import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Bookmark,
  BookmarkCheck,
  ChevronLeft,
  ChevronRight,
  List,
  NotebookPen,
  Search,
  Type,
  Undo2,
} from "lucide-react";
import { Overlayer } from "@/vendor/foliate-js/overlayer.js";
import * as CFI from "@/vendor/foliate-js/epubcfi.js";
import * as api from "@/lib/api";
import {
  DEFAULT_READER_PREFS,
  type Annotation,
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

export type SelectionAction = "ask" | "explain" | "related";

export interface ReadTarget {
  docId: string;
  /** 要跳到的页（PDF）或第几节（EPUB） */
  page?: number | null;
  /** 要高亮的原文片段（来自引用） */
  quote?: string;
  /** 直接给出书内位置（从笔记跳过来） */
  cfi?: string;
  /** 同一位置重复点击时也要重新定位，用它触发 */
  nonce: number;
}

interface Props {
  doc: Doc;
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
  /** 让助手整理这本书的笔记 */
  onAskNotes: (doc: Doc) => void;
  /** 进度、封面变了，书架要刷新 */
  onDocsChanged: () => void;
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

type Panel = "toc" | "notes" | "bookmarks" | "search";
const PREFS_KEY = "reader";
const NOTE_PREFIX = "foliate-note:";
const CITE_ID = "__cite__";
const SEARCH_CAP = 500;

/** 阅读器：所有格式都走同一个排版引擎，所以目录、搜索、高亮、笔记、书签、进度记忆对每种格式都一样。 */
export function Reader({
  doc,
  target,
  notesVersion,
  command,
  onCommandDone,
  onLocation,
  onClose,
  onSelection,
  onAskNotes,
  onDocsChanged,
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
  const [panel, setPanel] = useState<Panel | null>(null);
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
      return;
    }
    const cfi = await locateQuote(view, t.quote, t.page);
    if (citeRef.current) void view.deleteAnnotation({ value: citeRef.current }).catch(() => {});
    citeRef.current = cfi;
    if (!cfi) {
      if (t.page) await view.goTo(t.page - 1);
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
          api.listAnnotations(doc.id).catch(() => []),
          api.getSetting(PREFS_KEY).catch(() => null),
        ]);
        const p = { ...DEFAULT_READER_PREFS, ...(rawPrefs ? (JSON.parse(rawPrefs) as Partial<ReaderPrefs>) : {}) };
        if (p.spread !== "both") p.spread = "none";
        const source = await openSource(doc, p);
        opened = source as { destroy?: () => void };
        if (dead || !stage.current) return;
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
          const l = (e as CustomEvent<Loc>).detail;
          setLoc(l);
          setCanGoBack(!!v.history?.canGoBack);
          // 翻页了，浮在原位置上的菜单和脚注就不对了
          setPopup(null);
          setFootnote(null);
          onLocationRef.current({
            docId: doc.id,
            docTitle: doc.title,
            // 索引里 PDF 按页、EPUB 按节记了位置；其它格式没有
            page: (v.isFixedLayout || doc.kind === "epub") && l.section ? l.section.current + 1 : null,
            chapter: l.tocItem?.label?.trim() ?? "",
            fraction: l.fraction ?? 0,
          });
          // 进度别每翻一页都写库，停下来再写
          clearTimeout(saveTimer);
          saveTimer = window.setTimeout(() => {
            void api.saveReadingState(doc.id, l.cfi, l.fraction ?? 0).catch(() => {});
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
        if (t.quote || t.page || t.cfi) await showCitation(v, t);
        if (dead) return;
        setReady(true);

        // 没有封面的（PDF 等）：拿第一页当封面存起来
        if (!doc.hasCover && typeof v.book.getCover === "function") {
          void (async () => {
            const blob = (await v.book.getCover()) as Blob | null;
            if (!blob) return;
            await api.setDocCover(doc.id, new Uint8Array(await blob.arrayBuffer()));
            onDocsChanged();
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
      if (l?.cfi) void api.saveReadingState(doc.id, l.cfi, l.fraction ?? 0).then(onDocsChanged, () => {});
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
    void api.listAnnotations(doc.id).then((list) => {
      for (const a of annRef.current) erase(a);
      sectionOf.current.clear();
      annRef.current = list;
      setAnnotations(list);
      for (const a of list) draw(a);
    });
  }, [notesVersion, doc.id, draw, erase]);

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
    const md = notesMarkdown(doc, highlights);
    const name = `${doc.title.replace(/\.[^.]+$/, "")}-笔记.md`;
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
  const togglePanel = (p: Panel) => setPanel((cur) => (cur === p ? null : p));

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
      }}
    >
      <header className="flex items-center gap-1 border-b border-hairline-soft px-3 py-2">
        <button className={tool(panel === "toc")} title="目录" aria-label="目录" onClick={() => togglePanel("toc")}>
          <List className="h-4 w-4" />
        </button>
        <button className={tool(panel === "notes")} title="笔记" aria-label="笔记" onClick={() => togglePanel("notes")}>
          <NotebookPen className="h-4 w-4" />
        </button>
        <button className={tool(panel === "search")} title="书内搜索" aria-label="书内搜索" onClick={() => togglePanel("search")}>
          <Search className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 truncate px-2 text-center text-[13px] text-text-2">
          {doc.title}
          {doc.author ? <span className="ml-2 text-text-4">{doc.author}</span> : null}
        </div>
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
                  ["notes", `笔记${highlights.length ? ` ${highlights.length}` : ""}`],
                  ["bookmarks", `书签${bookmarks.length ? ` ${bookmarks.length}` : ""}`],
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
              {panel === "toc" && <TocPanel toc={toc} current={loc?.tocItem?.href ?? null} onGo={goTo} fixed={fixed} total={loc?.section?.total ?? doc.pages ?? 0} page={loc?.section?.current ?? 0} />}
              {panel === "notes" && (
                <NotesPanel
                  notes={highlights}
                  onGo={(a) => goTo(a.cfi)}
                  onSave={(a) => void saveAnnotation(a)}
                  onDelete={(a) => void removeAnnotation(a)}
                  onExport={() => void exportNotes()}
                  onAsk={() => onAskNotes(doc)}
                />
              )}
              {panel === "bookmarks" && (
                <BookmarksPanel bookmarks={bookmarks} onGo={(a) => goTo(a.cfi)} onDelete={(a) => void removeAnnotation(a)} />
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
            <p className="absolute inset-x-0 top-10 px-8 text-center text-[13px] text-danger">打不开这份文档：{failed}</p>
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
        <span className="min-w-0 max-w-[45%] truncate">{where}</span>
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

      {showPrefs && <PrefsPopover prefs={prefs} fixed={fixed} onChange={updatePrefs} />}

      {popup && (
        <SelectionPopup
          state={popup}
          existing={popup.existing ? (annotations.find((a) => a.id === popup.existing) ?? null) : null}
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
