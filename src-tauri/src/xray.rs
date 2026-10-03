//! 透视：把一本书从头到尾读一遍，给每一部分留下要点、人物和概念。
//!
//! 读书时想知道「这个人是谁」「前面讲到哪了」，不用翻回去找，也不会被后面的情节剧透——
//! 每条记录都带着它在书里的位置，界面只显示用户已经读到的部分。
//!
//! 做法：按书里的顺序把文字分成一段一段（几千字一段），每段单独交给模型提取，
//! 几段并行。结果存库，下次打开直接用；文档重新导入后作废重来。

use crate::agent::Provider;
use crate::llm;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

/// 一段攒到这么多字就收：太短要点太碎，太长模型会漏东西
const UNIT_CHARS: usize = 4000;
const UNIT_MAX: usize = 9000;
const WORKERS: usize = 4;

/// 书里的一段：交给模型的最小单位
#[derive(Debug, Clone, PartialEq)]
pub struct Unit {
    pub index: i64,
    /// 这一段从第几页 / 第几节开始（PDF、EPUB 才有）
    pub page: Option<i64>,
    /// 这一段在全书里的起止位置（0-1），用来判断用户读没读到
    pub start: f64,
    pub end: f64,
    pub text: String,
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

#[derive(Debug, Serialize)]
pub struct UnitOut {
    pub unit: i64,
    pub page: Option<i64>,
    pub start: f64,
    pub end: f64,
    pub title: String,
    pub summary: String,
    pub entities: Vec<Entity>,
}

#[derive(Debug, Serialize)]
pub struct XRay {
    pub units: Vec<UnitOut>,
    /// 全书一共分成多少段；units 比它少说明还没做完
    pub total: i64,
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
    Ok(())
}

/// 按阅读顺序把一份文档的片段攒成段。有页码 / 章节的在页的边界上断开，
/// 所以每段都能说清楚「从第几页开始」。
pub fn units(conn: &Connection, doc_id: &str) -> Result<Vec<Unit>> {
    let mut stmt = conn.prepare("SELECT page, text FROM chunks WHERE doc_id = ?1 ORDER BY idx")?;
    let rows: Vec<(Option<i64>, String)> = stmt
        .query_map(params![doc_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let total = rows.len();
    // 电子书的「页」是章节：一章一段，要点才对得上章节，防剧透也按章算。
    // 只有特别短的（扉页、题记）才和后面的并在一起。PDF 的一页太碎，攒够几千字再断
    let kind: String = conn
        .query_row(
            "SELECT kind FROM docs WHERE id = ?1",
            params![doc_id],
            |r| r.get(0),
        )
        .unwrap_or_default();
    let enough = if kind == "epub" { 300 } else { UNIT_CHARS };
    let mut out: Vec<Unit> = Vec::new();
    let mut buf = String::new();
    let mut first = 0usize;
    let mut page: Option<i64> = None;
    let flush =
        |buf: &mut String, first: usize, upto: usize, page: Option<i64>, out: &mut Vec<Unit>| {
            if buf.trim().is_empty() {
                return;
            }
            out.push(Unit {
                index: out.len() as i64,
                page,
                start: first as f64 / total as f64,
                end: upto as f64 / total as f64,
                text: std::mem::take(buf),
            });
        };
    for (i, (p, text)) in rows.iter().enumerate() {
        let len = buf.chars().count();
        // 攒够了：有页码的等到换页再断，实在太长就不等了
        let page_turn = *p != rows.get(i.wrapping_sub(1)).and_then(|r| r.0) || p.is_none();
        if (len >= enough && page_turn) || len >= UNIT_MAX {
            flush(&mut buf, first, i, page, &mut out);
        }
        if buf.is_empty() {
            first = i;
            page = *p;
        } else {
            buf.push_str("\n\n");
        }
        buf.push_str(text);
    }
    flush(&mut buf, first, total, page, &mut out);
    Ok(out)
}

pub fn get(conn: &Connection, doc_id: &str) -> Result<XRay> {
    let total = units(conn, doc_id)?.len() as i64;
    let mut stmt = conn.prepare(
        "SELECT unit, page, start, end, title, summary, entities
         FROM xray_units WHERE doc_id = ?1 ORDER BY unit",
    )?;
    let rows = stmt.query_map(params![doc_id], |r| {
        let entities: String = r.get(6)?;
        Ok(UnitOut {
            unit: r.get(0)?,
            page: r.get(1)?,
            start: r.get(2)?,
            end: r.get(3)?,
            title: r.get(4)?,
            summary: r.get(5)?,
            entities: serde_json::from_str(&entities).unwrap_or_default(),
        })
    })?;
    Ok(XRay {
        units: rows.collect::<Result<_, _>>()?,
        total,
    })
}

pub fn clear(conn: &Connection, doc_id: &str) -> Result<()> {
    conn.execute("DELETE FROM xray_units WHERE doc_id = ?1", params![doc_id])?;
    Ok(())
}

const SYSTEM: &str = "你在帮读者给一本书做随读笔记。只输出一个 JSON 对象，不要解释，不要代码块。";

fn prompt(unit: &Unit, known: &[String]) -> String {
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
         \u{20}\u{20}desc（一句话，说这一段里关于它的新信息）、quote（原文里一字不差的一小段，10 到 30 个字，能体现它）\n\n\
         {known}【原文】\n{}",
        unit.text
    )
}

/// 把模型的回答整理成一条记录；字段缺了、类型不对都尽量救回来
fn parse(text: &str) -> Result<(String, String, Vec<Entity>)> {
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
    Ok((title, summary, entities))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub doc_id: String,
    pub done: i64,
    pub total: i64,
    pub error: Option<String>,
    pub finished: bool,
}

fn running() -> &'static Mutex<HashSet<String>> {
    static R: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    R.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 透视一本书：没做过的段交给模型，做过的跳过（中途失败或关掉应用，下次接着做）。
/// complete 是「给一段提示词、拿回一段文字」的函数，测试里换成假的。
pub fn build(
    conn: &Arc<Mutex<Connection>>,
    doc_id: &str,
    complete: impl Fn(&str, &str) -> Result<String> + Sync,
    on_progress: impl Fn(Progress) + Sync,
) {
    if !running()
        .lock()
        .map(|mut r| r.insert(doc_id.to_string()))
        .unwrap_or(false)
    {
        return; // 这本书已经在做了
    }
    let result = run(conn, doc_id, &complete, &on_progress);
    if let Ok(mut r) = running().lock() {
        r.remove(doc_id);
    }
    let (done, total) = conn
        .lock()
        .ok()
        .and_then(|c| get(&c, doc_id).ok())
        .map(|x| (x.units.len() as i64, x.total))
        .unwrap_or((0, 0));
    on_progress(Progress {
        doc_id: doc_id.to_string(),
        done,
        total,
        error: result.err().map(|e| e.to_string()),
        finished: true,
    });
}

fn run(
    conn: &Arc<Mutex<Connection>>,
    doc_id: &str,
    complete: &(impl Fn(&str, &str) -> Result<String> + Sync),
    on_progress: &(impl Fn(Progress) + Sync),
) -> Result<()> {
    let lock = || conn.lock().map_err(|_| anyhow::anyhow!("数据库锁异常"));
    let (todo, total, known) = {
        let c = lock()?;
        let all = units(&c, doc_id)?;
        let have = get(&c, doc_id)?;
        let done: HashSet<i64> = have.units.iter().map(|u| u.unit).collect();
        let known: Vec<String> = have
            .units
            .iter()
            .flat_map(|u| u.entities.iter().map(|e| e.name.clone()))
            .collect();
        let total = all.len() as i64;
        let todo: Vec<Unit> = all
            .into_iter()
            .filter(|u| !done.contains(&u.index))
            .collect();
        (todo, total, known)
    };
    if total == 0 {
        anyhow::bail!("这份文档没有可读的文字（扫描件或漫画），没法透视");
    }
    let queue = Mutex::new(todo.into_iter());
    // 已经见过的名字：后面的段沿用同样的称呼，同一个人不会变成两张卡片
    let known = Mutex::new(known);
    let first_error: Mutex<Option<anyhow::Error>> = Mutex::new(None);

    std::thread::scope(|scope| {
        for _ in 0..WORKERS {
            scope.spawn(|| loop {
                if first_error.lock().map(|e| e.is_some()).unwrap_or(true) {
                    return;
                }
                let Some(unit) = queue.lock().ok().and_then(|mut q| q.next()) else {
                    return;
                };
                let names: Vec<String> = known
                    .lock()
                    .map(|k| {
                        let mut seen = HashSet::new();
                        k.iter().filter(|n| seen.insert((*n).clone())).take(40).cloned().collect()
                    })
                    .unwrap_or_default();
                // 偶尔会返回一段解析不了的东西，或者接口抖一下：再试一次
                let attempt = || complete(SYSTEM, &prompt(&unit, &names)).and_then(|t| parse(&t));
                let outcome = attempt().or_else(|_| attempt());
                let saved = outcome.and_then(|(title, summary, entities)| {
                    if let Ok(mut k) = known.lock() {
                        k.extend(entities.iter().map(|e| e.name.clone()));
                    }
                    let c = lock()?;
                    c.execute(
                        "INSERT OR REPLACE INTO xray_units(doc_id, unit, page, start, end, title, summary, entities)
                         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                        params![
                            doc_id,
                            unit.index,
                            unit.page,
                            unit.start,
                            unit.end,
                            title,
                            summary,
                            serde_json::to_string(&entities)?
                        ],
                    )?;
                    let done: i64 = c.query_row(
                        "SELECT COUNT(*) FROM xray_units WHERE doc_id = ?1",
                        params![doc_id],
                        |r| r.get(0),
                    )?;
                    Ok(done)
                });
                match saved {
                    Ok(done) => on_progress(Progress {
                        doc_id: doc_id.to_string(),
                        done,
                        total,
                        error: None,
                        finished: false,
                    }),
                    Err(e) => {
                        if let Ok(mut slot) = first_error.lock() {
                            slot.get_or_insert(e);
                        }
                        return;
                    }
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
    use crate::db::{self, NewDoc, TextChunk};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn book(pages: &[(Option<i64>, usize)]) -> (Arc<Mutex<Connection>>, String) {
        book_of("pdf", pages)
    }

    fn book_of(
        kind: &'static str,
        pages: &[(Option<i64>, usize)],
    ) -> (Arc<Mutex<Connection>>, String) {
        let mut conn = db::open_in_memory().unwrap();
        let chunks: Vec<TextChunk> = pages
            .iter()
            .enumerate()
            .map(|(i, (page, len))| TextChunk {
                idx: i as i64,
                page: *page,
                text: format!("第{i}块{}", "字".repeat(*len)),
            })
            .collect();
        let id = db::import_document(
            &mut conn,
            &NewDoc {
                title: "书",
                path: "/b.epub",
                kind,
                pages: None,
                author: None,
                cover: None,
            },
            &chunks,
        )
        .unwrap();
        (Arc::new(Mutex::new(conn)), id)
    }

    #[test]
    fn 分段_在换页处断开_位置连续() {
        // 三页各 2500 字（每页两块）+ 一页短的
        let (conn, id) = book(&[
            (Some(1), 1250),
            (Some(1), 1250),
            (Some(2), 1250),
            (Some(2), 1250),
            (Some(3), 1250),
            (Some(3), 1250),
            (Some(4), 300),
        ]);
        let u = units(&conn.lock().unwrap(), &id).unwrap();
        // 前两页攒够 4000 字，在第 3 页开头断开
        assert_eq!(u.len(), 2);
        assert_eq!((u[0].page, u[1].page), (Some(1), Some(3)));
        assert_eq!(u[0].start, 0.0);
        assert_eq!(u[0].end, u[1].start);
        assert_eq!(u[1].end, 1.0);
        assert!(u[0].text.contains("第3块") && u[1].text.starts_with("第4块"));

        // 电子书一章一段；很短的扉页并到下一章里
        let (conn, id) = book_of(
            "epub",
            &[
                (Some(1), 40),
                (Some(2), 900),
                (Some(3), 900),
                (Some(3), 900),
            ],
        );
        let u = units(&conn.lock().unwrap(), &id).unwrap();
        assert_eq!(
            u.iter().map(|x| x.page).collect::<Vec<_>>(),
            vec![Some(1), Some(3)]
        );
        assert!(u[0].text.contains("第1块") && u[1].text.contains("第3块"));
    }

    #[test]
    fn 透视_逐段提取_做过的不重做_失败后能接着做() {
        let (conn, id) = book(&[(None, 4100), (None, 4100), (None, 4100)]);
        let calls = AtomicUsize::new(0);
        let failing = std::sync::atomic::AtomicBool::new(true);
        // 模拟模型：回答带代码块包装；接口坏着的时候第二段一直报错
        let answer = |_: &str, user: &str| -> Result<String> {
            calls.fetch_add(1, Ordering::SeqCst);
            if failing.load(Ordering::SeqCst) && user.contains("第1块") {
                anyhow::bail!("模型接口返回 500：boom");
            }
            Ok("```json\n{\"title\":\"小标题\",\"summary\":\"讲了一些事。\",\"entities\":[{\"name\":\"老陈\",\"type\":\"人物\",\"desc\":\"修相机的\",\"quote\":\"原文一小段\"},{\"name\":\"\",\"type\":\"人物\"}]}\n```".to_string())
        };

        let last = Mutex::new(None);
        build(&conn, &id, answer, |p| *last.lock().unwrap() = Some(p));
        let p = last.lock().unwrap().clone().unwrap();
        assert!(p.finished);
        assert!(p.error.as_deref().unwrap_or("").contains("500"), "{p:?}");
        let partial = get(&conn.lock().unwrap(), &id).unwrap();
        assert_eq!(partial.total, 3);
        assert!(partial.units.len() < 3);

        // 接口恢复后再点一次：只补没做的那段
        failing.store(false, Ordering::SeqCst);
        let before = calls.load(Ordering::SeqCst);
        build(&conn, &id, answer, |p| *last.lock().unwrap() = Some(p));
        let p = last.lock().unwrap().clone().unwrap();
        assert!(p.finished && p.error.is_none(), "{p:?}");
        assert_eq!((p.done, p.total), (3, 3));
        assert!(calls.load(Ordering::SeqCst) - before <= 2);

        let x = get(&conn.lock().unwrap(), &id).unwrap();
        assert_eq!(x.units[0].title, "小标题");
        // 没有名字的那条被丢掉了
        assert_eq!(x.units[0].entities.len(), 1);
        assert_eq!(x.units[0].entities[0].kind, "人物");

        // 全做完了再点：一次都不该再调模型
        let before = calls.load(Ordering::SeqCst);
        build(&conn, &id, answer, |_| {});
        assert_eq!(calls.load(Ordering::SeqCst), before);
    }

    #[test]
    fn 重新导入后透视作废() {
        let (conn, id) = book(&[(None, 4100)]);
        build(
            &conn,
            &id,
            |_, _| Ok(r#"{"title":"t","summary":"s","entities":[]}"#.into()),
            |_| {},
        );
        assert_eq!(get(&conn.lock().unwrap(), &id).unwrap().units.len(), 1);
        let mut c = conn.lock().unwrap();
        db::import_document(
            &mut c,
            &NewDoc {
                title: "书",
                path: "/b.epub",
                kind: "epub",
                pages: None,
                author: None,
                cover: None,
            },
            &[TextChunk {
                idx: 0,
                page: None,
                text: "换了内容".into(),
            }],
        )
        .unwrap();
        assert!(get(&c, &id).unwrap().units.is_empty());
    }
}
