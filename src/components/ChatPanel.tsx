import { useEffect, useRef, useState } from "react";
import { splitCitations } from "../lib/rag";
import type { Message, SearchHit } from "../lib/types";

interface Props {
  messages: Message[];
  status: string | null;
  busy: boolean;
  onSend: (q: string) => void;
  onStop: () => void;
  onCite: (hit: SearchHit) => void;
}

export function ChatPanel({ messages, status, busy, onSend, onStop, onCite }: Props) {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  function submit() {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    onSend(q);
  }

  return (
    <section className="panel chat">
      <div className="messages">
        {!messages.length && (
          <div className="empty">
            <h3>问问你的文档</h3>
            <p>
              导入资料后直接提问。回答里的 <span className="cite">[1]</span> 可以点开，
              跳到原文出处。
            </p>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">
              {m.role === "assistant" ? (
                <Answer msg={m} onCite={onCite} />
              ) : (
                m.content
              )}
            </div>

            {m.toolCalls?.length ? (
              <div className="tools">
                {m.toolCalls.map((t, j) => (
                  <span key={j} className={`tool ${t.status}`}>
                    {t.name}
                    {t.status === "rejected" ? "（已拒绝）" : t.result ? `：${t.result}` : ""}
                  </span>
                ))}
              </div>
            ) : null}

            {m.sources?.length ? (
              <details className="sources">
                <summary>检索到 {m.sources.length} 个片段</summary>
                <ol>
                  {m.sources.map((h, j) => (
                    <li key={h.chunkId}>
                      <button className="link" onClick={() => onCite(h)}>
                        [{j + 1}] {h.docTitle}
                        {h.page ? ` 第 ${h.page} 页` : ` 第 ${h.idx + 1} 段`}
                      </button>
                      <span className="dist">距离 {h.distance.toFixed(3)}</span>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </div>
        ))}

        {status && <div className="status">{status}</div>}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
          rows={3}
        />
        {busy ? (
          <button onClick={onStop} className="danger">
            停止
          </button>
        ) : (
          <button onClick={submit} className="primary" disabled={!input.trim()}>
            发送
          </button>
        )}
      </div>
    </section>
  );
}

function Answer({ msg, onCite }: { msg: Message; onCite: (h: SearchHit) => void }) {
  const parts = splitCitations(msg.content);
  return (
    <>
      {parts.map((p, i) =>
        p.type === "text" ? (
          <span key={i}>{p.value}</span>
        ) : (
          <button
            key={i}
            className="cite"
            title={msg.sources?.[p.n - 1]?.docTitle ?? "引用"}
            onClick={() => {
              const hit = msg.sources?.[p.n - 1];
              if (hit) onCite(hit);
            }}
          >
            [{p.n}]
          </button>
        ),
      )}
      {msg.pending && <span className="caret" />}
    </>
  );
}
