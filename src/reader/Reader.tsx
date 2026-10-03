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
  type ReaderPrefs,
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

/** 阅读器：所有格式都走同一个排版引擎，所以目录、搜索、高亮、笔记、书签、进度记忆对每种格式都一样。 */
export function Reader({ doc, target, notesVersion, onClose, onSelection, onAskNotes, onDocsChanged, onError }: Props) {
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
        v.addEventListener("create-overlay", () => {
          for (const a of annRef.current) draw(a);
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
        const t = targetRef.current;
        if (saved?.location || !v.isFixedLayout) await v.init({ lastLocation: saved?.location ?? null });
        else await v.goTo(0);
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
      if (!v || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") void v.goLeft();
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
        view?.close();
        (view?.book as { destroy?: () => void } | undefined)?.destroy?.();
      } catch {
        // 引擎收尾出错不影响关闭
      }
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
    if (!v) return;
    v.clearSearch();
    if (!q.trim()) return setSearching(false);
    setSearching(true);
    try {
      const found: SearchGroup[] = [];
      for await (const r of v.search({ query: q.trim(), matchCase: false, matchDiacritics: false, matchWholeWords: false })) {
        if (run !== searchRun.current) return;
        if (r === "done") break;
        if (r.subitems) {
          found.push({ label: r.label ?? "", items: r.subitems });
          setResults([...found]);
        }
      }
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
  }

  const goTo = (t: string | number) => void viewRef.current?.goTo(t)?.catch((err: unknown) => onError(String(err)));

  async function exportNotes() {
    const md = notesMarkdown(doc, highlights);
    try {
      if (api.isPreview) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
        a.download = `${doc.title}-笔记.md`;
        a.click();
        return;
      }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ defaultPath: `${doc.title.replace(/\.[^.]+$/, "")}-笔记.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
      if (path) await api.writeTextFile(path, md);
    } catch (err) {
      onError(String(err));
    }
  }

  const percent = loc ? Math.round((loc.fraction ?? 0) * 100) : 0;
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
    <section ref={host} className="relative flex min-w-0 flex-1 flex-col bg-bg">
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
        <button className={tool(showPrefs)} title="阅读设置" aria-label="阅读设置" onClick={() => setShowPrefs((v) => !v)}>
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
          value={Math.round((loc?.fraction ?? 0) * 1000)}
          onChange={(e) => void viewRef.current?.goToFraction(Number(e.target.value) / 1000)}
          className="reader-progress min-w-0 flex-1"
          aria-label="阅读进度"
        />
        <span className="num w-9 shrink-0 text-right">{percent}%</span>
      </footer>

      {showPrefs && <PrefsPopover prefs={prefs} fixed={fixed} onChange={updatePrefs} onClose={() => setShowPrefs(false)} />}

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
