import { useEffect, useId, useState } from "react";
import { ArrowDown, ArrowUp, FolderOpen, MessageSquare, RefreshCw, Split, Trash2 } from "lucide-react";
import * as api from "@/lib/api";
import type { Book, Doc, Session } from "@/lib/types";
import { Cover } from "./Library";
import { GlassModal } from "./ui/GlassModal";
import { ModalCloseButton } from "./ui/ModalCloseButton";
import { PrimaryButton } from "./ui/PrimaryButton";
import { SecondaryButton } from "./ui/SecondaryButton";

interface Props {
  book: Book;
  /** 这本书的对话 */
  sessions: Session[];
  onClose: () => void;
  /** 改了书名、封面、各篇之后让上层重新取数据 */
  onChanged: () => void;
  onOpen: (book: Book, docId?: string) => void;
  onOpenSession: (s: Session) => void;
  /** 移除要先确认（会删笔记），交给上层弹确认框 */
  onRemove: (book: Book) => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}

const inputCls =
  "mt-1 w-full rounded-md border border-hairline bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-accent";

/** 一本书的详情：封面、书名和作者、防剧透、各篇、这本书的对话，以及移除。
 *  书架上「换封面、删书、看这本书聊过什么」都在这一个地方 */
export function BookInfoModal({ book, sessions, onClose, onChanged, onOpen, onOpenSession, onRemove, onNotice, onError }: Props) {
  const titleId = useId();
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [working, setWorking] = useState<string | null>(null);
  // 外面刷新了数据（比如换了封面）之后，输入框跟上最新的书名，但不打断正在输入的内容
  useEffect(() => {
    setTitle(book.title);
    setAuthor(book.author ?? "");
  }, [book.id, book.title, book.author]);

  const dirty = title.trim() !== book.title || author.trim() !== (book.author ?? "");
  const multi = book.docs.length > 1;

  /** 做一件事：期间按钮不可点，出错报给上层，做完刷新 */
  async function run(label: string, fn: () => Promise<unknown>) {
    setWorking(label);
    try {
      await fn();
      onChanged();
    } catch (err) {
      onError(String(err));
    } finally {
      setWorking(null);
    }
  }

  const saveMeta = () =>
    run("save", async () => {
      if (!title.trim()) throw new Error("书名不能是空的");
      await api.updateBook(book.id, title.trim(), author.trim() || null);
    });

  const rescan = () =>
    run("rescan", async () => {
      const r = await api.rescanBook(book.id);
      // 「有几个文件已经在另一本书里」每次更新都一样，只在第一次导入时说
      onNotice(summaryText({ ...r, skipped: [] }));
      // 没解析成功的文件要说出来，不然用户看到「没有变化」，不知道为什么那个文件没进来
      if (r.failed.length) onError(`有 ${r.failed.length} 个文件没更新成功：${r.failed.slice(0, 3).join("；")}`);
    });

  const location = book.folder ?? book.docs[0]?.path ?? null;
  const link = "text-[12px] text-accent hover:underline disabled:opacity-40";

  return (
    <GlassModal open onClose={onClose} labelledBy={titleId} widthClassName="w-full max-w-[640px]">
      <div className="flex items-center justify-between px-5 pt-5">
        <h2 id={titleId} className="text-[15px] font-semibold text-text">
          书的详情
        </h2>
        <ModalCloseButton onClick={onClose} />
      </div>

      <div className="max-h-[70vh] overflow-y-auto px-5 py-4 text-[12px] text-text-2">
        <div className="flex gap-5">
          <div className="w-[128px] shrink-0">
            <Cover book={book} className="aspect-[5/7] w-full text-[13px]" />
            <div className="mt-2.5 flex flex-col items-start gap-1">
              <button
                className={link}
                disabled={!!working}
                onClick={() =>
                  void run("cover", async () => {
                    await api.pickBookCover(book.id);
                  })
                }
              >
                更换封面…
              </button>
              {book.customCover && (
                <button className={link} disabled={!!working} onClick={() => void run("cover", () => api.clearBookCover(book.id))}>
                  恢复默认
                </button>
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1 space-y-3">
            <label className="block">
              书名
              <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="block">
              作者
              <input className={inputCls} value={author} placeholder="没有可以不填" onChange={(e) => setAuthor(e.target.value)} />
            </label>
            {dirty && (
              <div className="flex justify-end">
                <PrimaryButton size="sm" disabled={!!working} onClick={() => void saveMeta()}>
                  保存书名和作者
                </PrimaryButton>
              </div>
            )}

            <div>
              <div className="flex items-center gap-2">
                <span>{book.folder ? "文件夹" : "文件"}</span>
                <button className={link} onClick={() => void api.revealBook(book.id).catch((err) => onError(String(err)))}>
                  在访达中显示
                </button>
                <button className={link} disabled={!!working} onClick={() => void run("relocate", () => api.relocateBook(book.id))}>
                  挪了地方？重新指定…
                </button>
              </div>
              <div className="num mt-1 break-all text-[11px] leading-relaxed text-text-4">{location ?? "找不到原来的位置"}</div>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-hairline px-3 py-2.5">
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--color-accent)]"
                checked={book.spoilerFree}
                disabled={!!working}
                onChange={(e) => void run("spoiler", () => api.setBookSpoiler(book.id, e.target.checked))}
              />
              <span>
                <span className="text-[13px] text-text">防剧透</span>
                {book.spoilerDefault && <span className="ml-1.5 text-text-4">（按这本书的类型默认{book.spoilerFree ? "开" : "关"}）</span>}
                <span className="mt-0.5 block leading-relaxed text-text-3">
                  开着的时候，透视只显示你读过的部分，助手也只用读过的部分回答。读小说开着，查合同、看文档关掉。
                </span>
              </span>
            </label>
          </div>
        </div>

        <section className="mt-5">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-text">{multi ? `这本书的 ${book.docs.length} 篇` : "文件"}</span>
            <span className="flex-1" />
            {book.folder && book.scan !== "none" && (
              <button className={`${link} inline-flex items-center gap-1`} disabled={!!working} onClick={() => void rescan()}>
                <RefreshCw className={`h-3 w-3 ${working === "rescan" ? "animate-spin" : ""}`} />
                按文件夹现在的样子更新
              </button>
            )}
            {multi && (
              <button
                className={`${link} inline-flex items-center gap-1`}
                disabled={!!working}
                title="每一篇变回单独的一本书，笔记和进度跟着各自的篇走"
                onClick={() => {
                  if (!confirm(`把《${book.title}》拆成 ${book.docs.length} 本单独的书？\n笔记、划线和阅读进度都会跟着各自的篇保留。`)) return;
                  void run("split", async () => {
                    await api.splitBook(book.id);
                    onClose();
                  });
                }}
              >
                <Split className="h-3 w-3" />
                拆成单独的书
              </button>
            )}
          </div>
          <ul className="mt-2 divide-y divide-hairline-soft rounded-lg border border-hairline">
            {book.docs.map((d, i) => (
              <PartRow
                key={d.id}
                doc={d}
                multi={multi}
                first={i === 0}
                last={i === book.docs.length - 1}
                busy={!!working}
                onOpen={() => {
                  onClose();
                  onOpen(book, d.id);
                }}
                onMove={(delta) => void run("move", () => api.movePart(d.id, delta))}
                onReveal={() => void api.revealDoc(d.id).catch((err) => onError(String(err)))}
                onRemove={() => {
                  const extra = book.folder && book.scan !== "none" ? "之后按文件夹更新也不会再把它加回来。" : "";
                  if (!confirm(`把「${d.name}」从这本书里移除？\n这一篇上的划线、笔记和阅读进度会一起删掉，原文件不动。${extra}`)) return;
                  void run("remove-part", () => api.deleteDocument(d.id));
                }}
              />
            ))}
          </ul>
        </section>

        <section className="mt-5">
          <div className="text-[13px] font-medium text-text">这本书的对话</div>
          {sessions.length ? (
            <ul className="mt-2 divide-y divide-hairline-soft rounded-lg border border-hairline">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-text-2 hover:bg-nav-card hover:text-text"
                    onClick={() => {
                      onClose();
                      onOpenSession(s);
                    }}
                  >
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-text-4" />
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    <span className="num shrink-0 text-[11px] text-text-4">{ago(s.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-text-4">还没有。打开这本书，在右边问点什么，那段对话就会归在这本书下面。</p>
          )}
        </section>
      </div>

      <div className="flex items-center gap-2 border-t border-hairline px-5 py-3.5">
        <button className="inline-flex items-center gap-1.5 text-[12px] text-danger hover:underline" onClick={() => onRemove(book)}>
          <Trash2 className="h-3.5 w-3.5" />
          从书架移除…
        </button>
        <span className="flex-1" />
        <SecondaryButton size="sm" onClick={onClose}>
          关闭
        </SecondaryButton>
        <PrimaryButton
          size="sm"
          onClick={() => {
            onClose();
            onOpen(book);
          }}
        >
          打开阅读
        </PrimaryButton>
      </div>
    </GlassModal>
  );
}

function PartRow(p: {
  doc: Doc;
  multi: boolean;
  first: boolean;
  last: boolean;
  busy: boolean;
  onOpen: () => void;
  onMove: (delta: -1 | 1) => void;
  onReveal: () => void;
  onRemove: () => void;
}) {
  const d = p.doc;
  const facts = [
    d.kind.toUpperCase(),
    d.pages ? `${d.pages} 页` : null,
    d.progress != null ? (d.progress >= 0.995 ? "读完" : `读到 ${Math.round(d.progress * 100)}%`) : "没读过",
  ].filter(Boolean);
  const icon = "grid h-6 w-6 place-items-center rounded text-text-4 hover:bg-nav-card hover:text-text disabled:opacity-30";
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <button className="min-w-0 flex-1 text-left" onClick={p.onOpen} disabled={d.missing} title={d.missing ? "原文件找不到了，打不开" : "从这一篇开始读"}>
        <div className={`truncate text-[13px] ${d.missing ? "text-text-4" : "text-text hover:text-accent"}`}>{p.multi ? d.name : d.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-text-4">
          <span>{facts.join(" · ")}</span>
          {d.missing && <span className="text-danger">原文件找不到了（笔记还在）</span>}
          {!d.missing && d.chunkCount === 0 && <span>没有可检索的文字</span>}
        </div>
      </button>
      {p.multi && (
        <>
          <button className={icon} aria-label="往前挪" title="往前挪" disabled={p.first || p.busy} onClick={() => p.onMove(-1)}>
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button className={icon} aria-label="往后挪" title="往后挪" disabled={p.last || p.busy} onClick={() => p.onMove(1)}>
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      <button className={icon} aria-label="在访达中显示这个文件" title="在访达中显示" disabled={d.missing} onClick={p.onReveal}>
        <FolderOpen className="h-3.5 w-3.5" />
      </button>
      {p.multi && (
        <button className={`${icon} hover:text-danger`} aria-label={`移除「${d.name}」`} title="从这本书里移除" disabled={p.busy} onClick={p.onRemove}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}

/** 移除一本书前的确认：说清楚会删什么、不会删什么，对话要不要一起删由用户定 */
export function RemoveBookDialog(p: { book: Book; onCancel: () => void; onConfirm: (withSessions: boolean) => void }) {
  const titleId = useId();
  const [withSessions, setWithSessions] = useState(false);
  const { book } = p;
  return (
    <GlassModal open onClose={p.onCancel} labelledBy={titleId} hairlineTone="warm" widthClassName="w-full max-w-[420px]">
      <div className="px-5 pb-4 pt-5">
        <h2 id={titleId} className="text-[15px] font-semibold text-text">
          从书架移除《{book.title}》？
        </h2>
        <ul className="mt-3 space-y-1.5 text-[13px] leading-relaxed text-text-2">
          <li>
            会删掉：这本书上的{book.noteCount > 0 ? ` ${book.noteCount} 条划线、笔记和书签` : "划线、笔记和书签"}，阅读进度，透视结果。
          </li>
          <li>不会动：磁盘上的原文件{book.docs.length > 1 ? `（${book.docs.length} 个）` : ""}。</li>
        </ul>
        {book.sessionCount > 0 && (
          <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-hairline px-3 py-2.5 text-[13px] text-text-2">
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--color-accent)]"
              checked={withSessions}
              onChange={(e) => setWithSessions(e.target.checked)}
            />
            <span>
              同时删除这本书的 {book.sessionCount} 个对话
              <span className="mt-0.5 block text-[12px] text-text-4">不勾的话对话会留着，归到「其它对话」里，里面的引用不能再点开。</span>
            </span>
          </label>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3.5">
        <SecondaryButton size="sm" onClick={p.onCancel}>
          取消
        </SecondaryButton>
        <PrimaryButton size="sm" tone="danger" onClick={() => p.onConfirm(withSessions)}>
          移除
        </PrimaryButton>
      </div>
    </GlassModal>
  );
}

export function ago(ts: number): string {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

/** 导入 / 更新之后给用户看的一句话 */
export function summaryText(r: { added: number; updated: number; unchanged: number; missing: number; skipped: string[]; failed: string[] }): string {
  const parts = [
    r.added ? `新增 ${r.added} 篇` : null,
    r.updated ? `更新 ${r.updated} 篇` : null,
    r.missing ? `${r.missing} 篇的原文件找不到了（笔记还留着）` : null,
    ...r.skipped,
  ].filter(Boolean);
  if (!parts.length) return r.unchanged ? "都是最新的，没有变化" : "没有可导入的内容";
  return parts.join("；");
}
