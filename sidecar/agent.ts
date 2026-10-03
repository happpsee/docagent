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
 *   ← {type:"ask", id, question, sessionId?, docIds?, k?, cwd?}   cwd：工作文件夹
 *   ← {type:"extensions", cwd?}                      查看已发现的技能和 MCP 服务
 *   ← {type:"approval", requestId, allow, remember?}   remember：本次运行内同类操作不再问
 *   ← {type:"abort", id}
 *   → {type:"ready"}
 *   → {type:"session", id, sessionId}
 *   → {type:"delta", id, text}
 *   → {type:"tool", id, toolUseId, name, input}
 *   → {type:"tool_result", id, toolUseId, text, isError}
 *   → {type:"approval_request", id, requestId, name, input}
 *   → {type:"result", id, text, sessionId, costUsd, turns, hits}
 *   → {type:"extensions", user, project}             各含 dir、skills[]、mcp[]
 *   → {type:"error", id?, message}
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  env.PATH = loginPath();
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

/** 用户级配置目录。应用自己的名字，不读也不写 ~/.claude */
const USER_DIR = process.env.DOCAGENT_USER_DIR ?? `${process.env.HOME ?? ""}/.docagent`;
const CONFIG_DIR = process.env.DOCAGENT_CONFIG_DIR ?? "";

/** 图形界面启动的程序拿不到终端里的 PATH（找不到 node、npx、uvx、git…），
 *  这里向用户的登录 shell 问一次，Bash 工具和 MCP 服务都要用。 */
let cachedPath: string | null = null;
function loginPath(): string {
  if (cachedPath != null) return cachedPath;
  cachedPath = process.env.PATH ?? "";
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const r = Bun.spawnSync([shell, "-ilc", 'printf "__P__%s__P__" "$PATH"'], { stdout: "pipe", stderr: "ignore" });
    const m = /__P__(.*)__P__/s.exec(new TextDecoder().decode(r.stdout));
    if (m?.[1]) cachedPath = m[1];
  } catch {
    // 问不到就用现有的
  }
  return cachedPath;
}

type McpMap = Record<string, Record<string, unknown>>;

