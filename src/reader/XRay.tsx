import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, RefreshCw, ScanSearch } from "lucide-react";
import * as api from "@/lib/api";
import type { XRay, XRayEntity, XRayUnit } from "@/lib/types";

/** 一个人物或概念：把它在各段里的出现合在一起 */
export interface Figure {
  name: string;
  type: string;
  mentions: { unit: XRayUnit; desc: string; quote: string }[];
}

/** 透视的数据和进度。数据在 Rust 那边存着，这里只是取来、听进度 */
export function useXRay(docId: string, onError: (m: string) => void) {
  const [xray, setXRay] = useState<XRay>({ units: [], total: 0 });
  const [building, setBuilding] = useState(false);

  const reload = useCallback(() => api.xrayGet(docId).then(setXRay, () => {}), [docId]);

  useEffect(() => {
    setXRay({ units: [], total: 0 });
    setBuilding(false);
    void reload();
    const un = api.onXRayProgress((p) => {
      if (p.docId !== docId) return;
      void reload();
      if (p.finished) {
        setBuilding(false);
        if (p.error) onError(`透视中断了（已完成的部分保留，可以接着做）：${p.error}`);
      } else setBuilding(true);
    });
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, reload]);

  const build = useCallback(async () => {
    setBuilding(true);
    try {
      await api.xrayBuild(docId);
    } catch (err) {
      setBuilding(false);
      onError(String(err));
    }
  }, [docId, onError]);

  const rebuild = useCallback(async () => {
    await api.xrayClear(docId).catch(() => {});
    setXRay((x) => ({ ...x, units: [] }));
    await build();
  }, [docId, build]);

  return { xray, building, build, rebuild };
}

/** 用户读到的位置之前（含正在读的这一段）的那些段 */
export function visibleUnits(xray: XRay, fraction: number, spoilerFree: boolean): XRayUnit[] {
  return spoilerFree ? xray.units.filter((u) => u.start <= fraction + 1e-6) : xray.units;
}

export function figuresOf(units: XRayUnit[]): Figure[] {
  const map = new Map<string, Figure>();
  for (const unit of units) {
    for (const e of unit.entities) {
      const f = map.get(e.name) ?? { name: e.name, type: e.type, mentions: [] };
      f.mentions.push({ unit, desc: e.desc, quote: e.quote });
      map.set(e.name, f);
    }
  }
  // 出现得多的在前；一样多的按先后
  return [...map.values()].sort((a, b) => b.mentions.length - a.mentions.length);
}

/** 选中的文字是不是某个人物或概念的名字（选多了一点也算） */
export function lookup(figures: Figure[], text: string): Figure | null {
  const t = text.trim();
  if (t.length < 2 || t.length > 40) return null;
  return figures.find((f) => f.name === t) ?? figures.find((f) => f.name.length >= 2 && t.includes(f.name)) ?? null;
}

const TYPE_TONE: Record<string, string> = {
  人物: "bg-accent-dim text-accent",
  地点: "bg-[#4f8a5b1f] text-good",
  机构: "bg-[#58a6f026] text-[#2f6fb0]",
};
export const typeTone = (type: string) => TYPE_TONE[type] ?? "bg-segment-bg text-text-3";

