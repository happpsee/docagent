import { useEffect, useState } from "react";
import { BookOpenText, Copy, Highlighter, MessageSquareQuote, NotebookPen, Search, Trash2, Underline, Waves } from "lucide-react";
import type { Annotation, HighlightColor, HighlightStyle } from "@/lib/types";
import { MOD } from "@/lib/keys";
import { HL } from "./engine";
import type { SelectionAction } from "./Reader";
import { FigureCard, type Figure } from "./XRay";

export interface PopupState {
  /** 相对阅读器的位置：选区最后一行底部的中点，以及选区顶部 */
  x: number;
  y: number;
  top: number;
  text: string;
  cfi: string;
  index: number;
  /** 点的是已有高亮时，它的 id */
  existing: string | null;
}

const STYLES: { id: HighlightStyle; name: string; icon: typeof Highlighter }[] = [
  { id: "highlight", name: "高亮", icon: Highlighter },
  { id: "underline", name: "下划线", icon: Underline },
  { id: "squiggly", name: "波浪线", icon: Waves },
];

/** 划词菜单：划线（颜色、样式）、写笔记、复制，以及把这段话交给助手 */
export function SelectionPopup(p: {
  state: PopupState;
  existing: Annotation | null;
  /** 选中的是透视里已知的人物或概念 */
  figure?: Figure | null;
  current: { color: HighlightColor; style: HighlightStyle };
  hostWidth: number;
  hostHeight: number;
  onMark: (patch: Partial<Pick<Annotation, "color" | "style" | "note">>) => Annotation | null;
  onDelete: (a: Annotation) => void;
  onCopy: () => void;
  onAction: (a: SelectionAction) => void;
  onClose: () => void;
}) {
  const [noting, setNoting] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    setNoting(false);
  }, [p.state.cfi]);

  const color = p.existing?.color ?? null;
  const style = p.existing?.style ?? p.current.style;
  const width = 300;
  const height = (noting ? 190 : 84) + (p.figure ? 92 : 0);
  // 下面放不下就翻到选区上面
  const below = p.state.y + 10 + height < p.hostHeight;
  const left = Math.min(Math.max(p.state.x, width / 2 + 8), p.hostWidth - width / 2 - 8);
  const top = below ? p.state.y + 10 : Math.max(p.state.top - height - 10, 8);

  const btn = "inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] text-text-2 hover:bg-nav-card hover:text-text";
  const icon = "grid h-7 w-7 place-items-center rounded-md text-text-3 hover:bg-nav-card hover:text-text";

  return (
    <div
      data-selection-menu
      className="absolute z-30 -translate-x-1/2 rounded-xl border border-hairline-strong bg-surface-2 p-1.5 shadow-[0_8px_28px_-6px_rgb(0_0_0/0.28)]"
      style={{ left, top, width }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {p.figure && <FigureCard figure={p.figure} />}
      <div className="flex items-center gap-1">
        {(Object.keys(HL) as HighlightColor[]).map((c) => (
          <button
            key={c}
            title={`${HL[c].name}色${STYLES.find((s) => s.id === style)?.name ?? ""}`}
            aria-label={`${HL[c].name}色`}
            onClick={() => p.onMark({ color: c, style })}
            className={`grid h-7 w-7 place-items-center rounded-md hover:bg-nav-card`}
          >
            <span
              className={`h-4 w-4 rounded-full ${color === c ? "ring-2 ring-text-3 ring-offset-1 ring-offset-surface-2" : ""}`}
              style={{ background: HL[c].fill }}
            />
          </button>
        ))}
        <span className="mx-0.5 h-4 w-px bg-hairline" />
        {STYLES.map((s) => (
          <button
            key={s.id}
            title={s.name}
            aria-label={s.name}
            onClick={() => p.onMark({ style: s.id, color: color ?? p.current.color })}
            className={`${icon} ${p.existing && style === s.id ? "bg-nav-card text-text" : ""}`}
          >
            <s.icon className="h-3.5 w-3.5" />
          </button>
        ))}
        <span className="flex-1" />
        {p.existing ? (
          <button className={`${icon} hover:text-danger`} title="删除这条划线" aria-label="删除这条划线" onClick={() => p.onDelete(p.existing!)}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {noting ? (
        <div className="mt-1.5">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            placeholder={`写下你的想法…  ${MOD}↵ 保存`}
            className="w-full resize-none rounded-md border border-hairline-strong bg-bg px-2 py-1.5 text-[13px] text-text outline-none focus:border-accent"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                p.onMark({ note: draft.trim() });
                p.onClose();
              }
              if (e.key === "Escape") setNoting(false);
              e.stopPropagation();
            }}
          />
          <div className="mt-1 flex justify-end gap-1">
            <button className={btn} onClick={() => setNoting(false)}>
              取消
            </button>
            <button
              className="rounded-md bg-accent px-3 py-1 text-[12px] text-white"
              onClick={() => {
                p.onMark({ note: draft.trim() });
                p.onClose();
              }}
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex items-center border-t border-hairline-soft pt-1">
          <button className={btn} onClick={() => p.onAction("ask")}>
            <MessageSquareQuote className="h-3.5 w-3.5 text-accent" />
            问这段
          </button>
          <button className={btn} onClick={() => p.onAction("explain")}>
            <BookOpenText className="h-3.5 w-3.5" />
            解释
          </button>
          <button className={btn} onClick={() => p.onAction("related")}>
            <Search className="h-3.5 w-3.5" />
            找相关
          </button>
          <span className="flex-1" />
          <button
            className={icon}
            title={p.existing?.note ? "改笔记" : "写笔记"}
            aria-label="写笔记"
            onClick={() => {
              setDraft(p.existing?.note ?? "");
              setNoting(true);
            }}
          >
            <NotebookPen className="h-3.5 w-3.5" />
          </button>
          <button className={icon} title="复制" aria-label="复制" onClick={p.onCopy}>
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {p.existing?.note && !noting ? (
        <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md bg-bg px-2 py-1.5 text-[12.5px] leading-relaxed text-text-2">
          {p.existing.note}
        </p>
      ) : null}
    </div>
  );
}
