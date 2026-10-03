//! 本地存储：文档、分块、向量索引，全部在一个 SQLite 文件里。
//!
//! 向量检索用 sqlite-vec 扩展（vec0 虚拟表）。它的维度在建表时固定，
//! 所以维度记在 meta 表里；换 embedding 模型需要重建索引。

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct DocOut {
    pub id: String,
    pub title: String,
    pub path: Option<String>,
    pub kind: String,
    pub pages: Option<i64>,
    pub chunk_count: i64,
    pub created_at: i64,
    pub author: Option<String>,
    pub has_cover: bool,
    /// 读到全书的几分之几；没打开过是 null
    pub progress: Option<f64>,
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
    /// 这条是哪一路找到的：fts（全文）/ vec（向量）/ both
    pub via: &'static str,
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

        -- 阅读器：封面缩略图、高亮/笔记/书签、读到哪了
        CREATE TABLE IF NOT EXISTS covers (
            doc_id  TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
            data    BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS annotations (
            id          TEXT PRIMARY KEY,
            doc_id      TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
            kind        TEXT NOT NULL,              -- highlight / bookmark
            cfi         TEXT NOT NULL,              -- 书内位置（EPUB CFI）
            text        TEXT NOT NULL DEFAULT '',   -- 被标记的原文
            note        TEXT NOT NULL DEFAULT '',
            color       TEXT NOT NULL DEFAULT 'yellow',
            style       TEXT NOT NULL DEFAULT 'highlight',
            label       TEXT NOT NULL DEFAULT '',   -- 所在章节
            page        INTEGER,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_annotations_doc ON annotations(doc_id);
        CREATE TABLE IF NOT EXISTS reading_state (
            doc_id      TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
            location    TEXT,
            fraction    REAL NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL
        );
        "#,
    )?;
    // 全文索引：存的是 jieba 切好、用空格隔开的词（见 fts.rs），rowid 就是片段 id。
    // 不存原文（原文在 chunks 里），只存倒排
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks
         USING fts5(text, content='', contentless_delete=1, tokenize='unicode61');",
    )?;
    // 早期版本的向量是本地哈希算的，和现在接口算的不是一回事，直接扔掉
    let model: Option<String> = get_setting(conn, "embedding_model")?;
    if model.is_none() {
        conn.execute_batch(
            "DROP TABLE IF EXISTS vec_chunks; DELETE FROM meta WHERE key = 'embedding_dim';",
        )?;
    }
    crate::fts::rebuild_if_empty(conn)?;
    // 老库升级：docs 后来才加的列
    let has_author = conn
        .prepare("SELECT 1 FROM pragma_table_info('docs') WHERE name = 'author'")?
        .exists([])?;
    if !has_author {
        conn.execute("ALTER TABLE docs ADD COLUMN author TEXT", [])?;
    }
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

pub fn list_documents(conn: &Connection) -> Result<Vec<DocOut>> {
    let mut stmt = conn.prepare(
        "SELECT d.id, d.title, d.path, d.kind, d.pages, d.created_at,
                (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id),
                d.author,
                EXISTS(SELECT 1 FROM covers v WHERE v.doc_id = d.id),
                (SELECT fraction FROM reading_state r WHERE r.doc_id = d.id)
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
            author: r.get(7)?,
            has_cover: r.get(8)?,
            progress: r.get(9)?,
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
    tx.execute(
        "DELETE FROM fts_chunks WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?1)",
        params![doc_id],
    )?;
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
pub fn search_vec(
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
            via: "vec",
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

/// 清掉所有片段和两路索引，文档本身（连同划线、笔记、进度）留着，等着重新导入
pub fn clear_index(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "DROP TABLE IF EXISTS vec_chunks;
         DELETE FROM fts_chunks;
         DELETE FROM chunks;
         DELETE FROM meta WHERE key IN ('embedding_dim', 'embedding_model');",
    )?;
    tx.commit()?;
    Ok(())
}

/// 所有还找得到原文件路径的文档
pub fn doc_paths(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path FROM docs WHERE path IS NOT NULL")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
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

/// 同一路径重复导入时，先把旧的那份删掉（文件改过后重新导入就是更新）
pub fn delete_by_path(conn: &mut Connection, path: &str) -> Result<()> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM docs WHERE path = ?1")?;
        let rows = stmt.query_map(params![path], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for id in ids {
        delete_document(conn, &id)?;
    }
    Ok(())
}

pub fn doc_path(conn: &Connection, doc_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT path FROM docs WHERE id = ?1",
            params![doc_id],
            |r| r.get(0),
        )
        .ok()
        .flatten())
}

/// 导入一份文档。同一路径再次导入时沿用原来的 id、只换内容——
/// 这样重新导入（文件改过了）不会把这份文档上的高亮、笔记和阅读进度弄丢。
/// chunks 可以为空（漫画、扫描件）：能读，只是搜不到。
/// 这里只建全文索引；向量要调接口，由后台任务补（见 search.rs）。
pub struct NewDoc<'a> {
    pub title: &'a str,
    pub path: &'a str,
    pub kind: &'a str,
    pub pages: Option<i64>,
    pub author: Option<&'a str>,
    pub cover: Option<&'a [u8]>,
}

pub fn import_document(
    conn: &mut Connection,
    doc: &NewDoc,
    chunks: &[TextChunk],
) -> Result<String> {
    // 分词是 CPU 活，在开事务之前做完
    let words: Vec<String> = chunks
        .iter()
        .map(|c| crate::fts::segment(&c.text))
        .collect();
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM docs WHERE path = ?1",
            params![doc.path],
            |r| r.get(0),
        )
        .ok();
    let has_vec = table_exists(conn, "vec_chunks")?;
    let tx = conn.transaction()?;
    let doc_id = match existing {
        Some(id) => {
            if has_vec {
                tx.execute(
                    "DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?1)",
                    params![id],
                )?;
            }
            tx.execute(
                "DELETE FROM fts_chunks WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?1)",
                params![id],
            )?;
            tx.execute("DELETE FROM chunks WHERE doc_id = ?1", params![id])?;
            tx.execute(
                "UPDATE docs SET title = ?2, kind = ?3, pages = ?4, author = ?5 WHERE id = ?1",
                params![id, doc.title, doc.kind, doc.pages, doc.author],
            )?;
            id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO docs(id, title, path, kind, pages, author, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![id, doc.title, doc.path, doc.kind, doc.pages, doc.author, now()],
            )?;
            id
        }
    };
    {
        let mut ins_chunk =
            tx.prepare("INSERT INTO chunks(doc_id, idx, page, text) VALUES(?1,?2,?3,?4)")?;
        let mut ins_fts = tx.prepare("INSERT INTO fts_chunks(rowid, text) VALUES(?1, ?2)")?;
        for (c, w) in chunks.iter().zip(&words) {
            ins_chunk.execute(params![doc_id, c.idx, c.page, c.text])?;
            ins_fts.execute(params![tx.last_insert_rowid(), w])?;
        }
    }
    if let Some(data) = doc.cover {
        tx.execute(
            "INSERT OR REPLACE INTO covers(doc_id, data) VALUES(?1, ?2)",
            params![doc_id, data],
        )?;
    }
    tx.commit()?;
    Ok(doc_id)
}

