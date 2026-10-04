//! 书：书架上的单位。
//!
//! 一本书有一篇或多篇（docs 表的行，一篇对应磁盘上的一个文件）。两种书：
//! - 单文件的书：`folder` 为空，只有一篇。书名是电子书自带的书名，没有就用文件名（去掉扩展名）。
//! - 文件夹书：`folder` 是磁盘上的一个目录，书名是目录名，篇是目录里的文件。
//!   `scan` 说明哪些文件算它的：none 只有用户亲手加的，flat 这一层全部，deep 连子文件夹。
//!
//! 「文件夹是单位」对零散的文件也成立：从同一个文件夹里挑几个文件可以合成一本以文件夹命名的书，
//! 不用把整个目录树都拉进来。
//!
//! 片段、索引、划线笔记、进度、透视、自动封面都挂在篇上，这里只管书和篇的归属、顺序、名字。

use crate::db::{self, Stamp};
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, Transaction};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// 文件夹书靠什么决定哪些文件是它的
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scan {
    None,
    Flat,
    Deep,
}

impl Scan {
    pub fn as_str(self) -> &'static str {
        match self {
            Scan::None => "none",
            Scan::Flat => "flat",
            Scan::Deep => "deep",
        }
    }

    fn parse(s: &str) -> Scan {
        match s {
            "flat" => Scan::Flat,
            "deep" => Scan::Deep,
            _ => Scan::None,
        }
    }
}

/// 书里的一篇
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    pub id: String,
    pub book_id: String,
    /// 在书里排第几，从 0 开始
    pub position: i64,
    /// 原始标题：文件名，或电子书自带的书名
    pub title: String,
    /// 篇名：去掉扩展名的文件名；同一本书里重名时带上相对路径
    pub name: String,
    /// 对外显示的名字：单文件的书就是书名，文件夹书是「书名 · 篇名」
    pub display_title: String,
    pub path: Option<String>,
    pub kind: String,
    pub pages: Option<i64>,
    pub chunk_count: i64,
    pub created_at: i64,
    pub author: Option<String>,
    /// 上次读到这一篇的几分之几；没打开过是 null
    pub progress: Option<f64>,
    /// 读到过的最远处（只增不减）
    pub furthest: f64,
    pub furthest_page: Option<i64>,
    pub opened: bool,
    pub read_at: Option<i64>,
    /// 原文件找不到了（被移走、改名，或者所在的盘没接上）
    pub missing: bool,
    pub has_cover: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub folder: Option<String>,
    pub scan: Scan,
    pub created_at: i64,
    pub has_cover: bool,
    /// 封面是用户自己上传的
    pub custom_cover: bool,
    /// 要显示的封面换了它就变，界面靠它知道该重新取图
    pub cover_rev: String,
    /// 全书读了多少；一篇都没打开过是 null
    pub progress: Option<f64>,
    pub read_at: Option<i64>,
    /// 防剧透现在是否生效（已经算上了按类型的默认值）
    pub spoiler_free: bool,
    /// 上面的值来自默认规则，用户没有手动设过
    pub spoiler_default: bool,
    pub session_count: i64,
    /// 这本书上的划线、笔记、书签总数
    pub note_count: i64,
    pub docs: Vec<Doc>,
}

/// 文档标题去掉扩展名——但只在标题就是文件名的时候。
/// 标题是从文件名来的（README.md）才有扩展名可去；电子书自带的书名里也可能有点
/// （「Node.js 设计模式」），那个点后面不是扩展名，不能截。书名和篇名都用这一个函数。
pub fn stem_title(doc_title: &str, doc_path: Option<&str>) -> String {
    let Some(path) = doc_path.map(Path::new) else {
        return doc_title.to_string();
    };
    let from_file_name = path
        .file_name()
        .is_some_and(|n| n.to_string_lossy() == doc_title);
    if !from_file_name {
        return doc_title.to_string();
    }
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| doc_title.to_string())
}

/// 目录路径的统一写法：结尾不带斜杠、中间没有多余的斜杠和 `.`。
/// books.folder 存的、拿来比较的都是这个写法，不然同一个目录会被当成两本书。
pub fn norm_folder(path: &Path) -> String {
    let clean: PathBuf = path.components().collect();
    clean.to_string_lossy().to_string()
}

/// 文件夹书的书名：目录名
pub fn folder_title(folder: &str) -> String {
    Path::new(folder)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| folder.to_string())
}

/// 一篇相对书的文件夹的路径（用 / 分隔）。不在那个文件夹下面的没有
fn rel_path(folder: Option<&str>, path: Option<&str>) -> Option<PathBuf> {
    let rel = Path::new(path?).strip_prefix(folder?).ok()?;
    (!rel.as_os_str().is_empty()).then(|| rel.to_path_buf())
}

/// 一本书里各篇的篇名。平时是去掉扩展名的文件名；两篇撞了名（各个子目录里都有一份 README）
/// 就改用相对书的文件夹的路径（api/README）；这样还撞（README.md 和 README.txt）就连扩展名一起带上。
fn part_names(folder: Option<&str>, parts: &[(&str, Option<&str>)]) -> Vec<String> {
    let mut names: Vec<String> = parts.iter().map(|(t, p)| stem_title(t, *p)).collect();
    for keep_ext in [false, true] {
        let mut seen: HashMap<&str, usize> = HashMap::new();
        for n in &names {
            *seen.entry(n.as_str()).or_default() += 1;
        }
        let clash: Vec<bool> = names.iter().map(|n| seen[n.as_str()] > 1).collect();
        if !clash.contains(&true) {
            break;
        }
        for (i, (_, path)) in parts.iter().enumerate() {
            if !clash[i] {
                continue;
            }
            if let Some(rel) = rel_path(folder, *path) {
                let rel = if keep_ext {
                    rel
                } else {
                    rel.with_extension("")
                };
                names[i] = rel.to_string_lossy().replace('\\', "/");
            }
        }
    }
    names
}

fn display_title(book_title: &str, folder: Option<&str>, name: &str) -> String {
    match folder {
        None => book_title.to_string(),
        Some(_) => format!("{book_title} · {name}"),
    }
}

/// 没有手动设过防剧透时的默认值：整本都是小说那一类的格式（EPUB / MOBI / FB2 / TXT）才开。
/// 合同、项目文档这种，读者要的是全部内容，藏起后文只会碍事。
pub(crate) fn spoiler_default<'a>(mut kinds: impl Iterator<Item = &'a str>) -> bool {
    let mut any = false;
    let all = kinds.all(|k| {
        any = true;
        matches!(k, "epub" | "mobi" | "fb2" | "txt")
    });
    any && all
}

