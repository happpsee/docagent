import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, FileText, Loader2, Square } from "lucide-react";
import { citedNumbers } from "@/lib/citations";
import type { Block, Hit, Message } from "@/lib/types";
import { StreamMarkdown } from "./StreamMarkdown";
import { AutoTextarea } from "./ui/AutoTextarea";

interface Props {
  title: string | null;
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

  const empty = p.messages.length === 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      {p.title && (
        <header className="truncate border-b border-hairline-soft px-6 py-2.5 text-[13px] text-text-2">
          {p.title}
        </header>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-6 py-7">
          {empty && (
            <div className="mt-[16vh]">
              <h1 className="display-serif text-[26px] font-semibold tracking-tight text-text">
                有什么想了解的？
              </h1>
              <p className="mt-2 text-[13px] leading-6 text-text-3">
                {p.docCount
                  ? "会优先从你的文档里找答案，并标出出处；文档没讲到的，我用自己的知识补充并说明。"
                  : "可以直接聊。导入文档后，我会优先从你的资料里找答案并标出出处。"}
              </p>
              {p.docCount > 0 && (
                <div className="mt-5 flex flex-col items-start gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      className="rounded-lg px-2.5 py-1.5 text-left text-[13px] text-text-2 hover:bg-nav-card hover:text-text"
                      onClick={() => submit(s)}
                      disabled={!p.ready}
                    >
                      <span className="mr-2 text-text-4">→</span>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {p.messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-nav-card-active px-4 py-2.5 text-[14px] leading-6 text-text">
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

      <div className="mx-auto w-full max-w-[760px] px-6 pb-4">
        <div className="rounded-2xl border border-hairline-strong bg-surface-2 shadow-sm focus-within:border-accent">
          <AutoTextarea
            value={input}
            onChange={setInput}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            aria-label="输入消息"
            placeholder={p.ready ? "问点什么，或者让我帮你整理资料…" : "先在左下角「设置」里配置模型"}
            className="max-h-52 w-full resize-none bg-transparent px-4 pt-3.5 text-[14px] leading-6 text-text outline-none placeholder:text-text-4"
            disabled={!p.ready}
          />
          <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
            <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-text-3">
              <FileText className="h-3.5 w-3.5" />
              {p.docCount === 0 ? "没有文档" : p.scopeCount ? `已选 ${p.scopeCount} 份文档` : `全部 ${p.docCount} 份文档`}
            </span>
            <span className="flex-1" />
            <span className="num text-[11px] text-text-4">{p.model}</span>
            {p.busy ? (
              <button
                aria-label="停止"
                onClick={p.onStop}
                className="grid h-8 w-8 place-items-center rounded-lg bg-text text-bg"
              >
                <Square className="h-3 w-3" fill="currentColor" />
              </button>
            ) : (
              <button
                aria-label="发送"
                onClick={() => submit()}
                disabled={!input.trim() || !p.ready}
                className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-white disabled:bg-track-idle disabled:text-text-4"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-text-4">
          回答可能出错。带编号的结论来自你的文档，可以点开核对原文。
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
          <div key={i} className={`text-[14px] leading-7 ${m.error ? "text-danger" : "text-text"}`}>
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
