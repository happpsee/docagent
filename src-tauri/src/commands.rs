//! Tauri 命令：前端唯一能调用的入口。只做参数转换和错误包装。

use crate::agent::{self, Provider};
use crate::books::{self, Book};
use crate::db::{self, MessageOut, SessionOut};
use crate::import::{self, ImportItem, ImportSummary, ReindexSummary, ScanItem};
use crate::parse;
use crate::AppState;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tauri::{AppHandle, Manager, State};

fn e(err: anyhow::Error) -> String {
    err.to_string()
}
const LOCK: &str = "数据库锁异常";
const SETTINGS_KEY: &str = "settings";

// ---------- 书架 ----------

#[tauri::command(async)]
pub fn list_books(state: State<'_, AppState>) -> Result<Vec<Book>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    books::list_books(&conn).map_err(e)
}

#[tauri::command(async)]
pub fn update_book(
    state: State<'_, AppState>,
    book_id: String,
    title: String,
    author: Option<String>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    books::update_book(&mut conn, &book_id, &title, author.as_deref()).map_err(e)
}

/// on 传 null 是恢复按类型的默认值
#[tauri::command(async)]
pub fn set_book_spoiler(
    state: State<'_, AppState>,
    book_id: String,
    on: Option<bool>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    books::set_spoiler(&conn, &book_id, on).map_err(e)
}

/// 从书架上移除一本书（原文件不动）。with_sessions 为真时这本书下的对话也一起删。
/// （这本书正在做透视的话会被叫停，见 books::delete_book）
#[tauri::command(async)]
pub fn delete_book(
    state: State<'_, AppState>,
    book_id: String,
    with_sessions: bool,
) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    books::delete_book(&mut conn, &book_id, with_sessions).map_err(e)
}

/// 移除书里的一篇；它是最后一篇的话书也一起移除。
/// （这本书正在做透视的话会被叫停，见 books::delete_document）
#[tauri::command(async)]
pub fn delete_document(state: State<'_, AppState>, doc_id: String) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    books::delete_document(&mut conn, &doc_id).map_err(e)
}

/// 把一篇在书里往前（-1）或往后（1）挪一位
#[tauri::command(async)]
pub fn move_part(state: State<'_, AppState>, doc_id: String, delta: i64) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    books::move_part(&mut conn, &doc_id, delta).map_err(e)
}

/// 把一本多篇的书拆成一篇一本
#[tauri::command(async)]
pub fn split_book(state: State<'_, AppState>, book_id: String) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    books::split_book(&mut conn, &book_id).map_err(e)
}

// ---------- 导入 ----------

/// 导入前先看看这些路径是什么：文件还是文件夹、里面有多少能导入的、是不是已经在书架上。
/// 只看不动；走文件夹可能要一会儿，放到后台线程
#[tauri::command]
pub async fn scan_paths(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<ScanItem>, String> {
    let conn = state.conn.clone();
    tauri::async_runtime::spawn_blocking(move || import::scan_paths(&conn, &paths).map_err(e))
        .await
        .map_err(|e| e.to_string())?
}

/// 导入文件或文件夹，每一项说明怎么归成书。解析在后台线程做，进度通过 import-progress 事件推给界面。
#[tauri::command]
pub async fn import_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    items: Vec<ImportItem>,
) -> Result<ImportSummary, String> {
    let conn = state.conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let summary = import::run(&conn, &items, &|p| {
            let _ = app.emit("import-progress", p);
        });
        // 新片段的向量在后台补，不让导入等接口
        spawn_fill_vectors(app.clone());
        summary
    })
    .await
    .map_err(|e| e.to_string())
}

