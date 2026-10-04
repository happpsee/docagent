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
 *   ← {type:"ask", id, question, sessionId?, docIds?, k?, cwd?, book?, reading?}
 *        cwd：工作文件夹；docIds：这一问的检索范围（不给就是整个书架）
 *        book：这段对话关联的那本书（不一定是阅读器里开着的那本）
 *              {id, title, scopeLabel, parts?}
 *              scopeLabel：检索范围给模型看的说法，原样拼进提示（「《书名》」「整个书架」…）
 *              parts：[{n, docId, name, kind, opened}]，n 从 1 开始；只在一段对话的第一问带，最多 60 篇
 *        reading：阅读器里正开着的那一篇和位置
 *              {docId, bookId, bookTitle, docTitle, kind, part, partCount, page, chapter, fraction, spoilerFree}
 *              一本书可以有多篇（一篇 = 磁盘上一个文件）。part / partCount：正开着的是第几篇（从 1 开始）/ 共几篇；
 *              docTitle：这一篇显示用的名字（单篇是书名，多篇是「书名 · 篇名」）；
 *              page：PDF、漫画的页码 / 电子书的第几节；fraction：读到「这一篇」的几分之几，不是全书的
 *   ← {type:"extensions", cwd?}                      查看已发现的技能和 MCP 服务
 *   ← {type:"approval", requestId, allow, remember?}   remember：本次运行内同类操作不再问
 *   ← {type:"abort", id}
 *   ← {type:"reader_result", callId, ok, message}    界面做完阅读器动作后的回执
 *   → {type:"ready"}
 *   → {type:"session", id, sessionId}
 *   → {type:"delta", id, text}
 *   → {type:"tool", id, toolUseId, name, input}
 *   → {type:"tool_result", id, toolUseId, text, isError}
 *   → {type:"approval_request", id, requestId, name, input, canRemember, rememberLabel?}
 *   → {type:"reader_action", id, callId, action, docId, quote, page, note?, color?}   让界面在阅读器里划线 / 跳转
 *        action："highlight" | "goto"。docId：要操作的那一篇，已经解析好，不一定是正开着的（没开着界面要先打开）；
 *        page：到哪一页 / 哪一节去找 quote 的提示，没有是 null；goto 不带 quote 时就是翻到这一页，两个都没有是翻到这一篇的开头
 *   → {type:"result", id, text, sessionId, tokens, turns, hits}
 *   → {type:"extensions", user, project}             各含 dir、skills[]、mcp[]
 *   → {type:"error", id?, message}
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
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
  /** 检索时这一篇属于哪本书 */
  bookId?: string;
  /** 显示用的名字：单篇的书是书名，多篇的是「书名 · 篇名」 */
  docTitle: string;
  /** 这一篇的格式，决定说「页」还是「节」。老数据里的命中没有 */
  docKind?: string;
  page: number | null;
  text: string;
  distance?: number;
  chunkId?: number;
}

function send(obj: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const HOME = process.env.HOME ?? "/";

/** 书里的一篇：磁盘上的一个文件。n 是它在书里排第几（从 1 开始），也就是工具参数里的 part */
interface Part {
  n: number;
  docId: string;
  name: string;
  kind: string;
  /** 用户打开过这一篇 */
  opened: boolean;
}

/** 这段对话关联的那本书。和阅读器里开着的那本是两回事：用户可以聊着这本、开着另一本 */
interface Book {
  id: string;
  title: string;
  /** 这一问的检索范围，界面拼好的说法（「《书名》」「整个书架」…），原样给模型看 */
  scopeLabel: string;
  /** 分篇列表。一长串没必要每问都重复，界面只在一段对话的第一问带，最多 60 篇 */
  parts?: Part[];
}

/** 用户在阅读器里的位置，随提问一起送过来 */
interface Reading {
  docId: string;
  bookId: string;
  bookTitle: string;
  /** 正开着的这一篇显示用的名字：单篇的书是书名，多篇的是「书名 · 篇名」 */
  docTitle: string;
  /** 这一篇的格式（pdf、epub、md…），决定说「页」还是「节」；不知道是空串 */
  kind: string;
  /** 正开着的是书里的第几篇（从 1 开始）、这本书一共几篇；单篇的书是 1 / 1 */
  part: number;
  partCount: number;
  /** PDF、漫画的页码 / 电子书的第几节；其它格式没有 */
  page: number | null;
  chapter: string;
  /** 读到「这一篇」的几分之几，不是全书的 */
  fraction: number;
  /** 防剧透：只能用读过的部分回答。拦不拦由宿主按书判断，这里只用来跟模型把话说清楚 */
  spoilerFree: boolean;
}

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);

/** 界面送来的 reading：补齐缺的字段，把数字收进合法范围。
 *  宿主接口对请求体是严格校验的（缺字段、多字段都拒），这里不收拾好，
 *  一个 undefined 的 fraction 就会让检索整个失败。 */
function readingOf(raw: any): Reading | undefined {
  if (!raw || typeof raw.docId !== "string" || !raw.docId) return undefined;
  const docTitle = String(raw.docTitle || raw.bookTitle || "");
  const partCount = Math.max(int(raw.partCount), 1);
  return {
    docId: raw.docId,
    bookId: typeof raw.bookId === "string" ? raw.bookId : "",
    bookTitle: String(raw.bookTitle || docTitle),
    docTitle,
    kind: typeof raw.kind === "string" ? raw.kind.toLowerCase() : "",
    part: Math.min(Math.max(int(raw.part), 1), partCount),
    partCount,
    page: int(raw.page) > 0 ? int(raw.page) : null,
    chapter: String(raw.chapter ?? "").trim(),
    fraction: Math.min(Math.max(Number(raw.fraction) || 0, 0), 1),
    spoilerFree: !!raw.spoilerFree,
  };
}

function bookOf(raw: any): Book | undefined {
  if (!raw || typeof raw.id !== "string" || !raw.id) return undefined;
  const parts: Part[] = (Array.isArray(raw.parts) ? raw.parts : [])
    .filter((p: any) => p && int(p.n) > 0 && typeof p.docId === "string" && p.docId)
    .map((p: any) => ({
      n: int(p.n),
      docId: p.docId,
      name: String(p.name ?? ""),
      kind: String(p.kind ?? "").toLowerCase(),
      opened: !!p.opened,
    }));
  return {
    id: raw.id,
    title: String(raw.title ?? ""),
    scopeLabel: String(raw.scopeLabel ?? "").trim(),
    ...(parts.length ? { parts } : {}),
  };
}

