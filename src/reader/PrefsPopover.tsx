import { Minus, Plus } from "lucide-react";
import type { ReaderPrefs } from "@/lib/types";
import { THEMES } from "./engine";

/** 阅读设置：字号、行距、版心、翻页方式、字体、配色。所有书共用一份。 */
export function PrefsPopover(p: { prefs: ReaderPrefs; fixed: boolean; onChange: (patch: Partial<ReaderPrefs>) => void }) {
  const { prefs, onChange } = p;
  const row = "flex items-center justify-between gap-3 py-1.5";
  const label = "text-[12px] text-text-3";
  const seg = (on: boolean) =>
    `rounded-md px-2.5 py-1 text-[12px] ${on ? "bg-surface-2 text-text shadow-sm" : "text-text-3 hover:text-text"}`;
  const group = "flex gap-0.5 rounded-lg bg-segment-bg p-0.5";

  const Stepper = (s: { value: string; onDown: () => void; onUp: () => void; name: string }) => (
    <div className="flex items-center gap-1">
      <button className="grid h-6 w-6 place-items-center rounded-md text-text-2 hover:bg-nav-card" aria-label={`${s.name}减小`} onClick={s.onDown}>
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="num w-10 text-center text-[12px] text-text">{s.value}</span>
      <button className="grid h-6 w-6 place-items-center rounded-md text-text-2 hover:bg-nav-card" aria-label={`${s.name}增大`} onClick={s.onUp}>
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

  return (
    <div
      data-floating
      className="absolute right-12 top-11 z-30 w-[270px] rounded-xl border border-hairline-strong bg-surface-2 px-3.5 py-2 shadow-[0_10px_32px_-8px_rgb(0_0_0/0.3)]"
      role="dialog"
      aria-label="阅读设置"
    >
      {p.fixed ? (
        <div className={row}>
          <span className={label}>版面</span>
          <div className={group}>
            <button className={seg(prefs.spread === "none")} onClick={() => onChange({ spread: "none" })}>
              单页
            </button>
            <button className={seg(prefs.spread === "both")} onClick={() => onChange({ spread: "both" })}>
              双页
            </button>
          </div>
        </div>
      ) : (
        <>
      <div className={row}>
            <span className={label}>翻页方式</span>
            <div className={group}>
              <button className={seg(prefs.flow === "paginated")} onClick={() => onChange({ flow: "paginated" })}>
                翻页
              </button>
              <button className={seg(prefs.flow === "scrolled")} onClick={() => onChange({ flow: "scrolled" })}>
                滚动
              </button>
            </div>
          </div>
          <div className={row}>
            <span className={label}>字号</span>
            <Stepper
              name="字号"
              value={String(prefs.fontSize)}
              onDown={() => onChange({ fontSize: clamp(prefs.fontSize - 1, 12, 30) })}
              onUp={() => onChange({ fontSize: clamp(prefs.fontSize + 1, 12, 30) })}
            />
          </div>
          <div className={row}>
            <span className={label}>行距</span>
            <Stepper
              name="行距"
              value={prefs.lineHeight.toFixed(1)}
              onDown={() => onChange({ lineHeight: clamp(Math.round((prefs.lineHeight - 0.1) * 10) / 10, 1.2, 2.6) })}
              onUp={() => onChange({ lineHeight: clamp(Math.round((prefs.lineHeight + 0.1) * 10) / 10, 1.2, 2.6) })}
            />
          </div>
          <div className={row}>
            <span className={label}>版心宽度</span>
            <Stepper
              name="版心宽度"
              value={String(prefs.width)}
              onDown={() => onChange({ width: clamp(prefs.width - 40, 480, 1200) })}
              onUp={() => onChange({ width: clamp(prefs.width + 40, 480, 1200) })}
            />
          </div>
          <div className={row}>
            <span className={label}>分栏</span>
            <div className={group}>
              <button className={seg(prefs.columns === 1)} onClick={() => onChange({ columns: 1 })}>
                单栏
              </button>
              <button className={seg(prefs.columns === 2)} onClick={() => onChange({ columns: 2 })}>
                双栏
              </button>
            </div>
          </div>
          <div className={row}>
            <span className={label}>字体</span>
            <div className={group}>
              <button className={seg(prefs.font === "serif")} onClick={() => onChange({ font: "serif" })}>
                宋体
              </button>
              <button className={seg(prefs.font === "sans")} onClick={() => onChange({ font: "sans" })}>
                黑体
              </button>
              <button className={seg(prefs.font === "book")} onClick={() => onChange({ font: "book" })} title="用书里自带的字体">
                原书
              </button>
            </div>
          </div>
          <div className={row}>
            <span className={label}>两端对齐</span>
            <div className={group}>
              <button className={seg(prefs.justify)} onClick={() => onChange({ justify: true })}>
                开
              </button>
              <button className={seg(!prefs.justify)} onClick={() => onChange({ justify: false })}>
                关
              </button>
            </div>
          </div>
          <div className={row}>
            <span className={label}>纸色</span>
            <div className="flex gap-1.5">
              {(Object.keys(THEMES) as ReaderPrefs["theme"][]).map((id) => (
                <button
                  key={id}
                  title={THEMES[id].name}
                  aria-label={THEMES[id].name}
                  onClick={() => onChange({ theme: id })}
                  className={`grid h-7 w-7 place-items-center rounded-full border text-[11px] ${prefs.theme === id ? "border-accent ring-2 ring-accent-soft" : "border-hairline-strong"}`}
                  style={{ background: THEMES[id].bg, color: THEMES[id].fg }}
                >
                  文
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
