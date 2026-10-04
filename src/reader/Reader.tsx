import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Bookmark,
  BookmarkCheck,
  ChevronLeft,
  ChevronRight,
  List,
  NotebookPen,
  ScanSearch,
  Search,
  Sparkles,
  Type,
  Undo2,
} from "lucide-react";
import { Overlayer } from "@/vendor/foliate-js/overlayer.js";
import * as CFI from "@/vendor/foliate-js/epubcfi.js";
import * as api from "@/lib/api";
import {
  DEFAULT_READER_PREFS,
  type Annotation,
  type Book,
  type Doc,
  type HighlightColor,
  type HighlightStyle,
  type ReaderCommand,
  type ReaderPrefs,
  type ReadingInfo,
} from "@/lib/types";
import { ModalCloseButton } from "@/components/ui/ModalCloseButton";
import { anchorOf, applyPrefs, CITE_COLOR, HL, loadEngine, locateQuote, openSource, THEMES, type FoliateView } from "./engine";
import { BookmarksPanel, NotesPanel, SearchPanel, TocPanel, type SearchGroup } from "./panels";
import { SelectionPopup, type PopupState } from "./SelectionPopup";
import { PrefsPopover } from "./PrefsPopover";
import { notesMarkdown } from "./export";
import { readBoundaries } from "@/lib/scope";
import { figuresOf, lookup, useXRay, visibleUnits, XRayPanel } from "./XRay";

export type SelectionAction = "ask" | "explain" | "related";

export interface ReadTarget {
  docId: string;
  /** 要跳到的页（PDF）或第几节（EPUB） */
  page?: number | null;
  /** 要高亮的原文片段（来自引用） */
  quote?: string;
  /** 直接给出书内位置（从笔记跳过来） */
  cfi?: string;
  /** 翻到这一篇的几分之几处（从透视的要点跳过来，那一篇没有页码时用） */
  fraction?: number;
  /** 同一位置重复点击时也要重新定位，用它触发 */
  nonce: number;
}

interface Props {
  /** 正在读的书，和现在开着的是它的哪一篇。引擎一次只开一篇（一个文件） */
  book: Book;
  doc: Doc;
  /** 左边开着哪个面板。由上层保管：换一篇会重建阅读器，面板不该跟着关掉 */
  panel: Panel | null;
  onPanel: (p: Panel | null) => void;
  target: ReadTarget;
  /** 外面改了笔记（比如把助手的回答存成笔记）时加一，阅读器重新读一遍 */
  notesVersion: number;
  /** 助手交代的事（划线、翻到某处）；做完用 onCommandDone 回话 */
  command: ReaderCommand | null;
  onCommandDone: (callId: string, ok: boolean, message: string) => void;
  /** 翻页时报告当前位置，提问时带给助手 */
  onLocation: (info: ReadingInfo) => void;
  onClose: () => void;
  /** 用户对选中的文字发起操作 */
  onSelection: (action: SelectionAction, text: string, page: number | null, cfi: string) => void;
  /** 就这本书向助手提一个问题（一键动作、整理笔记等）。title：为它新开对话时用的标题 */
  onAsk: (prompt: string, title?: string) => void;
  /** 翻到这本书的另一篇（可以带着要去的位置） */
  onOpenPart: (docId: string, at?: Partial<Omit<ReadTarget, "docId" | "nonce">>) => void;
  /** 打开这本书的详情（封面、书名、各篇、移除） */
  onInfo: () => void;
  /** 改这本书的防剧透开关 */
  onSpoiler: (on: boolean) => void;
  /** 进度、封面变了，书架要刷新 */
  onBooksChanged: () => void;
  onError: (message: string) => void;
}

/** relocate 事件带出来的当前位置 */
interface Loc {
  fraction: number;
  cfi: string;
  range?: Range;
  tocItem?: { label: string; href: string } | null;
  pageItem?: { label: string } | null;
  section?: { current: number; total: number };
  location?: { current: number; next: number; total: number };
}

export type Panel = "toc" | "xray" | "notes" | "bookmarks" | "search";

/** 一键动作：不用想怎么问，点一下就把这句话连同当前位置交给助手 */
const QUICK: { name: string; prompt: string }[] = [
  { name: "总结这一章", prompt: "总结我正在读的这一章：先用三句话说清讲了什么，再列出三到五个要点。" },
  { name: "梳理人物关系", prompt: "梳理到我读到的位置为止出现过的人物：每个人是谁、彼此是什么关系。不要提我还没读到的内容。" },
  { name: "这一章和前面的呼应", prompt: "我正在读的这一章，和前面的内容有哪些呼应、伏笔或者矛盾？指出具体的地方。" },
  { name: "出几道题考考我", prompt: "根据我正在读的这一章出三道题考我，先只出题，等我回答后再讲解。" },
];
const PREFS_KEY = "reader";
const NOTE_PREFIX = "foliate-note:";
const CITE_ID = "__cite__";
const SEARCH_CAP = 500;

