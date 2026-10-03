/** Rust 命令的封装。前端只通过这里碰 Rust。 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { mockInvoke } from "./mock";
/** 不在 Tauri 里（浏览器直接打开 dev server）时用假数据，方便调界面 */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isPreview = !inTauri;
const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  inTauri ? tauriInvoke<T>(cmd, args) : mockInvoke<T>(cmd, args);

import type { AgentEvent, Annotation, Block, Doc, DocKind, Hit, Message, Quote, Session } from "./types";

export interface ImportProgress {
  name: string;
  stage: "parsing" | "indexing" | "done" | "error";
  index: number;
  total: number;
  message: string | null;
}

/** 导入文件或文件夹（解析、分块、建索引都在 Rust 后台线程里做） */
export const importPaths = (paths: string[]) =>
  invoke<{ imported: number; failed: string[] }>("import_paths", { paths });

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

export async function listDocuments(): Promise<Doc[]> {
  const raw = await invoke<
    {
      id: string; title: string; path: string | null; kind: string; pages: number | null; chunk_count: number;
      created_at: number; author?: string | null; has_cover?: boolean; progress?: number | null;
    }[]
  >("list_documents");
  return raw.map((d) => ({
    id: d.id,
    title: d.title,
    path: d.path,
    kind: d.kind as DocKind,
    pages: d.pages,
    chunkCount: d.chunk_count,
    createdAt: d.created_at,
    author: d.author ?? null,
    hasCover: !!d.has_cover,
    progress: d.progress ?? null,
  }));
}

export const deleteDocument = (docId: string) => invoke<void>("delete_document", { docId });
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

/** 封面缩略图的 blob 地址；没有封面返回 null */
export async function docCover(docId: string): Promise<string | null> {
  const buf = await invoke<ArrayBuffer | null>("doc_cover", { docId });
  if (!buf || !buf.byteLength) return null;
  return URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
}
export const setDocCover = (docId: string, data: Uint8Array) =>
  invoke<void>("set_doc_cover", { docId, data: Array.from(data) });

export const listAnnotations = (docId?: string) =>
  invoke<Annotation[] | null>("list_annotations", { docId: docId ?? null }).then((l) => l ?? []);
export const saveAnnotation = (annotation: Annotation) => invoke<void>("save_annotation", { annotation });
export const deleteAnnotation = (id: string) => invoke<void>("delete_annotation", { id });
export const readingState = (docId: string) =>
  invoke<{ location: string | null; fraction: number } | null>("reading_state", { docId });
export const saveReadingState = (docId: string, location: string, fraction: number) =>
  invoke<void>("save_reading_state", { docId, location, fraction });
/** 导出文字：Rust 那边弹「另存为」再写，返回存到了哪（用户取消返回 null） */
export const exportText = (defaultName: string, content: string) =>
  invoke<string | null>("export_text", { defaultName, content });

export const getSetting = (key: string) => invoke<string | null>("get_setting", { key });
export const setSetting = (key: string, value: string) => invoke<void>("set_setting", { key, value });
export const dbInfo = () =>
  invoke<{
    docs: number; chunks: number; sessions: number; dbPath: string; dbSizeBytes: number; saveDir: string;
    vectors?: number; embedModel?: string | null;
  }>("db_info");

// ---------- 会话 ----------

export async function listSessions(): Promise<Session[]> {
  const raw = await invoke<
    { id: string; sdk_session_id: string | null; title: string; updated_at: number }[]
  >("list_sessions");
  return raw.map((s) => ({ id: s.id, sdkSessionId: s.sdk_session_id, title: s.title, updatedAt: s.updated_at }));
}

export const upsertSession = (id: string, title: string, sdkSessionId: string | null) =>
  invoke<void>("upsert_session", { id, title, sdkSessionId });
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
