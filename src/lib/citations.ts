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
