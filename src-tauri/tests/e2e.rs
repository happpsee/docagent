//! 端到端：真实索引 + 本地接口 + sidecar（Agent SDK）+ 真实模型。
//!
//! 需要 bun 和一个可用的 API key，所以默认忽略。手动跑：
//!   DOCAGENT_TEST_KEY=sk-... cargo test --test e2e -- --ignored --nocapture
//! 可选：DOCAGENT_TEST_BASE_URL / DOCAGENT_TEST_MODEL

use docagent_lib::{chunk, db, parse, server};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

/// 和应用里的导入走同一条链路：Rust 解析 → 分块
fn chunks(path: &Path) -> (Vec<db::TextChunk>, &'static str, Option<i64>) {
    let parsed = parse::extract(path).expect("解析失败");
    let chunks = chunk::chunk_pages(&parsed.pages)
        .into_iter()
        .map(|c| db::TextChunk {
            idx: c.idx,
            page: c.page,
            text: c.text,
        })
        .collect();
    (chunks, parsed.kind, parsed.page_count)
}

struct Run {
    answer: String,
    searches: usize,
    hits: usize,
    session: Option<String>,
    approvals: usize,
    saved: bool,
}

fn ask(
    root: &Path,
    api: &server::LocalApi,
    config_dir: &Path,
    question: &str,
    resume: Option<&str>,
    allow_save: bool,
) -> Run {
    let key = std::env::var("DOCAGENT_TEST_KEY").expect("需要 DOCAGENT_TEST_KEY");
    let base = std::env::var("DOCAGENT_TEST_BASE_URL")
        .unwrap_or_else(|_| "https://api.deepseek.com/anthropic".into());
    let model = std::env::var("DOCAGENT_TEST_MODEL").unwrap_or_else(|_| "deepseek-flash".into());
    // bun 的安装位置不固定（官方脚本、npm、brew 各不相同），交给 PATH
    let mut child = Command::new("bun")
        .arg("run")
        .arg(root.join("sidecar/agent.ts"))
        .env("DOCAGENT_API", format!("http://127.0.0.1:{}", api.port))
        .env("DOCAGENT_TOKEN", &api.token)
        .env("DOCAGENT_BASE_URL", base)
        .env("DOCAGENT_API_KEY", key)
        .env("DOCAGENT_MODEL", model)
        .env("DOCAGENT_CONFIG_DIR", config_dir)
        .current_dir(config_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动 sidecar 失败");
    let mut stdin = child.stdin.take().unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());

    let mut run = Run {
        answer: String::new(),
        searches: 0,
        hits: 0,
        session: None,
        approvals: 0,
        saved: false,
    };
    for line in stdout.lines().map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v["type"].as_str().unwrap_or("") {
            "ready" => {
                let mut msg =
                    serde_json::json!({ "type": "ask", "id": "e2e", "question": question, "k": 6 });
                if let Some(r) = resume {
                    msg["sessionId"] = r.into();
                }
                writeln!(stdin, "{msg}").unwrap();
            }
            "session" => run.session = v["sessionId"].as_str().map(String::from),
            "tool" => {
                let name = v["name"].as_str().unwrap_or("");
                if name.ends_with("search_docs") {
                    run.searches += 1;
                }
                println!("  工具 {name} {}", v["input"]);
            }
            "approval_request" => {
                run.approvals += 1;
                let reply = serde_json::json!({ "type": "approval", "requestId": v["requestId"], "allow": allow_save });
                writeln!(stdin, "{reply}").unwrap();
            }
            "tool_result" => {
                if v["text"].as_str().unwrap_or("").contains("已保存到") {
                    run.saved = true;
                }
            }
            "result" => {
                run.answer = v["text"].as_str().unwrap_or("").to_string();
                run.hits = v["hits"].as_array().map(|a| a.len()).unwrap_or(0);
                break;
            }
            "error" => panic!("sidecar 报错：{}", v["message"]),
            _ => {}
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    run
}

#[test]
#[ignore]
fn 导入文档_提问_引用_拒答_续聊_审批保存() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let tmp = std::env::temp_dir().join(format!("docagent-e2e-{}", std::process::id()));
    let config_dir = tmp.join("claude");
    let save_dir = tmp.join("saved");
    std::fs::create_dir_all(&config_dir).unwrap();

    // 1. 建库并导入两份测试合同
    let mut conn = db::open(&tmp.join("test.db")).unwrap();
    // 采购合同用 PDF 版本，顺带验证 PDF 的页码能带到引用里
    for name in ["采购合同.pdf", "服务协议.md"] {
        let (chunks, kind, pages) = chunks(&root.join("test-docs").join(name));
        db::add_document_text(&mut conn, name, None, kind, pages, &chunks).unwrap();
    }
    let conn = Arc::new(Mutex::new(conn));
    let api = server::start(conn, save_dir.clone()).unwrap();

    // 2. 事实性问题：应检索并答出 24 个月，带引用
    println!("\n[问] 采购合同的质保期多久？");
    let r1 = ask(
        &root,
        &api,
        &config_dir,
        "采购合同的质保期多久？",
        None,
        false,
    );
    println!("[答] {}\n", r1.answer);
    assert!(r1.searches >= 1, "应至少检索一次");
    assert!(r1.hits >= 1, "应有命中片段");
    assert!(
        r1.answer.contains("24"),
        "答案应包含 24 个月：{}",
        r1.answer
    );
    assert!(
        r1.answer.contains("[1]") || r1.answer.contains('['),
        "答案应带引用编号"
    );
    let session = r1.session.clone().expect("应拿到会话 id");

    // 3. 续聊：不重复说是哪份合同，靠会话上下文理解「它」
    println!("[问] 那它的付款分几期？（续接上一轮会话）");
    let r2 = ask(
        &root,
        &api,
        &config_dir,
        "那它的付款分几期？",
        Some(&session),
        false,
    );
    println!("[答] {}\n", r2.answer);
    assert!(
        r2.answer.contains('三') || r2.answer.contains('3'),
        "应答出三期：{}",
        r2.answer
    );

    // 4. 资料里没有的问题：应拒答而不是编
    println!("[问] 甲方公司的注册资本是多少？");
    let r3 = ask(
        &root,
        &api,
        &config_dir,
        "甲方公司的注册资本是多少？",
        None,
        false,
    );
    println!("[答] {}\n", r3.answer);
    assert!(
        r3.answer.contains("没有"),
        "应明确说资料里没有：{}",
        r3.answer
    );

    // 4b. 文档没讲的通用知识：可以用自身知识回答，但要说明不是出自文档，且不能挂引用
    println!("[问] 贸易术语 FOB 是什么意思？");
    let r3b = ask(
        &root,
        &api,
        &config_dir,
        "贸易术语 FOB 是什么意思？",
        None,
        false,
    );
    println!("[答] {}\n", r3b.answer);
    assert!(
        r3b.answer.contains("船")
            || r3b.answer.contains("离岸")
            || r3b.answer.contains("Free On Board"),
        "应能用自身知识解释 FOB：{}",
        r3b.answer
    );
    assert!(
        r3b.answer.contains("文档"),
        "应说明这部分不是出自用户文档：{}",
        r3b.answer
    );

    // 4c. 读本地项目：应请求读取许可，放行后能说出代码里的接口
    let proj = tmp.join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::write(
        proj.join("main.py"),
        "from fastapi import FastAPI\napp = FastAPI()\n\n@app.get(\"/orders/{order_id}\")\ndef get_order(order_id: int):\n    return {\"id\": order_id}\n",
    )
    .unwrap();
    let q = format!("看一下 {} 这个项目，它提供了哪些接口？", proj.display());
    println!("[问] {q}");
    let r3c = ask(&root, &api, &config_dir, &q, None, true);
    println!("[答] {}\n", r3c.answer);
    assert!(r3c.approvals >= 1, "读本地目录前应请求许可");
    assert!(
        r3c.answer.contains("orders"),
        "应读到代码里的接口：{}",
        r3c.answer
    );

    // 5. 保存文件：必须先过审批；拒绝后不应落盘
    println!("[问] 把采购合同的付款条款保存成文件（这次拒绝审批）");
    let r4 = ask(
        &root,
        &api,
        &config_dir,
        "把采购合同的付款条款整理后用 save_note 保存成 付款条款.md",
        None,
        false,
    );
    println!("[答] {}\n", r4.answer);
    assert!(r4.approvals >= 1, "保存前应请求审批");
    assert!(
        !r4.saved && !save_dir.join("付款条款.md").exists(),
        "拒绝后不应写文件"
    );

    // 6. 同意审批后应落盘
    println!("[问] 同样的请求（这次同意审批）");
    let r5 = ask(
        &root,
        &api,
        &config_dir,
        "把采购合同的付款条款整理后用 save_note 保存成 付款条款.md",
        None,
        true,
    );
    println!("[答] {}\n", r5.answer);
    assert!(r5.approvals >= 1 && r5.saved, "同意后应保存成功");
    let saved = std::fs::read_to_string(save_dir.join("付款条款.md")).expect("文件应存在");
    assert!(
        saved.contains("30%") || saved.contains("预付款"),
        "保存的内容应来自合同：{saved}"
    );

    let _ = std::fs::remove_dir_all(&tmp);
}
