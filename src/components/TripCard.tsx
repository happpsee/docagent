import { useEffect, useState } from "react";
import { BookCheck, Loader2, X } from "lucide-react";
import * as api from "@/lib/api";
import type { Trip } from "@/lib/types";

/** 合上书时的小结：这一程读了多久、往前读了多少、划了几句、答了几题。
 *  划的句子在后台变成复习题（一次模型调用），过一阵和别的题一起来考你 */
export function TripCard(p: {
  bookId: string;
  title: string;
  minutes: number;
  /** 这一程往前读了多少（0–1，可能是 0） */
  gained: number;
  trip: Trip;
  /** 故事类的书不把划线变成题 */
  makeQuestions: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { trip } = p;
  const [made, setMade] = useState<number | null>(null);
  const [working, setWorking] = useState(p.makeQuestions && trip.pendingMarks > 0);

  useEffect(() => {
    if (!working) return;
    let dead = false;
    api.quizFromMarks(p.bookId).then(
      (n) => {
        if (dead) return;
        setMade(n);
        setWorking(false);
        if (n > 0) p.onChanged();
      },
      () => !dead && setWorking(false),
    );
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const answered = trip.recalled + trip.partial + trip.lapsed;
  const parts = [
    p.minutes >= 1 ? `读了 ${p.minutes} 分钟` : null,
    p.gained >= 0.01 ? `往前读了 ${Math.round(p.gained * 100)}%` : null,
    trip.highlights > 0 ? `划下 ${trip.highlights} 句` : null,
    answered > 0 ? `答了 ${answered} 题，对 ${trip.recalled} 题` : null,
  ].filter(Boolean);

  return (
    <div className="fixed bottom-5 left-1/2 z-40 w-[min(460px,calc(100vw-40px))] -translate-x-1/2 rounded-2xl border border-hairline-strong bg-surface-2 px-4 py-3.5 shadow-[0_18px_50px_-12px_rgb(0_0_0/0.4)]" role="status">
      <div className="flex items-center gap-2">
        <BookCheck className="h-4 w-4 text-accent" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">这一程读完了 · 《{p.title}》</span>
        <button className="grid h-6 w-6 place-items-center rounded-md text-text-3 hover:bg-nav-card hover:text-text" aria-label="关闭" onClick={p.onClose}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-text-2">{parts.join("，")}。</p>
      {working && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-text-3">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在把你划的 {trip.pendingMarks} 句整理成复习题…
        </p>
      )}
      {made != null && made > 0 && <p className="mt-1.5 text-[12px] text-good">有 {made} 句划线排进了复习，过一阵来考你。</p>}
      {trip.partial + trip.lapsed > 0 && <p className="mt-1.5 text-[12px] text-text-3">没答好的 {trip.partial + trip.lapsed} 题会更早再来问你。</p>}
    </div>
  );
}
