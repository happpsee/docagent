import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { BookOpenText, MessageSquareQuote, Search } from "lucide-react";
import * as api from "@/lib/api";
import type { Doc } from "@/lib/types";
import { StreamMarkdown } from "./StreamMarkdown";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type SelectionAction = "ask" | "explain" | "related";
import { ModalCloseButton } from "./ui/ModalCloseButton";

export interface ReadTarget {
  docId: string;
  /** 要跳到的页（PDF） */
  page?: number | null;
  /** 要高亮的原文片段（来自引用） */
  quote?: string;
  /** 同一位置重复点击时也要重新滚动，用它触发 */
  nonce: number;
}

interface Props {
  doc: Doc;
  target: ReadTarget;
  onClose: () => void;
  /** 用户对选中的文字发起操作 */
  onSelection: (action: SelectionAction, text: string, page: number | null) => void;
}

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

/** 文档阅读器：PDF 逐页渲染（带可选中的文字层），其它格式显示全文。
 *  从引用跳过来时滚到那一页并高亮被引用的片段。 */
export function Reader({ doc, target, onClose, onSelection }: Props) {
  const root = useRef<HTMLElement>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState<number | null>(doc.pages);

  return (
    <section ref={root} className="relative flex min-w-0 flex-1 flex-col bg-bg">
      <SelectionMenu root={root} onAction={onSelection} />
      <header className="flex items-center gap-3 border-b border-hairline-soft px-6 py-2.5">
        <div className="min-w-0 flex-1 truncate text-[13px] text-text-2">{doc.title}</div>
        {pages ? (
          <span className="num text-[12px] text-text-3">
            {page} / {pages}
          </span>
        ) : null}
        <ModalCloseButton ariaLabel="关闭文档" onClick={onClose} />
      </header>
      {!doc.path ? (
        <p className="p-8 text-center text-[13px] text-text-3">找不到这份文档的原始文件。</p>
      ) : doc.kind === "pdf" ? (
        <PdfView key={doc.id} path={doc.path} target={target} onPage={setPage} onPages={setPages} />
      ) : (
        <TextView key={doc.id} doc={doc} target={target} />
      )}
    </section>
  );
}

