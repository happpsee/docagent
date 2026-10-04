//! 透视：把一本书从头到尾读一遍，给每一部分留下要点、人物和概念。
//!
//! 读书时想知道「这个人是谁」「前面讲到哪了」，不用翻回去找，也不会被后面的情节剧透——
//! 每条记录都带着它在书里的位置，界面只显示用户已经读到的部分。
//!
//! 做法：按书里的顺序把文字分成一段一段（几千字一段），每段单独交给模型提取，
//! 几段并行。结果存库，下次打开直接用。
//!
//! 透视是按书做的：一本书有几篇就一篇接一篇往下做，人物的叫法在篇和篇之间也保持一致。
//! 结果还是挂在篇上（xray_units.doc_id）——哪一篇的文字变了只作废那一篇的，
//! 把几篇合成一本、把一本拆开，做过的都不用重来。

use crate::agent::Provider;
use crate::books;
use crate::llm;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// 一段攒到这么多字就收：太短要点太碎，太长模型会漏东西
const UNIT_CHARS: usize = 4000;
const UNIT_MAX: usize = 9000;
const WORKERS: usize = 4;
/// 每段带给模型多少个「前文出现过的名字」
const KNOWN_NAMES: usize = 40;

/// 一篇里的一段：交给模型的最小单位。这里只有位置，文字等真要做这一段时再取
#[derive(Debug, Clone, PartialEq)]
pub struct Unit {
    pub index: i64,
    /// 这一段从第几页 / 第几节开始（PDF、EPUB 才有）
    pub page: Option<i64>,
    /// 这一段在它那一篇里的起止位置（0-1），用来判断用户读没读到
    pub start: f64,
    pub end: f64,
    /// 这一段是那一篇的第几个片段到第几个片段（不含 upto）
    first: usize,
    upto: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct Entity {
    pub name: String,
    /// 人物 / 地点 / 机构 / 概念 / 物品 / 条款…
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub desc: String,
    /// 原文里的一小段，点了能跳过去
    #[serde(default)]
    pub quote: String,
}

/// 两个人物 / 概念之间的一条关系，关系图里的一条线
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct Relation {
    pub from: String,
    pub to: String,
    /// 几个字说清是什么关系：父子、雇佣、依赖、属于…
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitOut {
    /// 这一段属于哪一篇
    pub doc_id: String,
    /// 这一篇里的第几段
    pub unit: i64,
    pub page: Option<i64>,
    /// 这一段在它那一篇里的起止位置（0-1）
    pub start: f64,
    pub end: f64,
    pub title: String,
    pub summary: String,
    pub entities: Vec<Entity>,
    pub relations: Vec<Relation>,
}

#[derive(Debug, Serialize)]
pub struct XRay {
    /// 做好的段：按篇在书里的先后，同一篇里按段的先后
    pub units: Vec<UnitOut>,
    /// 全书一共分成多少段；units 比它少说明还没做完
    pub total: i64,
    /// 这本书现在是不是正在透视。界面换一篇会重建面板，得能问出来，不然会以为停了
    pub building: bool,
}

pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS xray_units (
            doc_id    TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
            unit      INTEGER NOT NULL,
            page      INTEGER,
            start     REAL NOT NULL,
            end       REAL NOT NULL,
            title     TEXT NOT NULL,
            summary   TEXT NOT NULL,
            entities  TEXT NOT NULL,
            PRIMARY KEY (doc_id, unit)
        );",
    )?;
    // 后来加的列：老库补上（已经有了会报重复，忽略）
    let _ = conn.execute(
        "ALTER TABLE xray_units ADD COLUMN relations TEXT NOT NULL DEFAULT '[]'",
        [],
    );
    Ok(())
}

/// 按阅读顺序把一篇的片段攒成段。有页码 / 章节的在页的边界上断开，
/// 所以每段都能说清楚「从第几页开始」。
///
/// 只看每个片段的页码和字数，不把文字取出来：界面每次打开透视面板都要问一遍
/// 「全书分多少段」，几百上千个片段的文字来回搬一趟就为了数个数，不值当。
/// kind 是这一篇的格式。
pub fn plan(conn: &Connection, doc_id: &str, kind: &str) -> Result<Vec<Unit>> {
    // 第三列：这个片段是不是只有空白（空格、制表、换行、全角空格）
    let mut stmt = conn.prepare(
        "SELECT page, length(text), trim(text, char(32, 9, 10, 13, 12288)) = ''
         FROM chunks WHERE doc_id = ?1 ORDER BY idx, id",
    )?;
    let rows: Vec<(Option<i64>, usize, bool)> = stmt
        .query_map(params![doc_id], |r| {
            Ok((r.get(0)?, r.get::<_, i64>(1)? as usize, r.get(2)?))
        })?
        .collect::<Result<_, _>>()?;
    let total = rows.len();
    // 电子书的「页」是章节：一章一段，要点才对得上章节，防剧透也按章算。
    // 只有特别短的（扉页、题记）才和后面的并在一起。PDF 的一页太碎，攒够几千字再断
    let enough = if kind == "epub" { 300 } else { UNIT_CHARS };
    let mut out: Vec<Unit> = Vec::new();
    // 正在攒的这一段：字数（片段之间接上时算两个换行）、是不是到现在都只有空白
    let (mut len, mut blank) = (0usize, true);
    let mut first = 0usize;
    let mut page: Option<i64> = None;
    for (i, (p, chars, is_blank)) in rows.iter().enumerate() {
        // 攒够了：有页码的等到换页再断，实在太长就不等了。只有空白的不成段，接着往下攒
        let page_turn = *p != rows.get(i.wrapping_sub(1)).and_then(|r| r.0) || p.is_none();
        if ((len >= enough && page_turn) || len >= UNIT_MAX) && !blank {
            out.push(Unit {
                index: out.len() as i64,
                page,
                start: first as f64 / total as f64,
                end: i as f64 / total as f64,
                first,
                upto: i,
            });
            (len, blank) = (0, true);
        }
        if len == 0 {
            first = i;
            page = *p;
        } else {
            len += 2;
        }
        len += chars;
        blank &= is_blank;
    }
    if !blank {
        out.push(Unit {
            index: out.len() as i64,
            page,
            start: first as f64 / total as f64,
            end: 1.0,
            first,
            upto: total,
        });
    }
    Ok(out)
}

