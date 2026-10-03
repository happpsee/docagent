//! Tauri 命令：前端唯一能调用的入口。只做参数转换和错误包装。

use crate::agent::{self, Provider};
use crate::db::{self, DocOut, MessageOut, SessionOut, TextChunk};
use crate::AppState;
use crate::{chunk, parse};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tauri::{AppHandle, Manager, State};

fn e(err: anyhow::Error) -> String {
    err.to_string()
}
const LOCK: &str = "数据库锁异常";
const SETTINGS_KEY: &str = "settings";

// ---------- 文档 ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    name: String,
    /// parsing / indexing / done / error
    stage: &'static str,
    index: usize,
    total: usize,
    message: Option<String>,
}

#[derive(Serialize)]
pub struct ImportSummary {
    pub imported: usize,
    pub failed: Vec<String>,
}

/// 把用户选的路径展开成文件清单：文件夹递归找支持的类型，跳过隐藏文件
fn collect_files(paths: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for p in paths {
        let path = Path::new(p);
        if path.is_dir() {
            let walker = walkdir::WalkDir::new(path)
                .max_depth(8)
                .into_iter()
                // 用户亲手选的那个文件夹即使以 . 开头也要进；里面的隐藏项才跳过
                .filter_entry(|e| {
                    e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.')
                });
            for entry in walker.flatten() {
                if entry.file_type().is_file() && parse::kind_of(entry.path()).is_some() {
                    out.push(entry.into_path());
                }
            }
        } else {
            out.push(path.to_path_buf());
        }
    }
    out
}

fn import_one(
    conn: &std::sync::Mutex<rusqlite::Connection>,
    path: &Path,
    on_stage: impl Fn(&'static str),
) -> anyhow::Result<()> {
    on_stage("parsing");
    // 解析和分块不占数据库锁，别的操作（比如同时在提问检索）不会被卡住
    let parsed = parse::extract(path)?;
    let chunks: Vec<TextChunk> = chunk::chunk_pages(&parsed.pages)
        .into_iter()
        .map(|c| TextChunk {
            idx: c.idx,
            page: c.page,
            text: c.text,
        })
        .collect();
    // 漫画和扫描版 PDF 没有文字：照样能读，只是搜不到
    if chunks.is_empty() && !matches!(parsed.kind, "cbz" | "pdf") {
        anyhow::bail!("解析后没有内容");
    }
    on_stage("indexing");
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    // 电子书用书里写的书名，其它用文件名
    let title = parsed
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(&file_name);
    let cover = parsed.cover.as_deref().and_then(crate::ebook::thumbnail);
    let path_str = path.to_string_lossy().to_string();
    let mut conn = conn.lock().map_err(|_| anyhow::anyhow!(LOCK))?;
    db::import_document(
        &mut conn,
        &db::NewDoc {
            title,
            path: &path_str,
            kind: parsed.kind,
            pages: parsed.page_count,
            author: parsed.author.as_deref(),
            cover: cover.as_deref(),
        },
        &chunks,
    )?;
    Ok(())
}

/// 解析库遇到畸形文件可能 panic；兜住，变成这一个文件的失败，不连累同一批的其它文件
fn import_guarded(
    conn: &std::sync::Mutex<rusqlite::Connection>,
    path: &Path,
    on_stage: impl Fn(&'static str),
) -> anyhow::Result<()> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        import_one(conn, path, on_stage)
    }))
    .unwrap_or_else(|_| Err(anyhow::anyhow!("这个文件的结构解析不了")))
}

/// 导入文件或文件夹。解析在后台线程做，进度通过 import-progress 事件推给界面。
#[tauri::command]
pub async fn import_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<ImportSummary, String> {
    let conn = state.conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let files = collect_files(&paths);
        let total = files.len();
        let mut summary = ImportSummary {
            imported: 0,
            failed: vec![],
        };
        for (i, file) in files.iter().enumerate() {
            let name = file
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let emit = |stage: &'static str, message: Option<String>| {
                let _ = app.emit(
                    "import-progress",
                    ImportProgress {
                        name: name.clone(),
                        stage,
                        index: i + 1,
                        total,
                        message,
                    },
                );
            };
            match import_guarded(&conn, file, |stage| emit(stage, None)) {
                Ok(()) => {
                    summary.imported += 1;
                    emit("done", None);
                }
                Err(err) => {
                    summary.failed.push(format!("{name}：{err}"));
                    emit("error", Some(err.to_string()));
                }
            }
        }
        // 新片段的向量在后台补，不让导入等接口
        spawn_fill_vectors(app.clone());
        summary
    })
    .await
    .map_err(|e| e.to_string())
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

#[tauri::command(async)]
pub fn list_documents(state: State<'_, AppState>) -> Result<Vec<DocOut>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::list_documents(&conn).map_err(e)
}

#[tauri::command(async)]
pub fn delete_document(state: State<'_, AppState>, doc_id: String) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::delete_document(&mut conn, &doc_id).map_err(e)
}

/// 重建索引：按原文件把每份文档重新解析一遍。文档上的划线、笔记、进度都留着。
/// 原文件已经不在的文档会留在书架上，但搜不到内容，返回值里列出来。
#[tauri::command]
pub async fn reset_index(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ImportSummary, String> {
    let conn = state.conn.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || -> Result<ImportSummary, String> {
        let paths = {
            let mut c = conn.lock().map_err(|_| LOCK.to_string())?;
            db::clear_index(&mut c).map_err(e)?;
            db::doc_paths(&c).map_err(e)?
        };
        let mut summary = ImportSummary {
            imported: 0,
            failed: vec![],
        };
        for p in paths {
            match import_guarded(&conn, Path::new(&p), |_| {}) {
                Ok(()) => summary.imported += 1,
                Err(err) => summary.failed.push(format!("{p}：{err}")),
            }
        }
        Ok(summary)
    })
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

#[tauri::command(async)]
pub fn doc_cover(
    state: State<'_, AppState>,
    doc_id: String,
) -> Result<tauri::ipc::Response, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    let data = db::cover(&conn, &doc_id).map_err(e)?.unwrap_or_default();
    Ok(tauri::ipc::Response::new(data))
}

/// PDF 这类没法在 Rust 里取封面的，由阅读器渲染出第一页后送过来，这里缩成小图存库
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

#[tauri::command(async)]
pub fn list_annotations(
    state: State<'_, AppState>,
    doc_id: Option<String>,
) -> Result<Vec<db::Annotation>, String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    let ids = doc_id.map(|d| vec![d]);
    db::list_annotations(&conn, ids.as_deref()).map_err(e)
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

#[tauri::command(async)]
pub fn save_reading_state(
    state: State<'_, AppState>,
    doc_id: String,
    location: String,
    fraction: f64,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::save_reading_state(&conn, &doc_id, &location, fraction).map_err(e)
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

#[tauri::command(async)]
pub fn upsert_session(
    state: State<'_, AppState>,
    id: String,
    title: String,
    sdk_session_id: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| LOCK.to_string())?;
    db::upsert_session(&conn, &id, &title, sdk_session_id.as_deref()).map_err(e)
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
