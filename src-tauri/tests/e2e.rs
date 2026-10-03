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
        // 用户级配置放在临时目录里，不碰真实的 ~/.docagent
        .env(
            "DOCAGENT_USER_DIR",
            config_dir.parent().unwrap().join("user-docagent"),
        )
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
        let path = root.join("test-docs").join(name);
        let (chunks, kind, pages) = chunks(&path);
        db::import_document(
            &mut conn,
            &db::NewDoc {
                title: name,
                path: &path.to_string_lossy(),
                kind,
                pages,
                author: None,
                cover: None,
            },
            &chunks,
        )
        .unwrap();
    }
    // 再导入一本 EPUB，并在上面划一条带笔记的高亮（模拟用户在阅读器里的操作）
    let epub = root.join("test-docs/示例小说.epub");
    let parsed = parse::extract(&epub).unwrap();
    let (book_chunks, _, _) = chunks(&epub);
    let book_id = db::import_document(
        &mut conn,
        &db::NewDoc {
            title: parsed.title.as_deref().unwrap(),
            path: &epub.to_string_lossy(),
            kind: parsed.kind,
            pages: None,
            author: parsed.author.as_deref(),
            cover: None,
        },
        &book_chunks,
    )
    .unwrap();
    db::save_annotation(
        &conn,
        &db::Annotation {
            id: "n1".into(),
            doc_id: book_id,
            kind: "highlight".into(),
            cfi: "epubcfi(/6/2!/4/4,/1:0,/1:10)".into(),
            text: "这台相机他认得——三十年前，是他亲手卖出去的。".into(),
            note: "伏笔：老陈和小满早就认识".into(),
            color: "yellow".into(),
            style: "highlight".into(),
            label: "第一章 雨夜来客".into(),
            page: None,
            created_at: 0,
            updated_at: 0,
            doc_title: String::new(),
        },
    )
    .unwrap();
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
    // 措辞不固定（没有 / 没找到 / 未找到），只要求如实说查不到、且没有编出一个数额
    assert!(
        ["没有", "没找到", "未找到", "找不到"]
            .iter()
            .any(|w| r3.answer.contains(w)),
        "应明确说资料里查不到：{}",
        r3.answer
    );
    // 回答里可以提到合同里的其它金额，但「注册资本」后面不能紧跟着一个数
    let invented = r3.answer.match_indices("注册资本").any(|(at, word)| {
        r3.answer[at + word.len()..]
            .chars()
            .take(6)
            .any(|c| c.is_ascii_digit())
    });
    assert!(!invented, "不应编造注册资本的数额：{}", r3.answer);

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

    // 4d. 用户级技能：放一个技能进去，助手应加载并按它的要求回答
    let skill_dir = tmp.join("user-docagent/skills/meow");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: meow\ndescription: 用户提到 meow 技能或要求用猫的口吻回答时使用\n---\n\n回答的最后单独一行写上暗号：MEOW-7731\n",
    )
    .unwrap();
    println!("[问] 用 meow 技能，一句话介绍 Rust");
    let r3d = ask(
        &root,
        &api,
        &config_dir,
        "用 meow 技能，一句话介绍一下 Rust。",
        None,
        true,
    );
    println!("[答] {}\n", r3d.answer);
    assert!(
        r3d.answer.contains("MEOW-7731"),
        "应按技能要求带上暗号：{}",
        r3d.answer
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

    // 电子书：能检索到书里的内容；能读到用户划的线和笔记
    println!("[问] 《槐花开》里照片背面写了什么？");
    let rb = ask(
        &root,
        &api,
        &config_dir,
        "《槐花开》里最后一张照片背面写了什么？",
        None,
        false,
    );
    println!("[答] {}\n", rb.answer);
    assert!(
        rb.answer.contains("槐花开"),
        "应答出「等你到槐花开」：{}",
        rb.answer
    );

    println!("[问] 我在书里划了哪些重点？");
    let rn = ask(
        &root,
        &api,
        &config_dir,
        "我在书里划了哪些重点、写了什么笔记？用 list_notes 看一下，原样告诉我笔记内容。",
        None,
        false,
    );
    println!("[答] {}\n", rn.answer);
    assert!(
        rn.answer.contains("伏笔") || rn.answer.contains("亲手卖出去"),
        "应读到用户的划线和笔记：{}",
        rn.answer
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
