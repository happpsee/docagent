import { memo, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Circle, Loader2, NotebookPen } from "lucide-react";
import { citedNumbers, pageLabel } from "@/lib/citations";
import type { Block, Hit, Message, Quote } from "@/lib/types";
import { StreamMarkdown } from "./StreamMarkdown";
import { Composer } from "./Composer";

interface Props {
  title: string | null;
  /** 旁边开着文档时，对话缩在右侧窄栏里 */
  compact?: boolean;
  messages: Message[];
  busy: boolean;
  /** 本轮开始的时间戳，用来显示已用时 */
  startedAt: number | null;
  ready: boolean;
  model: string;
  docCount: number;
  scopeCount: number;
  onSend: (q: string) => void;
  onStop: () => void;
  onCite: (hit: Hit) => void;
  onApproval: (requestId: string, allow: boolean, remember?: boolean) => void;
  quote: Quote | null;
  onClearQuote: () => void;
  onOpenQuote: (q: Quote) => void;
  /** 把助手对一段原文的回答存成那段话的笔记 */
  onSaveNote: (q: Quote, answer: string) => Promise<void>;
  workspace: string | null;
  onPickWorkspace: () => void;
  onClearWorkspace: () => void;
}

const SUGGESTIONS = ["这些资料主要讲了什么？", "帮我看看某个项目的代码结构", "把要点整理成一份文档"];

export function ChatPanel(p: Props) {
  const [input, setInput] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  /** 用户是不是贴着底部：是才跟着新内容往下滚，往上翻着看的时候不打扰 */
  const stick = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [p.messages]);
  // 自己发了新问题：回到底部
  const count = p.messages.length;
  useEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  function submit(text = input) {
    const q = text.trim();
    if (!q || p.busy || !p.ready) return;
    setInput("");
    p.onSend(q);
  }

  const composer = (
    <Composer
      value={input}
      onChange={setInput}
      onSubmit={() => submit()}
      onStop={p.onStop}
      busy={p.busy}
      ready={p.ready}
      model={p.model}
      docCount={p.docCount}
      scopeCount={p.scopeCount}
      autoFocus
      quote={p.quote}
      onClearQuote={p.onClearQuote}
      workspace={p.workspace}
      onPickWorkspace={p.onPickWorkspace}
      onClearWorkspace={p.onClearWorkspace}
    />
  );

  // 空状态：问候语和输入框一起居中，像一张信纸的开头
  if (p.messages.length === 0) {
    const hour = new Date().getHours();
    const hello = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
    return (
      <section className={`flex min-w-0 flex-1 flex-col items-center justify-center pb-[8vh] ${p.compact ? "px-4" : "px-6"}`}>
        <div className="w-full max-w-[680px]">
          <h1
            className={`display-serif flex items-center justify-center gap-3 tracking-tight text-text ${
              p.compact ? "text-[20px]" : "text-[32px]"
            }`}
          >
            <span className="text-accent">✳</span>
            {p.compact ? "就这份文档问点什么？" : `${hello}，想了解点什么？`}
          </h1>
          <div className="mt-7">{composer}</div>
          {p.compact ? null : p.docCount > 0 ? (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  className="rounded-full border border-hairline bg-surface-2/60 px-3.5 py-1.5 text-[13px] text-text-2 hover:border-hairline-strong hover:bg-surface-2 hover:text-text"
                  onClick={() => submit(s)}
                  disabled={!p.ready}
                >
                  {s}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-center text-[13px] text-text-3">
              可以直接聊，也可以让我读本地项目、整理文件。导入文档后，我会优先从里面找答案并标出出处。
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      {p.title && !p.compact && (
        <header className="truncate px-6 py-3 text-[13px] text-text-3">{p.title}</header>
      )}

      <div
        ref={scroller}
        className="flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className={`mx-auto flex max-w-[740px] flex-col gap-6 pb-8 ${p.compact ? "px-4 pt-4" : "px-6 pt-2"}`}>
          {p.messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex flex-col items-end gap-1.5">
                {m.quote && (
                  <button
                    className="max-w-[85%] rounded-xl border-l-2 border-accent bg-accent-dim px-3 py-2 text-left hover:bg-accent-soft"
                    onClick={() => p.onOpenQuote(m.quote!)}
                    title="回到原文"
                  >
                    <div className="line-clamp-3 text-[12px] leading-5 text-text-2">{m.quote.text}</div>
                    <div className="mt-0.5 text-[11px] text-text-4">
                      {m.quote.docTitle}
                      {pageLabel(m.quote.docTitle, m.quote.page)}
                    </div>
                  </button>
                )}
                <div className="max-w-[85%] whitespace-pre-wrap rounded-[18px] bg-segment-bg px-4 py-2.5 text-[15px] leading-6 text-text">
                  {m.content}
                </div>
              </div>
            ) : (
              <Assistant
                key={i}
                m={m}
                startedAt={m.pending ? p.startedAt : null}
                onCite={p.onCite}
                onApproval={p.onApproval}
                quote={p.messages[i - 1]?.role === "user" ? p.messages[i - 1].quote : undefined}
                onSaveNote={p.onSaveNote}
              />
            ),
          )}
          <div className="h-2" />
        </div>
      </div>

      <div className={`mx-auto w-full max-w-[740px] pb-3 ${p.compact ? "px-3" : "px-6"}`}>
        {composer}
        <p className="mt-2 text-center text-[11px] text-text-4">
          回答可能出错。带编号的结论来自你的文档，点开可以核对原文。
        </p>
      </div>
    </section>
  );
}