/// 按文件夹现在的样子更新一本书：新文件收进来，改过的重建，原文件不见了的按规矩留下或拿掉
#[tauri::command]
pub async fn rescan_book(
    app: AppHandle,
    state: State<'_, AppState>,
    book_id: String,
) -> Result<ImportSummary, String> {
    let conn = state.conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 不发 import-progress：那是「导入」的进度条，由导入结束时收掉；
        // 更新一本书走的不是那条路，发了就没人收，书架上的「添加」会一直灰着。
        // 详情面板自己有个转圈
        let summary = import::rescan(&conn, &book_id, &|_| {}).map_err(e)?;
        spawn_fill_vectors(app.clone());
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 文件或文件夹挪了地方：让用户重新指给应用。取消返回 false。
/// 选位置的对话框由这边弹——不提供「给个路径就改」的命令，界面里跑着第三方内容（书），
/// 不能让它有办法把一本书指到任意文件上再读出来
#[tauri::command]
pub async fn relocate_book(
    app: AppHandle,
    state: State<'_, AppState>,
    book_id: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let is_folder = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        books::book_ref(&conn, &book_id)
            .map_err(e)?
            .ok_or_else(|| "这本书已经不在书架上了".to_string())?
            .folder
            .is_some()
    };
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let dialog = dialog_app.dialog().file();
        if is_folder {
            dialog.blocking_pick_folder()
        } else {
            dialog
                .add_filter("文档", &parse::EXTENSIONS)
                .blocking_pick_file()
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(false);
    };
    let conn = state.conn.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        {
            let mut c = conn.lock().map_err(|_| LOCK.to_string())?;
            books::relocate(&mut c, &book_id, &path).map_err(e)?;
        }
        // 路径换了，内容可能也不一样了：按新位置的文件刷新一遍
        import::refresh_parts(&conn, &book_id).map_err(e)
    })
    .await
    .map_err(|e| e.to_string())??;
    spawn_fill_vectors(app);
    Ok(true)
}

/// 在访达里显示一个文件或文件夹（选中它，不打开）
fn reveal(path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err("原文件找不到了".to_string());
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("打不开 {path}：{err}"))
}

/// 在访达里显示一本书：文件夹书显示它的文件夹，单文件的书显示那个文件。
/// 路径在这边按 id 查，不收界面传来的路径
#[tauri::command(async)]
pub fn reveal_book(state: State<'_, AppState>, book_id: String) -> Result<(), String> {
    let path = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        let book = books::book_ref(&conn, &book_id)
            .map_err(e)?
            .ok_or_else(|| "这本书已经不在书架上了".to_string())?;
        match book.folder {
            Some(folder) => Some(folder),
            None => books::parts(&conn, &book_id)
                .map_err(e)?
                .into_iter()
                .find_map(|p| p.path),
        }
    };
    reveal(&path.ok_or_else(|| "原文件找不到了".to_string())?)
}

#[tauri::command(async)]
pub fn reveal_doc(state: State<'_, AppState>, doc_id: String) -> Result<(), String> {
    let path = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        db::doc_path(&conn, &doc_id).map_err(e)?
    };
    reveal(&path.ok_or_else(|| "原文件找不到了".to_string())?)
}

