//! DocAgent：本地文档智能体工作台。
//!
//! 进程划分：
//! - Rust（这里）：SQLite 存储（文档、向量索引、会话）、文件读写、管理 sidecar
//! - sidecar（bun 单文件，内含 Claude Agent SDK）：agent 循环、工具调用、会话续接
//! - WebView：界面
//!
//! sidecar 的工具通过只绑本机的 HTTP 接口调回 Rust 做检索和保存。

pub mod agent;
pub mod chunk;
pub mod commands;
pub mod db;
pub mod embed;
pub mod parse;
pub mod server;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub struct AppState {
    pub conn: Arc<Mutex<rusqlite::Connection>>,
    pub db_path: PathBuf,
    pub save_dir: PathBuf,
    pub api_port: u16,
    pub api_token: String,
    pub agent: Mutex<Option<agent::Agent>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("docagent.db");
            let conn = Arc::new(Mutex::new(db::open(&db_path)?));

            // agent 保存的文件统一放这里，不让它决定路径
            let save_dir = app
                .path()
                .document_dir()
                .unwrap_or_else(|_| dir.clone())
                .join("DocAgent");
            let api = server::start(conn.clone(), save_dir.clone())?;

            app.manage(AppState {
                conn,
                db_path,
                save_dir,
                api_port: api.port,
                api_token: api.token,
                agent: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_paths,
            commands::document_text,
            commands::list_documents,
            commands::delete_document,
            commands::reset_index,
            commands::read_file_bytes,
            commands::get_setting,
            commands::set_setting,
            commands::db_info,
            commands::list_sessions,
            commands::upsert_session,
            commands::delete_session,
            commands::add_message,
            commands::get_messages,
            commands::agent_start,
            commands::agent_send,
            commands::ensure_config_dir,
            commands::open_path,
        ])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
