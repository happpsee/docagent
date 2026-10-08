//! 给 sidecar 用的本地接口。
//!
//! agent 的工具（检索、保存）在 sidecar 进程里被调用，但索引和文件在 Rust 这边，
//! 所以开一个只绑 127.0.0.1 的 HTTP 接口给它调。端口随机，带一次性 token：
//! 同机其它程序即使扫到端口，没有 token 也调不了。

use crate::db;
use crate::spoiler::{self, Bound, Live};
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Method, Response, Server};

// 请求体都不认多余的字段：sidecar 和这边是分开改的，哪边的字段名写错了、
// 或者还在送旧版的字段，当场报错，好过悄悄按「没传」处理（防剧透会因此整个失效）。

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchReq {
    query: String,
    /// 限定在这几篇里找；null 是整个书架
    doc_ids: Option<Vec<String>>,
    k: Option<usize>,
    /// 阅读器此刻的位置；没开着书是 null。哪本书要防剧透、读到哪了由这边按库里的记录算
    live: Option<Live>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SectionReq {
    doc_id: String,
    /// 要读第几页 / 第几节；null 是「当前位置所在的那一节」，位置也没给就从头
    page: Option<i64>,
    /// 当前读到这一篇的几分之几（没有页码的格式靠它定位）
    fraction: Option<f64>,
    live: Option<Live>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnnotationsReq {
    doc_ids: Option<Vec<String>>,
    /// 只要这本书上的；null 不按书限定
    book_id: Option<String>,
}

/// 助手对「我的画像」的读写：list 列出来，remember 记一条（带 id 是改写那一条），forget 删一条
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemoryReq {
    op: String,
    id: Option<i64>,
    kind: Option<String>,
    content: Option<String>,
    evidence: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveReq {
    filename: String,
    content: String,
}

pub struct LocalApi {
    pub port: u16,
    pub token: String,
}

pub fn start(conn: Arc<Mutex<Connection>>, save_dir: PathBuf) -> Result<LocalApi> {
    let server =
        Server::http("127.0.0.1:0").map_err(|e| anyhow::anyhow!("本地接口启动失败：{e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| anyhow::anyhow!("拿不到端口"))?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let expected = format!("Bearer {token}");

    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let authed = req
                .headers()
                .iter()
                .any(|h| h.field.equiv("Authorization") && h.value.as_str() == expected);
            if !authed {
                let _ = req.respond(Response::from_string("unauthorized").with_status_code(401));
                continue;
            }
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);

            let result: Result<serde_json::Value> = match (req.method(), req.url()) {
                (Method::Post, "/search") => handle_search(&conn, &body),
                (Method::Post, "/save") => handle_save(&save_dir, &body),
                (Method::Post, "/annotations") => handle_annotations(&conn, &body),
                (Method::Post, "/memory") => handle_memory(&conn, &body),
                (Method::Post, "/section") => handle_section(&conn, &body),
                _ => Err(anyhow::anyhow!("未知接口")),
            };
            let (code, payload) = match result {
                Ok(v) => (200, v),
                Err(e) => (400, serde_json::json!({ "error": e.to_string() })),
            };
            let header =
                Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
            let _ = req.respond(
                Response::from_string(payload.to_string())
                    .with_status_code(code)
                    .with_header(header),
            );
        }
    });

    Ok(LocalApi { port, token })
}

fn handle_search(conn: &Arc<Mutex<Connection>>, body: &str) -> Result<serde_json::Value> {
    let req: SearchReq = serde_json::from_str(body)?;
    let (hits, bounded) = crate::search::hybrid_noting(
        conn,
        &req.query,
        req.k.unwrap_or(6),
        req.doc_ids.as_deref(),
        req.live.as_ref(),
    )?;
    // bounded：范围里有书开着防剧透、只搜了读过的部分。助手得知道，不然会把搜不到当成书里没有
    Ok(serde_json::json!({ "hits": hits, "bounded": bounded }))
}

/// 用户在阅读器里划的高亮和写的笔记，给 agent 看。按书里篇的先后排
fn handle_annotations(conn: &Arc<Mutex<Connection>>, body: &str) -> Result<serde_json::Value> {
    let req: AnnotationsReq = serde_json::from_str(body)?;
    let conn = conn.lock().map_err(|_| anyhow::anyhow!("数据库锁异常"))?;
    let list = db::list_annotations(&conn, req.doc_ids.as_deref(), req.book_id.as_deref())?;
    Ok(serde_json::json!({ "annotations": list }))
}

fn handle_memory(conn: &Arc<Mutex<Connection>>, body: &str) -> Result<serde_json::Value> {
    let req: MemoryReq = serde_json::from_str(body)?;
    let conn = conn.lock().map_err(|_| anyhow::anyhow!("数据库锁异常"))?;
    match req.op.as_str() {
        "list" => Ok(serde_json::json!({ "notes": crate::learn::notes(&conn)? })),
        "remember" => {
            let kind = req.kind.unwrap_or_default();
            if !crate::learn::NOTE_KINDS.contains(&kind.as_str()) {
                anyhow::bail!("kind 只能是 {} 之一", crate::learn::NOTE_KINDS.join(" / "));
            }
            let content: String = req
                .content
                .unwrap_or_default()
                .trim()
                .chars()
                .take(300)
                .collect();
            if content.is_empty() {
                anyhow::bail!("内容是空的");
            }
            let evidence: String = req
                .evidence
                .unwrap_or_default()
                .trim()
                .chars()
                .take(200)
                .collect();
            let id =
                crate::learn::agent_note(&conn, req.id, &kind, &content, &evidence, db::now())?;
            Ok(serde_json::json!({ "id": id }))
        }
        "forget" => {
            crate::learn::delete_note(&conn, req.id.ok_or_else(|| anyhow::anyhow!("要给出编号"))?)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        other => anyhow::bail!("不认识的操作：{other}"),
    }
}

/// 保存到固定目录下，文件名去掉路径成分——agent 给的名字不能决定写到哪
fn handle_save(save_dir: &std::path::Path, body: &str) -> Result<serde_json::Value> {
    let req: SaveReq = serde_json::from_str(body)?;
    let name = sanitize_filename(&req.filename);
    std::fs::create_dir_all(save_dir)?;
    let path = free_path(save_dir, &name);
    std::fs::write(&path, req.content)?;
    Ok(serde_json::json!({ "path": path.to_string_lossy() }))
}

/// 同名文件已经在了就加序号（总结.md → 总结 (2).md），不覆盖用户已有的东西
fn free_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// 一节最多给模型这么多字
const SECTION_CHARS: usize = 12_000;
/// 不分节的文档一次给多少个片段
const WINDOW: i64 = 14;

#[derive(Debug, Serialize, PartialEq)]
struct Section {
    text: String,
    /// 实际给的是第几页 / 第几节；不分节的文档是 null
    page: Option<i64>,
    /// 这一节太长，只给了前一部分
    truncated: bool,
    /// 用户还没读到那里（这本书开着防剧透），一个字都没给
    blocked: bool,
}

impl Section {
    fn of(text: String, page: Option<i64>) -> Section {
        let truncated = text.chars().count() > SECTION_CHARS;
        Section {
            text: if truncated {
                text.chars().take(SECTION_CHARS).collect()
            } else {
                text
            },
            page,
            truncated,
            blocked: false,
        }
    }

    fn blocked(page: Option<i64>) -> Section {
        Section {
            text: String::new(),
            page,
            truncated: false,
            blocked: true,
        }
    }
}

fn handle_section(conn: &Arc<Mutex<Connection>>, body: &str) -> Result<serde_json::Value> {
    let req: SectionReq = serde_json::from_str(body)?;
    let conn = conn.lock().map_err(|_| anyhow::anyhow!("数据库锁异常"))?;
    Ok(serde_json::to_value(section(&conn, &req)?)?)
}

/// 读一篇里的一节：把那一节的片段按顺序接起来（片段之间有重叠，这里不去重，给模型读没有影响）。
///
/// - 分节的（PDF 的一页、电子书的一章）：给指定的那一节；没指定就给当前位置所在的那一节，
///   位置也没有（读的是没开着的另一篇）就从第一节读起。
/// - 不分节的（Markdown、TXT、MOBI…）：按位置取一段，请求里的 page 不管用。
///
/// 防剧透的界线在这里也算数（和检索是同一条规则）：要读的地方用户还没读到，就一个字不给。
fn section(conn: &Connection, req: &SectionReq) -> Result<Section> {
    let doc_id = req.doc_id.as_str();
    let bound = spoiler::bound_of(conn, doc_id, req.live.as_ref())?;
    // COUNT(page) 只数有页码的：一个都没有就是不分节的文档
    let (total, paged): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COUNT(page) FROM chunks WHERE doc_id = ?1",
        params![doc_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    // 当前位置落在第几个片段上
    let at = req
        .fraction
        .filter(|f| f.is_finite())
        .map(|f| (f.clamp(0.0, 1.0) * total as f64) as i64);
    if paged == 0 {
        return window(conn, doc_id, bound, at, total);
    }

    let page = match req.page {
        Some(p) => Some(p),
        None => conn
            .query_row(
                "SELECT page FROM chunks
                 WHERE doc_id = ?1 AND page IS NOT NULL AND idx >= ?2
                 ORDER BY idx LIMIT 1",
                params![doc_id, at.unwrap_or(0).min(total - 1)],
                |r| r.get(0),
            )
            .ok(),
    };
    let Some(page) = page else {
        return Ok(Section::of(String::new(), None));
    };
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT idx, text FROM chunks WHERE doc_id = ?1 AND page = ?2 ORDER BY idx")?;
        let rows = stmt.query_map(params![doc_id, page], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let readable: Vec<&str> = rows
        .iter()
        .filter(|(idx, _)| bound.allows(Some(page), *idx, total))
        .map(|(_, text)| text.as_str())
        .collect();
    let beyond = match bound {
        Bound::Open => false,
        Bound::Blocked => true,
        // 知道读到第几页：直接比页码，那一页上有没有文字都一样
        Bound::UpTo {
            page: Some(limit), ..
        } => page > limit,
        // 只知道读到几分之几（老记录）：这一节有文字、却一块都还没读到，才算没读到
        Bound::UpTo { page: None, .. } => !rows.is_empty() && readable.is_empty(),
    };
    if beyond {
        return Ok(Section::blocked(Some(page)));
    }
    Ok(Section::of(readable.join("\n\n"), Some(page)))
}

/// 不分节的文档按位置取一段。
///
/// 平时是从当前位置往后读（往前带两块、往后十来块）：用户问「这部分讲了什么」，要的是眼前和接下来的。
/// 开了防剧透就反过来，这一段到读到的地方为止：往后的还没读，能给的只有读过的这一截。
fn window(
    conn: &Connection,
    doc_id: &str,
    bound: Bound,
    at: Option<i64>,
    total: i64,
) -> Result<Section> {
    let texts: Vec<String> = match bound {
        Bound::Blocked => return Ok(Section::blocked(None)),
        Bound::Open => {
            let mut stmt = conn.prepare(
                "SELECT text FROM chunks WHERE doc_id = ?1 AND idx >= ?2 ORDER BY idx LIMIT ?3",
            )?;
            let from = (at.unwrap_or(0) - 2).max(0);
            let rows = stmt.query_map(params![doc_id, from, WINDOW], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        }
        Bound::UpTo { fraction, .. } => {
            // 读到过的最远处；当前位置在它前面（翻回去重看）就到当前位置为止
            let read = Bound::last_idx(fraction, total);
            let upto = at.map_or(read, |at| at.min(read));
            let mut stmt = conn.prepare(
                "SELECT text FROM chunks WHERE doc_id = ?1 AND idx <= ?2 ORDER BY idx DESC LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![doc_id, upto, WINDOW], |r| r.get(0))?;
            let mut texts: Vec<String> = rows.collect::<Result<_, _>>()?;
            texts.reverse();
            // 太长的话从前面丢：离读到的地方最近的那几块最要紧
            let mut size: usize = texts.iter().map(|t| t.chars().count() + 2).sum();
            let mut skip = 0;
            while size > SECTION_CHARS && skip + 1 < texts.len() {
                size -= texts[skip].chars().count() + 2;
                skip += 1;
            }
            texts.split_off(skip)
        }
    };
    Ok(Section::of(texts.join("\n\n"), None))
}

pub fn sanitize_filename(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let cleaned: String = base
        .chars()
        .filter(|c| !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'))
        .collect();
    let cleaned = cleaned.trim_start_matches('.').trim().to_string();
    if cleaned.is_empty() {
        "note.md".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::books::{self, Scan};
    use crate::db::{NewDoc, TextChunk};

    fn library() -> Arc<Mutex<Connection>> {
        Arc::new(Mutex::new(db::open_in_memory().unwrap()))
    }

    /// 导入一篇。pages 是每个片段的页码（不分节的给 None），片段的文字是「<名字>第 i 块」
    fn add(
        conn: &Arc<Mutex<Connection>>,
        title: &str,
        path: &str,
        kind: &str,
        pages: &[Option<i64>],
    ) -> String {
        let chunks: Vec<TextChunk> = pages
            .iter()
            .enumerate()
            .map(|(i, page)| TextChunk {
                idx: i as i64,
                page: *page,
                text: format!("{title}第 {i} 块"),
            })
            .collect();
        let doc = NewDoc {
            title,
            path,
            kind,
            pages: None,
            author: None,
            cover: None,
        };
        db::import_document(&mut conn.lock().unwrap(), &doc, &chunks).unwrap()
    }

    fn read(conn: &Arc<Mutex<Connection>>, body: serde_json::Value) -> Section {
        let req: SectionReq = serde_json::from_value(body).unwrap();
        section(&conn.lock().unwrap(), &req).unwrap()
    }

    /// 返回的文字是哪几块（按片段的序号）
    fn blocks(s: &Section) -> Vec<usize> {
        s.text
            .split("\n\n")
            .filter(|t| !t.is_empty())
            .map(|t| {
                let n = t.rsplit("第 ").next().unwrap();
                n.trim_end_matches(" 块").parse().unwrap()
            })
            .collect()
    }

    #[test]
    fn 检索接口_带着阅读位置_命中带书和格式_多余的字段当场拒绝() {
        let conn = library();
        books::create_book(&conn.lock().unwrap(), "手册", None, Some("/n"), Scan::None).unwrap();
        let one = add(&conn, "锅炉.txt", "/n/锅炉.txt", "txt", &[None; 4]);
        let two = add(&conn, "活塞.txt", "/n/活塞.txt", "txt", &[None; 4]);
        let search = |body: serde_json::Value| handle_search(&conn, &body.to_string());

        // 没开着书、也没读过：整本都能搜
        let out =
            search(serde_json::json!({ "query": "活塞", "docIds": null, "k": 8, "live": null }))
                .unwrap();
        assert_eq!(out["hits"].as_array().unwrap().len(), 4);

        // 正开着第一篇、读到一半：它到第 2 块为止，第二篇还没打开过
        let live = serde_json::json!({ "docId": one, "page": null, "fraction": 0.5 });
        let out = search(
            serde_json::json!({ "query": "锅炉 活塞", "docIds": null, "k": 8, "live": live }),
        )
        .unwrap();
        let hits = out["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 3, "{out}");
        let book = books::book_of(&conn.lock().unwrap(), &one)
            .unwrap()
            .unwrap();
        for h in hits {
            assert_eq!(h["docId"], one.as_str());
            assert_eq!(h["bookId"], book.as_str());
            assert_eq!(h["docTitle"], "手册 · 锅炉");
            assert_eq!(h["docKind"], "txt");
            assert!(h["idx"].as_i64().unwrap() <= 2);
            assert!(h["page"].is_null());
            assert_eq!(h["via"], "fts");
            assert!(h["chunkId"].is_i64() && h["text"].is_string() && h["distance"].is_number());
            assert_eq!(h.as_object().unwrap().len(), 10);
        }
        // 限定在第二篇里找也一样搜不到
        let out =
            search(serde_json::json!({ "query": "活塞", "docIds": [two], "live": live })).unwrap();
        assert!(out["hits"].as_array().unwrap().is_empty());

        // 旧版的字段、写错的字段：报错，不当作没传
        let old = serde_json::json!({
            "query": "锅炉", "bound": { "docId": one, "page": null, "fraction": 0.5 },
        });
        assert!(search(old).is_err());
        let typo = serde_json::json!({
            "query": "锅炉", "live": { "docId": one, "page": null, "fraction": 0.5, "bookId": "x" },
        });
        assert!(search(typo).is_err());
        assert!(search(serde_json::json!({ "query": "锅炉", "docIds": null, "k": 3 })).is_ok());
    }

    #[test]
    fn 读一节_分节的给指定的那一节_没读到的一个字不给() {
        let conn = library();
        // 一本三章的电子书，每章两块（防剧透默认开）
        let pages = [Some(1), Some(1), Some(2), Some(2), Some(3), Some(3)];
        let novel = add(&conn, "小说", "/n.epub", "epub", &pages);

        // 还没开始读：不设限
        let s = read(
            &conn,
            serde_json::json!({ "docId": novel, "page": 3, "fraction": null, "live": null }),
        );
        assert_eq!(
            (blocks(&s), s.page, s.blocked),
            (vec![4, 5], Some(3), false)
        );

        // 读到第二章
        db::save_reading_state(&conn.lock().unwrap(), &novel, "loc", 0.4, Some(2)).unwrap();
        let s = read(
            &conn,
            serde_json::json!({ "docId": novel, "page": 2, "fraction": 0.4, "live": null }),
        );
        assert_eq!(
            (blocks(&s), s.page, s.truncated, s.blocked),
            (vec![2, 3], Some(2), false, false)
        );
        // 第三章还没读到
        let s = read(
            &conn,
            serde_json::json!({ "docId": novel, "page": 3, "fraction": 0.4, "live": null }),
        );
        assert_eq!(
            s,
            Section {
                text: String::new(),
                page: Some(3),
                truncated: false,
                blocked: true
            }
        );
        // 不存在的章节号也是「没读到」，不透露书有多长
        let s = read(
            &conn,
            serde_json::json!({ "docId": novel, "page": 40, "fraction": null, "live": null }),
        );
        assert!(s.blocked);
        // 阅读器此刻已经翻到第三章（进度还没存）：能读
        let live = serde_json::json!({ "docId": novel, "page": 3, "fraction": 0.7 });
        let s = read(
            &conn,
            serde_json::json!({ "docId": novel, "page": 3, "fraction": 0.7, "live": live }),
        );
        assert_eq!((blocks(&s), s.blocked), (vec![4, 5], false));

        // 没说第几节：按位置找到所在的那一节，返回里说清实际给的是哪一节
        let s = read(
            &conn,
            serde_json::json!({ "docId": novel, "page": null, "fraction": 0.4, "live": null }),
        );
        assert_eq!((blocks(&s), s.page), (vec![2, 3], Some(2)));
        // 位置也没有（读的是没开着的一篇）：从第一节读起
        let s = read(
            &conn,
            serde_json::json!({ "docId": novel, "page": null, "fraction": null, "live": null }),
        );
        assert_eq!((blocks(&s), s.page), (vec![0, 1], Some(1)));

        // 老库升上来的记录没有页码，只有比例（读到一半 = 6 块里到第 3 块）：按片段的先后算
        conn.lock()
            .unwrap()
            .execute(
                "UPDATE reading_state SET furthest = 0.5, furthest_page = NULL",
                [],
            )
            .unwrap();
        let s = read(
            &conn,
            serde_json::json!({ "docId": novel, "page": 2, "fraction": null, "live": null }),
        );
        assert_eq!((blocks(&s), s.blocked), (vec![2, 3], false));
        let s = read(
            &conn,
            serde_json::json!({ "docId": novel, "page": 3, "fraction": null, "live": null }),
        );
        assert!(s.blocked && s.text.is_empty());

        // 已经不在的文档：空的，不报错
        let s = read(
            &conn,
            serde_json::json!({ "docId": "没有这一篇", "page": 1, "fraction": null, "live": null }),
        );
        assert_eq!((s.text.as_str(), s.blocked), ("", false));
        // 请求体里多了不认识的字段：拒绝
        let extra = serde_json::json!({ "docId": novel, "page": 1, "fraction": null, "live": null, "bound": 1 });
        assert!(handle_section(&conn, &extra.to_string()).is_err());
        let ok = serde_json::json!({ "docId": novel, "page": 1, "fraction": null, "live": null });
        let out = handle_section(&conn, &ok.to_string()).unwrap();
        assert_eq!(out["page"], 1);
        assert_eq!(out["blocked"], false);
        assert_eq!(out["truncated"], false);
        assert!(out["text"].as_str().unwrap().contains("第 0 块"));
    }

    #[test]
    fn 读一节_不分节的按位置取一段_开了防剧透就到读到的地方为止() {
        let conn = library();
        books::create_book(&conn.lock().unwrap(), "连载", None, Some("/n"), Scan::None).unwrap();
        let one = add(&conn, "卷一.txt", "/n/卷一.txt", "txt", &[None; 30]);
        let two = add(&conn, "卷二.txt", "/n/卷二.txt", "txt", &[None; 30]);
        let book = books::book_of(&conn.lock().unwrap(), &one)
            .unwrap()
            .unwrap();
        let ask = |doc: &str, fraction: Option<f64>| {
            read(
                &conn,
                serde_json::json!({ "docId": doc, "page": 7, "fraction": fraction, "live": null }),
            )
        };

        // 没开防剧透：从当前位置往后读（往前带两块）。请求里的 page 对不分节的文档不管用
        books::set_spoiler(&conn.lock().unwrap(), &book, Some(false)).unwrap();
        let s = ask(&one, Some(0.5));
        assert_eq!(blocks(&s), (13..27).collect::<Vec<_>>());
        assert_eq!((s.page, s.blocked), (None, false));
        assert_eq!(blocks(&ask(&two, None)), (0..14).collect::<Vec<_>>());

        // 开了防剧透、卷一读到一半（30 块里到第 15 块）：这一段到读到的地方为止
        books::set_spoiler(&conn.lock().unwrap(), &book, None).unwrap();
        db::save_reading_state(&conn.lock().unwrap(), &one, "loc", 0.5, None).unwrap();
        let s = ask(&one, Some(0.5));
        assert_eq!(blocks(&s), (2..16).collect::<Vec<_>>());
        assert_eq!((s.page, s.truncated, s.blocked), (None, false, false));
        // 翻回前面重看：到当前位置为止
        assert_eq!(blocks(&ask(&one, Some(0.25))), (0..8).collect::<Vec<_>>());
        // 当前位置没给，或者给得比读到的还靠后：都到读到的最远处为止
        assert_eq!(blocks(&ask(&one, None)), (2..16).collect::<Vec<_>>());
        assert_eq!(blocks(&ask(&one, Some(0.9))), (2..16).collect::<Vec<_>>());
        // 阅读器此刻的位置比存下来的靠后：以此刻的为准
        let live = serde_json::json!({ "docId": one, "page": null, "fraction": 0.75 });
        let s = read(
            &conn,
            serde_json::json!({ "docId": one, "page": null, "fraction": 0.75, "live": live }),
        );
        assert_eq!(blocks(&s), (9..23).collect::<Vec<_>>());

        // 卷二还没打开过：不给
        let s = ask(&two, None);
        assert_eq!(
            s,
            Section {
                text: String::new(),
                page: None,
                truncated: false,
                blocked: true
            }
        );
        // 翻开卷二之后，卷一整篇算读过，又回到「从当前位置往后读」
        db::save_reading_state(&conn.lock().unwrap(), &two, "loc", 0.0, None).unwrap();
        assert_eq!(blocks(&ask(&one, Some(0.5))), (13..27).collect::<Vec<_>>());
        assert_eq!(blocks(&ask(&two, Some(0.0))), vec![0]);
    }

    #[test]
    fn 一节太长只给前一部分_到读到的地方为止的那一段从前面丢() {
        let conn = library();
        let long = |title: &str, path: &str, kind: &str, page: Option<i64>| {
            let chunks: Vec<TextChunk> = (0..20)
                .map(|i| TextChunk {
                    idx: i,
                    page,
                    text: format!("{}第 {i} 块", "字".repeat(1000)),
                })
                .collect();
            let doc = NewDoc {
                title,
                path,
                kind,
                pages: None,
                author: None,
                cover: None,
            };
            db::import_document(&mut conn.lock().unwrap(), &doc, &chunks).unwrap()
        };
        // 一章两万字：只给前一万二，并且说明截断了
        let chapter = long("长章节", "/c.epub", "epub", Some(1));
        let s = read(
            &conn,
            serde_json::json!({ "docId": chapter, "page": 1, "fraction": null, "live": null }),
        );
        assert!(s.truncated);
        assert_eq!(s.text.chars().count(), SECTION_CHARS);
        assert!(s.text.contains("第 0 块") && !s.text.contains("第 19 块"));

        // 不分节、开着防剧透、读完了：给的是紧挨着读到的地方的那几块，前面的丢掉，不算截断
        let serial = long("长连载", "/s.txt", "txt", None);
        db::save_reading_state(&conn.lock().unwrap(), &serial, "loc", 1.0, None).unwrap();
        let s = read(
            &conn,
            serde_json::json!({ "docId": serial, "page": null, "fraction": 1.0, "live": null }),
        );
        assert!(!s.truncated && s.text.chars().count() <= SECTION_CHARS);
        assert_eq!(blocks(&s), (9..20).collect::<Vec<_>>());
    }

    #[test]
    fn 笔记接口_可以只要一本书的_按篇的先后排() {
        let conn = library();
        let book = books::create_book(&conn.lock().unwrap(), "手册", None, Some("/m"), Scan::None)
            .unwrap();
        let first = add(&conn, "第一章.md", "/m/第一章.md", "md", &[None]);
        let second = add(&conn, "第二章.md", "/m/第二章.md", "md", &[None]);
        let other = add(&conn, "小说", "/n.epub", "epub", &[Some(1)]);
        let note = |id: &str, doc_id: &str| {
            let a: db::Annotation = serde_json::from_value(serde_json::json!({
                "id": id, "docId": doc_id, "kind": "highlight", "cfi": "epubcfi(/6/2)", "text": "划的一句",
            }))
            .unwrap();
            db::save_annotation(&conn.lock().unwrap(), &a).unwrap();
        };
        // 先在第二章划，再在别的书上划，最后在第一章划
        note("b", &second);
        note("x", &other);
        note("a", &first);
        let ids = |body: serde_json::Value| -> Vec<String> {
            handle_annotations(&conn, &body.to_string()).unwrap()["annotations"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a["id"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(
            ids(serde_json::json!({ "docIds": null, "bookId": book })),
            vec!["a", "b"]
        );
        assert_eq!(
            ids(serde_json::json!({ "docIds": [other], "bookId": null })),
            vec!["x"]
        );
        assert_eq!(
            ids(serde_json::json!({ "docIds": null, "bookId": null })).len(),
            3
        );
        let out =
            handle_annotations(&conn, &serde_json::json!({ "bookId": book }).to_string()).unwrap();
        assert_eq!(out["annotations"][0]["docTitle"], "手册 · 第一章");
        assert_eq!(out["annotations"][0]["docId"], first.as_str());
        // 字段名写错（book_id）：拒绝，不当作「全部」
        let wrong = serde_json::json!({ "docIds": null, "book_id": book });
        assert!(handle_annotations(&conn, &wrong.to_string()).is_err());
    }

    #[test]
    fn 同名文件不覆盖_加序号() {
        let dir = std::env::temp_dir().join(format!("docagent-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_path(&dir, "总结.md"), dir.join("总结.md"));
        std::fs::write(dir.join("总结.md"), "旧的").unwrap();
        assert_eq!(free_path(&dir, "总结.md"), dir.join("总结 (2).md"));
        std::fs::write(dir.join("总结 (2).md"), "x").unwrap();
        assert_eq!(free_path(&dir, "总结.md"), dir.join("总结 (3).md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 文件名不能带路径跳出保存目录() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(
            sanitize_filename("/Users/x/.ssh/authorized_keys"),
            "authorized_keys"
        );
        assert_eq!(sanitize_filename("..\\..\\a.md"), "a.md");
        assert_eq!(sanitize_filename(".bashrc"), "bashrc");
        assert_eq!(sanitize_filename(""), "note.md");
        assert_eq!(sanitize_filename("合同要点.md"), "合同要点.md");
    }
}
