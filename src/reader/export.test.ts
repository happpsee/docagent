import { describe, expect, it } from "vitest";
import { notesMarkdown } from "./export";
import { pageLabel } from "@/lib/citations";
import type { Annotation, Doc } from "@/lib/types";

const doc: Doc = {
  id: "d", title: "槐花开.epub", path: "/x.epub", kind: "epub", pages: null, chunkCount: 1, createdAt: 0,
  author: "某人", hasCover: false, progress: null, readAt: null,
};
const note = (patch: Partial<Annotation>): Annotation => ({
  id: "a", docId: "d", kind: "highlight", cfi: "epubcfi(/6/2)", text: "原文", note: "", color: "yellow",
  style: "highlight", label: "第一章", page: null, createdAt: 0, updatedAt: 0, ...patch,
});

describe("导出笔记", () => {
  it("按章节分组，原文是引用块，笔记跟在后面", () => {
    const md = notesMarkdown(doc, [
      note({ text: "雨是从傍晚开始下的", note: "开头" }),
      note({ id: "b", text: "第二句" }),
      note({ id: "c", text: "等你到槐花开", label: "第三章" }),
    ]);
    expect(md).toBe(
      "# 《槐花开》读书笔记\n\n作者：某人\n\n## 第一章\n\n> 雨是从傍晚开始下的\n\n开头\n\n> 第二句\n\n## 第三章\n\n> 等你到槐花开\n",
    );
  });

  it("没有章节名的 PDF 用页码分组", () => {
    expect(notesMarkdown({ ...doc, author: null }, [note({ label: "", page: 3 })])).toContain("## 第 3 页");
  });
});

describe("引用位置的说法", () => {
  it("PDF 说页，电子书说节，没有就不说", () => {
    expect(pageLabel("合同.pdf", 2)).toBe(" · 第 2 页");
    expect(pageLabel("槐花开", 2)).toBe(" · 第 2 节");
    expect(pageLabel("笔记.md", null)).toBe("");
  });
});
