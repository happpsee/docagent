import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { BookInfoModal, RemoveBookDialog, summaryText } from "./components/BookInfoModal";
import { ChatPanel } from "./components/ChatPanel";
import { ImportDialog, planImport } from "./components/ImportDialog";
import { IMPORT_EXTENSIONS, Library } from "./components/Library";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { Reader, type Panel, type ReadTarget, type SelectionAction } from "./reader/Reader";
import * as api from "./lib/api";
import { unitOf } from "./lib/citations";
import { resolveScope, resumePart } from "./lib/scope";
import {
  DEFAULT_SETTINGS,
  type AgentEvent,
  type Annotation,
  type Block,
  type Book,
  type Extensions,
  type Hit,
  type ImportItem,
  type Message,
  type Quote,
  type ReaderCommand,
  type ReadingInfo,
  type Scope,
  type Session,
  type Settings,
} from "./lib/types";

const SETTINGS_KEY = "settings";
/** 一本书各篇清单的指纹：哪些篇、什么顺序 */
const partsKey = (book: Book) => book.docs.slice(0, 60).map((d) => d.id).join(",");
type AgentState = "unconfigured" | "starting" | "ready" | "down";
type View = "library" | "chat";

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [agent, setAgent] = useState<AgentState>("unconfigured");
  const [books, setBooks] = useState<Book[]>([]);
  const [booksLoaded, setBooksLoaded] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [current, setCurrent] = useState<Session | null>(null);
  const [messages, setMessagesState] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 不是出错，只是告诉用户一声（导入了几篇、哪本书不在了） */
  const [notice, setNotice] = useState<string | null>(null);
  const [reading, setReading] = useState<ReadTarget | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const [extensions, setExtensions] = useState<Extensions | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [notesVersion, setNotesVersion] = useState(0);
  const [vectorizing, setVectorizing] = useState<string | null>(null);
  const [readerCmd, setReaderCmd] = useState<ReaderCommand | null>(null);
  /** 没在读书时主区域显示什么：书架（首页）还是对话 */
  const [view, setView] = useState<View>("library");
  /** 阅读器左边开着哪个面板。放在这儿是因为换一篇会重建阅读器，面板不该跟着关掉 */
  const [readerPanel, setReaderPanel] = useState<Panel | null>(null);
  /** 还没发第一句的新对话选的检索范围；发出去时存到会话上 */
  const [pendingScope, setPendingScope] = useState<Scope | null>(null);
  /** 等用户决定「怎么归成书」的一次导入 */
  const [importPlan, setImportPlan] = useState<ReturnType<typeof planImport> | null>(null);
  const [infoBookId, setInfoBookId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Book | null>(null);

  // 事件回调里要读最新值，用 ref 避免闭包拿到旧状态
  const askRef = useRef<{ id: string; session: Session; startedAt: number } | null>(null);
  // 消息以这个 ref 为准，状态只是它的镜像：事件一个接一个来的时候，后一个要基于前一个
  // 改完的结果接着改，等 React 重新渲染再读就晚了（结尾的几段字会被覆盖掉）
  const messagesRef = useRef<Message[]>([]);
  const setMessages = useCallback((next: Message[] | ((prev: Message[]) => Message[])) => {
    messagesRef.current = typeof next === "function" ? next(messagesRef.current) : next;
    setMessagesState(messagesRef.current);
  }, []);
  /** 流式文字先攒着，每帧合并写一次，不然每个字都让整个界面重新渲染 */
  const deltaBuf = useRef("");
  const deltaTimer = useRef(0);
  const readingRef = useRef<ReadTarget | null>(null);
  readingRef.current = reading;
  const booksRef = useRef<Book[]>([]);
  booksRef.current = books;
  const viewRef = useRef<View>(view);
  viewRef.current = view;
  /** 阅读器是从哪儿打开的，关掉时回哪儿去（从对话里点引用进来的，回对话） */
  const readerFrom = useRef<View>("library");
  /** 阅读器当前的位置（翻页时更新，不触发渲染） */
  const readingInfo = useRef<ReadingInfo | null>(null);
  /** 助手进程这次启动以来，已经把哪些书的各篇清单告诉过它：书 id → 当时的清单。
   *  它重启就忘了，要再给一次；清单变了（加了篇、删了篇、调了顺序）也要再给，不然它按篇号会找错 */
  const partsSent = useRef(new Map<string, string>());
  /** 有一批导入正等着用户决定怎么归成书 */
  const planPending = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const docs = useMemo(() => books.flatMap((b) => b.docs), [books]);
  const readingDoc = reading ? (docs.find((d) => d.id === reading.docId) ?? null) : null;
  const readingBook = readingDoc ? (books.find((b) => b.id === readingDoc.bookId) ?? null) : null;
  /** 这段对话属于哪本书。还没发第一句的新对话，归正开着的那本 */
  const sessionBook = current ? (books.find((b) => b.id === current.bookId) ?? null) : readingBook;
  const scope = current ? current.scope : pendingScope;

  const refreshBooks = useCallback(() => {
    api.listBooks().then(
      (list) => {
        setBooks(list);
        setBooksLoaded(true);
      },
      (e) => setError(String(e)),
    );
  }, []);
  const refreshSessions = useCallback(() => {
    api.listSessions().then(
      (list) => {
        setSessions(list);
        // 正开着的这段对话，它归哪本书可能在后台变了（单独的书并进了文件夹那本、书被拆开）：跟上。
        // 列表里没有它时不动——可能是刚新建、这次列表是之前发出去的请求
        setCurrent((cur) => {
          const row = cur && list.find((s) => s.id === cur.id);
          return cur && row && (row.bookId !== cur.bookId || row.bookTitle !== cur.bookTitle)
            ? { ...cur, bookId: row.bookId, bookTitle: row.bookTitle }
            : cur;
        });
      },
      (e) => setError(String(e)),
    );
  }, []);

  const startAgent = useCallback(async () => {
    setAgent("starting");
    try {
      await api.agentStart();
    } catch (err) {
      setAgent("unconfigured");
      throw err;
    }
  }, []);

  /** 更新最后一条助手消息 */
  const patchLast = useCallback((fn: (m: Message) => Message) => {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === "assistant") next[next.length - 1] = fn(last);
      return next;
    });
  }, [setMessages]);

  /** 改助手消息里的块时间线 */
  const patchBlocks = useCallback(
    (fn: (blocks: Block[]) => Block[]) => patchLast((m) => ({ ...m, blocks: fn(m.blocks ?? []) })),
    [patchLast],
  );

  /** 把攒着的流式文字写进最后一个文字块 */
  const flushDeltas = useCallback(() => {
    cancelAnimationFrame(deltaTimer.current);
    deltaTimer.current = 0;
    const text = deltaBuf.current;
    if (!text) return;
    deltaBuf.current = "";
    // 接在最后一个文字块后面；上一块是工具调用就另起一块，保持时间线顺序
    patchBlocks((bs) => {
      const last = bs[bs.length - 1];
      if (last?.type === "text") return [...bs.slice(0, -1), { ...last, text: last.text + text }];
      return [...bs, { type: "text", text }];
    });
  }, [patchBlocks]);

  const finish = useCallback(
    (patch: (m: Message) => Partial<Message>) => {
      const ask = askRef.current;
      askRef.current = null;
      setBusy(false);
      setReaderCmd(null);
      flushDeltas();
      const last = messagesRef.current[messagesRef.current.length - 1];
      if (!ask || last?.role !== "assistant") return;
      const patched = { ...last, ...patch(last) };
      const done: Message = {
        ...patched,
        // 这一轮结束了，还没答复的审批卡片不再有效
        blocks: patched.blocks?.map((b) =>
          b.type === "tool" && b.approval?.state === "pending" ? { ...b, approval: { ...b.approval, state: "expired" } } : b,
        ),
        pending: false,
        durationMs: Date.now() - ask.startedAt,
      };
      patchLast(() => done);
      void api.addMessage(ask.session.id, done).then(refreshSessions);
    },
    [patchLast, refreshSessions, flushDeltas],
  );

  const onEvent = useCallback(
    (e: AgentEvent) => {
      if (e.type === "ready") {
        partsSent.current.clear();
        void api.agentSend({ type: "extensions", cwd: settingsRef.current.workspace ?? undefined });
        return setAgent("ready");
      }
      if (e.type === "extensions") return setExtensions({ user: e.user, project: e.project });
      if (e.type === "exited") {
        // 助手进程没了：正在进行的这一轮不会再有结果，收尾，别让界面一直转圈
        if (askRef.current) {
          finish((m) => ({
            error: !m.blocks?.length,
            blocks: [...(m.blocks ?? []), { type: "text", text: "*助手进程意外退出了，这次回答没有完成。点左下角可以重连。*" }],
          }));
        }
        return setAgent((s) => (s === "starting" ? s : "down"));
      }
      const ask = askRef.current;
      if (!ask || !("id" in e) || e.id !== ask.id) {
        if (e.type === "error" && !("id" in e && e.id)) setError(e.message);
        return;
      }
      if (e.type === "delta") {
        deltaBuf.current += e.text;
        deltaTimer.current ||= requestAnimationFrame(flushDeltas);
        return;
      }
      // 其它事件要排在已经收到的文字后面
      flushDeltas();
      switch (e.type) {
        case "reader_action": {
          // 助手要在书里划线或翻页。那一篇不在书架上了、或者原文件没了，就直接回绝，别让它干等
          const part = booksRef.current.flatMap((b) => b.docs).find((d) => d.id === e.docId);
          if (!part || part.missing) {
            const why = part ? "这一篇的原文件找不到了，打不开。" : "这一篇已经不在书架上了。";
            void api.agentSend({ type: "reader_result", callId: e.callId, ok: false, message: why });
            break;
          }
          // 没开着（或者开的是另一篇）就先翻过去；阅读器准备好后会执行这条指令并回话。对话不换
          if (readingRef.current?.docId !== e.docId) {
            if (!readingRef.current) readerFrom.current = viewRef.current;
            setReading({ docId: e.docId, nonce: Date.now() });
            setCollapsed(true);
          }
          setReaderCmd({ callId: e.callId, action: e.action, docId: e.docId, quote: e.quote, note: e.note, color: e.color, page: e.page });
          break;
        }
        case "session": {
          const s = { ...ask.session, sdkSessionId: e.sessionId };
          ask.session = s;
          setCurrent(s);
          void api.upsertSession(s.id, s.title, e.sessionId);
          break;
        }
        case "tool":
          patchBlocks((bs) => {
            // 审批请求可能比这条先到，那时已经放了一个占位块，这里把真实的调用 id 补上
            const i = bs.findLastIndex(
              (b) => b.type === "tool" && b.toolUseId.startsWith("ap") && b.name.endsWith(e.name) && b.result == null,
            );
            if (i >= 0) {
              const next = [...bs];
              next[i] = { ...(next[i] as Extract<Block, { type: "tool" }>), toolUseId: e.toolUseId, name: e.name, input: e.input };
              return next;
            }
            return [...bs, { type: "tool", toolUseId: e.toolUseId, name: e.name, input: e.input }];
          });
          break;
        case "tool_result":
          patchBlocks((bs) =>
            bs.map((b) =>
              b.type === "tool" && b.toolUseId === e.toolUseId ? { ...b, result: e.text, isError: e.isError } : b,
            ),
          );
          break;
        case "approval_request": {
          // 挂到对应的那次工具调用上（最近一个同名、还没结果、还没挂审批的）
          const approval = {
            requestId: e.requestId,
            state: "pending" as const,
            canRemember: e.canRemember,
            rememberLabel: e.rememberLabel,
          };
          patchBlocks((bs) => {
            const i = bs.findLastIndex(
              (b) => b.type === "tool" && b.name.endsWith(e.name) && b.result == null && !b.approval,
            );
            if (i < 0) return [...bs, { type: "tool", toolUseId: e.requestId, name: e.name, input: e.input, approval }];
            const next = [...bs];
            const cur = next[i] as Extract<Block, { type: "tool" }>;
            next[i] = { ...cur, input: { ...cur.input, ...e.input }, approval };
            return next;
          });
          break;
        }
        case "result":
          finish((m) => {
            const hasText = m.blocks?.some((b) => b.type === "text" && b.text.trim());
            return {
              content: e.text,
              // 供应商没给流式片段时，最终文本补成一个块
              blocks: hasText ? m.blocks : [...(m.blocks ?? []), { type: "text", text: e.text }],
              hits: e.hits,
              costUsd: e.costUsd,
            };
          });
          break;
        case "error":
          if (askRef.current) {
            finish((m) => ({
              error: !m.blocks?.length,
              content: m.content || e.message,
              blocks: [...(m.blocks ?? []), { type: "text", text: `出错了：${e.message}` }],
              ...(e.hits?.length ? { hits: e.hits } : {}),
            }));
          }
          break;
      }
    },
    [finish, patchBlocks, flushDeltas],
  );

  useEffect(() => {
    const un = api.onAgentEvent(onEvent);
    return () => {
      void un.then((f) => f());
    };
  }, [onEvent]);


  // ---------- 导入 ----------

  /** 真正开始导入。每一项已经说明了怎么归成书 */
  const runImport = useCallback(
    async (items: ImportItem[]) => {
      if (!items.length) return;
      setImporting("准备导入…");
      try {
        const r = await api.importPaths(items);
        if (r.failed.length) setError(`有 ${r.failed.length} 个文件没导入成功：${r.failed.slice(0, 3).join("；")}`);
        setNotice(summaryText(r));
      } catch (err) {
        setError(String(err));
      } finally {
        setImporting(null);
        refreshBooks();
        // 单独的书并进文件夹那本书时，它的对话也跟着过去了
        refreshSessions();
      }
    },
    [refreshBooks, refreshSessions],
  );

  /** 用户选了 / 拖进来一些路径：先看看是什么，文件夹和同一个文件夹里的几个文件要问一下怎么归成书 */
  const startImport = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      // 上一批还在问「怎么归成书」：先答完那一批。不然新的一批会把那一批顶掉、或者被它的选项误伤
      const busyNote = "先决定上一批怎么放到书架上，再添加新的。";
      if (planPending.current) return setNotice(busyNote);
      try {
        const plan = planImport(await api.scanPaths(paths), booksRef.current);
        if (planPending.current) return setNotice(busyNote);
        if (plan.empty.length) setNotice(`「${plan.empty.join("」「")}」里没有能导入的文件`);
        if (plan.folders.length || plan.groups.length) {
          planPending.current = true;
          setImportPlan(plan);
        } else await runImport(plan.ready);
      } catch (err) {
        setError(String(err));
      }
    },
    [runImport],
  );

  async function pickAndImport(what: "files" | "folder") {
    // 浏览器预览里没有系统的文件对话框，给一个假路径，方便看询问框长什么样
    if (api.isPreview) return void startImport(["/Users/demo/AgentFlow"]);
    const picked =
      what === "folder"
        ? await openDialog({ directory: true, multiple: true, title: "选择文件夹" })
        : await openDialog({ multiple: true, filters: [{ name: "书和文档", extensions: IMPORT_EXTENSIONS }] });
    if (picked) void startImport(Array.isArray(picked) ? picked : [picked]);
  }

  // 导入进度 + 拖文件进窗口
  useEffect(() => {
    const stageText = { parsing: "解析", indexing: "建索引", done: "完成", error: "失败" } as const;
    const un1 = api.onImportProgress((p) => {
      const tag = p.total > 1 ? `(${p.index}/${p.total}) ` : "";
      setImporting(`${tag}${stageText[p.stage]} ${p.name}`);
      if (p.stage === "done") refreshBooks();
    });
    const un2 = api.onFileDrop((paths) => void startImport(paths), setDropHover);
    // 向量是导入之后在后台补的
    const un3 = api.onVectorProgress((p) => {
      if (p.error) {
        setVectorizing(null);
        setError(`向量接口出错，已暂停（全文检索不受影响）：${p.error}`);
      } else setVectorizing(p.done < p.total ? `建立语义索引 ${p.done}/${p.total}` : null);
    });
    return () => {
      void un1.then((f) => f());
      void un2.then((f) => f());
      void un3.then((f) => f());
    };
  }, [startImport, refreshBooks]);

  // 提示条自己会消失
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(t);
  }, [notice]);

  // 正在读的那一篇被移除了（或者整本书被移除）：关掉阅读器
  useEffect(() => {
    if (booksLoaded && reading && !readingDoc) {
      setReading(null);
      readingInfo.current = null;
      setCollapsed(false);
    }
  }, [booksLoaded, reading, readingDoc]);

  // 启动：读设置 → 起 agent → 读书架和会话
  useEffect(() => {
    void (async () => {
      refreshSessions();
      let list: Book[] = [];
      try {
        list = await api.listBooks();
        setBooks(list);
        booksRef.current = list;
        setBooksLoaded(true);
      } catch (err) {
        setError(String(err));
      }
      if (api.isPreview) await preview(list);
      try {
        const raw = await api.getSetting(SETTINGS_KEY);
        if (!raw) return setShowSettings(true);
        const s = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
        setSettings(s);
        if (s.apiKey) await startAgent();
        else setShowSettings(true);
      } catch (err) {
        setError(String(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSessions, startAgent]);

  /** 浏览器预览：用网址参数直接摆出某个界面，方便看效果。
   *  ?book=d4 打开一篇（也可以给书的 id）；&hl=原文 模拟助手划线；?chat 打开示例会话；&read / &readmd 点开引用；
   *  ?info=b2 书的详情；?import 导入询问框 */
  async function preview(list: Book[]) {
    const q = location.search;
    const book = /book=(\w+)/.exec(q);
    if (book) {
      const owner = list.find((b) => b.id === book[1] || b.docs.some((d) => d.id === book[1]));
      const doc = owner?.docs.find((d) => d.id === book[1]) ?? owner?.docs[0];
      if (owner && doc) {
        if (owner.docs.length > 1) setReaderPanel("toc");
        showDoc(doc.id);
        const hl = /hl=([^&]+)/.exec(q);
        if (hl) setReaderCmd({ callId: "preview", action: "highlight", docId: doc.id, quote: decodeURIComponent(hl[1]), note: "助手加的笔记" });
      }
    }
    const info = /info=(\w+)/.exec(q);
    if (info) setInfoBookId(info[1]);
    if (q.includes("import")) void startImport(["/Users/demo/AgentFlow"]);
    if (q.includes("chat")) {
      setView("chat");
      const all = await api.listSessions();
      const s = all.find((x) => x.id === "s1") ?? all[0];
      if (s) {
        const msgs = await api.getMessages(s.id);
        setMessages(msgs);
        setCurrent(s);
        const h = msgs.at(-1)?.hits?.[q.includes("readmd") ? 1 : 0];
        if (h && q.includes("read")) {
          readerFrom.current = "chat";
          showDoc(h.docId, { page: h.page, quote: h.text });
        }
      }
    }
  }

  async function saveSettings(s: Settings) {
    try {
      await api.setSetting(SETTINGS_KEY, JSON.stringify(s));
      setSettings(s);
      void api.fillVectors();
      await startAgent();
      setShowSettings(false);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  // ---------- 提问 ----------

  interface SendOptions {
    /** 这一问只在这些篇里找（阅读器里的一键动作：就在正读的这本书里） */
    docIds?: string[];
    /** 上面那个范围怎么称呼 */
    label?: string;
    /** 这一问不管会话选的范围，找整个书架（「找相关」） */
    wholeShelf?: boolean;
    /** 新开会话时用的标题（不然用问题的开头） */
    title?: string;
    /** 不接着现在这段对话，另开一段 */
    fresh?: boolean;
  }

  async function send(question: string, withQuote: Quote | null = quote, opts: SendOptions = {}) {
    setError(null);
    setQuote(null);
    let session = opts.fresh ? null : current;
    if (opts.fresh) setMessages([]);
    try {
      if (!session) {
        // 读书时开的对话归这本书。只在新建时定：一段已经聊起来的对话不会因为顺手点开了哪本书就被划过去
        session = {
          id: crypto.randomUUID(),
          sdkSessionId: null,
          title: (opts.title ?? question).slice(0, 40),
          updatedAt: Date.now() / 1000,
          bookId: readingBook?.id ?? null,
          bookTitle: readingBook?.title ?? null,
          scope: opts.fresh ? null : pendingScope,
        };
        await api.upsertSession(session.id, session.title, null, session.bookId);
        if (session.scope) await api.setSessionScope(session.id, session.scope);
        setCurrent(session);
        setPendingScope(null);
      }
      const book = session.bookId ? (books.find((b) => b.id === session!.bookId) ?? null) : null;
      const resolved = resolveScope(session.scope, book, books);
      const docIds = opts.wholeShelf ? undefined : (opts.docIds ?? resolved.docIds);
      const scopeLabel = opts.wholeShelf ? "整个书架" : (opts.label ?? resolved.label);

      const user: Message = { role: "user", content: question, ...(withQuote ? { quote: withQuote } : {}) };
      await api.addMessage(session.id, user);
      setMessages((m) => [...m, user, { role: "assistant", content: "", blocks: [], pending: true }]);
      const id = crypto.randomUUID();
      const t0 = Date.now();
      askRef.current = { id, session, startedAt: t0 };
      setStartedAt(t0);
      setBusy(true);

      const info = readingInfo.current;
      await api.agentSend({
        type: "ask",
        id,
        // 引文拼进发给助手的文本里；界面上问题和引文分开显示
        question: withQuote
          ? `我在《${withQuote.docTitle}》${
              withQuote.page ? `第 ${withQuote.page} ${unitOf(withQuote.kind, withQuote.docTitle)}` : ""
            }选中了这段原文：\n"""\n${withQuote.text}\n"""\n\n${question}`
          : question,
        sessionId: session.sdkSessionId ?? undefined,
        docIds,
        // 这段对话属于哪本书。各篇的清单在一段对话的第一问给（它会留在助手那边的会话里，不用每问都带），
        // 助手进程重启后也要再给一次（按篇号翻页、读原文靠它）
        book: book
          ? {
              id: book.id,
              title: book.title,
              scopeLabel,
              parts:
                session.sdkSessionId && partsSent.current.get(book.id) === partsKey(book)
                  ? undefined
                  : book.docs.slice(0, 60).map((d) => ({ n: d.position + 1, docId: d.id, name: d.name, kind: d.kind, opened: d.opened })),
            }
          : undefined,
        // 阅读器开着的话，告诉助手用户在看哪本、哪一篇、读到哪
        reading:
          readingDoc && readingBook && info?.docId === readingDoc.id
            ? {
                docId: readingDoc.id,
                bookId: readingBook.id,
                bookTitle: readingBook.title,
                docTitle: readingDoc.displayTitle,
                kind: readingDoc.kind,
                part: readingDoc.position + 1,
                partCount: readingBook.docs.length,
                page: info.page,
                chapter: info.chapter,
                fraction: info.fraction,
                spoilerFree: readingBook.spoilerFree,
              }
            : undefined,
        k: settings.topK,
        cwd: settings.workspace ?? undefined,
      });
      if (book) partsSent.current.set(book.id, partsKey(book));
      refreshSessions();
      if (session.bookId) refreshBooks(); // 书上的对话数变了
    } catch (err) {
      setError(String(err));
      // 已经放了一条「处理中」的回答就把它收尾，否则它会一直转
      if (askRef.current) {
        finish((m) => ({ error: true, content: String(err), blocks: [...(m.blocks ?? []), { type: "text", text: `没发出去：${String(err)}` }] }));
      } else setBusy(false);
    }
  }

  function stop() {
    const ask = askRef.current;
    if (!ask) return;
    void api.agentSend({ type: "abort", id: ask.id });
    finish((m) => ({
      content: m.blocks?.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "",
      blocks: [...(m.blocks ?? []), { type: "text", text: "*（已停止）*" }],
    }));
  }

  // ---------- 对话 ----------

  /** 侧栏的「新对话」：不属于任何书的普通对话 */
  function newChat() {
    if (busy) return;
    setCurrent(null);
    setMessages([]);
    setPendingScope(null);
    setQuote(null);
    setReading(null);
    readingInfo.current = null;
    setCollapsed(false);
    setView("chat");
  }

  /** 阅读器旁边的「＋」：不离开这本书，为它开一段新对话 */
  function newBookChat() {
    if (busy) return;
    setCurrent(null);
    setMessages([]);
    setPendingScope(null);
    setQuote(null);
  }

  async function loadSession(s: Session) {
    setMessages(await api.getMessages(s.id));
    setCurrent(s);
    setQuote(null);
  }

  /** 打开一段对话。它属于某本书的话，把书也一起打开——对话和书是连着的 */
  async function openSession(s: Session) {
    if (busy) return;
    try {
      await loadSession(s);
      const book = s.bookId ? books.find((b) => b.id === s.bookId) : null;
      if (book) {
        if (readingBook?.id !== book.id) {
          const doc = resumePart(book);
          if (doc) {
            readerFrom.current = "library";
            showDoc(doc.id);
          }
        }
      } else if (!reading) setView("chat");
      else if (readerFrom.current === "library") {
        // 正读着书时点开一段和书无关的对话：收起阅读器，把对话摊开看
        setReading(null);
        readingInfo.current = null;
        setCollapsed(false);
        setView("chat");
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function removeSession(s: Session) {
    await api.deleteSession(s.id);
    if (current?.id === s.id) {
      setCurrent(null);
      setMessages([]);
    }
    refreshSessions();
    refreshBooks();
  }

  /** 把一段对话归到某本书下面，或者拿出来 */
  async function linkSession(s: Session, bookId: string | null) {
    try {
      await api.setSessionBook(s.id, bookId);
      const title = bookId ? (books.find((b) => b.id === bookId)?.title ?? null) : null;
      if (current?.id === s.id) setCurrent({ ...s, bookId, bookTitle: title });
      refreshSessions();
      refreshBooks();
    } catch (err) {
      setError(String(err));
    }
  }

  function changeScope(next: Scope | null) {
    if (!current) return setPendingScope(next);
    setCurrent({ ...current, scope: next });
    setSessions((list) => list.map((s) => (s.id === current.id ? { ...s, scope: next } : s)));
    void api.setSessionScope(current.id, next).catch((err) => setError(String(err)));
  }

  function setSpoiler(book: Book, on: boolean) {
    void api.setBookSpoiler(book.id, on).then(refreshBooks, (err) => setError(String(err)));
  }

  // ---------- 打开书 ----------

  function showDoc(docId: string, at: Partial<Omit<ReadTarget, "docId" | "nonce">> = {}) {
    setReading({ docId, ...at, nonce: Date.now() });
    setCollapsed(true);
  }

  /** 从书架、侧栏、详情里打开一本书：翻到上次读的那一篇，右边接上这本书最近的那段对话 */
  async function openBook(book: Book, docId?: string) {
    const doc = book.docs.find((d) => d.id === docId) ?? resumePart(book);
    if (!doc) return;
    // 第一次打开一本多篇的书：把目录摆出来，让人看到里面有什么
    if (book.docs.length > 1 && book.readAt == null) setReaderPanel("toc");
    readerFrom.current = "library";
    showDoc(doc.id);
    // 正在回答的时候不换对话（换了这条回答就没处落了）；用户之后可以从右上角的历史里切
    if (busy || current?.bookId === book.id) return;
    const latest = sessions.find((s) => s.bookId === book.id);
    try {
      if (latest) await loadSession(latest);
      else newBookChat();
    } catch (err) {
      setError(String(err));
    }
  }

  /** 从引用、引文点进原文：只翻书，不动对话 */
  function openDoc(docId: string, page?: number | null, quoteText?: string, cfi?: string) {
    if (!docs.some((d) => d.id === docId)) return setNotice("这本书已经不在书架上了，原文打不开。");
    if (!reading) readerFrom.current = view;
    showDoc(docId, { page, quote: quoteText, cfi });
  }
  const openHit = (h: Hit) => openDoc(h.docId, h.page, h.text);

  function closeReader() {
    setReading(null);
    readingInfo.current = null;
    setCollapsed(false);
    setView(readerFrom.current);
    refreshBooks();
  }

  /** 阅读器做完了助手交代的事，回话 */
  const onReaderDone = useCallback((callId: string, ok: boolean, message: string) => {
    setReaderCmd((c) => (c?.callId === callId ? null : c));
    void api.agentSend({ type: "reader_result", callId, ok, message });
  }, []);
  const onLocation = useCallback((info: ReadingInfo) => {
    readingInfo.current = info;
  }, []);

  /** 换工作文件夹：只存设置，不用重启助手（每次提问都会带上） */
  async function setWorkspace(workspace: string | null) {
    const next = { ...settings, workspace };
    setSettings(next);
    try {
      await api.setSetting(SETTINGS_KEY, JSON.stringify(next));
      if (agent === "ready") await api.agentSend({ type: "extensions", cwd: workspace ?? undefined });
    } catch (err) {
      setError(String(err));
    }
  }
  async function pickWorkspace() {
    const dir = await openDialog({ directory: true, multiple: false, title: "选择工作文件夹" });
    if (typeof dir === "string") await setWorkspace(dir);
  }

  /** 阅读器里划词后的三个动作 */
  function onSelection(action: SelectionAction, text: string, page: number | null, cfi: string) {
    const d = readingDoc;
    if (!d) return;
    const q: Quote = { text, docId: d.id, docTitle: d.displayTitle, kind: d.kind, page, cfi };
    if (action === "ask") return setQuote(q); // 放进输入框，等用户写问题
    if (busy || agent !== "ready") return setQuote(q);
    if (action === "explain") void send("解释一下这段话：它是什么意思，在这本书里起什么作用。", q);
    // 找相关：就是要跨书找，不管这段对话平时只在哪本书里找
    else void send("在我的书架里找出和这段内容相关的其它地方，说明它们之间的关系（有没有呼应、补充或矛盾）。", q, { wholeShelf: true });
  }

  /** 阅读器里的一键动作：就正在读的这本书问助手。对话不是这本书的，就为它另开一段 */
  function askAboutBook(book: Book, prompt: string, title?: string) {
    if (busy || agent !== "ready") return setError("助手还没准备好，稍后再试");
    void send(prompt, null, {
      docIds: book.docs.map((d) => d.id),
      label: `《${book.title}》`,
      title,
      fresh: !!current && current.bookId !== book.id,
    });
  }

  /** 把助手对一段原文的回答记到那段话上：已有划线就追加到它的笔记里，没有就新建一条 */
  async function saveAnswerAsNote(q: Quote, answer: string) {
    if (!q.cfi) return;
    try {
      const all = await api.listAnnotations({ docId: q.docId });
      const old = all.find((a) => a.kind === "highlight" && a.cfi === q.cfi);
      const now = Math.floor(Date.now() / 1000);
      const note: Annotation = old
        ? { ...old, note: old.note ? `${old.note}\n\n${answer}` : answer, updatedAt: now }
        : {
            id: crypto.randomUUID(),
            docId: q.docId,
            kind: "highlight",
            cfi: q.cfi,
            text: q.text,
            note: answer,
            color: "yellow",
            style: "highlight",
            label: "",
            page: q.page,
            createdAt: now,
            updatedAt: now,
          };
      await api.saveAnnotation(note);
      setNotesVersion((v) => v + 1);
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }

  function answerApproval(requestId: string, allow: boolean, remember = false) {
    void api.agentSend({ type: "approval", requestId, allow, remember });
    patchBlocks((bs) =>
      bs.map((b) =>
        b.type === "tool" && b.approval?.requestId === requestId
          ? { ...b, approval: { requestId, state: allow ? "allowed" : "denied" } }
          : b,
      ),
    );
  }

  // ---------- 书的管理 ----------

  async function removeBook(book: Book, withSessions: boolean) {
    setRemoving(null);
    setInfoBookId(null);
    try {
      await api.deleteBook(book.id, withSessions);
      if (current?.bookId === book.id) {
        if (withSessions) {
          setCurrent(null);
          setMessages([]);
        } else setCurrent({ ...current, bookId: null });
      }
      if (readingBook?.id === book.id) closeReader();
      setNotice(`《${book.title}》已从书架移除，原文件没有动。`);
    } catch (err) {
      setError(String(err));
    } finally {
      refreshBooks();
      refreshSessions();
    }
  }

  const pickCover = (book: Book) => void api.pickBookCover(book.id).then(refreshBooks, (err) => setError(String(err)));
  const reveal = (book: Book) => void api.revealBook(book.id).catch((err) => setError(String(err)));

  const status = {
    unconfigured: { text: "未配置模型 · 点击设置", tone: "warn" as const },
    starting: { text: "连接中…", tone: "idle" as const },
    ready: { text: settings.model, tone: "ok" as const },
    down: { text: "助手已断开 · 点击重连", tone: "bad" as const },
  }[agent];

  const infoBook = infoBookId ? (books.find((b) => b.id === infoBookId) ?? null) : null;
  const progress = importing ?? vectorizing;

  return (
    <div className="flex h-screen flex-col">
      {error && (
        <button
          className="border-b border-danger-ring bg-danger-soft px-4 py-2 text-left text-[12px] text-danger"
          onClick={() => setError(null)}
        >
          {error}　<span className="opacity-60">点击关闭</span>
        </button>
      )}
      {notice && !error && (
        <button className="border-b border-hairline bg-segment-bg px-4 py-2 text-left text-[12px] text-text-2" onClick={() => setNotice(null)}>
          {notice}
        </button>
      )}

      <main className="flex min-h-0 flex-1">
        <Sidebar
          sessions={sessions}
          books={books}
          currentId={current?.id ?? null}
          status={status}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((v) => !v)}
          progress={progress}
          atLibrary={!readingDoc && view === "library"}
          onOpenLibrary={() => {
            readerFrom.current = "library";
            if (reading) closeReader();
            setView("library");
          }}
          onNewChat={newChat}
          onOpenSession={(s) => void openSession(s)}
          onDeleteSession={(s) => void removeSession(s)}
          onUnlinkSession={(s) => void linkSession(s, null)}
          onOpenBook={(b) => void openBook(b)}
          onOpenSettings={() => setShowSettings(true)}
        />
        {readingDoc && readingBook && reading && (
          <Reader
            key={readingDoc.id}
            book={readingBook}
            doc={readingDoc}
            panel={readerPanel}
            onPanel={setReaderPanel}
            command={readerCmd?.docId === readingDoc.id ? readerCmd : null}
            onCommandDone={onReaderDone}
            onLocation={onLocation}
            target={reading}
            notesVersion={notesVersion}
            onClose={closeReader}
            onSelection={onSelection}
            onAsk={(prompt, title) => askAboutBook(readingBook, prompt, title)}
            onOpenPart={(docId, at) => showDoc(docId, at)}
            onInfo={() => setInfoBookId(readingBook.id)}
            onSpoiler={(on) => setSpoiler(readingBook, on)}
            onBooksChanged={refreshBooks}
            onError={setError}
          />
        )}
        {!readingDoc && view === "library" && (
          <Library
            books={books}
            progress={progress}
            onOpen={(b, docId) => void openBook(b, docId)}
            onAdd={(what) => void pickAndImport(what)}
            onInfo={(b) => setInfoBookId(b.id)}
            onPickCover={pickCover}
            onReveal={reveal}
            onRemove={setRemoving}
          />
        )}
        <div
          className={
            readingDoc ? "flex w-[400px] shrink-0 border-l border-hairline" : view === "library" ? "hidden" : "flex min-w-0 flex-1"
          }
        >
          <ChatPanel
            title={current?.title ?? null}
            compact={!!readingDoc}
            messages={messages}
            busy={busy}
            startedAt={startedAt}
            ready={agent === "ready"}
            model={settings.model}
            onSend={(q) => void send(q)}
            onStop={stop}
            onCite={openHit}
            onApproval={answerApproval}
            quote={quote}
            onClearQuote={() => setQuote(null)}
            onOpenQuote={(q) => openDoc(q.docId, q.page, q.text, q.cfi)}
            onSaveNote={saveAnswerAsNote}
            workspace={settings.workspace}
            onPickWorkspace={() => void pickWorkspace()}
            onClearWorkspace={() => void setWorkspace(null)}
            books={books}
            book={sessionBook}
            openBook={readingBook}
            openDoc={readingDoc}
            bookSessions={readingBook ? sessions.filter((s) => s.bookId === readingBook.id) : []}
            currentId={current?.id ?? null}
            scope={scope}
            onScope={changeScope}
            onSpoiler={setSpoiler}
            onOpenSession={(s) => void openSession(s)}
            onNewBookChat={newBookChat}
            onLinkToOpenBook={() => {
              if (current && readingBook) void linkSession(current, readingBook.id);
            }}
          />
        </div>
      </main>

      {dropHover && (
        <div className="pointer-events-none fixed inset-3 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-accent-dim backdrop-blur-[2px]">
          <div className="display-serif text-[22px] text-text">松手放到书架上</div>
        </div>
      )}

      {importPlan && (
        <ImportDialog
          plan={importPlan}
          onCancel={() => {
            planPending.current = false;
            setImportPlan(null);
          }}
          onConfirm={(items) => {
            planPending.current = false;
            setImportPlan(null);
            void runImport(items);
          }}
        />
      )}

      {infoBook && !removing && (
        <BookInfoModal
          book={infoBook}
          sessions={sessions.filter((s) => s.bookId === infoBook.id)}
          onClose={() => setInfoBookId(null)}
          onChanged={() => {
            refreshBooks();
            refreshSessions();
          }}
          onOpen={(b, docId) => void openBook(b, docId)}
          onOpenSession={(s) => void openSession(s)}
          onRemove={setRemoving}
          onNotice={setNotice}
          onError={setError}
        />
      )}
      {removing && <RemoveBookDialog book={removing} onCancel={() => setRemoving(null)} onConfirm={(withSessions) => void removeBook(removing, withSessions)} />}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
          onDocsChanged={refreshBooks}
          extensions={extensions}
        />
      )}
    </div>
  );
}
