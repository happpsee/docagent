import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, GraduationCap, Loader2, MessageCircleQuestion, X } from "lucide-react";
import * as api from "@/lib/api";
import { MOD } from "@/lib/keys";
import type { QuizItem, QuizResult } from "@/lib/types";

const GRADE: Record<QuizResult["grade"], { name: string; tone: string }> = {
  recalled: { name: "答对了", tone: "bg-[#4f8a5b1f] text-good" },
  partial: { name: "差一点", tone: "bg-[#c9952a26] text-[#9a6f12]" },
  lapsed: { name: "没答上来", tone: "bg-[#c2603c1f] text-danger" },
};

/** 下次复习是什么时候，说成人话 */
export function dueText(due: number, now = Date.now() / 1000): string {
  const days = (due - now) / 86400;
  if (days < 0.04) return "过一会儿";
  if (days < 0.6) return "今天晚些时候";
  if (days < 1.5) return "明天";
  if (days < 30) return `${Math.round(days)} 天后`;
  return `${Math.round(days / 30)} 个月后`;
}

/** 一轮问答：浮在右下角，不挡书页。一题一题来——用自己的话答，交上去对照原文批改，
 *  每条评分要点答没答到都列出来，可以点回原文；最后说一共答得怎么样、下次什么时候复习 */
