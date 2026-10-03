//! 检索：全文和向量两路各找一批，合并排序。
//!
//! - 全文（fts.rs）：字面命中，快，离线可用。
//! - 向量（embed.rs）：意思相近就能找到（问「逾期罚款」能找到「违约金」），要调接口。
//!
//! 合并用「倒数排名融合」：每一路里排第 r 名的片段得 1/(60+r) 分，两路的分加起来。
//! 只看名次、不看两路各自的分数，所以不用管 BM25 和向量距离的量纲对不上。

use crate::db::{self, SearchHit};
use crate::{embed, fts};
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

pub fn hybrid(
    conn: &Mutex<Connection>,
    query: &str,
    k: usize,
    doc_ids: Option<&[String]>,
) -> Result<Vec<SearchHit>> {
    let lock = || conn.lock().map_err(|_| anyhow::anyhow!("数据库锁异常"));
    let query = crate::parse::normalize(query);
    let (text_hits, cfg) = {
        let conn = lock()?;
        let cfg =
            embed::config(&conn).filter(|c| db::vectors_ready(&conn, &c.model).unwrap_or(false));
        (fts::search(&conn, &query, POOL, doc_ids)?, cfg)
    };
    // 调接口的这段时间不占数据库锁
    let vec_hits = match cfg {
        Some(cfg) => match embed::embed(&cfg, &[query.as_str()], QUERY_TIMEOUT) {
            Ok(v) => {
                let conn = lock()?;
                let mut hits = db::search_vec(&conn, &v[0], POOL, doc_ids)?;
                let best = hits.first().map(|h| h.distance).unwrap_or(0.0);
                hits.retain(|h| h.distance <= best + NEAR_BEST && h.distance <= MAX_DISTANCE);
                hits
            }
            Err(_) => vec![],
        },
        None => vec![],
    };
    Ok(fuse(text_hits, vec_hits, k))
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
    use crate::db::{NewDoc, TextChunk};
    use crate::embed::testing;

    // 补向量的任务是全局互斥的，这几个测试不能同时跑
    static SERIAL: Mutex<()> = Mutex::new(());

    fn library() -> Mutex<Connection> {
        let mut conn = db::open_in_memory().unwrap();
        let texts = [
            "第三条 付款条款：合同签订后 5 个工作日内支付 30% 预付款。",
            "第四条 质保：质保期为验收合格之日起 24 个月，期内免费维修。",
            "第五条 违约责任：乙方逾期交付的，每日按合同总价的 0.05% 支付违约金。",
            "运输费用由乙方承担，保险由甲方自行办理。",
        ];
        let chunks: Vec<TextChunk> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| TextChunk {
                idx: i as i64,
                page: None,
                text: t.to_string(),
            })
            .collect();
        db::import_document(
            &mut conn,
            &NewDoc {
                title: "采购合同",
                path: "/a.md",
                kind: "md",
                pages: None,
                author: None,
                cover: None,
            },
            &chunks,
        )
        .unwrap();
        Mutex::new(conn)
    }

    fn configure(conn: &Mutex<Connection>, cfg: &embed::EmbedConfig) {
        let json = serde_json::json!({
            "embedBaseUrl": cfg.base_url, "embedApiKey": cfg.api_key, "embedModel": cfg.model,
        });
        db::set_setting(&conn.lock().unwrap(), "settings", &json.to_string()).unwrap();
    }

    #[test]
    fn 没配向量接口时只走全文_照样能用() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let conn = library();
        fill_vectors(&conn, |_| panic!("没配接口不该有进度"));
        let hits = hybrid(&conn, "质保期多久", 3, None).unwrap();
        assert!(hits[0].text.contains("质保期"));
        assert_eq!(hits[0].via, "fts");
        // 换了说法，字面对不上：只靠全文是找不到的
        assert!(hybrid(&conn, "迟交货要罚多少钱", 3, None)
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
        let hits = hybrid(&conn, "迟交货要罚多少钱", 3, None).unwrap();
        assert!(hits[0].text.contains("违约金"), "{hits:?}");
        assert_eq!(hits[0].via, "vec");

        // 字面和意思都对得上的，标成两路都命中，排第一
        let hits = hybrid(&conn, "质保期多久", 3, None).unwrap();
        assert!(hits[0].text.contains("质保期"));
        assert_eq!(hits[0].via, "both");

        // 完全无关的问题：两路都不该硬凑结果
        assert!(hybrid(&conn, "讲讲唐朝的科举制度", 3, None)
            .unwrap()
            .is_empty());
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
        assert!(hybrid(&conn, "质保期多久", 3, None).unwrap()[0]
            .text
            .contains("质保期"));
    }
}