/** 每本书最近一次送来的分篇列表。界面只在一段对话的第一问带它，
 *  但模型后面几问还会照着那份列表说「读第 5 篇」，所以得记着，否则 part 只有第一问能用。 */
const partsByBook = new Map<string, Part[]>();

const SEP = " · ";
/** 正开着的这一篇的篇名：docTitle 是「书名 · 篇名」，把书名那一截去掉 */
function partName(r: Reading): string {
  const prefix = `${r.bookTitle}${SEP}`;
  return r.docTitle.startsWith(prefix) ? r.docTitle.slice(prefix.length) : r.docTitle;
}
/** 正开着的这一篇显示用的名字。不直接用 docTitle：界面只送了篇名来的话也能拼对 */
const titleOf = (r: Reading) => (r.partCount > 1 ? `${r.bookTitle}${SEP}${partName(r)}` : r.bookTitle);

/** 一轮提问的上下文。工具、闸门、审批都挂在它上面，而不是用全局的「当前提问」——
 *  上一轮收尾和下一轮开始可能交叠，全局变量会让上一轮的工具调用串到新一轮里。 */
interface Ask {
  id: string;
  cwd: string;
  docIds?: string[];
  k?: number;
  /** 累积的检索命中，界面用它把 [n] 映射回原文；工具的 ref 也是按它找回是哪一篇 */
  hits: Hit[];
  book?: Book;
  /** 关联的那本书的分篇列表：这一问带了就用这一问的，没带用之前记下的 */
  parts?: Part[];
  reading?: Reading;
  /** 关于读者本人的几句话（背景、偏好、易错点），界面从「我的画像」里取来 */
  profile?: string;
  /** 这一轮发出去、还没答复的审批 */
  approvals: Set<string>;
  /** 同一次工具调用只问一次：钩子和 canUseTool 都会来问，按调用 id 记住结论 */
  decided: Map<string, Promise<Verdict>>;
  ended: boolean;
}
type Verdict = { allow: boolean; reason?: string };

const pendingApprovals = new Map<string, (r: { allow: boolean; remember: boolean }) => void>();
const pendingReader = new Map<string, (r: { ok: boolean; message: string }) => void>();
/** 本次运行里用户已经放行的范围：read:<目录>、write:<目录>、bash:<命令>、web、mcp:<服务> */
const granted = new Set<string>();
let grantedFor: string | null = null;
const aborts = new Map<string, AbortController>();
let seq = 0;

/** 向界面请求审批，等用户点同意或拒绝。grantKey：用户选「记住」时放行的范围 */
async function requestApproval(
  ask: Ask,
  name: string,
  input: Record<string, unknown>,
  grantKey?: string,
  rememberLabel?: string,
): Promise<boolean> {
  if (ask.ended) return false;
  const requestId = `ap${++seq}`;
  ask.approvals.add(requestId);
  send({ type: "approval_request", id: ask.id, requestId, name, input, canRemember: !!grantKey, rememberLabel });
  const r = await new Promise<{ allow: boolean; remember: boolean }>((resolve) =>
    pendingApprovals.set(requestId, resolve),
  );
  ask.approvals.delete(requestId);
  // 提问已经结束（被停止或出错）之后才点的同意不算数
  if (ask.ended) return false;
  if (r.allow && r.remember && grantKey) granted.add(grantKey);
  return r.allow;
}

/** 提问结束时，把它还挂着的审批全部按拒绝处理，免得界面上一张旧卡片晚点被点了还生效 */
function endAsk(ask: Ask) {
  ask.ended = true;
  for (const requestId of ask.approvals) {
    pendingApprovals.get(requestId)?.({ allow: false, remember: false });
    pendingApprovals.delete(requestId);
  }
  ask.approvals.clear();
}

// ---------- 路径 ----------

/** 把工具给的路径变成真实的绝对路径：展开 ~、按工作目录补全相对路径、消掉 ..、解开软链接。
 *  只做字符串比较的话，「已授权目录/../.ssh/id_rsa」和指到外面的软链接都能混过去。 */
function realPath(p: unknown, cwd: string): string {
  const abs = resolvePath(cwd, String(p ?? "").replace(/^~(?=\/|$)/, HOME));
  // 文件可能还不存在（要新建的）：对最近的已存在的上级目录取真实路径，再把剩下的拼回去
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const inside = (path: string, dir: string) => path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);
const covered = (kind: string, path: string) =>
  [...granted].some((g) => g.startsWith(`${kind}:`) && inside(path, g.slice(kind.length + 1)));

const REAL_HOME = realPath(HOME, "/");
/** Claude Code 自己的配置目录：里面有用户的登录凭据和别的项目的会话，这个应用永远不碰 */
const CLAUDE_HOME = `${REAL_HOME}/.claude`;
const touchesClaudeHome = (command: string) =>
  [`~/.claude`, `$HOME/.claude`, "${HOME}/.claude", `${HOME}/.claude`, CLAUDE_HOME].some((p) => command.includes(p));

/** 范围太大或太敏感的目录不提供「记住」：整个用户目录、根目录、隐藏目录（.ssh、.config…） */
const tooBroad = (dir: string) =>
  dir === REAL_HOME || dir === "/" || !inside(dir, REAL_HOME) || dir.split("/").some((seg) => seg.startsWith("."));

const shown = (p: string) => (inside(p, REAL_HOME) ? `~${p.slice(REAL_HOME.length)}` : p);

