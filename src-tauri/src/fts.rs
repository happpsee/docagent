//! 全文检索：jieba 分词 + SQLite FTS5（BM25 排序）。
//!
//! FTS5 自带的分词器不认识中文词（要么整句当一个词，要么一个字一个词），所以入库前
//! 先用 jieba 把文字切成词、用空格隔开再交给它；查询也用同样的切法。
//! 索引就在同一个数据库文件里，和片段在同一个事务里增删，不会对不上。

use crate::db::SearchHit;
use crate::spoiler::Access;
use anyhow::Result;
use jieba_rs::Jieba;
use rusqlite::types::Value;
use rusqlite::{params, Connection};
use std::sync::OnceLock;

fn jieba() -> &'static Jieba {
    static J: OnceLock<Jieba> = OnceLock::new();
    J.get_or_init(Jieba::new)
}

/// 切成检索用的词：长词会再拆出里面的短词（「质保期」→ 质保 / 质保期），提高召回
fn words(text: &str) -> Vec<String> {
    jieba()
        .cut_for_search(text, true)
        .into_iter()
        .map(|t| t.word)
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .map(|w| w.to_lowercase())
        .collect()
}

/// 入库用：切好的词用空格连起来。
///
/// 入库时用「全模式」——把所有可能的词都列出来。中文切词有歧义：「甲方向乙方采购」
/// 会被切成 甲 / 方向 / 乙方，只按一种切法入库的话搜「甲方」就漏了这一段。
pub fn segment(text: &str) -> String {
    let mut out = words(text);
    out.extend(
        jieba()
            .cut_all(text)
            .into_iter()
            .map(|t| t.word)
            .filter(|w| w.chars().count() >= 2 && w.chars().any(char::is_alphanumeric))
            .map(|w| w.to_lowercase()),
    );
    out.join(" ")
}

/// 问句里这些词到处都是，拿来匹配只会带进无关的片段
const STOP: [&str; 44] = [
    "什么",
    "怎么",
    "怎样",
    "如何",
    "多少",
    "多久",
    "哪些",
    "哪个",
    "哪里",
    "是否",
    "有没有",
    "可以",
    "一下",
    "一个",
    "这个",
    "那个",
    "这些",
    "那些",
    "我们",
    "你们",
    "他们",
    "以及",
    "还是",
    "或者",
    "因为",
    "所以",
    "但是",
    "如果",
    "就是",
    "不是",
    "没有",
    "关于",
    "对于",
    "里面",
    "告诉",
    "请问",
    "帮我",
    "the",
    "and",
    "what",
    "how",
    "is",
    "of",
    "to",
];

/// 查询里真正有信息量的词：去重、去掉疑问词。只剩单字时才用单字
pub fn query_terms(query: &str) -> Vec<String> {
    let mut all: Vec<String> = Vec::new();
    for w in words(query) {
        if !STOP.contains(&w.as_str()) && !all.contains(&w) {
            all.push(w);
        }
    }
    let long: Vec<String> = all
        .iter()
        .filter(|w| w.chars().count() >= 2)
        .cloned()
        .collect();
    if long.is_empty() {
        all
    } else {
        long
    }
}

