//! 导入：把磁盘上的文件和文件夹变成书架上的书，以及之后按磁盘上现在的样子更新它们。
//!
//! 分三步走：
//! 1. 探查（scan_paths）：只看不动，告诉界面每个路径是什么、里面有多少能导入的，让用户选怎么归成书。
//! 2. 排任务：把用户的选择展开成一串「刷新已有的一篇 / 收一个文件 / 收尾」的任务。
//! 3. 一个文件一个文件地做。解析和分块不占数据库锁；一个文件出错或者把解析库弄崩了，
//!    只算它自己失败，不连累同一批的其它文件。
//!
//! 几条贯穿始终的规矩：
//! - 一篇只属于一本书。按文件夹导入时只收新文件和「自己单独成一本」的文件（后者并进来）；
//!   已经在别的多篇的书里的不动，在结果里说一声。
//! - 同一个文件再次导入是原地更新：文档 id、所在的书、位置都不变，所以划线、笔记、进度不会丢。
//!   文件的大小和修改时间没变就不解析；解析出来文字没变就不重写（透视也就不用重做）。
//! - 原文件不见了的篇，只要上面有笔记或进度就留着（界面显示「原文件找不到了」）；
//!   是不是不见了，按库里存的路径一个个去看，不靠「这次扫描没走到它」来猜。

use crate::books::{self, BookRef, Scan};
use crate::db::{self, NewDoc, Stamp, TextChunk};
use crate::{chunk, natural, parse};
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// 文件夹最多往下走几层
pub const MAX_DEPTH: usize = 8;

fn lock(conn: &Mutex<Connection>) -> Result<MutexGuard<'_, Connection>> {
    conn.lock().map_err(|_| anyhow!("数据库锁异常"))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

// ---------- 探查 ----------

#[derive(Debug, Serialize)]
pub struct Subfolder {
    pub name: String,
    pub path: String,
    /// 里面（连更深的层）有多少个能导入的文件
    pub total: usize,
}

#[derive(Debug, Serialize)]
pub struct BookLink {
    pub id: String,
    pub title: String,
}

/// 导入前对一个路径的探查结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanItem {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    /// 文件：文档类型；不支持的是 null
    pub kind: Option<&'static str>,
    /// 文件夹：直接放在这一层的能导入的文件数
    pub direct: usize,
    /// 文件夹：连子文件夹一共多少个
    pub total: usize,
    /// 文件夹：里面有能导入的文件的直接子文件夹
    pub subfolders: Vec<Subfolder>,
    /// 文件夹：里面全是自成一本的格式（EPUB、PDF 这些）——多半是「一堆书」而不是「一本书的各章」
    pub self_contained: bool,
    /// 文件夹：层数太深，有东西没数进来
    pub truncated: bool,
    /// 文件夹：它已经是书架上的一本书
    pub book_id: Option<String>,
    /// 文件：它所在的文件夹（或上级）已经是一本书，导入后会加进那本书
    pub parent_book: Option<BookLink>,
}

#[derive(Default)]
struct Walk {
    files: Vec<PathBuf>,
    truncated: bool,
}

/// 这些目录里放的是依赖和构建产物，不是用户写的东西。把一个项目文件夹当成一本书时，
/// 不跳过的话 node_modules 里几百个 README 都会变成这本书的「篇」
const NOT_CONTENT: [&str; 7] = [
    "node_modules",
    "bower_components",
    "__pycache__",
    "venv",
    "Pods",
    "target",
    "dist",
];

fn hidden(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    name.starts_with('.') || NOT_CONTENT.contains(&name.as_ref())
}

fn has_visible_entries(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().any(|e| !hidden(&e.file_name())))
        .unwrap_or(false)
}

/// 走一遍文件夹，找出能导入的文件。deep 为假只看这一层
fn walk(root: &Path, deep: bool) -> Walk {
    let depth = if deep { MAX_DEPTH } else { 1 };
    let mut out = Walk::default();
    let walker = walkdir::WalkDir::new(root)
        .max_depth(depth)
        .into_iter()
        // 用户亲手选的那个文件夹即使以 . 开头也要进；里面的隐藏项才跳过
        .filter_entry(|e| e.depth() == 0 || !hidden(e.file_name()));
    for entry in walker.flatten() {
        let ty = entry.file_type();
        if ty.is_file() {
            if parse::kind_of(entry.path()).is_some() {
                out.files.push(entry.into_path());
            }
        } else if deep && ty.is_dir() && entry.depth() == depth {
            // 到最深的一层就不再往里走了；里面还有东西的话得让用户知道有没数进来的
            out.truncated |= has_visible_entries(entry.path());
        }
    }
    out
}

fn walk_for(dir: &Path, scan: Scan) -> Vec<PathBuf> {
    match scan {
        Scan::None => vec![],
        Scan::Flat => walk(dir, false).files,
        Scan::Deep => walk(dir, true).files,
    }
}

/// 一本按文件夹扫描的书，自己扫描时会不会收这个文件
fn covers(book: &BookRef, file: &Path) -> bool {
    match (book.scan, book.folder.as_deref()) {
        (Scan::Deep, Some(_)) => true,
        (Scan::Flat, Some(folder)) => file.parent() == Some(Path::new(folder)),
        _ => false,
    }
}

/// 看看这些路径各是什么。不改任何东西
pub fn scan_paths(conn: &Mutex<Connection>, paths: &[String]) -> Result<Vec<ScanItem>> {
    let known = books::folder_books(&*lock(conn)?)?;
    // 走文件夹可能要一会儿，不占着数据库锁
    Ok(paths.iter().map(|p| scan_one(p, &known)).collect())
}

fn scan_one(raw: &str, known: &[BookRef]) -> ScanItem {
    let path = Path::new(raw);
    let mut item = ScanItem {
        path: raw.to_string(),
        name: file_name(path),
        is_dir: path.is_dir(),
        kind: None,
        direct: 0,
        total: 0,
        subfolders: vec![],
        self_contained: false,
        truncated: false,
        book_id: None,
        parent_book: None,
    };
    if !item.is_dir {
        item.kind = parse::kind_of(path);
        item.parent_book = books::deepest_owner(known, path).map(|b| BookLink {
            id: b.id.clone(),
            title: b.title.clone(),
        });
        return item;
    }
    let found = walk(path, true);
    item.total = found.files.len();
    item.truncated = found.truncated;
    item.self_contained = !found.files.is_empty()
        && found.files.iter().all(|f| {
            matches!(
                parse::kind_of(f),
                Some("epub" | "mobi" | "fb2" | "cbz" | "pdf")
            )
        });
    let mut subs: Vec<(String, usize)> = Vec::new();
    for file in &found.files {
        let Ok(rel) = file.strip_prefix(path) else {
            continue;
        };
        let mut parts = rel.components();
        let first = parts
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_string());
        match (first, parts.next()) {
            (Some(name), Some(_)) => match subs.iter_mut().find(|(n, _)| *n == name) {
                Some((_, n)) => *n += 1,
                None => subs.push((name, 1)),
            },
            _ => item.direct += 1,
        }
    }
    subs.sort_by(|a, b| natural::cmp(Path::new(&a.0), Path::new(&b.0)));
    item.subfolders = subs
        .into_iter()
        .map(|(name, total)| Subfolder {
            path: path.join(&name).to_string_lossy().to_string(),
            name,
            total,
        })
        .collect();
    let folder = books::norm_folder(path);
    item.book_id = known
        .iter()
        .find(|b| b.folder.as_deref() == Some(folder.as_str()))
        .map(|b| b.id.clone());
    item
}

// ---------- 导入 ----------

/// 一个路径怎么导入
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// 文件：这个路径导入过就原地更新；落在某本文件夹书的目录里就加进那本书；否则自己成一本
    #[default]
    Auto,
    /// 文件夹：整个文件夹（连子文件夹）是一本书。带 files 时只收点名的那几个文件
    Book,
    /// 文件夹：只有这一层的文件算这本书
    BookFlat,
    /// 文件夹：每个子文件夹各是一本书，这一层的文件各归各的
    Subfolders,
    /// 文件夹：里面每个文件各归各的
    Each,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportItem {
    pub path: String,
    #[serde(default)]
    pub mode: Mode,
    /// 只和 mode = book 一起用：从这个文件夹里挑出来合成一本的那几个文件
    #[serde(default)]
    pub files: Option<Vec<String>>,
}

