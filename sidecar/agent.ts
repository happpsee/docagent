/**
 * Agent sidecar：宿主（Rust）启动这个进程，双方用 stdin/stdout 交换 JSON 行。
 *
 * 为什么单独一个进程：Claude Agent SDK 是 JS 库，既不能在 webview（浏览器环境）跑，
 * 也不能在 Rust 里跑。agent 循环、工具调用、会话持久化全交给 SDK，
 * 这里只做两件事：把检索/保存工具接到宿主，把事件转成协议消息。
 *
 * 开发：bun run agent.ts
 * 交付：bun build --compile → 单文件可执行，不依赖系统 Node
 *
 * 协议（每行一个 JSON）
 *   ← {type:"ask", id, question, sessionId?, docIds?, k?}
 *   ← {type:"approval", requestId, allow}
 *   ← {type:"abort", id}
 *   → {type:"ready"}
 *   → {type:"session", id, sessionId}
 *   → {type:"delta", id, text}
 *   → {type:"tool", id, name, input}
 *   → {type:"tool_result", id, summary}
 *   → {type:"approval_request", id, requestId, name, input}
 *   → {type:"result", id, text, sessionId, costUsd, turns, hits}
 *   → {type:"error", id?, message}
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const HOST_API = process.env.DOCAGENT_API ?? "";
const HOST_TOKEN = process.env.DOCAGENT_TOKEN ?? "";

/** 模型供应商配置由宿主通过环境变量传入（来自 app 自己的设置），
 *  不读用户的 ~/.claude，也不继承宿主进程里的 ANTHROPIC_* / CLAUDE_CODE_*。 */