/** Glob 的 pattern 本身可以带目录（甚至是绝对路径或 ../），真正被扫的是通配符之前的那一段 */
function globBase(input: Record<string, unknown>, cwd: string): string {
  const base = realPath(input.path ?? cwd, cwd);
  const pattern = String(input.pattern ?? "");
  const fixed = pattern.split(/[*?[{]/)[0];
  if (!fixed.includes("/")) return base;
  return realPath(fixed.slice(0, fixed.lastIndexOf("/") + 1), base);
}

// ---------- 闸门 ----------

/** 这些工具不碰外部世界：计划清单、子代理（它内部的每次工具调用照样过闸门）、技能 */
const FREE = new Set([
  "TodoWrite",
  "Task",
  "Agent",
  "TaskStop",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "ListAgents",
  "Skill",
  "mcp__docagent__search_docs",
  "mcp__docagent__list_notes",
  "mcp__docagent__read_section",
  "mcp__docagent__show_in_reader",
  // 下面两个的审批在工具内部做
  "mcp__docagent__save_note",
  "mcp__docagent__highlight",
]);

/** 这个应用里用不上、或者界面接不住的内置工具，直接不给模型 */
const UNUSED_TOOLS = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "EnterWorktree",
  "ExitWorktree",
  "Workflow",
  "Monitor",
  "PushNotification",
  "Artifact",
  "SendFeedback",
  "ReportFindings",
];

/** 内置工具的放行规则。读本地内容和有副作用的操作都要用户点头：
 *  读——文件内容会发给模型接口；写、跑命令——会改动这台电脑。 */
async function gate(ask: Ask, tool: string, input: Record<string, unknown>): Promise<Verdict> {
  if (FREE.has(tool)) return { allow: true };
  const { cwd } = ask;
  switch (tool) {
    case "Read":
    case "Glob":
    case "Grep": {
      // 不给路径时这几个工具默认在工作目录里找
      const target =
        tool === "Glob" ? globBase(input, cwd) : realPath(input.file_path ?? input.path ?? cwd, cwd);
      if (inside(target, CLAUDE_HOME)) return { allow: false, reason: "这个应用不读取 ~/.claude" };
      if (covered("read", target)) return { allow: true };
      const dir = isDir(target) ? target : dirname(target);
      const ok = tooBroad(dir)
        ? await requestApproval(ask, tool, { ...input, _dir: tool === "Read" ? target : dir })
        : await requestApproval(ask, tool, { ...input, _dir: dir }, `read:${dir}`, `以后读取 ${shown(dir)} 里的内容不再问`);
      return ok ? { allow: true } : { allow: false, reason: "用户没有允许读取这个位置" };
    }
    case "Write":
    case "Edit":
    case "NotebookEdit": {
      const target = realPath(input.file_path ?? input.notebook_path, cwd);
      if (inside(target, CLAUDE_HOME)) return { allow: false, reason: "这个应用不改动 ~/.claude" };
      if (covered("write", target)) return { allow: true };
      const dir = dirname(target);
      const ok = tooBroad(dir)
        ? await requestApproval(ask, tool, input)
        : await requestApproval(ask, tool, input, `write:${dir}`, `以后写入 ${shown(dir)} 里的文件不再问`);
      return ok ? { allow: true } : { allow: false, reason: "用户拒绝了这次写入" };
    }
    case "Bash": {
      const command = String(input.command ?? "");
      if (touchesClaudeHome(command)) return { allow: false, reason: "这个应用不碰 ~/.claude" };
      // 命令能做任何事，所以「记住」只记这一条一模一样的命令，不是整类放行
      const key = `bash:${command}`;
      if (granted.has(key)) return { allow: true };
      const ok = await requestApproval(ask, tool, input, key, "以后这条一模一样的命令不再问");
      return ok ? { allow: true } : { allow: false, reason: "用户拒绝运行这条命令" };
    }
    case "WebFetch":
    case "WebSearch": {
      if (granted.has("web")) return { allow: true };
      const ok = await requestApproval(ask, tool, input, "web", "本次运行里联网不再问");
      return ok ? { allow: true } : { allow: false, reason: "用户拒绝了这次联网" };
    }
    default: {
      // 没单独定规则的工具：问用户，而不是直接拒绝。
      // 外部 MCP 的工具按「服务」记住——同一个服务放行一次，它的其它工具不再问
      const mcp = /^mcp__(.+?)__/.exec(tool);
      const key = mcp ? `mcp:${mcp[1]}` : `tool:${tool}`;
      if (granted.has(key)) return { allow: true };
      const ok = await requestApproval(ask, tool, input, key, mcp ? `以后「${mcp[1]}」这个服务的工具不再问` : `以后「${tool}」不再问`);
      return ok ? { allow: true } : { allow: false, reason: "用户没有允许使用这个工具" };
    }
  }
}

/** 同一次工具调用，钩子和 canUseTool 可能各来问一遍；只让用户看到一张审批卡片 */
function gateOnce(ask: Ask, toolUseId: string | undefined, tool: string, input: Record<string, unknown>) {
  if (!toolUseId) return gate(ask, tool, input);
  let verdict = ask.decided.get(toolUseId);
  if (!verdict) {
    verdict = gate(ask, tool, input);
    ask.decided.set(toolUseId, verdict);
  }
  return verdict;
}

// ---------- 文件夹里带来的技能和 MCP 服务 ----------

const TRUST_FILE = CONFIG_DIR ? `${CONFIG_DIR}/trusted-folders.json` : "";
function loadTrusted(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(TRUST_FILE, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

/** 文件夹里的 .docagent 有没有东西、内容是什么。内容一变指纹就变，要重新确认 */
function folderExtensions(dir: string): { fingerprint: string; mcp: McpMap; skills: string[] } | null {
  const mcp = readMcp(dir);
  const skills = listSkills(dir);
  if (!Object.keys(mcp).length && !skills.length) return null;
  const h = createHash("sha256").update(dir).update(JSON.stringify(mcp));
  for (const name of skills) {
    try {
      h.update(name).update(readFileSync(`${dir}/skills/${name}/SKILL.md`));
    } catch {
      // 读不到就只算名字
    }
  }
  return { fingerprint: h.digest("hex"), mcp, skills };
}

/** 工作文件夹里的 mcp.json 就是「打开这个文件夹就运行这些命令」，技能则是塞给模型的指令。
 *  文件夹可能是下载来的，所以第一次见到（或内容变了）要用户确认；用户自己目录下的不用。 */
async function trustedProject(ask: Ask, projectDir: string) {
  const ext = folderExtensions(projectDir);
  if (!ext) return null;
  const trusted = loadTrusted();
  if (trusted.has(ext.fingerprint)) return ext;
  const commands = Object.entries(ext.mcp).map(
    ([name, c]) => `${name}：${c.command ? [c.command, ...((c.args as string[]) ?? [])].join(" ") : String(c.url ?? "")}`,
  );
  const requestSeq = seq + 1;
  const ok = await requestApproval(ask, "TrustFolder", { dir: projectDir, commands, skills: ext.skills });
  // 这张卡片不对应任何工具调用，自己补一条结果，界面上才不会一直显示「进行中」
  send({
    type: "tool_result",
    id: ask.id,
    toolUseId: `ap${requestSeq}`,
    text: ok ? "已信任这个文件夹的配置" : "没有加载这个文件夹的配置",
    isError: false,
  });
  if (!ok) return null;
  trusted.add(ext.fingerprint);
  try {
    writeFileSync(TRUST_FILE, JSON.stringify([...trusted]));
  } catch {
    // 存不下来就下次再问
  }
  return ext;
}

// ---------- 宿主接口 ----------

async function hostFetch(path: string, body: unknown) {
  if (!HOST_API) throw new Error("未连接宿主");
  const res = await fetch(`${HOST_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${HOST_TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${path} 返回 ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

/** 阅读器此刻的位置，交给宿主算「读到哪了」：读到过的最远处存在库里，
 *  但正开着的这一篇可能刚往后翻了几页还没存。哪本书开了防剧透由宿主自己判断，
 *  所以只要开着书就带上，不看 spoilerFree。 */
const liveOf = (r?: Reading) => (r ? { docId: r.docId, page: r.page, fraction: r.fraction } : null);

/** bounded：范围里有书开着防剧透，这次只搜了用户读过的部分。
 *  由宿主说了算——阅读器关着、或者开的是别的书时，界线照样在起作用，光看 reading 是看不出来的 */
async function searchDocs(
  q: string,
  docIds?: string[],
  k?: number,
  reading?: Reading,
): Promise<{ hits: Hit[]; bounded: boolean }> {
  if (!HOST_API) {
    // 未接宿主时的占位，便于单独测 sidecar
    return { hits: [{ docTitle: "占位文档", page: 1, text: `（未连接索引）检索词：${q}`, distance: 0.5 }], bounded: false };
  }
  const out = (await hostFetch("/search", { query: q, docIds: docIds ?? null, k: k ?? 6, live: liveOf(reading) })) as {
    hits: Hit[];
    bounded?: boolean;
  };
  return { hits: out.hits, bounded: !!out.bounded };
}

/** 电子书的 page 存的是第几节，只有 PDF 和漫画是真页码。
 *  kind 是这一篇的格式。老数据里的命中没有它，才退回去看标题是不是以 .pdf 结尾——
 *  现在的标题是书名，不带扩展名，那个判断只对老数据还管用。 */
function where(kind: string | undefined, docTitle: string, page: number | null): string {
  if (!page) return "正文";
  const paged = kind ? kind === "pdf" || kind === "cbz" : /\.pdf$/i.test(docTitle);
  return paged ? `第 ${page} 页` : `第 ${page} 节`;
}

/** numbers[i] 是 hits[i] 在本轮提问里的全局编号 */
function renderHits(hits: Hit[], numbers: number[]): string {
  return hits
    .map((h, i) => `[${numbers[i]}] 《${h.docTitle}》${where(h.docKind, h.docTitle, h.page)}\n${h.text}`)
    .join("\n\n");
}

/** 没搜到时把搜的范围说出来：范围是用户在界面上选的，不说的话模型会把
 *  「这本书里没有」讲成「你的资料里没有」。 */
function nothingFound(ask: Ask, bounded: boolean): string {
  const scope = ask.book?.scopeLabel || (ask.docIds?.length ? "用户限定的范围" : "整个书架");
  return `在${scope}里没有找到相关内容。${bounded ? UNREAD_NOTE : ""}`;
}

/** 防剧透挡掉了一部分内容时附在检索结果后面的话：不说的话，模型搜不到后文会当成「书里没写」，
 *  或者拿自己的知识去补 */
const UNREAD_NOTE = "（范围里有开着防剧透的书，只搜了用户读过的部分；没搜到的可能在后面还没读到的地方，不要说成书里没有，也不要用自己的知识补后面的内容。）";

const NO_REPLY = "阅读器没有响应";

/** 让界面在阅读器里做一件事（划线、跳转），等它做完回话 */
async function readerAction(ask: Ask, action: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  const callId = `rd${++seq}`;
  send({ type: "reader_action", id: ask.id, callId, ...action });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingReader.delete(callId);
      resolve({ ok: false, message: NO_REPLY });
    }, 30_000);
    pendingReader.set(callId, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });
const NO_BOOK =
  "用户现在没有在阅读器里打开书。可以先用 search_docs 找到内容（highlight、show_in_reader 带上那条结果的 ref 就能落到它所在的那一篇），或者请用户打开那本书。";

/** 工具要操作的那一篇 */
interface Target {
  docId: string;
  /** 显示用的名字 */
  title: string;
  kind?: string;
  /** 到哪一页 / 哪一节去找的提示 */
  page: number | null;
  /** 来自检索结果时，那条结果的原文 */
  text?: string;
}

/** 正开着的那本书的分篇列表。手上只有「对话关联的那本书」的列表，所以开着的得是同一本；
 *  列表和阅读器对不上（之后排过序、删过篇）就当没有——宁可说不知道，也不读错一篇。 */
function openBookParts(ask: Ask): Part[] | null {
  const r = ask.reading;
  if (!r || !ask.book || !ask.parts || ask.book.id !== r.bookId) return null;
  const here = ask.parts.find((p) => p.n === r.part);
  return here && here.docId !== r.docId ? null : ask.parts;
}

/** part（第几篇，从 1 开始）→ 正开着的那本书里的那一篇；不给就是正开着的这一篇。
 *  解析不了时返回给模型看的原因。 */
function partTarget(ask: Ask, part?: number): Target | string {
  const r = ask.reading;
  if (!r) return NO_BOOK;
  if (part == null || part === r.part) return { docId: r.docId, title: titleOf(r), kind: r.kind || undefined, page: null };
  if (r.partCount <= 1) return `《${r.bookTitle}》只有一个文件，没有分篇，不用填 part。`;
  if (part > r.partCount) return `《${r.bookTitle}》一共 ${r.partCount} 篇，没有第 ${part} 篇。`;
  const p = openBookParts(ask)?.find((x) => x.n === part);
  if (p) return { docId: p.docId, title: `${r.bookTitle}${SEP}${p.name}`, kind: p.kind || undefined, page: null };
  const why =
    ask.book?.id === r.bookId
      ? `手上没有《${r.bookTitle}》第 ${part} 篇的信息（这一问没带分篇列表、列表没列到那一篇，或者分篇后来变过）`
      : `用户现在打开的《${r.bookTitle}》不是这段对话关联的那本书，手上没有它的分篇列表`;
  return `${why}，part 眼下只能指正开着的这一篇（第 ${r.part} 篇）。别的篇可以先用 search_docs 找到内容、再带上那条结果的 ref，或者请用户在阅读器里打开那一篇。`;
}

/** ref（search_docs 结果里的 [n]）→ 那条结果所在的那一篇和页。
 *  只认这一问里的结果：编号每一问都从 1 重新排，上一问的 [3] 和这一问的 [3] 不是同一条。 */
function hitTarget(ask: Ask, ref: number): Target | string {
  const h = ask.hits[ref - 1];
  if (!h) {
    return ask.hits.length
      ? `这一问里没有编号 [${ref}] 的检索结果（现在到 [${ask.hits.length}]）。ref 只能用这一问里 search_docs 返回的编号。`
      : "这一问里还没有检索结果。ref 是 search_docs 结果的编号，之前几问的编号不能用，先检索一次。";
  }
  if (!h.docId) return `[${ref}] 这条结果对不上书架里的文档，定位不了。`;
  return { docId: h.docId, title: h.docTitle, kind: h.docKind, page: h.page ?? null, text: h.text };
}

/** 文档库和阅读器的工具，做成 SDK 的进程内 MCP 工具：参数校验、分发、错误处理都由 SDK 管。
 *  每轮提问建一份，工具闭包里直接拿得到这一轮的上下文。 */
function docTools(ask: Ask) {
  return createSdkMcpServer({
    name: "docagent",
    version: "0.1.0",
    tools: [
      tool(
        "search_docs",
        "在用户的书架（导入的本地文档）里检索，返回最相关的片段。每条带一个编号 [n]（这一问之内连续；引用时用它，" +
          "highlight、show_in_reader 的 ref 也用它）和出处：《书名》，书有多篇时是《书名 · 篇名》，后面是这一篇里的第几页 / 第几节。" +
          "检索范围是用户在界面上选的（一本书、书里的一篇、几本书或整个书架），只在范围里找；" +
          "开了防剧透的书只搜得到用户读过的部分。字面和语义两路一起找，可以换关键词多次调用。",
        { query: z.string().describe("检索语句，可与用户原问题不同；关键词比整句更准") },
        async ({ query: q }) => {
          const { hits, bounded } = await searchDocs(q, ask.docIds, ask.k, ask.reading);
          if (!hits.length) return text(nothingFound(ask, bounded));
          // 累积到本轮上下文并分配全局编号：模型多次检索时 [n] 不会撞号，
          // 界面用同一份列表把 [n] 映射回原文位置
          const numbers = hits.map((h) => {
            const key = h.chunkId ?? h.text;
            let at = ask.hits.findIndex((x) => (x.chunkId ?? x.text) === key);
            if (at < 0) {
              ask.hits.push(h);
              at = ask.hits.length - 1;
            }
            return at + 1;
          });
          return text(bounded ? `${renderHits(hits, numbers)}\n\n${UNREAD_NOTE}` : renderHits(hits, numbers));
        },
      ),
      tool(
        "read_section",
        "读用户正开着的那本书里的一整节（PDF、漫画是一页，电子书是一章）。什么都不填就读用户当前所在的那一节。" +
          "书有多篇（一篇是一个文件）时，number 数的是「一篇」之内的页 / 节，不是全书的；" +
          "要读同一本书的另一篇用 part，那一篇从头读起，可以再配 number。" +
          "用户问「这一章讲了什么」「这页什么意思」「上一篇说了什么」时用它，比检索完整。" +
          "开了防剧透的书读不到用户还没读到的地方。",
        {
          number: z.number().int().positive().optional().describe("这一篇里的第几页 / 第几节，从 1 开始；不填是当前这一节"),
          part: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("正开着的这本书的第几篇，从 1 开始（提问开头的说明和分篇列表里的序号）；不填是正开着的这一篇"),
        },
        async ({ number, part }) => {
          const r = ask.reading;
          const t = partTarget(ask, part);
          if (!r || typeof t === "string") return text(typeof t === "string" ? t : NO_BOOK, true);
          // 正开着的这一篇有「当前位置」，不给 number 就读那里；别的篇没有，交给宿主从头读
          const open = t.docId === r.docId;
          const out = (await hostFetch("/section", {
            docId: t.docId,
            page: number ?? (open ? r.page : null),
            fraction: open ? r.fraction : null,
            live: liveOf(r),
          })) as { text: string; page: number | null; truncated: boolean; blocked?: boolean };
          // 读没读到由宿主判断（存下来的最远位置和此刻的位置取大的），这里不再自己比页码：
          // 用户往回翻了几页时，当前页之后、读过的那几页应该还能读
          if (out.blocked) return text("还没读到那里：这本书开了防剧透，只能读用户已经读过的部分。", true);
          if (!out.text) return text("这一节没有可读的文字（可能是图片或扫描页）。", true);
          const head = `《${t.title}》${where(t.kind, t.title, out.page)}${out.truncated ? "（太长，只取了前一部分）" : ""}`;
          return text(`${head}\n\n${out.text}`);
        },
      ),
      tool(
        "list_notes",
        "读取用户在阅读器里划的重点（高亮）和写的笔记，按书里的先后排。默认只取一本书的：这段对话关联的那本，" +
          "没有关联就取正开着的那本，两样都没有才是全部；要所有书的传 all: true。" +
          "用户提到「我的笔记」「我划的线」「我标的重点」时用。",
        {
          limit: z.number().int().positive().max(300).optional().describe("最多返回多少条，默认 80"),
          all: z.boolean().optional().describe("true：不限于一本书，取所有书上的划线和笔记"),
        },
        async ({ limit, all }) => {
          if (!HOST_API) return text("（未连接阅读器）");
          // 默认只看一本：聊着这本书时说「我的笔记」，指的就是这本书上的，别的书的划线混进来只会添乱
          const r = ask.reading;
          const of = all ? null : ask.book ? ask.book : r?.bookId ? { id: r.bookId, title: r.bookTitle } : null;
          const out = (await hostFetch("/annotations", { docIds: null, bookId: of?.id ?? null })) as {
            annotations: { kind: string; docTitle: string; label: string; page: number | null; text: string; note: string }[];
          };
          const marks = out.annotations.filter((a) => a.kind === "highlight");
          if (!marks.length) {
            return text(of ? `用户在《${of.title}》里还没有划线或写笔记。别的书上的要传 all: true 才看得到。` : "用户还没有划线或写笔记。");
          }
          const max = limit ?? 80;
          const body = marks
            .slice(0, max)
            .map((a) => {
              // 划线只有在版面固定的书（PDF、漫画）里才记页码，所以这里有 page 就是真页码
              const at = [`《${a.docTitle}》`, a.label, a.page ? `第 ${a.page} 页` : ""].filter(Boolean).join(" ");
              return `${at}\n划线：${a.text.slice(0, 600)}${a.note ? `\n笔记：${a.note.slice(0, 600)}` : ""}`;
            })
            .join("\n\n");
          return text(marks.length > max ? `${body}\n\n（共 ${marks.length} 条，这里是前 ${max} 条）` : body);
        },
      ),
      tool(
        "highlight",
        "在书里把一段原文划出来，可以附一条笔记。会先征求用户同意。" +
          "quote 必须是书里的原文、一字不差（从 read_section 或 search_docs 的结果里照抄），一次划一处，尽量短（一两句）。" +
          "默认划在用户正开着的这一篇里；原文是从 search_docs 的第 [n] 条结果里抄的就带上 ref: n，" +
          "会划到那条结果所在的那一篇、那一页（没开着会先打开）；不带 ref 只会在正开着的这一篇里找这段原文。",
        {
          quote: z.string().min(2).describe("要划线的原文，一字不差"),
          note: z.string().optional().describe("附在这条划线上的笔记"),
          color: z.enum(["yellow", "green", "blue", "pink", "purple"]).optional(),
          ref: z.number().int().positive().optional().describe("这一问里 search_docs 结果的编号 [n]：原文出自那条结果"),
        },
        async ({ quote, note, color, ref }) => {
          const t = ref != null ? hitTarget(ask, ref) : partTarget(ask);
          if (typeof t === "string") return text(t, true);
          // 审批紧贴副作用：进程内 MCP 工具不一定经过外面的闸门。
          // 卡片上写的是要划的那一篇，不是正开着的那一篇——带 ref 时两者可能不同
          const allow = await requestApproval(ask, "highlight", { quote, note, docTitle: t.title });
          if (!allow) return text("用户没有同意这次划线。", true);
          const out = await readerAction(ask, {
            action: "highlight",
            docId: t.docId,
            quote,
            note: note ?? "",
            color: color ?? "yellow",
            page: t.page,
          });
          return text(out.message, !out.ok);
        },
      ),
      tool(
        "show_in_reader",
        "把阅读器翻到书里的某一处给用户看：给一段原文就定位到那段并标出来，或者给页码 / 第几节。" +
          "默认在用户正开着的这一篇里；part 换到同一本书的另一篇（只给 part 就翻到那一篇的开头）；" +
          "ref 是 search_docs 结果的编号 [n]，翻到那条结果所在的那一篇那一处（只给 ref 就行，没开着会先打开）。",
        {
          quote: z.string().optional().describe("要定位的原文，一字不差"),
          number: z.number().int().positive().optional().describe("这一篇里的第几页 / 第几节"),
          part: z.number().int().positive().optional().describe("正开着的这本书的第几篇，从 1 开始；不填是正开着的这一篇"),
          ref: z.number().int().positive().optional().describe("这一问里 search_docs 结果的编号 [n]；给了它就不看 part"),
        },
        async ({ quote, number, part, ref }) => {
          if (!quote && !number && part == null && ref == null) {
            return text("要给一段原文、一个页码，或者一条检索结果的编号（ref）。", true);
          }
          const t = ref != null ? hitTarget(ask, ref) : partTarget(ask, part);
          if (typeof t === "string") return text(t, true);
          const page = number ?? t.page;
          // 按页码或篇号翻（不是翻到一条搜得到的结果）：先问宿主那里用户读没读到。
          // 这个工具不经用户确认，翻过去之后阅读器还会把那里记成「读到过」——不拦的话，
          // 助手自己就能把防剧透的界线往后推
          if (ref == null && !quote) {
            // 没有页码的格式（Markdown、文本、MOBI…）宿主没法按 number 判断读没读到，开着防剧透时不按它翻
            const paged = t.kind === "pdf" || t.kind === "cbz" || t.kind === "epub";
            if (number && !paged && ask.reading?.spoilerFree) {
              return text("这种格式没有页码。给一段原文（quote）或者检索结果的编号（ref）来定位。", true);
            }
            const probe = (await hostFetch("/section", {
              docId: t.docId,
              page: number ?? null,
              fraction: null,
              live: liveOf(ask.reading),
            })) as { blocked?: boolean };
            if (probe.blocked) {
              return text("那里用户还没读到（这本书开着防剧透），不能替用户翻过去。可以请用户自己翻。", true);
            }
          }
          // 只给了 ref：和用户点回答里的 [n] 一样，拿那条结果的原文去定位
          const byHit = !quote && !number ? (t.text ?? null) : null;
          let out = await readerAction(ask, { action: "goto", docId: t.docId, quote: quote ?? byHit, page });
          if (!out.ok && byHit && out.message !== NO_REPLY) {
            // 片段和页面上的文字对不上（分块重叠、表格…）时退一步，翻到它所在的那一页。
            // 没有页码的格式没处可退；阅读器那句「原文要一字不差」是说给自己写 quote 的模型听的，这里换成对得上的说法
            out = page
              ? await readerAction(ask, { action: "goto", docId: t.docId, quote: null, page })
              : { ok: false, message: `没能在《${t.title}》里标出这条结果的原文。从结果里照抄一两句当 quote 再试。` };
          }
          return text(out.message, !out.ok);
        },
      ),
      tool(
        "save_note",
        "把内容保存成本地文件（固定存到「文稿/DocAgent」）。会先征求用户同意。",
        { filename: z.string().describe("文件名，如 合同要点.md"), content: z.string() },
        async ({ filename, content }) => {
          // 审批放在这里而不是交给 SDK 的 canUseTool：端到端测试发现进程内 MCP 工具
          // 不会触发 canUseTool，写文件会直接执行。闸门紧贴副作用才绕不过去。
          const allow = await requestApproval(ask, "save_note", { filename, content });
          if (!allow) return text("用户拒绝了这次保存，文件没有写入。", true);
          const out = (await hostFetch("/save", { filename, content })) as { path: string };
          return text(`已保存到 ${out.path}`);
        },
      ),
    ],
  });
}

const RULES = `你运行在一个叫 DocAgent 的桌面应用里，是用户的通用助手：可以读写本地文件、运行命令、联网搜索、访问网页、派子代理，也可以检索用户的书架、操作用户正在看的书。

关于用户的书架（search_docs）：
- 书架上的一本书可以只有一个文件，也可以是一个文件夹里的多个文件——每个文件是这本书的「一篇」。检索结果的出处写成《书名》或《书名 · 篇名》，页码 / 第几节是那一篇之内的。
- 问题可能和用户的资料有关时先检索。检索范围是用户在界面上选的（提问开头的说明里写着「检索范围」）；范围里没找到就照实说是在哪个范围里没找到，不要说成用户的资料里都没有。文档内容和你的常识冲突时以文档为准。
- 来自书架的结论在句末标注编号 [1]、[2]（对应检索结果里的编号）；其它来源（你自己的知识、读到的本地文件、网页）不要用这种编号，直接说明来源。
- 不要把自身知识说成是文档里的，不要编造引用。
- 用户在阅读器里划的重点和写的笔记用 list_notes 读取（默认只取这段对话关联的那本书，要所有书的传 all: true）；整理笔记时以用户划的原文为依据。

关于用户正在看的书（提问开头的说明会告诉你是哪本、第几篇、读到哪）：
- 「这一篇」「这个文件」指正开着的那个文件；「这一章」「这一页」「这里」指这一篇里用户当前的位置。两个不是一回事：一篇里可以有很多章。只有一个文件的书没有「篇」这一层，「这本书」就是它。
- 读原文用 read_section，不要让用户再选一遍：不填参数是当前这一节，number 是这一篇里的第几页 / 第几节，part 换到同一本书的另一篇（序号见说明和分篇列表）。
- 说明里的百分比，书有多篇时是「这一篇」读到哪了，不是整本书的进度。
- 用户让你标重点、划线时用 highlight；想让用户看某一处时用 show_in_reader。两个工具默认都作用在正开着的这一篇上；内容出自这一问里 search_docs 的第 [n] 条结果时带上 ref: n，就会落到那条结果所在的那一篇、那一页，哪怕它现在没开着。之前几问的编号不能当 ref 用，要用就重新检索。
- 开了防剧透的书，用户没读到的部分搜不到也读不出来（read_section 会说还没读到那里）；不要拿自己的知识去补后面的内容。
- 说明里没有「正在阅读器里看」，就是用户现在没开着书，不要假设；这时 read_section 用不了，highlight 和 show_in_reader 要带 ref。

关于这个应用本身（用户问「怎么改」「在哪看」时，先说应用里现成的办法，不要让用户去开别的编辑器或敲命令）：
- 改原文：Markdown 和纯文本的篇，阅读器右上角有铅笔按钮「编辑原文」，改完保存会写回原文件并重新索引。用户让你替他改时，用 Edit 改那个文件（路径用 read_section 的结果或先 Glob 找），改完告诉他改了哪里。其它格式（PDF、EPUB、Word）应用里改不了。
- 学习：这个应用的主线是「读完真的学会」。读完一段，页面底下会问要不要考几道题（也可以从右上角一键动作里点「考考我这一段」）；答完对照原文批改，每个概念记掌握度，到期了书架首页会提醒复习；透视里的关系图按掌握度上色。用户想被考、想复习时指给他这些入口，不要自己在对话里另出一套题。
- 阅读器左上角：目录、透视（全书要点、人物与概念）、笔记、书签、搜索；右上角：一键动作、书签、排版。选中文字会弹出划线、写笔记、问助手。
- 书架上每本书的「⋯」里可以换封面、改名、设防剧透、移除。左下角齿轮是设置（模型、检索、技能与 MCP、数据）。
- 用户没问到的事不要主动汇报（比如文件夹的 git 状态）。

做事方式：
- 了解本地项目或目录时，优先用 Glob 找文件、Grep 搜内容、Read 读文件；Bash 留给确实要执行的事（每条命令用户都要点一次同意）。
- 需要最新信息或文档库、本地都没有的资料时，用 WebSearch 联网搜索，用 WebFetch 打开具体网页；引用网页内容时给出链接。
- 任务大、可以拆开并行时，可以派子代理去做。
- 用户配置了技能（Skill）时，遇到匹配的任务先用对应的技能。
- 读取、写入、运行命令、联网会由应用向用户请求许可；被拒绝就换个办法或者如实说明，不要反复重试同一个操作。
- 要交付文件时：用户指定了位置就用 Write 写到那里；没指定就用 save_note。
- 用中文回答，简洁，适当使用 Markdown。`;

/** 拼在问题前面的说明：用户在看哪本、哪一篇、读到哪，这一问在哪个范围里检索。
 *  模型看不到界面，「这一篇」「这一章」「这本书」各指什么全靠这段话。 */
function preface(ask: Ask): string {
  const { book, reading: r } = ask;
  const bits: string[] = [];
  if (r) {
    const pct = Math.round(r.fraction * 100);
    const multi = r.partCount > 1;
    let s = `用户正在阅读器里看《${r.bookTitle}》`;
    // 多篇的书：进度是这一篇的。不说清楚的话，模型会把「这一篇读了 90%」当成整本快读完了
    if (multi) s += `，共 ${r.partCount} 篇，现在是第 ${r.part} 篇「${partName(r)}」，读到这一篇的 ${pct}%`;
    if (r.chapter) s += `，当前在「${r.chapter}」`;
    if (r.page) s += `，${where(r.kind, r.docTitle, r.page)}`;
    if (!multi) s += `，读到全书 ${pct}%`;
    bits.push(s);
  }
  // 聊着这本、开着另一本（或者没开书）时，两本都要交代，免得模型把「这本书」认错
  if (book && book.id !== r?.bookId) bits.push(`这段对话关联的书${r ? "是" : "："}《${book.title}》`);
  if (book?.scopeLabel) bits.push(`检索范围：${book.scopeLabel}`);
  // 读者的画像：讲解时照着他的背景和偏好来，碰到他容易错的地方多说一句
  const who = ask.profile ? `（关于这位读者，他自己能看到也能改；讲解时照顾到，但不要复述给他听：\n${ask.profile}）\n\n` : "";
  if (!bits.length) return who;
  let out = bits.join("；");
  if (r?.spoilerFree) {
    out += "。用户开了防剧透：这本书只能依据他已经读过的部分回答，不要透露、不要暗示后面的情节；问到后面的事就说还没读到";
  }
  // 只有一篇的书列出来也没有信息量
  if (book?.parts && book.parts.length > 1) {
    const kinds = new Set(book.parts.map((p) => p.kind));
    const lines = book.parts.map((p) => {
      // 格式只在一本书里混着几种时才值得写
      const tags = [kinds.size > 1 ? p.kind : "", p.opened ? "打开过" : ""].filter(Boolean).join("，");
      return `${p.n}. ${p.name}${tags ? `（${tags}）` : ""}`;
    });
    const cut =
      r && r.bookId === book.id && r.partCount > book.parts.length
        ? `\n……一共 ${r.partCount} 篇，这里只列了前 ${book.parts.length} 篇`
        : "";
    out += `。\n《${book.title}》的分篇（序号就是工具参数里的 part；标了「打开过」的是用户翻开过的）：\n${lines.join("\n")}${cut}\n`;
  }
  return `（${out}）\n\n${who}`;
}

async function handleAsk(msg: {
  id: string;
  question: string;
  sessionId?: string;
  docIds?: string[];
  k?: number;
  cwd?: string;
  book?: unknown;
  reading?: unknown;
  profile?: unknown;
}) {
  const { id, sessionId } = msg;
  const cwd = realPath(msg.cwd && existsSync(msg.cwd) ? msg.cwd : HOME, "/");
  const book = bookOf(msg.book);
  if (book?.parts) partsByBook.set(book.id, book.parts);
  const ask: Ask = {
    id,
    cwd,
    docIds: msg.docIds,
    k: msg.k,
    hits: [],
    book,
    parts: book ? (book.parts ?? partsByBook.get(book.id)) : undefined,
    reading: readingOf(msg.reading),
    profile: typeof msg.profile === "string" && msg.profile.trim() ? msg.profile.slice(0, 2000) : undefined,
    approvals: new Set(),
    decided: new Map(),
    ended: false,
  };
  const ac = new AbortController();
  aborts.set(id, ac);
  ac.signal.addEventListener("abort", () => endAsk(ask));
  let answer = "";
  let session = sessionId ?? null;

  try {
    // 不设自己的配置目录的话，SDK 会去用 ~/.claude——宁可不干活
    if (!CONFIG_DIR) throw new Error("没有设置配置目录（DOCAGENT_CONFIG_DIR），拒绝运行");
    // 换了工作文件夹，之前记住的放行范围全部作废（同名的 MCP 服务在另一个文件夹里可能是另一条命令）
    if (grantedFor !== cwd) {
      granted.clear();
      grantedFor = cwd;
    }
    // 用户自己选的工作文件夹：读取不用再问（写入和跑命令仍然要问）
    if (msg.cwd) granted.add(`read:${cwd}`);

    const project = msg.cwd ? await trustedProject(ask, `${cwd}/.docagent`) : null;
    const plugins = [pluginFor("user", USER_DIR), project?.skills.length ? pluginFor("project", `${cwd}/.docagent`) : null].filter(
      (x): x is NonNullable<typeof x> => !!x,
    );
    // 文件夹级的 MCP 配置覆盖用户级同名项；内置的文档库工具始终存在
    const externalMcp: McpMap = { ...readMcp(USER_DIR), ...(project?.mcp ?? {}) };
    delete externalMcp.docagent;

    const prompt = preface(ask) + msg.question;

    const q = query({
      prompt,
      options: {
        // 用 Claude Code 自带的系统提示（它知道怎么用好这些工具），后面追加本应用的规则
        systemPrompt: { type: "preset", preset: "claude_code", append: RULES },
        cwd,
        mcpServers: { ...(externalMcp as Record<string, any>), docagent: docTools(ask) },
        // 只认上面传进去的 MCP 服务，不让 SDK 自己去别处找配置
        strictMcpConfig: true,
        ...(plugins.length ? { plugins } : {}),
        // SDK 的全套内置工具（和 Claude Code 一样）：读写改文件、Bash、联网搜索、
        // 抓网页、子代理、Notebook、Skill 等。能不能用由 gate 决定。
        tools: { type: "preset", preset: "claude_code" },
        disallowedTools: UNUSED_TOOLS,
        // 明确用「每次都问」的模式：不写的话可能落到由模型自己判断要不要问
        permissionMode: "default",
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
              // 等用户点按钮可能很久，别让钩子超时
              timeout: 3600,
              hooks: [
                async (input: any) => {
                  const v = await gateOnce(ask, input.tool_use_id, input.tool_name, input.tool_input ?? {});
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: v.allow ? "allow" : "deny",
                      permissionDecisionReason: v.reason ?? "已放行",
                    },
                  };
                },
              ],
            },
          ],
        },
        // 钩子已经做了决定；万一还走到这里，按调用 id 取同一个结论，不再问第二遍
        canUseTool: async (name: string, input: Record<string, unknown>, opts: { toolUseID?: string }) => {
          const v = await gateOnce(ask, opts?.toolUseID, name, input);
          return v.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: v.reason ?? "已拒绝" };
        },
        stderr: (d: string) => process.stderr.write(d),
      } as any,
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
            const out = Array.isArray(b.content)
              ? b.content.map((c: any) => c.text ?? "").join("")
              : String(b.content ?? "");
            send({ type: "tool_result", id, toolUseId: b.tool_use_id, text: out.slice(0, 4000), isError: !!b.is_error });
          }
        }
      } else if (m.type === "result" && m.subtype !== "success") {
        // 中途失败（比如轮数用完）时，已经写出来的回答里可能带着 [n]，命中列表要一起给界面
        send({
          type: "error",
          id,
          message: `模型返回失败：${m.subtype}${m.result ? ` — ${m.result}` : ""}`,
          sessionId: m.session_id ?? session,
          hits: ask.hits,
        });
      } else if (m.type === "result") {
        send({
          type: "result",
          id,
          text: m.result ?? answer,
          sessionId: m.session_id ?? session,
          costUsd: null,
          tokens: m.usage
            ? (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0) + (m.usage.output_tokens ?? 0)
            : null,
          turns: m.num_turns ?? null,
          hits: ask.hits,
        });
      }
    }
  } catch (err) {
    send({ type: "error", id, message: err instanceof Error ? err.message : String(err), hits: ask.hits });
  } finally {
    endAsk(ask);
    aborts.delete(id);
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
    } else if (msg.type === "reader_result") {
      pendingReader.get(msg.callId)?.({ ok: !!msg.ok, message: String(msg.message ?? "") });
      pendingReader.delete(msg.callId);
    } else if (msg.type === "abort") aborts.get(msg.id)?.abort();
  }
}

void main();