/// 一段的文字：它那几个片段按顺序接起来
pub(crate) fn unit_text(conn: &Connection, doc_id: &str, unit: &Unit) -> Result<String> {
    let mut stmt = conn
        .prepare("SELECT text FROM chunks WHERE doc_id = ?1 ORDER BY idx, id LIMIT ?2 OFFSET ?3")?;
    let texts: Vec<String> = stmt
        .query_map(
            params![doc_id, (unit.upto - unit.first) as i64, unit.first as i64],
            |r| r.get(0),
        )?
        .collect::<Result<_, _>>()?;
    Ok(texts.join("\n\n"))
}

/// 一本书做好的段：按篇在书里的先后，同一篇里按段的先后
fn built(conn: &Connection, book_id: &str) -> Result<Vec<UnitOut>> {
    let mut stmt = conn.prepare(
        "SELECT u.doc_id, u.unit, u.page, u.start, u.end, u.title, u.summary, u.entities, u.relations
         FROM xray_units u JOIN docs d ON d.id = u.doc_id
         WHERE d.book_id = ?1
         ORDER BY d.position, d.created_at, d.rowid, u.unit",
    )?;
    let rows = stmt.query_map(params![book_id], |r| {
        let entities: String = r.get(7)?;
        let relations: String = r.get(8)?;
        Ok(UnitOut {
            doc_id: r.get(0)?,
            unit: r.get(1)?,
            page: r.get(2)?,
            start: r.get(3)?,
            end: r.get(4)?,
            title: r.get(5)?,
            summary: r.get(6)?,
            entities: serde_json::from_str(&entities).unwrap_or_default(),
            relations: serde_json::from_str(&relations).unwrap_or_default(),
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// 一本书的透视：做好的段，和全书一共多少段（各篇的段数加起来；没有文字的篇是 0）
pub fn get(conn: &Connection, book_id: &str) -> Result<XRay> {
    let mut total = 0i64;
    for part in books::parts(conn, book_id)? {
        total += plan(conn, &part.id, &part.kind)?.len() as i64;
    }
    Ok(XRay {
        units: built(conn, book_id)?,
        total,
        building: is_building(book_id),
    })
}

fn is_building(book_id: &str) -> bool {
    running()
        .lock()
        .map(|r| r.contains(book_id))
        .unwrap_or(false)
}

/// 这本书做好了多少段
fn done_count(conn: &Connection, book_id: &str) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM xray_units u JOIN docs d ON d.id = u.doc_id WHERE d.book_id = ?1",
        params![book_id],
        |r| r.get(0),
    )?)
}

/// 把一本书做过的透视清掉（各篇的都清）。
/// 正在透视的时候不让清：那一趟的任务清单是开始时排好的，清掉的段它不会补做，
/// 结果会缺一截还不报错
pub fn clear(conn: &Connection, book_id: &str) -> Result<()> {
    if is_building(book_id) {
        anyhow::bail!("这本书正在透视，等它做完再重新来");
    }
    conn.execute(
        "DELETE FROM xray_units WHERE doc_id IN (SELECT id FROM docs WHERE book_id = ?1)",
        params![book_id],
    )?;
    Ok(())
}

const SYSTEM: &str = "你在帮读者给一本书做随读笔记。只输出一个 JSON 对象，不要解释，不要代码块。";

fn prompt(text: &str, known: &[String]) -> String {
    let known = if known.is_empty() {
        String::new()
    } else {
        format!(
            "前文已经出现过这些名字，指的是同一个人或事物时沿用同样的写法：{}\n\n",
            known.join("、")
        )
    };
    format!(
        "下面是书里的一段。提取：\n\
         - title：给这一段起个小标题，12 个字以内\n\
         - summary：两三句话说清这一段讲了什么，只根据这一段，不要猜后文\n\
         - entities：这一段里值得记住的人物、地点、机构、概念、物品或条款，最多 6 个，宁缺毋滥，没有就给空数组。\n\
         \u{20}\u{20}只留读者之后会想回头查的：人物优先，其次是反复出现或对情节、论证起关键作用的东西；\n\
         \u{20}\u{20}随手一提的日用品、家具、普通场景不要。每个包含：\n\
         \u{20}\u{20}name（最常用的称呼）、type（人物/地点/机构/概念/物品/条款 之一）、\n\
         \u{20}\u{20}desc（一句话，说这一段里关于它的新信息）、quote（原文里一字不差的一小段，10 到 30 个字，能体现它）\n\
         - relations：这一段里明确写到的、上面这些（或前文出现过的名字）两两之间的关系，最多 5 条，没有就给空数组。\n\
         \u{20}\u{20}每条包含 from、to（都用 name 的写法）、label（6 个字以内，如 父子、上下级、依赖、属于、对立）；只写原文说了的，不要推测\n\n\
         {known}【原文】\n{text}"
    )
}

/// 把模型的回答整理成一条记录；字段缺了、类型不对都尽量救回来
fn parse(text: &str) -> Result<(String, String, Vec<Entity>, Vec<Relation>)> {
    let v = llm::json_object(text)?;
    let title = v["title"].as_str().unwrap_or("").trim().to_string();
    let summary = v["summary"].as_str().unwrap_or("").trim().to_string();
    if summary.is_empty() {
        anyhow::bail!("模型没给出要点");
    }
    let entities: Vec<Entity> = v["entities"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|e| serde_json::from_value::<Entity>(e.clone()).ok())
                .map(|mut e| {
                    e.name = e.name.trim().to_string();
                    e
                })
                .filter(|e| !e.name.is_empty() && e.name.chars().count() <= 24)
                .collect()
        })
        .unwrap_or_default();
    let relations: Vec<Relation> = v["relations"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|r| serde_json::from_value::<Relation>(r.clone()).ok())
                .map(|r| Relation {
                    from: r.from.trim().to_string(),
                    to: r.to.trim().to_string(),
                    label: r.label.trim().chars().take(8).collect(),
                })
                .filter(|r| !r.from.is_empty() && !r.to.is_empty() && r.from != r.to)
                .take(8)
                .collect()
        })
        .unwrap_or_default();
    Ok((title, summary, entities, relations))
}

