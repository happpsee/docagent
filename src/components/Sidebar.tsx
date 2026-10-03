import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, CircleCheck, FileText, PanelLeft, Plus, Settings as SettingsIcon, SquarePen, Trash2 } from "lucide-react";
import * as api from "@/lib/api";
import { chunkPages } from "@/lib/chunk";
import { kindFromName, parseFile } from "@/lib/parse";
import type { Doc, Session } from "@/lib/types";

interface Props {
  sessions: Session[];
  currentId: string | null;
  docs: Doc[];
  selected: Set<string>;
  status: { text: string; tone: "ok" | "warn" | "bad" | "idle" };
  /** 收成一条窄边（阅读文档时把空间让给正文） */
  collapsed: boolean;
  readingId: string | null;
  onToggleCollapsed: () => void;
  onOpenDoc: (d: Doc) => void;
  onNewChat: () => void;
  onOpenSession: (s: Session) => void;
  onDeleteSession: (s: Session) => void;
  onToggleDoc: (id: string) => void;
  onDocsChanged: () => void;
  onOpenSettings: () => void;
  onError: (m: string) => void;
}

function ago(ts: number): string {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

export function Sidebar(p: Props) {
  const [progress, setProgress] = useState<string | null>(null);
  const [docsOpen, setDocsOpen] = useState(true);

  async function importFiles() {
    const picked = await open({
      multiple: true,
      filters: [{ name: "文档", extensions: ["pdf", "docx", "md", "markdown", "txt"] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    setDocsOpen(true);
    for (const [i, path] of paths.entries()) {
      const name = path.split("/").pop() ?? path;
      const tag = paths.length > 1 ? `(${i + 1}/${paths.length}) ` : "";
      try {
        setProgress(`${tag}读取 ${name}`);
        const bytes = new Uint8Array(await api.readFileBytes(path));
        setProgress(`${tag}解析 ${name}`);
        const parsed = await parseFile(name, bytes);
        const chunks = chunkPages(parsed.pages);
        if (!chunks.length) throw new Error("解析后没有内容");
        setProgress(`${tag}建索引 · ${chunks.length} 个片段`);
        await api.addDocument(name, path, kindFromName(name), parsed.pageCount, chunks);
        p.onDocsChanged();
      } catch (err) {
        p.onError(`${name}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setProgress(null);
  }

  const tone = { ok: "bg-good", warn: "bg-warm", bad: "bg-danger", idle: "bg-track-idle" }[p.status.tone];

  if (p.collapsed) {
    const btn = "grid h-8 w-8 place-items-center rounded-lg text-text-3 hover:bg-nav-card hover:text-text";
    return (
      <aside className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-hairline bg-bg-grad-b/60 py-3">
        <button className={btn} aria-label="展开侧栏" onClick={p.onToggleCollapsed}>
          <PanelLeft className="h-4 w-4" />
        </button>
        <button className={btn} aria-label="新对话" onClick={p.onNewChat}>
          <SquarePen className="h-4 w-4" />
        </button>
        <span className="flex-1" />
        <button className={`${btn} relative`} aria-label="设置" onClick={p.onOpenSettings}>
          <SettingsIcon className="h-4 w-4" />
          <span className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${tone}`} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-hairline bg-bg-grad-b/60">
      <div className="px-3 pb-1 pt-3.5">
        <div className="flex items-center px-2">
          <span className="flex-1 text-[14px] font-semibold tracking-tight text-text">DocAgent</span>
          <button
            className="grid h-6 w-6 place-items-center rounded-md text-text-4 hover:bg-nav-card hover:text-text"
            aria-label="收起侧栏"
            onClick={p.onToggleCollapsed}
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          className="mt-3 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-text hover:bg-nav-card"
          onClick={p.onNewChat}
        >
          <SquarePen className="h-4 w-4 text-text-3" />
          新对话
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        <button
          className="mt-3 flex w-full items-center gap-1 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-text-4"
          onClick={() => setDocsOpen((v) => !v)}
        >
          <ChevronDown className={`h-3 w-3 transition-transform ${docsOpen ? "" : "-rotate-90"}`} />
          文档 {p.docs.length ? `· ${p.docs.length}` : ""}
          <span className="flex-1" />
          <span
            role="button"
            tabIndex={0}
            aria-label="导入文档"
            className="grid h-5 w-5 place-items-center rounded hover:bg-nav-card-hover"
            onClick={(e) => {
              e.stopPropagation();
              if (!progress) void importFiles();
            }}
          >
            <Plus className="h-3.5 w-3.5" />
          </span>
        </button>

        {progress && <div className="arc-shimmer-text px-2 py-1 text-[12px]">{progress}</div>}

        {docsOpen &&
          (p.docs.length ? (
            p.docs.map((d) => {
              const on = p.selected.has(d.id);
              return (
                <div
                  key={d.id}
                  className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] ${
                    d.id === p.readingId ? "bg-nav-card-active text-text" : "text-text-2 hover:bg-nav-card"
                  }`}
                  title={`${d.title}\n${d.kind.toUpperCase()}${d.pages ? ` · ${d.pages} 页` : ""} · ${d.chunkCount} 个片段`}
                >
                  <FileText className={`h-3.5 w-3.5 shrink-0 ${on ? "text-accent" : "text-text-4"}`} />
                  <button className="min-w-0 flex-1 truncate text-left" onClick={() => p.onOpenDoc(d)}>
                    {d.title}
                  </button>
                  <button
                    className="hidden group-hover:block"
                    aria-label="删除文档"
                    onClick={() => void api.deleteDocument(d.id).then(p.onDocsChanged, (err) => p.onError(String(err)))}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-text-4 hover:text-danger" />
                  </button>
                  <button
                    className={on ? "" : "opacity-0 group-hover:opacity-100"}
                    aria-label={on ? "取消限定" : "只检索这份"}
                    aria-pressed={on}
                    title={on ? "已限定在这份文档里检索，点击取消" : "只在这份文档里检索"}
                    onClick={() => p.onToggleDoc(d.id)}
                  >
                    <CircleCheck className={`h-3.5 w-3.5 ${on ? "text-accent" : "text-text-4 hover:text-text"}`} />
                  </button>
                </div>
              );
            })
          ) : (
            <button
              className="w-full rounded-lg border border-dashed border-hairline-strong px-2 py-3 text-[12px] text-text-3 hover:border-accent hover:text-accent"
              onClick={() => void importFiles()}
            >
              导入 PDF / Word / Markdown
            </button>
          ))}
        {docsOpen && p.docs.length > 0 && (
          <p className="px-2 pt-1 text-[11px] text-text-4">
            {p.selected.size ? `只检索打勾的 ${p.selected.size} 份` : "点文档打开阅读"}
          </p>
        )}

        <div className="mt-4 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-text-4">会话</div>
        {p.sessions.length ? (
          p.sessions.map((s) => (
            <div
              key={s.id}
              className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] ${
                s.id === p.currentId ? "bg-nav-card-active text-text" : "text-text-2 hover:bg-nav-card"
              }`}
            >
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => p.onOpenSession(s)}>
                {s.title}
              </button>
              <span className="num shrink-0 text-[10px] text-text-4 group-hover:hidden">{ago(s.updatedAt)}</span>
              <button
                className="hidden group-hover:block"
                aria-label="删除会话"
                onClick={() => p.onDeleteSession(s)}
              >
                <Trash2 className="h-3.5 w-3.5 text-text-4 hover:text-danger" />
              </button>
            </div>
          ))
        ) : (
          <p className="px-2 py-1 text-[12px] text-text-4">对话会自动保存在这里</p>
        )}
      </div>

      <button
        className="flex items-center gap-2 border-t border-hairline px-5 py-3 text-left text-[12px] text-text-2 hover:bg-nav-card"
        onClick={p.onOpenSettings}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
        <span className="min-w-0 flex-1 truncate">{p.status.text}</span>
        <SettingsIcon className="h-3.5 w-3.5 text-text-4" />
      </button>
    </aside>
  );
}
