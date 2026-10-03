// foliate-js 是纯 JS（MIT，见 src/vendor/foliate-js/LICENSE），这里只声明用到的那部分形状
declare module "@/vendor/foliate-js/view.js" {
  export class View extends HTMLElement {
    book: any;
    renderer: any;
    lastLocation: any;
    isFixedLayout: boolean;
    history: any;
    open(book: unknown): Promise<void>;
    close(): void;
    init(opts: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>;
    goTo(target: unknown): Promise<any>;
    goToFraction(frac: number): Promise<void>;
    prev(distance?: number): Promise<void>;
    next(distance?: number): Promise<void>;
    goLeft(): void;
    goRight(): void;
    getCFI(index: number, range?: Range): string;
    resolveCFI(cfi: string): { index: number; anchor: (doc: Document) => Range | Element | null };
    addAnnotation(annotation: { value: string; [k: string]: unknown }, remove?: boolean): Promise<any>;
    deleteAnnotation(annotation: { value: string }): Promise<any>;
    showAnnotation(annotation: { value: string }): Promise<void>;
    search(opts: Record<string, unknown>): AsyncGenerator<any>;
    clearSearch(): void;
    deselect(): void;
    getSectionFractions(): number[];
  }
  export function makeBook(file: File | Blob | string): Promise<any>;
}
declare module "@/vendor/foliate-js/overlayer.js" {
  export class Overlayer {
    static highlight(rects: unknown, opts?: Record<string, unknown>): SVGElement;
    static underline(rects: unknown, opts?: Record<string, unknown>): SVGElement;
    static squiggly(rects: unknown, opts?: Record<string, unknown>): SVGElement;
    static outline(rects: unknown, opts?: Record<string, unknown>): SVGElement;
  }
}
declare module "@/vendor/foliate-js/epubcfi.js" {
  export function compare(a: string, b: string): number;
  export function collapse(cfi: string, toEnd?: boolean): string;
  export const fake: { fromIndex(i: number): string; toIndex(parts: unknown): number };
}
declare module "@/vendor/foliate-js/footnotes.js" {
  export class FootnoteHandler extends EventTarget {
    detectFootnotes: boolean;
    handle(book: unknown, e: Event): Promise<void> | undefined;
  }
}
