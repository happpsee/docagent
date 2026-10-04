/** 预览用的假数据：不在 Tauri 里运行时（直接用浏览器打开 dev server）走这里，
 *  方便调界面。不参与正式构建后的任何逻辑。 */
import samplePdf from "../../test-docs/采购合同.pdf?url";
import sampleMd from "../../test-docs/服务协议.md?raw";
import sampleEpub from "../../test-docs/示例小说.epub?url";
import type { Annotation, Book, Doc, Hit, Message } from "./types";

const hits: Hit[] = [
  { chunkId: 1, docId: "d1", bookId: "b1", docTitle: "采购合同", docKind: "pdf", idx: 2, page: 1, distance: 1.02,
    text: "第三条 付款条款 付款分三期： 1. 合同签订后 5 个工作日内支付 30% 预付款； 2. 设备验收合格后 15 个工作日内支付 60%； 3. 质保期满后支付剩余 10% 尾款。 逾期付款的，每日按未付金额的 0.03% 计违约金。" },
  { chunkId: 2, docId: "d2", bookId: "b2", docTitle: "项目文档 · 服务协议", docKind: "md", idx: 2, page: null, distance: 1.11,
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

const doc = (d: Partial<Doc> & Pick<Doc, "id" | "bookId" | "title" | "kind">): Doc => ({
  position: 0,
  name: d.title.replace(/\.[^.]+$/, ""),
  displayTitle: d.title.replace(/\.[^.]+$/, ""),
  path: `/Users/demo/${d.title}`,
  pages: null,
  chunkCount: 12,
  createdAt: 0,
  author: null,
  progress: null,
  furthest: 0,
  furthestPage: null,
  opened: false,
  readAt: null,
  missing: false,
  hasCover: false,
  ...d,
});
const book = (b: Partial<Book> & Pick<Book, "id" | "title" | "docs">): Book => ({
  author: null,
  folder: null,
  scan: "none",
  createdAt: 0,
  hasCover: false,
  customCover: false,
  coverRev: "",
  progress: null,
  readAt: null,
  spoilerFree: false,
  spoilerDefault: true,
  sessionCount: 0,
  noteCount: 0,
  ...b,
});

/** 预览用的书架：一本 PDF、一本由文件夹里两个文件组成的书、一本找不到原文件的、一本小说 */
const books: Book[] = [
  book({ id: "b1", title: "采购合同", sessionCount: 1, docs: [doc({ id: "d1", bookId: "b1", title: "采购合同.pdf", kind: "pdf", pages: 3, chunkCount: 34 })] }),
  book({
    id: "b2",
    title: "项目文档",
    folder: "/Users/demo/项目文档",
    progress: 0.42,
    readAt: 200,
    sessionCount: 1,
    docs: [
      doc({ id: "d2", bookId: "b2", title: "服务协议.md", kind: "md", displayTitle: "项目文档 · 服务协议", path: "sample.md", chunkCount: 8, progress: 0.84, furthest: 0.84, opened: true, readAt: 200 }),
      doc({ id: "d5", bookId: "b2", position: 1, title: "验收标准.md", kind: "md", displayTitle: "项目文档 · 验收标准", path: "sample2.md", chunkCount: 8 }),
    ],
  }),
  book({ id: "b3", title: "第一集剧本（定稿）", docs: [doc({ id: "d3", bookId: "b3", title: "第一集剧本（定稿）.docx", kind: "docx", chunkCount: 61, missing: true })] }),
  book({
    id: "b4",
    title: "槐花开",
    author: "测试作者",
    progress: 0.37,
    readAt: 300,
    spoilerFree: true,
    sessionCount: 2,
    docs: [doc({ id: "d4", bookId: "b4", title: "槐花开", kind: "epub", path: "sample.epub", author: "测试作者", progress: 0.37, furthest: 0.37, opened: true, readAt: 300 })],
  }),
];

const sessions = [
  { id: "s1", sdk_session_id: "x", title: "对比两份合同的付款方式", updated_at: Date.now() / 1000 - 120, book_id: null, book_title: null, scope: null },
  { id: "s4", sdk_session_id: "w", title: "小满是谁？", updated_at: Date.now() / 1000 - 900, book_id: "b4", book_title: "槐花开", scope: null },
  { id: "s5", sdk_session_id: "v", title: "总结这一章 · 第二章 底片", updated_at: Date.now() / 1000 - 4000, book_id: "b4", book_title: "槐花开", scope: null },
  { id: "s2", sdk_session_id: "y", title: "验收要看哪几项？", updated_at: Date.now() / 1000 - 7200, book_id: "b2", book_title: "项目文档", scope: null },
  { id: "s3", sdk_session_id: "z", title: "质保期和违约责任", updated_at: Date.now() / 1000 - 172800, book_id: "b1", book_title: "采购合同", scope: null },
];

const store: Record<string, unknown> = {
  get_setting: JSON.stringify({ baseUrl: "https://api.deepseek.com/anthropic", apiKey: "demo", model: "deepseek-flash", topK: 6, workspace: "/Users/Admin/Desktop/awemesome" }),
  db_info: { docs: 5, books: 4, chunks: 103, sessions: 5, dbPath: "~/Library/…/docagent.db", dbSizeBytes: 5_400_000, saveDir: "~/Documents/DocAgent" },
};

const notes: Annotation[] = [];

const xray = {
  total: 3,
  units: [
    { docId: "d4", unit: 0, page: 1, start: 0, end: 0.34, title: "雨夜来客", summary: "雨夜里一个年轻人带着一台旧胶片机来到老陈的修理店。老陈认出这台相机是自己三十年前卖出去的。",
      entities: [
        { name: "老陈", type: "人物", desc: "相机修理店的店主，三十年前卖出过这台相机", quote: "老陈把店门的卷帘拉到一半" },
        { name: "年轻人", type: "人物", desc: "雨夜带着旧相机来修的客人", quote: "一个浑身湿透的年轻人挤了进来" },
        { name: "小满", type: "人物", desc: "相机机身上刻着的受赠人名字", quote: "赠予小满，一九八七年秋" },
      ] },
    { docId: "d4", unit: 1, page: 2, start: 0.34, end: 0.67, title: "一卷没洗的底片", summary: "相机里留着一卷没冲洗的胶片。年轻人说相机是刚过世的外婆留下的，老陈答应三天后交照片。",
      entities: [
        { name: "年轻人", type: "人物", desc: "相机是他外婆留下的，外婆上个月去世了", quote: "外婆上个月走了" },
        { name: "底片", type: "物品", desc: "卷片轴里一卷没冲洗的胶片，要等三天", quote: "卷片轴里还留着一卷没冲洗的胶片" },
        { name: "外婆", type: "人物", desc: "年轻人的外婆，相机的主人，上个月去世", quote: "外婆上个月走了" },
      ],
      relations: [
        { from: "年轻人", to: "外婆", label: "外孙" },
        { from: "年轻人", to: "老陈", label: "托他修相机" },
      ] },
    { docId: "d4", unit: 2, page: 3, start: 0.67, end: 1, title: "桥头的槐树", summary: "照片洗出来只有七张成像，都是一座石桥。最后一张背面写着“等你到槐花开”，老陈明白了小满是谁。",
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
  if (cmd === "import_paths" || cmd === "rescan_book") {
    return { added: 0, updated: 0, unchanged: 0, missing: 0, skipped: [], failed: [], books: [] } as T;
  }
  if (cmd === "read_file_bytes") {
    return (await (await fetch(args?.docId === "d4" ? sampleEpub : samplePdf)).arrayBuffer()) as T;
  }
  if (cmd === "document_book") return mdBook(sampleMd) as T;
  if (cmd === "list_books") return structuredClone(books) as T;
  if (cmd === "document_source") return sampleMd as T;
  if (cmd === "test_model") return 820 as T;
  if (cmd === "test_embedding") return 1024 as T;
  if (cmd === "list_sessions") return structuredClone(sessions) as T;
  if (cmd === "recap") return "老陈守着一间相机修理店，雨夜里一个年轻人带来一台他三十年前卖出去的旧胶片机。相机是年轻人刚过世的外婆留下的，里面还有一卷没冲洗的底片，机身上刻着“赠予小满”。老陈答应三天后交照片——你停在他刚把底片取出来的地方。" as T;
  if (cmd === "xray_get") return (args?.bookId === "b4" ? xray : { units: [], total: 0 }) as T;
  if (cmd === "update_book") {
    const b = books.find((x) => x.id === args?.bookId);
    if (b) Object.assign(b, { title: String(args?.title), author: (args?.author as string | null) ?? null });
    return null as T;
  }
  if (cmd === "set_book_spoiler") {
    const b = books.find((x) => x.id === args?.bookId);
    if (b) Object.assign(b, { spoilerFree: args?.on ?? false, spoilerDefault: args?.on == null });
    return null as T;
  }
  if (cmd === "delete_book") {
    const i = books.findIndex((x) => x.id === args?.bookId);
    if (i >= 0) books.splice(i, 1);
    for (const s of sessions) if (s.book_id === args?.bookId) s.book_id = null;
    return null as T;
  }
  if (cmd === "move_part") {
    for (const b of books) {
      const i = b.docs.findIndex((d) => d.id === args?.docId);
      const j = i + Number(args?.delta);
      if (i < 0 || j < 0 || j >= b.docs.length) continue;
      [b.docs[i], b.docs[j]] = [b.docs[j], b.docs[i]];
      b.docs.forEach((d, n) => (d.position = n));
    }
    return null as T;
  }
  if (cmd === "set_session_book") {
    const s = sessions.find((x) => x.id === args?.id);
    const b = books.find((x) => x.id === args?.bookId);
    if (s) Object.assign(s, { book_id: b?.id ?? null, book_title: b?.title ?? null });
    return null as T;
  }
  if (cmd === "set_session_scope") {
    const s = sessions.find((x) => x.id === args?.id);
    if (s) Object.assign(s, { scope: args?.scope ?? null });
    return null as T;
  }
  if (cmd === "delete_session") {
    const i = sessions.findIndex((x) => x.id === args?.id);
    if (i >= 0) sessions.splice(i, 1);
    return null as T;
  }
  if (cmd === "scan_paths") {
    return (args?.paths as string[]).map((p) => ({
      path: p, name: p.split("/").pop(), isDir: true, kind: null, direct: 13, total: 223,
      subfolders: [{ name: "api", path: `${p}/api`, total: 40 }, { name: "guides", path: `${p}/guides`, total: 170 }],
      selfContained: false, truncated: false, bookId: null, parentBook: null,
    })) as T;
  }
  if (cmd === "list_annotations") {
    const ids = args?.bookId ? books.find((b) => b.id === args.bookId)?.docs.map((d) => d.id) : args?.docId ? [args.docId] : null;
    return notes.filter((a) => !ids || ids.includes(a.docId)) as T;
  }
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
