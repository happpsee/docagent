import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import * as api from "@/lib/api";
import { locate } from "@/lib/citations";
import { parseFile } from "@/lib/parse";
import type { Doc } from "@/lib/types";
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
}

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

/** 文档阅读器：PDF 逐页渲染（带可选中的文字层），其它格式显示全文。
 *  从引用跳过来时滚到那一页并高亮被引用的片段。 */
export function Reader({ doc, target, onClose }: Props) {
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState<number | null>(doc.pages);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg-grad-b/50">
      <header className="flex items-center gap-3 border-b border-hairline bg-bg px-5 py-2.5">
        <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{doc.title}</div>
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
      className="pdf-page relative bg-white shadow-[0_1px_8px_-2px_rgb(0_0_0/0.18)]"
      style={{ width: p.w, height: p.h, ["--scale-factor" as string]: p.scale, ["--total-scale-factor" as string]: p.scale }}
    >
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      <div ref={textRef} className="textLayer" />
    </div>
  );
}

/** 非 PDF：显示提取出的全文，引文用 <mark> 标出 */
function TextView({ doc, target }: { doc: Doc; target: ReadTarget }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const bytes = new Uint8Array(await api.readFileBytes(doc.path!));
        const parsed = await parseFile(doc.title, bytes);
        if (!dead) setText(parsed.pages.map((p) => p.text).join("\n\n"));
      } catch (err) {
        if (!dead) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      dead = true;
    };
  }, [doc.path, doc.title]);

  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [text, target.quote, target.nonce]);

  if (error) return <p className="p-8 text-center text-[13px] text-danger">打不开这份文档：{error}</p>;
  if (text == null) return <p className="arc-shimmer-text p-8 text-center text-[13px]">正在打开…</p>;

  const [at, len] = locate(text, target.quote);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <article className="mx-auto max-w-[720px] whitespace-pre-wrap rounded-sm bg-surface-2 px-12 py-10 text-[15px] leading-8 text-text shadow-[0_1px_8px_-2px_rgb(0_0_0/0.12)]">
        {at < 0 ? (
          text
        ) : (
          <>
            {text.slice(0, at)}
            <mark ref={markRef} className="cite-mark">
              {text.slice(at, at + len)}
            </mark>
            {text.slice(at + len)}
          </>
        )}
      </article>
    </div>
  );
}
