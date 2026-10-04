//! 检索：全文和向量两路各找一批，合并排序。
//!
//! - 全文（fts.rs）：字面命中，快，离线可用。
//! - 向量（embed.rs）：意思相近就能找到（问「逾期罚款」能找到「违约金」），要调接口。
//!
//! 合并用「倒数排名融合」：每一路里排第 r 名的片段得 1/(60+r) 分，两路的分加起来。
//! 只看名次、不看两路各自的分数，所以不用管 BM25 和向量距离的量纲对不上。

use crate::db::{self, SearchHit};
use crate::spoiler::{Access, Live};
use crate::{books, embed, fts};
use anyhow::Result;
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// 每一路取多少条参与合并
const POOL: usize = 24;
const RRF_K: f64 = 60.0;
/// 向量这一路的取舍。不同模型的相似度水位差很多，所以主要看相对值：
/// 只留和第一名差不多近的；另有一个很宽的绝对上限（余弦相似度约 0.2 以下肯定无关）
const NEAR_BEST: f64 = 0.15;
const MAX_DISTANCE: f64 = 1.26;
/// 提问时等向量接口的时间上限：接口慢或挂了就只用全文那一路，不让用户干等
const QUERY_TIMEOUT: Duration = Duration::from_secs(6);

/// 检索。doc_ids 是用户限定的范围（None 或空是整个书架）；live 是阅读器此刻的位置，
/// 开了防剧透的书按它和存下来的进度算出读到哪，没读到的不拿出来（规则见 spoiler.rs）。
///
/// 范围和界线都在两路各自的查询里面筛，所以每一路的名额、向量那一路「和最近的差多少」
/// 的参照，算的都只是用户能看的片段。
pub fn hybrid(
    conn: &Mutex<Connection>,
    query: &str,
    k: usize,
    doc_ids: Option<&[String]>,
    live: Option<&Live>,
) -> Result<Vec<SearchHit>> {
    Ok(hybrid_noting(conn, query, k, doc_ids, live)?.0)
}

/// 和 hybrid 一样，另外说明这次有没有因为防剧透少搜了内容（true = 有的篇只搜了读过的部分）
pub fn hybrid_noting(
    conn: &Mutex<Connection>,
    query: &str,
    k: usize,
    doc_ids: Option<&[String]>,
    live: Option<&Live>,
) -> Result<(Vec<SearchHit>, bool)> {
    let lock = || conn.lock().map_err(|_| anyhow::anyhow!("数据库锁异常"));
    let query = crate::parse::normalize(query);
    let (text_hits, cfg, access) = {
        let conn = lock()?;
        let access = Access::of(&conn, doc_ids, live)?;
        let cfg =
            embed::config(&conn).filter(|c| db::vectors_ready(&conn, &c.model).unwrap_or(false));
        (fts::search(&conn, &query, POOL, &access)?, cfg, access)
    };
    // 调接口的这段时间不占数据库锁
    let vec_hits = match cfg {
        Some(cfg) => match embed::embed(&cfg, &[query.as_str()], QUERY_TIMEOUT) {
            Ok(v) => {
                let conn = lock()?;
                let mut hits = db::search_vec(&conn, &v[0], POOL, &access)?;
                let best = hits.first().map(|h| h.distance).unwrap_or(0.0);
                hits.retain(|h| h.distance <= best + NEAR_BEST && h.distance <= MAX_DISTANCE);
                hits
            }
            Err(_) => vec![],
        },
        None => vec![],
    };
    let mut hits = fuse(text_hits, vec_hits, k);
    if !hits.is_empty() {
        // 出处的名字统一用显示名：多篇的书是「书名 · 篇名」，只有书名分不清是哪一篇
        let labels = books::labels(&*lock()?)?;
        for h in &mut hits {
            if let Some(l) = labels.get(&h.doc_id) {
                h.doc_title = l.display_title.clone();
                h.book_id = l.book_id.clone();
            }
        }
    }
    Ok((hits, access.bounded()))
}