/// 书架：每本书带着它的各篇。最近加的排前面
pub fn list_books(conn: &Connection) -> Result<Vec<Book>> {
    struct Raw {
        doc: Doc,
        cover_len: Option<i64>,
    }
    let mut by_book: HashMap<String, Vec<Raw>> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT d.id, d.book_id, d.title, d.path, d.kind, d.pages, d.created_at, d.author,
                    (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id),
                    (SELECT length(v.data) FROM covers v WHERE v.doc_id = d.id),
                    r.fraction, r.furthest, r.furthest_page, r.updated_at, r.doc_id IS NOT NULL
             FROM docs d LEFT JOIN reading_state r ON r.doc_id = d.id
             WHERE d.book_id IS NOT NULL
             ORDER BY d.book_id, d.position, d.created_at, d.rowid",
        )?;
        let rows = stmt.query_map([], |r| {
            let cover_len: Option<i64> = r.get(9)?;
            Ok(Raw {
                doc: Doc {
                    id: r.get(0)?,
                    book_id: r.get(1)?,
                    position: 0,
                    title: r.get(2)?,
                    name: String::new(),
                    display_title: String::new(),
                    path: r.get(3)?,
                    kind: r.get(4)?,
                    pages: r.get(5)?,
                    created_at: r.get(6)?,
                    author: r.get(7)?,
                    chunk_count: r.get(8)?,
                    has_cover: cover_len.is_some(),
                    progress: r.get(10)?,
                    furthest: r.get::<_, Option<f64>>(11)?.unwrap_or(0.0),
                    furthest_page: r.get(12)?,
                    read_at: r.get(13)?,
                    opened: r.get(14)?,
                    missing: false,
                },
                cover_len,
            })
        })?;
        for row in rows {
            let raw = row?;
            by_book
                .entry(raw.doc.book_id.clone())
                .or_default()
                .push(raw);
        }
    }

    let mut stmt = conn.prepare(
        "SELECT b.id, b.title, b.author, b.folder, b.scan, b.spoiler_free, b.created_at,
                (SELECT updated_at FROM book_custom_covers c WHERE c.book_id = b.id),
                (SELECT COUNT(*) FROM sessions s WHERE s.book_id = b.id),
                (SELECT COUNT(*) FROM annotations a JOIN docs d ON d.id = a.doc_id WHERE d.book_id = b.id)
         FROM books b ORDER BY b.created_at DESC, b.rowid DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            Book {
                id: r.get(0)?,
                title: r.get(1)?,
                author: r.get(2)?,
                folder: r.get(3)?,
                scan: Scan::parse(&r.get::<_, String>(4)?),
                created_at: r.get(6)?,
                has_cover: false,
                custom_cover: false,
                cover_rev: String::new(),
                progress: None,
                read_at: None,
                spoiler_free: false,
                spoiler_default: true,
                session_count: r.get(8)?,
                note_count: r.get(9)?,
                docs: vec![],
            },
            r.get::<_, Option<bool>>(5)?,
            r.get::<_, Option<i64>>(7)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (mut book, spoiler, custom_at) = row?;
        let raws = by_book.remove(&book.id).unwrap_or_default();
        let names = {
            let parts: Vec<(&str, Option<&str>)> = raws
                .iter()
                .map(|r| (r.doc.title.as_str(), r.doc.path.as_deref()))
                .collect();
            part_names(book.folder.as_deref(), &parts)
        };

        // 封面：用户上传的优先；没有就用排在最前面、自己有封面的那一篇的
        let auto = raws
            .iter()
            .find_map(|r| r.cover_len.map(|len| format!("d{}-{len}", r.doc.id)));
        book.custom_cover = custom_at.is_some();
        book.cover_rev = match custom_at {
            Some(t) => format!("c{t}"),
            None => auto.unwrap_or_default(),
        };
        book.has_cover = !book.cover_rev.is_empty();

        // 进度：各篇按篇幅加权（片段数和页数里取大的；漫画、扫描件没有片段，至少算 1）。
        // 没打开过的篇算 0；一篇都没打开过才是 null
        let (mut read, mut weight) = (0.0f64, 0.0f64);
        for r in &raws {
            let w = r.doc.chunk_count.max(r.doc.pages.unwrap_or(0)).max(1) as f64;
            weight += w;
            read += r.doc.progress.unwrap_or(0.0) * w;
        }
        if raws.iter().any(|r| r.doc.opened) && weight > 0.0 {
            book.progress = Some((read / weight).clamp(0.0, 1.0));
        }
        book.read_at = raws.iter().filter_map(|r| r.doc.read_at).max();

        book.spoiler_default = spoiler.is_none();
        book.spoiler_free =
            spoiler.unwrap_or_else(|| spoiler_default(raws.iter().map(|r| r.doc.kind.as_str())));

        for (i, (raw, name)) in raws.into_iter().zip(names).enumerate() {
            let mut doc = raw.doc;
            doc.position = i as i64;
            doc.display_title = display_title(&book.title, book.folder.as_deref(), &name);
            doc.name = name;
            doc.missing = !doc.path.as_deref().is_some_and(|p| Path::new(p).exists());
            book.docs.push(doc);
        }
        out.push(book);
    }
    Ok(out)
}

/// 一篇在界面上、检索结果里、给助手看的笔记里叫什么
#[derive(Debug, Clone)]
pub struct Label {
    pub book_id: String,
    pub book_title: String,
    /// 在书里排第几，从 0 开始
    pub position: i64,
    pub name: String,
    pub display_title: String,
}

/// 每一篇的名字（文档 id → 名字）。显示名字只在 Rust 这一处算，别处不要自己拼
pub fn labels(conn: &Connection) -> Result<HashMap<String, Label>> {
    struct Row {
        doc_id: String,
        title: String,
        path: Option<String>,
        book_id: String,
        book_title: String,
        folder: Option<String>,
    }
    let mut stmt = conn.prepare(
        "SELECT d.id, d.title, d.path, b.id, b.title, b.folder
         FROM docs d JOIN books b ON b.id = d.book_id
         ORDER BY b.id, d.position, d.created_at, d.rowid",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Row {
            doc_id: r.get(0)?,
            title: r.get(1)?,
            path: r.get(2)?,
            book_id: r.get(3)?,
            book_title: r.get(4)?,
            folder: r.get(5)?,
        })
    })?;
    let rows: Vec<Row> = rows.collect::<Result<Vec<_>, _>>()?;
    let mut out = HashMap::new();
    for group in rows.chunk_by(|a, b| a.book_id == b.book_id) {
        let book = &group[0];
        let parts: Vec<(&str, Option<&str>)> = group
            .iter()
            .map(|r| (r.title.as_str(), r.path.as_deref()))
            .collect();
        let names = part_names(book.folder.as_deref(), &parts);
        for (i, (row, name)) in group.iter().zip(names).enumerate() {
            out.insert(
                row.doc_id.clone(),
                Label {
                    book_id: row.book_id.clone(),
                    book_title: row.book_title.clone(),
                    position: i as i64,
                    display_title: display_title(&row.book_title, book.folder.as_deref(), &name),
                    name,
                },
            );
        }
    }
    Ok(out)
}

/// 一篇属于哪本书。这一篇不在了返回 None
pub fn book_of(conn: &Connection, doc_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT book_id FROM docs WHERE id = ?1",
            params![doc_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten())
}

