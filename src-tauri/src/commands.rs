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

/// 能在应用里直接改的格式：纯文本类的。别的格式（PDF、EPUB、Word）改不了
const EDITABLE: [&str; 2] = ["md", "txt"];

/// 取一篇的原文（没经过任何整理的文件内容），给编辑用
#[tauri::command]
pub async fn document_source(state: State<'_, AppState>, doc_id: String) -> Result<String, String> {
    let part = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        crate::books::part(&conn, &doc_id).map_err(e)?
    }
    .ok_or_else(|| "这一篇已经不在书架上了".to_string())?;
    if !EDITABLE.contains(&part.kind.as_str()) {
        return Err("这种格式不能在这里编辑".to_string());
    }
    let path = part.path.ok_or_else(|| "找不到原文件".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path)
            .map(|bytes| parse::decode_text(&bytes))
            .map_err(|err| format!("读不到文件 {path}：{err}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把改过的内容写回原文件，并马上重建这一篇的索引。
/// 只认书架上的篇（路径由这边按 id 查，不从界面传），只认纯文本类的格式。
#[tauri::command]
pub async fn save_document_source(
    app: AppHandle,
    state: State<'_, AppState>,
    doc_id: String,
    content: String,
) -> Result<(), String> {
    let conn = state.conn.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let part = {
            let c = conn.lock().map_err(|_| LOCK.to_string())?;
            crate::books::part(&c, &doc_id).map_err(e)?
        }
        .ok_or_else(|| "这一篇已经不在书架上了".to_string())?;
        if !EDITABLE.contains(&part.kind.as_str()) {
            return Err("这种格式不能在这里编辑".to_string());
        }
        let path = part.path.ok_or_else(|| "找不到原文件".to_string())?;
        // 先写到旁边的临时文件再换过去：写到一半出事（磁盘满、断电）不会把原文件弄成半截
        let tmp = format!("{path}.docagent-tmp");
        std::fs::write(&tmp, &content).map_err(|err| format!("写不了 {path}：{err}"))?;
        std::fs::rename(&tmp, &path).map_err(|err| {
            let _ = std::fs::remove_file(&tmp);
            format!("写不了 {path}：{err}")
        })?;
        // 内容变了：这一篇的片段和索引跟着重建（文字没变的话什么都不动）
        let item = import::ImportItem {
            path,
            mode: Default::default(),
            files: None,
        };
        let summary = import::run(&conn, &[item], &|_| {});
        if let Some(why) = summary.failed.first() {
            return Err(format!("已经保存，但重建索引失败：{why}"));
        }
        spawn_fill_vectors(app.clone());
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 试一下模型接口通不通：发一句最短的话，看有没有回话。返回用了多少毫秒
#[tauri::command]
pub async fn test_model(base_url: String, api_key: String, model: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let provider: Provider = serde_json::from_value(serde_json::json!({
            "baseUrl": base_url.trim(), "apiKey": api_key.trim(), "model": model.trim(),
        }))
        .map_err(|e| e.to_string())?;
        let t = std::time::Instant::now();
        crate::llm::complete(&provider, "只回答一个字。", "好", 16).map_err(e)?;
        Ok(t.elapsed().as_millis() as u64)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 试一下向量接口：算一句话的向量，返回它的维度
#[tauri::command]
pub async fn test_embedding(
    base_url: String,
    api_key: String,
    model: String,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = crate::embed::EmbedConfig {
            base_url: base_url.trim().to_string(),
            api_key: api_key.trim().to_string(),
            model: model.trim().to_string(),
        };
        crate::embed::embed(&cfg, &["测试"], std::time::Duration::from_secs(20))
            .map(|v| v[0].len())
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

// ---------- 学习：出题、批改、掌握度 ----------

fn provider_of(state: &State<'_, AppState>) -> Result<Provider, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    let provider: Provider = db::get_setting(&conn, SETTINGS_KEY)
        .map_err(e)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if provider.api_key.is_empty() || provider.base_url.is_empty() || provider.model.is_empty() {
        return Err("还没配置模型：请在设置里填接口地址、API Key 和模型名".to_string());
    }
    Ok(provider)
}

/// 一篇分成的段，和每段出没出过题。界面靠它知道「刚读完的是哪一段」
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizUnit {
    unit: i64,
    page: Option<i64>,
    start: f64,
    end: f64,
    quizzed: bool,
    /// 这一段多少字
    chars: i64,
    /// 这一段考的概念掌握得怎么样（0–1）；没出过题是 null
    mastery: Option<f64>,
}

#[tauri::command(async)]
pub fn quiz_units(state: State<'_, AppState>, doc_id: String) -> Result<Vec<QuizUnit>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    let Some(part) = crate::books::part(&conn, &doc_id).map_err(e)? else {
        return Ok(vec![]);
    };
    let mut stmt = conn
        .prepare("SELECT DISTINCT unit FROM quiz_items WHERE doc_id = ?1")
        .map_err(|err| err.to_string())?;
    let done: std::collections::HashSet<i64> = stmt
        .query_map([&doc_id], |r| r.get(0))
        .and_then(|rows| rows.collect())
        .map_err(|err| err.to_string())?;
    let mastery = crate::learn::unit_mastery(&conn, &doc_id, db::now()).map_err(e)?;
    let lengths: Vec<i64> = conn
        .prepare("SELECT length(text) FROM chunks WHERE doc_id = ?1 ORDER BY idx, id")
        .and_then(|mut stmt| stmt.query_map([&doc_id], |r| r.get(0))?.collect())
        .map_err(|err| err.to_string())?;
    Ok(crate::xray::plan(&conn, &doc_id, &part.kind)
        .map_err(e)?
        .into_iter()
        .map(|u| QuizUnit {
            unit: u.index,
            page: u.page,
            start: u.start,
            end: u.end,
            quizzed: done.contains(&u.index),
            chars: lengths.get(u.first..u.upto.min(lengths.len())).map(|s| s.iter().sum()).unwrap_or(0),
            mastery: mastery.get(&u.index).copied(),
        })
        .collect())
}

/// 一段的题。出过就用存着的；没出过现出（一次模型调用）
#[tauri::command(async)]
pub fn quiz_unit(
    state: State<'_, AppState>,
    book_id: String,
    doc_id: String,
    unit: i64,
) -> Result<Vec<crate::learn::Item>, String> {
    let (text, concepts) = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        let had = crate::learn::items_for_unit(&conn, &doc_id, unit).map_err(e)?;
        if !had.is_empty() {
            return Ok(had);
        }
        let part = crate::books::part(&conn, &doc_id)
            .map_err(e)?
            .ok_or("这一篇不在书架上了")?;
        let plan = crate::xray::plan(&conn, &doc_id, &part.kind).map_err(e)?;
        let u = plan.iter().find(|u| u.index == unit).ok_or("找不到这一段")?;
        let text = crate::xray::unit_text(&conn, &doc_id, u).map_err(e)?;
        // 透视过的段：题目考的概念沿用透视里的名字，掌握度才能落到关系图的同一个点上
        let concepts: Vec<String> = conn
            .query_row(
                "SELECT entities FROM xray_units WHERE doc_id = ?1 AND unit = ?2",
                rusqlite::params![doc_id, unit],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<crate::xray::Entity>>(&raw).ok())
            .map(|list| list.into_iter().map(|x| x.name).collect())
            .unwrap_or_default();
        (text, concepts)
    };
    if text.trim().chars().count() < 200 {
        return Err("这一段内容太少，出不了题".to_string());
    }
    let provider = provider_of(&state)?;
    let ask = || {
        crate::llm::complete(
            &provider,
            crate::learn::GEN_SYSTEM,
            &crate::learn::gen_prompt(&text, &concepts),
            1500,
        )
        .and_then(|reply| crate::learn::parse_items(&reply, &text))
    };
    let items = ask().or_else(|_| ask()).map_err(e)?;
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    // 模型想的这段时间里别处也出了这一段的题：用先存下的那份
    let had = crate::learn::items_for_unit(&conn, &doc_id, unit).map_err(e)?;
    if !had.is_empty() {
        return Ok(had);
    }
    crate::learn::save_items(&conn, &book_id, &doc_id, unit, &items, db::now()).map_err(e)?;
    crate::learn::items_for_unit(&conn, &doc_id, unit).map_err(e)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizResult {
    grade: &'static str,
    missing: Vec<String>,
    feedback: String,
    /// 这个概念下次什么时候复习
    due: i64,
}

/// 交一道题的回答。answer 为空是「不会」：不用问模型，直接记没答上来
#[tauri::command(async)]
pub fn quiz_answer(
    state: State<'_, AppState>,
    item_id: i64,
    answer: String,
) -> Result<QuizResult, String> {
    let item = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        crate::learn::item(&conn, item_id).map_err(e)?.ok_or("这道题不在了")?
    };
    let verdict = if answer.trim().is_empty() {
        crate::learn::Verdict {
            grade: crate::learn::Grade::Lapsed,
            missing: item.rubric.clone(),
            feedback: "先看一眼原文里是怎么说的，过会儿再考你一次。".to_string(),
            misconception: String::new(),
        }
    } else {
        let provider = provider_of(&state)?;
        let ask = || {
            crate::llm::complete(
                &provider,
                crate::learn::GRADE_SYSTEM,
                &crate::learn::grade_prompt(&item, answer.trim()),
                600,
            )
            .and_then(|reply| crate::learn::parse_verdict(&reply, &item))
        };
        ask().or_else(|_| ask()).map_err(e)?
    };
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    let now = db::now();
    let due = crate::learn::apply(&conn, &item.book_id, &item.concept, verdict.grade, now).map_err(e)?;
    crate::learn::log_review(&conn, &item, answer.trim(), &verdict, now).map_err(e)?;
    crate::learn::note_verdict(&conn, &item, answer.trim(), &verdict, now).map_err(e)?;
    Ok(QuizResult {
        grade: verdict.grade.as_str(),
        missing: verdict.missing,
        feedback: verdict.feedback,
        due,
    })
}

/// 复习时换个问法：这道题答过了，就给同一个概念另一道——没攒够就现出一道新的，攒够了在已有的里轮着问。
/// 没答过的原样返回。出不成新题不算错，退回原题
#[tauri::command(async)]
pub fn quiz_variant(state: State<'_, AppState>, item_id: i64) -> Result<crate::learn::Item, String> {
    let (item, text, asked, wrong) = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        let item = crate::learn::item(&conn, item_id).map_err(e)?.ok_or("这道题不在了")?;
        if !crate::learn::answered(&conn, item_id).map_err(e)? {
            return Ok(item);
        }
        let all = crate::learn::items_for_concept(&conn, &item.book_id, &item.concept).map_err(e)?;
        if all.len() >= crate::learn::MAX_PER_CONCEPT {
            return Ok(crate::learn::stalest(&conn, &item.book_id, &item.concept)
                .map_err(e)?
                .unwrap_or(item));
        }
        let text = crate::books::part(&conn, &item.doc_id)
            .ok()
            .flatten()
            .and_then(|part| crate::xray::plan(&conn, &item.doc_id, &part.kind).ok())
            .and_then(|plan| plan.into_iter().find(|u| u.index == item.unit))
            .and_then(|u| crate::xray::unit_text(&conn, &item.doc_id, &u).ok())
            .unwrap_or_default();
        // 原文变了（重新导入后分段不一样了）：依据都对不上，就别出新题了
        if !text.split_whitespace().collect::<String>().contains(&item.evidence.split_whitespace().collect::<String>()) {
            return Ok(item);
        }
        let asked: Vec<String> = all.into_iter().map(|i| i.question).collect();
        let wrong = crate::learn::misconception(&conn, &item.book_id, &item.concept).map_err(e)?;
        (item, text, asked, wrong)
    };
    let Ok(provider) = provider_of(&state) else {
        return Ok(item);
    };
    let fresh = crate::llm::complete(
        &provider,
        crate::learn::GEN_SYSTEM,
        &crate::learn::variant_prompt(&text, &item.concept, &asked, wrong.as_deref()),
        800,
    )
    .and_then(|reply| crate::learn::parse_items(&reply, &text));
    let Ok(mut fresh) = fresh else {
        return Ok(item);
    };
    fresh.truncate(1);
    // 概念名以原来的为准：模型换了个写法的话，掌握度就记到另一个点上去了
    fresh[0].concept = item.concept.clone();
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::learn::save_items(&conn, &item.book_id, &item.doc_id, item.unit, &fresh, db::now()).map_err(e)?;
    Ok(crate::learn::items_for_concept(&conn, &item.book_id, &item.concept)
        .map_err(e)?
        .pop()
        .unwrap_or(item))
}

/// 到了一个决策点：让模型决定要不要打断读者、提什么建议。能不能来问（频率）由界面先把关
#[tauri::command(async)]
pub fn coach_decide(
    state: State<'_, AppState>,
    book_id: String,
    signal: crate::coach::Signal,
) -> Result<crate::coach::Decision, String> {
    let prompt = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        let title: String = conn
            .query_row("SELECT title FROM books WHERE id = ?1", [&book_id], |r| r.get(0))
            .map_err(|err| err.to_string())?;
        crate::coach::prompt(&conn, &book_id, &title, &signal, db::now()).map_err(e)?
    };
    let provider = provider_of(&state)?;
    let ask = || {
        crate::llm::complete(&provider, crate::coach::SYSTEM, &prompt, 300)
            .and_then(|reply| crate::coach::parse(&reply))
    };
    ask().or_else(|_| ask()).map_err(e)
}

/// 考某一个概念：拿它最近的一道题（没出过题就是空的）。助手在对话里提出「考你一道」时用
#[tauri::command(async)]
pub fn quiz_concept(
    state: State<'_, AppState>,
    book_id: String,
    concept: String,
) -> Result<Vec<crate::learn::Item>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    Ok(crate::learn::items_for_concept(&conn, &book_id, &concept)
        .map_err(e)?
        .pop()
        .into_iter()
        .collect())
}

