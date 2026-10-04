import { useEffect } from "react";
import { Sparkles, X } from "lucide-react";

/** 助手主动提的一条建议：考几道题、讲一讲、先复习。它为什么现在提，写在那句话里。
 *  不点也没关系，一分钟后自己收起来（算作这次不需要，下次会隔得更久再提）。 */
export function SuggestionCard(p: {
  message: string;
  /** 「开始」那个按钮上写什么 */
  go: string;
  /** 靠左多少（读书时避开右边的对话栏） */
  center: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(p.onDismiss, 60_000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.message]);

  return (
    <div
      className="fixed bottom-14 z-30 flex max-w-[min(520px,calc(100vw-48px))] -translate-x-1/2 items-center gap-2 rounded-full border border-hairline-strong bg-surface-2 py-1.5 pl-3.5 pr-1.5 text-[12.5px] text-text shadow-[0_8px_28px_-8px_rgb(0_0_0/0.35)]"
      style={{ left: p.center }}
      role="status"
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
      <span className="min-w-0 leading-snug">{p.message}</span>
      <button className="shrink-0 rounded-full bg-accent px-3 py-1 text-[12.5px] text-white hover:bg-accent-2" onClick={p.onAccept}>
        {p.go}
      </button>
      <button className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-text-3 hover:bg-nav-card hover:text-text" aria-label="这次不用" title="这次不用（之后会隔得更久再提）" onClick={p.onDismiss}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
