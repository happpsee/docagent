//! DocAgent：本地文档智能体工作台。
//!
//! Rust 侧只负责三件事：SQLite 存储（文档、分块、向量索引）、文件读取、窗口。
//! 文档解析、embedding、模型调用都在前端（TS）做——这样换模型供应商不用改 Rust。

pub mod commands;
pub mod db;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub conn: Mutex<rusqlite::Connection>,
    pub db_path: PathBuf,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 数据目录由 Tauri 给出（macOS: ~/Library/Application Support/<identifier>）
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("docagent.db");
            let conn = db::open(&db_path)?;
            app.manage(AppState {
                conn: Mutex::new(conn),
                db_path,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_document,
            commands::list_documents,
            commands::delete_document,
            commands::search,
            commands::get_setting,
            commands::set_setting,
            commands::reset_index,
            commands::read_file_bytes,
            commands::db_info,
            commands::write_file_text,
        ])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