/// 取文档的全文（给阅读器显示非 PDF 文档用）
#[tauri::command]
pub async fn document_text(state: State<'_, AppState>, doc_id: String) -> Result<String, String> {
    let path = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        db::doc_path(&conn, &doc_id).map_err(e)?
    }
    .ok_or_else(|| "找不到这份文档的原始文件".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        parse::extract(Path::new(&path))
            .map(|p| {
                p.pages
                    .into_iter()
                    .map(|(_, t)| t)
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .map_err(e)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 重建索引：按原文件把每一篇重新解析一遍。书架不动（不增不减不换位置），划线、笔记、进度都留着。
/// 原文件已经不在的篇保持原来的内容，返回值里列出来。
#[tauri::command]
pub async fn reset_index(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ReindexSummary, String> {
    let conn = state.conn.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || import::reindex(&conn).map_err(e))
        .await
        .map_err(|e| e.to_string())??;
    spawn_fill_vectors(app);
    Ok(summary)
}

/// 在后台给还没有向量的片段补向量，进度通过 vector-progress 事件推给界面
pub fn spawn_fill_vectors(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        crate::search::fill_vectors(&state.conn, |p| {
            let _ = app.emit("vector-progress", p);
        });
    });
}

/// 设置里改了向量接口之后调一下
#[tauri::command(async)]
pub fn fill_vectors(app: AppHandle) {
    spawn_fill_vectors(app);
}

/// 读一份已导入文档的原文件，给阅读器打开（PDF、EPUB 等）。
/// 走二进制通道返回：几十 MB 的书如果转成 JSON 数组会又慢又占内存。
#[tauri::command]
pub async fn read_file_bytes(
    state: State<'_, AppState>,
    doc_id: String,
) -> Result<tauri::ipc::Response, String> {
    let path = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        db::doc_path(&conn, &doc_id).map_err(e)?
    }
    .ok_or_else(|| "找不到这份文档的原始文件".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path)
            .map(tauri::ipc::Response::new)
            .map_err(|err| format!("读不到文件 {path}：{err}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Markdown / TXT / DOCX 排成分好节的 HTML 和目录，给阅读器当书打开
#[tauri::command]
pub async fn document_book(
    state: State<'_, AppState>,
    doc_id: String,
) -> Result<crate::render::Book, String> {
    let path = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        db::doc_path(&conn, &doc_id).map_err(e)?
    }
    .ok_or_else(|| "找不到这份文档的原始文件".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::render::book_for(Path::new(&path)).map_err(e)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- 阅读器：封面、高亮笔记、进度 ----------

/// 书的封面：用户上传的那张，没有就用第一篇有封面的那张；都没有返回空。
/// 走二进制通道，不转成 JSON 数组
#[tauri::command(async)]
pub fn book_cover(
    state: State<'_, AppState>,
    book_id: String,
) -> Result<tauri::ipc::Response, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    let data = books::cover(&conn, &book_id)
        .map_err(e)?
        .unwrap_or_default();
    Ok(tauri::ipc::Response::new(data))
}

/// 让用户挑一张图当封面。文件对话框由这边弹、文件由这边读，界面拿不到路径也给不了路径。
/// 取消返回 false
#[tauri::command]
pub async fn pick_book_cover(
    app: AppHandle,
    state: State<'_, AppState>,
    book_id: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("图片", &["jpg", "jpeg", "png", "gif", "webp"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(false);
    };
    let small = tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path)
            .ok()
            .and_then(|bytes| crate::ebook::thumbnail(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "这张图片解不出来".to_string())?;
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    books::set_custom_cover(&conn, &book_id, &small).map_err(e)?;
    Ok(true)
}

/// 恢复默认封面
#[tauri::command(async)]
pub fn clear_book_cover(state: State<'_, AppState>, book_id: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    books::clear_custom_cover(&conn, &book_id).map_err(e)
}

/// 一篇的自动封面：PDF 这类没法在 Rust 里取封面的，由阅读器渲染出第一页后送过来，这里缩成小图存库
#[tauri::command]
pub async fn set_doc_cover(
    state: State<'_, AppState>,
    doc_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let small = tauri::async_runtime::spawn_blocking(move || crate::ebook::thumbnail(&data))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "封面图片解不出来".to_string())?;
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::set_cover(&conn, &doc_id, &small).map_err(e)
}

/// 一篇的标记，或者整本书所有篇的标记（按篇的先后排）；两样都不给是全部
#[tauri::command(async)]
pub fn list_annotations(
    state: State<'_, AppState>,
    doc_id: Option<String>,
    book_id: Option<String>,
) -> Result<Vec<db::Annotation>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    let ids = doc_id.map(|d| vec![d]);
    db::list_annotations(&conn, ids.as_deref(), book_id.as_deref()).map_err(e)
}

#[tauri::command(async)]
pub fn save_annotation(
    state: State<'_, AppState>,
    annotation: db::Annotation,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::save_annotation(&conn, &annotation).map_err(e)
}

#[tauri::command(async)]
pub fn delete_annotation(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::delete_annotation(&conn, &id).map_err(e)
}

#[tauri::command(async)]
pub fn reading_state(
    state: State<'_, AppState>,
    doc_id: String,
) -> Result<Option<db::ReadingState>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::reading_state(&conn, &doc_id).map_err(e)
}

/// page：PDF 的页码 / EPUB 的第几节（其它格式没有），用来记「读到过的最远处」
#[tauri::command(async)]
pub fn save_reading_state(
    state: State<'_, AppState>,
    doc_id: String,
    location: String,
    fraction: f64,
    page: Option<f64>,
) -> Result<(), String> {
    // 页码按数字收再取整：界面万一送来个 3.0 或带小数的，不能因为这个把整次进度保存打回去
    let page = page.filter(|p| p.is_finite()).map(|p| p.floor() as i64);
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::save_reading_state(&conn, &doc_id, &location, fraction, page).map_err(e)
}

/// 导出文字（笔记等）：由这边弹「另存为」对话框再写。
/// 不提供「给个路径就写」的命令——界面里跑着第三方内容（书），不能让它有办法写任意文件。
#[tauri::command]
pub async fn export_text(
    app: AppHandle,
    default_name: String,
    content: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let name = crate::server::sanitize_filename(&default_name);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(&name)
            .add_filter("Markdown", &["md"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    std::fs::write(&path, content).map_err(|err| format!("写不了 {}：{err}", path.display()))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// ---------- 透视 ----------

/// 一本书的透视：做好的段（按篇的先后）和全书一共多少段
#[tauri::command(async)]
pub fn xray_get(state: State<'_, AppState>, book_id: String) -> Result<crate::xray::XRay, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::xray::get(&conn, &book_id).map_err(e)
}

/// 开始（或接着）透视一本书。在后台跑，进度通过 xray-progress 事件推给界面
#[tauri::command(async)]
pub fn xray_build(
    app: AppHandle,
    state: State<'_, AppState>,
    book_id: String,
) -> Result<(), String> {
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
    let conn = state.conn.clone();
    std::thread::spawn(move || {
        crate::xray::build(&conn, &book_id, crate::xray::completer(provider), |p| {
            let _ = app.emit("xray-progress", p);
        });
    });
    Ok(())
}

#[tauri::command(async)]
pub fn xray_clear(state: State<'_, AppState>, book_id: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::xray::clear(&conn, &book_id).map_err(e)
}

// ---------- 设置 ----------

#[tauri::command(async)]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::get_setting(&conn, &key).map_err(e)
}

#[tauri::command(async)]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::set_setting(&conn, &key, &value).map_err(e)
}

#[tauri::command(async)]
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
        "books": count("SELECT COUNT(*) FROM books")?,
        "chunks": count("SELECT COUNT(*) FROM chunks")?,
        "vectors": db::vector_counts(&conn).map_err(e)?.0,
        "embedModel": crate::embed::config(&conn).map(|c| c.model),
        "sessions": count("SELECT COUNT(*) FROM sessions")?,
        "dbPath": state.db_path.to_string_lossy(),
        "dbSizeBytes": size,
        "saveDir": state.save_dir.to_string_lossy(),
    }))
}

