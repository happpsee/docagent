# 架构设计：本地大模型桌面应用

## 目标

在自己电脑上跑大模型的桌面应用。两个核心诉求：

1. **推理全程本地**，用户输入输出不出设备，且这一点可验证（不是口头承诺）。
2. **模型权重用 P2P 分发**，减少 CDN 流量成本；HTTP 下载兜底。

## 技术选型

| 领域 | 选型 | 理由 |
|---|---|---|
| 应用框架 | Tauri 2 | 系统 WebView，包体小；Rust 层能直接用 GPU、内存、文件系统 |
| 界面 | Vite + TypeScript | 前端技能直接复用；只负责渲染 |
| 推理 | Rust 原生，首选 candle（纯 Rust + Metal） | 无 wasm 的 4 GB 限制；备选 llama-cpp-2（模型覆盖全，需 cmake）；兜底 Ollama sidecar |
| 模型格式 | GGUF，mmap 加载 | 生态最广，量化选择多 |
| 下载 | HTTP Range（HuggingFace） | 断点续传；优先免登录仓库（Qwen / SmolLM 是 Apache-2.0） |
| P2P | iroh（QUIC + NAT 打洞） | 原生环境可直连；浏览器方案只能用 WebRTC，限制多 |
| 校验 | BLAKE3 + bao 校验组，先验证后落盘 | 从不可信 peer 下载必须内容寻址，防投毒 |

模型规模由内存决定：16 GB 机器约到 13B Q4，32 GB 可上 30B+。

## 模块划分

```
src-tauri/    应用层：命令注册、事件推送、状态持有，不含业务逻辑
protocol      纯逻辑：模型清单、分块换算、校验（零 I/O，最好测）
engine        推理：Backend trait + 具体实现，无网络依赖
store         本地文件系统：模型库、下载中间态
transport     唯一允许联网：HTTP Range + iroh P2P + 多源调度
seed-node     公网常驻种子节点，为 P2P 保底
web/          界面，只通过 invoke / Channel 与 Rust 交互
```

## 数据流

**模型下载**：清单（含 BLAKE3 根哈希）→ transport 从 HTTP/peers 取分块 → protocol 逐块校验 → store 落盘。

**推理**：前端 invoke → 应用层 → engine 从本地文件 mmap 加载 → 逐 token 经 Channel 流式推回前端。

两条路径完全分离：上面那条只搬运模型文件，下面那条不碰网络。

## 隐私约束（结构性，非纪律性）

1. 网络代码只允许出现在 transport 与 seed-node；engine、protocol 不得引入任何网络依赖——review 时查依赖清单即可确认。
2. 未通过校验的字节不得成为正式模型文件。
3. 不做跨设备拆分推理：激活值可反演出用户输入，一拆隐私承诺就失效。
4. 界面提供出站连接面板，用户可逐条核对。

## 里程碑

| 阶段 | 内容 |
|---|---|
| M1 | 能聊天：加载本地 GGUF，流式输出，可停止 |
| M2 | 模型管理：下载、断点续传、校验、模型库界面 |
| M3 | P2P 分发：iroh 节点互传 + 种子节点 |
| M4 | 产品化：隐私面板、参数设置、打包签名 |

## 主要风险

- candle 对新模型架构的支持有限，M1 第一步就要验证；不行换 llama-cpp-2。
- Tauri 依赖多，首次编译慢。
- 桌面端节点在线率不高，HTTP 兜底与种子节点是必需品。
- 分发需要代码签名（macOS 公证需开发者账号）。
