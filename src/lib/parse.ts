/** 文档解析：PDF 用 pdf.js（能拿到页码），DOCX 用 mammoth，其余按纯文本。 */
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { DocKind } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface ParsedPage {
  page: number | null;
  text: string;
}

export interface Parsed {
  kind: DocKind;
  pages: ParsedPage[];
  pageCount: number | null;
}

export function kindFromName(name: string): DocKind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "docx";
  if (ext === "md" || ext === "markdown") return "md";
  return "txt";
}

export async function parseFile(name: string, bytes: Uint8Array): Promise<Parsed> {
  const kind = kindFromName(name);
  if (kind === "pdf") return parsePdf(bytes);
  if (kind === "docx") return parseDocx(bytes);
  const text = new TextDecoder("utf-8").decode(bytes).normalize("NFKC");
  return { kind, pages: [{ page: null, text }], pageCount: null };
}

async function parsePdf(bytes: Uint8Array): Promise<Parsed> {
  // pdf.js 会接管传入的 buffer，复制一份避免后续复用时报错
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const pages: ParsedPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // NFKC：有些 PDF 会把「日」「支」「金」存成康熙部首字符（U+2F00 段），
    // 看着一样、编码不同，不规范化的话检索和引文高亮都对不上。
    const text = content.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
    if (text) pages.push({ page: i, text });
  }
  const pageCount = doc.numPages;
  await doc.destroy();
  if (!pages.length) {
    throw new Error("这个 PDF 里没有可提取的文字，可能是扫描件（需要 OCR，当前版本不支持）");
  }
  return { kind: "pdf", pages, pageCount };
}

async function parseDocx(bytes: Uint8Array): Promise<Parsed> {
  const mammoth = await import("mammoth");
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const res = await mammoth.extractRawText({ arrayBuffer: buf as ArrayBuffer });
  const text = res.value.normalize("NFKC").trim();
  if (!text) throw new Error("DOCX 解析后是空的");
  return { kind: "docx", pages: [{ page: null, text }], pageCount: null };
}