/** 读 <dir>/mcp.json。两种写法都认：{ "mcpServers": {...} } 或者直接 { 名字: 配置 } */
function readMcp(dir: string): McpMap {
  try {
    const raw = JSON.parse(readFileSync(`${dir}/mcp.json`, "utf8"));
    const map = (raw?.mcpServers ?? raw) as McpMap;
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

function listSkills(dir: string): string[] {
  try {
    return readdirSync(`${dir}/skills`, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && existsSync(`${dir}/skills/${d.name}/SKILL.md`))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** 把一个 .docagent 目录包装成 SDK 能加载的本地插件。
 *  包装目录放在应用自己的数据目录里，只是一个清单文件加一个指向 skills 的软链接，
 *  用户的 .docagent 里不需要出现任何 SDK 专用的文件。 */
function pluginFor(kind: "user" | "project", dir: string): { type: "local"; path: string; skipMcpDiscovery: true } | null {
  if (!CONFIG_DIR || !listSkills(dir).length) return null;
  const id = kind === "user" ? "user" : `project-${createHash("sha1").update(dir).digest("hex").slice(0, 10)}`;
  const root = `${CONFIG_DIR}/plugins/${id}`;
  try {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(`${root}/.claude-plugin`, { recursive: true });
    writeFileSync(
      `${root}/.claude-plugin/plugin.json`,
      JSON.stringify({ name: kind === "user" ? "user" : "folder", version: "1.0.0", description: `DocAgent ${kind} skills` }),
    );
    symlinkSync(`${dir}/skills`, `${root}/skills`);
    return { type: "local", path: root, skipMcpDiscovery: true };
  } catch (err) {
    process.stderr.write(`加载技能失败 ${dir}: ${String(err)}\n`);
    return null;
  }
}

function describeExtensions(cwd?: string) {
  const info = (dir: string) => ({ dir, skills: listSkills(dir), mcp: Object.keys(readMcp(dir)) });
  return { user: info(USER_DIR), project: cwd ? info(`${cwd}/.docagent`) : null };
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

const pendingApprovals = new Map<string, (r: { allow: boolean; remember: boolean }) => void>();
/** 本次运行里用户已经放行的范围：read:<目录>、write:<目录>、bash、web */
const granted = new Set<string>();
const aborts = new Map<string, AbortController>();
/** 每轮提问的上下文：检索范围、取几条、累积命中（给界面做引用用） */
const asks = new Map<string, { docIds?: string[]; k?: number; hits: Hit[] }>();
let currentAskId: string | null = null;
let approvalSeq = 0;

/** 向界面请求审批，等用户点同意或拒绝。没有进行中的提问时一律拒绝。 */
async function requestApproval(
  name: string,
  input: Record<string, unknown>,
  grantKey?: string,
): Promise<boolean> {
  const id = currentAskId;
  if (!id) return false;
  const requestId = `ap${++approvalSeq}`;
  send({ type: "approval_request", id, requestId, name, input, canRemember: !!grantKey });
  const r = await new Promise<{ allow: boolean; remember: boolean }>((resolve) =>
    pendingApprovals.set(requestId, resolve),
  );
  if (r.allow && r.remember && grantKey) granted.add(grantKey);
  return r.allow;
}

const HOME = process.env.HOME ?? "/";
const absPath = (p: unknown) => {
  const v = String(p ?? "").replace(/^~(?=\/|$)/, HOME);
  return v.startsWith("/") ? v : `${HOME}/${v}`;
};
/** 看起来像文件（最后一段带扩展名）就取它所在的目录 */
const dirOf = (p: string) => {
  const last = p.slice(p.lastIndexOf("/") + 1);
  return last.includes(".") ? p.slice(0, p.lastIndexOf("/")) || "/" : p.replace(/\/$/, "") || "/";
};
const under = (kind: string, path: string) =>
  [...granted].some((g) => g.startsWith(`${kind}:`) && `${path}/`.startsWith(`${g.slice(kind.length + 1)}/`));

/** 内置工具的放行规则。读本地内容和有副作用的操作都要用户点头：
 *  读——文件内容会发给模型接口；写、跑命令——会改动这台电脑。 */
async function gate(tool: string, input: Record<string, unknown>): Promise<{ allow: boolean; reason?: string }> {
  switch (tool) {
    case "TodoWrite":
    case "mcp__docagent__search_docs":
    case "mcp__docagent__save_note": // 它的审批在工具内部做
      return { allow: true };
    case "Read":
    case "Glob":
    case "Grep": {
      const target = absPath(input.file_path ?? input.path ?? HOME);
      const dir = tool === "Read" ? dirOf(target) : target.replace(/\/$/, "") || "/";
      if (under("read", target)) return { allow: true };
      const ok = await requestApproval(tool, { ...input, _dir: dir }, `read:${dir}`);
      return ok ? { allow: true } : { allow: false, reason: "用户没有允许读取这个位置" };
    }
    case "Write":
    case "Edit": {
      const target = absPath(input.file_path);
      if (under("write", target)) return { allow: true };
      const ok = await requestApproval(tool, input, `write:${dirOf(target)}`);
      return ok ? { allow: true } : { allow: false, reason: "用户拒绝了这次写入" };
    }
    case "Bash": {
      if (granted.has("bash")) return { allow: true };
      const ok = await requestApproval(tool, input, "bash");
      return ok ? { allow: true } : { allow: false, reason: "用户拒绝运行这条命令" };
    }
    case "WebFetch":
    case "WebSearch": {
      if (granted.has("web")) return { allow: true };
      const ok = await requestApproval(tool, input, "web");
      return ok ? { allow: true } : { allow: false, reason: "用户拒绝了这次联网" };
    }
    // 子代理本身不碰外部世界，它内部的每次工具调用同样会过这个 gate
    case "Task":
    case "Agent":
    case "TaskStop":
    case "ListAgents":
    case "Skill":
      return { allow: true };
    default: {
      // 没单独定规则的工具：问用户，而不是直接拒绝。
      // 外部 MCP 的工具按「服务」记住——同一个服务放行一次，它的其它工具不再问
      const mcp = /^mcp__(.+?)__/.exec(tool);
      const key = mcp ? `mcp:${mcp[1]}` : `tool:${tool}`;
      if (granted.has(key)) return { allow: true };
      const ok = await requestApproval(tool, input, key);
      return ok ? { allow: true } : { allow: false, reason: "用户没有允许使用这个工具" };
    }
  }
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

const RULES = `你运行在一个叫 DocAgent 的桌面应用里，是用户的通用助手：可以读写本地文件、运行命令、联网搜索、访问网页、派子代理，也可以检索用户导入的文档库。

关于用户导入的文档库（search_docs）：
- 问题可能和用户的资料有关时先检索。文档内容和你的常识冲突时以文档为准。
- 来自文档库的结论在句末标注编号 [1]、[2]（对应检索结果里的编号）；其它来源（你自己的知识、读到的本地文件、网页）不要用这种编号，直接说明来源。
- 不要把自身知识说成是文档里的，不要编造引用。

做事方式：
- 用户让你了解某个项目或目录时，直接去看（Bash 里用 ls / rg / find，或用 Read 读文件），不要说自己做不到。
- 需要最新信息或文档库、本地都没有的资料时，用 WebSearch 联网搜索，用 WebFetch 打开具体网页；引用网页内容时给出链接。
- 任务大、可以拆开并行时，可以用 Task 派子代理去做。
- 用户配置了技能（Skill）时，遇到匹配的任务先用对应的技能。
- 读取、写入、运行命令、联网会由应用向用户请求许可；被拒绝就换个办法或者如实说明，不要反复重试同一个操作。
- 要交付文件时：用户指定了位置就用 Write 写到那里；没指定就用 save_note。
- 用中文回答，简洁，适当使用 Markdown。`;

async function handleAsk(msg: {
  id: string;
  question: string;
  sessionId?: string;
  docIds?: string[];
  k?: number;
  cwd?: string;
}) {
  const { id, question, sessionId, docIds, k } = msg;
  const cwd = msg.cwd && existsSync(msg.cwd) ? msg.cwd : HOME;
  const projectDir = msg.cwd ? `${cwd}/.docagent` : null;
  // 用户自己选的工作文件夹：读取不用再问（写入和跑命令仍然要问）
  if (msg.cwd) granted.add(`read:${cwd}`);
  const plugins = [pluginFor("user", USER_DIR), projectDir ? pluginFor("project", projectDir) : null].filter(
    (x): x is NonNullable<typeof x> => !!x,
  );
  // 文件夹级的 MCP 配置覆盖用户级同名项；内置的文档库工具始终存在
  const externalMcp = { ...readMcp(USER_DIR), ...(projectDir ? readMcp(projectDir) : {}) };
  delete (externalMcp as McpMap).docagent;
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
        // 用 Claude Code 自带的系统提示（它知道怎么用好这些工具），后面追加本应用的规则
        systemPrompt: { type: "preset", preset: "claude_code", append: RULES },
        cwd,
        mcpServers: { ...(externalMcp as Record<string, any>), docagent: docTools },
        ...(plugins.length ? { plugins } : {}),
        // SDK 的全套内置工具（和 Claude Code 一样）：读写改文件、Bash、联网搜索、
        // 抓网页、子代理、Notebook、Skill 等。能不能用由 gate 决定，不在这里删减。
        tools: { type: "preset", preset: "claude_code" },
        includePartialMessages: true,
        maxTurns: 40,
        settingSources: [],
        env: agentEnv(),
        ...(MODEL ? { model: MODEL } : {}),
        abortController: ac,
        ...(sessionId ? { resume: sessionId } : {}),
        // 每次工具调用先过 gate。用 PreToolUse 钩子而不只靠 canUseTool：
        // 实测 canUseTool 在一些情况下不会被调用，钩子是每次必经的。
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (input: any) => {
                  const r = await gate(input.tool_name, input.tool_input ?? {});
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: r.allow ? "allow" : "deny",
                      permissionDecisionReason: r.reason ?? "已放行",
                    },
                  };
                },
              ],
            },
          ],
        },
        // 钩子已经做了决定；这里兜底，万一走到这也按同一套规则
        canUseTool: async (name: string, input: Record<string, unknown>) => {
          const r = await gate(name, input);
          return r.allow
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: r.reason ?? "已拒绝" };
        },
        stderr: (d: string) => process.stderr.write(d),
      },
    });

    for await (const m of q as AsyncIterable<any>) {
      if (m.type === "system" && m.subtype === "init") {
        session = m.session_id;
        send({ type: "session", id, sessionId: session });
      } else if (m.type === "stream_event") {
        if (m.parent_tool_use_id) continue; // 子代理的中间输出不混进主回答
        const ev = m.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          answer += ev.delta.text;
          send({ type: "delta", id, text: ev.delta.text });
        }
      } else if (m.type === "assistant") {
        for (const b of m.message?.content ?? []) {
          if (b.type === "tool_use") {
            send({ type: "tool", id, toolUseId: b.id, name: b.name, input: b.input });
          }
        }
      } else if (m.type === "user") {
        for (const b of m.message?.content ?? []) {
          if (b.type === "tool_result") {
            const text = Array.isArray(b.content)
              ? b.content.map((c: any) => c.text ?? "").join("")
              : String(b.content ?? "");
            send({
              type: "tool_result",
              id,
              toolUseId: b.tool_use_id,
              text: text.slice(0, 4000),
              isError: !!b.is_error,
            });
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
    else if (msg.type === "extensions") send({ type: "extensions", ...describeExtensions(msg.cwd) });
    else if (msg.type === "approval") {
      pendingApprovals.get(msg.requestId)?.({ allow: !!msg.allow, remember: !!msg.remember });
      pendingApprovals.delete(msg.requestId);
    } else if (msg.type === "abort") aborts.get(msg.id)?.abort();
  }
}

void main();
