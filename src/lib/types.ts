export type DocKind = "pdf" | "docx" | "md" | "txt" | "epub" | "mobi" | "fb2" | "cbz";

/** 书里的一篇：对应磁盘上的一个文件。单文件的书只有一篇 */
export interface Doc {
  id: string;
  bookId: string;
  /** 在书里排第几（从 0 开始） */
  position: number;
  /** 原始标题：文件名，或电子书自带的书名 */
  title: string;
  /** 篇名：去掉扩展名的文件名；同一本书里重名时带上相对路径 */
  name: string;
  /** 对外显示的名字：单文件的书就是书名，多篇的是「书名 · 篇名」 */
  displayTitle: string;
  path: string | null;
  kind: DocKind;
  pages: number | null;
  chunkCount: number;
  createdAt: number;
  author: string | null;
  /** 上次读到这一篇的几分之几（0-1）；没打开过是 null */
  progress: number | null;
  /** 这一篇读到过的最远处（只增不减），防剧透按它算 */
  furthest: number;
  furthestPage: number | null;
  opened: boolean;
  /** 上次阅读的时间（秒） */
  readAt: number | null;
  /** 原文件找不到了（被移走或改名） */
  missing: boolean;
  hasCover: boolean;
}

/** 书架上的一本书：一个文件，或者一个文件夹里的若干文件 */
export interface Book {
  id: string;
  title: string;
  author: string | null;
  /** 这本书对应的文件夹；单文件的书是 null */
  folder: string | null;
  /** 文件夹里哪些文件算这本书的：none 只有手动加的，flat 这一层全部，deep 含子文件夹 */
  scan: "none" | "flat" | "deep";
  createdAt: number;
  hasCover: boolean;
  /** 封面是用户自己上传的 */
  customCover: boolean;
  /** 要显示的封面变了它就变，用来刷新图片 */
  coverRev: string;
  /** 全书读了多少（各篇按篇幅加权）；一篇都没打开过是 null */
  progress: number | null;
  readAt: number | null;
  /** 防剧透是否生效（已经算上了按类型的默认值） */
  spoilerFree: boolean;
  /** 上面的值来自默认规则，用户没有手动设过 */
  spoilerDefault: boolean;
  sessionCount: number;
  /** 这本书上的划线、笔记、书签总数 */
  noteCount: number;
  docs: Doc[];
}

/** 导入前的探查结果 */
export interface ScanItem {
  path: string;
  name: string;
  isDir: boolean;
  kind: DocKind | null;
  /** 文件夹：这一层有多少个能导入的文件 */
  direct: number;
  /** 文件夹：连子文件夹一共多少个 */
  total: number;
  subfolders: { name: string; path: string; total: number }[];
  /** 文件夹：里面全是自成一本的格式（epub、pdf 等） */
  selfContained: boolean;
  /** 文件夹：层数太深，有文件没数进来 */
  truncated: boolean;
  /** 文件夹：它已经是书架上的一本书 */
  bookId: string | null;
  /** 文件：它所在的文件夹（或上级）已经是一本书 */
  parentBook: { id: string; title: string } | null;
}

/** 怎么导入一个路径。auto：文件按规则各归各的；book：整个文件夹一本（带 files 时只收这些文件）；
 *  book-flat：只要这一层；subfolders：每个子文件夹一本；each：每个文件各算一本 */
export interface ImportItem {
  path: string;
  mode: "auto" | "book" | "book-flat" | "subfolders" | "each";
  files?: string[];
}
export interface ImportSummary {
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
  skipped: string[];
  failed: string[];
  books: string[];
}

/** 透视：书里一段的要点，和这一段里出现的人物、概念 */
export interface XRayEntity {
  name: string;
  type: string;
  desc: string;
  quote: string;
}
export interface XRayUnit {
  /** 这一段属于哪一篇 */
  docId: string;
  unit: number;
  page: number | null;
  /** 这一段在它那一篇里的起止位置（0-1） */
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
  /** 这本书现在是不是正在透视 */
  building?: boolean;
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
};

export interface Hit {
  chunkId: number;
  docId: string;
  /** 检索时这一篇属于哪本书（只作参考：书可能后来被合并，以 docId 现查为准） */
  bookId?: string;
  docTitle: string;
  /** 这一篇是什么格式，决定说「页」还是「节」。老消息里没有 */
  docKind?: DocKind;
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
  kind?: DocKind;
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

/** 检索范围：整个书架、这段对话所属的那本书、书里的某一篇、或者手选的几本 */
export type Scope =
  | { type: "all" }
  | { type: "book" }
  | { type: "part"; docId: string }
  | { type: "books"; bookIds: string[] };

export interface Session {
  id: string;
  sdkSessionId: string | null;
  title: string;
  updatedAt: number;
  /** 这段对话是关于哪本书的；和书无关的是 null */
  bookId: string | null;
  /** 关联时记下的书名：书被移除后还能看出这段对话原来是聊哪本的 */
  bookTitle: string | null;
  /** 用户选过的检索范围；null 是默认（有书就在这本书里找，没有就找整个书架） */
  scope: Scope | null;
}

/** 一家模型供应商的配置 */
export interface ProviderConfig {
  /** 自定义接口起的名字；目录里的那几家不存，用目录里的名字 */
  name?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 应用设置。baseUrl / apiKey / model 是「正在用的那一家」的，Rust 和助手只读这三项；
 *  providers 里存着每一家各自填过的，换着用的时候不用重填 */
export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 正在用的是哪一家（providers 里的键） */
  provider?: string;
  providers?: Record<string, ProviderConfig>;
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

/** 阅读器当前的位置（翻页时由阅读器报上来） */
export interface ReadingInfo {
  docId: string;
  /** PDF 的页码 / EPUB 的第几节；其它格式没有 */
  page: number | null;
  chapter: string;
  /** 读到这一篇的几分之几 */
  fraction: number;
}
