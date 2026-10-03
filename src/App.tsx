import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Settings as SettingsIcon, ShieldCheck } from "lucide-react";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { Viewer } from "./components/Viewer";
import { GlassModal } from "./components/ui/GlassModal";
import { PrimaryButton } from "./components/ui/PrimaryButton";
import { SecondaryButton } from "./components/ui/SecondaryButton";
import * as api from "./lib/api";
import {
  DEFAULT_SETTINGS,
  type AgentEvent,
  type Doc,
  type Hit,
  type Message,
  type Session,
  type Settings,
} from "./lib/types";

const SETTINGS_KEY = "settings";
type AgentState = "unconfigured" | "starting" | "ready" | "down";

interface Approval {
  requestId: string;
  name: string;
  input: Record<string, unknown>;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [agent, setAgent] = useState<AgentState>("unconfigured");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [current, setCurrent] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cite, setCite] = useState<Hit | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const approvalTitle = useId();

  // 事件回调里要读最新值，用 ref 避免闭包拿到旧状态
  const askRef = useRef<{ id: string; session: Session } | null>(null);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

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
  }, []);

  const finish = useCallback(
    (patch: Partial<Message>) => {
      const ask = askRef.current;
      askRef.current = null;
      setBusy(false);
      setStatus(null);
      const last = messagesRef.current[messagesRef.current.length - 1];
      if (!ask || last?.role !== "assistant") return;
      const done: Message = { ...last, ...patch, pending: false };
      patchLast(() => done);
      void api.addMessage(ask.session.id, done).then(refreshSessions);
    },
    [patchLast, refreshSessions],
  );

  const onEvent = useCallback(
    (e: AgentEvent) => {
      if (e.type === "ready") return setAgent("ready");
      if (e.type === "exited") return setAgent((s) => (s === "starting" ? s : "down"));
      const ask = askRef.current;
      if (!ask || !("id" in e) || e.id !== ask.id) {
        if (e.type === "error" && !("id" in e && e.id)) setError(e.message);
        return;
      }
      switch (e.type) {
        case "session": {
          const s = { ...ask.session, sdkSessionId: e.sessionId };
          ask.session = s;
          setCurrent(s);
          void api.upsertSession(s.id, s.title, e.sessionId);
          break;
        }
        case "delta":
          setStatus(null);
          patchLast((m) => ({ ...m, content: m.content + e.text }));
          break;
        case "tool":
          if (e.name.endsWith("search_docs")) setStatus(`检索：${String(e.input.query ?? "")}`);
          patchLast((m) => ({ ...m, tools: [...(m.tools ?? []), { name: e.name, input: e.input }] }));
          break;
        case "tool_result":
          patchLast((m) => {
            const tools = [...(m.tools ?? [])];
            const i = tools.length - 1;
            if (i >= 0) tools[i] = { ...tools[i], summary: e.summary };
            return { ...m, tools };
          });
          setStatus("整理回答…");
          break;
        case "approval_request":
          setApproval({ requestId: e.requestId, name: e.name, input: e.input });
          break;
        case "result":
          finish({ content: e.text || messagesRef.current.at(-1)?.content || "", hits: e.hits, costUsd: e.costUsd });
          break;
        case "error":
          // 已经拿到正文的情况下（result 之后的收尾报错）不覆盖回答
          if (askRef.current) finish({ content: `出错了：${e.message}`, error: true });
          break;
      }
    },
    [finish, patchLast],
  );

  useEffect(() => {
    const un = api.onAgentEvent(onEvent);
    return () => {
      void un.then((f) => f());
    };
  }, [onEvent]);

  // 启动：读设置 → 起 agent → 读文档和会话
  useEffect(() => {
    void (async () => {
      refreshDocs();
      refreshSessions();
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
      await startAgent();
      setShowSettings(false);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function send(question: string) {
    setError(null);
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
      const user: Message = { role: "user", content: question };
      await api.addMessage(session.id, user);
      setMessages((m) => [...m, user, { role: "assistant", content: "", pending: true }]);
      const id = crypto.randomUUID();
      askRef.current = { id, session };
      setBusy(true);
      setStatus("思考中…");
      await api.agentSend({
        type: "ask",
        id,
        question,
        sessionId: session.sdkSessionId ?? undefined,
        docIds: selected.size ? [...selected] : undefined,
        k: settings.topK,
      });
      refreshSessions();
    } catch (err) {
      setBusy(false);
      setStatus(null);
      setError(String(err));
    }
  }

  function stop() {
    const ask = askRef.current;
    if (!ask) return;
    void api.agentSend({ type: "abort", id: ask.id });
    finish({ content: `${messagesRef.current.at(-1)?.content ?? ""}\n\n（已停止）` });
  }

  function newChat() {
    if (busy) return;
    setCurrent(null);
    setMessages([]);
    setCite(null);
  }

  async function openSession(s: Session) {
    if (busy) return;
    try {
      setMessages(await api.getMessages(s.id));
      setCurrent(s);
      setCite(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function removeSession(s: Session) {
    await api.deleteSession(s.id);
    if (current?.id === s.id) newChat();
    refreshSessions();
  }

  function answerApproval(allow: boolean) {
    if (!approval) return;
    void api.agentSend({ type: "approval", requestId: approval.requestId, allow });
    setApproval(null);
  }

  const badge = {
    unconfigured: { text: "未配置模型", cls: "text-warm border-warm-ring" },
    starting: { text: "连接中…", cls: "text-text-3 border-hairline" },
    ready: { text: settings.model, cls: "text-good border-hairline" },
    down: { text: "助手已断开", cls: "text-danger border-danger-ring" },
  }[agent];

  return (
    <div className="flex h-screen flex-col">
      <nav className="flex items-center gap-3 border-b border-hairline px-4 py-2.5" data-tauri-drag-region>
        <span className="text-[14px] font-semibold tracking-tight text-text">DocAgent</span>
        <span className={`num rounded-full border px-2 py-0.5 text-[11px] ${badge.cls}`}>{badge.text}</span>
        <span className="flex-1" />
        <span className="hidden items-center gap-1 text-[11px] text-text-4 md:flex" title="文档解析、索引、检索都在本机完成；只有提问时会把问题和命中的片段发给模型接口">
          <ShieldCheck className="h-3.5 w-3.5" />
          文档与索引只存在本机
        </span>
        <button
          aria-label="设置"
          className="arc-close-btn grid h-7 w-7 place-items-center rounded-md"
          onClick={() => setShowSettings(true)}
        >
          <SettingsIcon className="h-4 w-4" />
        </button>
      </nav>

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
          onError={setError}
        />
        <ChatPanel
          messages={messages}
          status={status}
          busy={busy}
          ready={agent === "ready"}
          hasDocs={docs.length > 0}
          onSend={(q) => void send(q)}
          onStop={stop}
          onCite={setCite}
        />
        {cite && (
          <Viewer
            hit={cite}
            docPath={docs.find((d) => d.id === cite.docId)?.path ?? null}
            onClose={() => setCite(null)}
          />
        )}
      </main>

      {showSettings && (
        <SettingsModal
          settings={settings}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
          onDocsChanged={refreshDocs}
        />
      )}

      {approval && (
        <GlassModal
          open
          onClose={() => answerApproval(false)}
          labelledBy={approvalTitle}
          hairlineTone="warm"
          closeOnBackdrop={false}
        >
          <div className="px-5 pt-5">
            <h2 id={approvalTitle} className="text-[15px] font-semibold text-text">
              助手想保存一个文件
            </h2>
            <p className="mt-1 text-[12px] text-text-3">文件会写到「文稿/DocAgent」目录下。</p>
            <div className="mt-3 rounded-md bg-bg p-3 text-[12px]">
              <div className="num text-text">{String(approval.input.filename ?? "")}</div>
              <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-text-3">
                {String(approval.input.content ?? "").slice(0, 1200)}
              </pre>
            </div>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4">
            <SecondaryButton size="sm" onClick={() => answerApproval(false)}>
              拒绝
            </SecondaryButton>
            <PrimaryButton size="sm" tone="warm" onClick={() => answerApproval(true)}>
              同意保存
            </PrimaryButton>
          </div>
        </GlassModal>
      )}
    </div>
  );
}
