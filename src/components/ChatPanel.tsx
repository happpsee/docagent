import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { citedNumbers } from "@/lib/citations";
import type { Block, Hit, Message } from "@/lib/types";
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
  onApproval: (requestId: string, allow: boolean) => void;
}

const SUGGESTIONS = ["这些资料主要讲了什么？", "列出里面所有的金额和期限", "有哪些需要注意的风险点？"];

export function ChatPanel(p: Props) {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [p.messages]);

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
              可以直接聊。点左侧「文档」旁的 + 导入资料后，我会优先从里面找答案并标出出处。
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

      <div className="flex-1 overflow-y-auto">
        <div className={`mx-auto flex max-w-[740px] flex-col gap-6 pb-8 ${p.compact ? "px-4 pt-4" : "px-6 pt-2"}`}>
          {p.messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
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
              />
            ),
          )}
          <div ref={endRef} className="h-2" />
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

function Assistant({
  m,
  startedAt,
  onCite,
  onApproval,
}: {
  m: Message;
  startedAt: number | null;
  onCite: (h: Hit) => void;
  onApproval: (requestId: string, allow: boolean) => void;
}) {
  const blocks: Block[] = m.blocks?.length ? m.blocks : m.content ? [{ type: "text", text: m.content }] : [];
  const fullText = blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  const cited = citedNumbers(fullText).filter((n) => m.hits?.[n - 1]);

  return (
    <div className="flex flex-col gap-2.5">
      {blocks.map((b, i) =>
        b.type === "text" ? (
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
                  {h.page ? ` · 第 ${h.page} 页` : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {!m.pending && (m.durationMs != null || m.costUsd != null) && (
        <div className="num text-[11px] text-text-4">
          {m.durationMs != null && `${(m.durationMs / 1000).toFixed(1)}s`}
          {m.costUsd != null && ` · $${m.costUsd.toFixed(4)}`}
          {m.hits?.length ? ` · 检索到 ${m.hits.length} 个片段` : ""}
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

/** 一次工具调用：一行摘要，可展开看输入和结果；需要审批时在下面直接给按钮 */
function ToolRow({ b, onApproval }: { b: Extract<Block, { type: "tool" }>; onApproval: Props["onApproval"] }) {
  const [open, setOpen] = useState(false);
  const short = b.name.replace("mcp__docagent__", "");
  const isSearch = short === "search_docs";
  const running = b.result == null && b.approval?.state !== "denied";
  const label = isSearch ? "检索文档" : short === "save_note" ? "保存文件" : short;
  const arg = String(isSearch ? (b.input.query ?? "") : (b.input.filename ?? ""));
  const found = isSearch && b.result ? (b.result.match(/^\[\d+\]/gm)?.length ?? 0) : null;

  const dot = b.isError || b.approval?.state === "denied"
    ? "bg-danger"
    : running
      ? "bg-warm animate-pulse"
      : "bg-good";

  return (
    <div className="text-[13px]">
      <button
        className="group flex w-full items-center gap-2 rounded-md py-0.5 text-left text-text-2 hover:text-text"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="font-medium">{label}</span>
        <span className="min-w-0 truncate text-text-3">{arg}</span>
        {found != null && <span className="num shrink-0 text-[11px] text-text-4">{found} 个片段</span>}
        <ChevronRight
          className={`ml-auto h-3.5 w-3.5 shrink-0 text-text-4 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>

      {b.approval?.state === "pending" && (
        <div className="ml-3.5 mt-2 rounded-xl border border-warm-ring bg-warm-tint-faint p-3">
          <div className="text-[13px] text-text">允许保存这个文件吗？</div>
          <div className="mt-0.5 text-[12px] text-text-3">会写到「文稿/DocAgent/{arg}」</div>
          <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-bg p-2.5 text-[12px] leading-5 text-text-2">
            {String(b.input.content ?? "").slice(0, 1500)}
          </pre>
          <div className="mt-2.5 flex justify-end gap-2">
            <button
              className="arc-btn-secondary rounded-md px-3 py-1.5 text-[12px]"
              onClick={() => onApproval(b.approval!.requestId, false)}
            >
              拒绝
            </button>
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
            {JSON.stringify(b.input, null, 2).slice(0, 1200)}
          </pre>
          {b.result != null && (
            <pre
              className={`max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-bg p-2.5 text-[12px] leading-5 ${
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
