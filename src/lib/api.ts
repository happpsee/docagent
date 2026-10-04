/** Rust 命令的封装。前端只通过这里碰 Rust。 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { mockInvoke } from "./mock";
/** 不在 Tauri 里（浏览器直接打开 dev server）时用假数据，方便调界面 */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isPreview = !inTauri;
const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  inTauri ? tauriInvoke<T>(cmd, args) : mockInvoke<T>(cmd, args);

import type {
  AgentEvent,
  Annotation,
  Block,
  Book,
  Hit,
  ImportItem,
  ImportSummary,
  Message,
  Quote,
  ScanItem,
  Scope,
  Session,
  XRay,
  QuizItem,
  QuizResult,
  QuizUnit,
  LearnOverview,
  LearnerNote,
  Trip,
} from "./types";

export interface ImportProgress {
  name: string;
  stage: "parsing" | "indexing" | "done" | "error";
  index: number;
  total: number;
  message: string | null;
}

/** 导入前先看看这些路径是什么：文件还是文件夹、里面有多少能导入的、是不是已经在书架上 */
export const scanPaths = (paths: string[]) => invoke<ScanItem[] | null>("scan_paths", { paths }).then((l) => l ?? []);

const EMPTY_SUMMARY: ImportSummary = { added: 0, updated: 0, unchanged: 0, missing: 0, skipped: [], failed: [], books: [] };
/** 导入（解析、分块、建索引都在 Rust 后台线程里做）。每一项说明怎么归成书 */
export const importPaths = (items: ImportItem[]) =>
  invoke<ImportSummary | null>("import_paths", { items }).then((r) => r ?? EMPTY_SUMMARY);
/** 按文件夹现在的样子更新一本书：新文件加进来，改过的重建，带笔记的篇即使文件不见了也留着 */
export const rescanBook = (bookId: string) =>
  invoke<ImportSummary | null>("rescan_book", { bookId }).then((r) => r ?? EMPTY_SUMMARY);
/** 把一本多篇的书拆成一篇一本（笔记、进度都跟着各自的篇走） */
export const splitBook = (bookId: string) => invoke<void>("split_book", { bookId });
/** 文件或文件夹挪了地方：让用户重新指给应用。取消返回 false */
export const relocateBook = (bookId: string) => invoke<boolean | null>("relocate_book", { bookId }).then((r) => !!r);

export const onImportProgress = (fn: (p: ImportProgress) => void): Promise<UnlistenFn> =>
  inTauri ? listen<ImportProgress>("import-progress", (e) => fn(e.payload)) : Promise.resolve(() => {});

/** 拖文件/文件夹到窗口上 */
export async function onFileDrop(fn: (paths: string[]) => void, onHover: (over: boolean) => void): Promise<UnlistenFn> {
  if (!inTauri) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "enter" || e.payload.type === "over") onHover(true);
    else if (e.payload.type === "leave") onHover(false);
    else if (e.payload.type === "drop") {
      onHover(false);
      if (e.payload.paths.length) fn(e.payload.paths);
    }
  });
}

export const documentText = (docId: string) => invoke<string>("document_text", { docId });

/** 一篇的原文（Markdown、文本），给编辑用 */
export const documentSource = (docId: string) => invoke<string>("document_source", { docId });
/** 把改过的内容写回原文件并重建这一篇的索引 */
export const saveDocumentSource = (docId: string, content: string) => invoke<void>("save_document_source", { docId, content });

/** 试一下模型接口通不通，返回用了多少毫秒 */
export const testModel = (baseUrl: string, apiKey: string, model: string) =>
  invoke<number>("test_model", { baseUrl, apiKey, model });
/** 试一下向量接口，返回向量的维度 */
export const testEmbedding = (baseUrl: string, apiKey: string, model: string) =>
  invoke<number>("test_embedding", { baseUrl, apiKey, model });

// ---------- 书架 ----------

export const listBooks = () => invoke<Book[] | null>("list_books").then((l) => l ?? []);
export const updateBook = (bookId: string, title: string, author: string | null) =>
  invoke<void>("update_book", { bookId, title, author });
/** on 传 null 是恢复按类型的默认值 */
export const setBookSpoiler = (bookId: string, on: boolean | null) => invoke<void>("set_book_spoiler", { bookId, on });
/** 从书架移除：划线、笔记、进度、透视一起删，原文件不动 */
export const deleteBook = (bookId: string, withSessions: boolean) => invoke<void>("delete_book", { bookId, withSessions });
/** 移除书里的一篇；是最后一篇的话书也一起移除 */
export const deleteDocument = (docId: string) => invoke<void>("delete_document", { docId });
/** 把一篇往前（-1）或往后（1）挪一位 */
export const movePart = (docId: string, delta: -1 | 1) => invoke<void>("move_part", { docId, delta });

