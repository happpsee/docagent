import { useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, FolderPlus, MessageSquare, MoreHorizontal, Plus, Search } from "lucide-react";
import * as api from "@/lib/api";
import type { Book } from "@/lib/types";

export const IMPORT_EXTENSIONS = ["pdf", "epub", "mobi", "azw3", "azw", "fb2", "fbz", "cbz", "docx", "md", "markdown", "txt"];

type Sort = "recent" | "added" | "title";

interface Props {
  books: Book[];
  /** 导入、建索引的进度文案；null 表示没有在进行 */
  progress: string | null;
  /** 打开一本书；docId 指定从哪一篇开始 */
  onOpen: (book: Book, docId?: string) => void;
  /** 添加：文件或文件夹（选择框和「怎么归成书」的询问由上层负责） */
  onAdd: (what: "files" | "folder") => void;
  /** 书的详情面板：封面、书名、各篇、对话、移除 */
  onInfo: (book: Book) => void;
  onPickCover: (book: Book) => void;
  onReveal: (book: Book) => void;
  onRemove: (book: Book) => void;
}

/** 书架：应用的首页。一张卡片是一本书——一个文件，或者一个文件夹里的若干篇。 */
export function Library(p: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [adding, setAdding] = useState(false);
  /** 哪本书的菜单开着，以及开在哪 */
  const [menu, setMenu] = useState<{ book: Book; x: number; y: number } | null>(null);

  const reading = useMemo(
    () =>
      p.books
        .filter((b) => b.progress != null && b.progress > 0.005 && b.progress < 0.995)
        .sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0))
        .slice(0, 4),
    [p.books],
  );

  /** 搜书名、作者，也搜书里各篇的名字（文件并进一本书以后，还能按文件名找到） */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = p.books
      .map((book) => {
        if (!q) return { book, part: null };
        if (`${book.title} ${book.author ?? ""}`.toLowerCase().includes(q)) return { book, part: null };
        const part = book.docs.find((d) => d.name.toLowerCase().includes(q) || d.title.toLowerCase().includes(q));
        return part ? { book, part } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (sort === "title") list.sort((a, b) => a.book.title.localeCompare(b.book.title, "zh"));
    else if (sort === "recent") list.sort((a, b) => (b.book.readAt ?? b.book.createdAt) - (a.book.readAt ?? a.book.createdAt));
    else list.sort((a, b) => b.book.createdAt - a.book.createdAt);
    return list;
  }, [p.books, query, sort]);

  const openMenu = (book: Book, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ book, x: Math.min(r.left, window.innerWidth - 190), y: Math.min(r.bottom + 4, window.innerHeight - 200) });
  };
  const contextMenu = (book: Book) => (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ book, x: Math.min(e.clientX, window.innerWidth - 190), y: Math.min(e.clientY, window.innerHeight - 200) });
  };

  const addMenu = (align: string) =>
    adding && (
      <Popover onClose={() => setAdding(false)} className={`absolute top-full z-20 mt-1 w-[168px] ${align}`}>
        <MenuItem
          icon={<FilePlus2 className="h-3.5 w-3.5" />}
          onClick={() => {
            setAdding(false);
            p.onAdd("files");
          }}
        >
          添加文件…
        </MenuItem>
        <MenuItem
          icon={<FolderPlus className="h-3.5 w-3.5" />}
          onClick={() => {
            setAdding(false);
            p.onAdd("folder");
          }}
        >
          添加文件夹…
        </MenuItem>
      </Popover>
    );

  if (!p.books.length) {
    return (
      <section className="grid min-w-0 flex-1 place-items-center px-8">
        <div className="max-w-[420px] text-center">
          <div className="display-serif text-[26px] text-text">书架还是空的</div>
          <p className="mt-3 text-[14px] leading-relaxed text-text-3">
            把书、文档或者整个文件夹拖进窗口，或者点下面的按钮。一个文件夹可以当成一本书，里面的文件是它的各篇。
            支持 PDF、EPUB、MOBI、FB2、漫画包、Word、Markdown 和文本。
          </p>
          <div className="relative mt-5 inline-block">
            <button
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] text-white hover:bg-accent-2 disabled:opacity-60"
              disabled={!!p.progress}
              onClick={() => setAdding((v) => !v)}
            >
              <Plus className="h-4 w-4" />
              {p.progress ?? "添加书或文档"}
            </button>
            {addMenu("left-1/2 -translate-x-1/2 text-left")}
          </div>
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
          <span className="num text-[12px] text-text-4">{p.books.length}</span>
          <span className="flex-1" />
          <label className="flex w-[200px] items-center gap-1.5 rounded-lg border border-hairline bg-surface-2 px-2.5">
            <Search className="h-3.5 w-3.5 text-text-4" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="找书名、作者或篇名"
              className="min-w-0 flex-1 bg-transparent py-1.5 text-[13px] text-text outline-none placeholder:text-text-4"
            />
          </label>
          <div className="flex gap-0.5 rounded-lg bg-segment-bg p-0.5">
            {sortBtn("recent", "最近")}
            {sortBtn("added", "新添加")}
            {sortBtn("title", "书名")}
          </div>
          <div className="relative">
            <button
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] text-white hover:bg-accent-2 disabled:opacity-60"
              disabled={!!p.progress}
              aria-haspopup="menu"
              onClick={() => setAdding((v) => !v)}
            >
              <Plus className="h-4 w-4" />
              添加
            </button>
            {addMenu("right-0")}
          </div>
        </header>
        {p.progress && <div className="arc-shimmer-text mt-3 text-[12px]">{p.progress}</div>}

        {reading.length > 0 && !query && (
          <>
            <h2 className="mt-8 text-[12px] font-medium text-text-3">继续读</h2>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {reading.map((b) => (
                <button
                  key={b.id}
                  onClick={() => p.onOpen(b)}
                  onContextMenu={contextMenu(b)}
                  className="flex items-center gap-4 rounded-xl border border-hairline bg-surface-2 p-3 text-left transition-shadow hover:shadow-[0_6px_20px_-10px_rgb(0_0_0/0.25)]"
                >
                  <Cover book={b} className="h-[84px] w-[60px] text-[11px]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium text-text">{b.title}</div>
                    <div className="mt-0.5 truncate text-[12px] text-text-3">{subtitle(b)}</div>
                    <div className="mt-3 h-1 overflow-hidden rounded-full bg-segment-bg">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((b.progress ?? 0) * 100)}%` }} />
                    </div>
                    <div className="num mt-1 text-[11px] text-text-4">读到 {Math.round((b.progress ?? 0) * 100)}%</div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        <h2 className="mt-9 text-[12px] font-medium text-text-3">{query ? `找到 ${shown.length} 本` : "全部"}</h2>
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-5 gap-y-7">
          {shown.map(({ book: b, part }) => (
            <div key={b.id} className="group relative" onContextMenu={contextMenu(b)}>
              <button onClick={() => p.onOpen(b, part?.id)} className="block w-full text-left" title={b.title}>
                <Cover
                  book={b}
                  className="aspect-[5/7] w-full transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:shadow-[0_10px_24px_-10px_rgb(0_0_0/0.35)]"
                />
                <div className="mt-2 line-clamp-2 text-[13px] leading-snug text-text">{b.title}</div>
              </button>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-4">
                <span className="min-w-0 truncate">{part ? `含：${part.name}` : subtitle(b)}</span>
                <span className="flex-1" />
                {b.sessionCount > 0 && (
                  <button
                    className="inline-flex shrink-0 items-center gap-0.5 hover:text-text"
                    title={`${b.sessionCount} 个对话`}
                    aria-label={`${b.sessionCount} 个对话`}
                    onClick={() => p.onInfo(b)}
                  >
                    <MessageSquare className="h-3 w-3" />
                    <span className="num">{b.sessionCount}</span>
                  </button>
                )}
                {b.progress != null && b.progress > 0.005 && (
                  <span className="num shrink-0">{b.progress >= 0.995 ? "读完" : `${Math.round(b.progress * 100)}%`}</span>
                )}
                {/* 一直看得见（淡一点），不是悬停才出现：换封面、移除都从这里进 */}
                <button
                  className="-mr-1 grid h-5 w-5 shrink-0 place-items-center rounded text-text-4 hover:bg-nav-card hover:text-text"
                  aria-label={`《${b.title}》的更多操作`}
                  aria-haspopup="menu"
                  onClick={(e) => openMenu(b, e.currentTarget)}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {menu && (
        <Popover onClose={() => setMenu(null)} className="fixed z-40 w-[176px]" style={{ left: menu.x, top: menu.y }}>
          {(
            [
              ["打开", () => p.onOpen(menu.book)],
              ["详情…", () => p.onInfo(menu.book)],
              ["更换封面…", () => p.onPickCover(menu.book)],
              ["在访达中显示", () => p.onReveal(menu.book)],
            ] as [string, () => void][]
          ).map(([name, run]) => (
            <MenuItem
              key={name}
              onClick={() => {
                setMenu(null);
                run();
              }}
            >
              {name}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-hairline-soft" />
          <MenuItem
            danger
            onClick={() => {
              setMenu(null);
              p.onRemove(menu.book);
            }}
          >
            从书架移除…
          </MenuItem>
        </Popover>
      )}
    </section>
  );
}

/** 卡片上书名下面那一行：作者，或者「N 篇」，或者格式 */
function subtitle(b: Book): string {
  if (b.docs.length > 1) return `${b.docs.length} 篇`;
  return b.author ?? b.docs[0]?.kind.toUpperCase() ?? "";
}

/** 小浮层：点外面或按 Esc 关掉 */
export function Popover(p: { onClose: () => void; className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { onClose } = p;
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 打开它的那一下点击还在冒泡，下一轮再开始听
    const t = setTimeout(() => document.addEventListener("pointerdown", down), 0);
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      style={p.style}
      className={`rounded-xl border border-hairline-strong bg-surface-2 p-1 shadow-[0_10px_32px_-8px_rgb(0_0_0/0.3)] ${p.className ?? ""}`}
    >
      {p.children}
    </div>
  );
}

export function MenuItem(p: { onClick: () => void; icon?: React.ReactNode; danger?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      role="menuitem"
      disabled={p.disabled}
      onClick={p.onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-nav-card disabled:opacity-40 ${
        p.danger ? "text-danger" : "text-text-2 hover:text-text"
      }`}
    >
      {p.icon}
      {p.children}
    </button>
  );
}

/** 没有封面图的书用的底色：按书名固定挑一个，同一本书每次都一样 */
const PAPERS = ["#e9e4da", "#dfe5e1", "#e4e1ea", "#e8dfdc", "#dde3ea", "#e6e6dc"];

/** 封面：有图用图（用户上传的优先，否则是书里自带的），没有就排一张只有书名的封面。
 *  多篇的书在后面露出两层纸边，一眼看得出是一摞 */
export function Cover({ book, className = "" }: { book: Book; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!book.hasCover) return setUrl(null);
    let dead = false;
    let made: string | null = null;
    void api.bookCover(book.id).then(
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
    // coverRev：换了封面（同一本书、同样「有封面」）也要重新取
  }, [book.id, book.hasCover, book.coverRev]);

  let h = 0;
  for (const c of book.title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const paper = PAPERS[h % PAPERS.length];
  const face = "overflow-hidden rounded-[5px] shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_0.5px_rgb(0_0_0/0.12)]";
  const stacked = book.docs.length > 1;
  return (
    <div className={`relative shrink-0 ${className}`}>
      {stacked && (
        <>
          <div className={`absolute inset-0 translate-x-[7px] translate-y-[-7px] ${face}`} style={{ background: paper, filter: "brightness(0.93)" }} />
          <div className={`absolute inset-0 translate-x-[3.5px] translate-y-[-3.5px] ${face}`} style={{ background: paper, filter: "brightness(0.965)" }} />
        </>
      )}
      {url ? (
        <img src={url} alt="" className={`relative h-full w-full object-cover ${face}`} />
      ) : (
        <div className={`relative flex h-full w-full flex-col justify-between p-[10%] ${face}`} style={{ background: paper }}>
          <div className="display-serif line-clamp-4 shrink-0 text-[0.86em] leading-snug text-[#3a3833]">{book.title}</div>
          <div className="text-[9px] tracking-wider text-[#3a383380]">
            {stacked ? `${book.docs.length} 篇` : (book.docs[0]?.kind.toUpperCase() ?? "")}
          </div>
        </div>
      )}
    </div>
  );
}
