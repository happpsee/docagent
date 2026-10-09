import { describe, expect, it } from "vitest";
import { reportCurrentUnit } from "./unitNotification";

describe("阅读位置通知", () => {
  it("回调返回段落编号时，通知本身仍不返回 React 清理函数", () => {
    let reported: number | null = null;
    const result = reportCurrentUnit((unit) => (reported = unit), 2);

    expect(reported).toBe(2);
    expect(result).toBeUndefined();
  });
});
