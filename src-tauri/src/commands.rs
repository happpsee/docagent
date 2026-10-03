//! Tauri 命令：前端唯一能调用的入口。
//!
//! 这里只做参数转换和错误包装，逻辑在 db 模块里。

use crate::db::{self, ChunkIn, DocOut, SearchHit};
use crate::AppState;
use tauri::State;

/// 错误统一转成字符串，前端 invoke 的 Promise reject 里能直接显示
fn e(err: anyhow::Error) -> String {
    err.to_string()
}

#[tauri::command]
pub fn add_document(
    state: State<'_, AppState>,
    title: String,
    path: Option<String>,
    kind: String,
    pages: Option<i64>,
    chunks: Vec<ChunkIn>,
) -> Result<String, String> {
    let mut conn = state.conn.lock().map_err(|_| "数据库锁异常".to_string())?;
    db::add_document(&mut conn, &title, path.as_deref(), &kind, pages, &chunks).map_err(e)
}

#[tauri::command]
pub fn list_documents(state: State<'_, AppState>) -> Result<Vec<DocOut>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库锁异常".to_string())?;
    db::list_documents(&conn).map_err(e)
}

#[tauri::command]
pub fn delete_document(state: State<'_, AppState>, doc_id: String) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|_| "数据库锁异常".to_string())?;
    db::delete_document(&mut conn, &doc_id).map_err(e)
}

#[tauri::command]
pub fn search(
    state: State<'_, AppState>,
    embedding: Vec<f32>,
    k: usize,
    doc_ids: Option<Vec<String>>,
) -> Result<Vec<SearchHit>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库锁异常".to_string())?;
    db::search(&conn, &embedding, k, doc_ids.as_deref()).map_err(e)
}

#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库锁异常".to_string())?;
    db::get_setting(&conn, &key).map_err(e)
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库锁异常".to_string())?;
    db::set_setting(&conn, &key, &value).map_err(e)
}

#[tauri::command]
pub fn reset_index(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库锁异常".to_string())?;
    db::reset_index(&conn).map_err(e)
}

/// 读取本地文件的原始字节，给前端解析 PDF / DOCX 用。
/// 只允许读用户通过文件选择框显式挑中的文件（路径由前端传回，不做遍历）。
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|err| format!("读不到文件 {path}：{err}"))
}

#[tauri::command]
pub fn db_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let conn = state.conn.lock().map_err(|_| "数据库锁异常".to_string())?;
    let docs: i64 = conn
        .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let chunks: i64 = conn
        .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let dim = db::get_setting(&conn, "embedding_dim").map_err(e)?;
    let size = std::fs::metadata(&state.db_path)
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(serde_json::json!({
        "docs": docs,
        "chunks": chunks,
        "embeddingDim": dim,
        "dbPath": state.db_path.to_string_lossy(),
        "dbSizeBytes": size,
    }))
}

/// 写文本文件。只在用户通过保存对话框确认后调用（路径由前端给出）。
#[tauri::command]
pub fn write_file_text(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|err| format!("写不了文件 {path}：{err}"))
}
