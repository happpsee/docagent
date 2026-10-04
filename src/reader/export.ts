import type { Annotation, Book } from "@/lib/types";

/** 把一本书的高亮和笔记整理成 Markdown：按篇、按章节分组，原文用引用块，笔记跟在下面。
 *  notes 已经按书里的先后排好；partName 给出每条在哪一篇（单篇的书返回空串） */
export function notesMarkdown(book: Book, notes: Annotation[], partName: (docId: string) => string): string {
  const lines: string[] = [`# 《${book.title}》读书笔记`, ""];
  if (book.author) lines.push(`作者：${book.author}`, "");
  let part: string | null = null;
  let chapter: string | null = null;
  for (const a of notes) {
    const name = partName(a.docId);
    if (name !== part) {
      part = name;
      chapter = null;
      if (name) lines.push(`## ${name}`, "");
    }
    const label = a.label || (a.page ? `第 ${a.page} 页` : "");
    if (label !== chapter) {
      chapter = label;
      // 多篇的书里，章节降一级，排在篇的下面
      if (label) lines.push(`${name ? "###" : "##"} ${label}`, "");
    }
    lines.push(...a.text.split("\n").map((l) => `> ${l}`), "");
    if (a.note.trim()) lines.push(a.note.trim(), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}