export function QuizSession(p: {
  title: string;
  /** 取这一轮的题（读完一段是现出的，要等模型；复习是存着的） */
  load: () => Promise<QuizItem[]>;
  /** 复习：答过的题换个问法再考（每题要等模型现出，出不来就用原题） */
  fresh?: boolean;
  /** 靠右留多少（阅读时右边有对话栏） */
  right: number;
  bookTitle: (bookId: string) => string;
  onShowSource: (item: QuizItem) => void;
  /** 批改完一题：掌握度变了 */
  onAnswered: () => void;
  /** 没答好：让助手针对没答到的地方讲一讲 */
  onExplain: (item: QuizItem, answer: string, result: QuizResult) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<QuizItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<(QuizResult | undefined)[]>([]);
  /** 还在换问法的那几题（按序号） */
  const [swapping, setSwapping] = useState<Set<number>>(new Set());
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let dead = false;
    p.load().then(
      (list) => {
        if (dead) return;
        setItems(list);
        if (!p.fresh) return;
        setSwapping(new Set(list.map((_, i) => i)));
        list.forEach((old, i) => {
          const settle = (next: QuizItem) => {
            if (dead) return;
            setItems((cur) => cur && cur.map((x, j) => (j === i ? next : x)));
            setSwapping((cur) => new Set([...cur].filter((j) => j !== i)));
          };
          api.quizVariant(old.id).then(settle, () => settle(old));
        });
      },
      (err) => !dead && setError(String(err)),
    );
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    box.current?.focus();
  }, [at, items]);

  const waiting = swapping.has(at);
  const item = waiting ? undefined : items?.[at];
  const result = results[at];
  const finished = items != null && at >= items.length;

  async function submit(text: string) {
    if (!item || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.quizAnswer(item.id, text);
      setResults((list) => {
        const next = [...list];
        next[at] = r;
        return next;
      });
      p.onAnswered();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const done = results.filter(Boolean) as QuizResult[];
  const count = (g: QuizResult["grade"]) => done.filter((r) => r.grade === g).length;

  return (
    <div
      className="fixed bottom-5 z-40 flex max-h-[min(640px,calc(100vh-90px))] w-[420px] flex-col rounded-2xl border border-hairline-strong bg-surface-2 shadow-[0_18px_50px_-12px_rgb(0_0_0/0.4)]"
      style={{ right: p.right }}
      role="dialog"
      aria-label={p.title}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline-soft px-4 py-2.5">
        <GraduationCap className="h-4 w-4 text-accent" />
        <span className="text-[13px] font-medium text-text">{p.title}</span>
        {items && !finished && (
          <span className="num text-[11px] text-text-4">
            {at + 1} / {items.length}
          </span>
        )}
        <span className="flex-1" />
        <button className="grid h-6 w-6 place-items-center rounded-md text-text-3 hover:bg-nav-card hover:text-text" aria-label="关闭" onClick={p.onClose}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        {!items && !error && (
          <div className="flex items-center gap-2 py-6 text-[12.5px] text-text-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在根据这一段出题…
          </div>
        )}
        {waiting && (
          <div className="flex items-center gap-2 py-6 text-[12.5px] text-text-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            换个问法再考你…
          </div>
        )}
        {items && !items.length && <p className="py-6 text-[12.5px] text-text-3">现在没有该复习的。</p>}

        {item && (
          <>
            <div className="flex items-center gap-1.5 text-[11px] text-text-4">
              <span className="rounded-full bg-accent-dim px-1.5 py-px text-accent">{item.concept}</span>
              <span className="truncate">《{p.bookTitle(item.bookId)}》</span>
            </div>
            <p className="mt-2 text-[14px] leading-relaxed text-text">{item.question}</p>

            {!result ? (
              <>
                <textarea
                  ref={box}
                  className="mt-3 h-28 w-full resize-none rounded-lg border border-hairline bg-bg px-3 py-2 text-[13px] leading-relaxed text-text outline-none placeholder:text-text-4 focus:border-accent"
                  placeholder={`用自己的话答，不用和原文一样。${MOD}↩ 提交`}
                  value={answer}
                  disabled={busy}
                  onChange={(e) => setAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && answer.trim()) void submit(answer);
                  }}
                />
                <div className="mt-2 flex items-center gap-2">
                  <button className="text-[12px] text-text-3 hover:text-text disabled:opacity-40" disabled={busy} onClick={() => void submit("")}>
                    不会，看答案
                  </button>
                  <span className="flex-1" />
                  <button
                    className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[13px] text-white hover:bg-accent-2 disabled:opacity-40"
                    disabled={busy || !answer.trim()}
                    onClick={() => void submit(answer)}
                  >
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {busy ? "批改中" : "提交"}
                  </button>
                </div>
              </>
            ) : (
              <>
                {answer.trim() && <p className="mt-3 rounded-lg bg-bg px-3 py-2 text-[12.5px] leading-relaxed text-text-2">{answer}</p>}
                <div className="mt-3 flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[12px] font-medium ${GRADE[result.grade].tone}`}>{GRADE[result.grade].name}</span>
                  <span className="text-[11px] text-text-4">{dueText(result.due)}再考</span>
                </div>
                {result.feedback && <p className="mt-2 text-[13px] leading-relaxed text-text">{result.feedback}</p>}
                <ul className="mt-2.5 space-y-1">
                  {item.rubric.map((r) => {
                    const miss = result.missing.includes(r);
                    return (
                      <li key={r} className={`flex gap-1.5 text-[12.5px] leading-relaxed ${miss ? "text-text" : "text-text-3"}`}>
                        {miss ? <X className="mt-[3px] h-3.5 w-3.5 shrink-0 text-danger" /> : <Check className="mt-[3px] h-3.5 w-3.5 shrink-0 text-good" />}
                        {r}
                      </li>
                    );
                  })}
                </ul>
                <button
                  className="mt-3 block w-full rounded-lg border border-hairline px-3 py-2 text-left hover:border-accent"
                  title="翻到原文这一句"
                  onClick={() => p.onShowSource(item)}
                >
                  <span className="flex items-center gap-1 text-[11px] text-text-4">
                    <BookOpen className="h-3 w-3" />
                    原文
                  </span>
                  <span className="display-serif mt-0.5 block text-[13px] leading-relaxed text-text-2">“{item.evidence}”</span>
                </button>
                <div className="mt-3 flex items-center justify-between">
                  {result.grade !== "recalled" ? (
                    <button className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline" onClick={() => p.onExplain(item, answer, result)}>
                      <MessageCircleQuestion className="h-3.5 w-3.5" />
                      让助手讲讲我没答到的
                    </button>
                  ) : (
                    <span />
                  )}
                  <button
                    className="rounded-lg bg-accent px-3.5 py-1.5 text-[13px] text-white hover:bg-accent-2"
                    onClick={() => {
                      setAnswer("");
                      setAt(at + 1);
                    }}
                  >
                    {at + 1 < (items?.length ?? 0) ? "下一题" : "看结果"}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {finished && items.length > 0 && (
          <div className="py-3 text-center">
            <div className="display-serif text-[16px] text-text">这一轮答完了</div>
            <div className="mt-3 flex justify-center gap-2 text-[12px]">
              {(["recalled", "partial", "lapsed"] as const).map(
                (g) =>
                  count(g) > 0 && (
                    <span key={g} className={`rounded-full px-2 py-0.5 ${GRADE[g].tone}`}>
                      {GRADE[g].name} {count(g)}
                    </span>
                  ),
              )}
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-text-3">
              {count("lapsed") + count("partial") > 0 ? "没答好的过一阵会再考你；答对的会隔得越来越久。" : "都答对了。这些会隔得越来越久再考你。"}
            </p>
            <button className="mt-4 rounded-lg border border-hairline px-4 py-1.5 text-[13px] text-text-2 hover:border-accent hover:text-accent" onClick={p.onClose}>
              好
            </button>
          </div>
        )}

        {error && <p className="mt-3 break-all text-[12.5px] leading-relaxed text-danger">{error}</p>}
      </div>
    </div>
  );
}
