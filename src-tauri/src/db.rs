//! 本地存储：文档、分块、向量索引，全部在一个 SQLite 文件里。
//!
//! 向量检索用 sqlite-vec 扩展（vec0 虚拟表）。它的维度在建表时固定，
//! 所以维度记在 meta 表里；换 embedding 模型需要重建索引。

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
pub struct ChunkIn {
    pub idx: i64,
    /// PDF 的页码（从 1 开始）；非分页文档为 null
    pub page: Option<i64>,
    pub text: String,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Serialize)]
pub struct DocOut {
    pub id: String,
    pub title: String,
    pub path: Option<String>,
    pub kind: String,
    pub pages: Option<i64>,
    pub chunk_count: i64,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub chunk_id: i64,
    pub doc_id: String,
    pub doc_title: String,
    pub idx: i64,
    pub page: Option<i64>,
    pub text: String,
    pub distance: f64,
}

/// sqlite-vec 以静态扩展注册，必须在打开任何连接之前调用一次。
/// 签名来自 libsqlite3-sys，两边版本一致时可以直接传函数指针。
fn register_vec_extension() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    // sqlite-vec 把入口导出成 fn()，而 sqlite3_auto_extension 要的是标准扩展签名，
    // 所以必须转一下；类型写全是为了过 clippy 的 missing_transmute_annotations。
    type ExtInit = unsafe extern "C" fn(
        *mut libsqlite3_sys::sqlite3,
        *mut *mut std::os::raw::c_char,
        *const libsqlite3_sys::sqlite3_api_routines,
    ) -> std::os::raw::c_int;

    ONCE.call_once(|| unsafe {
        let init: ExtInit = std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());
        libsqlite3_sys::sqlite3_auto_extension(Some(init));
    });
}

pub fn open(path: &Path) -> Result<Connection> {
    register_vec_extension();
    let conn = Connection::open(path)?;
    init_schema(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> Result<Connection> {
    register_vec_extension();
    let conn = Connection::open_in_memory()?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS docs (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            path        TEXT,
            kind        TEXT NOT NULL,
            pages       INTEGER,
            created_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chunks (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id  TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
            idx     INTEGER NOT NULL,
            page    INTEGER,
            text    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);

        -- 对话持久化。sdk_session_id 是 Agent SDK 的会话 id，续聊时用它 resume
        CREATE TABLE IF NOT EXISTS sessions (
            id              TEXT PRIMARY KEY,
            sdk_session_id  TEXT,
            title           TEXT NOT NULL,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL,
            meta        TEXT,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        "#,
    )?;
    Ok(())
}

/// vec0 表的维度固定，第一次写入时按 embedding 长度建表。
fn ensure_vec_table(conn: &Connection, dim: usize) -> Result<()> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'embedding_dim'",
            [],
            |r| r.get(0),
        )
        .ok();
    match stored {
        Some(v) => {
            let existing: usize = v.parse().unwrap_or(0);
            if existing != dim {
                return Err(anyhow!(
                    "索引维度是 {existing}，当前 embedding 是 {dim}。换了 embedding 模型需要清空重建索引。"
                ));
            }
        }
        None => {
            conn.execute(
                &format!("CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[{dim}])"),
                [],
            )?;
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES('embedding_dim', ?1)",
                params![dim.to_string()],
            )?;
        }
    }
    Ok(())
}

fn vec_json(v: &[f32]) -> String {
    let mut s = String::with_capacity(v.len() * 8 + 2);
    s.push('[');
    for (i, x) in v.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&x.to_string());
    }
    s.push(']');
    s
}

