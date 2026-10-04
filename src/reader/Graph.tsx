import { useEffect, useMemo, useRef, useState } from "react";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { X } from "lucide-react";
import type { LearnConcept, LearnOverview, XRayUnit } from "@/lib/types";
import { dueText } from "@/components/QuizSession";
import { typeTone, type Figure } from "./XRay";

/** 图上最多画多少个：再多就糊成一团了，取出现得最多的 */
const MAX_NODES = 60;

interface GNode extends SimulationNodeDatum {
  id: string;
  figure: Figure;
  r: number;
}
interface GLink extends SimulationLinkDatum<GNode> {
  source: GNode;
  target: GNode;
  /** 原文写明的关系；空的是「只是出现在同一段里」 */
  label: string;
  weight: number;
}

const COLOR: Record<string, string> = { 人物: "#c2603c", 地点: "#4f8a5b", 机构: "#2f6fb0", 概念: "#7a5fb0", 物品: "#a8842c", 条款: "#5a7d8c" };
const colorOf = (type: string) => COLOR[type] ?? "#8a8780";

/** 掌握地图的颜色：没考过灰，记得牢绿，快忘了黄，没答上来 / 忘了红 */
const MASTERY = { none: "#b9b6ae", good: "#4f8a5b", weak: "#c9952a", bad: "#c2603c" };
function masteryColor(c: LearnConcept | undefined): string {
  if (!c) return MASTERY.none;
  if (c.lastGrade === "lapsed" || c.mastery < 0.5) return MASTERY.bad;
  return c.mastery >= 0.85 && c.lastGrade === "recalled" ? MASTERY.good : MASTERY.weak;
}

/** 从读过的那些段里拼出图：点是人物和概念，线是原文写明的关系；
 *  没抽出关系的段（老的透视数据都是这样）退回「出现在同一段」连虚线；抽出了关系的段，同段出现要两次以上才连，不然每段都是一团 */
export function graphOf(units: XRayUnit[], figures: Figure[]): { nodes: GNode[]; links: GLink[] } {
  const top = figures.slice(0, MAX_NODES);
  const nodes = new Map<string, GNode>(top.map((f) => [f.name, { id: f.name, figure: f, r: 7 + Math.min(11, Math.sqrt(f.mentions.length) * 4) }]));
  const pair = (a: string, b: string) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);
  const links = new Map<string, GLink>();
  for (const u of units) {
    for (const r of u.relations ?? []) {
      const s = nodes.get(r.from);
      const t = nodes.get(r.to);
      if (!s || !t || s === t) continue;
      const k = pair(s.id, t.id);
      const had = links.get(k);
      // 后面的段说得更新：关系变了（朋友 → 对手）以后来的为准
      links.set(k, { source: s, target: t, label: r.label || had?.label || "", weight: (had?.weight ?? 0) + 2 });
    }
  }
  const together = new Map<string, number>();
  for (const u of units) {
    const names = [...new Set(u.entities.map((e) => e.name))].filter((n) => nodes.has(n));
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) together.set(pair(names[i], names[j]), (together.get(pair(names[i], names[j])) ?? 0) + (u.relations?.length ? 1 : 2));
  }
  for (const [k, n] of together) {
    if (links.has(k) || n < 2) continue;
    const [a, b] = k.split("\n");
    links.set(k, { source: nodes.get(a)!, target: nodes.get(b)!, label: "", weight: n / 2 });
  }
  return { nodes: [...nodes.values()], links: [...links.values()] };
}

