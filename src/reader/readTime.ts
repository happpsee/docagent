/** 判断「这一段是不是真的读过了」。翻过去不算读过：要在这一段上实际停留够久，而且各部分都看到过。
 *
 *  - 停留：只在窗口开着、在前台、两分钟内有过翻页或鼠标键盘动作时计时——开着书去干别的不算
 *  - 够久：按这一段的字数算，至少是「快速浏览」的速度（每秒 20 个字）读一遍要的时间，最少半分钟
 *  - 都看到过：把这一段按大约一屏一格分成几格，七成以上的格子都停留过
 *
 *  读的时间按篇存在本机（localStorage），关了书下次接着算。 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { QuizUnit } from "@/lib/types";

const TICK = 2;
const IDLE_MS = 120_000;
const key = (docId: string) => `docagent:read:${docId}`;

/** 一段分几格：大约一屏（800 字）一格，最多 8 格 */
export const cellsOf = (u: QuizUnit) => Math.min(8, Math.max(1, Math.round((u.chars ?? 2000) / 800)));
/** 一段至少要停留多少秒才算读过 */
export const needOf = (u: QuizUnit) => Math.min(480, Math.max(30, (u.chars ?? 2000) / 20));

/** 这一段读过了没有。cells 是每一格停留的秒数 */
export function isRead(u: QuizUnit, cells: number[] | undefined): boolean {
  if (!cells) return false;
  const n = cellsOf(u);
  const need = needOf(u);
  const total = cells.reduce((a, b) => a + (b || 0), 0);
  // 一格至少停留过「平均每格该花的时间」的四分之一才算看到过，一闪而过的不算
  const seen = Array.from({ length: n }, (_, i) => cells[i] || 0).filter((s) => s >= Math.max(TICK, (need / n) * 0.25)).length;
  return total >= need && seen >= Math.ceil(n * 0.7);
}

export function useReadTracker(docId: string, units: QuizUnit[], here: { unit: number | null; fraction: number }) {
  const times = useRef<Record<number, number[]>>({});
  const [read, setRead] = useState<Set<number>>(new Set());
  const hereRef = useRef(here);
  hereRef.current = here;
  const unitsRef = useRef(units);
  unitsRef.current = units;
  const lastActive = useRef(Date.now());
  /** 有动作（翻页、鼠标、键盘）时叫一下 */
  const touch = useCallback(() => {
    lastActive.current = Date.now();
  }, []);

  useEffect(touch, [here.fraction, touch]);

  const recompute = useCallback(() => {
    const next = new Set(unitsRef.current.filter((u) => isRead(u, times.current[u.unit])).map((u) => u.unit));
    setRead((cur) => (cur.size === next.size && [...next].every((x) => cur.has(x)) ? cur : next));
  }, []);

  useEffect(() => {
    try {
      times.current = JSON.parse(localStorage.getItem(key(docId)) ?? "{}") as Record<number, number[]>;
    } catch {
      times.current = {};
    }
    recompute();
  }, [docId, recompute]);
  useEffect(recompute, [units, recompute]);

  useEffect(() => {
    let ticks = 0;
    const save = () => {
      try {
        localStorage.setItem(key(docId), JSON.stringify(times.current));
      } catch {
        // 存不了就只在这次打开期间算
      }
    };
    const timer = window.setInterval(() => {
      const { unit, fraction } = hereRef.current;
      const u = unitsRef.current.find((x) => x.unit === unit);
      if (!u || document.visibilityState !== "visible" || !document.hasFocus() || Date.now() - lastActive.current > IDLE_MS) return;
      const n = cellsOf(u);
      const span = Math.max(1e-6, u.end - u.start);
      const cell = Math.min(n - 1, Math.max(0, Math.floor(((fraction - u.start) / span) * n)));
      const cells = (times.current[u.unit] ??= []);
      cells[cell] = (cells[cell] || 0) + TICK;
      recompute();
      if (++ticks % 5 === 0) save();
    }, TICK * 1000);
    return () => {
      window.clearInterval(timer);
      save();
    };
  }, [docId, recompute]);

  /** 在这一段上一共停留了多少秒 */
  const secondsOn = useCallback((unit: number) => (times.current[unit] ?? []).reduce((a, b) => a + (b || 0), 0), []);
  return { read, touch, secondsOn };
}