// ---------- 会话 ----------

#[tauri::command(async)]
pub fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionOut>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::list_sessions(&conn).map_err(e)
}

/// book_id 只在新建会话时生效：会话关联哪本书在创建时定下来，之后的更新不会改它
#[tauri::command(async)]
pub fn upsert_session(
    state: State<'_, AppState>,
    id: String,
    title: String,
    sdk_session_id: Option<String>,
    book_id: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::upsert_session(
        &conn,
        &id,
        &title,
        sdk_session_id.as_deref(),
        book_id.as_deref(),
    )
    .map_err(e)
}

/// 手动把一段对话归到某本书下，或者传 null 取消关联
#[tauri::command(async)]
pub fn set_session_book(
    state: State<'_, AppState>,
    id: String,
    book_id: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::set_session_book(&conn, &id, book_id.as_deref()).map_err(e)
}

/// 记下这段对话的检索范围（界面给的 JSON 文本，原样存）；null 是恢复默认
#[tauri::command(async)]
pub fn set_session_scope(
    state: State<'_, AppState>,
    id: String,
    scope: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::set_session_scope(&conn, &id, scope.as_deref()).map_err(e)
}

#[tauri::command(async)]
pub fn delete_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::delete_session(&conn, &id).map_err(e)
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn get_messages(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<MessageOut>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::get_messages(&conn, &session_id).map_err(e)
}