/// 进度。透视是按书做的，界面按 bookId 认是不是自己正开着的那本
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub book_id: String,
    pub done: i64,
    pub total: i64,
    pub error: Option<String>,
    pub finished: bool,
}

fn running() -> &'static Mutex<HashSet<String>> {
    static R: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    R.get_or_init(|| Mutex::new(HashSet::new()))
}

fn cancelled() -> &'static Mutex<HashSet<String>> {
    static C: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 让正在给这本书做的透视停下来：书或其中一篇被移除时调（见 books::delete_book / delete_document）。
/// 没有在做就什么都不发生，所以不会误伤以后再开始的透视。
pub fn cancel(book_id: &str) {
    let is_running = running()
        .lock()
        .map(|r| r.contains(book_id))
        .unwrap_or(false);
    if is_running {
        if let Ok(mut c) = cancelled().lock() {
            c.insert(book_id.to_string());
        }
    }
}

fn is_cancelled(book_id: &str) -> bool {
    cancelled()
        .lock()
        .map(|c| c.contains(book_id))
        .unwrap_or(false)
}

/// 书里到目前为止出现过的名字，和各自被提到的次数
#[derive(Default)]
struct Names {
    /// 按第一次出现的先后
    seen: Vec<String>,
    mentions: HashMap<String, usize>,
}

impl Names {
    fn add(&mut self, name: &str) {
        match self.mentions.get_mut(name) {
            Some(n) => *n += 1,
            None => {
                self.seen.push(name.to_string());
                self.mentions.insert(name.to_string(), 1);
            }
        }
    }

    /// 提到次数最多的 n 个（次数一样的，先出现的在前）。
    /// 名单有限，留给主角和反复出现的东西：一本几十章的书里露过一面的名字成百上千，
    /// 按出现的先后取的话，名单会被第一章的路人占满，后面才登场的主角反而排不进去
    fn top(&self, n: usize) -> Vec<String> {
        let mut all: Vec<&String> = self.seen.iter().collect();
        all.sort_by_key(|name| std::cmp::Reverse(self.mentions[*name]));
        all.into_iter().take(n).cloned().collect()
    }
}

/// 排着队等着做的一段
struct Job {
    doc_id: String,
    /// 排队时这一篇的版本号。轮到它、做完要存的时候各对一次：对不上说明这一篇被重新导入过，
    /// 手上的分段是按旧文字算的，不能再用
    rev: i64,
    unit: Unit,
}

/// 一本书还有哪些段没做（按篇在书里的先后，同一篇里按段的先后排成一队）、
/// 全书一共多少段、做过的段里出现过哪些名字
fn pending(conn: &Connection, book_id: &str) -> Result<(Vec<Job>, i64, Names)> {
    let parts = books::parts(conn, book_id)?;
    if parts.is_empty() {
        anyhow::bail!("这本书已经不在书架上了");
    }
    let have = built(conn, book_id)?;
    let done: HashSet<(&str, i64)> = have.iter().map(|u| (u.doc_id.as_str(), u.unit)).collect();
    let mut names = Names::default();
    for e in have.iter().flat_map(|u| &u.entities) {
        names.add(&e.name);
    }
    let mut jobs = Vec::new();
    let mut total = 0i64;
    for part in &parts {
        // 没有文字的篇（漫画、扫描件）分不出段，自然就跳过了
        let units = plan(conn, &part.id, &part.kind)?;
        total += units.len() as i64;
        jobs.extend(
            units
                .into_iter()
                .filter(|u| !done.contains(&(part.id.as_str(), u.index)))
                .map(|unit| Job {
                    doc_id: part.id.clone(),
                    rev: part.rev,
                    unit,
                }),
        );
    }
    if total == 0 {
        anyhow::bail!("这本书没有可读的文字（扫描件或漫画），没法透视");
    }
    Ok((jobs, total, names))
}

