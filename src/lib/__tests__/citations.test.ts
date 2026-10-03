import { describe, expect, it } from "vitest";
import { citedNumbers, splitCitations } from "../citations";

describe("引用解析", () => {
  it("把 [n] 拆成可点击片段", () => {
    const parts = splitCitations("结论是甲方承担 [1]，依据见第二条 [2][3]。");
    expect(parts.filter((p) => p.type === "cite").map((p) => (p as { n: number }).n)).toEqual([1, 2, 3]);
    expect(parts[0]).toEqual({ type: "text", value: "结论是甲方承担 " });
  });

  it("没有引用时原样返回", () => {
    expect(splitCitations("纯文本")).toEqual([{ type: "text", value: "纯文本" }]);
  });

  it("不把普通中括号当引用", () => {
    expect(splitCitations("数组写法是 [abc] 这样").every((p) => p.type === "text")).toBe(true);
  });

  it("引用编号去重并排序", () => {
    expect(citedNumbers("见 [3]，另见 [1][3]。")).toEqual([1, 3]);
  });
});
