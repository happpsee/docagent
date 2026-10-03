export type DocKind = "pdf" | "docx" | "md" | "txt";

export interface Doc {
  id: string;
  title: string;
  path: string | null;
  kind: DocKind;
  pages: number | null;
  chunkCount: number;
  createdAt: number;
}

export interface Hit {
  chunkId: number;
  docId: string;
  docTitle: string;
  idx: number;
  page: number | null;
  text: string;
  distance: number;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  summary?: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  hits?: Hit[];
  tools?: ToolCall[];
  costUsd?: number | null;
  pending?: boolean;
  error?: boolean;
}

export interface Session {
  id: string;
  sdkSessionId: string | null;
  title: string;
  updatedAt: number;
}

/** 模型供应商：任何 Anthropic 兼容接口 */
export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  topK: number;
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: "https://api.deepseek.com/anthropic",
  apiKey: "",
  model: "deepseek-flash",
  topK: 6,
};

/** sidecar 发来的事件（协议定义见 sidecar/agent.ts 顶部） */
export type AgentEvent =
  | { type: "ready" }
  | { type: "exited" }
  | { type: "session"; id: string; sessionId: string }
  | { type: "delta"; id: string; text: string }
  | { type: "tool"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; summary: string }
  | { type: "approval_request"; id: string; requestId: string; name: string; input: Record<string, unknown> }
  | { type: "result"; id: string; text: string; sessionId: string | null; costUsd: number | null; turns: number | null; hits: Hit[] }
  | { type: "error"; id?: string; message: string };
