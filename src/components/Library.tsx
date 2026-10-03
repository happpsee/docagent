import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus, Search } from "lucide-react";
import * as api from "@/lib/api";
import type { Doc } from "@/lib/types";

export const IMPORT_EXTENSIONS = ["pdf", "epub", "mobi", "azw3", "azw", "fb2", "fbz", "cbz", "docx", "md", "markdown", "txt"];

type Sort = "recent" | "added" | "title";

/** 书架：应用的首页。封面网格、最近在读、进度。 */
export function Library(p: {
  docs: Doc[];
  /** 导入进度文案；null 表示没有在导入 */
  progress: string | null;
  onOpen: (d: Doc) => void;
  onImport: (paths: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");

  async function pick() {
    const picked = await open({ multiple: true, filters: [{ name: "文档", extensions: IMPORT_EXTENSIONS }] });
    if (picked) p.onImport(Array.isArray(picked) ? picked : [picked]);
  }

  const reading = useMemo(
    () =>
      p.docs
        .filter((d) => d.progress != null && d.progress > 0.005 && d.progress < 0.995)
        .sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0))
        .slice(0, 4),
    [p.docs],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? p.docs.filter((d) => `${d.title} ${d.author ?? ""}`.toLowerCase().includes(q)) : [...p.docs];
    if (sort === "title") list.sort((a, b) => a.title.localeCompare(b.title, "zh"));
    else if (sort === "recent") list.sort((a, b) => (b.readAt ?? b.createdAt) - (a.readAt ?? a.createdAt));
    else list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }, [p.docs, query, sort]);

  if (!p.docs.length) {
    return (
      <section className="grid min-w-0 flex-1 place-items-center px-8">
        <div className="max-w-[420px] text-center">
          <div className="display-serif text-[26px] text-text">书架还是空的</div>
          <p className="mt-3 text-[14px] leading-relaxed text-text-3">
            把书或文档拖进窗口，或者点下面的按钮。支持 PDF、EPUB、MOBI、FB2、漫画包、Word、Markdown 和文本。
          </p>
          <button
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] text-white hover:bg-accent-2 disabled:opacity-60"
            disabled={!!p.progress}
            onClick={() => void pick()}
          >
            <Plus className="h-4 w-4" />
            {p.progress ?? "添加书或文档"}
          </button>
        </div>
      </section>
    );
  }

  const sortBtn = (id: Sort, name: string) => (
    <button
      onClick={() => setSort(id)}
      className={`rounded-md px-2 py-1 text-[12px] ${sort === id ? "bg-surface-2 text-text shadow-sm" : "text-text-3 hover:text-text"}`}
    >
      {name}
    </button>
  );

  return (
    <section className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1040px] px-10 pb-16 pt-9">
        <header className="flex items-center gap-3">
          <h1 className="display-serif text-[24px] text-text">书架</h1>
          <span className="num text-[12px] text-text-4">{p.docs.length}</span>
          <span className="flex-1" />
          <label className="flex w-[200px] items-center gap-1.5 rounded-lg border border-hairline bg-surface-2 px-2.5">
            <Search className="h-3.5 w-3.5 text-text-4" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="找书名或作者"
              className="min-w-0 flex-1 bg-transparent py-1.5 text-[13px] text-text outline-none placeholder:text-text-4"
            />
          </label>
          <div className="flex gap-0.5 rounded-lg bg-segment-bg p-0.5">
            {sortBtn("recent", "最近")}
            {sortBtn("added", "新添加")}
            {sortBtn("title", "书名")}
          </div>
          <button
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] text-white hover:bg-accent-2 disabled:opacity-60"
            disabled={!!p.progress}
            onClick={() => void pick()}
          >
            <Plus className="h-4 w-4" />
            添加
          </button>
        </header>
        {p.progress && <div className="arc-shimmer-text mt-3 text-[12px]">{p.progress}</div>}

        {reading.length > 0 && !query && (
          <>
            <h2 className="mt-8 text-[12px] font-medium text-text-3">继续读</h2>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {reading.map((d) => (
                <button
                  key={d.id}
                  onClick={() => p.onOpen(d)}
                  className="flex items-center gap-4 rounded-xl border border-hairline bg-surface-2 p-3 text-left transition-shadow hover:shadow-[0_6px_20px_-10px_rgb(0_0_0/0.25)]"
                >
                  <Cover doc={d} className="h-[84px] w-[60px] text-[11px]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium text-text">{d.title}</div>
                    {d.author && <div className="mt-0.5 truncate text-[12px] text-text-3">{d.author}</div>}
                    <div className="mt-3 h-1 overflow-hidden rounded-full bg-segment-bg">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((d.progress ?? 0) * 100)}%` }} />
                    </div>
                    <div className="num mt-1 text-[11px] text-text-4">读到 {Math.round((d.progress ?? 0) * 100)}%</div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        <h2 className="mt-9 text-[12px] font-medium text-text-3">{query ? `找到 ${shown.length} 本` : "全部"}</h2>
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-5 gap-y-7">
          {shown.map((d) => (
            <button key={d.id} onClick={() => p.onOpen(d)} className="group text-left" title={d.title}>
              <Cover
                doc={d}
                className="aspect-[5/7] w-full transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:shadow-[0_10px_24px_-10px_rgb(0_0_0/0.35)]"
              />
              <div className="mt-2 line-clamp-2 text-[13px] leading-snug text-text">{d.title}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-4">
                <span className="truncate">{d.author ?? d.kind.toUpperCase()}</span>
                {d.progress != null && d.progress > 0.005 && (
                  <span className="num ml-auto shrink-0">{d.progress >= 0.995 ? "读完" : `${Math.round(d.progress * 100)}%`}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/** 没有封面图的书用的底色：按书名固定挑一个，同一本书每次都一样 */
const PAPERS = ["#e9e4da", "#dfe5e1", "#e4e1ea", "#e8dfdc", "#dde3ea", "#e6e6dc"];

/** 封面：有图用图（缩略图在 Rust 那边存着），没有就排一张只有书名的封面 */
export function Cover({ doc, className = "" }: { doc: Doc; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!doc.hasCover) return setUrl(null);
    let dead = false;
    let made: string | null = null;
    void api.docCover(doc.id).then(
      (u) => {
        made = u;
        if (dead && u) URL.revokeObjectURL(u);
        else setUrl(u);
      },
      () => {},
    );
    return () => {
      dead = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [doc.id, doc.hasCover]);

  const frame = `shrink-0 overflow-hidden rounded-[5px] shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_0.5px_rgb(0_0_0/0.12)] ${className}`;
  if (url) return <img src={url} alt="" className={`${frame} object-cover`} />;
  let h = 0;
  for (const c of doc.title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <div className={`${frame} flex flex-col justify-between p-[10%]`} style={{ background: PAPERS[h % PAPERS.length] }}>
      <div className="display-serif line-clamp-4 shrink-0 text-[0.86em] leading-snug text-[#3a3833]">{doc.title.replace(/\.[^.]+$/, "")}</div>
      <div className="text-[9px] tracking-wider text-[#3a383380]">{doc.kind.toUpperCase()}</div>
    </div>
  );
}