/// 忽略 / 恢复一个概念：忽略的不提醒复习，也不算进「学会了多少」
#[tauri::command(async)]
pub fn learn_ignore(state: State<'_, AppState>, book_id: String, concept: String, on: bool) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::learn::set_ignored(&conn, &book_id, &concept, on, db::now()).map_err(e)
}

/// 关于读者本人的那些话：背景、偏好、强项、弱项、易错点
#[tauri::command(async)]
pub fn learner_notes(state: State<'_, AppState>) -> Result<Vec<crate::learn::LearnerNote>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::learn::notes(&conn).map_err(e)
}

#[tauri::command(async)]
pub fn learner_note_save(state: State<'_, AppState>, id: Option<i64>, kind: String, content: String) -> Result<(), String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("内容是空的".to_string());
    }
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::learn::save_note(&conn, id, &kind, content, db::now()).map_err(e)
}

#[tauri::command(async)]
pub fn learner_note_delete(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::learn::delete_note(&conn, id).map_err(e)
}

/// 这一程读下来的小结：since 是打开这本书的时刻（秒）
#[tauri::command(async)]
pub fn reading_trip(state: State<'_, AppState>, book_id: String, since: i64) -> Result<crate::learn::Trip, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::learn::trip(&conn, &book_id, since).map_err(e)
}

