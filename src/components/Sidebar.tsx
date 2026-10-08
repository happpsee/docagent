import { useMemo, useState } from "react";
import { BookOpen, LibraryBig, Link2Off, PanelLeft, Settings as SettingsIcon, SquarePen, Trash2 } from "lucide-react";
import type { Book, Session } from "@/lib/types";
import { ago } from "./BookInfoModal";

interface Props {
  sessions: Session[];
  books: Book[];
  currentId: string | null;
  status: { text: string; tone: "ok" | "warn" | "bad" | "idle" };
  /** 收成一条窄边（阅读时把空间让给正文） */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 导入、建语义索引的进度；null 表示没有在进行 */
  progress: string | null;
  /** 主区域现在是不是书架 */
  atLibrary: boolean;
  onOpenLibrary: () => void;
  /** 新对话：不属于任何书的普通对话 */
  onNewChat: () => void;
  onOpenSession: (s: Session) => void;
  onDeleteSession: (s: Session) => void;
  /** 把一段对话从它那本书下面拿出来 */
  onUnlinkSession: (s: Session) => void;
  onOpenBook: (book: Book) => void;
  onOpenSettings: () => void;
}

/** 每本书下面先显示几条对话，多的收起来 */
const PER_BOOK = 3;

/** 侧栏：书架入口、新对话，下面是对话——按书分组，一眼看得出哪段对话是聊哪本书的 */
export function Sidebar(p: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /** 有对话的书，按最近聊过的排；和书无关的对话单独一组 */
  const { groups, loose } = useMemo(() => {
    const byBook = new Map<string, Session[]>();
    const loose: Session[] = [];
    for (const s of p.sessions) {
      const book = s.bookId ? p.books.find((b) => b.id === s.bookId) : null;
      if (!book) loose.push(s);
      else byBook.set(book.id, [...(byBook.get(book.id) ?? []), s]);
    }
    const groups = [...byBook.entries()]
      .map(([id, list]) => ({ book: p.books.find((b) => b.id === id)!, list }))
      .sort((a, b) => b.list[0].updatedAt - a.list[0].updatedAt);
    return { groups, loose };
  }, [p.sessions, p.books]);

  const tone = { ok: "bg-good", warn: "bg-warm", bad: "bg-danger", idle: "bg-track-idle" }[p.status.tone];

  if (p.collapsed) {
    const btn = "grid h-8 w-8 place-items-center rounded-lg text-text-3 hover:bg-nav-card hover:text-text";
    return (
      <aside className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-hairline bg-bg-grad-b/60 py-3">
        <button className={btn} aria-label="展开侧栏" onClick={p.onToggleCollapsed}>
          <PanelLeft className="h-4 w-4" />
        </button>
        <button className={btn} aria-label="书架" title="书架" onClick={p.onOpenLibrary}>
          <LibraryBig className="h-4 w-4" />
        </button>
        <button className={btn} aria-label="新对话" title="新对话（不属于任何书）" onClick={p.onNewChat}>
          <SquarePen className="h-4 w-4" />
        </button>
        <span className="flex-1" />
        <button
          className={`${btn} relative`}
          aria-label="设置"
          title={p.progress ?? p.status.text}
          onClick={p.onOpenSettings}
        >
          <SettingsIcon className={`h-4 w-4 ${p.progress ? "animate-pulse text-accent" : ""}`} />
          <span className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${tone}`} />
        </button>
      </aside>
    );
  }

  const row = (s: Session) => (
    <div
      key={s.id}
      className={`group flex items-center gap-1.5 rounded-lg py-1.5 pl-2 pr-1.5 text-[13px] ${
        s.id === p.currentId ? "bg-nav-card-active text-text" : "text-text-2 hover:bg-nav-card"
      }`}
    >
      <button className="min-w-0 flex-1 truncate text-left" onClick={() => p.onOpenSession(s)} title={s.title}>
        {s.title}
      </button>
      <span className="num shrink-0 text-[10px] text-text-4 group-focus-within:hidden group-hover:hidden">{ago(s.updatedAt)}</span>
      {s.bookId && (
        <button
          className="hidden text-text-4 hover:text-text focus-visible:block group-hover:block"
          aria-label="取消和这本书的关联"
          title="从这本书下面拿出来，放到「其它对话」"
          onClick={() => p.onUnlinkSession(s)}
        >
          <Link2Off className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        className="hidden text-text-4 hover:text-danger focus-visible:block group-hover:block"
        aria-label="删除对话"
        onClick={() => {
          if (confirm(`删除对话「${s.title}」？`)) p.onDeleteSession(s);
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-hairline bg-bg-grad-b/60">
      <div className="px-3 pb-1 pt-3.5">
        <div className="flex items-center px-2">
          <span className="flex-1 text-[14px] font-semibold tracking-tight text-text">时习</span>
          <button
            className="grid h-6 w-6 place-items-center rounded-md text-text-4 hover:bg-nav-card hover:text-text"
            aria-label="收起侧栏"
            onClick={p.onToggleCollapsed}
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          className={`mt-3 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-text hover:bg-nav-card ${p.atLibrary ? "bg-nav-card-active" : ""}`}
          onClick={p.onOpenLibrary}
        >
          <LibraryBig className="h-4 w-4 text-text-3" />
          书架
          <span className="num ml-auto text-[11px] text-text-4">{p.books.length || ""}</span>
        </button>
        <button
          className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-text hover:bg-nav-card"
          onClick={p.onNewChat}
          title="不属于任何书的对话，默认在整个书架里找"
        >
          <SquarePen className="h-4 w-4 text-text-3" />
          新对话
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {groups.map(({ book, list }) => {
          const open = expanded.has(book.id) || list.some((s) => s.id === p.currentId && list.indexOf(s) >= PER_BOOK);
          const shown = open ? list : list.slice(0, PER_BOOK);
          return (
            <div key={book.id} className="mt-3">
              <button
                className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] font-medium text-text-3 hover:bg-nav-card hover:text-text"
                onClick={() => p.onOpenBook(book)}
                title={`打开《${book.title}》`}
              >
                <BookOpen className="h-3.5 w-3.5 shrink-0 text-text-4 group-hover:text-accent" />
                <span className="min-w-0 flex-1 truncate">{book.title}</span>
              </button>
              <div className="ml-[13px] border-l border-hairline pl-1.5">
                {shown.map(row)}
                {list.length > PER_BOOK && (
                  <button
                    className="px-2 py-1 text-[11px] text-text-4 hover:text-text"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(book.id)) next.delete(book.id);
                        else next.add(book.id);
                        return next;
                      })
                    }
                  >
                    {open ? "收起" : `还有 ${list.length - PER_BOOK} 个`}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {(loose.length > 0 || groups.length === 0) && (
          <div className="mt-3">
            <div className="px-2 py-1 text-[12px] font-medium text-text-3">{groups.length ? "其它对话" : "对话"}</div>
            {loose.length ? (
              loose.map((s) => (
                <div key={s.id}>
                  {row(s)}
                  {/* 原来那本书已经不在书架上了：留个痕迹，看得出这段对话是聊什么的 */}
                  {s.bookTitle && <div className="-mt-1 truncate pb-1 pl-2 text-[10.5px] text-text-4">原《{s.bookTitle}》，已不在书架上</div>}
                </div>
              ))
            ) : (
              <p className="px-2 py-1 text-[12px] leading-relaxed text-text-4">读书时在右边问的问题会归在那本书下面；点上面的「新对话」可以随便聊。</p>
            )}
          </div>
        )}
      </div>

      <button
        className="flex items-center gap-2 border-t border-hairline px-5 py-3 text-left text-[12px] text-text-2 hover:bg-nav-card"
        onClick={p.onOpenSettings}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{p.status.text}</span>
          {/* 导入和建索引的进度放在这儿：书架、对话、阅读三个界面都看得到 */}
          {p.progress && <span className="arc-shimmer-text block truncate text-[11px]">{p.progress}</span>}
        </span>
        <SettingsIcon className="h-3.5 w-3.5 shrink-0 text-text-4" />
      </button>
    </aside>
  );
}
