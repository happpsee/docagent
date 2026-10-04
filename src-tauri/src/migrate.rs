//! 库的升级。版本号记在 SQLite 自带的 `PRAGMA user_version` 里。
//!
//! 第 1 版：书架的单位从「文件」变成「书」。加 books 等几张表，给 docs / sessions / reading_state
//! 加列，再把库里已有的文档归成书。
//!
//! 几条规矩：
//! - 动老库之前先整库备份一份（`VACUUM INTO`）。升级写错了，用户的笔记还找得回来。
//! - 一次升级的所有改动放在一个事务里，版本号在同一个事务的最后写。中途断电、崩溃，
//!   库还是升级前的样子，下次打开从头再来——所以这里的每一步都不怕重跑。
//! - 不重建、不 DROP docs：外键开着，那样会把片段、笔记、进度一路级联删光。只加列。

use crate::books::{self, Scan};
use crate::db;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, Transaction};
use std::collections::BTreeMap;
use std::path::Path;

/// 升级前的备份，和数据库放在同一个目录
pub const BACKUP_NAME: &str = "docagent.backup-v0.db";

fn user_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// 还没升级过、而且里面有东西的库，先备份。
/// 用 VACUUM INTO 而不是复制文件：库开着 WAL，最近的改动可能还在 -wal 文件里，
/// 只拷主文件会拷出一份缺内容的库。
/// 上次升级到一半崩了会留下一份旧备份，先删掉（VACUUM INTO 不肯覆盖已有的文件）；
/// 那时库还没动过，重新备份出来的内容是一样的。
/// 备份不成就不往下走：宁可这次打不开，也不在没有退路的情况下改用户的库。
pub fn backup(conn: &Connection, db_path: &Path) -> Result<()> {
    if user_version(conn)? != 0 || !db::table_exists(conn, "docs")? {
        return Ok(());
    }
    let has_docs = conn.prepare("SELECT 1 FROM docs LIMIT 1")?.exists([])?;
    if !has_docs {
        return Ok(());
    }
    let target = db_path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join(BACKUP_NAME);
    if target.exists() {
        std::fs::remove_file(&target)
            .with_context(|| format!("删不掉旧的备份 {}", target.display()))?;
    }
    conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])
        .with_context(|| format!("升级前备份数据库失败（{}）", target.display()))?;
    Ok(())
}

/// 把库升到最新一版，再把没有归属的文档补上。每次打开都调
pub fn run(conn: &Connection) -> Result<()> {
    if user_version(conn)? < 1 {
        migration_1(conn)?;
    }
    repair(conn)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    Ok(conn
        .prepare("SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2")?
        .exists(params![table, column])?)
}

fn add_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    if !has_column(conn, table, column)? {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )?;
    }
    Ok(())
}

