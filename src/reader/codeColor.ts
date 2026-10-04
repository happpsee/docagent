/** 给代码块上色。不改正文的 DOM（划线、引用的位置都是按 DOM 算的，插进一堆 span 会全部错位），
 *  用 CSS Custom Highlight：只登记「哪一段字是什么颜色」。老系统的 WebView 不支持就保持原样。 */
import hljs from "highlight.js/lib/common";

/** 没写语言的代码块只在这几种里猜，全猜一遍太慢 */
const GUESS = ["json", "javascript", "typescript", "python", "bash", "rust", "go", "java", "xml", "yaml", "sql", "css", "cpp"];
const GROUP: Record<string, string> = {
  keyword: "kw", built_in: "kw", literal: "kw", type: "kw", meta: "kw", tag: "kw", name: "kw", "selector-tag": "kw",
  string: "str", regexp: "str", symbol: "str",
  number: "num",
  attr: "attr", attribute: "attr", property: "attr", variable: "attr",
  comment: "com", quote: "com",
  title: "fn", function: "fn", section: "fn",
};
const STYLE = `
::highlight(code-kw) { color: #a04a9c; }
::highlight(code-str) { color: #3f8a4b; }
::highlight(code-num) { color: #b06a1a; }
::highlight(code-attr) { color: #2f6fb5; }
::highlight(code-fn) { color: #2f6fb5; }
::highlight(code-com) { color: #8a8a8a; }
`;

interface HighlightSet {
  add(r: Range): void;
}

export function colorCode(doc: Document) {
  const win = doc.defaultView as (Window & { Highlight?: new () => HighlightSet; CSS?: { highlights?: Map<string, HighlightSet> } }) | null;
  const registry = win?.CSS?.highlights;
  if (!win?.Highlight || !registry) return;
  const sets = new Map<string, HighlightSet>();
  for (const pre of doc.querySelectorAll("pre")) {
    const code = pre.querySelector("code") ?? pre;
    const text = code.textContent ?? "";
    if (!text.trim() || text.length > 60_000) continue;
    const lang = /language-([\w+#-]+)/.exec(code.className)?.[1];
    let html: string;
    try {
      html = lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang }).value : lang === "text" ? "" : hljs.highlightAuto(text, GUESS).value;
    } catch {
      continue;
    }
    if (!html) continue;

    // hljs 给的是带 span 的 HTML：换算成 [起, 止, 颜色组]
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const spans: [number, number, string][] = [];
    let off = 0;
    const walk = (n: Node, group: string | null) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          const len = c.textContent?.length ?? 0;
          if (group && len) spans.push([off, off + len, group]);
          off += len;
        } else if (c.nodeType === 1) {
          const cls = (c as Element).className.split(" ").map((x) => GROUP[x.replace(/^hljs-/, "").replace(/_+$/, "")]).find(Boolean);
          walk(c, cls ?? group);
        }
      }
    };
    walk(tpl.content, null);
    if (off !== text.length) continue;

    // 对回正文里真正的文字节点
    const nodes: [Text, number][] = [];
    const tw = doc.createTreeWalker(code, 4);
    for (let n = tw.nextNode(), at = 0; n; n = tw.nextNode()) {
      nodes.push([n as Text, at]);
      at += (n as Text).length;
    }
    let i = 0;
    const locate = (pos: number, end: boolean): [Text, number] | null => {
      while (i < nodes.length - 1 && nodes[i][1] + nodes[i][0].length < pos + (end ? 0 : 1)) i++;
      const hit = nodes[i];
      return hit ? [hit[0], Math.min(pos - hit[1], hit[0].length)] : null;
    };
    for (const [a, b, group] of spans) {
      const from = locate(a, false);
      const to = locate(b, true);
      if (!from || !to) continue;
      const r = doc.createRange();
      r.setStart(from[0], from[1]);
      r.setEnd(to[0], to[1]);
      let set = sets.get(group);
      if (!set) sets.set(group, (set = new win.Highlight()));
      set.add(r);
    }
  }
  if (!sets.size) return;
  for (const [group, set] of sets) registry.set(`code-${group}`, set);
  const style = doc.createElement("style");
  style.textContent = STYLE;
  doc.head.append(style);
}
