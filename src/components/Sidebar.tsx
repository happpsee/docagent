import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileText, MessageSquare, Plus, Trash2, Upload } from "lucide-react";
import * as api from "@/lib/api";
import { chunkPages } from "@/lib/chunk";
import { kindFromName, parseFile } from "@/lib/parse";
import type { Doc, Session } from "@/lib/types";
import { PrimaryButton } from "./ui/PrimaryButton";

interface Props {
  sessions: Session[];
  currentId: string | null;
  docs: Doc[];
  selected: Set<string>;
  onNewChat: () => void;
  onOpenSession: (s: Session) => void;
  onDeleteSession: (s: Session) => void;
  onToggleDoc: (id: string) => void;
  onDocsChanged: () => void;
  onError: (m: string) => void;
}

export function Sidebar(p: Props) {
  const [tab, setTab] = useState<"chats" | "docs">("chats");
  const [progress, setProgress] = useState<string | null>(null);

  async function importFiles() {
    const picked = await open({
      multiple: true,
      filters: [{ name: "文档", extensions: ["pdf", "docx", "md", "markdown", "txt"] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    setTab("docs");
    for (const [i, path] of paths.entries()) {
      const name = path.split("/").pop() ?? path;
      const tag = `(${i + 1}/${paths.length})`;
      try {
        setProgress(`${tag} 读取 ${name}`);
        const bytes = new Uint8Array(await api.readFileBytes(path));
        setProgress(`${tag} 解析 ${name}`);
        const parsed = await parseFile(name, bytes);
        const chunks = chunkPages(parsed.pages);
        if (!chunks.length) throw new Error("解析后没有内容");
        setProgress(`${tag} 建索引（${chunks.length} 个片段）`);
        await api.addDocument(name, path, kindFromName(name), parsed.pageCount, chunks);
        p.onDocsChanged();
      } catch (err) {
        p.onError(`${name}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setProgress(null);
  }

  const tabCls = (on: boolean) =>
    `flex-1 rounded-md px-2 py-1.5 text-[12px] transition-colors ${
      on ? "bg-nav-card-active text-text" : "text-text-3 hover:text-text"
    }`;

  return (
    <aside className="flex w-[272px] shrink-0 flex-col border-r border-hairline bg-surface-2/60">
      <div className="flex gap-2 p-3">
        <PrimaryButton className="flex-1" size="sm" leadingIcon={<Plus className="h-3.5 w-3.5" />} onClick={p.onNewChat}>
          新对话
        </PrimaryButton>
        <button
          className="arc-btn-secondary focus-ring inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px]"
          onClick={() => void importFiles()}
          disabled={!!progress}
        >
          <Upload className="h-3.5 w-3.5" />
          导入
        </button>
      </div>

      <div className="mx-3 flex gap-1 rounded-lg bg-segment-bg p-1">
        <button className={tabCls(tab === "chats")} onClick={() => setTab("chats")}>
          会话 {p.sessions.length || ""}
        </button>
        <button className={tabCls(tab === "docs")} onClick={() => setTab("docs")}>
          文档 {p.docs.length || ""}
        </button>
      </div>

      {progress && <div className="arc-shimmer-text px-4 pt-3 text-[12px]">{progress}</div>}

      <div className="mt-2 flex-1 overflow-y-auto px-2 pb-3">
        {tab === "chats" ? (
          p.sessions.length ? (
            p.sessions.map((s) => (
              <div
                key={s.id}
                className={`group flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] ${
                  s.id === p.currentId ? "bg-nav-card-active text-text" : "text-text-2 hover:bg-nav-card"
                }`}
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-text-4" />
                <button className="min-w-0 flex-1 truncate text-left" onClick={() => p.onOpenSession(s)}>
                  {s.title}
                </button>
                <button
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="删除会话"
                  onClick={() => p.onDeleteSession(s)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-text-4 hover:text-danger" />
                </button>
              </div>
            ))
          ) : (
            <Empty text="还没有会话。提一个问题就会自动保存。" />
          )
        ) : p.docs.length ? (
          <>
            {p.docs.map((d) => (
              <label
                key={d.id}
                className={`group flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 ${
                  p.selected.has(d.id) ? "bg-accent-dim" : "hover:bg-nav-card"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1 accent-[var(--color-accent)]"
                  checked={p.selected.has(d.id)}
                  onChange={() => p.onToggleDoc(d.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[13px] text-text">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-text-4" />
                    <span className="truncate" title={d.path ?? d.title}>
                      {d.title}
                    </span>
                  </div>
                  <div className="num mt-0.5 text-[11px] text-text-4">
                    {d.kind.toUpperCase()}
                    {d.pages ? ` · ${d.pages} 页` : ""} · {d.chunkCount} 片段
                  </div>
                </div>
                <button
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="删除文档"
                  onClick={(e) => {
                    e.preventDefault();
                    void api.deleteDocument(d.id).then(p.onDocsChanged, (err) => p.onError(String(err)));
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5 text-text-4 hover:text-danger" />
                </button>
              </label>
            ))}
            <p className="px-2.5 pt-2 text-[11px] text-text-4">
              {p.selected.size ? `只在勾选的 ${p.selected.size} 份里检索` : "不勾选则检索全部文档"}
            </p>
          </>
        ) : (
          <Empty text="还没有文档。点「导入」添加 PDF / DOCX / Markdown / TXT。" />
        )}
      </div>
    </aside>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-3 py-6 text-center text-[12px] leading-5 text-text-4">{text}</p>;
}
