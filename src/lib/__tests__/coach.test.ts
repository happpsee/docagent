import { describe, expect, it } from "vitest";
import { answered, asked, EMPTY, gapOf, mayAsk, pushed } from "../coach";

const MIN = 60_000;
const T = Date.UTC(2026, 9, 5, 10, 0, 0);

describe("主动建议的频率", () => {
  it("关着就什么都不问", () => {
    expect(mayAsk("off", EMPTY, "d:0:done", T).ok).toBe(false);
  });

  it("两次建议至少隔 10 分钟（适中）", () => {
    const s = pushed(EMPTY, T);
    expect(mayAsk("mid", s, "d:1:done", T + 9 * MIN).ok).toBe(false);
    expect(mayAsk("mid", s, "d:1:done", T + 11 * MIN).ok).toBe(true);
  });

  it("被关掉一次间隔翻倍，接受一次恢复，最多一小时", () => {
    let s = answered(pushed(EMPTY, T), false);
    expect(gapOf("mid", s)).toBe(20 * MIN);
    expect(mayAsk("mid", s, "d:1:done", T + 15 * MIN).ok).toBe(false);
    s = answered(answered(answered(s, false), false), false);
    expect(gapOf("mid", s)).toBe(60 * MIN);
    expect(gapOf("mid", answered(s, true))).toBe(10 * MIN);
  });

  it("同一段只问一次", () => {
    const s = asked(EMPTY, "d:0:done", T);
    expect(mayAsk("mid", s, "d:0:done", T + 60 * MIN).ok).toBe(false);
    expect(mayAsk("mid", s, "d:0:stuck", T + 60 * MIN).ok).toBe(true);
  });

  it("模型说不用打断，也要歇几分钟再问它", () => {
    const s = asked(EMPTY, "d:0:done", T);
    expect(mayAsk("mid", s, "d:1:done", T + 2 * MIN).ok).toBe(false);
    expect(mayAsk("mid", s, "d:1:done", T + 5 * MIN).ok).toBe(true);
  });

  it("一天有上限，第二天重新算", () => {
    let s = EMPTY;
    for (let i = 0; i < 8; i++) s = pushed(s, T + i * 20 * MIN);
    expect(mayAsk("mid", s, "d:9:done", T + 8 * 20 * MIN).ok).toBe(false);
    expect(mayAsk("mid", s, "d:9:done", T + 24 * 60 * MIN).ok).toBe(true);
  });
});