/** 封面的 blob 地址；没有封面返回 null */
export async function bookCover(bookId: string): Promise<string | null> {
  const buf = await invoke<ArrayBuffer | null>("book_cover", { bookId });
  if (!buf || !buf.byteLength) return null;
  return URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
}
/** 让用户挑一张图当封面（文件对话框由 Rust 打开）。取消返回 false */
export const pickBookCover = (bookId: string) => invoke<boolean | null>("pick_book_cover", { bookId }).then((r) => !!r);
export const clearBookCover = (bookId: string) => invoke<void>("clear_book_cover", { bookId });
export const revealBook = (bookId: string) => invoke<void>("reveal_book", { bookId });
export const revealDoc = (docId: string) => invoke<void>("reveal_doc", { docId });

/** 重建索引：按原文件重新解析所有文档（划线、笔记、进度不动） */
export const resetIndex = () => invoke<{ imported: number; failed: string[] } | null>("reset_index");
/** 让后台给还没有向量的片段补向量 */
export const fillVectors = () => invoke<void>("fill_vectors");
export interface VectorProgress {
  done: number;
  total: number;
  error: string | null;
}
export const onVectorProgress = (fn: (p: VectorProgress) => void): Promise<UnlistenFn> =>
  inTauri ? listen<VectorProgress>("vector-progress", (e) => fn(e.payload)) : Promise.resolve(() => {});

/** 原文件的字节（Rust 走二进制通道返回 ArrayBuffer） */
export const readFileBytes = (docId: string) => invoke<ArrayBuffer>("read_file_bytes", { docId });

// ---------- 阅读器 ----------

export interface BookSection {
  id: string;
  html: string;
}
export interface TocItem {
  label: string;
  href: string;
  subitems?: TocItem[] | null;
}
/** Markdown / TXT / DOCX 由 Rust 排成分好节的 HTML */
export const documentBook = (docId: string) =>
  invoke<{ sections: BookSection[]; toc: TocItem[] }>("document_book", { docId });

/** 阅读器把一篇的第一页送过来当自动封面（PDF 这类没法在 Rust 里取封面的） */
export const setDocCover = (docId: string, data: Uint8Array) =>
  invoke<void>("set_doc_cover", { docId, data: Array.from(data) });

/** 一篇的标记，或者整本书所有篇的标记（按篇的先后排） */
export const listAnnotations = (of: { docId?: string; bookId?: string }) =>
  invoke<Annotation[] | null>("list_annotations", { docId: of.docId ?? null, bookId: of.bookId ?? null }).then((l) => l ?? []);
export const saveAnnotation = (annotation: Annotation) => invoke<void>("save_annotation", { annotation });
export const deleteAnnotation = (id: string) => invoke<void>("delete_annotation", { id });
export const readingState = (docId: string) =>
  invoke<{ location: string | null; fraction: number; furthest?: number; furthestPage?: number | null } | null>("reading_state", {
    docId,
  });
/** page：PDF 的页码 / EPUB 的第几节，用来记「读到过的最远处」 */
export const saveReadingState = (docId: string, location: string, fraction: number, page: number | null) =>
  invoke<void>("save_reading_state", { docId, location, fraction, page });
// ---------- 透视 ----------

export const xrayGet = (bookId: string) => invoke<XRay | null>("xray_get", { bookId }).then((x) => x ?? { units: [], total: 0 });
/** 开始（或接着）透视；在后台跑，进度走 onXRayProgress */
export const xrayBuild = (bookId: string) => invoke<void>("xray_build", { bookId });
// ---------- 学习：出题、批改、掌握度 ----------

export const quizUnits = (docId: string) => invoke<QuizUnit[]>("quiz_units", { docId });
/** 一段的题：出过就用存着的，没出过现出 */
export const quizUnit = (bookId: string, docId: string, unit: number) => invoke<QuizItem[]>("quiz_unit", { bookId, docId, unit });
/** 交回答；空串是「不会」 */
export const quizAnswer = (itemId: number, answer: string) => invoke<QuizResult>("quiz_answer", { itemId, answer });
/** 复习时换个问法：答过的题换成同一个概念的另一道（现出或轮换），没答过的原样返回 */
export const quizVariant = (itemId: number) => invoke<QuizItem>("quiz_variant", { itemId });
export const quizFromMarks = (bookId: string) => invoke<number>("quiz_from_marks", { bookId });
export const learnIgnore = (bookId: string, concept: string, on: boolean) => invoke<void>("learn_ignore", { bookId, concept, on });
export const learnerNotes = () => invoke<LearnerNote[] | null>("learner_notes").then((x) => x ?? []);
export const learnerNoteSave = (id: number | null, kind: LearnerNote["kind"], content: string) => invoke<void>("learner_note_save", { id, kind, content });
export const learnerNoteDelete = (id: number) => invoke<void>("learner_note_delete", { id });
export const readingTrip = (bookId: string, since: number) => invoke<Trip>("reading_trip", { bookId, since });
export const quizDue = (bookId: string | null) => invoke<QuizItem[]>("quiz_due", { bookId });
export const learnOverviews = () => invoke<LearnOverview[] | null>("learn_overviews").then((x) => x ?? []);

/** 前情提要。notes 是读过那些段的要点（没做过透视传空串，Rust 改用原文）；fresh 是不用存着的、重写 */
export const recap = (bookId: string, docId: string, fraction: number, notes: string, fresh: boolean) =>
  invoke<string>("recap", { bookId, docId, fraction, notes, fresh });