fn migration_1(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        r#"
        -- 书架上的一本书。folder 为空是单文件的书；不为空是「文件夹书」，folder 是它在磁盘上的目录
        CREATE TABLE IF NOT EXISTS books (
            id            TEXT PRIMARY KEY,
            title         TEXT NOT NULL,
            author        TEXT,
            folder        TEXT,                          -- 规范化过（结尾不带斜杠）
            scan          TEXT NOT NULL DEFAULT 'none',  -- none 只有手动加的 / flat 这一层全部 / deep 含子文件夹
            spoiler_free  INTEGER,                       -- 空 = 按书的类型取默认值
            created_at    INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_books_folder ON books(folder) WHERE folder IS NOT NULL;
        -- 用户自己上传的封面。自动取的封面还在 covers 里，跟着篇走
        CREATE TABLE IF NOT EXISTS book_custom_covers (
            book_id     TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
            data        BLOB NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        -- 用户从书里移除的篇：文件还在文件夹里，再扫描时不能又把它收回来
        CREATE TABLE IF NOT EXISTS book_excluded (
            book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            path     TEXT NOT NULL,
            PRIMARY KEY (book_id, path)
        );
        "#,
    )?;
    for (table, column, decl) in [
        ("docs", "book_id", "TEXT REFERENCES books(id)"),
        ("docs", "position", "INTEGER NOT NULL DEFAULT 0"),
        ("docs", "file_size", "INTEGER"),
        ("docs", "file_mtime", "INTEGER"),
        // 这一篇的片段每重写一次加一
        ("docs", "rev", "INTEGER NOT NULL DEFAULT 0"),
        (
            "sessions",
            "book_id",
            "TEXT REFERENCES books(id) ON DELETE SET NULL",
        ),
        // 关联时记下的书名；书被移除后还留着
        ("sessions", "book_title", "TEXT"),
        // 检索范围（JSON），空 = 默认
        ("sessions", "scope", "TEXT"),
        ("reading_state", "furthest", "REAL NOT NULL DEFAULT 0"),
        ("reading_state", "furthest_page", "INTEGER"),
    ] {
        add_column(&tx, table, column, decl)?;
    }
    tx.execute_batch("CREATE INDEX IF NOT EXISTS idx_docs_book ON docs(book_id, position);")?;

    group_existing_docs(&tx)?;
    // 「读到过的最远处」以前没记，拿现在的位置当起点（取大的：重跑一遍也不会把已经记下的改小）
    tx.execute(
        "UPDATE reading_state SET furthest = MAX(furthest, fraction)",
        [],
    )?;
    carry_reader_pref(&tx)?;
    link_sessions(&tx)?;

    tx.pragma_update(None, "user_version", 1)?;
    tx.commit()?;
    Ok(())
}

/// 把升级前的文档归成书。
/// 同一个目录里的 Markdown / TXT / DOCX 有两份以上的，合成一本以目录命名的书——
/// 这类文件通常是一个项目的几份文档，按文件名各摆一本，书架上就是一排 README。
/// 电子书和 PDF 本来就是一个文件一本书，各自成一本；落单的文档也是。
fn group_existing_docs(tx: &Transaction) -> Result<()> {
    struct Old {
        id: String,
        path: Option<String>,
        kind: String,
        created_at: i64,
    }
    let docs: Vec<Old> = {
        let mut stmt = tx.prepare(
            "SELECT id, path, kind, created_at FROM docs WHERE book_id IS NULL ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Old {
                id: r.get(0)?,
                path: r.get(1)?,
                kind: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut by_dir: BTreeMap<String, Vec<&Old>> = BTreeMap::new();
    for d in &docs {
        if !matches!(d.kind.as_str(), "md" | "txt" | "docx") {
            continue;
        }
        let dir = d.path.as_deref().and_then(|p| Path::new(p).parent());
        if let Some(dir) = dir.filter(|d| !d.as_os_str().is_empty()) {
            by_dir.entry(books::norm_folder(dir)).or_default().push(d);
        }
    }
    let mut grouped: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (folder, mut members) in by_dir {
        if members.len() < 2 {
            continue;
        }
        members.sort_by(|a, b| {
            let name = |d: &Old| {
                d.path
                    .as_deref()
                    .and_then(|p| Path::new(p).file_name().map(std::path::PathBuf::from))
                    .unwrap_or_default()
            };
            crate::natural::cmp(&name(a), &name(b))
        });
        let created = members.iter().map(|d| d.created_at).min().unwrap_or(0);
        // 上一次升级如果在别的版本里留下过这个目录的书，接着用，不撞唯一索引
        let book_id = match books::folder_book_at(tx, &folder)? {
            Some(book) => book.id,
            None => books::create_book_at(
                tx,
                &books::folder_title(&folder),
                None,
                Some(&folder),
                Scan::None,
                created,
            )?,
        };
        let base: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM docs WHERE book_id = ?1",
            params![book_id],
            |r| r.get(0),
        )?;
        for (i, d) in members.iter().enumerate() {
            tx.execute(
                "UPDATE docs SET book_id = ?2, position = ?3 WHERE id = ?1",
                params![d.id, book_id, base + i as i64],
            )?;
            grouped.insert(d.id.as_str());
        }
    }
    for d in docs.iter().filter(|d| !grouped.contains(d.id.as_str())) {
        books::give_own_book(tx, &d.id, None)?;
    }
    Ok(())
}

/// 防剧透以前是阅读器的一个全局开关（meta 表的 reader 键，JSON）。用户关掉过的话，
/// 升级后每本书都照着关；没动过就留空，按书的类型取默认值。
fn carry_reader_pref(tx: &Transaction) -> Result<()> {
    let off = db::get_setting(tx, "reader")?
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("spoilerFree").and_then(|s| s.as_bool()))
        == Some(false);
    if off {
        tx.execute(
            "UPDATE books SET spoiler_free = 0 WHERE spoiler_free IS NULL",
            [],
        )?;
    }
    Ok(())
}

/// 给已有的对话找到它聊的那本书：看消息里引用过哪些文档（见 books::session_book）
fn link_sessions(tx: &Transaction) -> Result<()> {
    let ids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM sessions WHERE book_id IS NULL")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for id in ids {
        if let Some((book_id, title)) = books::session_book(tx, &id)? {
            tx.execute(
                "UPDATE sessions SET book_id = ?2, book_title = ?3 WHERE id = ?1",
                params![id, book_id, title],
            )?;
        }
    }
    Ok(())
}

