# DocAgent

本地文档智能体工作台：导入资料，向它提问，每个结论都能点回原文。

Tauri 2 + React + Rust，agent 用 Claude Agent SDK，向量检索用 SQLite 的 sqlite-vec。

## 能做什么

- **导入** PDF / DOCX / Markdown / TXT，自动解析、分块、建索引
- **提问**：agent 自己决定检索什么、要不要换个说法再查，流式输出 Markdown
- **引用溯源**：回答下方的引用可以点开，看到原文片段；PDF 会渲染那一页
- **拒答**：资料里没有就明说没有，不编
- **审批**：助手要保存文件时先弹窗给你看内容，同意了才写
- **会话持久化**：对话存在本地，关掉重开能接着聊（上下文也在）
- **范围限定**：勾选文档后只在选中的资料里检索

## 结构

```
WebView（React）  ←Tauri 命令/事件→  Rust  ←stdin/stdout JSON→  sidecar
                                      │                          （bun 单文件，内含 Agent SDK）
                                      └── SQLite + sqlite-vec          │
                                               ↑                       │
                                               └── 127.0.0.1 本地接口 ──┘
```

- **Rust**（`src-tauri/`）：文档解析与分块、存储（文档、向量、会话）、管理 sidecar 进程
- **sidecar**（`sidecar/agent.ts`）：agent 循环、工具调用、会话续接，全部交给 Claude Agent SDK
- **前端**（`src/`）：界面和阅读器（PDF 用 pdf.js 渲染）

sidecar 的工具（检索、保存）通过只绑本机、带一次性 token 的 HTTP 接口调回 Rust。

## 跑起来

需要 Rust、Node 22+、pnpm、bun。

```bash
pnpm install && (cd sidecar && bun install)
pnpm tauri dev
```

首次打开在「设置」里填接口地址、API Key 和模型名（任何 Anthropic 兼容接口）。

打包：

```bash
(cd sidecar && bun run compile)   # sidecar 编成单文件，约 75 MB
pnpm tauri build
```

## 测试

```bash
pnpm test                                   # 前端：分块、引用解析
cd src-tauri && cargo test                  # Rust：索引、检索、会话、文件名净化
DOCAGENT_TEST_KEY=sk-... cargo test --test e2e -- --ignored --nocapture
```

最后一条是端到端测试，用真实模型走完：导入 → 提问带引用 → 续聊 → 拒答 → 拒绝审批不落盘 → 同意审批落盘。

## 数据去哪了

- 文档、索引、会话、设置：全在本机 `~/Library/Application Support/dev.local.docagent/`
- **出网的只有一样**：提问时，问题和检索命中的片段会发给你配置的模型接口
- agent 的配置目录是 app 自己的，不读也不写你的 `~/.claude`
- agent 只有两个工具（检索、保存），内置的文件读写、shell、联网工具全部关闭
- 保存的文件固定写到 `文稿/DocAgent/`，文件名里的路径成分会被去掉

## 已知限制

- 向量是本地哈希（字符 n-gram），只做字面匹配，同义不同词可能查不到；靠 agent 多次换词检索来弥补
- 扫描版 PDF 没有文字层，需要 OCR，暂不支持
- macOS 包未签名，首次打开要在「系统设置 → 隐私与安全性」里允许
- API Key 明文存在本机数据库里

## 许可

AGPL-3.0。界面的设计系统来自 ArcReel，见 [NOTICE](NOTICE)。
