import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import * as api from "../lib/api";
import type { SearchHit } from "../lib/types";

interface Props {
  hit: SearchHit | null;
  docPath: string | null;
  onClose: () => void;
}

/** 引用溯源视图：PDF 渲染对应页面，其它格式显示原文片段。 */
export function Viewer({ hit, docPath, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      if (!hit || !docPath || !hit.page || !canvasRef.current) return;
      setStatus("渲染页面…");
      try {
        const bytes = new Uint8Array(await api.readFileBytes(docPath));
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        if (cancelled) return;
        const page = await doc.getPage(hit.page);
        const viewport = page.getViewport({ scale: 1.4 });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        await doc.destroy();
        setStatus(null);
      } catch (err) {
        setStatus(`渲染失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    void render();
    return () => {
      cancelled = true;
    };
  }, [hit, docPath]);

  if (!hit) return null;

  return (
    <aside className="panel viewer">
      <header>
        <h2>
          {hit.docTitle}
          <small>{hit.page ? ` · 第 ${hit.page} 页` : ` · 第 ${hit.idx + 1} 段`}</small>
        </h2>
        <button className="link" onClick={onClose}>
          关闭
        </button>
      </header>

      <div className="excerpt">
        <div className="excerpt-label">引用的原文</div>
        <mark>{hit.text}</mark>
      </div>

      {hit.page ? (
        <div className="pagebox">
          {status && <div className="progress">{status}</div>}
          <canvas ref={canvasRef} />
        </div>
      ) : (
        <p className="hint">这个格式没有页码，上面就是原文位置。</p>
      )}
    </aside>
  );
}
