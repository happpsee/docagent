//! 本地存储：书、文档、分块、向量索引，全部在一个 SQLite 文件里。
//!
//! 向量检索用 sqlite-vec 扩展（vec0 虚拟表）。它的维度在建表时固定，
//! 所以维度记在 meta 表里；换 embedding 模型需要重建索引。
//!
//! 书架上摆的是「书」（books 表，见 books.rs）；一本书有一篇或多篇，一篇就是 docs 里的一行、
//! 磁盘上的一个文件。片段、两路索引、划线笔记、进度、透视都还是挂在「篇」上，
//! 所以把几篇合成一本、或者把一本拆开，这些东西一行都不用动。

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// 检索命中的一个片段。直接按这个样子（camelCase）交给 sidecar 和界面
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub chunk_id: i64,
    pub doc_id: String,
    /// 这一篇属于哪本书
    pub book_id: String,
    /// 对外显示的名字（单文件的书是书名，多篇的是「书名 · 篇名」）。
    /// 两路检索各自返回时填的还是文档自己的标题，合并之后统一换成显示名，见 search::hybrid
    pub doc_title: String,
    /// 这一篇的格式。page 对 PDF、漫画是页码，对电子书是第几节，说法要看它
    pub doc_kind: String,
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
    // 要升级的老库先留一份备份，赶在下面任何一句会改库的语句之前
    crate::migrate::backup(&conn, path)?;
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
    crate::xray::init_schema(conn)?;
    // 老库升级：docs 后来才加的列
    let has_author = conn
        .prepare("SELECT 1 FROM pragma_table_info('docs') WHERE name = 'author'")?
        .exists([])?;
    if !has_author {
        conn.execute("ALTER TABLE docs ADD COLUMN author TEXT", [])?;
    }
    // 上面建的是最早那一版的表；之后加的表和列都走带版本号的升级（新库也走一遍，只有一条路）
    crate::migrate::run(conn)?;
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

/// 删掉一篇：向量和全文索引里它的行，再删 docs 那一行（片段、划线笔记、进度、封面、透视
/// 靠外键级联跟着走）。所有要删文档的地方都走这一个函数——两张索引表没有外键，
/// 漏删一处就会留下指向不存在片段的行。
/// 只管这一篇本身；它所在的书要不要跟着处理，见 books::delete_document。
pub fn delete_document_in(tx: &Transaction, doc_id: &str) -> Result<()> {
    drop_index_rows(tx, doc_id)?;
    tx.execute("DELETE FROM docs WHERE id = ?1", params![doc_id])?;
    Ok(())
}