const MODEL = process.env.DOCAGENT_MODEL ?? "";
function agentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (k.startsWith("CLAUDE_CODE_") || k.startsWith("ANTHROPIC_") || k.startsWith("DOCAGENT_")) continue;
    env[k] = v;
  }
  if (process.env.DOCAGENT_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.DOCAGENT_BASE_URL;
  if (process.env.DOCAGENT_API_KEY) env.ANTHROPIC_AUTH_TOKEN = process.env.DOCAGENT_API_KEY;
  if (process.env.DOCAGENT_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.DOCAGENT_CONFIG_DIR;
  if (MODEL) {
    // 后台的小模型调用也指到同一个模型，避免请求供应商不认识的模型名
    env.ANTHROPIC_MODEL = MODEL;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = MODEL;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = MODEL;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = MODEL;
  }
  return env;
}

interface Hit {
  docId?: string;
  docTitle: string;
  page: number | null;
  text: string;
  distance?: number;
  chunkId?: number;
}

function send(obj: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const pendingApprovals = new Map<string, (ok: boolean) => void>();
const aborts = new Map<string, AbortController>();
/** 每轮提问的上下文：检索范围、取几条、累积命中（给界面做引用用） */
const asks = new Map<string, { docIds?: string[]; k?: number; hits: Hit[] }>();
let currentAskId: string | null = null;
let approvalSeq = 0;

/** 向界面请求审批，等用户点同意或拒绝。没有进行中的提问时一律拒绝。 */
function requestApproval(name: string, input: Record<string, unknown>): Promise<boolean> {
  const id = currentAskId;
  if (!id) return Promise.resolve(false);
  const requestId = `ap${++approvalSeq}`;
  send({ type: "approval_request", id, requestId, name, input });
  return new Promise<boolean>((resolve) => pendingApprovals.set(requestId, resolve));
}

async function hostFetch(path: string, body: unknown) {
  if (!HOST_API) throw new Error("未连接宿主");
  const res = await fetch(`${HOST_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${HOST_TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} 返回 ${res.status}`);
  return res.json();
}

async function searchDocs(q: string, docIds?: string[], k?: number): Promise<Hit[]> {
  if (!HOST_API) {
    // 未接宿主时的占位，便于单独测 sidecar
    return [
      { docTitle: "占位文档", page: 1, text: `（未连接索引）检索词：${q}`, distance: 0.5 },
    ];
  }
  const out = (await hostFetch("/search", { query: q, docIds: docIds ?? null, k: k ?? 6 })) as {
    hits: Hit[];
  };
  return out.hits;
}

/** numbers[i] 是 hits[i] 在本轮提问里的全局编号 */
function renderHits(hits: Hit[], numbers: number[]): string {
  if (!hits.length) return "没有找到相关内容。";
  return hits
    .map((h, i) => {
      const loc = h.page ? `第 ${h.page} 页` : "正文";
      return `[${numbers[i]}] 《${h.docTitle}》${loc}\n${h.text}`;
    })
    .join("\n\n");
}

/** 检索和保存做成 SDK 的进程内 MCP 工具：参数校验、分发、错误处理都由 SDK 管 */
const docTools = createSdkMcpServer({
  name: "docagent",
  version: "0.1.0",
  tools: [
    tool(
      "search_docs",
      "在用户导入的本地文档里做语义检索，返回最相关的片段。可以换关键词多次调用。",
      { query: z.string().describe("检索语句，可与用户原问题不同") },
      async ({ query: q }) => {
        const ctx = currentAskId ? asks.get(currentAskId) : undefined;
        const hits = await searchDocs(q, ctx?.docIds, ctx?.k);
        // 累积到本轮上下文并分配全局编号：模型多次检索时 [n] 不会撞号，
        // 界面用同一份列表把 [n] 映射回原文位置
        const all = ctx?.hits ?? [];
        const numbers = hits.map((h) => {
          const key = h.chunkId ?? h.text;
          let at = all.findIndex((x) => (x.chunkId ?? x.text) === key);
          if (at < 0) {
            all.push(h);
            at = all.length - 1;
          }
          return at + 1;
        });
        return { content: [{ type: "text", text: renderHits(hits, numbers) }] };
      },
    ),
    tool(
      "save_note",
      "把内容保存成本地文件。会先征求用户同意。",
      { filename: z.string().describe("文件名，如 合同要点.md"), content: z.string() },
      async ({ filename, content }) => {
        // 审批放在这里而不是交给 SDK 的 canUseTool：端到端测试发现进程内 MCP 工具
        // 不会触发 canUseTool，写文件会直接执行。闸门紧贴副作用才绕不过去。
        const allow = await requestApproval("save_note", { filename, content });
        if (!allow) {
          return { content: [{ type: "text", text: "用户拒绝了这次保存，文件没有写入。" }], isError: true };
        }
        const out = (await hostFetch("/save", { filename, content })) as { path: string };
        return { content: [{ type: "text", text: `已保存到 ${out.path}` }] };
      },
    ),
  ],
});

const SYSTEM = `你是本地文档问答助手。只能依据 search_docs 返回的资料回答。

规则：
1. 回答前先调用 search_docs 检索。结果不够就换个说法再检索，一个问题最多检索 3 次。
2. 只用检索到的内容回答。资料里没有的，直接说"资料里没有找到相关内容"，不要用常识补充，不要猜。
3. 每个结论后标注来源编号 [1]、[2]，编号对应检索结果里的序号。没找到内容时不要标编号。
4. 中文回答，先结论后依据，简洁。`;

async function handleAsk(msg: {
  id: string;
  question: string;
  sessionId?: string;
  docIds?: string[];
  k?: number;
}) {
  const { id, question, sessionId, docIds, k } = msg;
  asks.set(id, { docIds, k, hits: [] });
  currentAskId = id;
  const ac = new AbortController();
  aborts.set(id, ac);
  let answer = "";
  let session = sessionId ?? null;

  try {
    const q = query({
      prompt: question,
      options: {
        systemPrompt: { type: "custom", prompt: SYSTEM },
        mcpServers: { docagent: docTools },
        // 只自动放行只读的检索。save_note 故意不写在这里：
        // SDK 对 allowedTools 里的裸工具名直接放行，不会调 canUseTool（它自己会警告），
        // 所以要审批的工具必须不在这个列表里。
        allowedTools: ["mcp__docagent__search_docs"],
        tools: [],
        includePartialMessages: true,
        maxTurns: 8,
        settingSources: [],
        env: agentEnv(),
        ...(MODEL ? { model: MODEL } : {}),
        abortController: ac,
        ...(sessionId ? { resume: sessionId } : {}),
        // 白名单之外的工具一律拒绝。save_note 的用户审批在工具内部做（见上）。
        canUseTool: async (name, input) =>
          name === "mcp__docagent__search_docs" || name === "mcp__docagent__save_note"
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "这个工具没有启用" },
        stderr: (d) => process.stderr.write(d),
      },
    });

    for await (const m of q as AsyncIterable<any>) {
      if (m.type === "system" && m.subtype === "init") {
        session = m.session_id;
        send({ type: "session", id, sessionId: session });
      } else if (m.type === "stream_event") {
        const ev = m.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          answer += ev.delta.text;
          send({ type: "delta", id, text: ev.delta.text });
        }
      } else if (m.type === "assistant") {
        for (const b of m.message?.content ?? []) {
          if (b.type === "tool_use") send({ type: "tool", id, name: b.name, input: b.input });
        }
      } else if (m.type === "user") {
        for (const b of m.message?.content ?? []) {
          if (b.type === "tool_result") {
            const text = Array.isArray(b.content)
              ? b.content.map((c: any) => c.text ?? "").join("")
              : String(b.content ?? "");
            send({ type: "tool_result", id, summary: text.slice(0, 160) });
          }
        }
      } else if (m.type === "result" && m.subtype !== "success") {
        send({
          type: "error",
          id,
          message: `模型返回失败：${m.subtype}${m.result ? ` — ${m.result}` : ""}`,
          raw: m,
        });
      } else if (m.type === "result") {
        send({
          type: "result",
          id,
          text: m.subtype === "success" ? (m.result ?? answer) : answer,
          sessionId: m.session_id ?? session,
          costUsd: m.total_cost_usd ?? null,
          turns: m.num_turns ?? null,
          hits: asks.get(id)?.hits ?? [],
        });
      }
    }
  } catch (err) {
    send({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    asks.delete(id);
    aborts.delete(id);
    if (currentAskId === id) currentAskId = null;
  }
}

// 编译成单文件时不允许顶层 await，所以放进 main
async function main() {
  send({ type: "ready" });

  // Bun 里 console 是 stdin 的异步行迭代器
  for await (const line of console) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try {
      msg = JSON.parse(t);
    } catch {
      send({ type: "error", message: "非法 JSON" });
      continue;
    }
    if (msg.type === "ask") void handleAsk(msg);
    else if (msg.type === "approval") {
      pendingApprovals.get(msg.requestId)?.(!!msg.allow);
      pendingApprovals.delete(msg.requestId);
    } else if (msg.type === "abort") aborts.get(msg.id)?.abort();
  }
}

void main();