/** 一条助手消息。流式输出时只有最后一条在变，前面的不用跟着重新渲染 */
const Assistant = memo(AssistantView, (a, b) => a.m === b.m && a.startedAt === b.startedAt && a.quote === b.quote);

function AssistantView({
  m,
  startedAt,
  onCite,
  onApproval,
  quote,
  onSaveNote,
}: {
  m: Message;
  startedAt: number | null;
  onCite: (h: Hit) => void;
  onApproval: Props["onApproval"];
  /** 这条回答对应的提问里带的原文 */
  quote?: Quote;
  onSaveNote: Props["onSaveNote"];
}) {
  const [saved, setSaved] = useState(false);
  const blocks: Block[] = m.blocks?.length ? m.blocks : m.content ? [{ type: "text", text: m.content }] : [];
  const fullText = blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  const cited = citedNumbers(fullText).filter((n) => m.hits?.[n - 1]);
  const lastTodo = blocks.findLastIndex((b) => b.type === "tool" && b.name === "TodoWrite");

  return (
    <div className="flex flex-col gap-2.5">
      {blocks.map((b, i) =>
        b.type === "tool" && b.name === "TodoWrite" ? (
          // 计划会被反复更新，只显示最新的一份
          i === lastTodo ? <TodoList key={i} input={b.input} /> : null
        ) : b.type === "text" ? (
          <div key={i} className={`text-[15px] leading-7 ${m.error ? "text-danger" : "text-text"}`}>
            <StreamMarkdown content={b.text} />
          </div>
        ) : (
          <ToolRow key={b.toolUseId || i} b={b} onApproval={onApproval} />
        ),
      )}

      {m.pending && <Working startedAt={startedAt} />}

      {cited.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {cited.map((n) => {
            const h = m.hits![n - 1];
            return (
              <button
                key={n}
                onClick={() => onCite(h)}
                title={h.text.slice(0, 200)}
                className="inline-flex max-w-[280px] items-center gap-1.5 rounded-md border border-hairline px-2 py-1 text-[12px] text-text-2 hover:border-accent hover:text-accent"
              >
                <span className="num text-accent">[{n}]</span>
                <span className="truncate">
                  {h.docTitle}
                  {pageLabel(h.docTitle, h.page)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {!m.pending && !m.error && quote?.cfi && fullText.trim() && (
        <button
          disabled={saved}
          onClick={() => void onSaveNote(quote, fullText.trim()).then(() => setSaved(true))}
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-hairline px-2 py-1 text-[12px] text-text-2 hover:border-accent hover:text-accent disabled:border-transparent disabled:text-text-4"
          title="把这条回答记在你选中的那段原文上，之后在笔记里能看到"
        >
          <NotebookPen className="h-3.5 w-3.5" />
          {saved ? "已存到这段话的笔记" : "存为这段话的笔记"}
        </button>
      )}

      {!m.pending && (m.durationMs != null || m.costUsd != null) && (
        <div className="num text-[11px] text-text-4">
          {[
            m.durationMs != null ? `${(m.durationMs / 1000).toFixed(1)}s` : null,
            m.costUsd != null ? `$${m.costUsd.toFixed(4)}` : null,
            m.hits?.length ? `检索到 ${m.hits.length} 个片段` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}

/** 进行中的状态行：转圈 + 已用时 */
function Working({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const secs = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  return (
    <div className="flex items-center gap-2 text-[13px] text-text-3">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
      <span className="arc-shimmer-text">处理中…</span>
      <span className="num text-[11px] text-text-4">{secs}s</span>
    </div>
  );
}

/** 计划清单（TodoWrite）：做完的打勾，正在做的高亮 */
function TodoList({ input }: { input: Record<string, unknown> }) {
  const todos = (input.todos as { content: string; status: string; activeForm?: string }[] | undefined) ?? [];
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="rounded-xl border border-hairline bg-surface-2/60 px-3.5 py-3">
      <div className="mb-1.5 flex items-center text-[12px] text-text-3">
        <span className="font-medium text-text-2">计划</span>
        <span className="num ml-auto">
          {done} / {todos.length}
        </span>
      </div>
      <ul className="space-y-1">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px] leading-5">
            {t.status === "completed" ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" strokeWidth={2.5} />
            ) : t.status === "in_progress" ? (
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
            ) : (
              <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-4" />
            )}
            <span
              className={
                t.status === "completed" ? "text-text-4 line-through" : t.status === "in_progress" ? "text-text" : "text-text-2"
              }
            >
              {t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const tilde = (p: unknown) => String(p ?? "").replace(/^\/Users\/[^/]+/, "~");

/** 每种工具在一行摘要里显示什么 */
function describe(name: string, input: Record<string, unknown>): { label: string; arg: string; mono?: boolean } {
  const short = name.replace("mcp__docagent__", "");
  switch (short) {
    case "search_docs":
      return { label: "检索文档", arg: String(input.query ?? "") };
    case "save_note":
      return { label: "保存文件", arg: String(input.filename ?? "") };
    case "list_notes":
      return { label: "读我的划线和笔记", arg: "" };
    case "read_section":
      return { label: "读原文", arg: input.number ? `第 ${String(input.number)} 节` : "当前这一节" };
    case "highlight":
      return { label: "划线", arg: String(input.quote ?? "") };
    case "show_in_reader":
      return { label: "翻到", arg: String(input.quote ?? (input.number ? `第 ${String(input.number)} 节` : "")) };
    case "TrustFolder":
      return { label: "文件夹里的配置", arg: tilde(input.dir), mono: true };
    case "Read":
      return { label: "读取", arg: tilde(input.file_path), mono: true };
    case "Glob":
      return { label: "查找文件", arg: `${String(input.pattern ?? "")}${input.path ? `  ·  ${tilde(input.path)}` : ""}`, mono: true };
    case "Grep":
      return { label: "搜索内容", arg: `${String(input.pattern ?? "")}${input.path ? `  ·  ${tilde(input.path)}` : ""}`, mono: true };
    case "Write":
      return { label: "写入", arg: tilde(input.file_path), mono: true };
    case "Edit":
      return { label: "修改", arg: tilde(input.file_path), mono: true };
    case "Bash":
      return { label: "运行", arg: String(input.description ?? input.command ?? ""), mono: !input.description };
    case "WebFetch":
      return { label: "访问网页", arg: String(input.url ?? "") };
    case "WebSearch":
      return { label: "联网搜索", arg: String(input.query ?? "") };
    case "Task":
    case "Agent":
      return { label: "子代理", arg: String(input.description ?? input.prompt ?? "").slice(0, 80) };
    case "NotebookEdit":
      return { label: "修改 Notebook", arg: tilde(input.notebook_path), mono: true };
    default: {
      // 没有专门文案的工具：显示工具名和它的第一个文本参数
      const first = Object.values(input).find((v) => typeof v === "string");
      return { label: short, arg: String(first ?? "").slice(0, 100) };
    }
  }
}

/** 审批卡片上的问法和要给用户看的内容 */
function approvalCopy(name: string, input: Record<string, unknown>): { title: string; note?: string; body?: string } {
  const short = name.replace("mcp__docagent__", "");
  switch (short) {
    case "Read":
    case "Glob":
    case "Grep":
      return {
        title: "允许读取这个位置吗？",
        note: "读到的文件内容会发给模型接口",
        body: tilde(input._dir ?? input.file_path ?? input.path),
      };
    case "Write":
      return { title: "允许写入这个文件吗？", note: tilde(input.file_path), body: String(input.content ?? "").slice(0, 1500) };
    case "Edit":
      return {
        title: "允许修改这个文件吗？",
        note: tilde(input.file_path),
        body: `- ${String(input.old_string ?? "").slice(0, 600)}\n+ ${String(input.new_string ?? "").slice(0, 600)}`,
      };
    case "Bash":
      return { title: "允许运行这条命令吗？", note: input.description ? String(input.description) : undefined, body: String(input.command ?? "") };
    case "WebFetch":
      return { title: "允许访问这个网址吗？", body: String(input.url ?? "") };
    case "WebSearch":
      return { title: "允许联网搜索吗？", note: "搜索词会发给模型供应商的搜索服务", body: String(input.query ?? "") };
    case "highlight":
      return {
        title: `允许在《${String(input.docTitle ?? "")}》里划这一段吗？`,
        note: input.note ? `附笔记：${String(input.note)}` : undefined,
        body: String(input.quote ?? ""),
      };
    case "TrustFolder": {
      const commands = (input.commands as string[] | undefined) ?? [];
      const skills = (input.skills as string[] | undefined) ?? [];
      return {
        title: "这个文件夹自带了配置，要用吗？",
        note: "MCP 服务是会在你电脑上运行的命令，技能是给助手的指令。文件夹是你自己的就允许；是下载来的先看清楚。",
        body: [
          commands.length ? `会运行的 MCP 服务：\n${commands.map((c) => `  ${c}`).join("\n")}` : "",
          skills.length ? `技能：${skills.join("、")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    }
    case "save_note":
      return {
        title: "允许保存这个文件吗？",
        note: `会写到「文稿/DocAgent/${String(input.filename ?? "")}」`,
        body: String(input.content ?? "").slice(0, 1500),
      };
    default:
      return {
        title: `允许使用「${short}」吗？`,
        body: JSON.stringify(
          Object.fromEntries(Object.entries(input).filter(([k]) => !k.startsWith("_"))),
          null,
          2,
        ).slice(0, 1200),
      };
  }
}

/** 一次工具调用：一行摘要，可展开看输入和结果；需要许可时在下面直接给按钮 */
function ToolRow({ b, onApproval }: { b: Extract<Block, { type: "tool" }>; onApproval: Props["onApproval"] }) {
  const [open, setOpen] = useState(false);
  const { label, arg, mono } = describe(b.name, b.input);
  const denied = b.approval?.state === "denied";
  const expired = b.approval?.state === "expired";
  const running = b.result == null && !denied && !expired;
  const found = b.name.endsWith("search_docs") && b.result ? (b.result.match(/^\[\d+\]/gm)?.length ?? 0) : null;
  const dot = b.isError || denied ? "bg-danger" : running ? "bg-warm animate-pulse" : expired && b.result == null ? "bg-text-4" : "bg-good";
  const ask = b.approval?.state === "pending" ? approvalCopy(b.name, b.input) : null;
  const shown = Object.fromEntries(Object.entries(b.input).filter(([k]) => !k.startsWith("_")));

  return (
    <div className="text-[13px]">
      <button
        className="group flex w-full items-center gap-2 rounded-md py-0.5 text-left text-text-2 hover:text-text"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="shrink-0 font-medium">{label}</span>
        <span className={`min-w-0 truncate text-text-3 ${mono ? "num text-[12px]" : ""}`}>{arg}</span>
        {found != null && <span className="num shrink-0 text-[11px] text-text-4">{found} 个片段</span>}
        {denied && <span className="shrink-0 text-[11px] text-danger">已拒绝</span>}
        {expired && b.result == null && <span className="shrink-0 text-[11px] text-text-4">没有执行</span>}
        <ChevronRight
          className={`ml-auto h-3.5 w-3.5 shrink-0 text-text-4 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>

      {ask && (
        <div className="ml-3.5 mt-2 rounded-xl border border-warm-ring bg-warm-tint-faint p-3">
          <div className="text-[13px] text-text">{ask.title}</div>
          {ask.note && <div className="mt-0.5 break-all text-[12px] text-text-3">{ask.note}</div>}
          {ask.body && (
            <pre className="num mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-bg p-2.5 text-[12px] leading-5 text-text-2">
              {ask.body}
            </pre>
          )}
          {b.approval?.canRemember && b.approval.rememberLabel && (
            <div className="mt-2 text-[11px] text-text-4">选「允许并记住」：{b.approval.rememberLabel}</div>
          )}
          <div className="mt-2.5 flex flex-wrap justify-end gap-2">
            <button
              className="arc-btn-secondary rounded-md px-3 py-1.5 text-[12px]"
              onClick={() => onApproval(b.approval!.requestId, false)}
            >
              拒绝
            </button>
            {b.approval?.canRemember && (
              <button
                className="arc-btn-secondary rounded-md px-3 py-1.5 text-[12px]"
                onClick={() => onApproval(b.approval!.requestId, true, true)}
                title={b.approval.rememberLabel ?? "这次运行期间，同类操作不再询问"}
              >
                允许并记住
              </button>
            )}
            <button
              className="rounded-md bg-text px-3 py-1.5 text-[12px] text-bg"
              onClick={() => onApproval(b.approval!.requestId, true)}
            >
              允许
            </button>
          </div>
        </div>
      )}

      {open && (
        <div className="ml-3.5 mt-1.5 space-y-1.5 border-l border-hairline pl-3">
          <pre className="num whitespace-pre-wrap break-all text-[11px] leading-5 text-text-3">
            {JSON.stringify(shown, null, 2).slice(0, 1200)}
          </pre>
          {b.result != null && (
            <pre
              className={`max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-bg p-2.5 text-[12px] leading-5 ${
                b.isError ? "text-danger" : "text-text-2"
              }`}
            >
              {b.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
