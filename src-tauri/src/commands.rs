//! Tauri 命令：前端唯一能调用的入口。只做参数转换和错误包装。

use crate::agent::{self, Provider};
use crate::db::{self, DocOut, MessageOut, SessionOut, TextChunk};
use crate::AppState;
use tauri::{AppHandle, Manager, State};

fn e(err: anyhow::Error) -> String {
    err.to_string()
}
const LOCK: &str = "数据库锁异常";
const SETTINGS_KEY: &str = "settings";

// ---------- 文档 ----------

#[tauri::command]
pub fn add_document(
    state: State<'_, AppState>,
    title: String,
    path: Option<String>,
    kind: String,
    pages: Option<i64>,
    chunks: Vec<TextChunk>,
) -> Result<String, String> {
    let mut conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::add_document_text(&mut conn, &title, path.as_deref(), &kind, pages, &chunks).map_err(e)
}

#[tauri::command]
pub fn list_documents(state: State<'_, AppState>) -> Result<Vec<DocOut>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::list_documents(&conn).map_err(e)
}

#[tauri::command]
pub fn delete_document(state: State<'_, AppState>, doc_id: String) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::delete_document(&mut conn, &doc_id).map_err(e)
}

#[tauri::command]
pub fn reset_index(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::reset_index(&conn).map_err(e)
}

/// 读本地文件字节，给前端解析 PDF / DOCX。路径来自用户在文件选择框里的选择。
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|err| format!("读不到文件 {path}：{err}"))
}

// ---------- 设置 ----------

#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::get_setting(&conn, &key).map_err(e)
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::set_setting(&conn, &key, &value).map_err(e)
}

#[tauri::command]
pub fn db_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    let count = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get(0))
            .map_err(|e| e.to_string())
    };
    let size = std::fs::metadata(&state.db_path)
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(serde_json::json!({
        "docs": count("SELECT COUNT(*) FROM docs")?,
        "chunks": count("SELECT COUNT(*) FROM chunks")?,
        "sessions": count("SELECT COUNT(*) FROM sessions")?,
        "dbPath": state.db_path.to_string_lossy(),
        "dbSizeBytes": size,
        "saveDir": state.save_dir.to_string_lossy(),
    }))
}

// ---------- 会话 ----------

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionOut>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::list_sessions(&conn).map_err(e)
}

#[tauri::command]
pub fn upsert_session(
    state: State<'_, AppState>,
    id: String,
    title: String,
    sdk_session_id: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::upsert_session(&conn, &id, &title, sdk_session_id.as_deref()).map_err(e)
}

#[tauri::command]
pub fn delete_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::delete_session(&conn, &id).map_err(e)
}

#[tauri::command]
pub fn add_message(
    state: State<'_, AppState>,
    session_id: String,
    role: String,
    content: String,
    meta: Option<String>,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::add_message(&conn, &session_id, &role, &content, meta.as_deref()).map_err(e)
}

#[tauri::command]
pub fn get_messages(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<MessageOut>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::get_messages(&conn, &session_id).map_err(e)
}

// ---------- agent ----------

/// （重新）启动 sidecar。应用启动时和保存设置后调用。
#[tauri::command]
pub fn agent_start(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let provider: Provider = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        db::get_setting(&conn, SETTINGS_KEY)
            .map_err(e)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    };
    if provider.api_key.is_empty() || provider.base_url.is_empty() || provider.model.is_empty() {
        return Err("还没配置模型：请在设置里填接口地址、API Key 和模型名".to_string());
    }
    let config_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("claude");
    let mut slot = state.agent.lock().map_err(|_| "agent 锁异常".to_string())?;
    *slot = None; // 先停掉旧的
    let a = agent::spawn(
        app.clone(),
        state.api_port,
        &state.api_token,
        &provider,
        config_dir,
    )
    .map_err(e)?;
    *slot = Some(a);
    Ok(())
}

#[tauri::command]
pub fn agent_send(state: State<'_, AppState>, payload: serde_json::Value) -> Result<(), String> {
    let mut slot = state.agent.lock().map_err(|_| "agent 锁异常".to_string())?;
    match slot.as_mut() {
        Some(a) => a.send(&payload.to_string()).map_err(e),
        None => Err("agent 没有启动：请先在设置里配置模型".to_string()),
    }
}