#[derive(Debug, Default, Serialize)]
pub struct ImportSummary {
    /// 新收进来的篇
    pub added: usize,
    /// 文字变了、重建了索引的篇
    pub updated: usize,
    /// 没变的篇（包括文件动过但文字没变的、只是改了名的）
    pub unchanged: usize,
    /// 原文件找不到了、因为带着笔记或进度而留下来的篇
    pub missing: usize,
    /// 没收的，每条一句给用户看的话（「3 个文件已在《X》里」）
    pub skipped: Vec<String>,
    /// 失败的，「文件名：原因」
    pub failed: Vec<String>,
    /// 这次动到的书
    pub books: Vec<String>,
}

/// 导入进度，通过 import-progress 事件推给界面
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub name: String,
    /// parsing / indexing / done / error
    pub stage: &'static str,
    pub index: usize,
    pub total: usize,
    pub message: Option<String>,
}

enum Task {
    /// 已经在书里的一篇：看原文件变没变
    Refresh { doc_id: String, path: PathBuf },
    /// 一个要收的文件。book 是要放进去的那本书；None 表示按单个文件的规则自己找归属
    /// named：这个文件是用户点名选的，还是走文件夹时碰到的。只有点名的才会把
    /// 「之前从书里移除过」这件事推翻
    Take {
        path: PathBuf,
        book: Option<String>,
        named: bool,
    },
    /// 一本书的文件都过完了：处理原文件不见了的篇
    Settle { book_id: String },
}

#[derive(Default)]
struct Plan {
    tasks: Vec<Task>,
    /// 这次新建的书。到最后一篇都没收进来的话删掉，不留空壳
    created: Vec<String>,
    /// 已经排进任务的文件：同一个文件在一批里出现两次只处理一次
    seen: HashSet<PathBuf>,
    books: Vec<String>,
}

/// 要按「一本书」来处理的一个文件夹
struct FolderJob {
    folder: String,
    /// 已经是书架上的书的话，是它的 id
    book: Option<String>,
    scan: Scan,
    /// 已有的书要不要把扫描方式改成 scan
    set_scan: bool,
    walked: Vec<PathBuf>,
    /// 用户点名要收的文件
    extra: Vec<PathBuf>,
}

/// 把用户选的路径展开成「哪些文件夹各是一本书」和「哪些文件各归各的」。只看磁盘，不碰数据库
struct Expand<'a> {
    known: &'a [BookRef],
    folders: Vec<FolderJob>,
    singles: Vec<PathBuf>,
    /// singles 里哪些是走文件夹走出来的（不是用户点名的）
    walked: HashSet<PathBuf>,
    skipped: Vec<String>,
}

impl Expand<'_> {
    /// top：用户直接选的文件夹，里面什么都没有时要说一声；展开子文件夹时碰到空的就不说了
    fn dir(&mut self, dir: &Path, mode: Mode, files: Option<&[String]>, top: bool) {
        let folder = books::norm_folder(dir);
        let root = Path::new(&folder);
        // 点名的文件不在这个文件夹下面的，没法算它的篇，按单个文件导入
        let (extra, outside): (Vec<PathBuf>, Vec<PathBuf>) = files
            .unwrap_or_default()
            .iter()
            .map(PathBuf::from)
            .partition(|f| f != root && f.starts_with(root));
        self.singles.extend(outside);

        let existing = self
            .known
            .iter()
            .find(|b| b.folder.as_deref() == Some(folder.as_str()));
        if let Some(book) = existing {
            // 已经是一本书了：不管这次选的是哪种方式，都是按它现在的样子再扫一遍。
            // 只有一种例外：原来只收手动加的文件，这次明确说了要整个文件夹
            let scan = match mode {
                Mode::Book if files.is_none() && book.scan == Scan::None => Scan::Deep,
                Mode::BookFlat if book.scan == Scan::None => Scan::Flat,
                _ => book.scan,
            };
            self.folders.push(FolderJob {
                walked: walk_for(root, scan),
                book: Some(book.id.clone()),
                set_scan: scan != book.scan,
                folder,
                scan,
                extra,
            });
            return;
        }
        match mode {
            Mode::Book | Mode::BookFlat => {
                let scan = match (mode, files) {
                    (Mode::Book, Some(_)) => Scan::None,
                    (Mode::Book, None) => Scan::Deep,
                    _ => Scan::Flat,
                };
                let walked = walk_for(root, scan);
                let mut all: Vec<&PathBuf> = walked.iter().chain(&extra).collect();
                all.sort();
                all.dedup();
                match all.as_slice() {
                    [] => {
                        if top {
                            self.skipped.push(format!(
                                "「{}」里没有能导入的文件",
                                books::folder_title(&folder)
                            ));
                        }
                    }
                    // 只有一个文件的文件夹不算一本「文件夹书」，那个文件自己成一本
                    [only] => {
                        if !extra.contains(*only) {
                            self.walked.insert((*only).clone());
                        }
                        self.singles.push((*only).clone());
                    }
                    _ => self.folders.push(FolderJob {
                        folder,
                        book: None,
                        scan,
                        set_scan: false,
                        walked,
                        extra,
                    }),
                }
            }
            Mode::Subfolders => {
                let found = walk(root, false).files;
                self.walked.extend(found.iter().cloned());
                self.singles.extend(found);
                let mut subs: Vec<PathBuf> = std::fs::read_dir(root)
                    .map(|entries| {
                        entries
                            .flatten()
                            .filter(|e| !hidden(&e.file_name()))
                            .map(|e| e.path())
                            .filter(|p| p.is_dir())
                            .collect()
                    })
                    .unwrap_or_default();
                subs.sort_by(|a, b| natural::cmp(a, b));
                for sub in subs {
                    self.dir(&sub, Mode::Book, None, false);
                }
            }
            Mode::Auto | Mode::Each => {
                let found = walk(root, true).files;
                self.walked.extend(found.iter().cloned());
                self.singles.extend(found);
            }
        }
    }
}

fn plan(conn: &Mutex<Connection>, items: &[ImportItem]) -> Result<(Plan, Vec<String>)> {
    let known = books::folder_books(&*lock(conn)?)?;
    let mut ex = Expand {
        known: &known,
        folders: vec![],
        singles: vec![],
        walked: HashSet::new(),
        skipped: vec![],
    };
    // 用户点名的文件。同一个文件既被点名、又被走文件夹碰到时，算点名的
    let mut named: HashSet<PathBuf> = HashSet::new();
    for item in items {
        let path = Path::new(&item.path);
        if path.is_dir() {
            ex.dir(path, item.mode, item.files.as_deref(), true);
        } else {
            named.insert(path.to_path_buf());
            ex.singles.push(path.to_path_buf());
        }
    }
    let mut plan = Plan::default();
    // 文件夹先排：同一批里既给了文件夹、又单独给了里面的文件时，文件算文件夹那本书的
    for job in ex.folders {
        let book_id = {
            let c = lock(conn)?;
            match job.book {
                Some(id) => {
                    if job.set_scan {
                        c.execute(
                            "UPDATE books SET scan = ?2 WHERE id = ?1",
                            params![id, job.scan.as_str()],
                        )?;
                    }
                    id
                }
                // 同一批里同一个文件夹给了两次：第二次接着用第一次建的那本
                None => match books::folder_book_at(&c, &job.folder)? {
                    Some(book) => book.id,
                    None => {
                        let id = books::create_book(
                            &c,
                            &books::folder_title(&job.folder),
                            None,
                            Some(&job.folder),
                            job.scan,
                        )?;
                        plan.created.push(id.clone());
                        id
                    }
                },
            }
        };
        plan_book(
            conn,
            &book_id,
            Some(&job.folder),
            job.walked,
            job.extra,
            &mut plan,
        )?;
    }
    for path in ex.singles {
        if plan.seen.insert(path.clone()) {
            let named = named.contains(&path) || !ex.walked.contains(&path);
            plan.tasks.push(Task::Take {
                path,
                book: None,
                named,
            });
        }
    }
    Ok((plan, ex.skipped))
}