/// 把这本书里还没出过题的划线变成复习题（一次模型调用，最多 12 句）。返回出了几道
#[tauri::command(async)]
pub fn quiz_from_marks(state: State<'_, AppState>, book_id: String) -> Result<usize, String> {
    let (marks, concepts) = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        let marks = crate::learn::pending_marks(&conn, &book_id, 12).map_err(e)?;
        let concepts: Vec<String> = crate::learn::overview(&conn, &book_id, db::now())
            .map_err(e)?
            .concepts
            .into_iter()
            .map(|c| c.concept)
            .take(40)
            .collect();
        (marks, concepts)
    };
    if marks.is_empty() {
        return Ok(0);
    }
    let provider = provider_of(&state)?;
    let reply = crate::llm::complete(
        &provider,
        crate::learn::GEN_SYSTEM,
        &crate::learn::marks_prompt(&marks, &concepts),
        2000,
    )
    .map_err(e)?;
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::learn::save_mark_items(&conn, &book_id, &marks, &reply, db::now()).map_err(e)
}

/// 现在该复习的题；book_id 为空是所有书的
#[tauri::command(async)]
pub fn quiz_due(
    state: State<'_, AppState>,
    book_id: Option<String>,
) -> Result<Vec<crate::learn::Item>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::learn::due_items(&conn, book_id.as_deref(), db::now(), 20).map_err(e)
}