/** 阅读器：所有格式都走同一个排版引擎，所以目录、搜索、高亮、笔记、书签、进度记忆对每种格式都一样。 */
export function Reader({
  book,
  doc,
  panel,
  onPanel: setPanel,
  target,
  notesVersion,
  command,
  onCommandDone,
  onLocation,
  onClose,
  onSelection,
  onAsk,
  onOpenPart,
  onInfo,
  onSpoiler,
  onBooksChanged,
  onError,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [loc, setLoc] = useState<Loc | null>(null);
  const [toc, setToc] = useState<api.TocItem[]>([]);
  const [fixed, setFixed] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefs, setPrefs] = useState<ReaderPrefs>(DEFAULT_READER_PREFS);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [footnote, setFootnote] = useState<{ x: number; y: number } | null>(null);
  const footnoteBox = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchGroup[]>([]);
  const [searching, setSearching] = useState(false);
  /** 搜完了没有：区分「还没搜」和「搜了但没找到」 */
  const [searched, setSearched] = useState<null | { capped: boolean }>(null);
  /** 拖进度条时先只动滑块，松手才真的跳 */
  const [drag, setDrag] = useState<number | null>(null);
  /** 每条标记在第几节，算一次记下来 */
  const sectionOf = useRef(new Map<string, number>());
  const footnoteView = useRef<FoliateView | null>(null);
  const [showQuick, setShowQuick] = useState(false);
  const { xray, building, build, rebuild } = useXRay(book.id, onError);
  /** 这本书别的篇上的标记：只给笔记、书签面板列出来用。
   *  画到书页上、判断「这一屏有没有书签」只看当前这一篇的——不同篇的位置编码长得一样，混在一起会画错地方 */
  const [others, setOthers] = useState<Annotation[]>([]);
  const lastPage = useRef<number | null>(null);
  const multi = book.docs.length > 1;
  // 上一篇 / 下一篇跳过原文件找不到的（目录里它们也是灰的）
  const prevPart = [...book.docs].reverse().find((d) => !d.missing && d.position < doc.position) ?? null;
  const nextPart = book.docs.find((d) => !d.missing && d.position > doc.position) ?? null;
  /** 这一篇读到过的最远处（位置和页码）。书架那份数据是打开时取的，读的过程中不会更新，
   *  所以在这儿自己记：往回翻的时候，防剧透不能把这次刚读过的部分又藏起来 */
  const [seen, setSeen] = useState<{ fraction: number; page: number | null }>({ fraction: doc.furthest, page: doc.furthestPage });
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const onLocationRef = useRef(onLocation);
  onLocationRef.current = onLocation;
  const searchRun = useRef(0);
  const [lastStyle, setLastStyle] = useState<{ color: HighlightColor; style: HighlightStyle }>({
    color: "yellow",
    style: "highlight",
  });

  // 引擎的事件回调里要读最新值
  const annRef = useRef<Annotation[]>([]);
  annRef.current = annotations;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const locRef = useRef<Loc | null>(null);
  locRef.current = loc;
  const citeRef = useRef<string | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;

  const theme = THEMES[prefs.theme];

  /** 把一条标记画到书页上（先擦掉旧的） */
  const draw = useCallback((a: Annotation) => {
    const view = viewRef.current;
    if (!view || a.kind !== "highlight") return;
    void view.addAnnotation({ value: a.cfi, id: a.id }).catch(() => {});
    if (a.note) void view.addAnnotation({ value: NOTE_PREFIX + a.cfi, id: a.id }).catch(() => {});
    else void view.deleteAnnotation({ value: NOTE_PREFIX + a.cfi }).catch(() => {});
  }, []);

  /** 标记在第几节（算不出来返回 -1，那就每节都试着画） */
  const indexOf = useCallback((a: Annotation) => {
    const known = sectionOf.current.get(a.id);
    if (known != null) return known;
    let index = -1;
    try {
      index = viewRef.current?.resolveCFI(a.cfi)?.index ?? -1;
    } catch {
      // 位置解析不了
    }
    sectionOf.current.set(a.id, index);
    return index;
  }, []);

  const erase = useCallback((a: Annotation) => {
    const view = viewRef.current;
    if (!view) return;
    void view.deleteAnnotation({ value: a.cfi }).catch(() => {});
    void view.deleteAnnotation({ value: NOTE_PREFIX + a.cfi }).catch(() => {});
  }, []);

  /** 跳到引用的原文并标出来 */
  const showCitation = useCallback(async (view: FoliateView, t: ReadTarget) => {
    if (t.cfi) {
      await view.goTo(t.cfi);
      return;
    }
    if (!t.quote) {
      if (t.page) await view.goTo(t.page - 1);
      else if (t.fraction != null) await view.goToFraction(t.fraction);
      return;
    }
    const cfi = await locateQuote(view, t.quote, t.page);
    if (citeRef.current) void view.deleteAnnotation({ value: citeRef.current }).catch(() => {});
    citeRef.current = cfi;
    if (!cfi) {
      if (t.page) await view.goTo(t.page - 1);
      else if (t.fraction != null) await view.goToFraction(t.fraction);
      return;
    }
    await view.goTo(cfi);
    void view.addAnnotation({ value: cfi, id: CITE_ID }).catch(() => {});
  }, []);

  // 打开一本书
  useEffect(() => {
    let dead = false;
    let view: FoliateView | null = null;
    let saveTimer = 0;
    setReady(false);
    setFailed(null);
    setLoc(null);
    setToc([]);
    setPopup(null);
    setResults([]);
    setQuery("");
    citeRef.current = null;
    let opened: { destroy?: () => void } | null = null;

    void (async () => {
      try {
        const [, saved, notes, rawPrefs] = await Promise.all([
          loadEngine(),
          api.readingState(doc.id).catch(() => null),
          api.listAnnotations({ docId: doc.id }).catch(() => []),
          api.getSetting(PREFS_KEY).catch(() => null),
        ]);
        const p = { ...DEFAULT_READER_PREFS, ...(rawPrefs ? (JSON.parse(rawPrefs) as Partial<ReaderPrefs>) : {}) };
        if (p.spread !== "both") p.spread = "none";
        const source = await openSource(doc, p);
        opened = source as { destroy?: () => void };
        if (dead || !stage.current) {
          // 还没打开完就被关掉 / 换篇了：清理函数那时拿不到它，在这儿释放（PDF 的后台线程和整份文件的字节）
          if (dead) {
            try {
              opened.destroy?.();
            } catch {
              // 收尾出错不影响
            }
            opened = null;
          }
          return;
        }
        if (saved) {
          const far = { fraction: Math.max(doc.furthest, saved.furthest ?? saved.fraction ?? 0), page: saved.furthestPage ?? doc.furthestPage };
          setSeen(far);
          seenRef.current = far;
        }
        setPrefs(p);
        prefsRef.current = p;
        setAnnotations(notes);
        annRef.current = notes;

        view = document.createElement("foliate-view") as FoliateView;
        view.style.cssText = "display:block;width:100%;height:100%";
        stage.current.replaceChildren(view);
        await view.open(source);
        if (dead) return;
        viewRef.current = view;
        const v = view;
        setFixed(v.isFixedLayout);
        setToc((v.book.toc as api.TocItem[] | null) ?? []);
        applyPrefs(v, p);

        v.addEventListener("relocate", (e) => {
          const raw = (e as CustomEvent<Loc>).detail;
          // 滚动模式下引擎报的是视口顶端的位置，滚到底也到不了 100%：
          // 「下一篇」的提示、读完的标记、下次从哪一篇接着读都等着这个 100%，所以到底了就算读完
          const r = v.renderer as unknown as { scrolled?: boolean; atEnd?: boolean };
          const l: Loc = !v.isFixedLayout && r.scrolled && r.atEnd ? { ...raw, fraction: 1 } : raw;
          setLoc(l);
          setCanGoBack(!!v.history?.canGoBack);
          // 翻页了，浮在原位置上的菜单和脚注就不对了
          setPopup(null);
          setFootnote(null);
          // 索引里 PDF 按页、EPUB 按节记了位置；其它格式没有
          const page = (v.isFixedLayout || doc.kind === "epub") && l.section ? l.section.current + 1 : null;
          lastPage.current = page;
          // 往前读到了新的地方才更新「最远处」；页码只在往前的时候记（往回翻到的那一页不是最远的）
          const frac = l.fraction ?? 0;
          if (frac >= seenRef.current.fraction) {
            const far = { fraction: frac, page: page != null ? Math.max(page, seenRef.current.page ?? 0) : seenRef.current.page };
            seenRef.current = far;
            setSeen(far);
          }
          const info: ReadingInfo = { docId: doc.id, page, chapter: l.tocItem?.label?.trim() ?? "", fraction: l.fraction ?? 0 };
          onLocationRef.current(info);
          // 进度别每翻一页都写库，停下来再写
          clearTimeout(saveTimer);
          saveTimer = window.setTimeout(() => {
            void api.saveReadingState(doc.id, l.cfi, l.fraction ?? 0, page).catch(() => {});
          }, 600);
        });

        // 每一节加载出来时：接上划词、键盘翻页
        v.addEventListener("load", (e) => {
          const { doc: d, index } = (e as CustomEvent<{ doc: Document; index: number }>).detail;
          const onSelect = () => {
            const sel = d.getSelection();
            if (!sel || sel.isCollapsed || !sel.rangeCount || !host.current) return;
            const range = sel.getRangeAt(0);
            const text = sel.toString().replace(/\s+/g, " ").trim();
            if (text.length < 1) return;
            const at = anchorOf(range, host.current);
            if (!at) return;
            setPopup({ ...at, text: text.slice(0, 4000), cfi: v.getCFI(index, range), index, existing: null });
          };
          d.addEventListener("pointerup", () => setTimeout(onSelect, 10));
          d.addEventListener("pointerdown", () => {
            setPopup(null);
            setFootnote(null);
            setShowPrefs(false);
          });
          d.addEventListener("keydown", onKey);
          // 翻页模式下滚轮也能翻页（有节流，触控板一次滑动只翻一页）
          let lastTurn = 0;
          d.addEventListener(
            "wheel",
            (ev) => {
              if (v.isFixedLayout || prefsRef.current.flow !== "paginated") return;
              const delta = Math.abs(ev.deltaY) > Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
              if (Math.abs(delta) < 24 || Date.now() - lastTurn < 380) return;
              lastTurn = Date.now();
              void (delta > 0 ? v.next() : v.prev());
            },
            { passive: true },
          );
        });

        // 一节的标注层建好了：把这本书的高亮画上去（不在这一节的会被引擎忽略）
        v.addEventListener("create-overlay", (e) => {
          const { index } = (e as CustomEvent<{ index: number }>).detail;
          for (const a of annRef.current) {
            const at = indexOf(a);
            if (at < 0 || at === index) draw(a);
          }
          if (citeRef.current) void v.addAnnotation({ value: citeRef.current, id: CITE_ID }).catch(() => {});
        });

        v.addEventListener("draw-annotation", (e) => {
          const { draw: paint, annotation } = (e as CustomEvent).detail as {
            draw: (fn: unknown, opts?: Record<string, unknown>) => void;
            annotation: { value: string; id?: string };
          };
          // 引用处：整行连成一片的底色（PDF 的文字是一小块一小块的，描边会碎）
          if (annotation.id === CITE_ID) return paint(Overlayer.highlight, { color: CITE_COLOR });
          const a = annRef.current.find((x) => x.id === annotation.id);
          if (!a) return;
          const color = HL[a.color]?.fill ?? HL.yellow.fill;
          if (annotation.value.startsWith(NOTE_PREFIX)) {
            const bubble = (Overlayer as unknown as { bubble?: unknown }).bubble;
            if (bubble) paint(bubble, { color, size: 14, padding: 4 });
          } else if (a.style === "underline") paint(Overlayer.underline, { color, width: 2 });
          else if (a.style === "squiggly") paint(Overlayer.squiggly, { color, width: 1.5 });
          else paint(Overlayer.highlight, { color });
        });

        // 点到已有的高亮：弹出同一个菜单，可以改色、写笔记、删除
        v.addEventListener("show-annotation", (e) => {
          const { value, range, index } = (e as CustomEvent<{ value: string; range: Range; index: number }>).detail;
          const cfi = value.startsWith(NOTE_PREFIX) ? value.slice(NOTE_PREFIX.length) : value;
          const a = annRef.current.find((x) => x.cfi === cfi && x.kind === "highlight");
          if (!a || !host.current || !range) return;
          const at = anchorOf(range, host.current);
          if (at) setPopup({ ...at, text: a.text, cfi: a.cfi, index, existing: a.id });
        });

        // 脚注：点注释号时在浮层里显示，不跳走
        const { FootnoteHandler } = await import("@/vendor/foliate-js/footnotes.js");
        const notesHandler = new FootnoteHandler();
        notesHandler.detectFootnotes = true;
        let lastLink: HTMLElement | null = null;
        v.addEventListener("link", (e) => {
          lastLink = (e as CustomEvent<{ a: HTMLElement }>).detail.a;
          void notesHandler.handle(v.book, e)?.catch(() => {
            // 不是脚注，按普通链接跳
            void v.goTo((e as CustomEvent<{ href: string }>).detail.href);
          });
        });
        v.addEventListener("external-link", (e) => e.preventDefault());
        notesHandler.addEventListener("before-render", (e) => {
          const fv = (e as CustomEvent<{ view: FoliateView }>).detail.view;
          // 上一条脚注的视图要关掉，不然每点一次就多留一个
          try {
            footnoteView.current?.close();
          } catch {
            // 已经关过了
          }
          footnoteView.current = fv;
          fv.style.cssText = "display:block;width:100%;height:100%";
          fv.addEventListener("link", (ev) => {
            ev.preventDefault();
            setFootnote(null);
            void v.goTo((ev as CustomEvent<{ href: string }>).detail.href);
          });
          const r = fv.renderer as HTMLElement & { setStyles?: (css: string) => void };
          r.setAttribute("flow", "scrolled");
          r.setAttribute("margin-top", "0px");
          r.setAttribute("margin-bottom", "0px");
          r.setAttribute("gap", "5%");
          r.setStyles?.(`html { font-size: 14px !important; color: ${THEMES[prefsRef.current.theme].fg} !important; background: none !important; } body { background: none !important; } p { line-height: 1.7 !important; margin: 0.4em 0; }`);
          footnoteBox.current?.replaceChildren(fv);
        });
        notesHandler.addEventListener("render", () => {
          if (!host.current || !lastLink) return;
          const r = lastLink.ownerDocument.createRange();
          r.selectNode(lastLink);
          const at = anchorOf(r, host.current);
          if (at) setFootnote({ x: at.x, y: at.y });
        });

        // 从引用点进来的直接去引用处，否则回到上次读到的地方
        if (saved?.location || !v.isFixedLayout) await v.init({ lastLocation: saved?.location ?? null });
        else await v.goTo(0);
        // 打开的这段时间里用户可能又点了别的引用，以最新的为准
        const t = targetRef.current;
        if (t.quote || t.page || t.cfi || t.fraction != null) await showCitation(v, t);
        if (dead) return;
        setReady(true);

        // 没有封面的（PDF 等）：拿第一页当封面存起来
        if (!doc.hasCover && !doc.missing && typeof v.book.getCover === "function") {
          void (async () => {
            const blob = (await v.book.getCover()) as Blob | null;
            if (!blob) return;
            await api.setDocCover(doc.id, new Uint8Array(await blob.arrayBuffer()));
            onBooksChanged();
          })().catch(() => {});
        }
      } catch (err) {
        if (!dead) setFailed(err instanceof Error ? err.message : String(err));
      }
    })();

    function onKey(e: KeyboardEvent) {
      const v = viewRef.current;
      if (!v) return;
      // 有弹窗盖在上面（设置等）时，按键是给弹窗的
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === "Escape") {
        setPopup(null);
        setFootnote(null);
        setShowPrefs(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        setPanel("search");
        e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 焦点在输入框、按钮上时，空格和方向键是给它们的
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, textarea, select, button, [contenteditable], [role=dialog]")) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) void v.goLeft();
      else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") void v.goRight();
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);

    return () => {
      dead = true;
      clearTimeout(saveTimer);
      window.removeEventListener("keydown", onKey);
      const l = locRef.current;
      if (l?.cfi) void api.saveReadingState(doc.id, l.cfi, l.fraction ?? 0, lastPage.current).then(onBooksChanged, () => {});
      try {
        footnoteView.current?.close();
        view?.close();
        // 书可能还没来得及交给引擎就被关了（快速切书），一样要释放（PDF 的后台线程、解压器）
        opened?.destroy?.();
      } catch {
        // 引擎收尾出错不影响关闭
      }
      footnoteView.current = null;
      view?.remove();
      viewRef.current = null;
    };
    // 只在换书时重开；其它依赖都走 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  // 同一本书里再点别的引用
  useEffect(() => {
    const v = viewRef.current;
    if (!ready || !v) return;
    void showCitation(v, target).catch((err) => onError(String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.nonce]);

  // 外面改了笔记：重新读一遍并重画
  useEffect(() => {
    if (!notesVersion) return;
    void api.listAnnotations({ docId: doc.id }).then((list) => {
      for (const a of annRef.current) erase(a);
      sectionOf.current.clear();
      annRef.current = list;
      setAnnotations(list);
      for (const a of list) draw(a);
    });
  }, [notesVersion, doc.id, draw, erase]);

  // 这本书别的篇上的标记（多篇的书才需要），给面板列出来
  useEffect(() => {
    if (!multi) return setOthers([]);
    let dead = false;
    void api.listAnnotations({ bookId: book.id }).then(
      (list) => {
        if (!dead) setOthers(list.filter((a) => a.docId !== doc.id));
      },
      () => {},
    );
    return () => {
      dead = true;
    };
  }, [multi, book.id, doc.id, notesVersion]);

  function updatePrefs(patch: Partial<ReaderPrefs>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    if (viewRef.current) applyPrefs(viewRef.current, next);
    void api.setSetting(PREFS_KEY, JSON.stringify(next)).catch(() => {});
  }

  // ---------- 高亮和笔记 ----------

  function chapterOf(): string {
    return loc?.tocItem?.label?.trim() ?? "";
  }

  async function saveAnnotation(a: Annotation) {
    setAnnotations((prev) => (prev.some((x) => x.id === a.id) ? prev.map((x) => (x.id === a.id ? a : x)) : [...prev, a]));
    annRef.current = annRef.current.some((x) => x.id === a.id)
      ? annRef.current.map((x) => (x.id === a.id ? a : x))
      : [...annRef.current, a];
    draw(a);
    try {
      await api.saveAnnotation(a);
    } catch (err) {
      onError(String(err));
    }
  }

  async function removeAnnotation(a: Annotation) {
    erase(a);
    setAnnotations((prev) => prev.filter((x) => x.id !== a.id));
    annRef.current = annRef.current.filter((x) => x.id !== a.id);
    try {
      await api.deleteAnnotation(a.id);
    } catch (err) {
      onError(String(err));
    }
  }

  /** 菜单里选了颜色/样式/写了笔记：新建或修改这段话的高亮 */
  function mark(patch: Partial<Pick<Annotation, "color" | "style" | "note">>): Annotation | null {
    if (!popup) return null;
    const existing = popup.existing ? annotations.find((a) => a.id === popup.existing) : undefined;
    const now = Math.floor(Date.now() / 1000);
    const a: Annotation = existing
      ? { ...existing, ...patch, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          docId: doc.id,
          kind: "highlight",
          cfi: popup.cfi,
          text: popup.text,
          note: "",
          ...lastStyle,
          label: chapterOf(),
          page: fixed ? popup.index + 1 : null,
          createdAt: now,
          updatedAt: now,
          ...patch,
        };
    if (patch.color || patch.style) setLastStyle({ color: a.color, style: a.style });
    void saveAnnotation(a);
    viewRef.current?.deselect();
    setPopup((p) => (p ? { ...p, existing: a.id } : p));
    return a;
  }

  // ---------- 书签 ----------

  const bookmarks = useMemo(() => annotations.filter((a) => a.kind === "bookmark"), [annotations]);
  const highlights = useMemo(
    () =>
      annotations
        .filter((a) => a.kind === "highlight")
        .sort((a, b) => {
          try {
            return CFI.compare(a.cfi, b.cfi);
          } catch {
            return a.createdAt - b.createdAt;
          }
        }),
    [annotations],
  );

  /** 当前这一屏上的书签 */
  const here = useMemo(() => {
    if (!loc?.cfi) return null;
    return (
      bookmarks.find((b) => {
        try {
          return CFI.compare(CFI.collapse(loc.cfi), b.cfi) <= 0 && CFI.compare(b.cfi, CFI.collapse(loc.cfi, true)) <= 0;
        } catch {
          return b.cfi === loc.cfi;
        }
      }) ?? null
    );
  }, [bookmarks, loc]);

  function toggleBookmark() {
    if (here) return void removeAnnotation(here);
    if (!loc?.cfi) return;
    const now = Math.floor(Date.now() / 1000);
    let start = loc.cfi;
    try {
      start = CFI.collapse(loc.cfi);
    } catch {
      // 不是范围 CFI，直接用
    }
    void saveAnnotation({
      id: crypto.randomUUID(),
      docId: doc.id,
      kind: "bookmark",
      cfi: start,
      text: (loc.range?.toString() ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      note: "",
      color: "yellow",
      style: "highlight",
      label: chapterOf(),
      page: fixed && loc.section ? loc.section.current + 1 : null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // ---------- 书内搜索 ----------

  async function runSearch(q: string) {
    const v = viewRef.current;
    const run = ++searchRun.current;
    setResults([]);
    setSearched(null);
    if (!v) return;
    v.clearSearch();
    if (!q.trim()) return setSearching(false);
    setSearching(true);
    try {
      const found: SearchGroup[] = [];
      let count = 0;
      let capped = false;
      for await (const r of v.search({ query: q.trim(), matchCase: false, matchDiacritics: false, matchWholeWords: false })) {
        if (run !== searchRun.current) return;
        if (r === "done") break;
        if (r.subitems) {
          found.push({ label: r.label ?? "", items: r.subitems });
          count += r.subitems.length;
          setResults([...found]);
          // 搜「的」这种字会有几千处，列不过来也没意义
          if (count >= SEARCH_CAP) {
            capped = true;
            break;
          }
        }
      }
      if (run === searchRun.current) setSearched({ capped });
    } catch (err) {
      onError(`搜索失败：${String(err)}`);
    } finally {
      if (run === searchRun.current) setSearching(false);
    }
  }

  function closeSearch() {
    searchRun.current++;
    viewRef.current?.clearSearch();
    setResults([]);
    setQuery("");
    setSearching(false);
    setSearched(null);
  }

  const goTo = (t: string | number) => void viewRef.current?.goTo(t)?.catch((err: unknown) => onError(String(err)));

  async function exportNotes() {
    const md = notesMarkdown(book, allHighlights, partName);
    const name = `${book.title}-笔记.md`;
    try {
      if (api.isPreview) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
        a.download = name;
        a.click();
        return;
      }
      await api.exportText(name, md);
    } catch (err) {
      onError(String(err));
    }
  }

  // ---------- 助手交代的事 ----------

  // 这一篇打不开（原文件没了、文件坏了）：助手还等着回话，告诉它，别让它干等到超时
  useEffect(() => {
    if (failed && command) onCommandDone(command.callId, false, `这一篇打不开：${doc.missing ? "原文件找不到了" : failed}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed, command?.callId]);

  useEffect(() => {
    const v = viewRef.current;
    if (!ready || !v || !command) return;
    const cmd = command;
    const current = locRef.current?.section ? locRef.current.section.current + 1 : null;
    void (async () => {
      if (cmd.action === "goto") {
        if (!cmd.quote) {
          const n = Math.min(Math.max(cmd.page ?? 1, 1), v.book.sections.length);
          await v.goTo(n - 1);
          return onCommandDone(cmd.callId, true, `已翻到第 ${n} ${fixed ? "页" : "节"}。`);
        }
        const cfi = await locateQuote(v, cmd.quote, cmd.page ?? current);
        if (!cfi) return onCommandDone(cmd.callId, false, "在书里没找到这段原文。原文要一字不差，可以先用 read_section 读出来再照抄。");
        await showCitation(v, { docId: doc.id, cfi, nonce: Date.now() });
        if (citeRef.current) void v.deleteAnnotation({ value: citeRef.current }).catch(() => {});
        citeRef.current = cfi;
        void v.addAnnotation({ value: cfi, id: CITE_ID }).catch(() => {});
        return onCommandDone(cmd.callId, true, "已翻到那一处并标出来了。");
      }
      const quote = cmd.quote ?? "";
      const cfi = await locateQuote(v, quote, cmd.page ?? current);
      if (!cfi) return onCommandDone(cmd.callId, false, "在书里没找到这段原文，没有划线。原文要一字不差，可以先用 read_section 读出来再照抄。");
      const now = Math.floor(Date.now() / 1000);
      const a: Annotation = {
        id: crypto.randomUUID(),
        docId: doc.id,
        kind: "highlight",
        cfi,
        text: quote,
        note: cmd.note ?? "",
        color: cmd.color ?? "yellow",
        style: "highlight",
        label: "",
        page: fixed ? (cmd.page ?? current) : null,
        createdAt: now,
        updatedAt: now,
      };
      // 先放进列表引擎才画得出来；章节名要等引擎解析完位置才知道
      annRef.current = [...annRef.current, a];
      const info = (await v.addAnnotation({ value: cfi, id: a.id }).catch(() => null)) as { label?: string } | null;
      await saveAnnotation({ ...a, label: info?.label?.trim() ?? "" });
      await v.goTo(cfi);
      setPanel("notes");
      onCommandDone(cmd.callId, true, `已划线${cmd.note ? "并附上笔记" : ""}。`);
    })().catch((err) => onCommandDone(cmd.callId, false, `阅读器出错：${String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, command?.callId]);

  /** 松手才跳：拖的过程中每一格都跳的话，会连着加载几十章，「返回」也要按几十次 */
  function commitDrag() {
    if (drag == null) return;
    void viewRef.current?.goToFraction(drag / 1000);
    setDrag(null);
  }

  /** 透视里读过的部分出现的人物和概念：选中名字时直接告诉用户是谁 */
  /** 防剧透时每一篇能看到哪儿；正在读的这一篇按当前位置算 */
  const bounds = useMemo(
    () => readBoundaries(book, { docId: doc.id, fraction: seen.fraction, page: seen.page }),
    [book, doc.id, seen],
  );
  /** 此刻在第几页 / 第几节（没有页码的格式是 null） */
  const livePage = (fixed || doc.kind === "epub") && loc?.section ? loc.section.current + 1 : null;
  const figures = useMemo(() => figuresOf(visibleUnits(xray, bounds)), [xray, bounds]);

  /** 面板里列的标记：整本书的，按篇的先后排；当前这一篇的用最新的本地状态 */
  const partOf = useMemo(() => new Map(book.docs.map((d) => [d.id, d])), [book.docs]);
  const byPart = useCallback(
    (list: Annotation[]) =>
      [...list].sort((a, b) => {
        const pa = partOf.get(a.docId)?.position ?? 0;
        const pb = partOf.get(b.docId)?.position ?? 0;
        if (pa !== pb) return pa - pb;
        try {
          return CFI.compare(a.cfi, b.cfi);
        } catch {
          return a.createdAt - b.createdAt;
        }
      }),
    [partOf],
  );
  const allHighlights = useMemo(
    () => byPart([...highlights, ...others.filter((a) => a.kind === "highlight")]),
    [byPart, highlights, others],
  );
  const allBookmarks = useMemo(
    () => byPart([...bookmarks, ...others.filter((a) => a.kind === "bookmark")]),
    [byPart, bookmarks, others],
  );
  /** 面板里改 / 删一条标记。别的篇上的不经过引擎（它没开着那一篇），直接改库 */
  async function saveAny(a: Annotation) {
    if (a.docId === doc.id) return saveAnnotation(a);
    setOthers((list) => list.map((x) => (x.id === a.id ? a : x)));
    await api.saveAnnotation(a).catch((err) => onError(String(err)));
  }
  async function removeAny(a: Annotation) {
    if (a.docId === doc.id) return removeAnnotation(a);
    setOthers((list) => list.filter((x) => x.id !== a.id));
    await api.deleteAnnotation(a.id).catch((err) => onError(String(err)));
  }
  /** 点面板里的一条标记：在别的篇上就先翻过去 */
  const goAnnotation = (a: Annotation) => (a.docId === doc.id ? goTo(a.cfi) : onOpenPart(a.docId, { cfi: a.cfi }));
  const partName = (docId: string) => (multi ? (partOf.get(docId)?.name ?? "") : "");

  const percent = drag != null ? Math.round(drag / 10) : loc ? Math.round((loc.fraction ?? 0) * 100) : 0;
  const where = fixed
    ? loc?.section
      ? `第 ${loc.section.current + 1} / ${loc.section.total} 页`
      : ""
    : [loc?.tocItem?.label?.trim(), loc?.location ? `${loc.location.current + 1} / ${loc.location.total}` : ""].filter(Boolean).join(" · ");

  const tool = (active: boolean) =>
    `focus-ring grid h-7 w-7 place-items-center rounded-md transition-colors ${
      active ? "bg-accent-soft text-accent" : "text-text-3 hover:bg-nav-card hover:text-text"
    }`;
  const togglePanel = (p: Panel) => setPanel(panel === p ? null : p);

  return (
    <section
      ref={host}
      className="relative flex min-w-0 flex-1 flex-col bg-bg"
      onPointerDown={(e) => {
        // 点在浮层外面就收起来（点浮层自己、点打开它的按钮不算）
        const t = e.target as HTMLElement;
        if (t.closest("[data-selection-menu], [data-floating], [data-floating-toggle]")) return;
        setPopup(null);
        setFootnote(null);
        setShowPrefs(false);
        setShowQuick(false);
      }}
    >
      <header className="flex items-center gap-1 border-b border-hairline-soft px-3 py-2">
        <button className={tool(panel === "toc")} title="目录" aria-label="目录" onClick={() => togglePanel("toc")}>
          <List className="h-4 w-4" />
        </button>
        <button className={tool(panel === "xray")} title="透视：要点、人物与概念" aria-label="透视" onClick={() => togglePanel("xray")}>
          <ScanSearch className="h-4 w-4" />
        </button>
        <button className={tool(panel === "notes")} title="笔记" aria-label="笔记" onClick={() => togglePanel("notes")}>
          <NotebookPen className="h-4 w-4" />
        </button>
        <button className={tool(panel === "search")} title="书内搜索" aria-label="书内搜索" onClick={() => togglePanel("search")}>
          <Search className="h-4 w-4" />
        </button>
        <button
          className="min-w-0 flex-1 truncate rounded-md px-2 py-0.5 text-center text-[13px] text-text-2 hover:bg-nav-card hover:text-text"
          title="这本书的详情：封面、书名、各篇、对话"
          onClick={onInfo}
        >
          {book.title}
          {multi ? <span className="ml-2 text-text-4">{doc.name}</span> : book.author ? <span className="ml-2 text-text-4">{book.author}</span> : null}
        </button>
        <button
          data-floating-toggle
          className={tool(showQuick)}
          title="让助手…"
          aria-label="让助手"
          onClick={() => setShowQuick((v) => !v)}
        >
          <Sparkles className="h-4 w-4" />
        </button>
        <button
          className={tool(!!here)}
          title={here ? "取消书签" : "加书签"}
          aria-label={here ? "取消书签" : "加书签"}
          onClick={toggleBookmark}
          onContextMenu={(e) => {
            e.preventDefault();
            setPanel("bookmarks");
          }}
        >
          {here ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
        </button>
        <button
          data-floating-toggle
          className={tool(showPrefs)}
          title="阅读设置"
          aria-label="阅读设置"
          onClick={() => setShowPrefs((v) => !v)}
        >
          <Type className="h-4 w-4" />
        </button>
        <ModalCloseButton ariaLabel="关闭文档" onClick={onClose} />
      </header>

      <div className="relative flex min-h-0 flex-1">
        {panel && (
          <aside className="flex w-[280px] shrink-0 flex-col border-r border-hairline-soft bg-bg-grad-a">
            <nav className="flex gap-1 border-b border-hairline-soft px-2 py-1.5 text-[12px]">
              {(
                [
                  ["toc", "目录"],
                  ["xray", "透视"],
                  ["notes", `笔记${allHighlights.length ? ` ${allHighlights.length}` : ""}`],
                  ["bookmarks", `书签${allBookmarks.length ? ` ${allBookmarks.length}` : ""}`],
                  ["search", "搜索"],
                ] as [Panel, string][]
              ).map(([id, name]) => (
                <button
                  key={id}
                  onClick={() => setPanel(id)}
                  className={`rounded-md px-2 py-1 ${panel === id ? "bg-nav-card text-text" : "text-text-3 hover:text-text"}`}
                >
                  {name}
                </button>
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {panel === "toc" && (
                <TocPanel
                  toc={toc}
                  current={loc?.tocItem?.href ?? null}
                  onGo={goTo}
                  fixed={fixed}
                  total={loc?.section?.total ?? doc.pages ?? 0}
                  page={loc?.section?.current ?? 0}
                  parts={multi ? book.docs : null}
                  currentPart={doc.id}
                  onPart={(d) => onOpenPart(d.id)}
                />
              )}
              {panel === "xray" && (
                <XRayPanel
                  xray={xray}
                  building={building}
                  book={book}
                  currentDoc={doc.id}
                  fraction={loc?.fraction ?? 0}
                  page={livePage}
                  bounds={bounds}
                  onToggleSpoiler={() => onSpoiler(!book.spoilerFree)}
                  onBuild={() => void build()}
                  onRebuild={() => void rebuild()}
                  onGoUnit={(u) => {
                    // 别的篇上的要点：先翻到那一篇
                    if (u.docId !== doc.id) return onOpenPart(u.docId, u.page ? { page: u.page } : { fraction: u.start });
                    const v = viewRef.current;
                    if (!v) return;
                    void (u.page ? v.goTo(u.page - 1) : v.goToFraction(u.start)).catch((err: unknown) => onError(String(err)));
                  }}
                  onGoQuote={(quote, u) => {
                    // 带上这一段的位置：引文对不上原文（模型没照抄）时，至少翻到这一段
                    if (u.docId !== doc.id) return onOpenPart(u.docId, { quote, page: u.page, fraction: u.start });
                    const v = viewRef.current;
                    if (v) {
                      void showCitation(v, { docId: doc.id, quote, page: u.page, fraction: u.start, nonce: Date.now() }).catch((err) =>
                        onError(String(err)),
                      );
                    }
                  }}
                  onAskAbout={(name) =>
                    onAsk(
                      `讲讲「${name}」到我读到的位置为止的来龙去脉：出现在哪些地方、做了什么、和别人是什么关系。不要提我还没读到的内容。`,
                      `「${name}」的来龙去脉`,
                    )
                  }
                />
              )}
              {panel === "notes" && (
                <NotesPanel
                  notes={allHighlights}
                  partName={partName}
                  onGo={goAnnotation}
                  onSave={(a) => void saveAny(a)}
                  onDelete={(a) => void removeAny(a)}
                  onExport={() => void exportNotes()}
                  onAsk={() =>
                    onAsk(
                      `读一下我在《${book.title}》里划的重点和写的笔记（用 list_notes 工具），帮我整理：按主题归类、提炼要点，再指出几处我可能没注意到的关联。`,
                      "整理我的笔记",
                    )
                  }
                />
              )}
              {panel === "bookmarks" && (
                <BookmarksPanel bookmarks={allBookmarks} partName={partName} onGo={goAnnotation} onDelete={(a) => void removeAny(a)} />
              )}
              {panel === "search" && (
                <SearchPanel
                  query={query}
                  onQuery={setQuery}
                  onSearch={(q) => void runSearch(q)}
                  onClear={closeSearch}
                  searching={searching}
                  searched={searched}
                  results={results}
                  onGo={goTo}
                />
              )}
            </div>
          </aside>
        )}

        <div className="relative min-w-0 flex-1" style={{ background: fixed ? undefined : theme.bg }}>
          <div ref={stage} className={`reader-stage absolute inset-0 ${fixed ? "reader-fixed" : ""}`} />
          {!ready && !failed && (
            <p className="arc-shimmer-text pointer-events-none absolute inset-x-0 top-10 text-center text-[13px]">正在打开…</p>
          )}
          {failed && (
            <p className="absolute inset-x-0 top-10 px-8 text-center text-[13px] text-danger">打不开{multi ? "这一篇" : "这本书"}：{doc.missing ? "原文件找不到了（可以在书的详情里重新指定位置）" : failed}</p>
          )}
          {/* 一篇读到头了：直接给出下一篇 */}
          {ready && nextPart && (loc?.fraction ?? 0) >= 0.995 && (
            <button
              className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-full border border-hairline-strong bg-surface-2 px-4 py-1.5 text-[13px] text-text shadow-[0_6px_20px_-8px_rgb(0_0_0/0.3)] hover:border-accent hover:text-accent"
              onClick={() => onOpenPart(nextPart.id)}
            >
              下一篇：{nextPart.name} →
            </button>
          )}
          {/* 两侧的翻页热区 */}
          {ready && (fixed ? prefs.spread === "both" : prefs.flow === "paginated") && (
            <>
              <button
                aria-label="上一页"
                className="group absolute inset-y-0 left-0 z-10 w-10 cursor-w-resize"
                onClick={() => void viewRef.current?.goLeft()}
              >
                <ChevronLeft className="mx-auto h-5 w-5 text-text-4 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
              <button
                aria-label="下一页"
                className="group absolute inset-y-0 right-0 z-10 w-10 cursor-e-resize"
                onClick={() => void viewRef.current?.goRight()}
              >
                <ChevronRight className="mx-auto h-5 w-5 text-text-4 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </>
          )}
        </div>
      </div>

      <footer className="flex items-center gap-3 border-t border-hairline-soft px-4 py-1.5 text-[12px] text-text-3">
        {canGoBack && (
          <button
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-accent hover:bg-accent-dim"
            title="回到跳转前的位置"
            onClick={() => {
              viewRef.current?.history.back();
              setCanGoBack(!!viewRef.current?.history.canGoBack);
            }}
          >
            <Undo2 className="h-3.5 w-3.5" />
            返回
          </button>
        )}
        {multi && (
          <span className="flex shrink-0 items-center gap-0.5">
            <button
              className="grid h-5 w-5 place-items-center rounded hover:bg-nav-card hover:text-text disabled:opacity-30"
              aria-label="上一篇"
              title={prevPart ? `上一篇：${prevPart.name}` : "已经是第一篇"}
              disabled={!prevPart}
              onClick={() => prevPart && onOpenPart(prevPart.id)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="num">
              第 {doc.position + 1}/{book.docs.length} 篇
            </span>
            <button
              className="grid h-5 w-5 place-items-center rounded hover:bg-nav-card hover:text-text disabled:opacity-30"
              aria-label="下一篇"
              title={nextPart ? `下一篇：${nextPart.name}` : "已经是最后一篇"}
              disabled={!nextPart}
              onClick={() => nextPart && onOpenPart(nextPart.id)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
        <span className="min-w-0 max-w-[40%] truncate">{where}</span>
        <input
          type="range"
          min={0}
          max={1000}
          value={drag ?? Math.round((loc?.fraction ?? 0) * 1000)}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={commitDrag}
          onKeyUp={commitDrag}
          onBlur={commitDrag}
          className="reader-progress min-w-0 flex-1"
          aria-label="阅读进度"
        />
        <span className="num w-9 shrink-0 text-right">{percent}%</span>
      </footer>

      {showQuick && (
        <div
          data-floating
          className="absolute right-[84px] top-11 z-30 w-[190px] rounded-xl border border-hairline-strong bg-surface-2 p-1 shadow-[0_10px_32px_-8px_rgb(0_0_0/0.3)]"
          role="menu"
        >
          {QUICK.map((q) => (
            <button
              key={q.name}
              role="menuitem"
              className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] text-text-2 hover:bg-nav-card hover:text-text"
              onClick={() => {
                setShowQuick(false);
                // 标题带上章节名：同一本书问了几次「总结这一章」，历史里才分得清
                onAsk(q.prompt, [q.name, loc?.tocItem?.label?.trim() || (multi ? doc.name : "")].filter(Boolean).join(" · "));
              }}
            >
              {q.name}
            </button>
          ))}
        </div>
      )}

      {showPrefs && <PrefsPopover prefs={prefs} fixed={fixed} onChange={updatePrefs} />}

      {popup && (
        <SelectionPopup
          state={popup}
          existing={popup.existing ? (annotations.find((a) => a.id === popup.existing) ?? null) : null}
          figure={popup.existing ? null : lookup(figures, popup.text)}
          current={lastStyle}
          hostWidth={host.current?.clientWidth ?? 800}
          hostHeight={host.current?.clientHeight ?? 600}
          onMark={mark}
          onDelete={(a) => {
            void removeAnnotation(a);
            setPopup(null);
          }}
          onCopy={() => {
            void navigator.clipboard?.writeText(popup.text).catch(() => {});
            viewRef.current?.deselect();
            setPopup(null);
          }}
          onAction={(action) => {
            onSelection(action, popup.text, fixed ? popup.index + 1 : null, popup.cfi);
            viewRef.current?.deselect();
            setPopup(null);
          }}
          onClose={() => setPopup(null)}
        />
      )}

      {/* 脚注浮层：容器一直在，引擎往里放内容 */}
      <div
        data-floating
        className={`absolute z-20 w-[340px] -translate-x-1/2 overflow-hidden rounded-xl border border-hairline-strong shadow-[0_10px_32px_-8px_rgb(0_0_0/0.3)] ${footnote ? "" : "pointer-events-none invisible"}`}
        style={{
          left: Math.min(Math.max(footnote?.x ?? 0, 180), (host.current?.clientWidth ?? 800) - 180),
          top: Math.min((footnote?.y ?? 0) + 8, (host.current?.clientHeight ?? 600) - 220),
          height: 200,
          background: theme.bg,
        }}
      >
        <div ref={footnoteBox} className="h-full w-full" />
        <button
          className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded text-text-3 hover:bg-nav-card"
          aria-label="关闭脚注"
          onClick={() => setFootnote(null)}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </section>
  );
}
