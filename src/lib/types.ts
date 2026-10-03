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

/** 助手消息是一条时间线：文字和工具调用按发生顺序排列 */
export type Block =
  | { type: "text"; text: string }
  | {
      type: "tool";
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      /** 等待用户审批时带着 requestId；处理完后记录结果 */
      approval?: { requestId: string; state: "pending" | "allowed" | "denied" };
    };

/** 用户在阅读器里选中的一段原文，随问题一起发给助手 */
export interface Quote {
  text: string;
  docId: string;
  docTitle: string;
  page: number | null;
}

export interface Message {
  role: "user" | "assistant";
  /** 用户消息附带的引文 */
  quote?: Quote;
  /** 用户消息的正文；助手消息的最终文本（用于持久化检索和标题） */
  content: string;
  blocks?: Block[];
  hits?: Hit[];
  costUsd?: number | null;
  durationMs?: number;
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
  | { type: "tool"; id: string; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; toolUseId: string; text: string; isError: boolean }
  | { type: "approval_request"; id: string; requestId: string; name: string; input: Record<string, unknown> }
  | { type: "result"; id: string; text: string; sessionId: string | null; costUsd: number | null; turns: number | null; hits: Hit[] }
  | { type: "error"; id?: string; message: string };