fn fuse(text_hits: Vec<SearchHit>, vec_hits: Vec<SearchHit>, k: usize) -> Vec<SearchHit> {
    let mut scored: HashMap<i64, (f64, SearchHit)> = HashMap::new();
    for (rank, h) in text_hits.into_iter().enumerate() {
        scored.insert(h.chunk_id, (1.0 / (RRF_K + rank as f64 + 1.0), h));
    }
    for (rank, h) in vec_hits.into_iter().enumerate() {
        let score = 1.0 / (RRF_K + rank as f64 + 1.0);
        match scored.get_mut(&h.chunk_id) {
            Some((s, old)) => {
                *s += score;
                old.via = "both";
                old.distance = h.distance;
            }
            None => {
                scored.insert(h.chunk_id, (score, h));
            }
        }
    }
    let mut all: Vec<(f64, SearchHit)> = scored.into_values().collect();
    // 同分时按片段在库里的先后，保证结果稳定
    all.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.chunk_id.cmp(&b.1.chunk_id)));
    all.into_iter().take(k).map(|(_, h)| h).collect()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct VectorProgress {
    pub done: i64,
    pub total: i64,
    /// 出错时的原因；出错就停，下次启动或改了设置再接着算
    pub error: Option<String>,
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// 给还没有向量的片段补上向量。一次一小批，每批之间放开数据库锁，界面不会被卡住。
/// 已经有一个在跑就直接返回；没配接口也直接返回。
pub fn fill_vectors(conn: &Mutex<Connection>, on_progress: impl Fn(VectorProgress)) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let result = fill(conn, &on_progress);
    RUNNING.store(false, Ordering::SeqCst);
    if let Err(e) = result {
        let (done, total) = conn
            .lock()
            .ok()
            .and_then(|c| db::vector_counts(&c).ok())
            .unwrap_or((0, 0));
        on_progress(VectorProgress {
            done,
            total,
            error: Some(e.to_string()),
        });
    }
}

