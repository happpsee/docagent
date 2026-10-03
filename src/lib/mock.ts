/** 预览用的假数据：不在 Tauri 里运行时（直接用浏览器打开 dev server）走这里，
 *  方便调界面。不参与正式构建后的任何逻辑。 */
import samplePdf from "../../test-docs/采购合同.pdf?url";
import sampleMd from "../../test-docs/服务协议.md?raw";
import sampleEpub from "../../test-docs/示例小说.epub?url";
import type { Annotation, Hit, Message } from "./types";

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
    { id: "d4", title: "槐花开", path: "sample.epub", kind: "epub", pages: null, chunk_count: 12, created_at: 0, author: "测试作者", progress: 0.37 },
  ],
  list_sessions: [
    { id: "s1", sdk_session_id: "x", title: "对比两份合同的付款方式", updated_at: Date.now() / 1000 - 120 },
    { id: "s2", sdk_session_id: "y", title: "第一集里有哪些夜戏？", updated_at: Date.now() / 1000 - 7200 },
    { id: "s3", sdk_session_id: "z", title: "质保期和违约责任", updated_at: Date.now() / 1000 - 172800 },
  ],
  get_setting: JSON.stringify({ baseUrl: "https://api.deepseek.com/anthropic", apiKey: "demo", model: "deepseek-flash", topK: 6, workspace: "/Users/Admin/Desktop/awemesome" }),
  db_info: { docs: 3, chunks: 103, sessions: 3, dbPath: "~/Library/…/docagent.db", dbSizeBytes: 5_400_000, saveDir: "~/Documents/DocAgent" },
};

const notes: Annotation[] = [];

const xray = {
  total: 3,
  units: [
    { unit: 0, page: 1, start: 0, end: 0.34, title: "雨夜来客", summary: "雨夜里一个年轻人带着一台旧胶片机来到老陈的修理店。老陈认出这台相机是自己三十年前卖出去的。",
      entities: [
        { name: "老陈", type: "人物", desc: "相机修理店的店主，三十年前卖出过这台相机", quote: "老陈把店门的卷帘拉到一半" },
        { name: "年轻人", type: "人物", desc: "雨夜带着旧相机来修的客人", quote: "一个浑身湿透的年轻人挤了进来" },
        { name: "小满", type: "人物", desc: "相机机身上刻着的受赠人名字", quote: "赠予小满，一九八七年秋" },
      ] },
    { unit: 1, page: 2, start: 0.34, end: 0.67, title: "一卷没洗的底片", summary: "相机里留着一卷没冲洗的胶片。年轻人说相机是刚过世的外婆留下的，老陈答应三天后交照片。",
      entities: [
        { name: "年轻人", type: "人物", desc: "相机是他外婆留下的，外婆上个月去世了", quote: "外婆上个月走了" },
        { name: "底片", type: "物品", desc: "卷片轴里一卷没冲洗的胶片，要等三天", quote: "卷片轴里还留着一卷没冲洗的胶片" },
      ] },
    { unit: 2, page: 3, start: 0.67, end: 1, title: "桥头的槐树", summary: "照片洗出来只有七张成像，都是一座石桥。最后一张背面写着“等你到槐花开”，老陈明白了小满是谁。",
      entities: [
        { name: "小满", type: "人物", desc: "照片上穿蓝布衫的姑娘，老陈认识她", quote: "他终于知道小满是谁了" },
        { name: "石桥", type: "地点", desc: "所有照片拍的同一个地方，桥头有棵槐树", quote: "一座石桥，桥头一棵槐树" },
      ] },
  ],
};

/** 预览里没有 Rust，用最简单的规则把示例 Markdown 排成书（正式环境是 Rust 的 render.rs） */
function mdBook(md: string) {
  const toc: { label: string; href: string; subitems: never[] }[] = [];
  let n = 0;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const inline = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const html = md
    .split(/\n{2,}/)
    .map((block) => {
      const h = /^(#{1,6})\s+(.*)$/.exec(block.trim());
      if (h) {
        n += 1;
        toc.push({ label: h[2], href: `s0#h${n}`, subitems: [] });
        return `<h${h[1].length} id="h${n}">${inline(h[2])}</h${h[1].length}>`;
      }
      return `<p>${inline(block).replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");
  return { sections: [{ id: "s0", html }], toc };
}

export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd === "get_messages") {
    const meta = (m: Message) => JSON.stringify({ blocks: m.blocks, hits: m.hits, costUsd: m.costUsd, durationMs: m.durationMs });
    return (args?.sessionId === "s1" ? messages.map((m) => ({ role: m.role, content: m.content, meta: meta(m) })) : []) as T;
  }
  if (cmd === "document_text") return sampleMd as T;
  if (cmd === "import_paths") return { imported: 0, failed: [] } as T;
  if (cmd === "read_file_bytes") {
    return (await (await fetch(args?.docId === "d4" ? sampleEpub : samplePdf)).arrayBuffer()) as T;
  }
  if (cmd === "document_book") return mdBook(sampleMd) as T;
  if (cmd === "xray_get") return (args?.docId === "d4" ? xray : { units: [], total: 0 }) as T;
  if (cmd === "list_annotations") return notes.filter((a) => !args?.docId || a.docId === args.docId) as T;
  if (cmd === "save_annotation") {
    const a = args?.annotation as Annotation;
    const i = notes.findIndex((x) => x.id === a.id);
    if (i >= 0) notes[i] = a;
    else notes.push(a);
    return null as T;
  }
  if (cmd === "delete_annotation") {
    const i = notes.findIndex((x) => x.id === args?.id);
    if (i >= 0) notes.splice(i, 1);
    return null as T;
  }
  return (store[cmd] ?? null) as T;
}
