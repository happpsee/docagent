import { describe, expect, it } from "vitest";
import { canSee, readBoundaries, resolveScope, resumePart } from "../scope";
import type { Book, Doc } from "../types";

const doc = (id: string, position: number, patch: Partial<Doc> = {}): Doc => ({
  id, bookId: "b", position, title: `${id}.md`, name: id, displayTitle: `书 · ${id}`, path: `/x/${id}.md`, kind: "md",
  pages: null, chunkCount: 10, createdAt: 0, author: null, progress: null, furthest: 0, furthestPage: null,
  opened: false, readAt: null, missing: false, hasCover: false, ...patch,
});
const book = (docs: Doc[], patch: Partial<Book> = {}): Book => ({
  id: "b", title: "书", author: null, folder: "/x", scan: "none", createdAt: 0, hasCover: false, customCover: false,
  coverRev: "", progress: null, readAt: null, spoilerFree: true, spoilerDefault: true, sessionCount: 0, noteCount: 0, docs, ...patch,
});

describe("检索范围", () => {
  const b = book([doc("a", 0), doc("c", 1)]);
  const other = book([doc("z", 0)], { id: "o", title: "另一本" });

  it("默认：对话属于某本书就在那本书里找，否则整个书架", () => {
    expect(resolveScope(null, b, [b, other]).docIds).toEqual(["a", "c"]);
    expect(resolveScope(null, b, [b, other]).label).toBe("《书》");
    expect(resolveScope(null, null, [b, other]).docIds).toBeUndefined();
    expect(resolveScope(null, null, [b, other]).label).toBe("整个书架 · 2 本");
  });

  it("可以缩到一篇、放到整个书架、或者手选几本", () => {
    expect(resolveScope({ type: "part", docId: "c" }, b, [b]).docIds).toEqual(["c"]);
    expect(resolveScope({ type: "all" }, b, [b]).docIds).toBeUndefined();
    const picked = resolveScope({ type: "books", bookIds: ["o", "b"] }, null, [b, other]);
    expect(picked.docIds).toEqual(["a", "c", "z"]);
    expect(picked.label).toBe("选了 2 本");
  });

  it("存下来的范围不成立了就退回默认，不会变成搜不到东西", () => {
    expect(resolveScope({ type: "part", docId: "没了" }, b, [b]).docIds).toEqual(["a", "c"]);
    expect(resolveScope({ type: "books", bookIds: ["没了"] }, null, [b]).docIds).toBeUndefined();
    expect(resolveScope({ type: "book" }, null, [b]).docIds).toBeUndefined();
  });
});

describe("防剧透的界线", () => {
  const at = (b: Book, id: string, live?: Parameters<typeof readBoundaries>[1]) => readBoundaries(b, live).get(id)!;

  it("读到过的最远处为界；正在读的这一篇用当前位置", () => {
    const b = book([doc("a", 0, { opened: true, furthest: 0.4 })]);
    expect(at(b, "a").fraction).toBe(0.4);
    expect(at(b, "a", { docId: "a", fraction: 0.6 }).fraction).toBe(0.6);
    // 往回翻不会把读过的部分又藏起来
    expect(at(b, "a", { docId: "a", fraction: 0.1 }).fraction).toBe(0.4);
  });

  it("多篇：前面的算读过，后面没打开过的不给看", () => {
    const b = book([doc("a", 0), doc("c", 1, { opened: true, furthest: 0.3 }), doc("e", 2)]);
    expect(at(b, "a").fraction).toBe(Infinity);
    expect(at(b, "c").fraction).toBe(0.3);
    expect(at(b, "e").fraction).toBe(-1);
  });

  it("一篇都没打开过的书不设界线", () => {
    const b = book([doc("a", 0), doc("c", 1)]);
    expect([...readBoundaries(b).values()].map((x) => x.fraction)).toEqual([Infinity, Infinity]);
    // 一打开第一篇，后面的就挡住了
    expect(at(b, "c", { docId: "a", fraction: 0 }).fraction).toBe(-1);
  });

  it("关掉防剧透就全都能看", () => {
    const b = book([doc("a", 0), doc("c", 1)], { spoilerFree: false });
    expect([...readBoundaries(b).values()].map((x) => x.fraction)).toEqual([Infinity, Infinity]);
  });

  it("有页码的格式按页比：读到第 5 章，第 6 章的要点不显示，哪怕它的位置占比更靠前", () => {
    const b = book([doc("a", 0, { kind: "epub", opened: true, furthest: 0.5, furthestPage: 5 })]);
    const bound = at(b, "a", { docId: "a", fraction: 0.5, page: 5 });
    expect(bound.page).toBe(5);
    expect(canSee(bound, { start: 0.42, page: 6 })).toBe(false);
    expect(canSee(bound, { start: 0.55, page: 5 })).toBe(true);
    // 没有页码的段照旧按位置比
    expect(canSee(bound, { start: 0.55, page: null })).toBe(false);
  });

  it("老库升上来的进度没有页码：往回翻时不拿这一页当界线", () => {
    const b = book([doc("a", 0, { kind: "epub", opened: true, furthest: 0.6, furthestPage: null })]);
    expect(at(b, "a", { docId: "a", fraction: 0.3, page: 4 }).page).toBeNull();
    expect(at(b, "a", { docId: "a", fraction: 0.7, page: 9 }).page).toBe(9);
  });
});

describe("从书架打开时翻到哪一篇", () => {
  it("上次读的那篇；读完了就下一篇；没读过从头", () => {
    expect(resumePart(book([doc("a", 0), doc("c", 1)]))?.id).toBe("a");
    expect(resumePart(book([doc("a", 0, { readAt: 5, progress: 0.5 }), doc("c", 1, { readAt: 9, progress: 0.2 })]))?.id).toBe("c");
    expect(resumePart(book([doc("a", 0, { readAt: 9, progress: 1 }), doc("c", 1)]))?.id).toBe("c");
    // 最后一篇读完了：还是它
    expect(resumePart(book([doc("a", 0), doc("c", 1, { readAt: 9, progress: 1 })]))?.id).toBe("c");
  });
});
