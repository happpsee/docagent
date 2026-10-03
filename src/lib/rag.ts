/** 检索增强问答 + 工具调用闭环。
 *
 * 流程：问题 → 向量化 → 检索 → 组装带编号的材料 → 模型回答并标注 [n] →
 * 前端把 [n] 渲染成可点击的引用。模型还可以反复调用 search_docs 补充检索，
 * 或请求 save_answer（需要用户审批）。
 */
import { search } from "./api";
import { chatStream, chatWithTools, embed, type ChatMessage, type ToolSpec } from "./provider";
import type { SearchHit, Settings, ToolCallRecord } from "./types";

const SYSTEM = `你是一个只依据给定资料回答问题的助手。

规则：
1. 只用【资料】里的内容回答。资料里没有的，直接说"资料里没有找到相关内容"，不要用常识补充，不要猜。
2. 每个结论后面标注来源编号，格式是 [1] 或 [2][3]。编号对应【资料】里的序号。
3. 回答简洁，先给结论再给依据。用中文回答。
4. 如果资料不足但你知道换个说法可能检索到，调用 search_docs 再查一次。`;

const TOOLS: ToolSpec[] = [
  {
    name: "search_docs",
    description: "在用户的本地文档库里做语义检索，返回最相关的片段。换关键词可以多次调用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索用的查询语句，可以和用户原问题不同" },
      },
      required: ["query"],
    },
  },
  {
    name: "save_answer",
    description: "把当前回答保存为本地文件。需要用户确认后才会执行。",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "建议的文件名，例如 合同对比.md" },
        content: { type: "string", description: "要写入的完整内容（Markdown）" },
      },
      required: ["filename", "content"],
    },
  },
];

export interface AskCallbacks {
  onDelta: (text: string) => void;
  onStatus: (text: string) => void;
  /** 工具调用需要审批时回调，返回 true 表示用户同意 */
  onApprove: (name: string, args: Record<string, unknown>) => Promise<boolean>;
  /** 执行已批准的写文件动作，由 UI 层实现（走文件保存对话框） */
  onSaveFile: (filename: string, content: string) => Promise<string>;
}

export interface AskResult {
  answer: string;
  sources: SearchHit[];
  toolCalls: ToolCallRecord[];
}

async function retrieve(query: string, s: Settings, docIds?: string[]): Promise<SearchHit[]> {
  const [vec] = await embed([query], s);
  return search(vec, s.topK, docIds);
}

/** 材料块按编号拼成给模型看的文本 */
function renderSources(hits: SearchHit[]): string {
  return hits
    .map((h, i) => {
      const loc = h.page ? `第 ${h.page} 页` : `第 ${h.idx + 1} 段`;
      return `[${i + 1}] 《${h.docTitle}》${loc}\n${h.text}`;
    })
    .join("\n\n");
}

/** 本地哈希向量下，L2 距离超过这个值基本等于"没命中"。
 *  归一化向量的 L2 距离 = sqrt(2-2cos)：实测相关片段约 1.19，无关片段约 1.36。
 *  走接口 embedding 时相似度分布不同，不套用这个阈值。 */
const LOCAL_NO_MATCH_DISTANCE = 1.3;

export function isRelevant(distance: number, embedMode: "api" | "local"): boolean {
  return embedMode === "api" ? true : distance < LOCAL_NO_MATCH_DISTANCE;
}

/** 摘录模式：不调大模型，直接给检索结果。无密钥时也能用。 */
function extractiveAnswer(hits: SearchHit[]): string {
  if (!hits.length) return "资料里没有找到相关内容。";
  const lines = hits.slice(0, 3).map((h, i) => {
    const loc = h.page ? `第 ${h.page} 页` : `第 ${h.idx + 1} 段`;
    const text = h.text.length > 300 ? `${h.text.slice(0, 300)}…` : h.text;
    return `${i + 1}. 《${h.docTitle}》${loc} [${i + 1}]\n${text}`;
  });
  return `（摘录模式：未调用大模型，以下是检索到的原文）\n\n${lines.join("\n\n")}`;
}

export async function ask(
  question: string,
  s: Settings,
  cb: AskCallbacks,
  docIds?: string[],
  signal?: AbortSignal,
): Promise<AskResult> {
  const toolCalls: ToolCallRecord[] = [];

  cb.onStatus("检索中…");
  let hits = (await retrieve(question, s, docIds)).filter((h) => isRelevant(h.distance, s.embedMode));

  // 摘录模式 / 没配密钥：直接返回原文，不联网调模型
  if (s.answerMode === "extract" || !s.apiKey) {
    const answer = extractiveAnswer(hits);
    cb.onDelta(answer);
    return { answer, sources: hits, toolCalls };
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `【资料】\n${renderSources(hits)}\n\n【问题】\n${question}` },
  ];

  // agent 决策轮：模型可以要求补充检索，或请求保存文件。最多 3 轮，避免打转。
  for (let round = 0; round < 3; round++) {
    cb.onStatus(round === 0 ? "思考中…" : `补充检索（第 ${round + 1} 轮）…`);
    const { content, toolCalls: calls } = await chatWithTools(messages, TOOLS, s);
    if (!calls.length) {
      if (content) {
        // 模型直接给了答案，流式补发以保持体验一致
        cb.onDelta(content);
        return { answer: content, sources: hits, toolCalls };
      }
      break;
    }

    messages.push({
      role: "assistant",
      content: content ?? "",
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    });

    for (const call of calls) {
      if (call.name === "search_docs") {
        const q = String(call.args.query ?? question);
        cb.onStatus(`检索：${q}`);
        const more = await retrieve(q, s, docIds);
        // 合并去重，保持编号稳定
        const seen = new Set(hits.map((h) => h.chunkId));
        for (const m of more) if (!seen.has(m.chunkId)) hits.push(m);
        toolCalls.push({
          name: call.name,
          args: call.args,
          status: "auto",
          result: `找到 ${more.length} 个片段`,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: more.length ? renderSources(more) : "没有找到相关内容",
        });
      } else if (call.name === "save_answer") {
        const ok = await cb.onApprove(call.name, call.args);
        if (!ok) {
          toolCalls.push({ name: call.name, args: call.args, status: "rejected" });
          messages.push({ role: "tool", tool_call_id: call.id, content: "用户拒绝了这次保存" });
          continue;
        }
        const path = await cb.onSaveFile(
          String(call.args.filename ?? "answer.md"),
          String(call.args.content ?? ""),
        );
        toolCalls.push({ name: call.name, args: call.args, status: "approved", result: path });
        messages.push({ role: "tool", tool_call_id: call.id, content: `已保存到 ${path}` });
      } else {
        messages.push({ role: "tool", tool_call_id: call.id, content: `未知工具 ${call.name}` });
      }
    }
  }

  // 最后一轮：带上全部材料，流式输出答案
  cb.onStatus("生成回答…");
  messages.push({
    role: "user",
    content: `请基于目前掌握的全部资料回答，并标注来源编号。\n\n【资料】\n${renderSources(hits)}\n\n【问题】\n${question}`,
  });
  const answer = await chatStream(messages, s, cb.onDelta, signal);
  return { answer, sources: hits, toolCalls };
}

/** 把回答里的 [n] 切成可渲染的片段 */
export function splitCitations(text: string): ({ type: "text"; value: string } | { type: "cite"; n: number })[] {
  const out: ({ type: "text"; value: string } | { type: "cite"; n: number })[] = [];
  const re = /\[(\d{1,2})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    out.push({ type: "cite", n: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}
