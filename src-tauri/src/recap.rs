//! 前情提要：隔了一阵再打开一本书，先用几句话帮读者想起「讲到哪了」。
//!
//! 材料只用读过的部分：做过透视的书用读过那些段的要点（界面按防剧透的界线挑好了传进来），
//! 没做过的就取当前位置之前的一截原文。结果按「书 + 位置」存着，同一个位置再打开不用重算。

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

use crate::spoiler::Bound;

/// 没有透视可用时，往回取多少字的原文
const TEXT_CHARS: usize = 6000;

pub const SYSTEM: &str = "你在帮读者回忆一本读到一半的书。只根据给你的材料写，不要用自己的知识补充，更不要提材料之后的内容。";

pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS recaps (
            book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
            key     TEXT NOT NULL,
            text    TEXT NOT NULL
        );",
    )?;
    Ok(())
}

/// 同一个位置（精确到 2.5%）、同样多的材料算同一份
pub fn key(doc_id: &str, fraction: f64, notes: &str) -> String {
    format!("{doc_id}:{}:{}", (fraction * 40.0).floor() as i64, notes.len())
}

pub fn cached(conn: &Connection, book_id: &str, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT text FROM recaps WHERE book_id = ?1 AND key = ?2",
            params![book_id, key],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn store(conn: &Connection, book_id: &str, key: &str, text: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO recaps(book_id, key, text) VALUES (?1, ?2, ?3)",
        params![book_id, key, text],
    )?;
    Ok(())
}

/// 当前位置之前的一截原文（含正在读的这个片段）
pub fn text_before(conn: &Connection, doc_id: &str, fraction: f64) -> Result<String> {
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM chunks WHERE doc_id = ?1",
        params![doc_id],
        |r| r.get(0),
    )?;
    if total == 0 {
        return Ok(String::new());
    }
    let last = Bound::last_idx(fraction, total).clamp(0, total - 1);
    let mut stmt = conn.prepare(
        "SELECT text FROM (SELECT text, idx, id FROM chunks WHERE doc_id = ?1 ORDER BY idx, id LIMIT ?2)
         ORDER BY idx DESC, id DESC",
    )?;
    let mut picked: Vec<String> = Vec::new();
    let mut chars = 0usize;
    for text in stmt.query_map(params![doc_id, last + 1], |r| r.get::<_, String>(0))? {
        let text = text?;
        chars += text.chars().count();
        picked.push(text);
        if chars >= TEXT_CHARS {
            break;
        }
    }
    picked.reverse();
    Ok(picked.join("\n\n"))
}

/// notes 是读过那些段的要点（可以为空），text 是当前位置之前的原文（notes 为空时才用）
pub fn prompt(title: &str, notes: &str, text: &str) -> String {
    let material = if notes.trim().is_empty() {
        format!("【读者刚读过的原文】\n{text}")
    } else {
        format!("【读者已经读过的部分，按先后列出每一段的要点】\n{notes}")
    };
    format!(
        "读者隔了一阵回来接着读《{title}》。写一段「前情提要」帮他接上：\n\
         - 第一句说到目前为止整体讲到了哪里；\n\
         - 接着两三句说最近读的那部分讲了什么（人物做了什么，或者讲清了哪些概念、得出了什么结论）；\n\
         - 最后一句提醒他停在了什么地方。\n\
         一共不超过 150 个字，直接写内容，不要标题、列表和客套话。\n\n{material}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE books(id TEXT PRIMARY KEY);
             CREATE TABLE chunks(id INTEGER PRIMARY KEY, doc_id TEXT, idx INTEGER, text TEXT);",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn 只取当前位置之前的原文() {
        let conn = db();
        for i in 0..10 {
            conn.execute(
                "INSERT INTO chunks(doc_id, idx, text) VALUES ('d', ?1, ?2)",
                params![i, format!("第{i}段")],
            )
            .unwrap();
        }
        let text = text_before(&conn, "d", 0.35).unwrap();
        assert_eq!(text, "第0段\n\n第1段\n\n第2段\n\n第3段");
        assert!(text_before(&conn, "没有", 0.5).unwrap().is_empty());
    }

    #[test]
    fn 同一个位置用存着的_换了位置重算() {
        let conn = db();
        conn.execute("INSERT INTO books VALUES ('b')", []).unwrap();
        let k = key("d", 0.31, "要点");
        assert_eq!(k, key("d", 0.32, "要点"));
        assert_ne!(k, key("d", 0.36, "要点"));
        store(&conn, "b", &k, "提要").unwrap();
        assert_eq!(cached(&conn, "b", &k).unwrap().as_deref(), Some("提要"));
        assert_eq!(cached(&conn, "b", &key("d", 0.9, "要点")).unwrap(), None);
    }
}