/// 一本书学得怎么样：每个考过的概念的掌握度、学会了多少、该复习几个
#[tauri::command(async)]
pub fn learn_overview(
    state: State<'_, AppState>,
    book_id: String,
) -> Result<crate::learn::Overview, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::learn::overview(&conn, &book_id, db::now()).map_err(e)
}

/// 书架用：考过题的每本书的概况
#[tauri::command(async)]
pub fn learn_overviews(state: State<'_, AppState>) -> Result<Vec<crate::learn::Overview>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::learn::overviews(&conn, db::now()).map_err(e)
}

/// 前情提要。notes 是界面挑好的「读过那些段的要点」（没做过透视就是空的，这里改用原文）；
/// 同一个位置算过就直接给存着的，fresh 是要求重写
#[tauri::command(async)]
pub fn recap(
    state: State<'_, AppState>,
    book_id: String,
    doc_id: String,
    fraction: f64,
    notes: String,
    fresh: bool,
) -> Result<String, String> {
    let key = crate::recap::key(&doc_id, fraction, &notes);
    let (provider, title, text): (Provider, String, String) = {
        let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
        if !fresh {
            if let Some(text) = crate::recap::cached(&conn, &book_id, &key).map_err(e)? {
                return Ok(text);
            }
        }
        let provider = db::get_setting(&conn, SETTINGS_KEY)
            .map_err(e)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let title: String = conn
            .query_row("SELECT title FROM books WHERE id = ?1", [&book_id], |r| r.get(0))
            .map_err(|err| err.to_string())?;
        let text = if notes.trim().is_empty() {
            crate::recap::text_before(&conn, &doc_id, fraction).map_err(e)?
        } else {
            String::new()
        };
        (provider, title, text)
    };
    if provider.api_key.is_empty() || provider.base_url.is_empty() || provider.model.is_empty() {
        return Err("还没配置模型：请在设置里填接口地址、API Key 和模型名".to_string());
    }
    if notes.trim().is_empty() && text.trim().chars().count() < 200 {
        return Err("读过的内容还太少，没什么可回顾的".to_string());
    }
    let out = crate::llm::complete(
        &provider,
        crate::recap::SYSTEM,
        &crate::recap::prompt(&title, &notes, &text),
        600,
    )
    .map_err(e)?;
    let out = out.trim().to_string();
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    crate::recap::store(&conn, &book_id, &key, &out).map_err(e)?;
    Ok(out)
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
