import { useCallback, useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { ChatPanel } from "./components/ChatPanel";
import { DocPanel } from "./components/DocPanel";
import { PrivacyPanel } from "./components/PrivacyPanel";
import { SettingsModal } from "./components/Settings";
import { Viewer } from "./components/Viewer";
import * as api from "./lib/api";
import { ask } from "./lib/rag";
import { DEFAULT_SETTINGS, type Doc, type Message, type SearchHit, type Settings } from "./lib/types";

const SETTINGS_KEY = "settings";

interface Approval {
  name: string;
  args: Record<string, unknown>;
  resolve: (ok: boolean) => void;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cite, setCite] = useState<SearchHit | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDocs(await api.listDocuments());
    } catch (err) {
      setError(String(err));
    }
  }, []);

  // 启动时读设置和文档列表
  useEffect(() => {
    void (async () => {
      try {
        const raw = await api.getSetting(SETTINGS_KEY);
        if (raw) setSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) });
      } catch {
        // 设置读不出来就用默认值
      }
      await refresh();
    })();
  }, [refresh]);

  async function saveSettings(s: Settings) {
    setSettings(s);
    try {
      await api.setSetting(SETTINGS_KEY, JSON.stringify(s));
    } catch (err) {
      setError(String(err));
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function send(question: string) {
    if (!docs.length) {
      setError("先导入文档再提问");
      return;
    }
    setError(null);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setMessages((m) => [
      ...m,
      { role: "user", content: question },
      { role: "assistant", content: "", pending: true },
    ]);

    const appendDelta = (text: string) =>
      setMessages((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + text };
        return next;
      });

    try {
      const res = await ask(
        question,
        settings,
        {
          onDelta: appendDelta,
          onStatus: setStatus,
          onApprove: (name, args) =>
            new Promise<boolean>((resolve) => setApproval({ name, args, resolve })),
          onSaveFile: async (filename, content) => {
            const path = await save({ defaultPath: filename });
            if (!path) throw new Error("用户取消了保存");
            await api.writeFileText(path, content);
            return path;
          },
        },
        selected.size ? [...selected] : undefined,
        ctrl.signal,
      );
      setMessages((m) => {
        const next = [...m];
        next[next.length - 1] = {
          role: "assistant",
          content: res.answer,
          sources: res.sources,
          toolCalls: res.toolCalls,
        };
        return next;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setMessages((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last?.role === "assistant" && !last.content) {
          next[next.length - 1] = { role: "assistant", content: `出错了：${msg}` };
        } else if (last?.role === "assistant") {
          next[next.length - 1] = { ...last, pending: false };
        }
        return next;
      });
    } finally {
      setStatus(null);
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    setBusy(false);
    setStatus(null);
  }

  const activeDocPath = cite ? (docs.find((d) => d.id === cite.docId)?.path ?? null) : null;
  const localOnly = settings.embedMode === "local" && settings.answerMode === "extract";

  return (
    <div className="app">
      <nav className="topbar">
        <strong>DocAgent</strong>
        <span className={`badge ${localOnly ? "ok" : "warn"}`}>
          {localOnly ? "全本地模式" : `联网：${new URL(settings.baseUrl).host}`}
        </span>
        <span className="spacer" />
        <button className="link" onClick={() => setShowPrivacy(true)}>
          出站记录
        </button>
        <button className="link" onClick={() => setShowSettings(true)}>
          设置
        </button>
      </nav>

      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error} <span className="hint">（点击关闭）</span>
        </div>
      )}

      <main className={cite ? "with-viewer" : ""}>
        <DocPanel
          docs={docs}
          settings={settings}
          selected={selected}
          onToggleSelect={toggleSelect}
          onChanged={refresh}
          onError={setError}
        />
        <ChatPanel
          messages={messages}
          status={status}
          busy={busy}
          onSend={send}
          onStop={stop}
          onCite={setCite}
        />
        <Viewer hit={cite} docPath={activeDocPath} onClose={() => setCite(null)} />
      </main>

      {showSettings && (
        <SettingsModal
          settings={settings}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
          onError={setError}
          onChanged={refresh}
        />
      )}
      {showPrivacy && <PrivacyPanel onClose={() => setShowPrivacy(false)} />}

      {approval && (
        <div className="modal-bg">
          <div className="modal small">
            <h2>需要你确认</h2>
            <p>
              助手想执行 <code>{approval.name}</code>，参数：
            </p>
            <pre className="info">{JSON.stringify(approval.args, null, 2).slice(0, 800)}</pre>
            <div className="actions">
              <span className="spacer" />
              <button
                onClick={() => {
                  approval.resolve(false);
                  setApproval(null);
                }}
              >
                拒绝
              </button>
              <button
                className="primary"
                onClick={() => {
                  approval.resolve(true);
                  setApproval(null);
                }}
              >
                同意
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