/// 给一本书排任务：先刷新已有的篇（位置不动），再按自然顺序收新文件（排在后面），最后收尾
fn plan_book(
    conn: &Mutex<Connection>,
    book_id: &str,
    folder: Option<&str>,
    walked: Vec<PathBuf>,
    extra: Vec<PathBuf>,
    plan: &mut Plan,
) -> Result<()> {
    // 库里的清单取出来就放开锁：下面要挨个去看文件在不在，盘慢的时候不该让别的操作等着
    let (parts, excluded) = {
        let c = lock(conn)?;
        (books::parts(&c, book_id)?, books::excluded(&c, book_id)?)
    };
    let mine: HashSet<&str> = parts.iter().filter_map(|p| p.path.as_deref()).collect();
    for p in parts.iter().filter(|p| p.file_exists()) {
        let path = PathBuf::from(p.path.as_deref().unwrap_or_default());
        if plan.seen.insert(path.clone()) {
            plan.tasks.push(Task::Refresh {
                doc_id: p.id.clone(),
                path,
            });
        }
    }
    let mut incoming: Vec<PathBuf> = walked
        .into_iter()
        // 用户从这本书里移除过的文件，扫描时不再收
        .filter(|f| !excluded.contains(f.to_string_lossy().as_ref()))
        // 点名要的不受这个限制：用户又把它加回来了
        .chain(extra)
        .filter(|f| !mine.contains(f.to_string_lossy().as_ref()))
        .collect();
    let rel = |f: &PathBuf| -> PathBuf {
        folder
            .and_then(|d| f.strip_prefix(d).ok())
            .unwrap_or(f.as_path())
            .to_path_buf()
    };
    incoming.sort_by(|a, b| natural::cmp(&rel(a), &rel(b)));
    for path in incoming {
        if plan.seen.insert(path.clone()) {
            plan.tasks.push(Task::Take {
                path,
                book: Some(book_id.to_string()),
                named: true,
            });
        }
    }
    plan.tasks.push(Task::Settle {
        book_id: book_id.to_string(),
    });
    plan.books.push(book_id.to_string());
    Ok(())
}

/// 一个文件处理完的结果。带着的是它现在所在的书
enum Outcome {
    Added(String),
    Updated(String),
    Unchanged(String),
    /// 已经在另一本多篇的书里，没动。带的是那本书的书名
    Owned(String),
    /// 不归这次导入管（用户移除过的），不计数
    Left,
}

/// 文件解析、分块之后的样子
struct Loaded {
    title: String,
    kind: &'static str,
    pages: Option<i64>,
    author: Option<String>,
    cover: Option<Vec<u8>>,
    chunks: Vec<TextChunk>,
}

impl Loaded {
    fn doc<'a>(&'a self, path: &'a str) -> NewDoc<'a> {
        NewDoc {
            title: &self.title,
            path,
            kind: self.kind,
            pages: self.pages,
            author: self.author.as_deref(),
            cover: self.cover.as_deref(),
        }
    }
}

fn load(path: &Path) -> Result<Loaded> {
    let parsed = parse::extract(path)?;
    let chunks: Vec<TextChunk> = chunk::chunk_pages(&parsed.pages)
        .into_iter()
        .map(|c| TextChunk {
            idx: c.idx,
            page: c.page,
            text: c.text,
        })
        .collect();
    // 漫画和扫描版 PDF 没有文字：照样能读，只是搜不到
    if chunks.is_empty() && !matches!(parsed.kind, "cbz" | "pdf") {
        anyhow::bail!("解析后没有内容");
    }
    let name = file_name(path);
    // 电子书用书里写的书名，其它用文件名
    let title = parsed
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(&name)
        .to_string();
    Ok(Loaded {
        title,
        kind: parsed.kind,
        pages: parsed.page_count,
        author: parsed.author,
        cover: parsed.cover.as_deref().and_then(crate::ebook::thumbnail),
        chunks,
    })
}

fn same_text(stored: &[String], chunks: &[TextChunk]) -> bool {
    stored
        .iter()
        .map(String::as_str)
        .eq(chunks.iter().map(|c| c.text.as_str()))
}

/// 解析库遇到畸形文件可能 panic；兜住，变成这一个文件的失败，不连累同一批的其它文件
fn import_guarded<T>(work: impl FnOnce() -> Result<T>) -> Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
        .unwrap_or_else(|_| Err(anyhow!("这个文件的结构解析不了")))
}