pub fn add_document(
    conn: &mut Connection,
    title: &str,
    path: Option<&str>,
    kind: &str,
    pages: Option<i64>,
    chunks: &[ChunkIn],
) -> Result<String> {
    if chunks.is_empty() {
        return Err(anyhow!("没有可索引的内容（文档解析后为空）"));
    }
    let dim = chunks[0].embedding.len();
    if dim == 0 {
        return Err(anyhow!("embedding 为空"));
    }
    if chunks.iter().any(|c| c.embedding.len() != dim) {
        return Err(anyhow!("同一文档内 embedding 维度不一致"));
    }
    ensure_vec_table(conn, dim)?;

    let doc_id = uuid::Uuid::new_v4().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO docs(id, title, path, kind, pages, created_at) VALUES(?1,?2,?3,?4,?5,?6)",
        params![doc_id, title, path, kind, pages, now],
    )?;
    {
        let mut ins_chunk =
            tx.prepare("INSERT INTO chunks(doc_id, idx, page, text) VALUES(?1,?2,?3,?4)")?;
        let mut ins_vec = tx.prepare("INSERT INTO vec_chunks(rowid, embedding) VALUES(?1, ?2)")?;
        for c in chunks {
            ins_chunk.execute(params![doc_id, c.idx, c.page, c.text])?;
            let rowid = tx.last_insert_rowid();
            ins_vec.execute(params![rowid, vec_json(&c.embedding)])?;
        }
    }
    tx.commit()?;
    Ok(doc_id)
}

