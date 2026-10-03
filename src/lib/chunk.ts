/** 分块：按段落聚合到目标长度，块间留重叠，保留页码。 */
import type { ParsedPage } from "./parse";

export interface Chunk {
  idx: number;
  page: number | null;
  text: string;
}

const TARGET = 800; // 目标字符数：中文约 500-800 字一块，检索粒度和上下文成本的折中
const OVERLAP = 120; // 相邻块重叠，避免答案正好被切断

export function chunkPages(pages: ParsedPage[], target = TARGET, overlap = OVERLAP): Chunk[] {
  const out: Chunk[] = [];
  for (const p of pages) {
    for (const piece of splitText(p.text, target, overlap)) {
      out.push({ idx: out.length, page: p.page, text: piece });
    }
  }
  return out;
}

export function splitText(text: string, target = TARGET, overlap = OVERLAP): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= target) return [clean];

  // 先按段落切，再把短段落拼到目标长度
  const paras = clean.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const pieces: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) pieces.push(buf.trim());
    buf = "";
  };
  for (const para of paras) {
    if (para.length > target) {
      flush();
      pieces.push(...hardSplit(para, target, overlap));
      continue;
    }
    if (buf.length + para.length + 1 > target) flush();
    buf += (buf ? "\n" : "") + para;
  }
  flush();
  return pieces;
}

/** 超长段落按句子边界硬切，带重叠 */
function hardSplit(text: string, target: number, overlap: number): string[] {
  const sentences = text.split(/(?<=[。！？!?；;\n])/);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf.length + s.length > target && buf) {
      out.push(buf.trim());
      buf = buf.slice(Math.max(0, buf.length - overlap));
    }
    buf += s;
    // 单句就超长（没有标点的长文本），直接按长度切
    while (buf.length > target * 1.5) {
      out.push(buf.slice(0, target).trim());
      buf = buf.slice(target - overlap);
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}