// ---------- 向量 ----------

/// 向量表只能装一种模型、一种维度的向量。模型换了就整表重来
pub fn prepare_vectors(conn: &Connection, model: &str, dim: usize) -> Result<()> {
    let stored = get_setting(conn, "embedding_model")?;
    let stored_dim = get_setting(conn, "embedding_dim")?;
    if stored.as_deref() != Some(model) || stored_dim != Some(dim.to_string()) {
        conn.execute_batch(
            "DROP TABLE IF EXISTS vec_chunks; DELETE FROM meta WHERE key = 'embedding_dim';",
        )?;
        set_setting(conn, "embedding_model", model)?;
    }
    ensure_vec_table(conn, dim)
}

/// 当前向量表是不是这个模型算的
pub fn vectors_ready(conn: &Connection, model: &str) -> Result<bool> {
    Ok(
        get_setting(conn, "embedding_model")?.as_deref() == Some(model)
            && table_exists(conn, "vec_chunks")?,
    )
}

/// 还没有向量的片段（最多 limit 条）
pub fn missing_vectors(conn: &Connection, model: &str, limit: usize) -> Result<Vec<(i64, String)>> {
    let sql = if vectors_ready(conn, model)? {
        "SELECT id, text FROM chunks WHERE id NOT IN (SELECT rowid FROM vec_chunks) ORDER BY id LIMIT ?1"
    } else {
        "SELECT id, text FROM chunks ORDER BY id LIMIT ?1"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn insert_vectors(conn: &mut Connection, model: &str, rows: &[(i64, Vec<f32>)]) -> Result<()> {
    let Some((_, first)) = rows.first() else {
        return Ok(());
    };
    prepare_vectors(conn, model, first.len())?;
    let tx = conn.transaction()?;
    {
        // 片段可能在算向量的这段时间里被删了（文档被删或重新导入），只写还在的
        let mut alive = tx.prepare("SELECT 1 FROM chunks WHERE id = ?1")?;
        let mut ins =
            tx.prepare("INSERT OR REPLACE INTO vec_chunks(rowid, embedding) VALUES(?1, ?2)")?;
        for (id, v) in rows {
            if alive.exists(params![id])? {
                ins.execute(params![id, vec_json(v)])?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

/// (已有向量的片段数, 片段总数)
pub fn vector_counts(conn: &Connection) -> Result<(i64, i64)> {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))?;
    let have: i64 = if table_exists(conn, "vec_chunks")? {
        conn.query_row(
            "SELECT COUNT(*) FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks)",
            [],
            |r| r.get(0),
        )?
    } else {
        0
    };
    Ok((have, total))
}

pub fn set_cover(conn: &Connection, doc_id: &str, data: &[u8]) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO covers(doc_id, data) VALUES(?1, ?2)",
        params![doc_id, data],
    )?;
    Ok(())
}

pub fn cover(conn: &Connection, doc_id: &str) -> Result<Option<Vec<u8>>> {
    Ok(conn
        .query_row(
            "SELECT data FROM covers WHERE doc_id = ?1",
            params![doc_id],
            |r| r.get(0),
        )
        .ok())
}

// ---------- 高亮、笔记、书签 ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub doc_id: String,
    /// highlight / bookmark
    pub kind: String,
    pub cfi: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub style: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// 只在列出时带上，方便跨文档展示
    #[serde(default)]
    pub doc_title: String,
}

/// 新建或修改（按 id）。创建时间只在第一次写入时定下来
pub fn save_annotation(conn: &Connection, a: &Annotation) -> Result<()> {
    let t = now();
    conn.execute(
        "INSERT INTO annotations(id, doc_id, kind, cfi, text, note, color, style, label, page, created_at, updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)
         ON CONFLICT(id) DO UPDATE SET
            cfi = excluded.cfi, text = excluded.text, note = excluded.note, color = excluded.color,
            style = excluded.style, label = excluded.label, page = excluded.page, updated_at = excluded.updated_at",
        params![a.id, a.doc_id, a.kind, a.cfi, a.text, a.note, a.color, a.style, a.label, a.page, t],
    )?;
    Ok(())
}

pub fn delete_annotation(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM annotations WHERE id = ?1", params![id])?;
    Ok(())
}

/// doc_ids 为空时列出全部文档的
pub fn list_annotations(conn: &Connection, doc_ids: Option<&[String]>) -> Result<Vec<Annotation>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.doc_id, a.kind, a.cfi, a.text, a.note, a.color, a.style, a.label, a.page,
                a.created_at, a.updated_at, d.title
         FROM annotations a JOIN docs d ON d.id = a.doc_id
         ORDER BY a.doc_id, a.created_at",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Annotation {
            id: r.get(0)?,
            doc_id: r.get(1)?,
            kind: r.get(2)?,
            cfi: r.get(3)?,
            text: r.get(4)?,
            note: r.get(5)?,
            color: r.get(6)?,
            style: r.get(7)?,
            label: r.get(8)?,
            page: r.get(9)?,
            created_at: r.get(10)?,
            updated_at: r.get(11)?,
            doc_title: r.get(12)?,
        })
    })?;
    let mut out = rows.collect::<Result<Vec<_>, _>>()?;
    if let Some(ids) = doc_ids.filter(|ids| !ids.is_empty()) {
        out.retain(|a| ids.iter().any(|i| i == &a.doc_id));
    }
    Ok(out)
}