/// 透视一本书：没做过的段交给模型，做过的跳过（中途失败或关掉应用，下次接着做）。
/// complete 是「给一段提示词、拿回一段文字」的函数，测试里换成假的。
pub fn build(
    conn: &Arc<Mutex<Connection>>,
    book_id: &str,
    complete: impl Fn(&str, &str) -> Result<String> + Sync,
    on_progress: impl Fn(Progress) + Sync,
) {
    if !running()
        .lock()
        .map(|mut r| r.insert(book_id.to_string()))
        .unwrap_or(false)
    {
        return; // 这本书已经在做了
    }
    let result = run(conn, book_id, &complete, &on_progress);
    if let Ok(mut r) = running().lock() {
        r.remove(book_id);
    }
    // 被叫停的（书或其中一篇被移除了）悄悄结束：那不是用户该看到的错
    let stopped = cancelled()
        .lock()
        .map(|mut c| c.remove(book_id))
        .unwrap_or(false);
    let (done, total) = conn
        .lock()
        .ok()
        .and_then(|c| get(&c, book_id).ok())
        .map(|x| (x.units.len() as i64, x.total))
        .unwrap_or((0, 0));
    on_progress(Progress {
        book_id: book_id.to_string(),
        done,
        total,
        error: result.err().filter(|_| !stopped).map(|e| e.to_string()),
        finished: true,
    });
}