/// 已经在库里的一篇：原文件变了就原地更新
fn refresh(
    conn: &Mutex<Connection>,
    doc_id: &str,
    path: &Path,
    on_stage: &dyn Fn(&'static str),
) -> Result<Outcome> {
    let part =
        books::part(&*lock(conn)?, doc_id)?.ok_or_else(|| anyhow!("这一篇已经从书架上移除了"))?;
    // 先记下大小和时间再解析：解析的时候文件又被改了的话，下次扫描还能发现
    let stamp = Stamp::of(path);
    if stamp.is_some() && part.stamp == stamp {
        return Ok(Outcome::Unchanged(part.book_id));
    }
    on_stage("parsing");
    let loaded = load(path)?;
    {
        let c = lock(conn)?;
        // 文件动过（另存了一下、被同步工具碰了）但文字没变：片段、索引、透视都不用动。
        // 没有文字的（漫画、扫描件）比不出来，文件变了就当它变了；格式换了的也要把新格式记下来
        if !loaded.chunks.is_empty()
            && part.kind == loaded.kind
            && same_text(&db::chunk_texts(&c, doc_id)?, &loaded.chunks)
        {
            db::touch_document(&c, doc_id, stamp)?;
            return Ok(Outcome::Unchanged(part.book_id));
        }
    }
    on_stage("indexing");
    let words = db::segment_all(&loaded.chunks);
    let path_str = path.to_string_lossy();
    let mut c = lock(conn)?;
    let tx = c.transaction()?;
    db::replace_content(
        &tx,
        doc_id,
        &loaded.doc(&path_str),
        stamp,
        &loaded.chunks,
        &words,
    )?;
    tx.commit()?;
    Ok(Outcome::Updated(part.book_id))
}

/// 收一个文件。book 是要放进去的那本书（按文件夹导入时）；None 是按单个文件的规则找归属
fn take(
    conn: &Mutex<Connection>,
    path: &Path,
    book: Option<&str>,
    named: bool,
    on_stage: &dyn Fn(&'static str),
) -> Result<Outcome> {
    let path_str = path.to_string_lossy().to_string();
    let existing = books::part_by_path(&*lock(conn)?, &path_str)?;
    if let Some(part) = existing {
        if let Some(target) = book.filter(|t| *t != part.book_id) {
            let mut c = lock(conn)?;
            // 已经是另一本多篇的书里的一篇：不动它
            let owner = books::book_ref(&c, &part.book_id)?.filter(|o| o.folder.is_some());
            if let Some(owner) = owner {
                return Ok(Outcome::Owned(owner.title));
            }
            // 它自己单独成一本：并进来
            let tx = c.transaction()?;
            books::absorb(&tx, &part.id, target)?;
            tx.commit()?;
        }
        return refresh(conn, &part.id, path, on_stage);
    }

    on_stage("parsing");
    let stamp = Stamp::of(path);
    let loaded = load(path)?;
    on_stage("indexing");
    let words = db::segment_all(&loaded.chunks);

    let mut c = lock(conn)?;
    let tx = c.transaction()?;
    // 解析的这段时间里，另一次导入可能已经把它收进来了
    if let Some(part) = books::part_by_path(&tx, &path_str)? {
        return Ok(Outcome::Unchanged(part.book_id));
    }
    let known = books::folder_books(&tx)?;
    let deepest = books::deepest_owner(&known, path);
    let owner: Option<&BookRef> = match book {
        None => match deepest {
            // 走上级文件夹时碰到的文件，落在一本书的目录里、而那本书的主人亲手移除过它：
            // 不收回去。只有用户点名选这个文件，才算改了主意
            Some(o) if !named && books::excluded(&tx, &o.id)?.contains(&path_str) => {
                return Ok(Outcome::Left);
            }
            other => other,
        },
        Some(target) => match deepest {
            // 走文件夹时碰到的新文件，如果落在更里面一层的另一本书的目录里、而且那本书自己扫描时
            // 也会收它，就归那一本——和单个文件的规则一样，最里面的那本说了算。
            // 不然两本书谁先扫描谁就把它收走，结果看运气
            Some(inner) if inner.id != target && covers(inner, path) => {
                // 那本书的主人亲手移除过这个文件：谁也不收
                if books::excluded(&tx, &inner.id)?.contains(&path_str) {
                    return Ok(Outcome::Left);
                }
                Some(inner)
            }
            _ => Some(
                known
                    .iter()
                    .find(|b| b.id == target)
                    .ok_or_else(|| anyhow!("这本书已经从书架上移除了"))?,
            ),
        },
    };
    let outcome = match owner {
        Some(owner) => match renamed_part(&tx, &owner.id, &loaded, stamp)? {
            // 书里有一篇原文件不见了、文字和这个文件一模一样：是那一篇改了名或者挪了位置。
            // 只把路径指过来，文档 id 不变，上面的笔记和进度都还在
            Some(doc_id) => {
                books::repoint(&tx, &doc_id, path, stamp)?;
                tx.execute(
                    "UPDATE docs SET kind = ?2 WHERE id = ?1",
                    params![doc_id, loaded.kind],
                )?;
                Outcome::Unchanged(owner.id.clone())
            }
            None => {
                db::insert_document(
                    &tx,
                    &owner.id,
                    &loaded.doc(&path_str),
                    stamp,
                    &loaded.chunks,
                    &words,
                )?;
                // 以前移除过、现在用户又点名加回来的：从排除名单里拿掉
                tx.execute(
                    "DELETE FROM book_excluded WHERE book_id = ?1 AND path = ?2",
                    params![owner.id, path_str],
                )?;
                Outcome::Added(owner.id.clone())
            }
        },
        None => {
            let book_id = books::create_book(
                &tx,
                &books::stem_title(&loaded.title, Some(&path_str)),
                loaded.author.as_deref(),
                None,
                Scan::None,
            )?;
            db::insert_document(
                &tx,
                &book_id,
                &loaded.doc(&path_str),
                stamp,
                &loaded.chunks,
                &words,
            )?;
            Outcome::Added(book_id)
        }
    };
    tx.commit()?;
    Ok(outcome)
}

/// 这个新文件是不是书里某一篇换了个名字：那一篇的原文件不见了，而文字和它一模一样
fn renamed_part(
    tx: &Transaction,
    book_id: &str,
    loaded: &Loaded,
    stamp: Option<Stamp>,
) -> Result<Option<String>> {
    for part in books::parts(tx, book_id)? {
        if part.file_exists() {
            continue;
        }
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM chunks WHERE doc_id = ?1",
            params![part.id],
            |r| r.get(0),
        )?;
        if count as usize != loaded.chunks.len() {
            continue;
        }
        let same = if loaded.chunks.is_empty() {
            // 没有文字可比（漫画、扫描件）：同一种格式、字节数一样才认
            part.kind == loaded.kind
                && stamp.is_some()
                && part.stamp.map(|s| s.size) == stamp.map(|s| s.size)
        } else {
            same_text(&db::chunk_texts(tx, &part.id)?, &loaded.chunks)
        };
        if same {
            return Ok(Some(part.id));
        }
    }
    Ok(None)
}

/// 一本书的文件都过完之后：看看哪些篇的原文件不见了。
/// 上面有划线、笔记或进度的留着，算进「找不到原文件」的数里；什么都没有的直接拿掉。
/// 返回留下来的有几篇。
fn settle(conn: &Mutex<Connection>, book_id: &str) -> Result<usize> {
    let (book, parts) = {
        let c = lock(conn)?;
        (books::book_ref(&c, book_id)?, books::parts(&c, book_id)?)
    };
    let Some(book) = book else {
        return Ok(0);
    };
    // 看文件在不在的时候不占着数据库锁
    let gone: Vec<&books::Part> = parts.iter().filter(|p| !p.file_exists()).collect();
    if gone.is_empty() {
        return Ok(0);
    }
    // 只有文件夹书、而且文件夹本身还在的时候才往外拿。文件夹整个找不到（挪走了、移动硬盘没插上）
    // 时一篇都不能删——那是「书挪了地方」，不是「这几篇被删了」。单文件的书也不删：删了书就没了
    let may_drop = book
        .folder
        .as_deref()
        .is_some_and(|f| Path::new(f).is_dir());
    let mut c = lock(conn)?;
    let tx = c.transaction()?;
    let (mut kept, mut dropped) = (0, false);
    for part in gone {
        if may_drop && !books::has_user_data(&tx, &part.id)? {
            db::delete_document_in(&tx, &part.id)?;
            dropped = true;
        } else {
            kept += 1;
        }
    }
    if dropped {
        books::tidy_after_removal(&tx, book_id)?;
    }
    tx.commit()?;
    Ok(kept)
}

fn execute(
    conn: &Mutex<Connection>,
    plan: Plan,
    summary: &mut ImportSummary,
    on_progress: &dyn Fn(Progress),
) {
    let total = plan
        .tasks
        .iter()
        .filter(|t| !matches!(t, Task::Settle { .. }))
        .count();
    let mut index = 0;
    let mut owned: Vec<(String, usize)> = Vec::new();
    let mut touched = plan.books;
    for task in &plan.tasks {
        let path = match task {
            Task::Settle { book_id } => {
                match settle(conn, book_id) {
                    Ok(kept) => summary.missing += kept,
                    Err(err) => summary.failed.push(err.to_string()),
                }
                continue;
            }
            Task::Refresh { path, .. } | Task::Take { path, .. } => path,
        };
        index += 1;
        let name = file_name(path);
        let emit = |stage: &'static str, message: Option<String>| {
            on_progress(Progress {
                name: name.clone(),
                stage,
                index,
                total,
                message,
            })
        };
        let result = import_guarded(|| match task {
            Task::Refresh { doc_id, path } => refresh(conn, doc_id, path, &|s| emit(s, None)),
            Task::Take { path, book, named } => {
                take(conn, path, book.as_deref(), *named, &|s| emit(s, None))
            }
            Task::Settle { .. } => Ok(Outcome::Left),
        });
        let book = match result {
            Ok(Outcome::Added(book)) => {
                summary.added += 1;
                Some(book)
            }
            Ok(Outcome::Updated(book)) => {
                summary.updated += 1;
                Some(book)
            }
            Ok(Outcome::Unchanged(book)) => {
                summary.unchanged += 1;
                Some(book)
            }
            Ok(Outcome::Owned(title)) => {
                match owned.iter_mut().find(|(t, _)| *t == title) {
                    Some((_, n)) => *n += 1,
                    None => owned.push((title, 1)),
                }
                None
            }
            Ok(Outcome::Left) => None,
            Err(err) => {
                summary.failed.push(format!("{name}：{err}"));
                emit("error", Some(err.to_string()));
                continue;
            }
        };
        touched.extend(book);
        emit("done", None);
    }
    for (title, n) in owned {
        summary.skipped.push(format!("{n} 个文件已在《{title}》里"));
    }
    if let Ok(c) = conn.lock() {
        for id in &plan.created {
            let _ = c.execute(
                "DELETE FROM books WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM docs WHERE book_id = ?1)",
                params![id],
            );
        }
        let mut seen = HashSet::new();
        touched.retain(|id| {
            seen.insert(id.clone()) && books::book_ref(&c, id).ok().flatten().is_some()
        });
    }
    summary.books = touched;
}

/// 导入一批路径。on_progress 每个文件会被调几次（解析、建索引、完成或出错）
pub fn run(
    conn: &Mutex<Connection>,
    items: &[ImportItem],
    on_progress: &dyn Fn(Progress),
) -> ImportSummary {
    let mut summary = ImportSummary::default();
    match plan(conn, items) {
        Ok((plan, skipped)) => {
            summary.skipped = skipped;
            execute(conn, plan, &mut summary, on_progress);
        }
        Err(err) => summary.failed.push(err.to_string()),
    }
    summary
}

/// 按磁盘上现在的样子更新一本书：已有的篇变了就重建，文件夹里多出来的文件收进来（排在后面），
/// 原文件不见了的篇按规矩留下或拿掉。和把它的文件夹再导入一次是一回事。
/// 单文件的书、只收手动加的文件的书没有「多出来的文件」这一说，只做前后两样。
pub fn rescan(
    conn: &Mutex<Connection>,
    book_id: &str,
    on_progress: &dyn Fn(Progress),
) -> Result<ImportSummary> {
    let book = books::book_ref(&*lock(conn)?, book_id)?
        .ok_or_else(|| anyhow!("这本书已经不在书架上了"))?;
    let walked = match &book.folder {
        Some(folder) => walk_for(Path::new(folder), book.scan),
        None => vec![],
    };
    let mut plan = Plan::default();
    plan_book(
        conn,
        book_id,
        book.folder.as_deref(),
        walked,
        vec![],
        &mut plan,
    )?;
    let mut summary = ImportSummary::default();
    execute(conn, plan, &mut summary, on_progress);
    Ok(summary)
}

