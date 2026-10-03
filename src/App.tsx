import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChatPanel } from "./components/ChatPanel";
import { Library } from "./components/Library";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { Reader, type ReadTarget, type SelectionAction } from "./reader/Reader";
import * as api from "./lib/api";
import {
  DEFAULT_SETTINGS,
  type AgentEvent,
  type Annotation,
  type Block,
  type Doc,
  type Extensions,
  type Hit,
  type Message,
  type Quote,
  type ReaderCommand,
  type ReadingInfo,
  type Session,
  type Settings,
} from "./lib/types";

const SETTINGS_KEY = "settings";
type AgentState = "unconfigured" | "starting" | "ready" | "down";

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [agent, setAgent] = useState<AgentState>("unconfigured");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [current, setCurrent] = useState<Session | null>(null);
  const [messages, setMessagesState] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const [view, setView] = useState<"library" | "chat">("library");

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
  /** 阅读器当前的位置（翻页时更新，不触发渲染） */
  const readingInfo = useRef<ReadingInfo | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const refreshDocs = useCallback(() => {
    api.listDocuments().then(setDocs, (e) => setError(String(e)));
  }, []);
  const refreshSessions = useCallback(() => {
    api.listSessions().then(setSessions, (e) => setError(String(e)));
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
          // 书没开着就先打开；阅读器准备好后会执行这条指令并回话
          if (readingRef.current?.docId !== e.docId) {
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

  const importPaths = useCallback(
    async (paths: string[]) => {
      setImporting("准备导入…");
      try {
        const res = await api.importPaths(paths);
        if (res.failed.length) setError(`有 ${res.failed.length} 个文件没导入成功：${res.failed.slice(0, 3).join("；")}`);
      } catch (err) {
        setError(String(err));
      } finally {
        setImporting(null);
        refreshDocs();
      }
    },
    [refreshDocs],
  );

  // 导入进度 + 拖文件进窗口
  useEffect(() => {
    const stageText = { parsing: "解析", indexing: "建索引", done: "完成", error: "失败" } as const;
    const un1 = api.onImportProgress((p) => {
      const tag = p.total > 1 ? `(${p.index}/${p.total}) ` : "";
      setImporting(`${tag}${stageText[p.stage]} ${p.name}`);
      if (p.stage === "done") refreshDocs();
    });
    const un2 = api.onFileDrop((paths) => void importPaths(paths), setDropHover);
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
  }, [importPaths, refreshDocs]);

  // 启动：读设置 → 起 agent → 读文档和会话
  useEffect(() => {
    void (async () => {
      refreshDocs();
      refreshSessions();
      // 浏览器预览：?chat 直接打开示例会话，方便看对话界面
      // 浏览器预览：?book=d4 直接打开一本书
      const book = api.isPreview ? /book=(\w+)/.exec(location.search) : null;
      if (book) openDoc(book[1]);
      // ?book=d4&hl=原文：模拟助手让阅读器划线
      const hl = api.isPreview && book ? /hl=([^&]+)/.exec(location.search) : null;
      if (book && hl) {
        setReaderCmd({ callId: "preview", action: "highlight", docId: book[1], quote: decodeURIComponent(hl[1]), note: "助手加的笔记" });
      }
      if (api.isPreview && location.search.includes("chat")) {
        setView("chat");
        const list = await api.listSessions();
        if (list[0]) {
          const msgs = await api.getMessages(list[0].id);
          setMessages(msgs);
          setCurrent(list[0]);
          const h = msgs.at(-1)?.hits?.[location.search.includes("readmd") ? 1 : 0];
          if (h && location.search.includes("read")) openHit(h);
        }
      }
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
  }, [refreshDocs, refreshSessions, startAgent]);

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

  async function send(question: string, withQuote: Quote | null = quote, scope?: string[]) {
    setError(null);
    setQuote(null);
    let session = current;
    try {
      if (!session) {
        session = {
          id: crypto.randomUUID(),
          sdkSessionId: null,
          title: question.slice(0, 40),
          updatedAt: Date.now() / 1000,
        };
        await api.upsertSession(session.id, session.title, null);
        setCurrent(session);
      }
      const user: Message = { role: "user", content: question, ...(withQuote ? { quote: withQuote } : {}) };
      await api.addMessage(session.id, user);
      setMessages((m) => [...m, user, { role: "assistant", content: "", blocks: [], pending: true }]);
      const id = crypto.randomUUID();
      const t0 = Date.now();
      askRef.current = { id, session, startedAt: t0 };
      setStartedAt(t0);
      setBusy(true);
      await api.agentSend({
        type: "ask",
        id,
        // 引文拼进发给助手的文本里；界面上问题和引文分开显示
        question: withQuote
          ? `我在《${withQuote.docTitle}》${withQuote.page ? `第 ${withQuote.page} 页` : ""}选中了这段原文：\n"""\n${withQuote.text}\n"""\n\n${question}`
          : question,
        sessionId: session.sdkSessionId ?? undefined,
        docIds: scope ?? (selected.size ? [...selected] : undefined),
        // 阅读器开着的话，告诉助手用户在看哪本、读到哪
        reading: reading && readingInfo.current?.docId === reading.docId ? readingInfo.current : undefined,
        k: settings.topK,
        cwd: settings.workspace ?? undefined,
      });
      refreshSessions();
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

  function newChat() {
    if (busy) return;
    setCurrent(null);
    setMessages([]);
    setReading(null);
    setView("chat");
  }

  async function openSession(s: Session) {
    if (busy) return;
    try {
      setMessages(await api.getMessages(s.id));
      setCurrent(s);
      setReading(null);
      setView("chat");
    } catch (err) {
      setError(String(err));
    }
  }

  async function removeSession(s: Session) {
    await api.deleteSession(s.id);
    if (current?.id === s.id) newChat();
    refreshSessions();
  }

  /** 打开文档阅读：侧栏自动收起，把空间让给正文 */
  function openDoc(docId: string, page?: number | null, quote?: string, cfi?: string) {
    setReading({ docId, page, quote, cfi, nonce: Date.now() });
    setCollapsed(true);
  }
  const openHit = (h: Hit) => openDoc(h.docId, h.page, h.text);
  function closeReader() {
    setReading(null);
    readingInfo.current = null;
    setCollapsed(false);
    setView("library");
    refreshDocs();
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
    const d = docs.find((x) => x.id === reading?.docId);
    if (!d) return;
    const q: Quote = { text, docId: d.id, docTitle: d.title, page, cfi };
    if (action === "ask") return setQuote(q); // 放进输入框，等用户写问题
    if (busy || agent !== "ready") return setQuote(q);
    void send(
      action === "explain"
        ? "解释一下这段话：它是什么意思，在这份文档里起什么作用。"
        : "在我的文档里找出和这段内容相关的其它地方，说明它们之间的关系（有没有呼应、补充或矛盾）。",
      q,
    );
  }

  /** 阅读器里的一键动作：就正在读的这本书问助手 */
  function askAboutBook(d: Doc, prompt: string) {
    if (busy || agent !== "ready") return setError("助手还没准备好，稍后再试");
    void send(prompt, null, [d.id]);
  }

  /** 把助手对一段原文的回答记到那段话上：已有划线就追加到它的笔记里，没有就新建一条 */
  async function saveAnswerAsNote(q: Quote, answer: string) {
    if (!q.cfi) return;
    try {
      const all = await api.listAnnotations(q.docId);
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

  const status = {
    unconfigured: { text: "未配置模型 · 点击设置", tone: "warn" as const },
    starting: { text: "连接中…", tone: "idle" as const },
    ready: { text: settings.model, tone: "ok" as const },
    down: { text: "助手已断开 · 点击重连", tone: "bad" as const },
  }[agent];

  const readingDoc = reading ? (docs.find((d) => d.id === reading.docId) ?? null) : null;

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

      <main className="flex min-h-0 flex-1">
        <Sidebar
          sessions={sessions}
          currentId={current?.id ?? null}
          docs={docs}
          selected={selected}
          status={status}
          onNewChat={newChat}
          onOpenSession={(s) => void openSession(s)}
          onDeleteSession={(s) => void removeSession(s)}
          onToggleDoc={(id) =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onDocsChanged={refreshDocs}
          onOpenSettings={() => setShowSettings(true)}
          onError={setError}
          collapsed={collapsed}
          readingId={reading?.docId ?? null}
          onToggleCollapsed={() => setCollapsed((v) => !v)}
          onOpenDoc={(d) => openDoc(d.id)}
          progress={importing ?? vectorizing}
          onImport={(paths) => void importPaths(paths)}
          atLibrary={!readingDoc && view === "library"}
          onOpenLibrary={() => {
            if (reading) closeReader();
            setView("library");
          }}
        />
        {readingDoc && reading && (
          <Reader
            key={readingDoc.id}
            doc={readingDoc}
            command={readerCmd?.docId === readingDoc.id ? readerCmd : null}
            onCommandDone={onReaderDone}
            onLocation={onLocation}
            target={reading}
            notesVersion={notesVersion}
            onClose={closeReader}
            onSelection={onSelection}
            onAsk={(prompt) => askAboutBook(readingDoc, prompt)}
            onDocsChanged={refreshDocs}
            onError={setError}
          />
        )}
        {!readingDoc && view === "library" && (
          <Library docs={docs} progress={importing} onOpen={(d) => openDoc(d.id)} onImport={(paths) => void importPaths(paths)} />
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
            docCount={docs.length}
            scopeCount={selected.size}
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
          />
        </div>
      </main>

      {dropHover && (
        <div className="pointer-events-none fixed inset-3 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-accent-dim backdrop-blur-[2px]">
          <div className="display-serif text-[22px] text-text">松手导入</div>
        </div>
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
          onDocsChanged={refreshDocs}
          extensions={extensions}
        />
      )}
    </div>
  );
}
