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

export interface ChunkIn {
  idx: number;
  page: number | null;
  text: string;
  embedding: number[];
}

export interface SearchHit {
  chunkId: number;
  docId: string;
  docTitle: string;
  idx: number;
  page: number | null;
  text: string;
  distance: number;
}

/** 供应商配置。embedMode = "local" 时不联网，用本地哈希向量（仅供流程验证） */
export interface Settings {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embedModel: string;
  embedMode: "api" | "local";
  answerMode: "llm" | "extract";
  topK: number;
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  chatModel: "gpt-4o-mini",
  embedModel: "text-embedding-3-small",
  embedMode: "local",
  answerMode: "extract",
  topK: 6,
};

export interface Message {
  role: "user" | "assistant";
  content: string;
  /** 回答引用到的片段，按 [1][2] 的顺序 */
  sources?: SearchHit[];
  /** 本轮用过的工具调用记录 */
  toolCalls?: ToolCallRecord[];
  pending?: boolean;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  status: "approved" | "rejected" | "auto";
  result?: string;
}