function PdfView({
  path,
  target,
  onPage,
  onPages,
}: {
  path: string;
  target: ReadTarget;
  onPage: (n: number) => void;
  onPages: (n: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    let doc: PDFDocumentProxy | null = null;
    void (async () => {
      try {
        const bytes = new Uint8Array(await api.readFileBytes(path));
        doc = await pdfjs.getDocument({ data: bytes }).promise;
        if (dead) return void doc.destroy();
        const first = await doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        setSize({ w: vp.width, h: vp.height });
        onPages(doc.numPages);
        setPdf(doc);
      } catch (err) {
        if (!dead) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      dead = true;
      void doc?.destroy();
    };
  }, [path, onPages]);

  // 页宽跟着容器走
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.min(el.clientWidth - 48, 900)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 跳到目标页
  useEffect(() => {
    if (!pdf || !target.page || !width) return;
    const el = scroller.current?.querySelector(`[data-page="${target.page}"]`);
    el?.scrollIntoView({ block: "start" });
  }, [pdf, target.page, target.nonce, width]);

  if (error) return <p className="p-8 text-center text-[13px] text-danger">打不开这份 PDF：{error}</p>;

  const scale = size && width > 0 ? width / size.w : 0;

  return (
    <div ref={scroller} className="flex-1 overflow-y-auto px-6 py-5">
      {pdf && size && scale > 0 ? (
        <div className="mx-auto flex flex-col items-center gap-4">
          {Array.from({ length: pdf.numPages }, (_, i) => (
            <PdfPage
              key={i}
              pdf={pdf}
              n={i + 1}
              scale={scale}
              w={size.w * scale}
              h={size.h * scale}
              root={scroller}
              quote={target.page === i + 1 ? target.quote : undefined}
              onVisible={onPage}
            />
          ))}
        </div>
      ) : (
        <p className="arc-shimmer-text p-8 text-center text-[13px]">正在打开…</p>
      )}
    </div>
  );
}

/** 单页：进入视口附近才渲染，离开不销毁（文档通常不长，换来滚回去时不闪） */
function PdfPage(p: {
  pdf: PDFDocumentProxy;
  n: number;
  scale: number;
  w: number;
  h: number;
  root: React.RefObject<HTMLDivElement | null>;
  quote?: string;
  onVisible: (n: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setNear(true);
          if (e.intersectionRatio > 0.5) p.onVisible(p.n);
        }
      },
      { root: p.root.current, rootMargin: "600px 0px", threshold: [0, 0.5] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [p.n, p.root, p.onVisible]);

  useEffect(() => {
    if (!near) return;
    let dead = false;
    setDone(false);
    void (async () => {
      const page = await p.pdf.getPage(p.n);
      if (dead || !canvas.current || !textRef.current) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: p.scale * dpr });
      canvas.current.width = vp.width;
      canvas.current.height = vp.height;
      await page.render({ canvas: canvas.current, viewport: vp }).promise;
      if (dead) return;
      // 文字层：透明的可选中文本，叠在画面上
      textRef.current.replaceChildren();
      const tl = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textRef.current,
        viewport: page.getViewport({ scale: p.scale }),
      });
      await tl.render();
      if (!dead) setDone(true);
    })();
    return () => {
      dead = true;
    };
  }, [near, p.pdf, p.n, p.scale]);

  // 高亮被引用的片段：文字层里凡是落在引文内的文本块都标出来
  useEffect(() => {
    const layer = textRef.current;
    if (!layer || !done) return;
    const q = p.quote ? norm(p.quote) : "";
    const spans = [...layer.querySelectorAll<HTMLElement>("span")];
    const texts = spans.map((sp) => norm(sp.textContent ?? ""));
    // 第一遍：两个字以上、整块落在引文里的算命中
    const hits = texts.map((t) => q.length > 0 && t.length >= 2 && q.includes(t));
    // 第二遍：pdf.js 会把单个字切成独立文本块，夹在两个命中块之间的补上，避免高亮断开
    for (let i = 1; i < spans.length - 1; i++) {
      if (!hits[i] && texts[i].length > 0 && texts[i].length < 2 && hits[i - 1] && hits[i + 1] && q.includes(texts[i])) {
        hits[i] = true;
      }
    }
    spans.forEach((sp, i) => sp.classList.toggle("cite-hl", hits[i]));
    spans[hits.indexOf(true)]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [done, p.quote]);

  return (
    <div
      ref={box}
      data-page={p.n}
      className="pdf-page relative rounded-[3px] border border-hairline"
      style={{ width: p.w, height: p.h, ["--scale-factor" as string]: p.scale, ["--total-scale-factor" as string]: p.scale }}
    >
      <canvas ref={canvas} className="pdf-canvas absolute inset-0 h-full w-full" />
      <div ref={textRef} className="textLayer" />
    </div>
  );
}

/** 非 PDF：Markdown 正常排版，其它格式按段落显示。
 *  引文高亮用 CSS Custom Highlight——不改动 DOM，所以渲染后的 Markdown 也能标。 */
function TextView({ doc, target }: { doc: Doc; target: ReadTarget }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const article = useRef<HTMLElement>(null);

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const full = await api.documentText(doc.id);
        if (!dead) setText(full);
      } catch (err) {
        if (!dead) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      dead = true;
    };
  }, [doc.id]);

  useEffect(() => {
    const el = article.current;
    if (!el || text == null) return;
    let timer = 0;
    let tries = 0;
    // Markdown 是懒加载后才渲染出来的，等内容稳定了再定位
    const apply = () => {
      const range = target.quote ? rangeOf(el, target.quote) : null;
      const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
      if (range) {
        reg?.set("cite", new Highlight(range));
        (range.startContainer.parentElement ?? el).scrollIntoView({ block: "center", behavior: "smooth" });
      } else {
        reg?.delete("cite");
        if (target.quote && tries++ < 10) timer = window.setTimeout(apply, 150);
      }
    };
    timer = window.setTimeout(apply, 60);
    return () => {
      clearTimeout(timer);
      (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete("cite");
    };
  }, [text, target.quote, target.nonce]);

  if (error) return <p className="p-8 text-center text-[13px] text-danger">打不开这份文档：{error}</p>;
  if (text == null) return <p className="arc-shimmer-text p-8 text-center text-[13px]">正在打开…</p>;

  return (
    <div className="flex-1 overflow-y-auto">
      <article ref={article} className="reader-article mx-auto max-w-[720px] px-10 pb-24 pt-10">
        {doc.kind === "md" ? (
          <StreamMarkdown content={text} />
        ) : (
          <div className="whitespace-pre-wrap">{text}</div>
        )}
      </article>
    </div>
  );
}

