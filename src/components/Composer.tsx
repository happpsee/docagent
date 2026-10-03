import { useEffect, useRef } from "react";
import { ArrowUp, FileText, Square } from "lucide-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  ready: boolean;
  model: string;
  docCount: number;
  scopeCount: number;
  autoFocus?: boolean;
}

/** 输入框：一个大圆角卡片，文本区随内容长高，底部一行放检索范围、模型和发送 */
export function Composer(p: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 先交还给 CSS（rows=1 + min-height 保证至少一行高），量到有效高度才写回去。
    // 启动瞬间窗口可能还没完成布局，scrollHeight 会是 0；那时如果把 0 写进去，
    // 文本区就塌掉、点不进去了（真实应用里出过这个问题）。
    el.style.height = "auto";
    const h = el.scrollHeight;
    if (h > 0) el.style.height = `${Math.min(h, 220)}px`;
  }, [p.value]);

  const scope =
    p.docCount === 0 ? "还没有文档" : p.scopeCount ? `已选 ${p.scopeCount} 份文档` : `全部 ${p.docCount} 份文档`;

  return (
    <div className="rounded-[20px] border border-hairline-strong bg-surface-2 shadow-[0_2px_12px_-4px_rgb(0_0_0/0.08)] transition-colors focus-within:border-text-4">
      <textarea
        ref={ref}
        value={p.value}
        rows={1}
        autoFocus={p.autoFocus}
        disabled={!p.ready}
        aria-label="输入消息"
        placeholder={p.ready ? "问点什么，或者让我帮你整理资料…" : "先在左下角配置模型"}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            p.onSubmit();
          }
        }}
        className="block min-h-[44px] w-full resize-none bg-transparent px-5 pb-1 pt-4 text-[15px] leading-6 text-text outline-none placeholder:text-text-4"
      />
      <div className="flex items-center gap-2 px-3 pb-3 pt-2">
        <span className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-text-3">
          <FileText className="h-3.5 w-3.5" />
          {scope}
        </span>
        <span className="flex-1" />
        <span className="text-[12px] text-text-4">{p.model}</span>
        {p.busy ? (
          <button
            aria-label="停止"
            onClick={p.onStop}
            className="grid h-8 w-8 place-items-center rounded-full bg-text text-bg"
          >
            <Square className="h-3 w-3" fill="currentColor" />
          </button>
        ) : (
          <button
            aria-label="发送"
            onClick={p.onSubmit}
            disabled={!p.value.trim() || !p.ready}
            className="grid h-8 w-8 place-items-center rounded-full bg-accent text-white transition-opacity disabled:opacity-35"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}