/// 一本书的防剧透现在是否生效（用户设过就按设的，没设过按类型的默认值）
pub fn spoiler_free(conn: &Connection, book_id: &str) -> Result<bool> {
    let set: Option<bool> = conn
        .query_row(
            "SELECT spoiler_free FROM books WHERE id = ?1",
            params![book_id],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    if let Some(on) = set {
        return Ok(on);
    }
    let mut stmt = conn.prepare("SELECT kind FROM docs WHERE book_id = ?1")?;
    let kinds: Vec<String> = stmt
        .query_map(params![book_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(spoiler_default(kinds.iter().map(String::as_str)))
}

// ---------- 建书、找书 ----------

pub fn create_book(
    conn: &Connection,
    title: &str,
    author: Option<&str>,
    folder: Option<&str>,
    scan: Scan,
) -> Result<String> {
    create_book_at(conn, title, author, folder, scan, db::now())
}

/// 同上，建书时间由调用方给（升级老库、拆书时沿用原来的时间，书架上的位置不乱跳）
pub fn create_book_at(
    conn: &Connection,
    title: &str,
    author: Option<&str>,
    folder: Option<&str>,
    scan: Scan,
    created_at: i64,
) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO books(id, title, author, folder, scan, created_at) VALUES(?1,?2,?3,?4,?5,?6)",
        params![id, title, author, folder, scan.as_str(), created_at],
    )?;
    Ok(id)
}

/// 给一篇单独建一本书，把它放进去。书名取自它的标题，作者也跟着它。
/// created_at 不给就用这一篇导入的时间
pub fn give_own_book(conn: &Connection, doc_id: &str, created_at: Option<i64>) -> Result<String> {
    let (title, path, author, imported_at): (String, Option<String>, Option<String>, i64) = conn
        .query_row(
            "SELECT title, path, author, created_at FROM docs WHERE id = ?1",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    let book_id = create_book_at(
        conn,
        &stem_title(&title, path.as_deref()),
        author.as_deref(),
        None,
        Scan::None,
        created_at.unwrap_or(imported_at),
    )?;
    conn.execute(
        "UPDATE docs SET book_id = ?2, position = 0 WHERE id = ?1",
        params![doc_id, book_id],
    )?;
    Ok(book_id)
}

/// 一本书的基本情况
#[derive(Debug, Clone)]
pub struct BookRef {
    pub id: String,
    pub title: String,
    /// 单文件的书是 None
    pub folder: Option<String>,
    pub scan: Scan,
}

pub fn book_ref(conn: &Connection, book_id: &str) -> Result<Option<BookRef>> {
    Ok(conn
        .query_row(
            "SELECT id, title, folder, scan FROM books WHERE id = ?1",
            params![book_id],
            |r| {
                Ok(BookRef {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    folder: r.get(2)?,
                    scan: Scan::parse(&r.get::<_, String>(3)?),
                })
            },
        )
        .ok())
}

/// 所有的文件夹书
pub fn folder_books(conn: &Connection) -> Result<Vec<BookRef>> {
    let mut stmt =
        conn.prepare("SELECT id, title, folder, scan FROM books WHERE folder IS NOT NULL")?;
    let rows = stmt.query_map([], |r| {
        Ok(BookRef {
            id: r.get(0)?,
            title: r.get(1)?,
            folder: r.get(2)?,
            scan: Scan::parse(&r.get::<_, String>(3)?),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 正好以这个目录为文件夹的那本书。folder 要是 norm_folder 之后的写法
pub fn folder_book_at(conn: &Connection, folder: &str) -> Result<Option<BookRef>> {
    Ok(folder_books(conn)?
        .into_iter()
        .find(|b| b.folder.as_deref() == Some(folder)))
}

/// 这个文件在哪本文件夹书的目录下面。嵌套着几本的话取最里面的那本
pub fn folder_book_for(conn: &Connection, file: &Path) -> Result<Option<BookRef>> {
    Ok(deepest_owner(&folder_books(conn)?, file).cloned())
}

/// 同上，在已经取出来的清单里找
pub fn deepest_owner<'a>(books: &'a [BookRef], file: &Path) -> Option<&'a BookRef> {
    books
        .iter()
        .filter(|b| {
            b.folder
                .as_deref()
                .is_some_and(|f| file != Path::new(f) && file.starts_with(f))
        })
        .max_by_key(|b| {
            b.folder
                .as_deref()
                .map(|f| Path::new(f).components().count())
        })
}

/// 导入时要看的一篇的情况
#[derive(Debug, Clone)]
pub struct Part {
    pub id: String,
    pub book_id: String,
    pub path: Option<String>,
    pub kind: String,
    /// 上次解析时原文件的大小和修改时间；老库升上来的还没有
    pub stamp: Option<Stamp>,
    /// 这一篇的片段重写过几次。拿着旧片段干活的后台任务（透视）靠它发现内容已经换过了
    pub rev: i64,
}

impl Part {
    /// 原文件还在不在。按存着的路径去看，不靠「这次扫描有没有走到它」来判断
    pub fn file_exists(&self) -> bool {
        self.path.as_deref().is_some_and(|p| Path::new(p).exists())
    }
}

const PART_COLUMNS: &str = "id, COALESCE(book_id, ''), path, kind, file_size, file_mtime, rev";

fn part_row(r: &rusqlite::Row) -> rusqlite::Result<Part> {
    let size: Option<i64> = r.get(4)?;
    let mtime: Option<i64> = r.get(5)?;
    Ok(Part {
        id: r.get(0)?,
        book_id: r.get(1)?,
        path: r.get(2)?,
        kind: r.get(3)?,
        stamp: size.zip(mtime).map(|(size, mtime)| Stamp { size, mtime }),
        rev: r.get(6)?,
    })
}

/// 一本书的各篇，按书里的顺序
pub fn parts(conn: &Connection, book_id: &str) -> Result<Vec<Part>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PART_COLUMNS} FROM docs WHERE book_id = ?1 ORDER BY position, created_at, rowid"
    ))?;
    let rows = stmt.query_map(params![book_id], part_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn part(conn: &Connection, doc_id: &str) -> Result<Option<Part>> {
    Ok(conn
        .query_row(
            &format!("SELECT {PART_COLUMNS} FROM docs WHERE id = ?1"),
            params![doc_id],
            part_row,
        )
        .ok())
}

/// 这个路径的文件已经导入过的话，是哪一篇
pub fn part_by_path(conn: &Connection, path: &str) -> Result<Option<Part>> {
    Ok(conn
        .query_row(
            &format!("SELECT {PART_COLUMNS} FROM docs WHERE path = ?1"),
            params![path],
            part_row,
        )
        .ok())
}

/// 这一篇上有没有用户留下的东西（划线、笔记、书签、进度）。有的话原文件不见了也不能删
pub fn has_user_data(conn: &Connection, doc_id: &str) -> Result<bool> {
    Ok(conn
        .prepare(
            "SELECT 1 WHERE EXISTS(SELECT 1 FROM annotations WHERE doc_id = ?1)
                         OR EXISTS(SELECT 1 FROM reading_state WHERE doc_id = ?1)",
        )?
        .exists(params![doc_id])?)
}

/// 用户从这本书里移除过的文件
pub fn excluded(conn: &Connection, book_id: &str) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT path FROM book_excluded WHERE book_id = ?1")?;
    let rows = stmt.query_map(params![book_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<HashSet<_>, _>>()?)
}

/// 把各篇的 position 重新排成 0、1、2……（删掉一篇之后中间会空一格）
fn renumber(conn: &Connection, book_id: &str) -> Result<()> {
    let ids: Vec<String> = parts(conn, book_id)?.into_iter().map(|p| p.id).collect();
    set_order(conn, &ids)
}

fn set_order(conn: &Connection, ids: &[String]) -> Result<()> {
    let mut stmt = conn.prepare("UPDATE docs SET position = ?2 WHERE id = ?1")?;
    for (i, id) in ids.iter().enumerate() {
        stmt.execute(params![id, i as i64])?;
    }
    Ok(())
}

/// 一篇没了之后收拾它原来所在的书：书空了就删掉书，不然把顺序补齐。返回书还在不在
pub fn tidy_after_removal(conn: &Connection, book_id: &str) -> Result<bool> {
    let left: i64 = conn.query_row(
        "SELECT COUNT(*) FROM docs WHERE book_id = ?1",
        params![book_id],
        |r| r.get(0),
    )?;
    if left == 0 {
        conn.execute("DELETE FROM books WHERE id = ?1", params![book_id])?;
        return Ok(false);
    }
    renumber(conn, book_id)?;
    Ok(true)
}

// ---------- 改书 ----------

pub fn update_book(
    conn: &mut Connection,
    book_id: &str,
    title: &str,
    author: Option<&str>,
) -> Result<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(anyhow!("书名不能为空"));
    }
    let author = author.map(str::trim).filter(|a| !a.is_empty());
    let tx = conn.transaction()?;
    let n = tx.execute(
        "UPDATE books SET title = ?2, author = ?3 WHERE id = ?1",
        params![book_id, title, author],
    )?;
    if n == 0 {
        return Err(anyhow!("这本书已经不在书架上了"));
    }
    // 对话上记的书名跟着改：那个快照是给书被移除之后看的，书还在的时候不该和书名对不上
    tx.execute(
        "UPDATE sessions SET book_title = ?2 WHERE book_id = ?1",
        params![book_id, title],
    )?;
    tx.commit()?;
    Ok(())
}

/// on 传 None 是恢复按类型的默认值
pub fn set_spoiler(conn: &Connection, book_id: &str, on: Option<bool>) -> Result<()> {
    conn.execute(
        "UPDATE books SET spoiler_free = ?2 WHERE id = ?1",
        params![book_id, on],
    )?;
    Ok(())
}

/// 从书里移除一篇。它是最后一篇的话书也一起移除。
/// 书是按文件夹扫描的（flat / deep）时把这个文件记进排除名单——文件还在文件夹里，
/// 不记的话下次扫描又把它收回来了。
pub fn delete_document(conn: &mut Connection, doc_id: &str) -> Result<()> {
    let tx = conn.transaction()?;
    let Some(part) = part(&tx, doc_id)? else {
        return Ok(());
    };
    // 这本书正在做透视的话让它停下：少了一篇，接着做下去进度和内容都对不上了
    crate::xray::cancel(&part.book_id);
    db::delete_document_in(&tx, doc_id)?;
    if !part.book_id.is_empty() && tidy_after_removal(&tx, &part.book_id)? {
        let scans = book_ref(&tx, &part.book_id)?.is_some_and(|b| b.scan != Scan::None);
        if let Some(path) = part.path.filter(|_| scans) {
            tx.execute(
                "INSERT OR IGNORE INTO book_excluded(book_id, path) VALUES(?1, ?2)",
                params![part.book_id, path],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// 从书架上移除一本书：各篇连同上面的划线、笔记、进度、透视一起删，原文件不动。
/// with_sessions 为真时这本书下的对话也删；否则对话留着，只是不再挂在书下
/// （外键把 book_id 置空，book_title 那份书名快照还在）。
pub fn delete_book(conn: &mut Connection, book_id: &str, with_sessions: bool) -> Result<()> {
    // 正在给这本书做的透视停下来：书要没了，接着做只是白花模型的钱
    crate::xray::cancel(book_id);
    let tx = conn.transaction()?;
    for p in parts(&tx, book_id)? {
        db::delete_document_in(&tx, &p.id)?;
    }
    if with_sessions {
        tx.execute("DELETE FROM sessions WHERE book_id = ?1", params![book_id])?;
    }
    tx.execute("DELETE FROM books WHERE id = ?1", params![book_id])?;
    tx.commit()?;
    Ok(())
}

/// 把一篇在书里往前（负数）或往后挪。自然顺序排错了的时候，这是用户手动纠正的办法
pub fn move_part(conn: &mut Connection, doc_id: &str, delta: i64) -> Result<()> {
    let tx = conn.transaction()?;
    let book_id = book_of(&tx, doc_id)?.ok_or_else(|| anyhow!("这一篇已经不在书里了"))?;
    let mut ids: Vec<String> = parts(&tx, &book_id)?.into_iter().map(|p| p.id).collect();
    if let Some(from) = ids.iter().position(|id| id == doc_id) {
        let to = (from as i64 + delta).clamp(0, ids.len() as i64 - 1) as usize;
        let id = ids.remove(from);
        ids.insert(to, id);
        set_order(&tx, &ids)?;
    }
    tx.commit()?;
    Ok(())
}

/// 把一篇从它自己那本单文件的书挪进另一本书（排在最后），原来那本书随之消失：
/// 挂在它下面的对话改挂到新书，用户给它传过的封面在新书没有封面时带过去。
/// 文档 id 不变，所以划线、笔记、进度、透视都原样跟着。
pub fn absorb(tx: &Transaction, doc_id: &str, into: &str) -> Result<()> {
    let from = book_of(tx, doc_id)?.ok_or_else(|| anyhow!("这一篇已经不在书里了"))?;
    if from == into {
        return Ok(());
    }
    let into_title: String = tx.query_row(
        "SELECT title FROM books WHERE id = ?1",
        params![into],
        |r| r.get(0),
    )?;
    tx.execute(
        "UPDATE docs SET book_id = ?2,
                position = (SELECT COALESCE(MAX(position), -1) + 1 FROM docs WHERE book_id = ?2)
         WHERE id = ?1",
        params![doc_id, into],
    )?;
    let emptied = !tx
        .prepare("SELECT 1 FROM docs WHERE book_id = ?1")?
        .exists(params![from])?;
    if emptied {
        tx.execute(
            "UPDATE sessions SET book_id = ?2, book_title = ?3 WHERE book_id = ?1",
            params![from, into, into_title],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO book_custom_covers(book_id, data, updated_at)
             SELECT ?2, data, updated_at FROM book_custom_covers WHERE book_id = ?1",
            params![from, into],
        )?;
        tx.execute("DELETE FROM books WHERE id = ?1", params![from])?;
    }
    Ok(())
}

/// 把一本文件夹书拆开：每一篇自己成一本单文件的书。文档 id 不变，笔记、进度、透视都不动。
/// 书下的对话跟着它引用过的那一篇走（引用了不止一篇、或者没引用的，变成不挂在任何书下）；
/// 用户传的封面归第一篇那本。
pub fn split_book(conn: &mut Connection, book_id: &str) -> Result<()> {
    let tx = conn.transaction()?;
    let book = book_ref(&tx, book_id)?.ok_or_else(|| anyhow!("这本书已经不在书架上了"))?;
    if book.folder.is_none() {
        return Ok(()); // 单文件的书没什么可拆
    }
    let (spoiler, created_at): (Option<bool>, i64) = tx.query_row(
        "SELECT spoiler_free, created_at FROM books WHERE id = ?1",
        params![book_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let ids: Vec<String> = parts(&tx, book_id)?.into_iter().map(|p| p.id).collect();
    let sessions: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM sessions WHERE book_id = ?1")?;
        let rows = stmt.query_map(params![book_id], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    // 拆出来的几本都沿用原书的时间，留在书架上原来的位置。
    // 倒着建：同一时间的书后建的排前面，这样它们之间还是书里的先后
    let mut first = None;
    for id in ids.iter().rev() {
        let own = give_own_book(&tx, id, Some(created_at))?;
        // 用户给整本书设过的防剧透，拆出来的每一本都照旧
        set_spoiler(&tx, &own, spoiler)?;
        first = Some(own);
    }
    if let Some(first) = &first {
        tx.execute(
            "UPDATE book_custom_covers SET book_id = ?2 WHERE book_id = ?1",
            params![book_id, first],
        )?;
    }
    for s in sessions {
        match session_book(&tx, &s)? {
            Some((b, title)) => tx.execute(
                "UPDATE sessions SET book_id = ?2, book_title = ?3 WHERE id = ?1",
                params![s, b, title],
            )?,
            // 书名快照留着：还看得出这段对话原来是聊哪本的
            None => tx.execute(
                "UPDATE sessions SET book_id = NULL WHERE id = ?1",
                params![s],
            )?,
        };
    }
    tx.execute("DELETE FROM books WHERE id = ?1", params![book_id])?;
    tx.commit()?;
    Ok(())
}

/// 让一篇指向新的文件位置。标题本来是文件名的话跟着新文件名改（篇名随之更新）
pub fn repoint(
    conn: &Connection,
    doc_id: &str,
    new_path: &Path,
    stamp: Option<Stamp>,
) -> Result<()> {
    let (title, old_path): (String, Option<String>) = conn.query_row(
        "SELECT title, path FROM docs WHERE id = ?1",
        params![doc_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let titled_by_file = old_path
        .as_deref()
        .and_then(|p| Path::new(p).file_name())
        .is_some_and(|n| n.to_string_lossy() == title);
    let title = match new_path.file_name() {
        Some(name) if titled_by_file => name.to_string_lossy().to_string(),
        _ => title,
    };
    conn.execute(
        "UPDATE docs SET path = ?2, title = ?3, file_size = ?4, file_mtime = ?5 WHERE id = ?1",
        params![
            doc_id,
            new_path.to_string_lossy(),
            title,
            stamp.map(|s| s.size),
            stamp.map(|s| s.mtime)
        ],
    )?;
    Ok(())
}

/// 文件或文件夹挪了地方，用户重新指了一个位置。
/// 文件夹书：换掉 books.folder，各篇的路径在新位置找得到文件的跟着换前缀（找不到的保持原样，
/// 继续显示为「原文件找不到了」）。单文件的书：那一篇直接指向选的文件。
/// 只改路径，不重新解析；调用方随后刷新一遍内容（见 import::refresh_parts）。
pub fn relocate(conn: &mut Connection, book_id: &str, target: &Path) -> Result<()> {
    let tx = conn.transaction()?;
    let book = book_ref(&tx, book_id)?.ok_or_else(|| anyhow!("这本书已经不在书架上了"))?;
    match &book.folder {
        Some(old) => {
            if !target.is_dir() {
                return Err(anyhow!("选的不是文件夹"));
            }
            let new = norm_folder(target);
            if let Some(other) = folder_book_at(&tx, &new)?.filter(|b| b.id != book_id) {
                return Err(anyhow!("这个文件夹已经是《{}》了", other.title));
            }
            for p in parts(&tx, book_id)? {
                let Some(rel) = rel_path(Some(old), p.path.as_deref()) else {
                    continue;
                };
                let moved = Path::new(&new).join(rel);
                let taken =
                    part_by_path(&tx, &moved.to_string_lossy())?.is_some_and(|o| o.id != p.id);
                if moved.exists() && !taken {
                    tx.execute(
                        "UPDATE docs SET path = ?2 WHERE id = ?1",
                        params![p.id, moved.to_string_lossy()],
                    )?;
                }
            }
            // 排除名单里记的也是路径，跟着换
            for path in excluded(&tx, book_id)? {
                if let Some(rel) = rel_path(Some(old), Some(&path)) {
                    tx.execute(
                        "UPDATE OR REPLACE book_excluded SET path = ?3 WHERE book_id = ?1 AND path = ?2",
                        params![book_id, path, Path::new(&new).join(rel).to_string_lossy()],
                    )?;
                }
            }
            tx.execute(
                "UPDATE books SET folder = ?2 WHERE id = ?1",
                params![book_id, new],
            )?;
        }
        None => {
            if !target.is_file() {
                return Err(anyhow!("选的不是文件"));
            }
            if crate::parse::kind_of(target).is_none() {
                return Err(anyhow!("不支持的文件类型"));
            }
            let Some(p) = parts(&tx, book_id)?.into_iter().next() else {
                return Err(anyhow!("这本书里没有内容"));
            };
            let taken = part_by_path(&tx, &target.to_string_lossy())?.is_some_and(|o| o.id != p.id);
            if taken {
                return Err(anyhow!("这个文件已经在书架上了"));
            }
            // 不记大小和时间：选的文件内容可能和原来不一样，下一次刷新一定重新解析一遍来比
            repoint(&tx, &p.id, target, None)?;
        }
    }
    tx.commit()?;
    Ok(())
}

// ---------- 封面 ----------

/// 书的封面：用户上传的优先；没有就用排在最前面、自己有封面的那一篇的
/// （电子书导入时取出来的，或者阅读器送来的第一页）
pub fn cover(conn: &Connection, book_id: &str) -> Result<Option<Vec<u8>>> {
    let custom: Option<Vec<u8>> = conn
        .query_row(
            "SELECT data FROM book_custom_covers WHERE book_id = ?1",
            params![book_id],
            |r| r.get(0),
        )
        .ok();
    if custom.is_some() {
        return Ok(custom);
    }
    Ok(conn
        .query_row(
            "SELECT v.data FROM covers v JOIN docs d ON d.id = v.doc_id
             WHERE d.book_id = ?1 ORDER BY d.position, d.created_at, d.rowid LIMIT 1",
            params![book_id],
            |r| r.get(0),
        )
        .ok())
}

/// 存用户上传的封面。updated_at 保证每次都往前走（同一秒里连换两张也是），界面靠它刷新图片
pub fn set_custom_cover(conn: &Connection, book_id: &str, data: &[u8]) -> Result<()> {
    conn.execute(
        "INSERT INTO book_custom_covers(book_id, data, updated_at) VALUES(?1, ?2, ?3)
         ON CONFLICT(book_id) DO UPDATE SET
            data = excluded.data,
            updated_at = MAX(excluded.updated_at, book_custom_covers.updated_at + 1)",
        params![book_id, data, db::now()],
    )?;
    Ok(())
}

/// 恢复默认封面：把用户上传的那张删掉就行
pub fn clear_custom_cover(conn: &Connection, book_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM book_custom_covers WHERE book_id = ?1",
        params![book_id],
    )?;
    Ok(())
}

// ---------- 对话和书 ----------

/// 一段对话引用过哪些文档：消息的 meta（JSON）里，用户选中的那段话（quote.docId）
/// 和检索命中的片段（hits[].docId）
fn cited_docs(conn: &Connection, session_id: &str) -> Result<HashSet<String>> {
    let mut stmt =
        conn.prepare("SELECT meta FROM messages WHERE session_id = ?1 AND meta IS NOT NULL")?;
    let metas: Vec<String> = stmt
        .query_map(params![session_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut out = HashSet::new();
    for raw in metas {
        // 旧数据或损坏的 meta，当作没有
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if let Some(id) = v["quote"]["docId"].as_str() {
            out.insert(id.to_string());
        }
        for hit in v["hits"].as_array().into_iter().flatten() {
            if let Some(id) = hit["docId"].as_str() {
                out.insert(id.to_string());
            }
        }
    }
    Ok(out)
}

/// 一段对话聊的是哪本书：它引用过的、现在还在的文档全都属于同一本才算数，
/// 返回 (书的 id, 书名)。一个都没引用、或者跨了几本书的，不猜。
/// 升级老库和拆书时用同一条规则。
pub fn session_book(conn: &Connection, session_id: &str) -> Result<Option<(String, String)>> {
    let mut found: Option<String> = None;
    for doc_id in cited_docs(conn, session_id)? {
        let Some(book) = book_of(conn, &doc_id)? else {
            continue; // 文档已经不在了
        };
        match &found {
            None => found = Some(book),
            Some(b) if *b == book => {}
            Some(_) => return Ok(None),
        }
    }
    let Some(book_id) = found else {
        return Ok(None);
    };
    Ok(book_ref(conn, &book_id)?.map(|b| (b.id, b.title)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{NewDoc, TextChunk};

    fn chunk(text: &str) -> TextChunk {
        TextChunk {
            idx: 0,
            page: None,
            text: text.to_string(),
        }
    }

    fn add(conn: &mut Connection, title: &str, path: &str, kind: &str, text: &str) -> String {
        let doc = NewDoc {
            title,
            path,
            kind,
            pages: None,
            author: None,
            cover: None,
        };
        db::import_document(conn, &doc, &[chunk(text)]).unwrap()
    }

    /// 一本三篇的文件夹书（scan 由调用方定），返回 (书 id, 三篇的 id)
    fn folder_book(conn: &mut Connection, scan: Scan) -> (String, Vec<String>) {
        let book = create_book(conn, "手册", None, Some("/lib/手册"), scan).unwrap();
        let ids = ["第一章.md", "第二章.md", "第三章.md"]
            .iter()
            .map(|name| {
                let text = format!("{name} 讲蒸汽机的原理");
                add(conn, name, &format!("/lib/手册/{name}"), "md", &text)
            })
            .collect();
        (book, ids)
    }

    fn note(conn: &Connection, id: &str, doc_id: &str) {
        db::save_annotation(
            conn,
            &db::Annotation {
                id: id.into(),
                doc_id: doc_id.into(),
                kind: "highlight".into(),
                cfi: "epubcfi(/6/2)".into(),
                text: "划的一句".into(),
                note: String::new(),
                color: "yellow".into(),
                style: "highlight".into(),
                label: String::new(),
                page: None,
                created_at: 0,
                updated_at: 0,
                doc_title: String::new(),
            },
        )
        .unwrap();
    }

    fn cite(conn: &Connection, session: &str, doc_id: &str) {
        let meta = serde_json::json!({ "hits": [{ "docId": doc_id }] }).to_string();
        db::add_message(conn, session, "assistant", "……", Some(&meta)).unwrap();
    }

    fn session_link(conn: &Connection, id: &str) -> (Option<String>, Option<String>) {
        let s = db::list_sessions(conn).unwrap();
        let s = s.iter().find(|s| s.id == id).unwrap();
        (s.book_id.clone(), s.book_title.clone())
    }

    #[test]
    fn 书名只在标题就是文件名时去扩展名() {
        assert_eq!(stem_title("README.md", Some("/p/README.md")), "README");
        assert_eq!(
            stem_title("Node.js 设计模式", Some("/p/nodejs.epub")),
            "Node.js 设计模式"
        );
        assert_eq!(stem_title("v1.2 说明", None), "v1.2 说明");
        assert_eq!(
            stem_title("归档.tar.gz", Some("/p/归档.tar.gz")),
            "归档.tar"
        );
        assert_eq!(norm_folder(Path::new("/a/b/")), "/a/b");
        assert_eq!(norm_folder(Path::new("/a//b/./c")), "/a/b/c");
    }

    #[test]
    fn 单个文件自己成书_落在文件夹书里的文件加进那本书() {
        let mut conn = db::open_in_memory().unwrap();
        let (book, _) = folder_book(&mut conn, Scan::None);
        // 文件夹书下面更深一层的文件也归它；嵌套着两本时归最里面的那本
        let inner = create_book(&conn, "附录", None, Some("/lib/手册/附录"), Scan::None).unwrap();
        let a = add(&mut conn, "补遗.md", "/lib/手册/杂/补遗.md", "md", "补遗");
        let b = add(&mut conn, "表.md", "/lib/手册/附录/表.md", "md", "表");
        let c = add(&mut conn, "别处.md", "/lib/别处.md", "md", "别处");
        assert_eq!(book_of(&conn, &a).unwrap().as_deref(), Some(book.as_str()));
        assert_eq!(book_of(&conn, &b).unwrap().as_deref(), Some(inner.as_str()));

        let shelf = list_books(&conn).unwrap();
        assert_eq!(shelf.len(), 3);
        let manual = shelf.iter().find(|x| x.id == book).unwrap();
        assert_eq!(manual.docs.len(), 4);
        assert_eq!(manual.docs[3].id, a);
        assert_eq!(manual.docs[3].display_title, "手册 · 补遗");
        let own = shelf.iter().find(|x| x.docs[0].id == c).unwrap();
        assert!(own.folder.is_none());
        assert_eq!(
            (own.title.as_str(), own.docs[0].name.as_str()),
            ("别处", "别处")
        );
        assert_eq!(own.docs[0].display_title, "别处");
    }

    #[test]
    fn 同一本书里重名的篇带上相对路径() {
        let mut conn = db::open_in_memory().unwrap();
        let book = create_book(&conn, "项目", None, Some("/p"), Scan::Deep).unwrap();
        add(&mut conn, "README.md", "/p/README.md", "md", "根");
        add(&mut conn, "README.md", "/p/api/README.md", "md", "接口");
        add(&mut conn, "指南.md", "/p/指南.md", "md", "指南");
        let shelf = list_books(&conn).unwrap();
        let names: Vec<&str> = shelf[0].docs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["README", "api/README", "指南"]);
        let l = labels(&conn).unwrap();
        let api = &l[&shelf[0].docs[1].id];
        assert_eq!(api.display_title, "项目 · api/README");
        // 同一个目录里同名不同格式的两份：去掉扩展名还是分不开，就连扩展名一起带上
        let names = part_names(
            Some("/p"),
            &[
                ("采购合同.md", Some("/p/采购合同.md")),
                ("采购合同.pdf", Some("/p/采购合同.pdf")),
                ("槐花开", Some("/p/示例小说.epub")),
            ],
        );
        assert_eq!(names, vec!["采购合同.md", "采购合同.pdf", "槐花开"]);
        assert_eq!((api.book_id.as_str(), api.position), (book.as_str(), 1));
    }

    #[test]
    fn 多篇的书进度按篇幅加权_没打开过的篇算零() {
        let mut conn = db::open_in_memory().unwrap();
        let book = create_book(&conn, "合集", None, Some("/c"), Scan::None).unwrap();
        let long = NewDoc {
            title: "长.md",
            path: "/c/长.md",
            kind: "md",
            pages: None,
            author: None,
            cover: None,
        };
        let three: Vec<TextChunk> = (0..3)
            .map(|i| TextChunk {
                idx: i,
                page: None,
                text: format!("第 {i} 块"),
            })
            .collect();
        let a = db::import_document(&mut conn, &long, &three).unwrap();
        let b = add(&mut conn, "短.md", "/c/短.md", "md", "短");
        let shelf = list_books(&conn).unwrap();
        assert_eq!(shelf[0].progress, None);
        assert_eq!(shelf[0].read_at, None);

        // 长的那篇（3 块）读到一半，短的（1 块）没打开：0.5 × 3 / 4
        db::save_reading_state(&conn, &a, "loc", 0.5, None).unwrap();
        let shelf = list_books(&conn).unwrap();
        assert_eq!(shelf[0].progress, Some(0.375));
        assert!(shelf[0].read_at.is_some());
        assert!(shelf[0].docs[0].opened && !shelf[0].docs[1].opened);
        assert_eq!(shelf[0].docs[1].progress, None);

        db::save_reading_state(&conn, &b, "loc", 1.0, None).unwrap();
        assert_eq!(list_books(&conn).unwrap()[0].progress, Some(0.625));
        assert_eq!(shelf[0].id, book);
    }

    #[test]
    fn 全是没有文字的篇_进度照样能算() {
        let mut conn = db::open_in_memory().unwrap();
        create_book(&conn, "漫画", None, Some("/m"), Scan::None).unwrap();
        let mut ids = vec![];
        for (name, pages) in [
            ("上.cbz", Some(30)),
            ("下.cbz", Some(10)),
            ("扫描.pdf", None),
        ] {
            let doc = NewDoc {
                title: name,
                path: &format!("/m/{name}"),
                kind: if name.ends_with("pdf") { "pdf" } else { "cbz" },
                pages,
                author: None,
                cover: None,
            };
            ids.push(db::import_document(&mut conn, &doc, &[]).unwrap());
        }
        assert_eq!(list_books(&conn).unwrap()[0].progress, None);
        // 30 页的读完、10 页的读了一半、没有页数的那篇权重按 1 算：(30 + 5 + 0) / 41
        db::save_reading_state(&conn, &ids[0], "", 1.0, Some(30)).unwrap();
        db::save_reading_state(&conn, &ids[1], "", 0.5, Some(5)).unwrap();
        let p = list_books(&conn).unwrap()[0].progress.unwrap();
        assert!((p - 35.0 / 41.0).abs() < 1e-9, "{p}");
        // 只有一篇、没有片段也没有页数：就是那一篇的进度
        let mut conn = db::open_in_memory().unwrap();
        let doc = NewDoc {
            title: "扫描.pdf",
            path: "/s/扫描.pdf",
            kind: "pdf",
            pages: None,
            author: None,
            cover: None,
        };
        let id = db::import_document(&mut conn, &doc, &[]).unwrap();
        db::save_reading_state(&conn, &id, "", 0.3, None).unwrap();
        assert_eq!(list_books(&conn).unwrap()[0].progress, Some(0.3));
    }

    #[test]
    fn 读到过的最远处只增不减() {
        let mut conn = db::open_in_memory().unwrap();
        let id = add(&mut conn, "书", "/b.epub", "epub", "正文");
        db::save_reading_state(&conn, &id, "a", 0.6, Some(7)).unwrap();
        // 翻回前面：现在的位置变了，最远处不变；没报页码也不把记过的页码冲掉
        db::save_reading_state(&conn, &id, "b", 0.2, Some(3)).unwrap();
        db::save_reading_state(&conn, &id, "c", 0.25, None).unwrap();
        let s = db::reading_state(&conn, &id).unwrap().unwrap();
        assert_eq!(
            (s.fraction, s.furthest, s.furthest_page),
            (0.25, 0.6, Some(7))
        );
        db::save_reading_state(&conn, &id, "d", 0.9, Some(11)).unwrap();
        let doc = &list_books(&conn).unwrap()[0].docs[0];
        assert_eq!(
            (doc.progress, doc.furthest, doc.furthest_page),
            (Some(0.9), 0.9, Some(11))
        );
    }

    #[test]
    fn 升级前的进度没有页码_往回翻时不把那一页当成读到的最远一页() {
        let mut conn = db::open_in_memory().unwrap();
        let id = add(&mut conn, "书", "/b.epub", "epub", "正文");
        // 升级时迁过来的记录：只知道读到 60%，页码是空的
        conn.execute(
            "INSERT INTO reading_state(doc_id, location, fraction, updated_at, furthest, furthest_page)
             VALUES(?1, 'x', 0.6, 0, 0.6, NULL)",
            rusqlite::params![id],
        )
        .unwrap();
        let page = |conn: &Connection| db::reading_state(conn, &id).unwrap().unwrap().furthest_page;
        // 升级后第一次打开是点引用跳到了前面的第 4 页：不能说「只读到第 4 页」
        db::save_reading_state(&conn, &id, "a", 0.3, Some(4)).unwrap();
        assert_eq!(page(&conn), None);
        // 翻过了原来读到的地方：从这儿开始记页码
        db::save_reading_state(&conn, &id, "b", 0.7, Some(9)).unwrap();
        assert_eq!(page(&conn), Some(9));
        // 之后再往回翻，记下的页码不退
        db::save_reading_state(&conn, &id, "c", 0.2, Some(3)).unwrap();
        assert_eq!(page(&conn), Some(9));
    }

    #[test]
    fn 防剧透默认按格式定_可以手动改也可以恢复默认() {
        let mut conn = db::open_in_memory().unwrap();
        let novel = add(&mut conn, "小说", "/n.epub", "epub", "正文");
        add(&mut conn, "合同.pdf", "/c.pdf", "pdf", "条款");
        let (mixed, _) = folder_book(&mut conn, Scan::None);
        let by_id = |conn: &Connection, id: &str| {
            let b = list_books(conn).unwrap();
            let b = b.into_iter().find(|b| b.id == id).unwrap();
            (b.spoiler_free, b.spoiler_default)
        };
        let novel_book = book_of(&conn, &novel).unwrap().unwrap();
        assert_eq!(by_id(&conn, &novel_book), (true, true));
        assert_eq!(by_id(&conn, &mixed), (false, true));
        assert!(spoiler_free(&conn, &novel_book).unwrap());
        assert!(!spoiler_free(&conn, &mixed).unwrap());

        set_spoiler(&conn, &novel_book, Some(false)).unwrap();
        set_spoiler(&conn, &mixed, Some(true)).unwrap();
        assert_eq!(by_id(&conn, &novel_book), (false, false));
        assert_eq!(by_id(&conn, &mixed), (true, false));
        assert!(spoiler_free(&conn, &mixed).unwrap());
        set_spoiler(&conn, &novel_book, None).unwrap();
        assert_eq!(by_id(&conn, &novel_book), (true, true));
    }

    #[test]
    fn 封面_上传的优先_恢复默认回到第一篇有封面的那张() {
        let mut conn = db::open_in_memory().unwrap();
        let (book, ids) = folder_book(&mut conn, Scan::None);
        let rev = |conn: &Connection| {
            let b = &list_books(conn).unwrap()[0];
            (b.has_cover, b.custom_cover, b.cover_rev.clone())
        };
        assert_eq!(rev(&conn), (false, false, String::new()));
        assert_eq!(cover(&conn, &book).unwrap(), None);

        // 第二、三篇有自动封面：用排在前面的那张
        db::set_cover(&conn, &ids[2], &[3, 3]).unwrap();
        db::set_cover(&conn, &ids[1], &[2]).unwrap();
        assert_eq!(cover(&conn, &book).unwrap(), Some(vec![2]));
        let auto = rev(&conn);
        assert_eq!((auto.0, auto.1), (true, false));
        assert!(auto.2.starts_with(&format!("d{}", ids[1])));
        // 同一篇的自动封面换了一张，标记也跟着变
        db::set_cover(&conn, &ids[1], &[2, 2, 2]).unwrap();
        assert_ne!(rev(&conn).2, auto.2);

        set_custom_cover(&conn, &book, &[9]).unwrap();
        let first = rev(&conn);
        assert_eq!((first.0, first.1), (true, true));
        assert!(first.2.starts_with('c'));
        assert_eq!(cover(&conn, &book).unwrap(), Some(vec![9]));
        // 紧接着再换一张（同一秒）：标记必须变，不然界面不会重新取图
        set_custom_cover(&conn, &book, &[8]).unwrap();
        assert_ne!(rev(&conn).2, first.2);
        assert_eq!(cover(&conn, &book).unwrap(), Some(vec![8]));

        clear_custom_cover(&conn, &book).unwrap();
        assert_eq!(cover(&conn, &book).unwrap(), Some(vec![2, 2, 2]));
        assert!(!rev(&conn).1);
    }

    #[test]
    fn 改书名_对话上记的书名跟着改_空书名不行() {
        let mut conn = db::open_in_memory().unwrap();
        let (book, _) = folder_book(&mut conn, Scan::None);
        db::upsert_session(&conn, "s1", "聊手册", None, Some(&book)).unwrap();
        update_book(&mut conn, &book, "  用户手册 ", Some(" 张三 ")).unwrap();
        let b = &list_books(&conn).unwrap()[0];
        assert_eq!(
            (b.title.as_str(), b.author.as_deref()),
            ("用户手册", Some("张三"))
        );
        assert_eq!(b.docs[0].display_title, "用户手册 · 第一章");
        assert_eq!(session_link(&conn, "s1").1.as_deref(), Some("用户手册"));
        assert!(update_book(&mut conn, &book, "   ", None).is_err());
        update_book(&mut conn, &book, "用户手册", Some("")).unwrap();
        assert_eq!(list_books(&conn).unwrap()[0].author, None);
        assert!(update_book(&mut conn, "没有这本", "x", None).is_err());
    }

    #[test]
    fn 移除一本书_对话可以一起删也可以留下() {
        let mut conn = db::open_in_memory().unwrap();
        let (book, ids) = folder_book(&mut conn, Scan::None);
        note(&conn, "a1", &ids[0]);
        db::save_reading_state(&conn, &ids[1], "loc", 0.5, None).unwrap();
        set_custom_cover(&conn, &book, &[1]).unwrap();
        db::upsert_session(&conn, "s1", "聊手册", None, Some(&book)).unwrap();
        db::add_message(&conn, "s1", "user", "你好", None).unwrap();
        let other = add(&mut conn, "别的.md", "/x/别的.md", "md", "别的内容");
        assert_eq!(
            crate::fts::search(&conn, "蒸汽机", 5, &crate::spoiler::Access::all())
                .unwrap()
                .len(),
            3
        );

        // 留下对话：书没了，对话还在，不再挂在书下，但还看得出原来聊的是哪本
        delete_book(&mut conn, &book, false).unwrap();
        let shelf = list_books(&conn).unwrap();
        assert_eq!(shelf.len(), 1);
        assert_eq!(shelf[0].docs[0].id, other);
        assert!(db::list_annotations(&conn, None, None).unwrap().is_empty());
        assert!(db::reading_state(&conn, &ids[1]).unwrap().is_none());
        assert!(
            crate::fts::search(&conn, "蒸汽机", 5, &crate::spoiler::Access::all())
                .unwrap()
                .is_empty()
        );
        assert_eq!(session_link(&conn, "s1"), (None, Some("手册".to_string())));
        assert_eq!(db::get_messages(&conn, "s1").unwrap().len(), 1);
        let covers: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_custom_covers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(covers, 0);

        // 连对话一起删：只删这本书下的，别的对话不动
        let other_book = book_of(&conn, &other).unwrap().unwrap();
        db::upsert_session(&conn, "s2", "聊别的", None, Some(&other_book)).unwrap();
        db::add_message(&conn, "s2", "user", "在吗", None).unwrap();
        delete_book(&mut conn, &other_book, true).unwrap();
        assert!(list_books(&conn).unwrap().is_empty());
        let left: Vec<String> = db::list_sessions(&conn)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(left, vec!["s1"]);
        assert!(db::get_messages(&conn, "s2").unwrap().is_empty());
    }

    #[test]
    fn 移除一篇_最后一篇没了书也没了_扫描的书会记住不再收它() {
        let mut conn = db::open_in_memory().unwrap();
        let (book, ids) = folder_book(&mut conn, Scan::Deep);
        delete_document(&mut conn, &ids[1]).unwrap();
        let shelf = list_books(&conn).unwrap();
        assert_eq!(shelf[0].docs.len(), 2);
        assert_eq!(
            shelf[0].docs.iter().map(|d| d.position).collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert!(excluded(&conn, &book)
            .unwrap()
            .contains("/lib/手册/第二章.md"));
        // 已经不在的文档再删一次不报错
        delete_document(&mut conn, &ids[1]).unwrap();

        delete_document(&mut conn, &ids[0]).unwrap();
        delete_document(&mut conn, &ids[2]).unwrap();
        assert!(list_books(&conn).unwrap().is_empty());

        // 只收手动加的文件的书（scan = none）没有「再扫描」，用不着记
        let (book, ids) = folder_book(&mut conn, Scan::None);
        delete_document(&mut conn, &ids[0]).unwrap();
        assert!(excluded(&conn, &book).unwrap().is_empty());
    }

    #[test]
    fn 手动调整篇的顺序() {
        let mut conn = db::open_in_memory().unwrap();
        let (_, ids) = folder_book(&mut conn, Scan::None);
        let order = |conn: &Connection| -> Vec<String> {
            list_books(conn).unwrap()[0]
                .docs
                .iter()
                .map(|d| d.name.clone())
                .collect()
        };
        move_part(&mut conn, &ids[2], -1).unwrap();
        assert_eq!(order(&conn), vec!["第一章", "第三章", "第二章"]);
        move_part(&mut conn, &ids[0], 1).unwrap();
        assert_eq!(order(&conn), vec!["第三章", "第一章", "第二章"]);
        // 已经在头上了再往前挪：不动
        move_part(&mut conn, &ids[2], -1).unwrap();
        assert_eq!(order(&conn), vec!["第三章", "第一章", "第二章"]);
        move_part(&mut conn, &ids[1], 1).unwrap();
        assert_eq!(order(&conn), vec!["第三章", "第一章", "第二章"]);
        assert!(move_part(&mut conn, "没有这一篇", 1).is_err());
    }

    #[test]
    fn 拆书_每篇自己成书_笔记进度不动_对话跟着引用的那篇走() {
        let mut conn = db::open_in_memory().unwrap();
        let (book, ids) = folder_book(&mut conn, Scan::Deep);
        note(&conn, "a1", &ids[1]);
        db::save_reading_state(&conn, &ids[2], "loc", 0.7, None).unwrap();
        set_custom_cover(&conn, &book, &[5]).unwrap();
        set_spoiler(&conn, &book, Some(true)).unwrap();
        // 一段只引用第二章，一段两章都引用了，一段什么都没引用
        for s in ["s-one", "s-two", "s-none"] {
            db::upsert_session(&conn, s, s, None, Some(&book)).unwrap();
        }
        cite(&conn, "s-one", &ids[1]);
        cite(&conn, "s-two", &ids[0]);
        cite(&conn, "s-two", &ids[2]);

        split_book(&mut conn, &book).unwrap();
        let shelf = list_books(&conn).unwrap();
        assert_eq!(shelf.len(), 3);
        assert!(shelf
            .iter()
            .all(|b| b.folder.is_none() && b.docs.len() == 1));
        // 书架上还是原来的先后
        let titles: Vec<&str> = shelf.iter().map(|b| b.title.as_str()).collect();
        assert_eq!(titles, vec!["第一章", "第二章", "第三章"]);
        assert_eq!(
            shelf
                .iter()
                .map(|b| b.docs[0].id.clone())
                .collect::<Vec<_>>(),
            ids
        );
        assert_eq!(shelf[1].note_count, 1);
        assert_eq!(shelf[2].progress, Some(0.7));
        assert!(shelf.iter().all(|b| b.spoiler_free && !b.spoiler_default));
        // 上传的封面归第一篇那本
        assert_eq!(
            shelf.iter().map(|b| b.custom_cover).collect::<Vec<_>>(),
            vec![true, false, false]
        );

        assert_eq!(
            session_link(&conn, "s-one"),
            (Some(shelf[1].id.clone()), Some("第二章".to_string()))
        );
        assert_eq!(
            session_link(&conn, "s-two"),
            (None, Some("手册".to_string()))
        );
        assert_eq!(
            session_link(&conn, "s-none"),
            (None, Some("手册".to_string()))
        );
        assert_eq!(shelf[1].session_count, 1);
        assert!(folder_books(&conn).unwrap().is_empty());
        // 拆过的书再拆一次（现在是单文件的书）什么都不发生
        split_book(&mut conn, &shelf[0].id).unwrap();
        assert_eq!(list_books(&conn).unwrap().len(), 3);
    }

    #[test]
    fn 对话归属只在新建时定_之后不被改掉_书不存在也不报错() {
        let mut conn = db::open_in_memory().unwrap();
        let (book, _) = folder_book(&mut conn, Scan::None);
        let other = add(&mut conn, "别的.md", "/x/别的.md", "md", "别的");
        let other_book = book_of(&conn, &other).unwrap().unwrap();

        db::upsert_session(&conn, "s1", "聊手册", None, Some(&book)).unwrap();
        // 后来用户打开了另一本书，界面照常更新这段对话：归属不变
        db::upsert_session(&conn, "s1", "聊手册", Some("sdk-1"), Some(&other_book)).unwrap();
        db::upsert_session(&conn, "s1", "聊手册", None, None).unwrap();
        assert_eq!(
            session_link(&conn, "s1"),
            (Some(book.clone()), Some("手册".to_string()))
        );
        // 新建时没挂书的，之后的更新也不会给它挂上
        db::upsert_session(&conn, "s2", "闲聊", None, None).unwrap();
        db::upsert_session(&conn, "s2", "闲聊", None, Some(&book)).unwrap();
        assert_eq!(session_link(&conn, "s2"), (None, None));
        // 传来的书已经不在了：会话照样建，只是不挂书
        db::upsert_session(&conn, "s3", "聊一本刚删掉的书", None, Some("不存在的书")).unwrap();
        assert_eq!(session_link(&conn, "s3"), (None, None));

        // 手动改挂、取消、记检索范围
        db::set_session_book(&conn, "s2", Some(&other_book)).unwrap();
        assert_eq!(
            session_link(&conn, "s2"),
            (Some(other_book.clone()), Some("别的".to_string()))
        );
        db::set_session_book(&conn, "s2", None).unwrap();
        assert_eq!(session_link(&conn, "s2"), (None, None));
        assert!(db::set_session_book(&conn, "s2", Some("不存在的书")).is_err());
        db::set_session_scope(&conn, "s1", Some(r#"{"type":"all"}"#)).unwrap();
        let s = db::list_sessions(&conn).unwrap();
        let s1 = s.iter().find(|s| s.id == "s1").unwrap();
        assert_eq!(s1.scope.as_deref(), Some(r#"{"type":"all"}"#));
        db::set_session_scope(&conn, "s1", None).unwrap();
        assert_eq!(
            list_books(&conn)
                .unwrap()
                .iter()
                .map(|b| b.session_count)
                .sum::<i64>(),
            1
        );
    }

    #[test]
    fn 笔记按书里篇的先后列出_带显示用的名字() {
        let mut conn = db::open_in_memory().unwrap();
        let (book, ids) = folder_book(&mut conn, Scan::None);
        let other = add(&mut conn, "小说", "/n.epub", "epub", "正文");
        // 先在第三章划，再在第一章划，再在另一本书上划
        note(&conn, "n3", &ids[2]);
        note(&conn, "n1", &ids[0]);
        note(&conn, "nx", &other);
        note(&conn, "n1b", &ids[0]);

        let of_book = db::list_annotations(&conn, None, Some(&book)).unwrap();
        let got: Vec<&str> = of_book.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(got, vec!["n1", "n1b", "n3"]);
        assert_eq!(of_book[0].doc_title, "手册 · 第一章");
        // 调了顺序，笔记的先后跟着变
        move_part(&mut conn, &ids[2], -2).unwrap();
        let of_book = db::list_annotations(&conn, None, Some(&book)).unwrap();
        assert_eq!(of_book[0].id, "n3");

        let one = db::list_annotations(&conn, Some(std::slice::from_ref(&other)), None).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].doc_title, "小说");
        assert_eq!(db::list_annotations(&conn, None, None).unwrap().len(), 4);
        // 两个条件一起给：取交集
        let none =
            db::list_annotations(&conn, Some(std::slice::from_ref(&other)), Some(&book)).unwrap();
        assert!(none.is_empty());
    }
}