export function XRayPanel(p: {
  xray: XRay;
  building: boolean;
  fraction: number;
  spoilerFree: boolean;
  onToggleSpoiler: () => void;
  onBuild: () => void;
  onRebuild: () => void;
  onGoUnit: (u: XRayUnit) => void;
  onGoQuote: (quote: string, unit: XRayUnit) => void;
  /** 让助手基于某个人物继续聊 */
  onAskAbout: (name: string) => void;
}) {
  const [tab, setTab] = useState<"units" | "figures">("units");
  const [open, setOpen] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const units = useMemo(() => visibleUnits(p.xray, p.fraction, p.spoilerFree), [p.xray, p.fraction, p.spoilerFree]);
  const figures = useMemo(() => figuresOf(units), [units]);
  const types = useMemo(() => [...new Set(figures.map((f) => f.type).filter(Boolean))], [figures]);
  const hidden = p.xray.units.length - units.length;
  const done = p.xray.units.length;
  const current = [...units].reverse().find((u) => u.start <= p.fraction + 1e-6)?.unit;

  if (!done && !p.building) {
    return (
      <div className="px-5 py-8 text-center">
        <ScanSearch className="mx-auto h-7 w-7 text-accent" strokeWidth={1.5} />
        <div className="display-serif mt-3 text-[16px] text-text">透视这本书</div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-text-3">
          让助手把全书读一遍，给每一部分留下要点，把人物和概念整理成卡片。
          之后读到哪里忘了“这是谁”“前面讲了什么”，在这里一眼就能找回来，每一条都能点回原文。
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-text-4">默认只显示你读过的部分，不会剧透。全书的文字会分段发给你配置的模型。</p>
        <button className="mt-4 rounded-lg bg-accent px-4 py-2 text-[13px] text-white hover:bg-accent-2" onClick={p.onBuild}>
          开始透视
        </button>
      </div>
    );
  }

  const seg = (on: boolean) => `rounded-md px-2.5 py-1 text-[12px] ${on ? "bg-surface-2 text-text shadow-sm" : "text-text-3 hover:text-text"}`;
  const icon = "grid h-6 w-6 place-items-center rounded-md text-text-3 hover:bg-nav-card hover:text-text";

  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-hairline-soft bg-bg-grad-a px-2 py-1.5">
        <div className="flex items-center gap-1">
          <div className="flex gap-0.5 rounded-lg bg-segment-bg p-0.5">
            <button className={seg(tab === "units")} onClick={() => setTab("units")}>
              要点
            </button>
            <button className={seg(tab === "figures")} onClick={() => setTab("figures")}>
              人物与概念{figures.length ? ` ${figures.length}` : ""}
            </button>
          </div>
          <span className="flex-1" />
          <button
            className={`${icon} ${p.spoilerFree ? "text-accent" : ""}`}
            title={p.spoilerFree ? "防剧透已开：只显示你读过的部分。点击显示全书" : "正在显示全书。点击只显示读过的部分"}
            aria-label="防剧透"
            aria-pressed={p.spoilerFree}
            onClick={p.onToggleSpoiler}
          >
            {p.spoilerFree ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
          <button className={icon} title="重新透视" aria-label="重新透视" disabled={p.building} onClick={p.onRebuild}>
            <RefreshCw className={`h-3.5 w-3.5 ${p.building ? "animate-spin" : ""}`} />
          </button>
        </div>
        {p.building || done < p.xray.total ? (
          <div className="mt-1.5 px-0.5">
            <div className="h-1 overflow-hidden rounded-full bg-segment-bg">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${p.xray.total ? (done / p.xray.total) * 100 : 0}%` }} />
            </div>
            <div className="mt-1 flex items-center text-[11px] text-text-4">
              {p.building ? `正在读 ${done}/${p.xray.total}` : `读了 ${done}/${p.xray.total} 段`}
              {!p.building && (
                <button className="ml-auto text-accent hover:underline" onClick={p.onBuild}>
                  接着读完
                </button>
              )}
            </div>
          </div>
        ) : null}
      </div>

      {tab === "units" ? (
        <ul className="px-2 py-1.5">
          {units.map((u) => (
            <li key={u.unit}>
              <button
                onClick={() => p.onGoUnit(u)}
                className={`block w-full rounded-lg px-2.5 py-2 text-left hover:bg-nav-card ${u.unit === current ? "bg-accent-dim" : ""}`}
              >
                <div className={`text-[13px] font-medium ${u.unit === current ? "text-accent" : "text-text"}`}>
                  {u.title || `第 ${u.unit + 1} 部分`}
                </div>
                <div className="mt-0.5 text-[12.5px] leading-relaxed text-text-2">{u.summary}</div>
              </button>
            </li>
          ))}
          {hidden > 0 && <li className="px-2.5 py-3 text-[12px] text-text-4">后面还有 {hidden} 段，读到了再显示。</li>}
        </ul>
      ) : (
        <div className="px-2 py-1.5">
          {types.length > 1 && (
            <div className="flex flex-wrap gap-1 px-1 pb-1.5">
              {types.map((t) => (
                <button
                  key={t}
                  onClick={() => setType((cur) => (cur === t ? null : t))}
                  className={`rounded-full px-2 py-0.5 text-[11px] ${type === t ? "bg-text text-bg" : "bg-segment-bg text-text-3 hover:text-text"}`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          {!figures.length && <p className="px-2 py-6 text-center text-[12px] text-text-4">读过的部分里还没有整理出人物或概念。</p>}
          <ul>
            {figures
              .filter((f) => !type || f.type === type)
              .map((f) => {
                const last = f.mentions[f.mentions.length - 1];
                const expanded = open === f.name;
                return (
                  <li key={f.name} className="rounded-lg hover:bg-nav-card">
                    <button className="block w-full px-2.5 py-2 text-left" onClick={() => setOpen(expanded ? null : f.name)}>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-medium text-text">{f.name}</span>
                        {f.type && <span className={`rounded-full px-1.5 py-px text-[10px] ${typeTone(f.type)}`}>{f.type}</span>}
                        <span className="num ml-auto text-[11px] text-text-4">{f.mentions.length} 处</span>
                      </div>
                      {!expanded && <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-text-2">{last.desc}</div>}
                    </button>
                    {expanded && (
                      <div className="px-2.5 pb-2">
                        <ol className="space-y-1.5 border-l border-hairline pl-2.5">
                          {f.mentions.map((m, i) => (
                            <li key={i}>
                              <button className="block w-full text-left" onClick={() => p.onGoQuote(m.quote, m.unit)} title="跳到原文">
                                <div className="text-[11px] text-text-4">{m.unit.title || `第 ${m.unit.unit + 1} 部分`}</div>
                                <div className="text-[12.5px] leading-relaxed text-text-2">{m.desc}</div>
                                {m.quote && <div className="mt-0.5 text-[12px] leading-relaxed text-text-3">“{m.quote}”</div>}
                              </button>
                            </li>
                          ))}
                        </ol>
                        <button className="mt-2 text-[12px] text-accent hover:underline" onClick={() => p.onAskAbout(f.name)}>
                          让助手讲讲{f.type === "人物" ? "这个人" : "它"}到目前为止的来龙去脉
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>
          {hidden > 0 && <p className="px-2.5 py-3 text-[12px] text-text-4">只统计了你读过的部分。</p>}
        </div>
      )}
    </div>
  );
}

/** 划词菜单里的小卡片：选中的是个已知的人物或概念时，直接告诉用户它是什么 */
export function FigureCard({ figure, entity }: { figure: Figure; entity?: XRayEntity }) {
  const last = figure.mentions[figure.mentions.length - 1];
  return (
    <div className="mb-1.5 rounded-lg bg-bg px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[13px] font-medium text-text">{figure.name}</span>
        {figure.type && <span className={`rounded-full px-1.5 py-px text-[10px] ${typeTone(figure.type)}`}>{figure.type}</span>}
        <span className="num ml-auto text-[11px] text-text-4">读过的部分里出现 {figure.mentions.length} 处</span>
      </div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-text-2">{entity?.desc ?? last.desc}</div>
      {figure.mentions.length > 1 && (
        <div className="mt-1 text-[11.5px] leading-relaxed text-text-3">最早：{figure.mentions[0].desc}</div>
      )}
    </div>
  );
}
