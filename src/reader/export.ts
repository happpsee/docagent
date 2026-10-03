import type { Annotation, Doc } from "@/lib/types";

/** 把一本书的高亮和笔记整理成 Markdown：按章节分组，原文用引用块，笔记跟在下面 */
export function notesMarkdown(doc: Doc, notes: Annotation[]): string {
  const lines: string[] = [`# 《${doc.title.replace(/\.[^.]+$/, "")}》读书笔记`, ""];
  if (doc.author) lines.push(`作者：${doc.author}`, "");
  let chapter: string | null = null;
  for (const a of notes) {
    const label = a.label || (a.page ? `第 ${a.page} 页` : "");
    if (label !== chapter) {
      chapter = label;
      if (label) lines.push(`## ${label}`, "");
    }
    lines.push(...a.text.split("\n").map((l) => `> ${l}`), "");
    if (a.note.trim()) lines.push(a.note.trim(), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}
