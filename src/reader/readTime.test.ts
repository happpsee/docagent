import { describe, expect, it } from "vitest";
import { cellsOf, isRead, needOf } from "./readTime";
import type { QuizUnit } from "@/lib/types";

const unit = (chars: number): QuizUnit => ({ unit: 0, page: null, start: 0, end: 0.5, quizzed: false, mastery: null, chars });

describe("这一段读过了没有", () => {
  it("4000 字的一段：分 5 格，至少要停留 200 秒", () => {
    expect(cellsOf(unit(4000))).toBe(5);
    expect(needOf(unit(4000))).toBe(200);
  });
  it("一路滑到底不算：每格只停了两秒", () => {
    expect(isRead(unit(4000), [2, 2, 2, 2, 2])).toBe(false);
  });
  it("只在开头停了很久、后面没看也不算", () => {
    expect(isRead(unit(4000), [300, 0, 0, 0, 0])).toBe(false);
  });
  it("各部分都停留过、总时间够：算读过", () => {
    expect(isRead(unit(4000), [60, 50, 40, 50, 0])).toBe(true);
  });
  it("很短的一段：只有一格，也至少要半分钟", () => {
    expect(isRead(unit(300), [20])).toBe(false);
    expect(isRead(unit(300), [32])).toBe(true);
  });
  it("没记录过就是没读", () => {
    expect(isRead(unit(4000), undefined)).toBe(false);
  });
});