export const xrayClear = (bookId: string) => invoke<void>("xray_clear", { bookId });
export interface XRayProgress {
  bookId: string;
  done: number;
  total: number;
  error: string | null;
  finished: boolean;
}
export const onXRayProgress = (fn: (p: XRayProgress) => void): Promise<UnlistenFn> =>
  inTauri ? listen<XRayProgress>("xray-progress", (e) => fn(e.payload)) : Promise.resolve(() => {});

/** 导出文字：Rust 那边弹「另存为」再写，返回存到了哪（用户取消返回 null） */
export const exportText = (defaultName: string, content: string) =>
  invoke<string | null>("export_text", { defaultName, content });

export const getSetting = (key: string) => invoke<string | null>("get_setting", { key });
export const setSetting = (key: string, value: string) => invoke<void>("set_setting", { key, value });
export const dbInfo = () =>
  invoke<{
    docs: number; books?: number; chunks: number; sessions: number; dbPath: string; dbSizeBytes: number; saveDir: string;
    vectors?: number; embedModel?: string | null;
  }>("db_info");

// ---------- 会话 ----------

export async function listSessions(): Promise<Session[]> {
  const raw = await invoke<
    {
      id: string; sdk_session_id: string | null; title: string; updated_at: number;
      book_id?: string | null; book_title?: string | null; scope?: string | null;
    }[]
  >("list_sessions");
  return (raw ?? []).map((s) => {
    let scope: Scope | null = null;
    try {
      scope = s.scope ? (JSON.parse(s.scope) as Scope) : null;
    } catch {
      // 存坏了就当没选过
    }
    return {
      id: s.id,
      sdkSessionId: s.sdk_session_id,
      title: s.title,
      updatedAt: s.updated_at,
      bookId: s.book_id ?? null,
      bookTitle: s.book_title ?? null,
      scope,
    };
  });
}

/** bookId 只在新建会话时生效：会话关联哪本书在创建时定下来，之后的更新不会改它 */
export const upsertSession = (id: string, title: string, sdkSessionId: string | null, bookId: string | null = null) =>
  invoke<void>("upsert_session", { id, title, sdkSessionId, bookId });
/** 手动把一段对话归到某本书下，或者取消关联 */
export const setSessionBook = (id: string, bookId: string | null) => invoke<void>("set_session_book", { id, bookId });
export const setSessionScope = (id: string, scope: Scope | null) =>
  invoke<void>("set_session_scope", { id, scope: scope ? JSON.stringify(scope) : null });
export const deleteSession = (id: string) => invoke<void>("delete_session", { id });

interface MessageMeta {
  quote?: Quote;
  blocks?: Block[];
  hits?: Hit[];
  costUsd?: number | null;
  durationMs?: number;
  error?: boolean;
}

export const addMessage = (sessionId: string, m: Message) =>
  invoke<number>("add_message", {
    sessionId,
    role: m.role,
    content: m.content,
    meta: JSON.stringify({
      quote: m.quote,
      blocks: m.blocks,
      hits: m.hits,
      costUsd: m.costUsd,
      durationMs: m.durationMs,
      error: m.error,
    } satisfies MessageMeta),
  });

export async function getMessages(sessionId: string): Promise<Message[]> {
  const raw = await invoke<{ role: string; content: string; meta: string | null }[]>("get_messages", { sessionId });
  return raw.map((r) => {
    let meta: MessageMeta = {};
    try {
      meta = r.meta ? (JSON.parse(r.meta) as MessageMeta) : {};
    } catch {
      // 旧数据或损坏的 meta，当作没有
    }
    // 历史里还挂着「等你同意」的卡片：那轮提问早就结束了，点了也没人接，标成过期
    const blocks = meta.blocks?.map((b) =>
      b.type === "tool" && b.approval?.state === "pending" ? { ...b, approval: { ...b.approval, state: "expired" as const } } : b,
    );
    return { role: r.role as Message["role"], content: r.content, ...meta, ...(blocks ? { blocks } : {}) };
  });
}

// ---------- 扩展配置 ----------

/** 确保 .docagent 目录存在并返回路径；不传 dir 是用户级 */
export const ensureConfigDir = (dir?: string | null) => invoke<string>("ensure_config_dir", { dir: dir ?? null });
export const openPath = (path: string) => invoke<void>("open_path", { path });

// ---------- agent ----------

export const agentStart = () => invoke<void>("agent_start");
export const agentSend = (payload: Record<string, unknown>) =>
  inTauri ? invoke<void>("agent_send", { payload }) : Promise.resolve();
export const onAgentEvent = (fn: (e: AgentEvent) => void): Promise<UnlistenFn> => {
  if (!inTauri) {
    setTimeout(() => {
      fn({ type: "ready" });
      fn({
        type: "extensions",
        user: { dir: "~/.docagent", skills: ["写周报", "剧本拆解"], mcp: ["github"] },
        project: { dir: "awemesome/.docagent", skills: ["接口文档"], mcp: [] },
      });
    }, 100);
    return Promise.resolve(() => {});
  }
  return listen<AgentEvent>("agent-event", (e) => fn(e.payload));
};
