import { useState } from "react";
import { Download, Pencil, Sparkles, Trash2, X } from "lucide-react";
import type * as api from "@/lib/api";
import type { Annotation, Doc } from "@/lib/types";
import { HL } from "./engine";

const empty = "px-4 py-8 text-center text-[12px] leading-relaxed text-text-4";

// ---------- 目录 ----------

export function TocPanel(p: {
  toc: api.TocItem[];
  current: string | null;
  onGo: (target: string | number) => void;
  /** PDF 没有大纲时退回页码列表 */
  fixed: boolean;
  total: number;
  page: number;
  /** 多篇的书：各篇是目录的第一层，正开着的那一篇下面挂它自己的目录 */
  parts: Doc[] | null;
  currentPart: string;
  onPart: (d: Doc) => void;
}) {
  if (p.parts) {
    return (
      <ul className="py-1.5">
        {p.parts.map((d) => {
          const active = d.id === p.currentPart;
          return (
            <li key={d.id}>
              <button
                onClick={() => !active && p.onPart(d)}
                disabled={d.missing}
                className={`flex w-full items-center gap-2 py-1.5 pl-3.5 pr-3 text-left text-[13px] disabled:opacity-45 ${
                  active ? "font-medium text-accent" : "text-text hover:bg-nav-card"
                }`}
                title={d.missing ? `${d.name}（原文件找不到了）` : d.name}
              >
                <span className="num w-5 shrink-0 text-[11px] text-text-4">{d.position + 1}</span>
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                {d.progress != null && d.progress > 0.005 && (
                  <span className="num shrink-0 text-[10px] text-text-4">{d.progress >= 0.995 ? "读完" : `${Math.round(d.progress * 100)}%`}</span>
                )}
              </button>
              {active && p.toc.length > 0 && (
                <ul className="mb-1 ml-[22px] border-l border-hairline">
                  {p.toc.map((item, i) => (
                    <TocRow key={i} item={item} depth={0} current={p.current} onGo={p.onGo} />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  if (!p.toc.length) {
    if (p.fixed && p.total > 0) {
      return (
        <div className="grid grid-cols-5 gap-1 p-3">
          {Array.from({ length: p.total }, (_, i) => (
            <button
              key={i}
              onClick={() => p.onGo(i)}
              className={`num rounded-md py-1.5 text-[12px] ${i === p.page ? "bg-accent-soft text-accent" : "text-text-3 hover:bg-nav-card hover:text-text"}`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      );
    }
    return <p className={empty}>这份文档没有目录</p>;
  }
  return (
    <ul className="py-1.5">
      {p.toc.map((item, i) => (
        <TocRow key={i} item={item} depth={0} current={p.current} onGo={p.onGo} />
      ))}
    </ul>
  );
}

function TocRow({ item, depth, current, onGo }: { item: api.TocItem; depth: number; current: string | null; onGo: (t: string) => void }) {
  const active = current != null && item.href === current;
  return (
    <li>
      <button
        onClick={() => onGo(item.href)}
        className={`block w-full truncate py-1.5 pr-3 text-left text-[13px] ${active ? "bg-accent-dim font-medium text-accent" : "text-text-2 hover:bg-nav-card hover:text-text"}`}
        style={{ paddingLeft: 14 + depth * 14 }}
        title={item.label}
      >
        {item.label?.trim() || "（无标题）"}
      </button>
      {item.subitems?.length ? (
        <ul>
          {item.subitems.map((sub, i) => (
            <TocRow key={i} item={sub} depth={depth + 1} current={current} onGo={onGo} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// ---------- 笔记 ----------

export function NotesPanel(p: {
  notes: Annotation[];
  /** 多篇的书：这条标记在哪一篇上（单篇的书返回空串） */
  partName: (docId: string) => string;
  onGo: (a: Annotation) => void;
  onSave: (a: Annotation) => void;
  onDelete: (a: Annotation) => void;
  onExport: () => void;
  onAsk: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  if (!p.notes.length) {
    return <p className={empty}>还没有笔记。<br />在正文里选中一段文字，就可以划线、写想法。</p>;
  }
  const action = "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-text-2 hover:bg-nav-card hover:text-text";
  let chapter: string | null = null;
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-hairline-soft bg-bg-grad-a px-2 py-1.5">
        <button className={action} onClick={p.onAsk} title="让助手读你划的重点和笔记，帮你归纳">
          <Sparkles className="h-3.5 w-3.5 text-accent" />
          让助手整理
        </button>
        <button className={action} onClick={p.onExport} title="导出成 Markdown 文件">
          <Download className="h-3.5 w-3.5" />
          导出
        </button>
      </div>
      <ul className="px-2 py-1">
        {p.notes.map((a) => {
          const label = [p.partName(a.docId), a.label || (a.page ? `第 ${a.page} 页` : "")].filter(Boolean).join(" · ");
          const head = label !== chapter ? label : null;
          chapter = label;
          return (
            <li key={a.id}>
              {head ? <div className="px-2 pb-1 pt-3 text-[11px] font-medium text-text-4">{head}</div> : null}
              <div className="group rounded-lg px-2 py-2 hover:bg-nav-card">
                <button className="flex w-full gap-2 text-left" onClick={() => p.onGo(a)}>
                  <span className="mt-0.5 w-[3px] shrink-0 self-stretch rounded-full" style={{ background: HL[a.color]?.fill }} />
                  <span className="line-clamp-4 text-[13px] leading-relaxed text-text">{a.text}</span>
                </button>
                {editing === a.id ? (
                  <div className="mt-2 pl-[11px]">
                    <textarea
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={3}
                      className="w-full resize-none rounded-md border border-hairline-strong bg-surface-2 px-2 py-1.5 text-[13px] text-text outline-none focus:border-accent"
                      placeholder="写下你的想法…"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          p.onSave({ ...a, note: draft.trim() });
                          setEditing(null);
                        }
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                    <div className="mt-1 flex justify-end gap-1">
                      <button className={action} onClick={() => setEditing(null)}>
                        取消
                      </button>
                      <button
                        className="rounded-md bg-accent px-2.5 py-1 text-[12px] text-white"
                        onClick={() => {
                          p.onSave({ ...a, note: draft.trim() });
                          setEditing(null);
                        }}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {a.note ? <p className="mt-1.5 whitespace-pre-wrap pl-[11px] text-[12.5px] leading-relaxed text-text-2">{a.note}</p> : null}
                    <div className="mt-1 flex gap-0.5 pl-[5px] opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        className={action}
                        onClick={() => {
                          setDraft(a.note);
                          setEditing(a.id);
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                        {a.note ? "改笔记" : "写笔记"}
                      </button>
                      <button className={action} onClick={() => p.onDelete(a)}>
                        <Trash2 className="h-3 w-3" />
                        删除
                      </button>
                    </div>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- 书签 ----------

export function BookmarksPanel(p: {
  bookmarks: Annotation[];
  partName: (docId: string) => string;
  onGo: (a: Annotation) => void;
  onDelete: (a: Annotation) => void;
}) {
  if (!p.bookmarks.length) return <p className={empty}>还没有书签。<br />点右上角的书签按钮，记住当前这一页。</p>;
  return (
    <ul className="px-2 py-1.5">
      {p.bookmarks.map((b) => (
        <li key={b.id} className="group flex items-start gap-1 rounded-lg px-2 py-2 hover:bg-nav-card">
          <button className="min-w-0 flex-1 text-left" onClick={() => p.onGo(b)}>
            <div className="truncate text-[12px] text-text-3">
              {[p.partName(b.docId), b.label || (b.page ? `第 ${b.page} 页` : "")].filter(Boolean).join(" · ") || "书签"}
            </div>
            {b.text ? <div className="mt-0.5 line-clamp-2 text-[13px] leading-relaxed text-text">{b.text}</div> : null}
          </button>
          <button
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-text-4 opacity-0 hover:text-danger group-hover:opacity-100"
            aria-label="删除书签"
            onClick={() => p.onDelete(b)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------- 书内搜索 ----------

export interface SearchGroup {
  label: string;
  items: { cfi: string; excerpt: { pre: string; match: string; post: string } }[];
}

export function SearchPanel(p: {
  query: string;
  onQuery: (q: string) => void;
  onSearch: (q: string) => void;
  onClear: () => void;
  searching: boolean;
  searched: null | { capped: boolean };
  results: SearchGroup[];
  onGo: (cfi: string) => void;
}) {
  const count = p.results.reduce((n, g) => n + g.items.length, 0);
  return (
    <div>
      <form
        className="sticky top-0 z-10 border-b border-hairline-soft bg-bg-grad-a p-2"
        onSubmit={(e) => {
          e.preventDefault();
          p.onSearch(p.query);
        }}
      >
        <div className="flex items-center gap-1 rounded-md border border-hairline-strong bg-surface-2 px-2">
          <input
            autoFocus
            value={p.query}
            onChange={(e) => p.onQuery(e.target.value)}
            placeholder="在这本书里找…  回车搜索"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-[13px] text-text outline-none placeholder:text-text-4"
          />
          {p.query && (
            <button type="button" aria-label="清除搜索" className="text-text-4 hover:text-text" onClick={p.onClear}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="mt-1.5 px-0.5 text-[11px] text-text-4">
          {p.searching
            ? "正在找…"
            : p.searched
              ? count
                ? p.searched.capped
                  ? `太多了，只列出前 ${count} 处，换个更具体的词试试`
                  : `找到 ${count} 处`
                : "没有找到"
              : p.query
                ? "回车开始搜索"
                : ""}
        </div>
      </form>
      <ul className="px-2 py-1">
        {p.results.map((g, gi) => (
          <li key={gi}>
            {g.label ? <div className="px-2 pb-1 pt-3 text-[11px] font-medium text-text-4">{g.label}</div> : null}
            {g.items.map((it, i) => (
              <button
                key={i}
                onClick={() => p.onGo(it.cfi)}
                className="block w-full rounded-lg px-2 py-1.5 text-left text-[12.5px] leading-relaxed text-text-2 hover:bg-nav-card"
              >
                {it.excerpt.pre.length > 24 ? `…${it.excerpt.pre.slice(-24)}` : it.excerpt.pre}
                <mark className="rounded-sm bg-accent-soft px-0.5 text-text">{it.excerpt.match}</mark>
                {it.excerpt.post.length > 48 ? `${it.excerpt.post.slice(0, 48)}…` : it.excerpt.post}
              </button>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
