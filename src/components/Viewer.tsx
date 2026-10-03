import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import * as api from "@/lib/api";
import type { Hit } from "@/lib/types";
import { ModalCloseButton } from "./ui/ModalCloseButton";

interface Props {
  hit: Hit;
  docPath: string | null;
  onClose: () => void;
}

/** 引用溯源：显示被引用的原文片段；PDF 还会渲染那一页 */
export function Viewer({ hit, docPath, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      if (!docPath || !hit.page || !canvasRef.current) return;
      setStatus("渲染页面…");
      try {
        const bytes = new Uint8Array(await api.readFileBytes(docPath));
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        if (cancelled) return;
        const page = await doc.getPage(hit.page);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, viewport }).promise;
        await doc.destroy();
        if (!cancelled) setStatus(null);
      } catch (err) {
        if (!cancelled) setStatus(`渲染失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    void render();
    return () => {
      cancelled = true;
    };
  }, [hit, docPath]);

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-hairline bg-surface-2/60">
      <header className="flex items-center gap-2 border-b border-hairline px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-text">{hit.docTitle}</div>
          <div className="num text-[11px] text-text-4">
            {hit.page ? `第 ${hit.page} 页` : `第 ${hit.idx + 1} 段`}
          </div>
        </div>
        <ModalCloseButton onClick={onClose} />
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="text-[11px] uppercase tracking-wide text-text-4">引用的原文</div>
        <blockquote className="mt-2 whitespace-pre-wrap rounded-lg border-l-2 border-accent bg-accent-dim px-3 py-2.5 text-[13px] leading-6 text-text">
          {hit.text}
        </blockquote>

        {hit.page ? (
          <div className="mt-4">
            {status && <div className="arc-shimmer-text mb-2 text-[12px]">{status}</div>}
            <canvas ref={canvasRef} className="w-full rounded-lg border border-hairline" />
          </div>
        ) : null}
      </div>
    </aside>
  );
}
