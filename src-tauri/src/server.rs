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
    let conn = conn.lock().map_err(|_| anyhow::anyhow!("数据库锁异常"))?;
    let hits = db::search_text(
        &conn,
        &req.query,
        req.k.unwrap_or(6),
        req.doc_ids.as_deref(),
    )?;
    // sidecar 和前端都用 camelCase
    let hits: Vec<_> = hits
        .into_iter()
        .map(|h| {
            serde_json::json!({
                "chunkId": h.chunk_id, "docId": h.doc_id, "docTitle": h.doc_title,
                "idx": h.idx, "page": h.page, "text": h.text, "distance": h.distance,
            })
        })
        .collect();
    Ok(serde_json::json!({ "hits": hits }))
}

/// 保存到固定目录下，文件名去掉路径成分——agent 给的名字不能决定写到哪
fn handle_save(save_dir: &std::path::Path, body: &str) -> Result<serde_json::Value> {
    let req: SaveReq = serde_json::from_str(body)?;
    let name = sanitize_filename(&req.filename);
    std::fs::create_dir_all(save_dir)?;
    let path = save_dir.join(name);
    std::fs::write(&path, req.content)?;
    Ok(serde_json::json!({ "path": path.to_string_lossy() }))
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
    use super::sanitize_filename;

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