/// 每次打开都做，把两种不该有的状态收拾掉：
/// - 不属于任何一本书的文档（比如升级后又用旧版本导入的）：各自补一本书，不然在书架上看不见。
/// - 一篇都没有的书（导入到一半应用被关掉，书建了、文件还没收进来）：删掉，书架上不留打不开的空壳。
fn repair(conn: &Connection) -> Result<()> {
    let orphans: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM docs WHERE book_id IS NULL")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let tx = conn.unchecked_transaction()?;
    for id in orphans {
        books::give_own_book(&tx, &id, None)?;
    }
    tx.execute(
        "DELETE FROM books WHERE NOT EXISTS (SELECT 1 FROM docs WHERE docs.book_id = books.id)",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// 升级之前那一版的表结构（照着旧代码抄的，不能跟着新代码变）
    const OLD_SCHEMA: &str = r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE docs (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, path TEXT, kind TEXT NOT NULL,
            pages INTEGER, created_at INTEGER NOT NULL, author TEXT);
        CREATE TABLE chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
            idx INTEGER NOT NULL, page INTEGER, text TEXT NOT NULL);
        CREATE INDEX idx_chunks_doc ON chunks(doc_id);
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, sdk_session_id TEXT, title TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL);
        CREATE INDEX idx_messages_session ON messages(session_id);
        CREATE TABLE covers (
            doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE, data BLOB NOT NULL);
        CREATE TABLE annotations (
            id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
            kind TEXT NOT NULL, cfi TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'yellow',
            style TEXT NOT NULL DEFAULT 'highlight', label TEXT NOT NULL DEFAULT '',
            page INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE INDEX idx_annotations_doc ON annotations(doc_id);
        CREATE TABLE reading_state (
            doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
            location TEXT, fraction REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
        CREATE VIRTUAL TABLE fts_chunks
            USING fts5(text, content='', contentless_delete=1, tokenize='unicode61');
        CREATE TABLE xray_units (
            doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
            unit INTEGER NOT NULL, page INTEGER, start REAL NOT NULL, end REAL NOT NULL,
            title TEXT NOT NULL, summary TEXT NOT NULL, entities TEXT NOT NULL,
            PRIMARY KEY (doc_id, unit));
    "#;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("docagent-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 一个旧版本用过一阵子的库：项目文件夹里的两份 Markdown、一本 EPUB、一份单独的 PDF，
    /// 有封面、划线、进度，还有一段引用过那本 EPUB 的对话
    fn old_library(path: &Path) {
        // 先开一次库，让 sqlite-vec 扩展注册上：下面要建一张向量表
        drop(db::open_in_memory().unwrap());
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(OLD_SCHEMA).unwrap();
        // 配过向量接口的库里还有一张 vec0 虚拟表，备份和升级都得带着它走
        conn.execute_batch(
            r#"
            CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[4]);
            INSERT INTO vec_chunks(rowid, embedding) VALUES (1, '[0.1,0.2,0.3,0.4]');
            INSERT INTO meta(key, value) VALUES ('embedding_model', 'm'), ('embedding_dim', '4');
            "#,
        )
        .unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO docs(id, title, path, kind, pages, created_at, author) VALUES
              ('d-plan',   'AgentFlow-待实现代码清单.md', '/Users/me/AgentFlow/AgentFlow-待实现代码清单.md', 'md', NULL, 200, NULL),
              ('d-readme', 'README.md', '/Users/me/AgentFlow/README.md', 'md', NULL, 100, NULL),
              ('d-node',   'Node.js 设计模式', '/Users/me/书/nodejs-design-patterns.epub', 'epub', NULL, 300, 'Mario Casciaro'),
              ('d-pdf',    '采购合同.pdf', '/Users/me/合同/采购合同.pdf', 'pdf', 3, 400, NULL),
              ('d-lone',   '备忘.txt', '/Users/me/杂/备忘.txt', 'txt', NULL, 500, NULL);
            INSERT INTO chunks(doc_id, idx, page, text) VALUES
              ('d-readme', 0, NULL, '这个项目是一个流程编排引擎。'),
              ('d-plan', 0, NULL, '待实现：重试策略。'),
              ('d-node', 0, 1, '第一章 Node.js 平台'),
              ('d-node', 1, 2, '第二章 回调与事件');
            INSERT INTO covers(doc_id, data) VALUES ('d-node', x'010203');
            INSERT INTO annotations(id, doc_id, kind, cfi, text, note, created_at, updated_at) VALUES
              ('a1', 'd-node', 'highlight', 'epubcfi(/6/2)', '回调与事件', '重点', 10, 10),
              ('a2', 'd-readme', 'bookmark', 'epubcfi(/6/4)', '', '', 11, 11);
            INSERT INTO reading_state(doc_id, location, fraction, updated_at) VALUES
              ('d-node', 'epubcfi(/6/4)', 0.4, 900),
              ('d-readme', 'epubcfi(/6/2)', 0.25, 800);
            INSERT INTO sessions(id, sdk_session_id, title, created_at, updated_at) VALUES
              ('s-node', 'sdk-1', '回调是什么', 50, 60),
              ('s-mixed', NULL, '两本一起问', 51, 61),
              ('s-none', NULL, '随便聊聊', 52, 62);
            INSERT INTO messages(session_id, role, content, meta, created_at) VALUES
              ('s-node', 'user', '回调是什么', '{"quote":{"docId":"d-node","text":"回调"}}', 50),
              ('s-node', 'assistant', '……', '{"hits":[{"docId":"d-node","chunkId":4},{"docId":"已经删掉的文档","chunkId":9}]}', 51),
              ('s-mixed', 'assistant', '……', '{"hits":[{"docId":"d-node"},{"docId":"d-pdf"}]}', 52),
              ('s-none', 'user', '你好', NULL, 53),
              ('s-none', 'assistant', '你好', '这不是 JSON', 54);
            INSERT INTO xray_units(doc_id, unit, page, start, end, title, summary, entities)
              VALUES ('d-node', 0, 1, 0, 0.5, '平台', '讲了平台。', '[]');
            "#,
        )
        .unwrap();
        assert_eq!(user_version(&conn).unwrap(), 0);
    }

    /// 库里和书有关的东西拍个快照，用来比两次打开之间有没有变化
    fn snapshot(conn: &Connection) -> Vec<String> {
        let mut out = Vec::new();
        for sql in [
            "SELECT id || '|' || title || '|' || COALESCE(author,'') || '|' || COALESCE(folder,'') || '|' || scan
                    || '|' || COALESCE(spoiler_free,'') || '|' || created_at FROM books ORDER BY id",
            "SELECT id || '|' || book_id || '|' || position || '|' || rev FROM docs ORDER BY id",
            "SELECT id || '|' || COALESCE(book_id,'') || '|' || COALESCE(book_title,'') FROM sessions ORDER BY id",
            "SELECT doc_id || '|' || fraction || '|' || furthest FROM reading_state ORDER BY doc_id",
        ] {
            let mut stmt = conn.prepare(sql).unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            out.extend(rows.map(|r| r.unwrap()));
        }
        out
    }

    #[test]
    fn 老库升级_同目录的文档合成一本_电子书各自成书_对话归到书下_先留备份() {
        let dir = temp_dir("migrate");
        let db_path = dir.join("docagent.db");
        old_library(&db_path);

        let conn = db::open(&db_path).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 1);

        let shelf = books::list_books(&conn).unwrap();
        // 两份 Markdown 合成一本，加上 EPUB、PDF、落单的 TXT，一共四本
        assert_eq!(shelf.len(), 4);
        let folder = shelf.iter().find(|b| b.folder.is_some()).unwrap();
        assert_eq!(folder.title, "AgentFlow");
        assert_eq!(folder.folder.as_deref(), Some("/Users/me/AgentFlow"));
        assert_eq!(folder.scan, Scan::None);
        // 建书时间取最早的那一份；篇按文件名的自然顺序排，不是按导入先后
        assert_eq!(folder.created_at, 100);
        let names: Vec<&str> = folder.docs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["AgentFlow-待实现代码清单", "README"]);
        assert_eq!(
            folder.docs.iter().map(|d| d.position).collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(folder.docs[1].display_title, "AgentFlow · README");
        assert_eq!(folder.note_count, 1);
        // 项目文档默认不防剧透
        assert!(!folder.spoiler_free && folder.spoiler_default);

        // 电子书的书名里带点，不是扩展名，不能被截掉
        let node = shelf.iter().find(|b| b.docs[0].id == "d-node").unwrap();
        assert_eq!(node.title, "Node.js 设计模式");
        assert_eq!(node.author.as_deref(), Some("Mario Casciaro"));
        assert!(node.folder.is_none());
        assert!(node.has_cover && !node.custom_cover);
        assert!(node.cover_rev.starts_with('d'));
        assert_eq!(books::cover(&conn, &node.id).unwrap(), Some(vec![1, 2, 3]));
        assert_eq!(node.docs[0].display_title, "Node.js 设计模式");
        assert!(node.spoiler_free && node.spoiler_default);
        // 文件名当标题的，书名去掉扩展名
        let pdf = shelf.iter().find(|b| b.docs[0].id == "d-pdf").unwrap();
        assert_eq!(pdf.title, "采购合同");
        assert_eq!(pdf.docs[0].title, "采购合同.pdf");
        // 目录里只有它一份文档的，不合并
        let lone = shelf.iter().find(|b| b.docs[0].id == "d-lone").unwrap();
        assert!(lone.folder.is_none());
        assert_eq!(lone.title, "备忘");

        // 笔记、进度、片段、透视原样都在；「最远处」从现在的位置起算
        assert_eq!(db::list_annotations(&conn, None, None).unwrap().len(), 2);
        let state = db::reading_state(&conn, "d-node").unwrap().unwrap();
        assert_eq!((state.fraction, state.furthest), (0.4, 0.4));
        assert_eq!(state.furthest_page, None);
        assert_eq!(node.progress, Some(0.4));
        assert_eq!(node.docs[0].furthest, 0.4);
        assert_eq!(db::chunk_texts(&conn, "d-node").unwrap().len(), 2);
        let xray: i64 = conn
            .query_row("SELECT COUNT(*) FROM xray_units", [], |r| r.get(0))
            .unwrap();
        assert_eq!(xray, 1);
        assert_eq!(db::vector_counts(&conn).unwrap(), (1, 4));
        // 老库的全文索引是空的，打开时按片段补上了
        assert_eq!(
            crate::fts::search(&conn, "回调", 3, &crate::spoiler::Access::all())
                .unwrap()
                .len(),
            1
        );

        // 对话：只引用过一本书的归到那本书下（已经删掉的文档不算数）；跨两本的、没引用的不归
        let sessions = db::list_sessions(&conn).unwrap();
        let of = |id: &str| sessions.iter().find(|s| s.id == id).unwrap();
        assert_eq!(of("s-node").book_id.as_deref(), Some(node.id.as_str()));
        assert_eq!(of("s-node").book_title.as_deref(), Some("Node.js 设计模式"));
        assert_eq!(of("s-mixed").book_id, None);
        assert_eq!(of("s-none").book_id, None);
        assert_eq!(node.session_count, 1);

        // 备份是升级之前的样子：没有 books 表，文档都在
        let backup_path = dir.join(BACKUP_NAME);
        assert!(backup_path.exists());
        let old = Connection::open(&backup_path).unwrap();
        assert_eq!(user_version(&old).unwrap(), 0);
        assert!(!db::table_exists(&old, "books").unwrap());
        let n: i64 = old
            .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 5);
        let vectors: i64 = old
            .query_row("SELECT COUNT(*) FROM vec_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(vectors, 1);
        drop(old);

        // 再打开一次：什么都不变，备份也不重写
        let before = snapshot(&conn);
        let backup_bytes = std::fs::read(&backup_path).unwrap();
        drop(conn);
        let conn = db::open(&db_path).unwrap();
        assert_eq!(snapshot(&conn), before);
        assert_eq!(user_version(&conn).unwrap(), 1);
        assert_eq!(std::fs::read(&backup_path).unwrap(), backup_bytes);

        // 升级的每一步都不怕重跑：用了一阵子之后，就算版本号被拨回去再走一遍，
        // 书、归属、之后读出来的进度都不会被改回去
        db::save_reading_state(&conn, "d-node", "epubcfi(/6/8)", 0.9, Some(5)).unwrap();
        db::save_reading_state(&conn, "d-node", "epubcfi(/6/2)", 0.1, Some(1)).unwrap();
        books::set_spoiler(&conn, &node.id, Some(false)).unwrap();
        let before = snapshot(&conn);
        conn.pragma_update(None, "user_version", 0).unwrap();
        drop(conn);
        let conn = db::open(&db_path).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 1);
        assert_eq!(snapshot(&conn), before);
        let state = db::reading_state(&conn, "d-node").unwrap().unwrap();
        assert_eq!((state.fraction, state.furthest), (0.1, 0.9));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 老库升级_以前关掉过防剧透的_每本书都照着关() {
        let dir = temp_dir("migrate-pref");
        let db_path = dir.join("docagent.db");
        old_library(&db_path);
        // 上次升级到一半留下的旧备份：不能挡住这一次
        std::fs::write(dir.join(BACKUP_NAME), b"stale").unwrap();
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "INSERT INTO meta(key, value) VALUES('reader', '{\"fontSize\":18,\"spoilerFree\":false}')",
                [],
            )
            .unwrap();
        }
        let conn = db::open(&db_path).unwrap();
        let shelf = books::list_books(&conn).unwrap();
        assert!(shelf.iter().all(|b| !b.spoiler_free && !b.spoiler_default));
        assert!(std::fs::read(dir.join(BACKUP_NAME)).unwrap().len() > 5);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 新库和内存库直接是最新版_不留备份() {
        let conn = db::open_in_memory().unwrap();
        assert_eq!(user_version(&conn).unwrap(), 1);
        assert!(books::list_books(&conn).unwrap().is_empty());

        let dir = temp_dir("migrate-fresh");
        let db_path = dir.join("docagent.db");
        let conn = db::open(&db_path).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 1);
        assert!(!dir.join(BACKUP_NAME).exists());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 每次打开都把没有归属的文档补成一本书() {
        let dir = temp_dir("migrate-repair");
        let db_path = dir.join("docagent.db");
        {
            let conn = db::open(&db_path).unwrap();
            // 模拟旧版本的程序在升级后的库上导入了一份：没有 book_id
            conn.execute(
                "INSERT INTO docs(id, title, path, kind, created_at) VALUES('old', '说明.md', '/x/说明.md', 'md', 7)",
                [],
            )
            .unwrap();
            assert!(books::list_books(&conn).unwrap().is_empty());
            // 模拟导入到一半应用被关掉：书建了，一篇都还没收进来
            books::create_book(&conn, "空壳", None, Some("/x/空壳"), Scan::Deep).unwrap();
        }
        let conn = db::open(&db_path).unwrap();
        let shelf = books::list_books(&conn).unwrap();
        assert_eq!(shelf.len(), 1);
        assert_eq!(shelf[0].title, "说明");
        assert_eq!(shelf[0].docs[0].id, "old");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
