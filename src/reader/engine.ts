/** 阅读引擎的接线：打开各种格式、排版样式、位置换算。
 *  引擎本身是 foliate-js（src/vendor/foliate-js，MIT）；分页靠 WebView 的排版引擎。 */
import type { View } from "@/vendor/foliate-js/view.js";
import * as api from "@/lib/api";
import type { Doc, HighlightColor, ReaderPrefs } from "@/lib/types";

export type FoliateView = View;

let engine: Promise<unknown> | null = null;
/** 引擎按需加载：没打开过书就不占启动时间 */
export function loadEngine() {
  engine ??= import("@/vendor/foliate-js/view.js");
  return engine;
}

/** 这些格式由 Rust 排成 HTML 再当书打开；其余的把原文件直接交给引擎 */
const RENDERED = new Set(["md", "txt", "docx"]);
export const isFixedKind = (kind: string) => kind === "pdf" || kind === "cbz";

const BASE_CSS = `
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; word-break: break-word; overflow-wrap: anywhere; }
h1, h2, h3, h4 { line-height: 1.4; font-weight: 600; }
h1 { font-size: 1.6em; margin: 0 0 0.9em; }
h2 { font-size: 1.3em; margin: 1.6em 0 0.6em; }
h3 { font-size: 1.1em; margin: 1.3em 0 0.4em; }
p { margin: 0.75em 0; }
li { margin: 0.3em 0; }
table { border-collapse: collapse; margin: 1em 0; font-size: 0.92em; }
td, th { border: 1px solid #8884; padding: 6px 12px; vertical-align: top; text-align: left; }
th { background: #8881; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #8885; opacity: 0.85; }
pre { padding: 12px 14px; border-radius: 8px; background: #8882; overflow-x: auto; font-size: 0.88em; white-space: pre-wrap; }
code { font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 0.9em; }
hr { border: 0; border-top: 1px solid #8884; margin: 2em 0; }
img { max-width: 100%; }
`;

const wrap = (html: string) =>
  `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${html}</body></html>`;

