/** 主动建议的频率：什么时候可以打断读者，由这里说了算——不交给模型自己把握。
 *
 *  规矩：
 *  - 两次建议之间至少隔一段时间（「适中」是 10 分钟）
 *  - 被关掉一次，间隔翻倍（最多到 1 小时）；被接受一次，恢复原样——读者不想被打扰时，它自己会安静下来
 *  - 一天有上限
 *  - 同一段只问一次
 *  - 问过模型、模型说「现在不用打断」的，也要歇几分钟再问，不然每翻一页都在花钱
 */

export type CoachLevel = "off" | "low" | "mid" | "high";

const MIN = 60_000;
const BASE: Record<Exclude<CoachLevel, "off">, number> = { low: 20 * MIN, mid: 10 * MIN, high: 5 * MIN };
const DAILY: Record<Exclude<CoachLevel, "off">, number> = { low: 4, mid: 8, high: 14 };
const MAX_GAP = 60 * MIN;
/** 模型说不用打断之后，多久再问它 */
const ASK_GAP = 4 * MIN;

export interface CoachState {
  /** 上一次把建议摆到读者面前的时刻 */
  lastPushAt: number;
  /** 上一次去问模型的时刻（不管它说推不推） */
  lastAskAt: number;
  /** 连着被关掉了几次 */
  dismissed: number;
  /** 今天推了几次，和「今天」是哪天 */
  day: string;
  count: number;
  /** 已经为它问过的段：`docId:unit:原因` */
  asked: string[];
  /** 最近几次建议读者怎么回应的（接受 / 关掉），新的在后，给模型参考 */
  recent: string[];
}

export const EMPTY: CoachState = { lastPushAt: 0, lastAskAt: 0, dismissed: 0, day: "", count: 0, asked: [], recent: [] };

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/** 现在两次建议之间要隔多久 */
export function gapOf(level: CoachLevel, state: CoachState): number {
  if (level === "off") return Infinity;
  return Math.min(MAX_GAP, BASE[level] * 2 ** state.dismissed);
}

/** 现在能不能为这件事去问模型。key 是 `docId:unit:原因`；说明了为什么不能，方便排查 */
export function mayAsk(level: CoachLevel, state: CoachState, key: string, now: number): { ok: boolean; why?: string } {
  if (level === "off") return { ok: false, why: "关着" };
  if (state.asked.includes(key)) return { ok: false, why: "这一段问过了" };
  if (state.day === dayOf(now) && state.count >= DAILY[level]) return { ok: false, why: "今天够多了" };
  if (now - state.lastPushAt < gapOf(level, state)) return { ok: false, why: "离上一次建议太近" };
  if (now - state.lastAskAt < ASK_GAP) return { ok: false, why: "刚问过模型" };
  return { ok: true };
}

/** 去问了模型（不管结果） */
export function asked(state: CoachState, key: string, now: number): CoachState {
  return { ...state, lastAskAt: now, asked: [...state.asked.slice(-200), key] };
}

/** 把建议摆到了读者面前 */
export function pushed(state: CoachState, now: number): CoachState {
  const day = dayOf(now);
  return { ...state, lastPushAt: now, day, count: state.day === day ? state.count + 1 : 1 };
}

/** 读者怎么回应的：接受了恢复原来的间隔，关掉了间隔翻倍 */
export function answered(state: CoachState, accepted: boolean): CoachState {
  return { ...state, dismissed: accepted ? 0 : Math.min(6, state.dismissed + 1), recent: [...state.recent.slice(-4), accepted ? "接受" : "关掉"] };
}

const KEY = "docagent:coach";
export function loadCoach(): CoachState {
  try {
    return { ...EMPTY, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<CoachState>) };
  } catch {
    return EMPTY;
  }
}
export function saveCoach(state: CoachState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // 存不了就只在这次打开期间管用
  }
}
