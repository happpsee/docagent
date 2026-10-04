import { useState } from "react";
import { Check, ChevronDown, FileText } from "lucide-react";
import { resolveScope } from "@/lib/scope";
import type { Book, Doc, Scope } from "@/lib/types";
import { Popover } from "./Library";

interface Props {
  books: Book[];
  /** 这段对话属于哪本书（没有就是和书无关的对话） */
  book: Book | null;
  /** 阅读器里正开着的那一篇 */
  openDoc: Doc | null;
  scope: Scope | null;
  onScope: (s: Scope | null) => void;
  /** 改这本书的防剧透开关 */
  onSpoiler: (book: Book, on: boolean) => void;
}

/** 输入框下面的「助手在哪儿找」：整个书架、这本书、这一篇，或者手选几本。
 *  读书时还带着防剧透的开关——它管的也是「助手能看到什么」，放在一起。 */
export function ScopePicker({ books, book, openDoc, scope, onScope, onSpoiler }: Props) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const now = resolveScope(scope, book, books);
  const part = book && book.docs.length > 1 && openDoc && openDoc.bookId === book.id ? openDoc : null;
  const picked = now.scope.type === "books" ? now.scope.bookIds : [];

  const option = (active: boolean, label: string, onClick: () => void, hint?: string) => (
    <button
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-text-2 hover:bg-nav-card hover:text-text"
    >
      <Check className={`h-3.5 w-3.5 shrink-0 ${active ? "text-accent" : "opacity-0"}`} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-text-4">{hint}</span>}
    </button>
  );
  const choose = (s: Scope | null) => {
    onScope(s);
    setOpen(false);
  };
  const toggleBook = (id: string) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    onScope(next.length ? { type: "books", bookIds: next } : null);
  };

  return (
    <span className="relative min-w-0">
      <button
        className="inline-flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-text-3 hover:bg-nav-card hover:text-text"
        aria-haspopup="menu"
        aria-expanded={open}
        title="助手在哪些书里找答案"
        onClick={() => {
          setOpen((v) => !v);
          setPicking(now.scope.type === "books");
        }}
      >
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{now.label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="absolute bottom-full left-0 z-30 mb-1 w-[270px]">
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] text-text-4">助手在哪儿找</div>
          {option(now.scope.type === "all", "整个书架", () => choose({ type: "all" }), `${books.length} 本`)}
          {book && option(now.scope.type === "book", `这本书：《${book.title}》`, () => choose({ type: "book" }), book.docs.length > 1 ? `${book.docs.length} 篇` : undefined)}
          {part && option(now.scope.type === "part", `只在这一篇：${part.name}`, () => choose({ type: "part", docId: part.id }))}
          {books.length > 1 && option(now.scope.type === "books", "选几本…", () => setPicking((v) => !v), picked.length ? `${picked.length} 本` : undefined)}
          {picking && (
            <div className="mx-1 mb-1 rounded-lg border border-hairline">
              {books.length > 8 && (
                <input
                  autoFocus
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="找书名"
                  className="w-full border-b border-hairline bg-transparent px-2.5 py-1.5 text-[12px] text-text outline-none placeholder:text-text-4"
                />
              )}
              <div className="max-h-[180px] overflow-y-auto py-1">
                {books
                  .filter((b) => b.title.toLowerCase().includes(filter.trim().toLowerCase()))
                  .map((b) => (
                    <label key={b.id} className="flex cursor-pointer items-center gap-2 px-2.5 py-1 text-[12.5px] text-text-2 hover:bg-nav-card">
                      <input type="checkbox" className="accent-[var(--color-accent)]" checked={picked.includes(b.id)} onChange={() => toggleBook(b.id)} />
                      <span className="truncate">{b.title}</span>
                    </label>
                  ))}
              </div>
            </div>
          )}
          {book && (
            <>
              <div className="my-1 border-t border-hairline-soft" />
              <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-text-2 hover:bg-nav-card">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--color-accent)]"
                  checked={book.spoilerFree}
                  onChange={(e) => onSpoiler(book, e.target.checked)}
                />
                <span>
                  防剧透
                  <span className="block text-[11px] leading-relaxed text-text-4">这本书只用你读过的部分回答</span>
                </span>
              </label>
            </>
          )}
        </Popover>
      )}
    </span>
  );
}
