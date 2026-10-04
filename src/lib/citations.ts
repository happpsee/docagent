export type Part = { type: "text"; value: string } | { type: "cite"; n: number };

/** 把回答里的 [n] 切出来，界面渲染成可点击的引用 */
export function splitCitations(text: string): Part[] {
  const out: Part[] = [];
  const re = /\[(\d{1,2})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    out.push({ type: "cite", n: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

/** 引用的位置说明：PDF 是页码；电子书的 page 存的是第几节 */
export function pageLabel(docTitle: string, page: number | null | undefined): string {
  if (!page) return "";
  return /\.pdf$/i.test(docTitle) ? ` · 第 ${page} 页` : ` · 第 ${page} 节`;
}

/** 回答里实际引用到的编号（去重、升序） */
export function citedNumbers(text: string): number[] {
  const set = new Set<number>();
  for (const p of splitCitations(text)) if (p.type === "cite") set.add(p.n);
  return [...set].sort((a, b) => a - b);
}

/** 一个位置该叫「页」还是「节」：PDF、漫画是页，EPUB 的是章节序号。
 *  kind 没有时（这次改动之前存下来的消息）退回去看标题是不是 .pdf 结尾 */
export function unitOf(kind: string | undefined, legacyTitle = ""): "页" | "节" {
  if (kind) return kind === "pdf" || kind === "cbz" ? "页" : "节";
  return /\.pdf$/i.test(legacyTitle) ? "页" : "节";
}

/** 引用后面跟的位置说明，如「 · 第 3 页」 */
export function whereLabel(kind: string | undefined, title: string, page: number | null | undefined): string {
  return page ? ` · 第 ${page} ${unitOf(kind, title)}` : "";
}
