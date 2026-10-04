import { describe, expect, it } from "vitest";
import { notesMarkdown } from "./export";
import { unitOf, whereLabel } from "@/lib/citations";
import type { Annotation, Book } from "@/lib/types";

const book: Book = {
  id: "b", title: "槐花开", author: "某人", folder: null, scan: "none", createdAt: 0, hasCover: false, customCover: false,
  coverRev: "", progress: null, readAt: null, spoilerFree: true, spoilerDefault: true, sessionCount: 0, noteCount: 0, docs: [],
};
const note = (patch: Partial<Annotation>): Annotation => ({
  id: "a", docId: "d", kind: "highlight", cfi: "epubcfi(/6/2)", text: "原文", note: "", color: "yellow",
  style: "highlight", label: "第一章", page: null, createdAt: 0, updatedAt: 0, ...patch,
});

describe("导出笔记", () => {
  it("按章节分组，原文是引用块，笔记跟在后面", () => {
    const md = notesMarkdown(
      book,
      [
        note({ text: "雨是从傍晚开始下的", note: "开头" }),
        note({ id: "b", text: "第二句" }),
        note({ id: "c", text: "等你到槐花开", label: "第三章" }),
      ],
      () => "",
    );
    expect(md).toBe(
      "# 《槐花开》读书笔记\n\n作者：某人\n\n## 第一章\n\n> 雨是从傍晚开始下的\n\n开头\n\n> 第二句\n\n## 第三章\n\n> 等你到槐花开\n",
    );
  });

  it("没有章节名的 PDF 用页码分组", () => {
    expect(notesMarkdown({ ...book, author: null }, [note({ label: "", page: 3 })], () => "")).toContain("## 第 3 页");
  });

  it("多篇的书：先按篇分，章节排在篇下面", () => {
    const md = notesMarkdown(
      { ...book, title: "项目文档", author: null },
      [note({ docId: "d1", label: "概述", text: "甲" }), note({ id: "b", docId: "d2", label: "", text: "乙" })],
      (docId) => (docId === "d1" ? "README" : "设计"),
    );
    expect(md).toBe("# 《项目文档》读书笔记\n\n## README\n\n### 概述\n\n> 甲\n\n## 设计\n\n> 乙\n");
  });
});

describe("引用位置的说法", () => {
  it("按格式：PDF 和漫画说页，电子书说节", () => {
    expect(unitOf("pdf")).toBe("页");
    expect(unitOf("cbz")).toBe("页");
    expect(unitOf("epub")).toBe("节");
    expect(whereLabel("pdf", "合同", 2)).toBe(" · 第 2 页");
    expect(whereLabel("epub", "槐花开", 2)).toBe(" · 第 2 节");
    expect(whereLabel("md", "笔记", null)).toBe("");
  });

  it("以前存下来的消息没有格式，退回去看标题", () => {
    expect(unitOf(undefined, "合同.pdf")).toBe("页");
    expect(unitOf(undefined, "槐花开")).toBe("节");
  });
});
