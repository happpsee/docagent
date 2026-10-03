import { describe, expect, it } from "vitest";
import { splitCitations } from "../rag";

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
    const parts = splitCitations("数组写法是 [abc] 这样");
    expect(parts.every((p) => p.type === "text")).toBe(true);
  });

  it("结尾的引用也能识别", () => {
    const parts = splitCitations("见原文 [7]");
    expect(parts.at(-1)).toEqual({ type: "cite", n: 7 });
  });
});

describe("相关性阈值", () => {
  it("本地模式下距离太大判为无关", async () => {
    const { isRelevant } = await import("../rag");
    expect(isRelevant(1.19, "local")).toBe(true);
    expect(isRelevant(1.36, "local")).toBe(false);
  });

  it("走接口 embedding 时不套用本地阈值", async () => {
    const { isRelevant } = await import("../rag");
    expect(isRelevant(1.9, "api")).toBe(true);
  });
});
