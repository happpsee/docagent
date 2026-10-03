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

/** 回答里实际引用到的编号（去重、升序） */
export function citedNumbers(text: string): number[] {
  const set = new Set<number>();
  for (const p of splitCitations(text)) if (p.type === "cite") set.add(p.n);
  return [...set].sort((a, b) => a - b);
}

/** 在全文里找引文的位置，忽略空白差异（分块时段落间的换行会被合并）。返回 [起点, 长度] */
export function locate(text: string, quote?: string): [number, number] {
  const q = quote ? quote.replace(/\s+/g, "") : "";
  if (!q) return [-1, 0];
  // 去掉空白后的每个字符对应原文的下标
  const map: number[] = [];
  let flat = "";
  for (let i = 0; i < text.length; i++) {
    if (!/\s/.test(text[i])) {
      map.push(i);
      flat += text[i];
    }
  }
  const at = flat.indexOf(q);
  if (at < 0) return [-1, 0];
  const start = map[at];
  const end = map[at + q.length - 1] + 1;
  return [start, end - start];
}
