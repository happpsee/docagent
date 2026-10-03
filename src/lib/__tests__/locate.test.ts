import { describe, expect, it } from "vitest";
import { locate } from "../citations";

describe("在全文里定位引文", () => {
  const text = "## 第三条 付款条款\n服务费为每年 96000 元，按季度支付。\n\n甲方逾期支付超过 15 日的，乙方有权暂停服务。";

  it("原样能找到", () => {
    const [at, len] = locate(text, "服务费为每年 96000 元");
    expect(text.slice(at, at + len)).toBe("服务费为每年 96000 元");
  });

  it("换行和空格不一致也能找到，并还原成原文里的区间", () => {
    const [at, len] = locate(text, "按季度支付。 甲方逾期支付超过15日的");
    expect(text.slice(at, at + len)).toBe("按季度支付。\n\n甲方逾期支付超过 15 日的");
  });

  it("找不到返回 -1", () => {
    expect(locate(text, "不存在的句子")[0]).toBe(-1);
    expect(locate(text, undefined)[0]).toBe(-1);
  });
});