pub fn list_documents(conn: &Connection) -> Result<Vec<DocOut>> {
    let mut stmt = conn.prepare(
        "SELECT d.id, d.title, d.path, d.kind, d.pages, d.created_at,
                (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id)
         FROM docs d ORDER BY d.created_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(DocOut {
            id: r.get(0)?,
            title: r.get(1)?,
            path: r.get(2)?,
            kind: r.get(3)?,
            pages: r.get(4)?,
            created_at: r.get(5)?,
            chunk_count: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn delete_document(conn: &mut Connection, doc_id: &str) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("SELECT id FROM chunks WHERE doc_id = ?1")?;
        let ids: Vec<i64> = stmt
            .query_map(params![doc_id], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        // vec0 表没有外键级联，手动删
        if !ids.is_empty() && table_exists(&tx, "vec_chunks")? {
            let mut del = tx.prepare("DELETE FROM vec_chunks WHERE rowid = ?1")?;
            for id in ids {
                del.execute(params![id])?;
            }
        }
    }
    tx.execute("DELETE FROM docs WHERE id = ?1", params![doc_id])?;
    tx.commit()?;
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
        params![name],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// 向量检索。doc_ids 非空时只在这些文档里找。
pub fn search(
    conn: &Connection,
    embedding: &[f32],
    k: usize,
    doc_ids: Option<&[String]>,
) -> Result<Vec<SearchHit>> {
    if !table_exists(conn, "vec_chunks")? {
        return Ok(vec![]);
    }
    // 过滤文档时先多取一些候选，再按 doc_id 过滤
    let fetch = if doc_ids.is_some() { k * 8 } else { k };
    let mut stmt = conn.prepare(
        "SELECT v.rowid, v.distance, c.doc_id, c.idx, c.page, c.text, d.title
         FROM vec_chunks v
         JOIN chunks c ON c.id = v.rowid
         JOIN docs d ON d.id = c.doc_id
         WHERE v.embedding MATCH ?1 AND k = ?2
         ORDER BY v.distance",
    )?;
    let rows = stmt.query_map(params![vec_json(embedding), fetch as i64], |r| {
        Ok(SearchHit {
            chunk_id: r.get(0)?,
            distance: r.get(1)?,
            doc_id: r.get(2)?,
            idx: r.get(3)?,
            page: r.get(4)?,
            text: r.get(5)?,
            doc_title: r.get(6)?,
        })
    })?;
    let mut hits: Vec<SearchHit> = rows.collect::<Result<Vec<_>, _>>()?;
    if let Some(ids) = doc_ids {
        if !ids.is_empty() {
            hits.retain(|h| ids.iter().any(|i| i == &h.doc_id));
        }
    }
    hits.truncate(k);
    Ok(hits)
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
            r.get(0)
        })
        .ok())
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES(?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

/// 清空索引（换 embedding 模型时用）
pub fn reset_index(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS vec_chunks;
         DELETE FROM chunks;
         DELETE FROM docs;
         DELETE FROM meta WHERE key = 'embedding_dim';",
    )?;
    Ok(())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Deserialize)]
pub struct TextChunk {
    pub idx: i64,
    pub page: Option<i64>,
    pub text: String,
}

/// 入库：向量在这里算，前端只送文本。检索时的查询向量也在 Rust 算，保证两边一致。
pub fn add_document_text(
    conn: &mut Connection,
    title: &str,
    path: Option<&str>,
    kind: &str,
    pages: Option<i64>,
    chunks: &[TextChunk],
) -> Result<String> {
    let with_vec: Vec<ChunkIn> = chunks
        .iter()
        .map(|c| ChunkIn {
            idx: c.idx,
            page: c.page,
            text: c.text.clone(),
            embedding: crate::embed::hash_embed(&c.text),
        })
        .collect();
    add_document(conn, title, path, kind, pages, &with_vec)
}

/// 文本检索：算查询向量 → KNN → 丢掉距离过大的（等于没命中）
pub fn search_text(
    conn: &Connection,
    query: &str,
    k: usize,
    doc_ids: Option<&[String]>,
) -> Result<Vec<SearchHit>> {
    let v = crate::embed::hash_embed(query);
    let mut hits = search(conn, &v, k, doc_ids)?;
    hits.retain(|h| h.distance < crate::embed::NO_MATCH_DISTANCE);
    Ok(hits)
}

#[derive(Debug, Serialize)]
pub struct SessionOut {
    pub id: String,
    pub sdk_session_id: Option<String>,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct MessageOut {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub meta: Option<String>,
    pub created_at: i64,
}

pub fn upsert_session(
    conn: &Connection,
    id: &str,
    title: &str,
    sdk_session_id: Option<&str>,
) -> Result<()> {
    let t = now();
    conn.execute(
        "INSERT INTO sessions(id, sdk_session_id, title, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(id) DO UPDATE SET
            sdk_session_id = COALESCE(excluded.sdk_session_id, sessions.sdk_session_id),
            updated_at = excluded.updated_at",
        params![id, sdk_session_id, title, t],
    )?;
    Ok(())
}

pub fn list_sessions(conn: &Connection) -> Result<Vec<SessionOut>> {
    let mut stmt = conn.prepare(
        "SELECT id, sdk_session_id, title, created_at, updated_at
         FROM sessions ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SessionOut {
            id: r.get(0)?,
            sdk_session_id: r.get(1)?,
            title: r.get(2)?,
            created_at: r.get(3)?,
            updated_at: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn delete_session(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn add_message(
    conn: &Connection,
    session_id: &str,
    role: &str,
    content: &str,
    meta: Option<&str>,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO messages(session_id, role, content, meta, created_at) VALUES(?1,?2,?3,?4,?5)",
        params![session_id, role, content, meta, now()],
    )?;
    conn.execute(
        "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
        params![session_id, now()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn get_messages(conn: &Connection, session_id: &str) -> Result<Vec<MessageOut>> {
    let mut stmt = conn.prepare(
        "SELECT id, role, content, meta, created_at FROM messages
         WHERE session_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map(params![session_id], |r| {
        Ok(MessageOut {
            id: r.get(0)?,
            role: r.get(1)?,
            content: r.get(2)?,
            meta: r.get(3)?,
            created_at: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(idx: i64, text: &str, emb: Vec<f32>) -> ChunkIn {
        ChunkIn {
            idx,
            page: Some(idx + 1),
            text: text.to_string(),
            embedding: emb,
        }
    }

    #[test]
    fn 建库_写入_检索_删除() {
        let mut conn = open_in_memory().unwrap();
        let id = add_document(
            &mut conn,
            "测试文档",
            Some("/tmp/a.md"),
            "md",
            Some(3),
            &[
                chunk(0, "猫在睡觉", vec![1.0, 0.0, 0.0]),
                chunk(1, "狗在跑", vec![0.0, 1.0, 0.0]),
                chunk(2, "天气很好", vec![0.0, 0.0, 1.0]),
            ],
        )
        .unwrap();

        let docs = list_documents(&conn).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].chunk_count, 3);
        assert_eq!(docs[0].title, "测试文档");

        // 最接近 [1,0,0] 的应该是第一块
        let hits = search(&conn, &[0.9, 0.1, 0.0], 2, None).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].text, "猫在睡觉");
        assert_eq!(hits[0].page, Some(1));
        assert!(hits[0].distance < hits[1].distance);

        // 按文档过滤
        let hits = search(&conn, &[0.9, 0.1, 0.0], 2, Some(&["别的文档".to_string()])).unwrap();
        assert!(hits.is_empty());

        delete_document(&mut conn, &id).unwrap();
        assert!(list_documents(&conn).unwrap().is_empty());
        assert!(search(&conn, &[1.0, 0.0, 0.0], 3, None).unwrap().is_empty());
    }

    #[test]
    fn 维度不一致要报错() {
        let mut conn = open_in_memory().unwrap();
        add_document(
            &mut conn,
            "a",
            None,
            "txt",
            None,
            &[chunk(0, "x", vec![1.0, 0.0])],
        )
        .unwrap();
        let err = add_document(
            &mut conn,
            "b",
            None,
            "txt",
            None,
            &[chunk(0, "y", vec![1.0, 0.0, 0.0])],
        )
        .unwrap_err();
        assert!(err.to_string().contains("维度"));
    }

    #[test]
    fn 设置读写() {
        let conn = open_in_memory().unwrap();
        assert!(get_setting(&conn, "provider").unwrap().is_none());
        set_setting(&conn, "provider", "{\"base\":\"x\"}").unwrap();
        assert_eq!(
            get_setting(&conn, "provider").unwrap().unwrap(),
            "{\"base\":\"x\"}"
        );
    }

    #[test]
    fn 文本入库后能按内容检索_无关问题不命中() {
        let mut conn = open_in_memory().unwrap();
        add_document_text(
            &mut conn,
            "采购合同",
            None,
            "md",
            None,
            &[
                TextChunk {
                    idx: 0,
                    page: None,
                    text: "第三条 付款条款：合同签订后 5 个工作日内支付 30% 预付款。".into(),
                },
                TextChunk {
                    idx: 1,
                    page: None,
                    text: "第四条 质保：质保期为验收合格之日起 24 个月，期内免费维修。".into(),
                },
            ],
        )
        .unwrap();

        let hits = search_text(&conn, "质保期多久", 3, None).unwrap();
        assert!(!hits.is_empty());
        assert!(hits[0].text.contains("质保期"));

        // 完全无关的问题应被距离阈值滤掉
        let hits = search_text(&conn, "推荐一首适合跑步听的歌", 3, None).unwrap();
        assert!(hits.is_empty(), "无关问题不该有命中: {hits:?}");
    }

    #[test]
    fn 会话与消息读写_删除级联() {
        let conn = open_in_memory().unwrap();
        upsert_session(&conn, "s1", "第一个会话", None).unwrap();
        add_message(&conn, "s1", "user", "你好", None).unwrap();
        add_message(&conn, "s1", "assistant", "你好，有什么可以帮你", Some("{}")).unwrap();
        // 后续拿到 SDK 会话 id 再补上，标题不被覆盖
        upsert_session(&conn, "s1", "不应覆盖", Some("sdk-abc")).unwrap();

        let list = list_sessions(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "第一个会话");
        assert_eq!(list[0].sdk_session_id.as_deref(), Some("sdk-abc"));
        assert_eq!(get_messages(&conn, "s1").unwrap().len(), 2);

        delete_session(&conn, "s1").unwrap();
        assert!(get_messages(&conn, "s1").unwrap().is_empty());
    }
}