// ---------- 阅读进度 ----------

#[derive(Debug, Serialize)]
pub struct ReadingState {
    pub location: Option<String>,
    pub fraction: f64,
}

pub fn reading_state(conn: &Connection, doc_id: &str) -> Result<Option<ReadingState>> {
    Ok(conn
        .query_row(
            "SELECT location, fraction FROM reading_state WHERE doc_id = ?1",
            params![doc_id],
            |r| {
                Ok(ReadingState {
                    location: r.get(0)?,
                    fraction: r.get(1)?,
                })
            },
        )
        .ok())
}

pub fn save_reading_state(
    conn: &Connection,
    doc_id: &str,
    location: &str,
    fraction: f64,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO reading_state(doc_id, location, fraction, updated_at) VALUES(?1,?2,?3,?4)",
        params![doc_id, location, fraction, now()],
    )?;
    Ok(())
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

    #[test]
    fn 重新导入保留笔记和进度_删除文档时一起清掉() {
        let mut conn = open_in_memory().unwrap();
        let doc = NewDoc {
            title: "书",
            path: "/tmp/book.epub",
            kind: "epub",
            pages: None,
            author: Some("某人"),
            cover: Some(&[1, 2, 3]),
        };
        let chunk = |t: &str| TextChunk {
            idx: 0,
            page: Some(1),
            text: t.to_string(),
        };
        let id = import_document(&mut conn, &doc, &[chunk("雨是从傍晚开始下的")]).unwrap();
        let note = Annotation {
            id: "a1".into(),
            doc_id: id.clone(),
            kind: "highlight".into(),
            cfi: "epubcfi(/6/2!/4/2,/1:0,/1:5)".into(),
            text: "雨是从傍晚".into(),
            note: "开头".into(),
            color: "yellow".into(),
            style: "highlight".into(),
            label: "第一章".into(),
            page: None,
            created_at: 0,
            updated_at: 0,
            doc_title: String::new(),
        };
        save_annotation(&conn, &note).unwrap();
        save_annotation(
            &conn,
            &Annotation {
                note: "改过的".into(),
                ..note.clone()
            },
        )
        .unwrap();
        save_reading_state(&conn, &id, "epubcfi(/6/4)", 0.4).unwrap();

        // 同一路径再导入：id 不变，内容换新，笔记和进度都在
        let again = import_document(&mut conn, &doc, &[chunk("换了内容的正文")]).unwrap();
        assert_eq!(again, id);
        let found = |q: &str| crate::fts::search(&conn, q, 3, None).unwrap().len();
        assert_eq!(found("换了内容"), 1);
        assert_eq!(found("傍晚开始"), 0);
        let notes = list_annotations(&conn, None).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].note, "改过的");
        assert_eq!(notes[0].doc_title, "书");
        assert_eq!(reading_state(&conn, &id).unwrap().unwrap().fraction, 0.4);
        let docs = list_documents(&conn).unwrap();
        assert_eq!(docs[0].author.as_deref(), Some("某人"));
        assert!(docs[0].has_cover);
        assert_eq!(docs[0].progress, Some(0.4));

        // 没有文字的文档（漫画）也能入库
        let comic = NewDoc {
            title: "漫画",
            path: "/tmp/c.cbz",
            kind: "cbz",
            pages: Some(20),
            author: None,
            cover: None,
        };
        import_document(&mut conn, &comic, &[]).unwrap();
        assert_eq!(list_documents(&conn).unwrap().len(), 2);

        delete_document(&mut conn, &id).unwrap();
        assert!(list_annotations(&conn, None).unwrap().is_empty());
        assert!(reading_state(&conn, &id).unwrap().is_none());
        assert!(cover(&conn, &id).unwrap().is_none());
    }
}
