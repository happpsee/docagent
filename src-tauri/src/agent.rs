//! sidecar 进程管理：启动、转发消息、重启。
//!
//! sidecar 是用 bun 编译的单文件（内含 Claude Agent SDK）。发布包里它在可执行文件旁边；
//! 开发时没有编译产物，就用 `bun run sidecar/agent.ts`。

use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Provider {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

pub struct Agent {
    child: Child,
    stdin: ChildStdin,
}

impl Agent {
    pub fn send(&mut self, line: &str) -> Result<()> {
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        Ok(())
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn command() -> Result<Command> {
    // 发布包：sidecar 在主程序旁边
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Windows 上这个文件叫 docagent-agent.exe
            let bundled = dir.join(format!("docagent-agent{}", std::env::consts::EXE_SUFFIX));
            if bundled.exists() {
                return Ok(Command::new(bundled));
            }
        }
    }
    // 开发：用 bun 直接跑源码
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar/agent.ts");
    if !script.exists() {
        return Err(anyhow!(
            "找不到 sidecar（既没有打包产物，也没有 {script:?}）"
        ));
    }
    // 开发时从终端启动，bun 在 PATH 里；安装位置不固定，不去猜路径
    let bun = "bun";
    let mut cmd = Command::new(bun);
    cmd.arg("run").arg(script);
    Ok(cmd)
}

pub fn spawn(
    app: AppHandle,
    api_port: u16,
    api_token: &str,
    provider: &Provider,
    config_dir: PathBuf,
) -> Result<Agent> {
    std::fs::create_dir_all(&config_dir)?;
    let mut cmd = command()?;
    cmd.env("DOCAGENT_API", format!("http://127.0.0.1:{api_port}"))
        .env("DOCAGENT_TOKEN", api_token)
        .env("DOCAGENT_BASE_URL", &provider.base_url)
        .env("DOCAGENT_API_KEY", &provider.api_key)
        .env("DOCAGENT_MODEL", &provider.model)
        // 用 app 自己的配置目录，和用户的 ~/.claude 完全隔离
        .env("DOCAGENT_CONFIG_DIR", &config_dir)
        .current_dir(&config_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| anyhow!("启动 sidecar 失败：{e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("拿不到 sidecar stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("拿不到 sidecar stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("拿不到 sidecar stderr"))?;

    // 每行一个 JSON，原样转给前端
    let app_out = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                let _ = app_out.emit("agent-event", v);
            }
        }
        let _ = app_out.emit("agent-event", serde_json::json!({ "type": "exited" }));
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[sidecar] {line}");
        }
    });

    Ok(Agent { child, stdin })
}