// ---------- agent ----------

/// （重新）启动 sidecar。应用启动时和保存设置后调用。
#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn agent_send(state: State<'_, AppState>, payload: serde_json::Value) -> Result<(), String> {
    let mut slot = state.agent.lock().map_err(|_| "agent 锁异常".to_string())?;
    match slot.as_mut() {
        Some(a) => a.send(&payload.to_string()).map_err(e),
        None => Err("agent 没有启动：请先在设置里配置模型".to_string()),
    }
}

// ---------- 扩展配置（技能、MCP） ----------

const CONFIG_README: &str = r#"# DocAgent 配置目录

这里放技能和 MCP 服务的配置。用户目录下的（~/.docagent）对所有对话生效；
工作文件夹里的（<文件夹>/.docagent）只在选了那个文件夹时生效，同名时覆盖用户级。

## 技能

每个技能一个文件夹，里面放一份 SKILL.md：

    skills/
      写周报/
        SKILL.md

SKILL.md 的开头写清楚它叫什么、什么时候用，下面写具体做法：

    ---
    name: 写周报
    description: 用户要写周报、周总结时使用
    ---

    1. 先问清楚这周做了哪几件事
    2. 按「完成 / 进行中 / 下周计划」三段写
    3. 每条不超过两行

## MCP 服务

mcp.json 里写要连接的 MCP 服务：

    {
      "mcpServers": {
        "名字": { "command": "npx", "args": ["-y", "某个-mcp-server"] },
        "远程的": { "type": "http", "url": "https://example.com/mcp" }
      }
    }

改完后开一个新对话生效。助手第一次用某个服务的工具时会先问你。
"#;

/// 确保配置目录存在（没有就建好骨架），返回它的路径。
/// dir 为空表示用户级（~/.docagent），否则是 <dir>/.docagent。
#[tauri::command(async)]
pub fn ensure_config_dir(app: AppHandle, dir: Option<String>) -> Result<String, String> {
    let base = match dir {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => app.path().home_dir().map_err(|e| e.to_string())?,
    };
    let root = base.join(".docagent");
    std::fs::create_dir_all(root.join("skills")).map_err(|e| e.to_string())?;
    let mcp = root.join("mcp.json");
    if !mcp.exists() {
        std::fs::write(&mcp, "{\n  \"mcpServers\": {}\n}\n").map_err(|e| e.to_string())?;
    }
    let readme = root.join("README.md");
    if !readme.exists() {
        std::fs::write(&readme, CONFIG_README).map_err(|e| e.to_string())?;
    }
    Ok(root.to_string_lossy().to_string())
}

/// 在访达里打开一个文件夹
#[tauri::command(async)]
pub fn open_path(path: String) -> Result<(), String> {
    // 只开文件夹：对文件执行 open 等于运行它（.app、.command）
    if !Path::new(&path).is_dir() {
        return Err(format!("不是一个文件夹：{path}"));
    }
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打不开 {path}：{e}"))
}
