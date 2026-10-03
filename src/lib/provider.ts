/** 模型供应商：OpenAI 兼容的 embeddings 和 chat completions。
 *
 * 两个"无密钥也能跑"的降级模式：
 *   embedMode = "local"   —— 本地哈希向量，不联网。只能做粗粒度匹配，用于验证流程。
 *   answerMode = "extract" —— 不调大模型，直接把检索到的原文摘录出来。
 * 所有出站请求都记在 netLog 里，隐私面板直接读它。
 */
import type { Settings } from "./types";

export interface NetEntry {
  time: number;
  method: string;
  url: string;
  status: number | string;
}

const netLog: NetEntry[] = [];
const listeners = new Set<() => void>();

export function getNetLog(): NetEntry[] {
  return netLog;
}
export function onNetLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function record(method: string, url: string, status: number | string) {
  netLog.unshift({ time: Date.now(), method, url, status });
  if (netLog.length > 200) netLog.pop();
  listeners.forEach((f) => f());
}

async function post(url: string, apiKey: string, body: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    record("POST", url, "网络错误");
    throw new Error(`请求失败：${String(err)}`);
  }
  record("POST", url, res.status);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ""}`);
  }
  return res;
}

// 维度实测：256 维时无关文本的相似度底噪有 0.2，相关和无关分不开；
// 1024 维底噪降到 0.08（相关约 0.29），差 3.6 倍，足够做阈值判断。
// 再往上到 4096 能完全分开，但每个片段的向量要 16 KB，索引体积不值得。
const LOCAL_DIM = 1024;

/** 本地哈希向量：字符 n-gram 散列到固定维度后归一化。离线可用，质量有限。
 *
 * 只取 2-gram 和 3-gram：中文单字（1-gram）的共现率太高，会把任意两段文本的
 * 相似度都抬到 0.2 上下，使得"相关"和"无关"分不开（实测过）。
 * 去掉 1-gram 后排序和区分度都明显变好，但这仍然只是字面匹配，
 * 不理解语义——正式用途要走 embedMode = "api"。
 */
export function hashEmbed(text: string, dim = LOCAL_DIM): number[] {
  const v = new Float64Array(dim);
  const s = text.toLowerCase().replace(/\s+/g, " ");
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= s.length; i++) {
      const gram = s.slice(i, i + n);
      let h = 2166136261;
      for (let j = 0; j < gram.length; j++) {
        h ^= gram.charCodeAt(j);
        h = Math.imul(h, 16777619);
      }
      v[Math.abs(h) % dim] += 1 / n;
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => x / norm);
}

export async function embed(texts: string[], s: Settings): Promise<number[][]> {
  if (s.embedMode === "local" || !s.apiKey) return texts.map((t) => hashEmbed(t));
  const out: number[][] = [];
  // 按批发，避免单请求过大
  const BATCH = 32;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await post(`${s.baseUrl.replace(/\/$/, "")}/embeddings`, s.apiKey, {
      model: s.embedModel,
      input: batch,
    });
    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding));
  }
  return out;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 流式对话，逐段回调。返回完整文本。 */
export async function chatStream(
  messages: ChatMessage[],
  s: Settings,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await post(`${s.baseUrl.replace(/\/$/, "")}/chat/completions`, s.apiKey, {
    model: s.chatModel,
    messages,
    stream: true,
  });
  const reader = res.body?.getReader();
  if (!reader) throw new Error("没有响应流");
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const piece = json.choices?.[0]?.delta?.content;
        if (piece) {
          full += piece;
          onDelta(piece);
        }
      } catch {
        // 忽略无法解析的行（不同供应商会插入心跳）
      }
    }
  }
  return full;
}

/** 一次性对话，支持工具调用。用于 agent 的决策轮。 */
export async function chatWithTools(
  messages: ChatMessage[],
  tools: ToolSpec[],
  s: Settings,
): Promise<{ content: string; toolCalls: { id: string; name: string; args: Record<string, unknown> }[] }> {
  const res = await post(`${s.baseUrl.replace(/\/$/, "")}/chat/completions`, s.apiKey, {
    model: s.chatModel,
    messages,
    tools: tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
  });
  const json = (await res.json()) as {
    choices: {
      message: {
        content: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
    }[];
  };
  const msg = json.choices?.[0]?.message;
  const toolCalls = (msg?.tool_calls ?? []).map((tc) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {
      args = { _raw: tc.function.arguments };
    }
    return { id: tc.id, name: tc.function.name, args };
  });
  return { content: msg?.content ?? "", toolCalls };
}
