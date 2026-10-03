import { describe, expect, it } from "vitest";
import { hashEmbed } from "../provider";

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

describe("本地哈希向量", () => {
  it("维度固定且已归一化", () => {
    const v = hashEmbed("随便一句话");
    expect(v).toHaveLength(1024);
    expect(dot(v, v)).toBeCloseTo(1, 5);
  });

  it("同样的输入得到同样的向量", () => {
    expect(hashEmbed("合同付款条款")).toEqual(hashEmbed("合同付款条款"));
  });

  it("相近文本比无关文本更相似", () => {
    const base = hashEmbed("付款条款是货到后三十天内结清");
    const near = hashEmbed("付款条款：货到三十天结清");
    const far = hashEmbed("今天天气不错适合去爬山");
    expect(dot(base, near)).toBeGreaterThan(dot(base, far));
  });

  it("空字符串不会炸", () => {
    const v = hashEmbed("");
    expect(v).toHaveLength(1024);
    expect(v.every((x) => Number.isFinite(x))).toBe(true);
  });
});
