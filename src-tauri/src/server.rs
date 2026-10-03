//! 给 sidecar 用的本地接口。
//!
//! agent 的工具（检索、保存）在 sidecar 进程里被调用，但索引和文件在 Rust 这边，
//! 所以开一个只绑 127.0.0.1 的 HTTP 接口给它调。端口随机，带一次性 token：
//! 同机其它程序即使扫到端口，没有 token 也调不了。

use crate::db;
use anyhow::Result;
use rusqlite::Connection;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Method, Response, Server};

#[derive(Deserialize)]
struct SearchReq {
    query: String,
    #[serde(rename = "docIds")]
    doc_ids: Option<Vec<String>>,
    k: Option<usize>,
    /// 防剧透：某本书只搜用户读过的部分
    bound: Option<crate::search::Bound>,
}

#[derive(Deserialize)]
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
    let hits = crate::search::hybrid_bounded(
        conn,
        &req.query,
        req.k.unwrap_or(6),
        req.doc_ids.as_deref(),
        req.bound.as_ref(),
    )?;
    // sidecar 和前端都用 camelCase
    let hits: Vec<_> = hits
        .into_iter()
        .map(|h| {
            serde_json::json!({
                "chunkId": h.chunk_id, "docId": h.doc_id, "docTitle": h.doc_title,
                "idx": h.idx, "page": h.page, "text": h.text, "distance": h.distance, "via": h.via,
            })
        })
        .collect();
    Ok(serde_json::json!({ "hits": hits }))
}

/// 用户在阅读器里划的高亮和写的笔记，给 agent 看
fn handle_annotations(conn: &Arc<Mutex<Connection>>, body: &str) -> Result<serde_json::Value> {
    #[derive(Deserialize)]
    struct Req {
        #[serde(rename = "docIds")]
        doc_ids: Option<Vec<String>>,
    }
    let req: Req = serde_json::from_str(body)?;
    let conn = conn.lock().map_err(|_| anyhow::anyhow!("数据库锁异常"))?;
    let list = db::list_annotations(&conn, req.doc_ids.as_deref())?;
    Ok(serde_json::json!({ "annotations": list }))
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

/// 读一份文档的某一节（PDF 的一页 / 电子书的一章）。没有分节的文档返回开头的一段
fn handle_section(conn: &Arc<Mutex<Connection>>, body: &str) -> Result<serde_json::Value> {
    #[derive(Deserialize)]
    struct Req {
        #[serde(rename = "docId")]
        doc_id: String,
        page: Option<i64>,
        fraction: Option<f64>,
    }
    const LIMIT: usize = 12_000;
    let req: Req = serde_json::from_str(body)?;
    let conn = conn.lock().map_err(|_| anyhow::anyhow!("数据库锁异常"))?;
    let text = db::section_text(&conn, &req.doc_id, req.page, req.fraction)?;
    let truncated = text.chars().count() > LIMIT;
    let text: String = text.chars().take(LIMIT).collect();
    Ok(serde_json::json!({ "text": text, "page": req.page, "truncated": truncated }))
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
    use super::{free_path, sanitize_filename};

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
