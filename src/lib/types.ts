export type DocKind = "pdf" | "docx" | "md" | "txt" | "epub" | "mobi" | "fb2" | "cbz";

export interface Doc {
  id: string;
  title: string;
  path: string | null;
  kind: DocKind;
  pages: number | null;
  chunkCount: number;
  createdAt: number;
  author: string | null;
  hasCover: boolean;
  /** 读到全书的几分之几（0-1）；没打开过是 null */
  progress: number | null;
  /** 上次阅读的时间（秒） */
  readAt: number | null;
}

/** 透视：书里一段的要点，和这一段里出现的人物、概念 */
export interface XRayEntity {
  name: string;
  type: string;
  desc: string;
  quote: string;
}
export interface XRayUnit {
  unit: number;
  page: number | null;
  /** 这一段在全书里的起止位置（0-1） */
  start: number;
  end: number;
  title: string;
  summary: string;
  entities: XRayEntity[];
}
export interface XRay {
  units: XRayUnit[];
  /** 全书一共多少段；units 比它少说明还没做完 */
  total: number;
}

export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";
export type HighlightStyle = "highlight" | "underline" | "squiggly";

/** 阅读器里的一条标记：高亮（可带笔记）或书签 */
export interface Annotation {
  id: string;
  docId: string;
  kind: "highlight" | "bookmark";
  /** 书内位置 */
  cfi: string;
  /** 被标记的原文 */
  text: string;
  note: string;
  color: HighlightColor;
  style: HighlightStyle;
  /** 所在章节 */
  label: string;
  page: number | null;
  createdAt: number;
  updatedAt: number;
  docTitle?: string;
}

/** 阅读偏好（所有书共用） */
export interface ReaderPrefs {
  fontSize: number;
  lineHeight: number;
  /** 版心宽度（像素） */
  width: number;
  flow: "paginated" | "scrolled";
  columns: 1 | 2;
  font: "serif" | "sans" | "book";
  theme: "warm" | "paper" | "green" | "night";
  justify: boolean;
  /** PDF / 漫画：一次显示一页还是双页 */
  spread: "none" | "both";
  /** 防剧透：透视和助手都只用读过的部分 */
  spoilerFree: boolean;
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  fontSize: 17,
  lineHeight: 1.8,
  width: 720,
  flow: "paginated",
  columns: 1,
  font: "serif",
  theme: "warm",
  justify: true,
  spread: "none",
  spoilerFree: true,
};

export interface Hit {
  chunkId: number;
  docId: string;
  docTitle: string;
  idx: number;
  page: number | null;
  text: string;
  distance: number;
  /** 哪一路找到的：fts 全文 / vec 向量 / both */
  via?: "fts" | "vec" | "both";
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
      approval?: {
        requestId: string;
        /** expired：提问已经结束（被停止、出错、或是从历史里读出来的），这张卡片不再能点 */
        state: "pending" | "allowed" | "denied" | "expired";
        canRemember?: boolean;
        /** 选「记住」会放行什么，原样展示给用户 */
        rememberLabel?: string;
      };
    };

/** 用户在阅读器里选中的一段原文，随问题一起发给助手 */
export interface Quote {
  text: string;
  docId: string;
  docTitle: string;
  page: number | null;
  /** 书内位置：有它才能把回答存回这段话的笔记里 */
  cfi?: string;
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
  /** 工作文件夹：助手在这里干活，并加载这里的 .docagent 配置 */
  workspace: string | null;
  /** 向量接口（OpenAI 兼容的 /embeddings）。可选：不填就只用全文检索 */
  embedBaseUrl: string;
  embedApiKey: string;
  embedModel: string;
}

/** 一个 .docagent 目录里发现的扩展 */
export interface ExtensionSet {
  dir: string;
  skills: string[];
  mcp: string[];
}
export interface Extensions {
  user: ExtensionSet;
  project: ExtensionSet | null;
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: "https://api.deepseek.com/anthropic",
  apiKey: "",
  model: "deepseek-flash",
  topK: 6,
  workspace: null,
  embedBaseUrl: "https://api.siliconflow.cn/v1",
  embedApiKey: "",
  embedModel: "BAAI/bge-m3",
};

/** sidecar 发来的事件（协议定义见 sidecar/agent.ts 顶部） */
export type AgentEvent =
  | { type: "ready" }
  | ({ type: "extensions" } & Extensions)
  | { type: "exited" }
  | { type: "session"; id: string; sessionId: string }
  | { type: "delta"; id: string; text: string }
  | { type: "tool"; id: string; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; toolUseId: string; text: string; isError: boolean }
  | {
      type: "approval_request"; id: string; requestId: string; name: string; input: Record<string, unknown>;
      canRemember?: boolean; rememberLabel?: string;
    }
  | ({ type: "reader_action"; id: string } & ReaderCommand)
  | { type: "result"; id: string; text: string; sessionId: string | null; costUsd: number | null; turns: number | null; hits: Hit[] }
  | { type: "error"; id?: string; message: string; hits?: Hit[]; sessionId?: string | null };

/** 助手让阅读器做的事：在书里划线，或者翻到某一处 */
export interface ReaderCommand {
  callId: string;
  action: "highlight" | "goto";
  docId: string;
  quote?: string | null;
  note?: string;
  color?: HighlightColor;
  page?: number | null;
}

/** 阅读器当前的位置，提问时带给助手 */
export interface ReadingInfo {
  docId: string;
  docTitle: string;
  /** PDF 的页码 / EPUB 的第几节；其它格式没有 */
  page: number | null;
  chapter: string;
  fraction: number;
  spoilerFree?: boolean;
}
