/** 检索范围和防剧透界线：界面显示、发给助手的参数都从这里算，保证两边说的是一回事。 */
import type { Book, Scope } from "./types";

export interface ResolvedScope {
  /** 实际生效的范围（存下来的那个可能已经不成立了，比如指向的书被移除） */
  scope: Scope;
  /** 要限定的各篇；undefined 是不限定（整个书架） */
  docIds: string[] | undefined;
  /** 给人看、也告诉助手的说法 */
  label: string;
}

/** 把会话上存的范围落到具体的篇上。
 *  默认：对话属于某本书就在那本书里找，否则找整个书架。 */
export function resolveScope(scope: Scope | null, sessionBook: Book | null, books: Book[]): ResolvedScope {
  const all: ResolvedScope = { scope: { type: "all" }, docIds: undefined, label: books.length ? `整个书架 · ${books.length} 本` : "书架还是空的" };
  const book = (): ResolvedScope =>
    sessionBook ? { scope: { type: "book" }, docIds: sessionBook.docs.map((d) => d.id), label: `《${sessionBook.title}》` } : all;

  if (!scope) return book();
  switch (scope.type) {
    case "all":
      return all;
    case "book":
      return book();
    case "part": {
      const doc = sessionBook?.docs.find((d) => d.id === scope.docId);
      // 那一篇已经不在这本书里了（被移除、或者换了书）：退回整本书
      return doc && sessionBook ? { scope, docIds: [doc.id], label: `《${sessionBook.title}》· ${doc.name}` } : book();
    }
    case "books": {
      const picked = books.filter((b) => scope.bookIds.includes(b.id));
      if (!picked.length) return book();
      return {
        scope: { type: "books", bookIds: picked.map((b) => b.id) },
        docIds: picked.flatMap((b) => b.docs.map((d) => d.id)),
        label: picked.length === 1 ? `《${picked[0].title}》` : `选了 ${picked.length} 本`,
      };
    }
  }
}

/** 一篇能看到哪儿。fraction：0-1 的位置（Infinity 是整篇，-1 是一点都不能看）；
 *  page：有页码 / 章节序号的格式（PDF、EPUB）另外记着读到第几页，有它就按页比——
 *  按比例比的话，章节交界处会差出一截（一章的字数占比和它在文件里的位置占比不是一回事） */
export interface Boundary {
  fraction: number;
  page: number | null;
}
const OPEN: Boundary = { fraction: Infinity, page: null };
const BLOCKED: Boundary = { fraction: -1, page: null };

/** 防剧透时每一篇能看到哪儿。规则和 Rust 那边检索用的是同一条（spoiler.rs 的 book_bounds）：
 *  以「打开过的最靠后那一篇」为准，它前面的整篇算读过，它自己看到读过的最远处，它后面没打开过的不给看。
 *  live 是阅读器此刻的位置；一篇都没打开过的书不设界线。 */
export function readBoundaries(
  book: Book,
  live?: { docId: string; fraction: number; page?: number | null },
): Map<string, Boundary> {
  const out = new Map<string, Boundary>();
  const opened = (d: Book["docs"][number]) => d.opened || d.id === live?.docId;
  const last = book.spoilerFree ? Math.max(-1, ...book.docs.filter(opened).map((d) => d.position)) : -1;
  for (const d of book.docs) {
    if (last < 0 || d.position < last) out.set(d.id, OPEN);
    else if (d.position > last) out.set(d.id, BLOCKED);
    else {
      const here = d.id === live?.docId ? live : null;
      const now = here?.fraction ?? 0;
      const livePage = here?.page ?? null;
      // 存下来的记录里没有页码（老库升上来的）、而此刻又在比它靠前的地方：这一页代表不了读到的最远处
      const page =
        d.furthestPage != null && livePage != null
          ? Math.max(d.furthestPage, livePage)
          : (d.furthestPage ?? (livePage != null && (!d.opened || now >= d.furthest) ? livePage : null));
      out.set(d.id, { fraction: Math.max(d.furthest, now), page });
    }
  }
  return out;
}

/** 某个位置（一段的起点）在不在界线以内 */
export function canSee(b: Boundary | undefined, at: { start: number; page: number | null }): boolean {
  if (!b || b.fraction < 0) return false;
  if (b.fraction === Infinity) return true;
  return at.page != null && b.page != null ? at.page <= b.page : at.start <= b.fraction + 1e-6;
}

/** 从书架打开一本书时该翻到哪一篇：上次读的那篇；它读完了就下一篇；没读过从第一篇开始 */
export function resumePart(book: Book): Book["docs"][number] | undefined {
  const readable = book.docs.filter((d) => !d.missing);
  const list = readable.length ? readable : book.docs;
  const last = list.filter((d) => d.readAt != null).sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0))[0];
  if (!last) return list[0];
  if ((last.progress ?? 0) >= 0.995) return list.find((d) => d.position > last.position) ?? last;
  return last;
}