/** 比较时去掉空白和 Markdown 标记：引文来自原始文本（带 #、** 等），页面上是渲染后的文字 */
const strip = (s: string) => s.normalize("NFKC").replace(/[\s#*`>|_~\-\[\]()]/g, "");

/** 在渲染后的 DOM 里找到引文对应的文字范围 */
function rangeOf(root: HTMLElement, quote: string): Range | null {
  const q = strip(quote);
  if (q.length < 2) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const map: { node: Text; offset: number }[] = [];
  let flat = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n as Text).data;
    for (let i = 0; i < t.length; i++) {
      const c = strip(t[i]);
      if (c) {
        // NFKC 可能把一个字符展开成多个，逐个都指回原位置
        for (const ch of c) {
          flat += ch;
          map.push({ node: n as Text, offset: i });
        }
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
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset + 1);
  return range;
}

/** 划词菜单：在阅读器里选中文字后浮出来，三个动作都会带着引文发到对话里 */
function SelectionMenu({
  root,
  onAction,
}: {
  root: React.RefObject<HTMLElement | null>;
  onAction: (action: SelectionAction, text: string, page: number | null) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; text: string; page: number | null } | null>(null);

  useEffect(() => {
    function update() {
      const sel = window.getSelection();
      const host = root.current;
      if (!sel || sel.isCollapsed || !host || !sel.rangeCount) return setMenu(null);
      const range = sel.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) return setMenu(null);
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (text.length < 2) return setMenu(null);
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
      const pageEl = anchor?.closest("[data-page]");
      const hostRect = host.getBoundingClientRect();
      setMenu({
        // 相对阅读器定位，夹在可视范围内
        x: Math.min(Math.max(last.right - hostRect.left, 130), hostRect.width - 130),
        y: Math.min(last.bottom - hostRect.top + 8, hostRect.height - 48),
        text: text.slice(0, 2000),
        page: pageEl ? Number(pageEl.getAttribute("data-page")) : null,
      });
    }
    const hide = (e: Event) => {
      // 点菜单本身不算
      if (e.target instanceof Element && e.target.closest("[data-selection-menu]")) return;
      setMenu(null);
    };
    document.addEventListener("mouseup", update);
    document.addEventListener("mousedown", hide);
    const host = root.current;
    host?.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("mouseup", update);
      document.removeEventListener("mousedown", hide);
      host?.removeEventListener("scroll", hide, true);
    };
  }, [root]);

  if (!menu) return null;
  const act = (a: SelectionAction) => {
    onAction(a, menu.text, menu.page);
    window.getSelection()?.removeAllRanges();
    setMenu(null);
  };
  const btn = "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] text-text-2 hover:bg-nav-card hover:text-text";
  return (
    <div
      data-selection-menu
      className="absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-hairline-strong bg-surface-2 p-1 shadow-[0_6px_24px_-6px_rgb(0_0_0/0.25)]"
      style={{ left: menu.x, top: menu.y }}
    >
      <button className={btn} onClick={() => act("ask")}>
        <MessageSquareQuote className="h-3.5 w-3.5 text-accent" />
        问这段
      </button>
      <button className={btn} onClick={() => act("explain")}>
        <BookOpenText className="h-3.5 w-3.5" />
        解释
      </button>
      <button className={btn} onClick={() => act("related")}>
        <Search className="h-3.5 w-3.5" />
        找相关
      </button>
    </div>
  );
}
