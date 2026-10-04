import { useEffect, useState } from "react";
import { History, Loader2, RefreshCw, X } from "lucide-react";
import * as api from "@/lib/api";
import type { Book, XRayUnit } from "@/lib/types";

/** 隔了多久再打开才主动弹出来 */
export const RECAP_AFTER_MS = 6 * 3600 * 1000;

/** 读过那些段的要点，按先后一行一段；太长的书只留最近的 40 段 */
export function recapNotes(book: Book, units: XRayUnit[]): string {
  const name = new Map(book.docs.map((d) => [d.id, d.name]));
  const multi = book.docs.length > 1;
  return units
    .slice(-40)
    .map((u) => `${multi ? `${name.get(u.docId) ?? ""} · ` : ""}${u.title || `第 ${u.unit + 1} 部分`}：${u.summary}`)
    .join("\n");
}

/** 前情提要：浮在书页上方的一张卡片。只用读过的部分生成，同一个位置再打开直接用存着的 */
export function RecapCard(p: { book: Book; docId: string; fraction: number; notes: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = (fresh: boolean) => {
    setBusy(true);
    setError(null);
    return api.recap(p.book.id, p.docId, p.fraction, p.notes, fresh).then(
      (t) => {
        setText(t);
        setBusy(false);
      },
      (err) => {
        setError(String(err));
        setBusy(false);
      },
    );
  };
  // 打开时的位置和材料就是这一份的依据；之后翻页不跟着变
  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div data-floating className="absolute left-1/2 top-3 z-30 w-[min(520px,calc(100%-32px))] -translate-x-1/2 rounded-xl border border-hairline-strong bg-surface-2 p-4 shadow-[0_14px_40px_-10px_rgb(0_0_0/0.35)]" role="dialog" aria-label="前情提要">
      <div className="flex items-center gap-2">
        <History className="h-4 w-4 text-accent" />
        <span className="text-[13px] font-medium text-text">前情提要</span>
        <span className="text-[11px] text-text-4">读到 {Math.round(p.fraction * 100)}% · 只根据你读过的部分</span>
        <span className="flex-1" />
        <button className="grid h-6 w-6 place-items-center rounded-md text-text-3 hover:bg-nav-card hover:text-text disabled:opacity-40" title="重写一份" aria-label="重写一份" disabled={busy} onClick={() => void load(true)}>
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button className="grid h-6 w-6 place-items-center rounded-md text-text-3 hover:bg-nav-card hover:text-text" aria-label="关闭" onClick={p.onClose}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {busy ? (
        <div className="mt-3 flex items-center gap-2 text-[12.5px] text-text-3">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在回顾读过的部分…
        </div>
      ) : error ? (
        <p className="mt-3 text-[12.5px] leading-relaxed text-danger">{error}</p>
      ) : (
        <p className="display-serif mt-3 text-[14px] leading-[1.8] text-text">{text}</p>
      )}
    </div>
  );
}
