/** 预览用的假数据：不在 Tauri 里运行时（直接用浏览器打开 dev server）走这里，
 *  方便调界面。不参与正式构建后的任何逻辑。 */
import samplePdf from "../../test-docs/采购合同.pdf?url";
import sampleMd from "../../test-docs/服务协议.md?raw";
import type { Hit, Message } from "./types";

const hits: Hit[] = [
  { chunkId: 1, docId: "d1", docTitle: "采购合同.pdf", idx: 2, page: 1, distance: 1.02,
    text: "第三条 付款条款 付款分三期： 1. 合同签订后 5 个工作日内支付 30% 预付款； 2. 设备验收合格后 15 个工作日内支付 60%； 3. 质保期满后支付剩余 10% 尾款。 逾期付款的，每日按未付金额的 0.03% 计违约金。" },
  { chunkId: 2, docId: "d2", docTitle: "服务协议.md", idx: 2, page: null, distance: 1.11,
    text: "服务费为每年 96000 元，按季度支付，每季度首月 10 日前支付 24000 元。\n甲方逾期支付超过 15 日的，乙方有权暂停服务。" },
];

const messages: Message[] = [
  { role: "user", content: "对比一下采购合同和服务协议的付款方式，然后存成一份文件" },
  {
    role: "assistant",
    content: "",
    hits,
    costUsd: 0.0132,
    durationMs: 14200,
    blocks: [
      { type: "tool", toolUseId: "t0", name: "TodoWrite", input: { todos: [
        { content: "查两份文档里的付款条款", status: "completed" },
        { content: "看一下项目里的合同模板", status: "completed" },
        { content: "整理成对比表", status: "in_progress", activeForm: "正在整理对比表" },
        { content: "保存成文件", status: "pending" },
      ] } },
      { type: "text", text: "我先分别查两份文档里的付款条款。" },
      { type: "tool", toolUseId: "t9", name: "Read", input: { file_path: "/Users/Admin/Desktop/awesome/templates/contract.md" }, result: "# 合同模板\n…" },
      { type: "tool", toolUseId: "t1", name: "mcp__docagent__search_docs", input: { query: "采购合同 付款条款 分期" },
        result: "[1] 《采购合同.pdf》第 3 页\n第三条 付款条款：付款分三期……" },
      { type: "tool", toolUseId: "t2", name: "mcp__docagent__search_docs", input: { query: "服务协议 服务费 支付周期" },
        result: "[2] 《服务协议.md》正文\n第三条 付款条款：服务费为每年 96000 元……" },
      { type: "text", text: "## 付款方式对比\n\n| | 采购合同 | 服务协议 |\n|---|---|---|\n| 总额 | 172000 元 | 每年 96000 元 |\n| 节奏 | 分三期：30% / 60% / 10% [1] | 按季度，每季 24000 元 [2] |\n| 逾期后果 | 每日按未付金额 0.03% 计违约金 [1] | 超过 15 日可暂停服务 [2] |\n\n**主要差别**：采购合同按交付节点付款，尾款压到质保期满；服务协议是固定周期预付。\n\n补充一点文档之外的常识：把 10% 尾款留到质保期满是设备采购里很常见的做法，用来约束售后——这一条不是出自你的文档。" },
      { type: "tool", toolUseId: "t3", name: "mcp__docagent__save_note",
        input: { filename: "付款方式对比.md", content: "# 付款方式对比\n\n| | 采购合同 | 服务协议 |\n|---|---|---|\n| 总额 | 172000 元 | 每年 96000 元 |\n…" },
        approval: { requestId: "ap1", state: "pending" } },
    ],
  },
];

const store: Record<string, unknown> = {
  list_documents: [
    { id: "d1", title: "采购合同.pdf", path: "sample.pdf", kind: "pdf", pages: 3, chunk_count: 34, created_at: 0 },
    { id: "d2", title: "服务协议.md", path: "sample.md", kind: "md", pages: null, chunk_count: 8, created_at: 0 },
    { id: "d3", title: "第一集剧本（定稿）.docx", path: null, kind: "docx", pages: null, chunk_count: 61, created_at: 0 },
  ],
  list_sessions: [
    { id: "s1", sdk_session_id: "x", title: "对比两份合同的付款方式", updated_at: Date.now() / 1000 - 120 },
    { id: "s2", sdk_session_id: "y", title: "第一集里有哪些夜戏？", updated_at: Date.now() / 1000 - 7200 },
    { id: "s3", sdk_session_id: "z", title: "质保期和违约责任", updated_at: Date.now() / 1000 - 172800 },
  ],
  get_setting: JSON.stringify({ baseUrl: "https://api.deepseek.com/anthropic", apiKey: "demo", model: "deepseek-flash", topK: 6 }),
  db_info: { docs: 3, chunks: 103, sessions: 3, dbPath: "~/Library/…/docagent.db", dbSizeBytes: 5_400_000, saveDir: "~/Documents/DocAgent" },
};

export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd === "get_messages") {
    const meta = (m: Message) => JSON.stringify({ blocks: m.blocks, hits: m.hits, costUsd: m.costUsd, durationMs: m.durationMs });
    return (args?.sessionId === "s1" ? messages.map((m) => ({ role: m.role, content: m.content, meta: meta(m) })) : []) as T;
  }
  if (cmd === "document_text") return sampleMd as T;
  if (cmd === "import_paths") return { imported: 0, failed: [] } as T;
  if (cmd === "read_file_bytes") {
    const buf = String(args?.path).endsWith(".pdf")
      ? new Uint8Array(await (await fetch(samplePdf)).arrayBuffer())
      : new TextEncoder().encode(sampleMd);
    return Array.from(buf) as T;
  }
  return (store[cmd] ?? null) as T;
}