fn fill(conn: &Mutex<Connection>, on_progress: &impl Fn(VectorProgress)) -> Result<()> {
    let lock = || conn.lock().map_err(|_| anyhow::anyhow!("数据库锁异常"));
    loop {
        let (cfg, batch) = {
            let conn = lock()?;
            let Some(cfg) = embed::config(&conn) else {
                return Ok(());
            };
            let batch = db::missing_vectors(&conn, &cfg.model, embed::BATCH)?;
            (cfg, batch)
        };
        if batch.is_empty() {
            return Ok(());
        }
        let texts: Vec<&str> = batch.iter().map(|(_, t)| t.as_str()).collect();
        let vectors = embed::embed(&cfg, &texts, Duration::from_secs(60))?;
        let rows: Vec<(i64, Vec<f32>)> = batch.iter().map(|(id, _)| *id).zip(vectors).collect();
        let mut conn = lock()?;
        // 算的这段时间里用户可能换了模型，那这批就作废，下一轮按新配置重来
        if embed::config(&conn).as_ref() != Some(&cfg) {
            continue;
        }
        db::insert_vectors(&mut conn, &cfg.model, &rows)?;
        let (done, total) = db::vector_counts(&conn)?;
        drop(conn);
        on_progress(VectorProgress {
            done,
            total,
            error: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::books::Scan;
    use crate::db::{NewDoc, TextChunk};
    use crate::embed::testing;

    // 补向量的任务是全局互斥的，这几个测试不能同时跑
    static SERIAL: Mutex<()> = Mutex::new(());

    fn chunks(texts: &[&str]) -> Vec<TextChunk> {
        texts
            .iter()
            .enumerate()
            .map(|(i, t)| TextChunk {
                idx: i as i64,
                page: None,
                text: t.to_string(),
            })
            .collect()
    }

    fn add(
        conn: &Mutex<Connection>,
        title: &str,
        path: &str,
        kind: &str,
        texts: &[&str],
    ) -> String {
        let doc = NewDoc {
            title,
            path,
            kind,
            pages: None,
            author: None,
            cover: None,
        };
        db::import_document(&mut conn.lock().unwrap(), &doc, &chunks(texts)).unwrap()
    }

    const CONTRACT: [&str; 4] = [
        "第三条 付款条款：合同签订后 5 个工作日内支付 30% 预付款。",
        "第四条 质保：质保期为验收合格之日起 24 个月，期内免费维修。",
        "第五条 违约责任：乙方逾期交付的，每日按合同总价的 0.05% 支付违约金。",
        "运输费用由乙方承担，保险由甲方自行办理。",
    ];

    fn library() -> Mutex<Connection> {
        let conn = Mutex::new(db::open_in_memory().unwrap());
        add(&conn, "采购合同", "/a.md", "md", &CONTRACT);
        conn
    }

    fn configure(conn: &Mutex<Connection>, cfg: &embed::EmbedConfig) {
        let json = serde_json::json!({
            "embedBaseUrl": cfg.base_url, "embedApiKey": cfg.api_key, "embedModel": cfg.model,
        });
        db::set_setting(&conn.lock().unwrap(), "settings", &json.to_string()).unwrap();
    }

    fn live(doc_id: &str, fraction: f64) -> Live {
        Live {
            doc_id: doc_id.to_string(),
            page: None,
            fraction,
        }
    }

    /// 一本三卷的连载小说（txt，防剧透默认开），返回三卷的 id
    fn serial(conn: &Mutex<Connection>) -> Vec<String> {
        books::create_book(
            &conn.lock().unwrap(),
            "槐花巷",
            None,
            Some("/n"),
            Scan::None,
        )
        .unwrap();
        [
            (
                "卷一.txt",
                ["老陈在巷口开了一家照相馆。", "小满第一次来取照片。"],
            ),
            (
                "卷二.txt",
                ["照相馆的暗房里藏着一只信封。", "信封里是三十年前的底片。"],
            ),
            (
                "卷三.txt",
                ["底片上的人原来是小满的母亲。", "老陈最后把钥匙交给了小满。"],
            ),
        ]
        .iter()
        .map(|(name, texts)| add(conn, name, &format!("/n/{name}"), "txt", texts))
        .collect()
    }

    #[test]
    fn 防剧透_读到的位置之后的内容搜不出来() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let conn = library();
        let doc_id: String = conn
            .lock()
            .unwrap()
            .query_row("SELECT id FROM docs", [], |r| r.get(0))
            .unwrap();
        // 合同这类格式默认不开防剧透：读到哪都能搜全文
        let hits = hybrid(&conn, "违约金", 3, None, Some(&live(&doc_id, 0.0))).unwrap();
        assert!(hits[0].text.contains("违约金"));

        let book = books::book_of(&conn.lock().unwrap(), &doc_id)
            .unwrap()
            .unwrap();
        books::set_spoiler(&conn.lock().unwrap(), &book, Some(true)).unwrap();
        // 「违约金」在第三块（一共四块）。读到一半时搜不到，读到后面才有
        let early = hybrid(&conn, "违约金", 3, None, Some(&live(&doc_id, 0.3))).unwrap();
        assert!(early.is_empty(), "{early:?}");
        let later = hybrid(&conn, "违约金", 3, None, Some(&live(&doc_id, 0.6))).unwrap();
        assert!(later[0].text.contains("违约金"));
        // 前面读过的照常能搜到
        assert!(!hybrid(&conn, "预付款", 3, None, Some(&live(&doc_id, 0.3)))
            .unwrap()
            .is_empty());
        // 存下来的最远处也算数：读到过后面，现在翻回前面，后面的还是能搜到
        db::save_reading_state(&conn.lock().unwrap(), &doc_id, "loc", 0.7, None).unwrap();
        let back = hybrid(&conn, "违约金", 3, None, Some(&live(&doc_id, 0.1))).unwrap();
        assert!(back[0].text.contains("违约金"));
        // 没开着书的时候提问（live 不给）：按存下来的进度算
        let closed = hybrid(&conn, "运输费用", 3, None, None).unwrap();
        assert!(closed.is_empty(), "{closed:?}");
    }

    #[test]
    fn 多篇的书_前面的篇都能搜_读到的那篇到读过的地方_后面没打开过的搜不到() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let conn = Mutex::new(db::open_in_memory().unwrap());
        let v = serial(&conn);
        // 还没开始读：整本都能搜（用户没在读它，只是拿来查）
        let all = hybrid(&conn, "底片", 5, None, None).unwrap();
        assert_eq!(all.len(), 2, "{all:?}");

        // 读到卷二的开头
        db::save_reading_state(&conn.lock().unwrap(), &v[1], "loc", 0.0, None).unwrap();
        let found = |q: &str, live: Option<&Live>| -> Vec<String> {
            hybrid(&conn, q, 5, None, live)
                .unwrap()
                .into_iter()
                .map(|h| h.text)
                .collect()
        };
        // 卷一没打开过也算读过（排在读到的那篇前面）
        assert_eq!(found("取照片", None), vec!["小满第一次来取照片。"]);
        // 卷二只到读过的地方：第一块能搜到，第二块（底片）还没读到
        assert_eq!(found("信封", None), vec!["照相馆的暗房里藏着一只信封。"]);
        // 卷三没打开过：一条都不给，哪怕只在卷三里找
        assert!(found("底片", None).is_empty());
        assert!(hybrid(&conn, "小满的母亲", 5, Some(&v[2..]), None)
            .unwrap()
            .is_empty());

        // 命中带着书、格式和显示用的名字
        let hit = &hybrid(&conn, "信封", 5, None, None).unwrap()[0];
        assert_eq!(hit.doc_title, "槐花巷 · 卷二");
        assert_eq!(hit.doc_kind, "txt");
        assert_eq!(
            Some(hit.book_id.clone()),
            books::book_of(&conn.lock().unwrap(), &v[1]).unwrap()
        );
        assert_eq!(hit.doc_id, v[1]);

        // 阅读器此刻翻到了卷二的后半：不用等进度存盘
        assert_eq!(found("底片", Some(&live(&v[1], 0.5))).len(), 1);
        // 正开着卷三的开头：卷二整篇算读过，卷三到第一块
        let at_three = live(&v[2], 0.0);
        let texts = found("底片", Some(&at_three));
        assert_eq!(texts.len(), 2, "{texts:?}");
        assert!(found("钥匙", Some(&at_three)).is_empty());

        // 关掉这本书的防剧透：不设限
        let book = books::book_of(&conn.lock().unwrap(), &v[0])
            .unwrap()
            .unwrap();
        books::set_spoiler(&conn.lock().unwrap(), &book, Some(false)).unwrap();
        assert_eq!(found("钥匙", None).len(), 1);
    }

    #[test]
    fn 没配向量接口时只走全文_照样能用() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let conn = library();
        fill_vectors(&conn, |_| panic!("没配接口不该有进度"));
        let hits = hybrid(&conn, "质保期多久", 3, None, None).unwrap();
        assert!(hits[0].text.contains("质保期"));
        assert_eq!(hits[0].via, "fts");
        // 换了说法，字面对不上：只靠全文是找不到的
        assert!(hybrid(&conn, "迟交货要罚多少钱", 3, None, None)
            .unwrap()
            .iter()
            .all(|h| !h.text.contains("违约金")));
    }

    #[test]
    fn 配了接口后_换个说法也能找到_两路都命中的排最前() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let conn = library();
        let fake = testing::serve(None);
        configure(&conn, &fake.cfg);
        let last = Mutex::new(None);
        fill_vectors(&conn, |p| *last.lock().unwrap() = Some(p));
        let p = last.into_inner().unwrap().unwrap();
        assert_eq!((p.done, p.total), (4, 4));
        assert!(p.error.is_none());

        // 原文写的是「逾期交付……支付违约金」，问法里一个相同的词都没有
        let hits = hybrid(&conn, "迟交货要罚多少钱", 3, None, None).unwrap();
        assert!(hits[0].text.contains("违约金"), "{hits:?}");
        assert_eq!(hits[0].via, "vec");

        // 字面和意思都对得上的，标成两路都命中，排第一
        let hits = hybrid(&conn, "质保期多久", 3, None, None).unwrap();
        assert!(hits[0].text.contains("质保期"));
        assert_eq!(hits[0].via, "both");

        // 完全无关的问题：两路都不该硬凑结果
        assert!(hybrid(&conn, "讲讲唐朝的科举制度", 3, None, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn 向量这一路_范围和界线也在查询里筛_近的都在别的书里也找得到() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let conn = library();
        let contract: String = conn
            .lock()
            .unwrap()
            .query_row("SELECT id FROM docs", [], |r| r.get(0))
            .unwrap();
        // 另一本书里有两百多块，句句都和问法几乎一样——全库最近的那些全是它的
        let noise: Vec<String> = (0..210)
            .map(|i| format!("迟交货要罚多少钱？第 {i} 种说法。"))
            .collect();
        let noise: Vec<&str> = noise.iter().map(String::as_str).collect();
        let faq = add(&conn, "问答集", "/faq.md", "md", &noise);
        let fake = testing::serve(None);
        configure(&conn, &fake.cfg);
        fill_vectors(&conn, |_| {});
        assert_eq!(
            db::vector_counts(&conn.lock().unwrap()).unwrap(),
            (214, 214)
        );

        // 不限范围：前几名都是问答集里的；合同里讲违约金的那一块排在两百一十名开外
        let hits = hybrid(&conn, "迟交货要罚多少钱", 3, None, None).unwrap();
        assert!(hits.iter().all(|h| h.doc_id == faq), "{hits:?}");
        let v = embed::embed(&fake.cfg, &["迟交货要罚多少钱"], QUERY_TIMEOUT).unwrap();
        let nearest = db::search_vec(&conn.lock().unwrap(), &v[0], 214, &Access::all()).unwrap();
        let rank = nearest.iter().position(|h| h.text.contains("违约金"));
        assert!(rank.is_some_and(|r| r >= 210), "{rank:?}");
        // 只在合同里找：字面对不上，全靠向量；合同那一条在全库里排在两百名开外，照样找得到。
        // 「和最近的差多少」也是在合同里比的，不会因为问答集里有更近的就被筛掉
        let scope = [contract.clone()];
        let hits = hybrid(&conn, "迟交货要罚多少钱", 3, Some(&scope), None).unwrap();
        assert!(!hits.is_empty());
        assert!(hits[0].text.contains("违约金"), "{hits:?}");
        assert_eq!(hits[0].via, "vec");
        assert!(hits.iter().all(|h| h.doc_id == contract));

        // 界线同理：合同开了防剧透、只读到前一半，「违约金」那一块（第三块）还没读到，
        // 向量这一路也不能把它拿出来
        let book = books::book_of(&conn.lock().unwrap(), &contract)
            .unwrap()
            .unwrap();
        books::set_spoiler(&conn.lock().unwrap(), &book, Some(true)).unwrap();
        let early = hybrid(
            &conn,
            "迟交货要罚多少钱",
            3,
            Some(&scope),
            Some(&live(&contract, 0.3)),
        )
        .unwrap();
        assert!(
            early.iter().all(|h| !h.text.contains("违约金")),
            "{early:?}"
        );
        let later = hybrid(
            &conn,
            "迟交货要罚多少钱",
            3,
            Some(&scope),
            Some(&live(&contract, 0.6)),
        )
        .unwrap();
        assert!(later[0].text.contains("违约金"), "{later:?}");
    }

    #[test]
    fn 换了向量模型就整批重算_接口挂了报出原因且不丢已有的() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let conn = library();
        let fake = testing::serve(None);
        configure(&conn, &fake.cfg);
        fill_vectors(&conn, |_| {});
        assert_eq!(db::vector_counts(&conn.lock().unwrap()).unwrap(), (4, 4));

        // 再跑一次：都有了，不该再调接口
        let before = fake.calls.load(Ordering::SeqCst);
        fill_vectors(&conn, |_| {});
        assert_eq!(fake.calls.load(Ordering::SeqCst), before);

        // 换模型名：旧向量作废，全部重算
        let renamed = embed::EmbedConfig {
            model: "another-model".into(),
            ..fake.cfg.clone()
        };
        configure(&conn, &renamed);
        fill_vectors(&conn, |_| {});
        assert!(fake.calls.load(Ordering::SeqCst) > before);
        assert_eq!(db::vector_counts(&conn.lock().unwrap()).unwrap(), (4, 4));

        // 接口挂了：报出原因；检索退回只用全文，不报错
        let broken = testing::serve(Some(0));
        configure(
            &conn,
            &embed::EmbedConfig {
                model: "third".into(),
                ..broken.cfg.clone()
            },
        );
        let last = Mutex::new(None);
        fill_vectors(&conn, |p| *last.lock().unwrap() = Some(p));
        let p = last.into_inner().unwrap().unwrap();
        assert!(p.error.unwrap().contains("500"));
        assert!(hybrid(&conn, "质保期多久", 3, None, None).unwrap()[0]
            .text
            .contains("质保期"));
    }
}
