import { useEffect, useRef } from "react";
import { ArrowUp, Folder, Quote as QuoteIcon, Square, X } from "lucide-react";
import { whereLabel } from "@/lib/citations";
import type { Book, Doc, Quote, Scope } from "@/lib/types";
import { ScopePicker } from "./ScopePicker";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  ready: boolean;
  model: string;
  /** 窄栏里：地方小，模型名不显示，工作文件夹只留图标 */
  compact?: boolean;
  autoFocus?: boolean;
  /** 检索范围：见 ScopePicker */
  books: Book[];
  book: Book | null;
  openDoc: Doc | null;
  scope: Scope | null;
  onScope: (s: Scope | null) => void;
  onSpoiler: (book: Book, on: boolean) => void;
  /** 从阅读器带过来的引文，会和问题一起发出去 */
  quote?: Quote | null;
  onClearQuote?: () => void;
  workspace: string | null;
  onPickWorkspace: () => void;
  onClearWorkspace: () => void;
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

  // 带着引文过来时把光标放进输入框，直接就能打字
  useEffect(() => {
    if (p.quote) ref.current?.focus();
  }, [p.quote]);

  return (
    <div className="rounded-[20px] border border-hairline-strong bg-surface-2 shadow-[0_2px_12px_-4px_rgb(0_0_0/0.08)] transition-colors focus-within:border-text-4">
      {p.quote && (
        <div className="mx-3 mt-3 flex items-start gap-2 rounded-xl bg-segment-bg px-3 py-2">
          <QuoteIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="line-clamp-3 text-[12px] leading-5 text-text-2">{p.quote.text}</div>
            <div className="mt-0.5 truncate text-[11px] text-text-4">
              {p.quote.docTitle}
              {whereLabel(p.quote.kind, p.quote.docTitle, p.quote.page)}
            </div>
          </div>
          <button aria-label="移除引文" onClick={p.onClearQuote} className="text-text-4 hover:text-text">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <textarea
        ref={ref}
        value={p.value}
        rows={1}
        autoFocus={p.autoFocus}
        disabled={!p.ready}
        aria-label="输入消息"
        placeholder={!p.ready ? "先在左下角配置模型" : p.quote ? "就这段话问点什么…" : "哪里没看懂，问我…"}
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
        <span
          className={`group inline-flex min-w-0 shrink-0 items-center rounded-lg text-[12px] ${
            p.workspace ? "bg-segment-bg text-text-2" : "text-text-3 hover:bg-nav-card"
          }`}
        >
          <button
            className="inline-flex min-w-0 items-center gap-1.5 px-2 py-1"
            onClick={p.onPickWorkspace}
            title={p.workspace ?? "选一个文件夹，让助手在里面干活（读代码、写文件），并加载那里的 .docagent 配置"}
          >
            <Folder className="h-3.5 w-3.5 shrink-0" />
            {!p.compact && <span className="truncate">{p.workspace ? p.workspace.split("/").pop() : "工作文件夹"}</span>}
          </button>
          {p.workspace && !p.compact && (
            <button aria-label="取消工作文件夹" className="pr-1.5 text-text-4 hover:text-text" onClick={p.onClearWorkspace}>
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
        <ScopePicker books={p.books} book={p.book} openDoc={p.openDoc} scope={p.scope} onScope={p.onScope} onSpoiler={p.onSpoiler} />
        <span className="flex-1" />
        {!p.compact && <span className="shrink-0 text-[12px] text-text-4">{p.model}</span>}
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