/** 把 Rust 排好的 HTML 节包成引擎认识的「书」 */
function htmlBook(title: string, data: { sections: api.BookSection[]; toc: api.TocItem[] }) {
  const urls = new Map<number, string>();
  const index = new Map(data.sections.map((s, i) => [s.id, i]));
  const split = (href: string) => {
    const [id, frag] = href.split("#");
    return [id, frag ?? null] as const;
  };
  return {
    metadata: { title, language: "zh" },
    rendition: { layout: "reflowable" },
    dir: "ltr",
    toc: data.toc,
    sections: data.sections.map((s, i) => ({
      id: s.id,
      size: s.html.length,
      linear: "yes",
      load: () => {
        let url = urls.get(i);
        if (!url) {
          url = URL.createObjectURL(new Blob([wrap(s.html)], { type: "text/html" }));
          urls.set(i, url);
        }
        return url;
      },
      unload: () => {
        const url = urls.get(i);
        if (url) URL.revokeObjectURL(url);
        urls.delete(i);
      },
      createDocument: () => new DOMParser().parseFromString(wrap(s.html), "text/html"),
    })),
    resolveHref(href: string) {
      const [id, frag] = split(href);
      const i = index.get(id);
      if (i == null) return null;
      return { index: i, anchor: (doc: Document) => (frag ? doc.getElementById(frag) : null) ?? 0 };
    },
    splitTOCHref: split,
    getTOCFragment: (doc: Document, id: string) => doc.getElementById(id),
    destroy() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}

/** 准备好交给引擎打开的书 */
export async function openSource(doc: Doc, prefs: ReaderPrefs): Promise<unknown> {
  if (RENDERED.has(doc.kind)) return htmlBook(doc.title, await api.documentBook(doc.id));
  const [bytes, { makeBook }] = await Promise.all([api.readFileBytes(doc.id), import("@/vendor/foliate-js/view.js")]);
  // 引擎靠扩展名分辨 CBZ / FB2，其余看文件头
  const ext = doc.path?.split(".").pop()?.toLowerCase() ?? doc.kind;
  const book = await makeBook(new File([bytes], `book.${ext}`));
  // 单页还是双页要在打开前定下来：引擎在打开时就把页配成对了
  if (book.rendition?.layout === "pre-paginated") book.rendition.spread = prefs.spread;
  return book;
}

// ---------- 样式 ----------

export const THEMES: Record<ReaderPrefs["theme"], { name: string; bg: string; fg: string; link: string; dark: boolean }> = {
  warm: { name: "白", bg: "#fdfdfc", fg: "#262624", link: "#b5532f", dark: false },
  paper: { name: "纸黄", bg: "#f3e9d2", fg: "#3d3222", link: "#9a4a22", dark: false },
  green: { name: "护眼", bg: "#dcebd9", fg: "#22321f", link: "#2f6b3c", dark: false },
  night: { name: "夜间", bg: "#1f1e1c", fg: "#cfcabd", link: "#e08a66", dark: true },
};

export const HL: Record<HighlightColor, { name: string; fill: string }> = {
  yellow: { name: "黄", fill: "#f2c230" },
  green: { name: "绿", fill: "#5fc76a" },
  blue: { name: "蓝", fill: "#58a6f0" },
  pink: { name: "粉", fill: "#f0719b" },
  purple: { name: "紫", fill: "#a97be8" },
};
export const CITE_COLOR = "#c96442";

const FONTS = {
  serif: `"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif`,
  sans: `-apple-system, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif`,
};

/** 注入到每一节里的样式：字号、行距、字体、配色 */
export function contentCSS(p: ReaderPrefs): string {
  const t = THEMES[p.theme];
  const font = p.font === "book" ? "" : `font-family: ${FONTS[p.font]} !important;`;
  return `
@namespace epub "http://www.idpf.org/2007/ops";
html { color-scheme: ${t.dark ? "dark" : "light"}; color: ${t.fg} !important; background: none !important; font-size: ${p.fontSize}px !important; }
body { background: none !important; color: ${t.fg} !important; ${font} }
${p.font === "book" ? "" : `p, li, blockquote, dd, td, th, h1, h2, h3, h4, h5, h6, span, div { ${font} }`}
pre, code, kbd, samp { font-family: "SF Mono", ui-monospace, Menlo, monospace !important; }
p, li, blockquote, dd { line-height: ${p.lineHeight} !important; ${p.justify ? "text-align: justify;" : ""} }
a:any-link { color: ${t.link} !important; }
::selection { background: ${t.dark ? "#e08a6655" : "#c9644240"}; }
aside[epub|type~="endnote"], aside[epub|type~="footnote"], aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
${t.dark ? "img { filter: brightness(0.85); }" : ""}
`;
}

/** 把阅读偏好应用到引擎上 */
export function applyPrefs(view: FoliateView, p: ReaderPrefs) {
  const r = view.renderer as HTMLElement & { setStyles?: (css: string) => void };
  if (!r) return;
  if (view.isFixedLayout) {
    // PDF / 漫画：版面是固定的，只管缩放和单双页
    r.setAttribute("zoom", "fit-width");
    r.setAttribute("spread", p.spread);
    // 单页时上下连续滚动（一页通常比窗口高）；双页对开时一次翻一对
    r.setAttribute("flow", p.spread === "both" ? "paginated" : "scrolled");
    return;
  }
  r.setAttribute("flow", p.flow);
  r.setAttribute("gap", "6%");
  r.setAttribute("margin-top", "36px");
  r.setAttribute("margin-bottom", "36px");
  r.setAttribute("max-inline-size", `${p.width}px`);
  r.setAttribute("max-block-size", "1600px");
  r.setAttribute("max-column-count", String(p.columns));
  r.setStyles?.(contentCSS(p));
}

// ---------- 位置 ----------

/** 书页在 iframe 里（PDF 还带缩放），把里面的一段文字换算成相对 host 的坐标：最后一行的右下角 */
export function anchorOf(range: Range, host: HTMLElement): { x: number; y: number; top: number } | null {
  const frame = range.startContainer.ownerDocument?.defaultView?.frameElement as HTMLElement | null;
  if (!frame) return null;
  const rects = range.getClientRects();
  const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
  const first = rects[0] ?? last;
  const fr = frame.getBoundingClientRect();
  const sx = frame.offsetWidth ? fr.width / frame.offsetWidth : 1;
  const sy = frame.offsetHeight ? fr.height / frame.offsetHeight : 1;
  const hr = host.getBoundingClientRect();
  return {
    x: fr.left + ((last.left + last.right) / 2) * sx - hr.left,
    y: fr.top + last.bottom * sy - hr.top,
    top: fr.top + first.top * sy - hr.top,
  };
}

/** 比较时去掉空白和 Markdown 标记：引文来自原始文本（带 #、** 等），页面上是渲染后的文字 */
const strip = (s: string) => s.normalize("NFKC").replace(/[\s#*`>|_~\-\[\]()]/g, "");

/** 在一节的 DOM 里找到引文对应的文字范围 */
export function rangeOf(root: HTMLElement, quote: string): Range | null {
  const q = strip(quote);
  if (q.length < 2) return null;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const map: { node: Text; offset: number }[] = [];
  let flat = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n as Text).data;
    for (let i = 0; i < t.length; i++) {
      const c = strip(t[i]);
      // NFKC 可能把一个字符展开成多个，逐个都指回原位置
      for (const ch of c) {
        flat += ch;
        map.push({ node: n as Text, offset: i });
      }
    }
  }
  // 整段找不到时退而求其次：用引文开头的一截定位（分块重叠、表格等会造成细微差异）
  let at = flat.indexOf(q);
  let len = q.length;
  if (at < 0) {
    const head = q.slice(0, Math.min(40, q.length));
    at = flat.indexOf(head);
    len = head.length;
  }
  if (at < 0) return null;
  const a = map[at];
  const b = map[at + len - 1];
  const range = doc.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset + 1);
  return range;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Section {
  createDocument?: () => Promise<Document> | Document;
}

/** 找到引文在书里的位置（CFI）。page 是提示：PDF 的页码 / EPUB 的第几节。 */
export async function locateQuote(view: FoliateView, quote: string, page?: number | null): Promise<string | null> {
  const sections = view.book.sections as Section[];
  const live = (index: number) =>
    (view.renderer.getContents() as { index: number; doc: Document }[]).find((c) => c.index === index)?.doc;

  // 版面固定的（PDF）：文字层是翻到那页后才画出来的，只能到了再找
  if (view.isFixedLayout) {
    if (!page) return null;
    const index = Math.min(Math.max(page - 1, 0), sections.length - 1);
    await view.goTo(index);
    for (let i = 0; i < 20; i++) {
      const doc = live(index);
      const range = doc?.body ? rangeOf(doc.body, quote) : null;
      if (range) return view.getCFI(index, range);
      await sleep(150);
    }
    return null;
  }

  // 可重排的：先看提示的那一节，再从头找
  const hint = page ? page - 1 : -1;
  const order = [hint, ...sections.keys()].filter((i, pos, all) => i >= 0 && i < sections.length && all.indexOf(i) === pos);
  for (const index of order) {
    const doc = await sections[index].createDocument?.();
    if (!doc?.body) continue;
    const range = rangeOf(doc.body, quote);
    if (range) return view.getCFI(index, range);
  }
  return null;
}
