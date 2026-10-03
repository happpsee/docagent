/** 流水线测试：文本 → 分块 → 向量化 → 相似度检索。
 *  不含 Tauri（数据库那段由 Rust 的测试覆盖），验证的是检索能不能真的找对内容。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkPages } from "../chunk";
import { hashEmbed } from "../provider";

const 采购合同 = `# 设备采购合同

## 第二条 交付
乙方应于合同生效后 30 个工作日内将全部设备运抵甲方指定仓库。

## 第三条 付款条款
付款分三期：合同签订后 5 个工作日内支付 30% 预付款；设备验收合格后 15 个工作日内支付 60%；质保期满后支付剩余 10% 尾款。

## 第四条 质保
质保期为验收合格之日起 24 个月。质保期内非人为损坏，乙方免费维修或更换。

## 第五条 违约责任
乙方逾期交付的，每日按合同总价的 0.05% 支付违约金。`;

/** 模拟一次检索：对所有块算向量，返回和问题最相似的那块 */
function retrieve(text: string, question: string) {
  const chunks = chunkPages([{ page: null, text }], 200, 30);
  const qv = hashEmbed(question);
  const scored = chunks.map((c) => ({
    text: c.text,
    score: hashEmbed(c.text).reduce((s, x, i) => s + x * qv[i], 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

describe("检索流水线", () => {
  it("问质保，命中质保那一段", () => {
    const top = retrieve(采购合同, "质保期多久")[0];
    expect(top.text).toContain("质保期");
    expect(top.text).toContain("24 个月");
  });

  it("问付款，命中付款条款", () => {
    const top = retrieve(采购合同, "付款怎么分期的")[0];
    expect(top.text).toContain("付款");
  });

  it("问交付时间，命中交付条款", () => {
    const top = retrieve(采购合同, "多久能交货")[0];
    expect(top.text).toMatch(/交付|工作日/);
  });

  it("无关问题的最高分明显低于相关问题", () => {
    const related = retrieve(采购合同, "质保期多久")[0].score;
    const unrelated = retrieve(采购合同, "午饭吃什么比较好")[0].score;
    expect(related).toBeGreaterThan(unrelated * 2);
  });

  it("真实 Markdown 文件能解析分块（读测试样本）", () => {
    const path = `${process.env.HOME}/Documents/docagent-test/采购合同.md`;
    const text = readFileSync(path, "utf8");
    const chunks = chunkPages([{ page: null, text }]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    // 每块都能算出合法向量
    for (const c of chunks) {
      const v = hashEmbed(c.text);
      expect(v).toHaveLength(1024);
      expect(v.every(Number.isFinite)).toBe(true);
    }
  });
});