/// 只把一本书已有的各篇按原文件刷新一遍：不收新文件，也不拿掉找不到的。
/// 用户重新指了文件位置之后调——路径换了，内容可能也跟着不一样了
pub fn refresh_parts(conn: &Mutex<Connection>, book_id: &str) -> Result<()> {
    let parts = books::parts(&*lock(conn)?, book_id)?;
    for part in parts.iter().filter(|p| p.file_exists()) {
        let path = PathBuf::from(part.path.as_deref().unwrap_or_default());
        // 这一篇解析不了不影响别的篇；它保持原来的内容
        let _ = import_guarded(|| refresh(conn, &part.id, &path, &|_| {}));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct ReindexSummary {
    pub imported: usize,
    pub failed: Vec<String>,
}

/// 重建索引：按原文件把每一篇重新解析、重新切块、重写全文索引，向量整个重算。
/// 只动内容，不动书架：不新增、不移动、不拿掉任何一篇，也不碰书。
/// 文字没变的篇透视还留着（那是花钱让模型做的）。
/// 原文件找不到或解析不了的篇保持原来的内容（还按旧内容搜得到），在返回值里列出来。
pub fn reindex(conn: &Mutex<Connection>) -> Result<ReindexSummary> {
    let files = {
        let c = lock(conn)?;
        db::clear_vectors(&c)?;
        db::doc_files(&c)?
    };
    let mut summary = ReindexSummary {
        imported: 0,
        failed: vec![],
    };
    for (doc_id, path) in files {
        let result = import_guarded(|| {
            let path = path.as_deref().ok_or_else(|| anyhow!("没有原文件"))?;
            let file = Path::new(path);
            let stamp = Stamp::of(file);
            let loaded = load(file)?;
            let words = db::segment_all(&loaded.chunks);
            let mut c = lock(conn)?;
            let tx = c.transaction()?;
            db::replace_content(
                &tx,
                &doc_id,
                &loaded.doc(path),
                stamp,
                &loaded.chunks,
                &words,
            )?;
            tx.commit()?;
            Ok(())
        });
        match result {
            Ok(()) => summary.imported += 1,
            Err(err) => summary.failed.push(format!(
                "{}：{err}",
                path.as_deref().unwrap_or(doc_id.as_str())
            )),
        }
    }
    // 没能重写的篇，全文索引里要是缺了它们的片段就补上
    crate::fts::rebuild_if_empty(&*lock(conn)?)?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    /// 一个临时目录当「磁盘」，一个内存库当书架
    struct Bench {
        root: PathBuf,
        conn: Mutex<Connection>,
    }

    impl Bench {
        fn new(name: &str) -> Bench {
            let root =
                std::env::temp_dir().join(format!("docagent-import-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            Bench {
                root,
                conn: Mutex::new(db::open_in_memory().unwrap()),
            }
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.root.join(rel)
        }

        fn write(&self, rel: &str, text: &str) -> String {
            let path = self.path(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            path.to_string_lossy().to_string()
        }

        fn item(&self, rel: &str, mode: Mode) -> ImportItem {
            ImportItem {
                path: self.path(rel).to_string_lossy().to_string(),
                mode,
                files: None,
            }
        }

        fn import(&self, items: &[ImportItem]) -> ImportSummary {
            run(&self.conn, items, &|_| {})
        }

        fn rescan(&self, book_id: &str) -> ImportSummary {
            rescan(&self.conn, book_id, &|_| {}).unwrap()
        }

        fn shelf(&self) -> Vec<books::Book> {
            books::list_books(&self.conn.lock().unwrap()).unwrap()
        }

        fn book(&self, title: &str) -> books::Book {
            self.shelf()
                .into_iter()
                .find(|b| b.title == title)
                .unwrap_or_else(|| panic!("书架上没有《{title}》"))
        }

        fn names(&self, title: &str) -> Vec<String> {
            self.book(title).docs.into_iter().map(|d| d.name).collect()
        }

        fn doc(&self, book: &str, name: &str) -> books::Doc {
            self.book(book)
                .docs
                .into_iter()
                .find(|d| d.name == name)
                .unwrap_or_else(|| panic!("《{book}》里没有「{name}」"))
        }

        fn highlight(&self, doc_id: &str, id: &str) {
            db::save_annotation(
                &self.conn.lock().unwrap(),
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

        fn xray(&self, doc_id: &str) {
            self.conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO xray_units(doc_id, unit, page, start, end, title, summary, entities)
                     VALUES(?1, 0, NULL, 0, 1, '小标题', '要点', '[]')",
                    params![doc_id],
                )
                .unwrap();
        }

        fn count(&self, sql: &str, doc_id: &str) -> i64 {
            self.conn
                .lock()
                .unwrap()
                .query_row(sql, params![doc_id], |r| r.get(0))
                .unwrap()
        }

        fn xray_count(&self, doc_id: &str) -> i64 {
            self.count("SELECT COUNT(*) FROM xray_units WHERE doc_id = ?1", doc_id)
        }

        fn rev(&self, doc_id: &str) -> i64 {
            self.count("SELECT rev FROM docs WHERE id = ?1", doc_id)
        }

        fn chunk_ids(&self, doc_id: &str) -> Vec<i64> {
            let c = self.conn.lock().unwrap();
            let mut stmt = c
                .prepare("SELECT id FROM chunks WHERE doc_id = ?1 ORDER BY id")
                .unwrap();
            let rows = stmt.query_map(params![doc_id], |r| r.get(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        }

        fn found(&self, query: &str) -> usize {
            crate::fts::search(
                &self.conn.lock().unwrap(),
                query,
                10,
                &crate::spoiler::Access::all(),
            )
            .unwrap()
            .len()
        }

        /// 一个三章的手册文件夹，按一本书导入
        fn manual(&self) -> books::Book {
            self.write("手册/第一章.md", "第一章讲蒸汽机的锅炉。");
            self.write("手册/第二章.md", "第二章讲蒸汽机的活塞。");
            self.write("手册/第十章.md", "第十章讲蒸汽机的飞轮。");
            let s = self.import(&[self.item("手册", Mode::Book)]);
            assert_eq!((s.added, s.failed.len()), (3, 0), "{s:?}");
            self.book("手册")
        }
    }

    impl Drop for Bench {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// 把文件的修改时间往后拨，内容不动
    fn touch(path: &Path) {
        let later = SystemTime::now() + Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(later)
            .unwrap();
    }

    #[test]
    fn 文件夹按一本书导入_篇按自然顺序排_坏文件只算它自己失败() {
        let b = Bench::new("folder");
        b.write("手册/第十章.md", "第十章讲蒸汽机的飞轮。");
        b.write("手册/第二章.md", "第二章讲蒸汽机的活塞。");
        b.write("手册/第一章.md", "第一章讲蒸汽机的锅炉。");
        b.write("手册/附录/表.txt", "附录是一张对照表。");
        b.write("手册/坏的.docx", "这不是一个 zip");
        b.write("手册/.草稿.md", "隐藏文件不该被收进来");
        b.write("手册/图.png", "不支持的类型");

        let seen = Mutex::new(Vec::new());
        let s = run(&b.conn, &[b.item("手册", Mode::Book)], &|p| {
            seen.lock()
                .unwrap()
                .push((p.name, p.stage, p.index, p.total))
        });
        assert_eq!((s.added, s.updated, s.unchanged, s.missing), (4, 0, 0, 0));
        assert_eq!(s.failed.len(), 1);
        assert!(s.failed[0].starts_with("坏的.docx："), "{:?}", s.failed);
        assert!(s.skipped.is_empty());

        let shelf = b.shelf();
        assert_eq!(shelf.len(), 1);
        let book = &shelf[0];
        assert_eq!(s.books, vec![book.id.clone()]);
        assert_eq!(book.title, "手册");
        assert_eq!(book.scan, Scan::Deep);
        assert_eq!(
            book.folder.as_deref(),
            Some(b.path("手册").to_string_lossy().as_ref())
        );
        assert_eq!(b.names("手册"), vec!["第一章", "第二章", "第十章", "表"]);
        assert_eq!(book.docs[0].display_title, "手册 · 第一章");
        assert_eq!(book.docs[0].title, "第一章.md");
        assert!(book.docs.iter().all(|d| !d.missing && d.chunk_count == 1));
        assert_eq!(b.found("蒸汽机"), 3);

        // 进度事件：五个文件（坏的也算一个），每个都有个了结
        let seen = seen.into_inner().unwrap();
        assert!(seen.iter().all(|(_, _, _, total)| *total == 5));
        assert_eq!(
            seen.iter()
                .filter(|(_, stage, _, _)| *stage == "done")
                .count(),
            4
        );
        // 「坏的」按自然顺序排在最前面
        assert!(seen.contains(&("坏的.docx".to_string(), "error", 1, 5)));
    }

    #[test]
    fn 单个电子书和pdf各成一本_书名作者封面取自书里() {
        let b = Bench::new("ebook");
        let docs = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-docs");
        let item = |name: &str| ImportItem {
            path: docs.join(name).to_string_lossy().to_string(),
            mode: Mode::Auto,
            files: None,
        };
        let s = b.import(&[item("示例小说.epub"), item("采购合同.pdf")]);
        assert_eq!((s.added, s.failed.len(), s.books.len()), (2, 0, 2), "{s:?}");

        // 电子书用书里写的书名和作者，不用文件名
        let novel = b.book("槐花开");
        assert_eq!(novel.author.as_deref(), Some("测试作者"));
        assert!(novel.folder.is_none());
        assert_eq!(novel.docs[0].display_title, "槐花开");
        assert_eq!(novel.docs[0].kind, "epub");
        assert!(novel.spoiler_free && novel.spoiler_default);
        // PDF 用文件名，去掉扩展名；合同不是小说，默认不防剧透
        let contract = b.book("采购合同");
        assert_eq!(contract.docs[0].title, "采购合同.pdf");
        assert_eq!(contract.docs[0].pages, Some(3));
        assert!(!contract.spoiler_free);
        assert!(b.found("质保期") >= 1);

        // 再导入一遍：文件没动过，什么都不做
        let s = b.import(&[item("示例小说.epub"), item("采购合同.pdf")]);
        assert_eq!((s.added, s.updated, s.unchanged), (0, 0, 2));
        assert_eq!(b.shelf().len(), 2);
    }

    #[test]
    fn 重新扫描_新文件排在后面_没动过的不重新解析() {
        let b = Bench::new("rescan-add");
        let book = b.manual();
        let before: Vec<Vec<i64>> = book.docs.iter().map(|d| b.chunk_ids(&d.id)).collect();

        b.write("手册/第三章.md", "第三章讲蒸汽机的气缸。");
        b.write("手册/序.md", "序言。");
        let s = b.rescan(&book.id);
        assert_eq!((s.added, s.updated, s.unchanged, s.missing), (2, 0, 3, 0));
        assert_eq!(s.books, vec![book.id.clone()]);
        // 原来的三篇位置不变；新来的两篇接在后面，它们之间按自然顺序
        assert_eq!(
            b.names("手册"),
            vec!["第一章", "第二章", "第十章", "序", "第三章"]
        );
        let after: Vec<Vec<i64>> = book.docs.iter().map(|d| b.chunk_ids(&d.id)).collect();
        assert_eq!(before, after);

        // 再扫一次：什么都没变
        let s = b.rescan(&book.id);
        assert_eq!((s.added, s.updated, s.unchanged), (0, 0, 5));
    }

    #[test]
    fn 重新扫描_文件动过但文字没变_片段和透视都不动() {
        let b = Bench::new("rescan-touch");
        let book = b.manual();
        let doc = &book.docs[0];
        b.xray(&doc.id);
        let (chunks, rev) = (b.chunk_ids(&doc.id), b.rev(&doc.id));

        touch(&b.path("手册/第一章.md"));
        let s = b.rescan(&book.id);
        assert_eq!((s.added, s.updated, s.unchanged), (0, 0, 3));
        assert_eq!(b.chunk_ids(&doc.id), chunks);
        assert_eq!(b.rev(&doc.id), rev);
        assert_eq!(b.xray_count(&doc.id), 1);
        // 新的修改时间记下了：下一次扫描不用再解析它
        let stamp = books::part(&b.conn.lock().unwrap(), &doc.id)
            .unwrap()
            .unwrap()
            .stamp;
        assert_eq!(stamp, Stamp::of(&b.path("手册/第一章.md")));
    }

    #[test]
    fn 重新扫描_文字变了_这一篇重建且透视作废_别的篇不受影响() {
        let b = Bench::new("rescan-edit");
        let book = b.manual();
        let (first, second) = (&book.docs[0], &book.docs[1]);
        b.xray(&first.id);
        b.xray(&second.id);
        b.highlight(&first.id, "h1");
        let rev = b.rev(&first.id);
        let other_chunks = b.chunk_ids(&second.id);

        b.write("手册/第一章.md", "第一章改写了：讲的是内燃机的火花塞。");
        let s = b.rescan(&book.id);
        assert_eq!((s.added, s.updated, s.unchanged), (0, 1, 2));

        // 同一篇（id、位置不变），内容换新，笔记还在
        let now = b.doc("手册", "第一章");
        assert_eq!((now.id.as_str(), now.position), (first.id.as_str(), 0));
        assert_eq!(b.rev(&first.id), rev + 1);
        assert_eq!(b.found("火花塞"), 1);
        assert_eq!(b.found("锅炉"), 0);
        assert_eq!(b.book("手册").note_count, 1);
        assert_eq!(b.xray_count(&first.id), 0);
        // 别的篇原样
        assert_eq!(b.xray_count(&second.id), 1);
        assert_eq!(b.chunk_ids(&second.id), other_chunks);
        assert_eq!(b.rev(&second.id), 0);
    }

    #[test]
    fn 重新扫描_带着划线的文件改了名_还是同一篇_划线还在() {
        let b = Bench::new("rescan-rename");
        let book = b.manual();
        let doc = &book.docs[1];
        b.highlight(&doc.id, "h1");
        b.xray(&doc.id);

        std::fs::rename(b.path("手册/第二章.md"), b.path("手册/第二章 活塞.md")).unwrap();
        let s = b.rescan(&book.id);
        assert_eq!((s.added, s.updated, s.unchanged, s.missing), (0, 0, 3, 0));

        let now = b.book("手册");
        assert_eq!(now.docs.len(), 3);
        let renamed = &now.docs[1];
        assert_eq!(renamed.id, doc.id);
        assert_eq!(renamed.name, "第二章 活塞");
        assert!(!renamed.missing);
        assert_eq!(
            renamed.path.as_deref(),
            Some(b.path("手册/第二章 活塞.md").to_string_lossy().as_ref())
        );
        assert_eq!(now.note_count, 1);
        assert_eq!(b.xray_count(&doc.id), 1);
    }

    #[test]
    fn 重新扫描_文件删了_带划线的篇留着标成找不到_什么都没有的拿掉() {
        let b = Bench::new("rescan-gone");
        let book = b.manual();
        let (noted, plain) = (&book.docs[0], &book.docs[2]);
        b.highlight(&noted.id, "h1");
        // 有进度的也算「有东西」
        let read = &book.docs[1];
        db::save_reading_state(&b.conn.lock().unwrap(), &read.id, "loc", 0.5, None).unwrap();

        for name in ["第一章.md", "第二章.md", "第十章.md"] {
            std::fs::remove_file(b.path("手册").join(name)).unwrap();
        }
        b.write("手册/第三章.md", "第三章讲蒸汽机的气缸。");
        let s = b.rescan(&book.id);
        assert_eq!((s.added, s.missing), (1, 2), "{s:?}");

        let now = b.book("手册");
        let state: Vec<(&str, bool)> = now
            .docs
            .iter()
            .map(|d| (d.name.as_str(), d.missing))
            .collect();
        assert_eq!(
            state,
            vec![("第一章", true), ("第二章", true), ("第三章", false)]
        );
        assert_eq!(now.docs[0].id, noted.id);
        assert_eq!(now.note_count, 1);
        assert!(books::part(&b.conn.lock().unwrap(), &plain.id)
            .unwrap()
            .is_none());
        assert_eq!(b.found("飞轮"), 0);
        // 留下来的篇还按旧内容搜得到
        assert_eq!(b.found("锅炉"), 1);

        // 整个文件夹都找不到了（挪走了、盘没插上）：一篇都不删，全报成找不到
        std::fs::remove_dir_all(b.path("手册")).unwrap();
        let s = b.rescan(&book.id);
        assert_eq!(s.missing, 3);
        assert_eq!(b.book("手册").docs.len(), 3);
    }

    #[test]
    fn 从书里移除的篇_再扫描不会回来_点名加回来才算() {
        let b = Bench::new("excluded");
        let book = b.manual();
        let doc = &book.docs[1];
        books::delete_document(&mut b.conn.lock().unwrap(), &doc.id).unwrap();
        assert_eq!(b.names("手册"), vec!["第一章", "第十章"]);

        let s = b.rescan(&book.id);
        assert_eq!((s.added, s.unchanged), (0, 2));
        assert_eq!(b.names("手册"), vec!["第一章", "第十章"]);
        // 把整个文件夹再导入一次也一样
        let s = b.import(&[b.item("手册", Mode::Book)]);
        assert_eq!(s.added, 0);

        // 把上一级文件夹按「每个文件各算一本」拖进来，走到这个文件时也不收：
        // 它落在《手册》的目录里，而《手册》的主人移除过它
        let parent = ImportItem {
            path: b.root.to_string_lossy().to_string(),
            mode: Mode::Each,
            files: None,
        };
        let s = b.import(&[parent]);
        assert_eq!(s.added, 0, "{s:?}");
        assert_eq!(b.names("手册"), vec!["第一章", "第十章"]);

        // 用户单独把这个文件拖进来：加回到这本书里，以后扫描也认它
        let s = b.import(&[b.item("手册/第二章.md", Mode::Auto)]);
        assert_eq!(s.added, 1);
        assert_eq!(b.names("手册"), vec!["第一章", "第十章", "第二章"]);
        assert!(books::excluded(&b.conn.lock().unwrap(), &book.id)
            .unwrap()
            .is_empty());
        assert_eq!(b.rescan(&book.id).unchanged, 3);
    }

    #[test]
    fn 单独成书的文件被文件夹书并进来_对话和封面跟着走() {
        let b = Bench::new("absorb");
        b.write("项目/README.md", "这个项目是一个流程编排引擎。");
        b.write("项目/设计.md", "设计文档：调度器和执行器。");
        // 先单独导入 README：自己成一本
        let s = b.import(&[b.item("项目/README.md", Mode::Auto)]);
        assert_eq!(s.added, 1);
        let single = b.book("README");
        let doc_id = single.docs[0].id.clone();
        b.highlight(&doc_id, "h1");
        {
            let c = b.conn.lock().unwrap();
            db::upsert_session(&c, "s1", "聊 README", None, Some(&single.id)).unwrap();
            books::set_custom_cover(&c, &single.id, &[7, 7]).unwrap();
        }

        // 再把整个文件夹当一本书导入
        let s = b.import(&[b.item("项目", Mode::Book)]);
        assert_eq!((s.added, s.unchanged, s.failed.len()), (1, 1, 0), "{s:?}");
        let shelf = b.shelf();
        assert_eq!(shelf.len(), 1);
        let book = &shelf[0];
        assert_eq!(book.title, "项目");
        assert_eq!(b.names("项目"), vec!["README", "设计"]);
        // 文档还是那一份：id 不变，划线还在
        assert_eq!(book.docs[0].id, doc_id);
        assert_eq!(book.note_count, 1);
        // 对话改挂到新书下，书名快照也换了；上传的封面带过来了
        let sessions = db::list_sessions(&b.conn.lock().unwrap()).unwrap();
        assert_eq!(sessions[0].book_id.as_deref(), Some(book.id.as_str()));
        assert_eq!(sessions[0].book_title.as_deref(), Some("项目"));
        assert_eq!(book.session_count, 1);
        assert!(book.custom_cover);
        assert_eq!(
            books::cover(&b.conn.lock().unwrap(), &book.id).unwrap(),
            Some(vec![7, 7])
        );
    }

    #[test]
    fn 后来加的文件归到它所在文件夹的那本书里() {
        let b = Bench::new("join");
        b.write("项目/a.md", "甲文档。");
        b.write("项目/b.md", "乙文档。");
        // 从文件夹里挑两个文件合成一本：只收这两个，不扫描整个文件夹
        let files = vec![
            b.path("项目/a.md").to_string_lossy().to_string(),
            b.path("项目/b.md").to_string_lossy().to_string(),
        ];
        b.write("项目/c.md", "丙文档。");
        let s = b.import(&[ImportItem {
            files: Some(files),
            ..b.item("项目", Mode::Book)
        }]);
        assert_eq!(s.added, 2);
        let book = b.book("项目");
        assert_eq!(book.scan, Scan::None);
        assert_eq!(b.names("项目"), vec!["a", "b"]);
        // 没点名的 c.md 不会被扫描进来
        assert_eq!(b.rescan(&book.id).added, 0);

        // 之后单独拖进来的文件，在这个文件夹里（包括更深的子文件夹）的都归这本书
        b.write("项目/docs/深.md", "深处的文档。");
        b.write("别处/d.md", "丁文档。");
        let scanned = scan_paths(
            &b.conn,
            &[b.path("项目/c.md").to_string_lossy().to_string()],
        )
        .unwrap();
        assert_eq!(scanned[0].parent_book.as_ref().unwrap().id, book.id);
        let s = b.import(&[
            b.item("项目/c.md", Mode::Auto),
            b.item("项目/docs/深.md", Mode::Auto),
            b.item("别处/d.md", Mode::Auto),
        ]);
        assert_eq!(s.added, 3);
        assert_eq!(b.names("项目"), vec!["a", "b", "c", "深"]);
        assert_eq!(b.shelf().len(), 2);
        assert!(b.book("d").folder.is_none());
        assert_eq!(s.books.len(), 2);

        // 同一个文件再导入一次：原地更新，不会多出一篇
        let s = b.import(&[b.item("项目/c.md", Mode::Auto)]);
        assert_eq!((s.added, s.unchanged), (0, 1));
        // 这次明确要整个文件夹：扫描方式升级，没收过的文件都进来
        b.write("项目/e.md", "戊文档。");
        let s = b.import(&[b.item("项目", Mode::BookFlat)]);
        assert_eq!(s.added, 1);
        assert_eq!(b.book("项目").scan, Scan::Flat);
    }

    #[test]
    fn 已经在别的多篇书里的文件不动_在结果里说明() {
        let b = Bench::new("owned");
        b.write("项目/api/接口.md", "接口文档。");
        b.write("项目/api/错误码.md", "错误码表。");
        b.write("项目/README.md", "项目说明。");
        b.write("项目/指南.md", "使用指南。");
        // 里面的文件夹先成了一本书
        let s = b.import(&[b.item("项目/api", Mode::Book)]);
        assert_eq!(s.added, 2);
        let api = b.book("api");

        // 再把外面的文件夹整个当一本书导入：api 里的两篇已经有主了
        let s = b.import(&[b.item("项目", Mode::Book)]);
        assert_eq!(s.added, 2);
        assert_eq!(s.skipped, vec!["2 个文件已在《api》里"]);
        assert_eq!(b.names("项目"), vec!["README", "指南"]);
        assert_eq!(b.names("api"), vec!["接口", "错误码"]);

        // api 里新加的文件：外面那本书扫描时碰到了也让给 api（最里面的那本说了算）
        b.write("项目/api/鉴权.md", "鉴权方式。");
        let outer = b.book("项目");
        let s = b.rescan(&outer.id);
        assert_eq!(s.added, 1);
        assert_eq!(b.names("项目"), vec!["README", "指南"]);
        assert_eq!(b.names("api"), vec!["接口", "错误码", "鉴权"]);
        assert!(s.books.contains(&api.id));
        // api 的主人移除过的文件，外面那本书也不去捡
        let gone = b.doc("api", "鉴权");
        books::delete_document(&mut b.conn.lock().unwrap(), &gone.id).unwrap();
        let s = b.rescan(&outer.id);
        assert_eq!(s.added, 0);
        assert_eq!(b.names("项目"), vec!["README", "指南"]);
    }

    #[test]
    fn 各种导入方式_子文件夹各成一本_每个文件各成一本_只有一个文件的文件夹不算文件夹书() {
        let b = Bench::new("modes");
        b.write("书库/三体/上.txt", "上部：地球往事。");
        b.write("书库/三体/下.txt", "下部：死神永生。");
        b.write("书库/三体/中.txt", "中部：黑暗森林。");
        b.write("书库/独苗/唯一.md", "只有这一个文件。");
        b.write("书库/空的/图.png", "没有能导入的");
        b.write("书库/散页.md", "直接放在书库里的一页。");

        let scanned = scan_paths(&b.conn, &[b.path("书库").to_string_lossy().to_string()]).unwrap();
        let item = &scanned[0];
        assert!(item.is_dir && item.book_id.is_none() && !item.truncated);
        assert_eq!((item.direct, item.total), (1, 5));
        assert!(!item.self_contained);
        let subs: Vec<(&str, usize)> = item
            .subfolders
            .iter()
            .map(|s| (s.name.as_str(), s.total))
            .collect();
        assert_eq!(subs, vec![("三体", 3), ("独苗", 1)]);

        let s = b.import(&[b.item("书库", Mode::Subfolders)]);
        assert_eq!((s.added, s.failed.len()), (5, 0), "{s:?}");
        // 空的子文件夹不用特地说
        assert!(s.skipped.is_empty());
        assert_eq!(b.shelf().len(), 3);
        assert_eq!(b.names("三体"), vec!["上", "中", "下"]);
        assert_eq!(b.book("三体").scan, Scan::Deep);
        // 都是 TXT 的书默认防剧透
        assert!(b.book("三体").spoiler_free);
        assert!(b.book("唯一").folder.is_none());
        assert!(b.book("散页").folder.is_none());
        let again = scan_paths(
            &b.conn,
            &[b.path("书库/三体").to_string_lossy().to_string()],
        )
        .unwrap();
        assert_eq!(again[0].book_id, Some(b.book("三体").id));

        // 每个文件各成一本；文件夹没有别的方式说明时也是这样
        let b = Bench::new("modes-each");
        b.write("杂/a.md", "甲。");
        b.write("杂/深/b.md", "乙。");
        let s = b.import(&[b.item("杂", Mode::Each)]);
        assert_eq!(s.added, 2);
        assert!(b.shelf().iter().all(|book| book.folder.is_none()));
        // 用户选了空文件夹：说一声
        b.write("空/图.png", "x");
        let s = b.import(&[b.item("空", Mode::Book)]);
        assert_eq!(s.skipped, vec!["「空」里没有能导入的文件"]);
        assert_eq!(b.shelf().len(), 2);
    }

    #[test]
    fn 探查_只看不动_全是电子书的文件夹和太深的层数都认得出来() {
        let b = Bench::new("scan");
        // 探查只按扩展名数，不解析
        b.write("书/a.epub", "x");
        b.write("书/b.pdf", "x");
        b.write("书/漫画/c.cbz", "x");
        b.write("书/.隐藏/d.epub", "x");
        b.write("书/封面.jpg", "x");
        let deep = "深/1/2/3/4/5/6/7/8";
        b.write(&format!("{deep}/到不了.md"), "第九层");
        b.write("深/1/2/3/4/5/6/7/够得着.md", "第八层");
        let paths: Vec<String> = ["书", "深", "书/a.epub", "书/封面.jpg", "没有这个"]
            .iter()
            .map(|p| b.path(p).to_string_lossy().to_string())
            .collect();
        let items = scan_paths(&b.conn, &paths).unwrap();

        let shelf = &items[0];
        assert_eq!((shelf.name.as_str(), shelf.is_dir), ("书", true));
        assert_eq!((shelf.direct, shelf.total), (2, 3));
        assert!(shelf.self_contained && !shelf.truncated);
        assert_eq!(shelf.subfolders.len(), 1);
        assert_eq!(
            shelf.subfolders[0].path,
            b.path("书/漫画").to_string_lossy()
        );
        // 第八层的文件数得到；再往下的数不到，要说明有东西没数进来
        let deep = &items[1];
        assert_eq!((deep.direct, deep.total), (0, 1));
        assert!(deep.truncated && !deep.self_contained);

        assert_eq!((items[2].is_dir, items[2].kind), (false, Some("epub")));
        assert!(items[2].parent_book.is_none());
        assert_eq!(items[3].kind, None);
        assert_eq!((items[4].is_dir, items[4].kind), (false, None));
        // 什么都没建
        assert!(b.shelf().is_empty());
    }

    #[test]
    fn 重建索引_只动内容不动书架_文字没变的透视留着() {
        let b = Bench::new("reindex");
        let book = b.manual();
        let (kept, changed, gone) = (&book.docs[0], &book.docs[1], &book.docs[2]);
        for d in &book.docs {
            b.xray(&d.id);
        }
        b.highlight(&gone.id, "h1");
        b.write("手册/第二章.md", "第二章重写了：讲内燃机。");
        std::fs::remove_file(b.path("手册/第十章.md")).unwrap();
        b.write("手册/新来的.md", "重建索引不该把它收进来。");
        let old_chunks = b.chunk_ids(&kept.id);

        let s = reindex(&b.conn).unwrap();
        assert_eq!(s.imported, 2);
        assert_eq!(s.failed.len(), 1);
        assert!(s.failed[0].contains("第十章.md"));

        // 书架原样：还是三篇，顺序不变
        assert_eq!(b.names("手册"), vec!["第一章", "第二章", "第十章"]);
        // 片段都重写了（id 换了），文字没变的透视留着，变了的作废
        assert_ne!(b.chunk_ids(&kept.id), old_chunks);
        assert_eq!(b.xray_count(&kept.id), 1);
        assert_eq!(b.xray_count(&changed.id), 0);
        assert_eq!(b.found("内燃机"), 1);
        // 原文件没了的那篇保持原来的内容
        assert_eq!(b.xray_count(&gone.id), 1);
        assert_eq!(b.found("飞轮"), 1);
        assert_eq!(b.found("锅炉"), 1);
    }

    #[test]
    fn 文件夹挪了地方_重新指过去_各篇跟着换路径() {
        let b = Bench::new("relocate");
        let book = b.manual();
        b.highlight(&book.docs[0].id, "h1");
        std::fs::rename(b.path("手册"), b.path("手册（新位置）")).unwrap();
        assert!(b.book("手册").docs.iter().all(|d| d.missing));

        books::relocate(
            &mut b.conn.lock().unwrap(),
            &book.id,
            &b.path("手册（新位置）"),
        )
        .unwrap();
        refresh_parts(&b.conn, &book.id).unwrap();
        let now = b.book("手册");
        assert_eq!(
            now.folder.as_deref(),
            Some(b.path("手册（新位置）").to_string_lossy().as_ref())
        );
        assert!(now.docs.iter().all(|d| !d.missing));
        assert_eq!(now.docs[0].id, book.docs[0].id);
        assert_eq!(now.note_count, 1);
        assert_eq!(b.rescan(&book.id).unchanged, 3);

        // 单文件的书：指向另一个文件，内容跟着换
        let old = b.write("信.txt", "这是第一稿。");
        b.import(&[b.item("信.txt", Mode::Auto)]);
        let letter = b.book("信");
        std::fs::remove_file(old).unwrap();
        b.write("信（定稿）.txt", "这是定稿，改了措辞。");
        books::relocate(
            &mut b.conn.lock().unwrap(),
            &letter.id,
            &b.path("信（定稿）.txt"),
        )
        .unwrap();
        refresh_parts(&b.conn, &letter.id).unwrap();
        let now = b.book("信");
        assert_eq!(now.docs[0].id, letter.docs[0].id);
        assert!(!now.docs[0].missing);
        assert_eq!(now.docs[0].name, "信（定稿）");
        assert_eq!(b.found("定稿"), 1);
        // 已经在书架上的文件不能再指给另一本书
        assert!(books::relocate(
            &mut b.conn.lock().unwrap(),
            &letter.id,
            &b.path("手册（新位置）/第一章.md"),
        )
        .is_err());
    }

    #[test]
    fn 依赖和构建产物的目录不算进书里() {
        let dir = std::env::temp_dir().join(format!("docagent-skip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for sub in ["", "docs", "node_modules/pkg", "target/doc", ".git"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
            std::fs::write(dir.join(sub).join("README.md"), "# 说明\n\n正文").unwrap();
        }
        let found = walk(&dir, true);
        let mut names: Vec<String> = found
            .files
            .iter()
            .map(|p| p.strip_prefix(&dir).unwrap().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["README.md", "docs/README.md"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
