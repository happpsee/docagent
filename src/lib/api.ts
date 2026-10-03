/** Rust 命令的封装。前端只通过这里碰 Rust。 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEvent, Block, Doc, DocKind, Hit, Message, Session } from "./types";

export async function addDocument(
  title: string,
  path: string | null,
  kind: DocKind,
  pages: number | null,
  chunks: { idx: number; page: number | null; text: string }[],
): Promise<string> {
  return invoke<string>("add_document", { title, path, kind, pages, chunks });
}

export async function listDocuments(): Promise<Doc[]> {
  const raw = await invoke<
    { id: string; title: string; path: string | null; kind: string; pages: number | null; chunk_count: number; created_at: number }[]
  >("list_documents");
  return raw.map((d) => ({
    id: d.id,
    title: d.title,
    path: d.path,
    kind: d.kind as DocKind,
    pages: d.pages,
    chunkCount: d.chunk_count,
    createdAt: d.created_at,
  }));
}

export const deleteDocument = (docId: string) => invoke<void>("delete_document", { docId });
export const resetIndex = () => invoke<void>("reset_index");
export const readFileBytes = (path: string) => invoke<number[]>("read_file_bytes", { path });
export const getSetting = (key: string) => invoke<string | null>("get_setting", { key });
export const setSetting = (key: string, value: string) => invoke<void>("set_setting", { key, value });
export const dbInfo = () =>
  invoke<{ docs: number; chunks: number; sessions: number; dbPath: string; dbSizeBytes: number; saveDir: string }>("db_info");

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
    return { role: r.role as Message["role"], content: r.content, ...meta };
  });
}

// ---------- agent ----------

export const agentStart = () => invoke<void>("agent_start");
export const agentSend = (payload: Record<string, unknown>) => invoke<void>("agent_send", { payload });
export const onAgentEvent = (fn: (e: AgentEvent) => void): Promise<UnlistenFn> =>
  listen<AgentEvent>("agent-event", (e) => fn(e.payload));