/** 关系图：盖在书页上的一整层。只画读过的部分里出现的人物和概念，读得越多图越大 */
export function GraphView(p: {
  units: XRayUnit[];
  figures: Figure[];
  /** 后面还有多少段没读到（防剧透藏起来的） */
  hidden: number;
  /** 这本书的掌握度；考过题才有，有了图就按掌握度上色 */
  learn: LearnOverview | null;
  onClose: () => void;
  onGoQuote: (quote: string, unit: XRayUnit) => void;
  onAskAbout: (name: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const sim = useRef<Simulation<GNode, GLink> | null>(null);
  const [, setTick] = useState(0);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const state = useMemo(() => new Map((p.learn?.concepts ?? []).map((c) => [c.concept, c])), [p.learn]);
  const [byMastery, setByMastery] = useState(() => !!p.learn?.concepts.length);
  const fill = (n: GNode) => (byMastery ? masteryColor(state.get(n.id)) : colorOf(n.figure.type));
  const graph = useMemo(() => graphOf(p.units, p.figures), [p.units, p.figures]);
  const drag = useRef<{ node: GNode | null; x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const s = forceSimulation(graph.nodes)
      .force("link", forceLink<GNode, GLink>(graph.links).distance((l) => (l.label ? 95 : 120)).strength((l) => Math.min(0.9, 0.25 + l.weight * 0.12)))
      .force("charge", forceManyBody().strength(-420))
      .force("x", forceX(0).strength(0.06))
      .force("y", forceY(0).strength(0.08))
      .force("collide", forceCollide<GNode>().radius((n) => n.r + 16))
      .on("tick", () => setTick((t) => t + 1));
    sim.current = s;
    return () => {
      s.stop();
    };
  }, [graph]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  const focus = hover ?? picked;
  const near = useMemo(() => {
    if (!focus) return null;
    const set = new Set([focus]);
    for (const l of graph.links) {
      if (l.source.id === focus) set.add(l.target.id);
      if (l.target.id === focus) set.add(l.source.id);
    }
    return set;
  }, [focus, graph]);
  const chosen = graph.nodes.find((n) => n.id === picked) ?? null;
  const ties = chosen ? graph.links.filter((l) => l.source === chosen || l.target === chosen).sort((a, b) => b.weight - a.weight) : [];

  const toGraph = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - size.w / 2 - view.x) / view.k, y: (e.clientY - r.top - size.h / 2 - view.y) / view.k };
  };

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-bg" role="dialog" aria-label="关系图">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-hairline px-4">
        <span className="shrink-0 whitespace-nowrap text-[13px] font-medium text-text">关系图</span>
        <span className="min-w-0 truncate text-[12px] text-text-4" title="滚轮缩放 · 拖动空白处平移 · 拖动圆点调整">
          {graph.nodes.length} 个人物与概念 · {graph.links.length} 条关系
          {p.hidden > 0 ? " · 只画了你读过的部分，读到后面会长出新的" : ""}
        </span>
        <span className="flex-1" />
        {byMastery && (
          <span className="flex shrink-0 items-center gap-2.5 whitespace-nowrap text-[11px] text-text-3">
            {(
              [
                ["记得牢", MASTERY.good],
                ["快忘了", MASTERY.weak],
                ["没掌握", MASTERY.bad],
                ["没考过", MASTERY.none],
              ] as const
            ).map(([name, color]) => (
              <span key={name} className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                {name}
              </span>
            ))}
            {p.learn && <span className="num text-good">学会 {Math.round(p.learn.learned * 100)}%</span>}
          </span>
        )}
        <div className="flex shrink-0 gap-0.5 whitespace-nowrap rounded-lg bg-segment-bg p-0.5 text-[12px]">
          <button className={`rounded-md px-2 py-0.5 ${byMastery ? "bg-surface-2 text-text shadow-sm" : "text-text-3"}`} onClick={() => setByMastery(true)}>
            掌握度
          </button>
          <button className={`rounded-md px-2 py-0.5 ${!byMastery ? "bg-surface-2 text-text shadow-sm" : "text-text-3"}`} onClick={() => setByMastery(false)}>
            类型
          </button>
        </div>
        <button className="grid h-7 w-7 place-items-center rounded-md text-text-3 hover:bg-nav-card hover:text-text" aria-label="关闭关系图" onClick={p.onClose}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div
        ref={box}
        className="relative min-h-0 flex-1 cursor-grab select-none overflow-hidden active:cursor-grabbing"
        onWheel={(e) => {
          const k = Math.min(3, Math.max(0.3, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
          setView((v) => ({ ...v, k }));
        }}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const id = (e.target as Element).closest("[data-node]")?.getAttribute("data-node");
          const node = graph.nodes.find((n) => n.id === id) ?? null;
          drag.current = { node, x: e.clientX, y: e.clientY, moved: false };
          if (node) sim.current?.alphaTarget(0.25).restart();
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
          if (d.node) {
            const at = toGraph(e);
            d.node.fx = at.x;
            d.node.fy = at.y;
          } else if (d.moved) {
            setView((v) => ({ ...v, x: v.x + e.clientX - d.x, y: v.y + e.clientY - d.y }));
            d.x = e.clientX;
            d.y = e.clientY;
          }
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          sim.current?.alphaTarget(0);
          if (d.node) {
            d.node.fx = d.node.fy = null;
            if (!d.moved) setPicked((cur) => (cur === d.node!.id ? null : d.node!.id));
          } else if (!d.moved) setPicked(null);
        }}
      >
        {!graph.nodes.length && <p className="absolute inset-0 grid place-items-center text-[13px] text-text-4">读过的部分里还没有整理出人物或概念。</p>}
        <svg width={size.w} height={size.h} className="block">
          <g transform={`translate(${size.w / 2 + view.x},${size.h / 2 + view.y}) scale(${view.k})`}>
            {graph.links.map((l, i) => {
              const on = !near || (near.has(l.source.id) && near.has(l.target.id) && (l.source.id === focus || l.target.id === focus));
              const x1 = l.source.x ?? 0, y1 = l.source.y ?? 0, x2 = l.target.x ?? 0, y2 = l.target.y ?? 0;
              return (
                <g key={i} opacity={on ? 1 : 0.12}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" className="text-text-4" strokeOpacity={l.label ? 0.55 : 0.25} strokeWidth={l.label ? 1.2 : 0.8} strokeDasharray={l.label ? undefined : "3 3"} />
                  {l.label && (on || !near) && (
                    <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 3} textAnchor="middle" className="fill-text-3" fontSize={10} paintOrder="stroke" stroke="var(--color-bg)" strokeWidth={3}>
                      {l.label}
                    </text>
                  )}
                </g>
              );
            })}
            {graph.nodes.map((n) => {
              const on = !near || near.has(n.id);
              return (
                <g
                  key={n.id}
                  data-node={n.id}
                  transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                  opacity={on ? 1 : 0.18}
                  className="cursor-pointer"
                  onPointerEnter={() => !drag.current && setHover(n.id)}
                  onPointerLeave={() => setHover(null)}
                >
                  <circle r={n.r} fill={fill(n)} fillOpacity={0.88} stroke={picked === n.id ? "var(--color-text)" : "var(--color-bg)"} strokeWidth={picked === n.id ? 2 : 1.5} />
                  <text y={n.r + 13} textAnchor="middle" className="fill-text" fontSize={11.5} paintOrder="stroke" stroke="var(--color-bg)" strokeWidth={3}>
                    {n.id}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {chosen && (
          <div className="absolute bottom-4 left-4 max-h-[60%] w-[300px] cursor-default overflow-y-auto rounded-xl border border-hairline-strong bg-surface-2 p-3.5 shadow-[0_10px_32px_-8px_rgb(0_0_0/0.3)]" onPointerDown={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5">
              <span className="text-[14px] font-medium text-text">{chosen.id}</span>
              {chosen.figure.type && <span className={`rounded-full px-1.5 py-px text-[10px] ${typeTone(chosen.figure.type)}`}>{chosen.figure.type}</span>}
              <span className="num ml-auto text-[11px] text-text-4">{chosen.figure.mentions.length} 处</span>
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-text-2">{chosen.figure.mentions[chosen.figure.mentions.length - 1].desc}</p>
            <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-text-3">
              <span className="h-2 w-2 rounded-full" style={{ background: masteryColor(state.get(chosen.id)) }} />
              {state.has(chosen.id)
                ? `掌握度 ${Math.round((state.get(chosen.id)?.mastery ?? 0) * 100)}% · 考过 ${state.get(chosen.id)?.reps} 次 · ${dueText(state.get(chosen.id)?.due ?? 0)}复习`
                : "还没考过"}
            </p>
            {ties.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-hairline-soft pt-2">
                {ties.slice(0, 8).map((l, i) => {
                  const other = l.source === chosen ? l.target : l.source;
                  return (
                    <li key={i}>
                      <button className="flex w-full items-baseline gap-1.5 text-left text-[12.5px] text-text-2 hover:text-accent" onClick={() => setPicked(other.id)}>
                        <span className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full" style={{ background: colorOf(other.figure.type) }} />
                        <span className="text-text">{other.id}</span>
                        <span className="text-[11.5px] text-text-4">{l.label || "出现在同一段"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="mt-2.5 flex gap-3 text-[12px]">
              <button
                className="text-accent hover:underline"
                onClick={() => {
                  const m = chosen.figure.mentions[chosen.figure.mentions.length - 1];
                  p.onClose();
                  p.onGoQuote(m.quote, m.unit);
                }}
              >
                跳到原文
              </button>
              <button
                className="text-accent hover:underline"
                onClick={() => {
                  p.onClose();
                  p.onAskAbout(chosen.id);
                }}
              >
                让助手讲讲来龙去脉
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