/// 全文检索，按 BM25 相关度排序。
///
/// 词之间是「或」的关系（问句不可能每个词都出现在原文里），但至少要命中一半的词，
/// 否则「推荐一首适合跑步的歌」会因为合同里有个「适合」就算命中。
///
/// access 是这次能看哪些片段（限定的范围、防剧透的界线），在查询里面就筛掉：
/// LIMIT 数的只是能看的片段，范围外的内容再相关也占不了名额。
pub fn search(conn: &Connection, query: &str, n: usize, access: &Access) -> Result<Vec<SearchHit>> {
    let terms = query_terms(&crate::parse::normalize(query));
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let expr = terms
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
    let need = terms.len().div_ceil(2);
    // 「命中一半」是取出来之后再筛的，所以多取一些
    let mut args = vec![Value::Text(expr), Value::Integer((n * 8 + 40) as i64)];
    let filter = match access.filter(3) {
        Some((sql, more)) => {
            args.extend(more);
            format!("AND {sql}")
        }
        None => String::new(),
    };
    // CROSS JOIN 是说给 SQLite 听的：按写的顺序连，全文索引在最外层。
    // 这样才是「按相关度一条一条往下走，走到够数为止」，不会被改成先扫片段表再回头查索引
    let mut stmt = conn.prepare(&format!(
        "SELECT c.id, c.doc_id, c.idx, c.page, c.text, d.title, d.kind, COALESCE(d.book_id, '')
         FROM fts_chunks
         CROSS JOIN chunks c ON c.id = fts_chunks.rowid
         CROSS JOIN docs d ON d.id = c.doc_id
         WHERE fts_chunks MATCH ?1 {filter}
         ORDER BY rank
         LIMIT ?2"
    ))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
        Ok(SearchHit {
            chunk_id: r.get(0)?,
            doc_id: r.get(1)?,
            idx: r.get(2)?,
            page: r.get(3)?,
            text: r.get(4)?,
            doc_title: r.get(5)?,
            doc_kind: r.get(6)?,
            book_id: r.get(7)?,
            distance: 1.0,
            via: "fts",
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        let hit = row?;
        let lower = hit.text.to_lowercase();
        if terms.iter().filter(|t| lower.contains(t.as_str())).count() < need {
            continue;
        }
        out.push(hit);
        if out.len() >= n {
            break;
        }
    }
    Ok(out)
}

/// 老库升级、或索引被清掉之后：按库里现有的片段重建全文索引
pub fn rebuild_if_empty(conn: &Connection) -> Result<()> {
    let chunks: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))?;
    if chunks == 0 {
        return Ok(());
    }
    // 不存原文的 FTS 表数不了行数，看它的文档长度表
    let indexed: i64 =
        conn.query_row("SELECT COUNT(*) FROM fts_chunks_docsize", [], |r| r.get(0))?;
    if indexed >= chunks {
        return Ok(());
    }
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, text FROM chunks WHERE id NOT IN (SELECT id FROM fts_chunks_docsize)",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    conn.execute_batch("BEGIN")?;
    let result = (|| -> Result<()> {
        let mut ins = conn.prepare("INSERT INTO fts_chunks(rowid, text) VALUES(?1, ?2)")?;
        for (id, text) in &rows {
            ins.execute(params![id, segment(text)])?;
        }
        Ok(())
    })();
    conn.execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, NewDoc, TextChunk};

    fn library() -> Connection {
        let mut conn = db::open_in_memory().unwrap();
        let chunk = |i: i64, t: &str| TextChunk {
            idx: i,
            page: None,
            text: t.to_string(),
        };
        let doc = |title: &'static str, path: &'static str| NewDoc {
            title,
            path,
            kind: "md",
            pages: None,
            author: None,
            cover: None,
        };
        db::import_document(
            &mut conn,
            &doc("采购合同", "/a.md"),
            &[
                chunk(
                    0,
                    "甲方向乙方采购工业摄像机 20 台，型号 IC-7700，总价 172000 元。",
                ),
                chunk(1, "运输费用由乙方承担，保险由甲方自行办理。"),
                chunk(
                    2,
                    "第三条 付款条款：合同签订后 5 个工作日内支付 30% 预付款。",
                ),
                chunk(
                    3,
                    "第四条 质保：质保期为验收合格之日起 24 个月，期内免费维修。",
                ),
            ],
        )
        .unwrap();
        db::import_document(
            &mut conn,
            &doc("服务协议", "/b.md"),
            &[chunk(
                0,
                "服务费为每年 96000 元，按季度支付。甲方逾期支付超过 15 日的，乙方有权暂停服务。",
            )],
        )
        .unwrap();
        conn
    }

    #[test]
    fn 问句能找到对应条款_最相关的排第一() {
        let conn = library();
        let hits = search(&conn, "质保期多久？", 3, &Access::all()).unwrap();
        assert!(hits[0].text.contains("质保期为"), "{hits:?}");
        let hits = search(&conn, "预付款什么时候支付", 3, &Access::all()).unwrap();
        assert!(hits[0].text.contains("预付款"), "{hits:?}");
    }

    #[test]
    fn 短词_英文型号_数字都能搜() {
        let conn = library();
        assert_eq!(search(&conn, "甲方", 5, &Access::all()).unwrap().len(), 3);
        assert!(search(&conn, "ic-7700", 5, &Access::all()).unwrap()[0]
            .text
            .contains("IC-7700"));
        assert!(search(&conn, "96000", 5, &Access::all()).unwrap()[0]
            .text
            .contains("服务费"));
        // 两个词都命中的排在只命中一个的前面
        assert!(search(&conn, "甲方 保险", 5, &Access::all()).unwrap()[0]
            .text
            .contains("保险"));
    }

    #[test]
    fn 无关的问题不命中_只碰上个别常见词不算() {
        let conn = library();
        assert!(search(&conn, "推荐一首适合跑步听的歌", 5, &Access::all())
            .unwrap()
            .is_empty());
        assert!(search(&conn, "怎么？", 5, &Access::all())
            .unwrap()
            .is_empty());
        assert!(search(&conn, "", 5, &Access::all()).unwrap().is_empty());
    }

    #[test]
    fn 可以限定在某份文档里_删文档后搜不到() {
        let mut conn = library();
        let agreement: String = conn
            .query_row(
                "SELECT id FROM docs WHERE title = '服务协议'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let only = Access::of(&conn, Some(std::slice::from_ref(&agreement)), None).unwrap();
        let hits = search(&conn, "甲方", 5, &only).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].doc_title, "服务协议");
        assert_eq!(hits[0].doc_kind, "md");
        assert_eq!(
            Some(hits[0].book_id.clone()),
            crate::books::book_of(&conn, &agreement).unwrap()
        );
        crate::books::delete_document(&mut conn, &agreement).unwrap();
        assert!(search(&conn, "服务费", 5, &Access::all())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn 限定范围在查询里面筛_别的书占不了名额() {
        let mut conn = library();
        let doc = |title: &'static str, path: &'static str| NewDoc {
            title,
            path,
            kind: "md",
            pages: None,
            author: None,
            cover: None,
        };
        // 一本大部头，一百多块都在反复讲蒸汽机；一本小册子只顺带提了一句
        let tome: Vec<TextChunk> = (0..120)
            .map(|i| TextChunk {
                idx: i,
                page: None,
                text: format!("蒸汽机，蒸汽机，蒸汽机。第 {i} 条。"),
            })
            .collect();
        db::import_document(&mut conn, &doc("蒸汽机大全", "/tome.md"), &tome).unwrap();
        let leaflet = db::import_document(
            &mut conn,
            &doc("纺织厂手册", "/leaflet.md"),
            &[TextChunk {
                idx: 0,
                page: None,
                text: format!(
                    "{}顺带一提，厂里那台蒸汽机每周要保养一次。",
                    "纺织厂的日常管理包括排班、领料、验布和清扫车间。".repeat(12)
                ),
            }],
        )
        .unwrap();

        // 不限范围：排在前面的全是大部头，小册子那一句排在最后（第 121 名）
        let top = search(&conn, "蒸汽机", 3, &Access::all()).unwrap();
        assert_eq!(top.len(), 3);
        assert!(top.iter().all(|h| h.doc_title == "蒸汽机大全"), "{top:?}");
        let everything = search(&conn, "蒸汽机", 200, &Access::all()).unwrap();
        assert_eq!(everything.len(), 121);
        assert_eq!(everything[120].doc_id, leaflet);
        // 只在小册子里找：它那一句在全库里排在一百多名开外，照样找得到
        let only = Access::of(&conn, Some(std::slice::from_ref(&leaflet)), None).unwrap();
        let hits = search(&conn, "蒸汽机", 3, &only).unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].text.contains("每周要保养一次"));
    }

    #[test]
    fn 索引丢了能按现有片段重建() {
        let conn = library();
        conn.execute("DELETE FROM fts_chunks", []).unwrap();
        assert!(search(&conn, "质保期", 3, &Access::all())
            .unwrap()
            .is_empty());
        rebuild_if_empty(&conn).unwrap();
        assert_eq!(search(&conn, "质保期", 3, &Access::all()).unwrap().len(), 1);
    }
}
