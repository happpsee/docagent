import { describe, expect, it } from "vitest";
import { chunkPages, splitText } from "../chunk";

describe("分块", () => {
  it("短文本不切", () => {
    expect(splitText("一句话。")).toEqual(["一句话。"]);
  });

  it("空白返回空数组", () => {
    expect(splitText("   \n\n  ")).toEqual([]);
  });

  it("超长文本按目标长度切开，每块不超过上限", () => {
    const text = "这是一个句子。".repeat(400); // 2800 字
    const parts = splitText(text, 300, 50);
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(300 * 1.5);
  });

  it("没有标点的长串也能切，不会死循环", () => {
    const parts = splitText("x".repeat(5000), 400, 40);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.join("").length).toBeGreaterThan(4000);
  });

  it("按段落优先切分，短段落会合并", () => {
    const parts = splitText("第一段。\n\n第二段。\n\n第三段。", 100);
    expect(parts).toHaveLength(1); // 都很短，合成一块
    expect(parts[0]).toContain("第三段");
  });

  it("保留页码，序号连续", () => {
    const chunks = chunkPages(
      [
        { page: 1, text: "甲".repeat(900) },
        { page: 2, text: "乙段落。" },
      ],
      400,
      40,
    );
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].page).toBe(1);
    expect(chunks.at(-1)!.page).toBe(2);
    expect(chunks.map((c) => c.idx)).toEqual(chunks.map((_, i) => i));
  });
});