/// 把一篇在两张索引表里的行删掉（片段本身不动）
fn drop_index_rows(tx: &Transaction, doc_id: &str) -> Result<()> {
    // vec0 表没有外键级联，手动删
    if table_exists(tx, "vec_chunks")? {
        let ids: Vec<i64> = {
            let mut stmt = tx.prepare("SELECT id FROM chunks WHERE doc_id = ?1")?;
            let rows = stmt.query_map(params![doc_id], |r| r.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut del = tx.prepare("DELETE FROM vec_chunks WHERE rowid = ?1")?;
        for id in ids {
            del.execute(params![id])?;
        }
    }
    tx.execute(
        "DELETE FROM fts_chunks WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?1)",
        params![doc_id],
    )?;
    Ok(())
}

pub(crate) fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
        params![name],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// 向量检索：在 access 放行的片段里找最近的 k 个。
///
/// 范围和防剧透的界线作为 rowid 的候选集交给 vec0，它只在这些片段里比距离。
/// 所以 k 数的是「能看的片段里最近的 k 个」，返回的第一条就是能看的里面最近的那条——
/// 调用方按「和最近的差多少」取舍时，参照的不会是一条用户看不到的片段。
pub fn search_vec(
    conn: &Connection,
    embedding: &[f32],
    k: usize,
    access: &crate::spoiler::Access,
) -> Result<Vec<SearchHit>> {
    use rusqlite::types::Value;
    if !table_exists(conn, "vec_chunks")? {
        return Ok(vec![]);
    }
    let mut args = vec![Value::Text(vec_json(embedding)), Value::Integer(k as i64)];
    let filter = match access.filter(3) {
        Some((sql, more)) => {
            args.extend(more);
            format!("AND v.rowid IN (SELECT c.id FROM chunks c WHERE {sql})")
        }
        None => String::new(),
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT v.rowid, v.distance, h.doc_id, h.idx, h.page, h.text, d.title, d.kind,
                COALESCE(d.book_id, '')
         FROM vec_chunks v
         JOIN chunks h ON h.id = v.rowid
         JOIN docs d ON d.id = h.doc_id
         WHERE v.embedding MATCH ?1 AND k = ?2 {filter}
         ORDER BY v.distance"
    ))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
        Ok(SearchHit {
            chunk_id: r.get(0)?,
            distance: r.get(1)?,
            doc_id: r.get(2)?,
            idx: r.get(3)?,
            page: r.get(4)?,
            text: r.get(5)?,
            doc_title: r.get(6)?,
            doc_kind: r.get(7)?,
            book_id: r.get(8)?,
            via: "vec",
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
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

/// 重建索引的第一步：向量整表扔掉（换了模型、维度都从头来）。
/// 片段和全文索引留着——接下来按原文件一篇一篇重写，原文件找不到的那些至少还能按旧内容搜到
pub fn clear_vectors(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS vec_chunks;
         DELETE FROM meta WHERE key IN ('embedding_dim', 'embedding_model');",
    )?;
    Ok(())
}

/// 所有文档的 (id, 原文件路径)。重建索引时按它一篇一篇来
pub fn doc_files(conn: &Connection) -> Result<Vec<(String, Option<String>)>> {
    let mut stmt = conn.prepare("SELECT id, path FROM docs ORDER BY created_at, rowid")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub(crate) fn now() -> i64 {
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

/// 原文件的大小和修改时间（毫秒）。下次扫描时两样都没变就不用重新解析
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub size: i64,
    pub mtime: i64,
}

impl Stamp {
    /// 文件不在、或者读不到属性时是 None
    pub fn of(path: &Path) -> Option<Stamp> {
        let meta = std::fs::metadata(path).ok()?;
        let mtime = meta
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis() as i64;
        Some(Stamp {
            size: meta.len() as i64,
            mtime,
        })
    }
}

/// 一篇解析出来的样子。chunks 可以为空（漫画、扫描件）：能读，只是搜不到。
pub struct NewDoc<'a> {
    pub title: &'a str,
    pub path: &'a str,
    pub kind: &'a str,
    pub pages: Option<i64>,
    pub author: Option<&'a str>,
    pub cover: Option<&'a [u8]>,
}

/// 一篇现在存着的片段文字，按顺序。重新解析之后拿它比：文字没变就不用重写
pub fn chunk_texts(conn: &Connection, doc_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT text FROM chunks WHERE doc_id = ?1 ORDER BY idx, id")?;
    let rows = stmt.query_map(params![doc_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 入库用的分词。是 CPU 活，在开事务（占着数据库锁）之前做完
pub fn segment_all(chunks: &[TextChunk]) -> Vec<String> {
    chunks
        .iter()
        .map(|c| crate::fts::segment(&c.text))
        .collect()
}

fn write_chunks(
    tx: &Transaction,
    doc_id: &str,
    chunks: &[TextChunk],
    words: &[String],
) -> Result<()> {
    let mut ins_chunk =
        tx.prepare("INSERT INTO chunks(doc_id, idx, page, text) VALUES(?1,?2,?3,?4)")?;
    let mut ins_fts = tx.prepare("INSERT INTO fts_chunks(rowid, text) VALUES(?1, ?2)")?;
    for (c, w) in chunks.iter().zip(words) {
        ins_chunk.execute(params![doc_id, c.idx, c.page, c.text])?;
        ins_fts.execute(params![tx.last_insert_rowid(), w])?;
    }
    Ok(())
}

fn write_cover(tx: &Transaction, doc_id: &str, cover: Option<&[u8]>) -> Result<()> {
    if let Some(data) = cover {
        tx.execute(
            "INSERT OR REPLACE INTO covers(doc_id, data) VALUES(?1, ?2)",
            params![doc_id, data],
        )?;
    }
    Ok(())
}

/// 往一本书里加一篇，排在最后。只建全文索引；向量要调接口，由后台任务补（见 search.rs）。
/// words 是 segment_all(chunks) 的结果。
pub fn insert_document(
    tx: &Transaction,
    book_id: &str,
    doc: &NewDoc,
    stamp: Option<Stamp>,
    chunks: &[TextChunk],
    words: &[String],
) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let position: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM docs WHERE book_id = ?1",
        params![book_id],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO docs(id, title, path, kind, pages, author, created_at, book_id, position, file_size, file_mtime)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            id,
            doc.title,
            doc.path,
            doc.kind,
            doc.pages,
            doc.author,
            now(),
            book_id,
            position,
            stamp.map(|s| s.size),
            stamp.map(|s| s.mtime),
        ],
    )?;
    write_chunks(tx, &id, chunks, words)?;
    write_cover(tx, &id, doc.cover)?;
    Ok(id)
}

/// 原地换掉一篇的内容：id、所在的书、位置都不变，所以这一篇上的划线、笔记、进度都还在。
/// 片段和索引整个重写，rev 加一（正在跑的透视靠它发现「这一篇变过了」）。
/// 只有文字真的变了才把这一篇的透视作废；返回文字变没变。
pub fn replace_content(
    tx: &Transaction,
    doc_id: &str,
    doc: &NewDoc,
    stamp: Option<Stamp>,
    chunks: &[TextChunk],
    words: &[String],
) -> Result<bool> {
    let changed = !chunk_texts(tx, doc_id)?
        .iter()
        .map(String::as_str)
        .eq(chunks.iter().map(|c| c.text.as_str()));
    drop_index_rows(tx, doc_id)?;
    tx.execute("DELETE FROM chunks WHERE doc_id = ?1", params![doc_id])?;
    if changed {
        // 内容变了，按旧内容做的透视作废
        tx.execute("DELETE FROM xray_units WHERE doc_id = ?1", params![doc_id])?;
    }
    tx.execute(
        "UPDATE docs SET title = ?2, kind = ?3, pages = ?4, author = ?5,
                file_size = ?6, file_mtime = ?7, rev = rev + 1
         WHERE id = ?1",
        params![
            doc_id,
            doc.title,
            doc.kind,
            doc.pages,
            doc.author,
            stamp.map(|s| s.size),
            stamp.map(|s| s.mtime),
        ],
    )?;
    write_chunks(tx, doc_id, chunks, words)?;
    write_cover(tx, doc_id, doc.cover)?;
    Ok(changed)
}

/// 文件动过（另存了一下、被同步工具碰了）但解析出来的文字没变：只记下新的大小和修改时间
pub fn touch_document(conn: &Connection, doc_id: &str, stamp: Option<Stamp>) -> Result<()> {
    conn.execute(
        "UPDATE docs SET file_size = ?2, file_mtime = ?3 WHERE id = ?1",
        params![doc_id, stamp.map(|s| s.size), stamp.map(|s| s.mtime)],
    )?;
    Ok(())
}

/// 导入一份已经解析好的文档，按「单个文件」的规则放：
/// 这个路径导入过 → 原地换内容（文字没变就什么都不动）；
/// 没导入过 → 它所在的文件夹（或上级）已经是一本书就加进那本书，否则自己成一本。
/// 不看文件本身的大小和修改时间；应用里的导入走 import.rs，那边先比这两样、能不解析就不解析。
pub fn import_document(
    conn: &mut Connection,
    doc: &NewDoc,
    chunks: &[TextChunk],
) -> Result<String> {
    let words = segment_all(chunks);
    let tx = conn.transaction()?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM docs WHERE path = ?1",
            params![doc.path],
            |r| r.get(0),
        )
        .ok();
    let doc_id = match existing {
        Some(id) => {
            let same = chunk_texts(&tx, &id)?
                .iter()
                .map(String::as_str)
                .eq(chunks.iter().map(|c| c.text.as_str()));
            if !same {
                replace_content(&tx, &id, doc, None, chunks, &words)?;
            }
            id
        }
        None => {
            let book_id = match crate::books::folder_book_for(&tx, Path::new(doc.path))? {
                Some(book) => book.id,
                None => crate::books::create_book(
                    &tx,
                    &crate::books::stem_title(doc.title, Some(doc.path)),
                    doc.author,
                    None,
                    crate::books::Scan::None,
                )?,
            };
            insert_document(&tx, &book_id, doc, None, chunks, &words)?
        }
    };
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

/// 列出标记。doc_ids 限定到某几篇，book_id 限定到一本书，两样都不给就是全部。
/// 顺序跟着书走：先按书，书里按篇的先后，同一篇里按划的时间——跨篇的笔记读起来才是顺的。
/// doc_title 填的是对外显示的名字（单文件的书是书名，多篇的是「书名 · 篇名」）。
pub fn list_annotations(
    conn: &Connection,
    doc_ids: Option<&[String]>,
    book_id: Option<&str>,
) -> Result<Vec<Annotation>> {
    use rusqlite::types::Value;
    let mut sql = String::from(
        "SELECT a.id, a.doc_id, a.kind, a.cfi, a.text, a.note, a.color, a.style, a.label, a.page,
                a.created_at, a.updated_at, d.title
         FROM annotations a
         JOIN docs d ON d.id = a.doc_id
         LEFT JOIN books b ON b.id = d.book_id
         WHERE 1 = 1",
    );
    let mut args: Vec<Value> = Vec::new();
    if let Some(book) = book_id {
        sql.push_str(" AND d.book_id = ?");
        args.push(Value::Text(book.to_string()));
    }
    if let Some(ids) = doc_ids.filter(|ids| !ids.is_empty()) {
        sql.push_str(" AND a.doc_id IN (");
        sql.push_str(&vec!["?"; ids.len()].join(","));
        sql.push(')');
        args.extend(ids.iter().map(|i| Value::Text(i.clone())));
    }
    sql.push_str(
        " ORDER BY b.created_at DESC, b.rowid DESC, d.position, d.created_at, a.created_at, a.rowid",
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
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
    if !out.is_empty() {
        let labels = crate::books::labels(conn)?;
        for a in &mut out {
            if let Some(l) = labels.get(&a.doc_id) {
                a.doc_title = l.display_title.clone();
            }
        }
    }
    Ok(out)
}

// ---------- 阅读进度 ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingState {
    pub location: Option<String>,
    pub fraction: f64,
    /// 读到过的最远处。只增不减：往回翻不会让它变小，防剧透按它算
    pub furthest: f64,
    /// 读到过的最远一页 / 一节（PDF、EPUB 才有）
    pub furthest_page: Option<i64>,
}

pub fn reading_state(conn: &Connection, doc_id: &str) -> Result<Option<ReadingState>> {
    Ok(conn
        .query_row(
            "SELECT location, fraction, furthest, furthest_page FROM reading_state WHERE doc_id = ?1",
            params![doc_id],
            |r| {
                Ok(ReadingState {
                    location: r.get(0)?,
                    fraction: r.get(1)?,
                    furthest: r.get(2)?,
                    furthest_page: r.get(3)?,
                })
            },
        )
        .ok())
}

/// 记下读到哪了。fraction 是现在的位置，可以往回走；
/// furthest / furthest_page 是到过的最远处，只会变大——翻回去重看前面的章节，不该让已经读过的后文又被当成没读过。
pub fn save_reading_state(
    conn: &Connection,
    doc_id: &str,
    location: &str,
    fraction: f64,
    page: Option<i64>,
) -> Result<()> {
    let fraction = if fraction.is_finite() {
        fraction.clamp(0.0, 1.0)
    } else {
        0.0
    };
    conn.execute(
        "INSERT INTO reading_state(doc_id, location, fraction, updated_at, furthest, furthest_page)
         VALUES(?1, ?2, ?3, ?4, ?3, ?5)
         ON CONFLICT(doc_id) DO UPDATE SET
            location = excluded.location,
            fraction = excluded.fraction,
            updated_at = excluded.updated_at,
            furthest = MAX(reading_state.furthest, excluded.fraction),
            -- 升级前的记录只有「读到几分之几」、没有页码。这时如果是往回翻（比原来读到的地方靠前），
            -- 不能把这一页当成读到的最远一页，等翻过原来的位置再开始记页码
            furthest_page = CASE
                WHEN reading_state.furthest_page IS NULL AND excluded.fraction < reading_state.furthest THEN NULL
                ELSE MAX(
                    COALESCE(reading_state.furthest_page, excluded.furthest_page),
                    COALESCE(excluded.furthest_page, reading_state.furthest_page))
            END",
        params![doc_id, location, fraction, now(), page],
    )?;
    Ok(())
}

// ---------- 会话 ----------

#[derive(Debug, Serialize)]
pub struct SessionOut {
    pub id: String,
    pub sdk_session_id: Option<String>,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// 这段对话是关于哪本书的；和书无关、或者书已经被移除了是 null
    pub book_id: Option<String>,
    /// 关联时记下的书名。书被移除后 book_id 会变成 null，它留着，还能看出原来聊的是哪本
    pub book_title: Option<String>,
    /// 用户给这段对话选的检索范围（JSON 文本，界面自己解析）；null 是默认
    pub scope: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MessageOut {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub meta: Option<String>,
    pub created_at: i64,
}

/// 新建或更新一段对话。属于哪本书只在新建时定下来：界面每轮都会调这个函数，
/// 当时开着哪本书是会变的，不能让后来的调用把最初的归属改掉（要改走 set_session_book）。
/// book_id 用子查询绑：传来的 id 已经不在了（书刚被移除）就当没有，不让外键把整次写入打回去。
pub fn upsert_session(
    conn: &Connection,
    id: &str,
    title: &str,
    sdk_session_id: Option<&str>,
    book_id: Option<&str>,
) -> Result<()> {
    let t = now();
    conn.execute(
        "INSERT INTO sessions(id, sdk_session_id, title, created_at, updated_at, book_id, book_title)
         VALUES(?1, ?2, ?3, ?4, ?4,
                (SELECT id FROM books WHERE id = ?5),
                (SELECT title FROM books WHERE id = ?5))
         ON CONFLICT(id) DO UPDATE SET
            sdk_session_id = COALESCE(excluded.sdk_session_id, sessions.sdk_session_id),
            updated_at = excluded.updated_at",
        params![id, sdk_session_id, title, t, book_id],
    )?;
    Ok(())
}

/// 手动把一段对话归到某本书下（书名快照跟着更新），或者传 None 取消关联
pub fn set_session_book(conn: &Connection, id: &str, book_id: Option<&str>) -> Result<()> {
    match book_id {
        Some(book) => {
            let title: Option<String> = conn
                .query_row(
                    "SELECT title FROM books WHERE id = ?1",
                    params![book],
                    |r| r.get(0),
                )
                .ok();
            let Some(title) = title else {
                return Err(anyhow!("这本书已经不在书架上了"));
            };
            conn.execute(
                "UPDATE sessions SET book_id = ?2, book_title = ?3 WHERE id = ?1",
                params![id, book, title],
            )?;
        }
        None => {
            conn.execute(
                "UPDATE sessions SET book_id = NULL, book_title = NULL WHERE id = ?1",
                params![id],
            )?;
        }
    }
    Ok(())
}

/// 记下这段对话的检索范围。scope 是界面给的 JSON 文本，这边原样存取，不解释
pub fn set_session_scope(conn: &Connection, id: &str, scope: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET scope = ?2 WHERE id = ?1",
        params![id, scope],
    )?;
    Ok(())
}

pub fn list_sessions(conn: &Connection) -> Result<Vec<SessionOut>> {
    let mut stmt = conn.prepare(
        "SELECT id, sdk_session_id, title, created_at, updated_at, book_id, book_title, scope
         FROM sessions ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SessionOut {
            id: r.get(0)?,
            sdk_session_id: r.get(1)?,
            title: r.get(2)?,
            created_at: r.get(3)?,
            updated_at: r.get(4)?,
            book_id: r.get(5)?,
            book_title: r.get(6)?,
            scope: r.get(7)?,
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
        upsert_session(&conn, "s1", "第一个会话", None, None).unwrap();
        add_message(&conn, "s1", "user", "你好", None).unwrap();
        add_message(&conn, "s1", "assistant", "你好，有什么可以帮你", Some("{}")).unwrap();
        // 后续拿到 SDK 会话 id 再补上，标题不被覆盖
        upsert_session(&conn, "s1", "不应覆盖", Some("sdk-abc"), None).unwrap();

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
        save_reading_state(&conn, &id, "epubcfi(/6/4)", 0.4, None).unwrap();

        // 同一路径再导入：id 不变，内容换新，笔记和进度都在
        let again = import_document(&mut conn, &doc, &[chunk("换了内容的正文")]).unwrap();
        assert_eq!(again, id);
        let found = |q: &str| {
            crate::fts::search(&conn, q, 3, &crate::spoiler::Access::all())
                .unwrap()
                .len()
        };
        assert_eq!(found("换了内容"), 1);
        assert_eq!(found("傍晚开始"), 0);
        let notes = list_annotations(&conn, None, None).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].note, "改过的");
        assert_eq!(notes[0].doc_title, "书");
        assert_eq!(reading_state(&conn, &id).unwrap().unwrap().fraction, 0.4);
        let shelf = crate::books::list_books(&conn).unwrap();
        assert_eq!(shelf[0].author.as_deref(), Some("某人"));
        assert!(shelf[0].has_cover && shelf[0].docs[0].has_cover);
        assert_eq!(shelf[0].progress, Some(0.4));
        assert_eq!(shelf[0].docs[0].progress, Some(0.4));
        // 内容换过一次，版本号跟着走；同样的内容再导入一遍什么都不动
        let rev = |conn: &Connection| -> i64 {
            conn.query_row("SELECT rev FROM docs WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(rev(&conn), 1);
        import_document(&mut conn, &doc, &[chunk("换了内容的正文")]).unwrap();
        assert_eq!(rev(&conn), 1);

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
        assert_eq!(crate::books::list_books(&conn).unwrap().len(), 2);

        crate::books::delete_document(&mut conn, &id).unwrap();
        assert!(list_annotations(&conn, None, None).unwrap().is_empty());
        assert!(reading_state(&conn, &id).unwrap().is_none());
        assert!(cover(&conn, &id).unwrap().is_none());
        // 它是那本书唯一的一篇，书也跟着没了
        assert_eq!(crate::books::list_books(&conn).unwrap().len(), 1);
    }
}
