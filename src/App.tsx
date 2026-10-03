import { useCallback, useEffect, useRef, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { Viewer } from "./components/Viewer";
import * as api from "./lib/api";
import {
  DEFAULT_SETTINGS,
  type AgentEvent,
  type Block,
  type Doc,
  type Hit,
  type Message,
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cite, setCite] = useState<Hit | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // 事件回调里要读最新值，用 ref 避免闭包拿到旧状态
  const askRef = useRef<{ id: string; session: Session; startedAt: number } | null>(null);
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

  /** 改助手消息里的块时间线 */
  const patchBlocks = useCallback(
    (fn: (blocks: Block[]) => Block[]) => patchLast((m) => ({ ...m, blocks: fn(m.blocks ?? []) })),
    [patchLast],
  );

  const finish = useCallback(
    (patch: (m: Message) => Partial<Message>) => {
      const ask = askRef.current;
      askRef.current = null;
      setBusy(false);
      const last = messagesRef.current[messagesRef.current.length - 1];
      if (!ask || last?.role !== "assistant") return;
      const done: Message = {
        ...last,
        ...patch(last),
        pending: false,
        durationMs: Date.now() - ask.startedAt,
      };
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
          // 接在最后一个文字块后面；上一块是工具调用就另起一块，保持时间线顺序
          patchBlocks((bs) => {
            const last = bs[bs.length - 1];
            if (last?.type === "text") return [...bs.slice(0, -1), { ...last, text: last.text + e.text }];
            return [...bs, { type: "text", text: e.text }];
          });
          break;
        case "tool":
          patchBlocks((bs) => [...bs, { type: "tool", toolUseId: e.toolUseId, name: e.name, input: e.input }]);
          break;
        case "tool_result":
          patchBlocks((bs) =>
            bs.map((b) =>
              b.type === "tool" && b.toolUseId === e.toolUseId ? { ...b, result: e.text, isError: e.isError } : b,
            ),
          );
          break;
        case "approval_request":
          // 挂到对应的那次工具调用上（最近一个同名且还没结果的）
          patchBlocks((bs) => {
            const i = bs.findLastIndex((b) => b.type === "tool" && b.name.endsWith(e.name) && b.result == null);
            if (i < 0) {
              return [
                ...bs,
                { type: "tool", toolUseId: e.requestId, name: `mcp__docagent__${e.name}`, input: e.input, approval: { requestId: e.requestId, state: "pending" } },
              ];
            }
            const next = [...bs];
            next[i] = { ...(next[i] as Extract<Block, { type: "tool" }>), approval: { requestId: e.requestId, state: "pending" } };
            return next;
          });
          break;
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
            }));
          }
          break;
      }
    },
    [finish, patchBlocks],
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
      // 浏览器预览：?chat 直接打开示例会话，方便看对话界面
      if (api.isPreview && location.search.includes("chat")) {
        const list = await api.listSessions();
        if (list[0]) {
          setMessages(await api.getMessages(list[0].id));
          setCurrent(list[0]);
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
      setMessages((m) => [...m, user, { role: "assistant", content: "", blocks: [], pending: true }]);
      const id = crypto.randomUUID();
      const t0 = Date.now();
      askRef.current = { id, session, startedAt: t0 };
      setStartedAt(t0);
      setBusy(true);
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
      setError(String(err));
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

  function answerApproval(requestId: string, allow: boolean) {
    void api.agentSend({ type: "approval", requestId, allow });
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
        />
        <ChatPanel
          title={current?.title ?? null}
          messages={messages}
          busy={busy}
          startedAt={startedAt}
          ready={agent === "ready"}
          model={settings.model}
          docCount={docs.length}
          scopeCount={selected.size}
          onSend={(q) => void send(q)}
          onStop={stop}
          onCite={setCite}
          onApproval={answerApproval}
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
    </div>
  );
}