fn run(
    conn: &Arc<Mutex<Connection>>,
    book_id: &str,
    complete: &(impl Fn(&str, &str) -> Result<String> + Sync),
    on_progress: &(impl Fn(Progress) + Sync),
) -> Result<()> {
    let lock = || conn.lock().map_err(|_| anyhow::anyhow!("数据库锁异常"));
    let (jobs, total, names) = pending(&*lock()?, book_id)?;
    let queue = Mutex::new(jobs.into_iter());
    // 已经见过的名字：后面的段沿用同样的称呼，同一个人不会变成两张卡片
    let names = Mutex::new(names);
    let first_error: Mutex<Option<anyhow::Error>> = Mutex::new(None);
    let fail = |e: anyhow::Error| {
        if let Ok(mut slot) = first_error.lock() {
            slot.get_or_insert(e);
        }
    };

    std::thread::scope(|scope| {
        for _ in 0..WORKERS {
            scope.spawn(|| loop {
                if first_error.lock().map(|e| e.is_some()).unwrap_or(true) || is_cancelled(book_id)
                {
                    return;
                }
                let Some(job) = queue.lock().ok().and_then(|mut q| q.next()) else {
                    return;
                };
                // 文字到这时才取。排队的这段时间里这一篇被重新导入或移除了：这一段不做了
                let text = lock().and_then(|c| {
                    let current: Option<i64> = c
                        .query_row(
                            "SELECT rev FROM docs WHERE id = ?1",
                            params![job.doc_id],
                            |r| r.get(0),
                        )
                        .ok();
                    if current != Some(job.rev) {
                        return Ok(None);
                    }
                    unit_text(&c, &job.doc_id, &job.unit).map(Some)
                });
                let text = match text {
                    Ok(Some(text)) => text,
                    Ok(None) => continue,
                    Err(e) => return fail(e),
                };
                let known = names
                    .lock()
                    .map(|n| n.top(KNOWN_NAMES))
                    .unwrap_or_default();
                // 偶尔会返回一段解析不了的东西，或者接口抖一下：再试一次
                let attempt = || complete(SYSTEM, &prompt(&text, &known)).and_then(|t| parse(&t));
                let outcome = attempt().or_else(|_| attempt());
                let saved = outcome.and_then(|(title, summary, entities, relations)| {
                    let c = lock()?;
                    // 模型想的这段时间里这一篇也可能变了或没了：只在版本号还对得上时才存
                    let kept = c.execute(
                        "INSERT OR REPLACE INTO xray_units(doc_id, unit, page, start, end, title, summary, entities, relations)
                         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10
                         WHERE EXISTS (SELECT 1 FROM docs WHERE id = ?1 AND rev = ?9)",
                        params![
                            job.doc_id,
                            job.unit.index,
                            job.unit.page,
                            job.unit.start,
                            job.unit.end,
                            title,
                            summary,
                            serde_json::to_string(&entities)?,
                            job.rev,
                            serde_json::to_string(&relations)?
                        ],
                    )?;
                    if kept == 0 {
                        return Ok(None);
                    }
                    Ok(Some((done_count(&c, book_id)?, entities)))
                });
                match saved {
                    Ok(Some((done, entities))) => {
                        if let Ok(mut n) = names.lock() {
                            for e in &entities {
                                n.add(&e.name);
                            }
                        }
                        on_progress(Progress {
                            book_id: book_id.to_string(),
                            done,
                            total,
                            error: None,
                            finished: false,
                        });
                    }
                    Ok(None) => {}
                    Err(e) => return fail(e),
                }
            });
        }
    });
    match first_error.into_inner().ok().flatten() {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// 用模型配置做出「提示词进、文字出」的函数
pub fn completer(p: Provider) -> impl Fn(&str, &str) -> Result<String> + Sync {
    move |system, user| llm::complete(&p, system, user, 1500)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::books::Scan;
    use crate::db::{self, NewDoc, TextChunk};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    const REPLY: &str = r#"{"title":"t","summary":"s","entities":[]}"#;
    /// 一篇的各个片段：(页码, 字数)
    type Pages = [(Option<i64>, usize)];
    /// 没有文字的一篇（漫画、扫描件）
    const NO_TEXT: &Pages = &[];

    /// 每个片段的文字是「<label>第 i 块」后面跟 len 个字
    fn chunks(label: &str, pages: &Pages) -> Vec<TextChunk> {
        pages
            .iter()
            .enumerate()
            .map(|(i, (page, len))| TextChunk {
                idx: i as i64,
                page: *page,
                text: format!("{label}第{i}块{}", "字".repeat(*len)),
            })
            .collect()
    }

    fn import(
        conn: &Arc<Mutex<Connection>>,
        path: &str,
        kind: &str,
        chunks: &[TextChunk],
    ) -> String {
        let title = path.rsplit('/').next().unwrap();
        let doc = NewDoc {
            title,
            path,
            kind,
            pages: None,
            author: None,
            cover: None,
        };
        db::import_document(&mut conn.lock().unwrap(), &doc, chunks).unwrap()
    }

    /// 一本单文件的书，返回 (库, 书 id, 那一篇的 id)
    fn book(pages: &Pages) -> (Arc<Mutex<Connection>>, String, String) {
        book_of("pdf", pages)
    }

    fn book_of(kind: &'static str, pages: &Pages) -> (Arc<Mutex<Connection>>, String, String) {
        let conn = Arc::new(Mutex::new(db::open_in_memory().unwrap()));
        let id = import(&conn, "/b.epub", kind, &chunks("", pages));
        let book = books::book_of(&conn.lock().unwrap(), &id).unwrap().unwrap();
        (conn, book, id)
    }

    /// 一本文件夹书（/s），每一项是 (文件名, 格式, 各片段)。片段文字以文件名开头。
    /// 返回 (库, 书 id, 各篇的 id)
    fn series(parts: &[(&str, &str, &Pages)]) -> (Arc<Mutex<Connection>>, String, Vec<String>) {
        let conn = Arc::new(Mutex::new(db::open_in_memory().unwrap()));
        let book = books::create_book(&conn.lock().unwrap(), "合集", None, Some("/s"), Scan::None)
            .unwrap();
        let ids = parts
            .iter()
            .map(|(name, kind, pages)| {
                import(&conn, &format!("/s/{name}"), kind, &chunks(name, pages))
            })
            .collect();
        (conn, book, ids)
    }

    /// 跑一遍透视，返回收到的所有进度
    fn run_build(
        conn: &Arc<Mutex<Connection>>,
        book: &str,
        complete: impl Fn(&str, &str) -> Result<String> + Sync,
    ) -> Vec<Progress> {
        let seen = Mutex::new(Vec::new());
        build(conn, book, complete, |p| seen.lock().unwrap().push(p));
        seen.into_inner().unwrap()
    }

    /// 做好的段：(哪一篇, 第几段)
    fn done(conn: &Arc<Mutex<Connection>>, book: &str) -> Vec<(String, i64)> {
        get(&conn.lock().unwrap(), book)
            .unwrap()
            .units
            .into_iter()
            .map(|u| (u.doc_id, u.unit))
            .collect()
    }

    #[test]
    fn 分段_在换页处断开_位置连续() {
        // 三页各 2500 字（每页两块）+ 一页短的
        let (conn, _, id) = book(&[
            (Some(1), 1250),
            (Some(1), 1250),
            (Some(2), 1250),
            (Some(2), 1250),
            (Some(3), 1250),
            (Some(3), 1250),
            (Some(4), 300),
        ]);
        let c = conn.lock().unwrap();
        let u = plan(&c, &id, "pdf").unwrap();
        // 前两页攒够 4000 字，在第 3 页开头断开
        assert_eq!(u.len(), 2);
        assert_eq!((u[0].page, u[1].page), (Some(1), Some(3)));
        assert_eq!(u[0].start, 0.0);
        assert_eq!(u[0].end, u[1].start);
        assert_eq!(u[1].end, 1.0);
        // 文字是做这一段时才取的，取到的正是这一段的那几块
        let text = |unit: &Unit| unit_text(&c, &id, unit).unwrap();
        assert!(text(&u[0]).starts_with("第0块") && text(&u[0]).contains("第3块"));
        assert!(!text(&u[0]).contains("第4块"));
        assert!(text(&u[1]).starts_with("第4块") && text(&u[1]).contains("第6块"));
        drop(c);

        // 电子书一章一段；很短的扉页并到下一章里
        let (conn, _, id) = book_of(
            "epub",
            &[
                (Some(1), 40),
                (Some(2), 900),
                (Some(3), 900),
                (Some(3), 900),
            ],
        );
        let c = conn.lock().unwrap();
        let u = plan(&c, &id, "epub").unwrap();
        assert_eq!(
            u.iter().map(|x| x.page).collect::<Vec<_>>(),
            vec![Some(1), Some(3)]
        );
        assert!(unit_text(&c, &id, &u[0]).unwrap().contains("第1块"));
        assert!(unit_text(&c, &id, &u[1]).unwrap().contains("第3块"));
    }

    #[test]
    fn 分段_只有空白的片段不单独成段_没有文字的篇分不出段() {
        let conn = Arc::new(Mutex::new(db::open_in_memory().unwrap()));
        let blank = |idx: i64| TextChunk {
            idx,
            page: None,
            text: " \n\u{3000}\t".repeat(2000),
        };
        let mut list = vec![blank(0)];
        list.extend(
            chunks("正文", &[(None, 4100), (None, 10)])
                .into_iter()
                .map(|mut c| {
                    c.idx += 1;
                    c
                }),
        );
        list.push(blank(3));
        let id = import(&conn, "/空白.md", "md", &list);
        let c = conn.lock().unwrap();
        let u = plan(&c, &id, "md").unwrap();
        // 开头那块空白攒够了字数也不成段，和后面的正文并在一起；结尾的空白并进最后一段
        assert_eq!(u.len(), 2);
        assert_eq!((u[0].start, u[0].end, u[1].end), (0.0, 0.5, 1.0));
        assert!(unit_text(&c, &id, &u[0]).unwrap().contains("正文第0块"));
        drop(c);

        let comic = import(&conn, "/漫画.cbz", "cbz", &[]);
        let all_blank = import(&conn, "/空.txt", "txt", &[blank(0), blank(1)]);
        let c = conn.lock().unwrap();
        assert!(plan(&c, &comic, "cbz").unwrap().is_empty());
        assert!(plan(&c, &all_blank, "txt").unwrap().is_empty());
    }

    #[test]
    fn 透视_逐段提取_做过的不重做_失败后能接着做() {
        let (conn, book, id) = book(&[(None, 4100), (None, 4100), (None, 4100)]);
        let calls = AtomicUsize::new(0);
        let failing = AtomicBool::new(true);
        // 模拟模型：回答带代码块包装；接口坏着的时候第二段一直报错
        let answer = |_: &str, user: &str| -> Result<String> {
            calls.fetch_add(1, Ordering::SeqCst);
            if failing.load(Ordering::SeqCst) && user.contains("第1块") {
                anyhow::bail!("模型接口返回 500：boom");
            }
            Ok("```json\n{\"title\":\"小标题\",\"summary\":\"讲了一些事。\",\"entities\":[{\"name\":\"老陈\",\"type\":\"人物\",\"desc\":\"修相机的\",\"quote\":\"原文一小段\"},{\"name\":\"\",\"type\":\"人物\"}]}\n```".to_string())
        };

        let seen = run_build(&conn, &book, answer);
        let p = seen.last().unwrap();
        assert!(p.finished);
        assert!(p.error.as_deref().unwrap_or("").contains("500"), "{p:?}");
        let partial = get(&conn.lock().unwrap(), &book).unwrap();
        assert_eq!(partial.total, 3);
        assert!(partial.units.len() < 3);

        // 接口恢复后再点一次：只补没做的那段
        failing.store(false, Ordering::SeqCst);
        let before = calls.load(Ordering::SeqCst);
        let seen = run_build(&conn, &book, answer);
        let p = seen.last().unwrap();
        assert!(p.finished && p.error.is_none(), "{p:?}");
        assert_eq!((p.done, p.total), (3, 3));
        assert!(calls.load(Ordering::SeqCst) - before <= 2);

        let x = get(&conn.lock().unwrap(), &book).unwrap();
        assert_eq!(x.units[0].title, "小标题");
        assert_eq!(x.units[0].doc_id, id);
        // 没有名字的那条被丢掉了
        assert_eq!(x.units[0].entities.len(), 1);
        assert_eq!(x.units[0].entities[0].kind, "人物");

        // 全做完了再点：一次都不该再调模型
        let before = calls.load(Ordering::SeqCst);
        build(&conn, &book, answer, |_| {});
        assert_eq!(calls.load(Ordering::SeqCst), before);

        // 清掉之后从头来
        clear(&conn.lock().unwrap(), &book).unwrap();
        let x = get(&conn.lock().unwrap(), &book).unwrap();
        assert_eq!((x.units.len(), x.total), (0, 3));
    }

    #[test]
    fn 多篇的书_一篇接一篇做_进度按整本书算_结果按篇的先后给() {
        let two: &Pages = &[(None, 4100), (None, 4100)];
        let (conn, book, ids) = series(&[("甲.md", "md", two), ("乙.md", "md", two)]);

        // 排的队：先是第一篇的各段，再是第二篇的
        let (jobs, total, _) = pending(&conn.lock().unwrap(), &book).unwrap();
        assert_eq!(total, 4);
        let order: Vec<(&str, i64)> = jobs
            .iter()
            .map(|j| (j.doc_id.as_str(), j.unit.index))
            .collect();
        assert_eq!(
            order,
            vec![
                (ids[0].as_str(), 0),
                (ids[0].as_str(), 1),
                (ids[1].as_str(), 0),
                (ids[1].as_str(), 1)
            ]
        );

        let nested = AtomicBool::new(false);
        let seen = run_build(&conn, &book, |_, user| {
            // 这本书正在做的时候再点一次：直接返回，不会两边同时做
            if !nested.swap(true, Ordering::SeqCst) {
                build(
                    &conn,
                    &book,
                    |_, _| panic!("不该再调模型"),
                    |_| panic!("不该有进度"),
                );
            }
            // 每一段拿到的是它自己那一篇的文字
            assert!(user.contains("甲.md第") != user.contains("乙.md第"));
            Ok(REPLY.to_string())
        });
        // 四段各报一次进度，最后一条是「做完了」；都记在书的名下，总数是整本书的
        assert_eq!(seen.len(), 5);
        assert!(seen.iter().all(|p| p.book_id == book && p.total == 4));
        let mut steps: Vec<i64> = seen[..4].iter().map(|p| p.done).collect();
        steps.sort();
        assert_eq!(steps, vec![1, 2, 3, 4]);
        assert!(seen[..4].iter().all(|p| !p.finished && p.error.is_none()));
        let last = &seen[4];
        assert!(last.finished && last.error.is_none());
        assert_eq!((last.done, last.total), (4, 4));
        let json = serde_json::to_value(last).unwrap();
        assert_eq!(json["bookId"], book.as_str());

        let want = |a: usize, b: usize| {
            vec![
                (ids[a].clone(), 0),
                (ids[a].clone(), 1),
                (ids[b].clone(), 0),
                (ids[b].clone(), 1),
            ]
        };
        assert_eq!(done(&conn, &book), want(0, 1));
        let x = get(&conn.lock().unwrap(), &book).unwrap();
        // 位置是每一段在它那一篇里的位置，不是在全书里的
        assert_eq!((x.units[2].start, x.units[3].end), (0.0, 1.0));
        let json = serde_json::to_value(&x).unwrap();
        assert_eq!(json["units"][2]["docId"], ids[1].as_str());
        assert_eq!(json["total"], 4);

        // 调了篇的顺序，结果跟着新的顺序排
        books::move_part(&mut conn.lock().unwrap(), &ids[1], -1).unwrap();
        assert_eq!(done(&conn, &book), want(1, 0));

        // 拆成两本：各自的透视都还在，不用重做
        books::split_book(&mut conn.lock().unwrap(), &book).unwrap();
        let own = books::book_of(&conn.lock().unwrap(), &ids[0])
            .unwrap()
            .unwrap();
        let x = get(&conn.lock().unwrap(), &own).unwrap();
        assert_eq!((x.units.len(), x.total), (2, 2));
        build(&conn, &own, |_, _| panic!("做过的不该重做"), |_| {});
    }

    #[test]
    fn 没有文字的篇跳过_整本都没有文字才报错() {
        let text: &Pages = &[(None, 4100)];
        let (conn, book, ids) = series(&[
            ("上.md", "md", text),
            ("插图.cbz", "cbz", NO_TEXT),
            ("下.md", "md", text),
        ]);
        let seen = run_build(&conn, &book, |_, _| Ok(REPLY.to_string()));
        let p = seen.last().unwrap();
        assert!(p.finished && p.error.is_none(), "{p:?}");
        assert_eq!((p.done, p.total), (2, 2));
        assert_eq!(
            done(&conn, &book),
            vec![(ids[0].clone(), 0), (ids[2].clone(), 0)]
        );

        // 整本都是漫画：做不了，说清楚原因
        let (conn, book, _) = series(&[("一.cbz", "cbz", NO_TEXT), ("二.cbz", "cbz", NO_TEXT)]);
        let seen = run_build(&conn, &book, |_, _| panic!("没有文字不该调模型"));
        assert_eq!(seen.len(), 1);
        let p = &seen[0];
        assert!(p.finished && (p.done, p.total) == (0, 0));
        assert!(
            p.error.as_deref().unwrap().contains("没有可读的文字"),
            "{p:?}"
        );

        // 书已经不在了
        let seen = run_build(&conn, "没有这本书", |_, _| panic!("不该调模型"));
        assert!(seen[0].error.as_deref().unwrap().contains("不在书架上"));
    }

    #[test]
    fn 一篇被重新导入_只作废它自己的_做到一半时也一样() {
        let two: &Pages = &[(None, 4100), (None, 4100)];
        let (conn, book, ids) = series(&[("甲.md", "md", two), ("乙.md", "md", two)]);
        let reimport = |name: &str, text: &str| {
            let fresh = [TextChunk {
                idx: 0,
                page: None,
                text: text.to_string(),
            }];
            import(&conn, &format!("/s/{name}"), "md", &fresh)
        };

        // 做完之后第一篇换了内容：它的两段作废，第二篇的留着
        run_build(&conn, &book, |_, _| Ok(REPLY.to_string()));
        assert_eq!(done(&conn, &book).len(), 4);
        assert_eq!(reimport("甲.md", "甲换了内容"), ids[0]);
        assert_eq!(
            done(&conn, &book),
            vec![(ids[1].clone(), 0), (ids[1].clone(), 1)]
        );
        let x = get(&conn.lock().unwrap(), &book).unwrap();
        assert_eq!(x.total, 3);

        // 清掉重做。做到第二篇的时候它被重新导入了：按旧文字做出来的那几段不能留
        clear(&conn.lock().unwrap(), &book).unwrap();
        let swapped = AtomicBool::new(false);
        let seen = run_build(&conn, &book, |_, user| {
            if user.contains("乙.md第") && !swapped.swap(true, Ordering::SeqCst) {
                reimport("乙.md", "乙也换了内容");
            }
            Ok(REPLY.to_string())
        });
        let p = seen.last().unwrap();
        assert!(p.finished && p.error.is_none(), "{p:?}");
        // 第一篇的照常做完了；第二篇一段都没留下（新内容的那一段还没做）
        assert_eq!(done(&conn, &book), vec![(ids[0].clone(), 0)]);
        assert_eq!((p.done, p.total), (1, 2));

        // 再点一次：只补第二篇新内容的那一段
        let calls = AtomicUsize::new(0);
        let seen = run_build(&conn, &book, |_, user| {
            calls.fetch_add(1, Ordering::SeqCst);
            assert!(user.contains("乙也换了内容"));
            Ok(REPLY.to_string())
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let p = seen.last().unwrap();
        assert_eq!((p.done, p.total, p.error.clone()), (2, 2, None));
    }

    #[test]
    fn 被叫停的透视悄悄结束_之后还能重新开始() {
        let pages: Vec<(Option<i64>, usize)> = (0..12).map(|_| (None, 4100)).collect();
        let (conn, book, _) = book(&pages);
        // 没在做的时候叫停：什么都不发生
        cancel(&book);
        // 第一段刚交给模型就被叫停了
        let seen = run_build(&conn, &book, |_, _| {
            cancel(&book);
            Ok(REPLY.to_string())
        });
        let p = seen.last().unwrap();
        assert!(p.finished && p.error.is_none(), "{p:?}");
        let x = get(&conn.lock().unwrap(), &book).unwrap();
        assert_eq!(x.total, 12);
        assert!(x.units.len() <= WORKERS, "叫停之后不该再接着做");

        let seen = run_build(&conn, &book, |_, _| Ok(REPLY.to_string()));
        let p = seen.last().unwrap();
        assert_eq!((p.done, p.total), (12, 12));
    }

    #[test]
    fn 移除书或其中一篇_正在做的透视停下来_不报错() {
        let six: Vec<(Option<i64>, usize)> = (0..6).map(|_| (None, 4100)).collect();
        let (conn, book, ids) = series(&[("甲.md", "md", &six[..]), ("乙.md", "md", &six[..])]);
        assert_eq!(get(&conn.lock().unwrap(), &book).unwrap().total, 12);

        // 刚开始做，第二篇就被移除了（Once：别的线程等移除完了才往下走，结果才是确定的）
        let removed = std::sync::Once::new();
        let calls = AtomicUsize::new(0);
        let seen = run_build(&conn, &book, |_, _| {
            calls.fetch_add(1, Ordering::SeqCst);
            removed.call_once(|| {
                books::delete_document(&mut conn.lock().unwrap(), &ids[1]).unwrap();
            });
            Ok(REPLY.to_string())
        });
        let p = seen.last().unwrap();
        assert!(p.finished && p.error.is_none(), "{p:?}");
        // 已经交出去的那几段做完就停，不会把剩下的都做了
        assert!(calls.load(Ordering::SeqCst) <= WORKERS);
        assert!(p.done <= WORKERS as i64 && p.total == 6, "{p:?}");
        assert!(done(&conn, &book).iter().all(|(doc, _)| *doc == ids[0]));

        // 之后再点：剩下的那一篇接着做完
        let seen = run_build(&conn, &book, |_, _| Ok(REPLY.to_string()));
        let p = seen.last().unwrap();
        assert_eq!((p.done, p.total, p.error.clone()), (6, 6, None));

        // 做的时候整本书被移除了：悄悄结束
        clear(&conn.lock().unwrap(), &book).unwrap();
        let removed = std::sync::Once::new();
        let seen = run_build(&conn, &book, |_, _| {
            removed.call_once(|| {
                books::delete_book(&mut conn.lock().unwrap(), &book, false).unwrap();
            });
            Ok(REPLY.to_string())
        });
        let p = seen.last().unwrap();
        assert!(p.finished && p.error.is_none(), "{p:?}");
        assert_eq!((p.done, p.total), (0, 0));
        let left: i64 = conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM xray_units", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn 带给模型的名字_取提到次数最多的四十个() {
        let mut names = Names::default();
        // 五十个只露过一面的路人，然后才是反复出现的两位主角
        for i in 0..50 {
            names.add(&format!("路人{i}"));
        }
        for _ in 0..3 {
            names.add("老陈");
        }
        names.add("小满");
        names.add("小满");
        let top = names.top(KNOWN_NAMES);
        assert_eq!(top.len(), 40);
        assert_eq!((top[0].as_str(), top[1].as_str()), ("老陈", "小满"));
        // 次数一样的按先出现的排
        assert_eq!((top[2].as_str(), top[39].as_str()), ("路人0", "路人37"));

        // 做过的段里的名字接着算数：第二次做的时候，提示词里带着前面出现过的
        let (conn, book, _) = book(&[(None, 4100), (None, 4100)]);
        let first = AtomicBool::new(true);
        let failing = |_: &str, user: &str| -> Result<String> {
            if user.contains("第1块") {
                anyhow::bail!("先只做第一段");
            }
            assert!(first.swap(false, Ordering::SeqCst));
            assert!(!user.contains("前文已经出现过"));
            Ok(r#"{"title":"t","summary":"s","entities":[{"name":"老陈","type":"人物"}]}"#.into())
        };
        run_build(&conn, &book, failing);
        let seen = run_build(&conn, &book, |_, user| {
            assert!(user.contains("前文已经出现过这些名字") && user.contains("老陈"));
            Ok(REPLY.to_string())
        });
        assert_eq!(seen.last().unwrap().done, 2);
    }

    #[test]
    fn 重新导入后透视作废() {
        let (conn, book, id) = book(&[(None, 4100)]);
        build(&conn, &book, |_, _| Ok(REPLY.into()), |_| {});
        assert_eq!(get(&conn.lock().unwrap(), &book).unwrap().units.len(), 1);
        let fresh = [TextChunk {
            idx: 0,
            page: None,
            text: "换了内容".into(),
        }];
        assert_eq!(import(&conn, "/b.epub", "epub", &fresh), id);
        assert!(get(&conn.lock().unwrap(), &book).unwrap().units.is_empty());
    }
}
