import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Search, Square, X } from "lucide-react";
import { citedNumbers } from "@/lib/citations";
import type { Hit, Message } from "@/lib/types";
import { StreamMarkdown } from "./StreamMarkdown";
import { AutoTextarea } from "./ui/AutoTextarea";

interface Props {
  messages: Message[];
  status: string | null;
  busy: boolean;
  ready: boolean;
  hasDocs: boolean;
  onSend: (q: string) => void;
  onStop: () => void;
  onCite: (hit: Hit) => void;
}

const SUGGESTIONS = ["这份资料主要讲了什么？", "列出里面所有的金额和期限", "有哪些需要注意的风险条款？"];

export function ChatPanel({ messages, status, busy, ready, hasDocs, onSend, onStop, onCite }: Props) {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, status]);

  function submit(text = input) {
    const q = text.trim();
    if (!q || busy || !ready) return;
    setInput("");
    onSend(q);
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
          {!messages.length && (
            <div className="mt-[12vh] text-center">
              <h1 className="display-serif text-2xl font-semibold text-text">问问你的文档</h1>
              <p className="mt-2 text-[13px] text-text-3">
                {hasDocs
                  ? "回答只依据你导入的资料，每个结论都能点回原文。"
                  : "先点左上角「导入」添加资料，再来提问。"}
              </p>
              {hasDocs && (
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      className="arc-btn-secondary rounded-full px-3.5 py-1.5 text-[12px]"
                      onClick={() => submit(s)}
                      disabled={!ready}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[14px] leading-6 text-white">
                  {m.content}
                </div>
              </div>
            ) : (
              <Answer key={i} m={m} onCite={onCite} />
            ),
          )}

          {status && <div className="arc-shimmer-text text-[13px]">{status}</div>}
          <div ref={endRef} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-6 pb-5">
        <div className="arc-glass-panel flex items-end gap-2 rounded-2xl p-2.5">
          <AutoTextarea
            value={input}
            onChange={setInput}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            aria-label="提问"
            placeholder={ready ? "问点什么…  Enter 发送，Shift+Enter 换行" : "先在右上角「设置」里配置模型"}
            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] leading-6 text-text outline-none placeholder:text-text-4"
            disabled={!ready}
          />
          {busy ? (
            <button
              aria-label="停止"
              onClick={onStop}
              className="grid h-9 w-9 place-items-center rounded-xl bg-danger-soft text-danger"
            >
              <Square className="h-4 w-4" fill="currentColor" />
            </button>
          ) : (
            <button
              aria-label="发送"
              onClick={() => submit()}
              disabled={!input.trim() || !ready}
              className="arc-btn-primary grid h-9 w-9 place-items-center rounded-xl disabled:opacity-40"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function Answer({ m, onCite }: { m: Message; onCite: (h: Hit) => void }) {
  const cited = citedNumbers(m.content).filter((n) => m.hits?.[n - 1]);
  return (
    <div className="flex flex-col gap-2.5">
      {m.tools?.length ? (
        <div className="flex flex-col gap-1">
          {m.tools.map((t, j) => (
            <ToolLine key={j} name={t.name} input={t.input} summary={t.summary} />
          ))}
        </div>
      ) : null}

      <div className={`text-[14px] leading-7 ${m.error ? "text-danger" : "text-text"}`}>
        <StreamMarkdown content={m.content} />
        {m.pending && !m.content && <span className="arc-shimmer-text text-[13px]">思考中…</span>}
      </div>

      {cited.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {cited.map((n) => {
            const h = m.hits![n - 1];
            return (
              <button
                key={n}
                onClick={() => onCite(h)}
                className="inline-flex max-w-[260px] items-center gap-1.5 rounded-full border border-hairline bg-surface-2 px-2.5 py-1 text-[12px] text-text-2 hover:border-accent hover:text-accent"
                title={h.text.slice(0, 200)}
              >
                <span className="num grid h-4 min-w-4 place-items-center rounded bg-accent px-1 text-[10px] text-white">
                  {n}
                </span>
                <span className="truncate">
                  {h.docTitle}
                  {h.page ? ` · 第 ${h.page} 页` : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {!m.pending && m.costUsd != null && (
        <div className="num text-[11px] text-text-4">
          检索到 {m.hits?.length ?? 0} 个片段 · 本次 ${m.costUsd.toFixed(4)}
        </div>
      )}
    </div>
  );
}

function ToolLine({ name, input, summary }: { name: string; input: Record<string, unknown>; summary?: string }) {
  const short = name.replace("mcp__docagent__", "");
  const isSearch = short === "search_docs";
  const denied = summary?.includes("拒绝");
  return (
    <div className="flex items-center gap-2 text-[12px] text-text-3">
      {isSearch ? (
        <Search className="h-3.5 w-3.5 text-text-4" />
      ) : denied ? (
        <X className="h-3.5 w-3.5 text-danger" />
      ) : (
        <Check className="h-3.5 w-3.5 text-good" />
      )}
      <span>
        {isSearch ? "检索" : "保存文件"}
        <span className="text-text-2">
          {" "}
          {String(isSearch ? (input.query ?? "") : (input.filename ?? ""))}
        </span>
      </span>
    </div>
  );
}
