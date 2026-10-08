/**
 * 把参赛技术文档（Markdown）转成一份自带图片、可直接「打印为 PDF」的 HTML。
 *
 * 本机没有 pandoc / LibreOffice，所以用仓库里已有的 marked 渲染，并把 5 张截图
 * 以 base64 内嵌，生成的 HTML 是单文件、可离线打开、可交 Word 或打印成 PDF。
 *
 * 用法：node 提交材料/build-html.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const SRC = join(here, "时习-参赛技术文档.md");
const OUT = join(here, "时习-参赛技术文档.html");

// pnpm 把依赖放在 .pnpm 下，按目录名找 marked 的 ESM 入口（不写死版本号）
function markedPath() {
  const base = join(repo, "node_modules", ".pnpm");
  const hit = globSync("marked@*/node_modules/marked/lib/marked.esm.js", { cwd: base });
  if (!hit.length) throw new Error("找不到 marked，请先在仓库根目录跑 pnpm install");
  return join(base, hit[0]);
}
const { marked } = await import(markedPath());

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

let md = readFileSync(SRC, "utf8");
let embedded = 0;
let missing = [];

// 截图内嵌：![说明](../docs/screenshots/x.png) → data URI
md = md.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, href) => {
  if (/^https?:|^data:/.test(href)) return whole;
  const file = resolve(here, href);
  if (!existsSync(file)) {
    missing.push(href);
    return whole;
  }
  const ext = href.split(".").pop().toLowerCase();
  const mime = MIME[ext];
  if (!mime) return whole;
  embedded++;
  return `![${alt}](data:${mime};base64,${readFileSync(file).toString("base64")})`;
});

const body = marked.parse(md, { gfm: true, breaks: false });

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>时习 参赛技术文档</title>
<style>
  @page { size: A4; margin: 18mm 15mm 16mm; }
  :root {
    --ink: #1c1917; --muted: #57534e; --line: #d6d3d1; --soft: #f5f5f4; --accent: #9a3412;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 32px 24px 64px; max-width: 900px;
    color: var(--ink); background: #fff;
    font-family: "PingFang SC", "Hiragino Sans GB", "Heiti SC", "Microsoft YaHei", "Source Han Sans SC", system-ui, sans-serif;
    font-size: 15px; line-height: 1.8; -webkit-font-smoothing: antialiased;
  }
  h1 { font-size: 26px; line-height: 1.4; margin: 0 0 8px; letter-spacing: -0.01em; }
  h2 {
    font-size: 20px; margin: 40px 0 14px; padding-bottom: 8px;
    border-bottom: 2px solid var(--ink); page-break-after: avoid;
  }
  h3 { font-size: 16px; margin: 26px 0 10px; color: var(--accent); page-break-after: avoid; }
  h4 { font-size: 15px; margin: 20px 0 8px; page-break-after: avoid; }
  p { margin: 10px 0; }
  a { color: var(--accent); }
  strong { font-weight: 600; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
  ul, ol { padding-left: 1.5em; margin: 10px 0; }
  li { margin: 4px 0; }
  li > ul, li > ol { margin: 4px 0; }
  code {
    font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.88em; background: var(--soft); padding: 1px 5px; border-radius: 4px;
  }
  pre {
    background: #1c1917; color: #e7e5e4; padding: 14px 16px; border-radius: 8px;
    overflow-x: auto; font-size: 12.5px; line-height: 1.65; page-break-inside: avoid;
  }
  pre code { background: none; padding: 0; color: inherit; font-size: inherit; }
  table {
    width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13px;
    page-break-inside: avoid;
  }
  th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; line-height: 1.6; }
  th { background: var(--soft); font-weight: 600; white-space: nowrap; }
  blockquote {
    margin: 14px 0; padding: 10px 16px; background: #fffbeb;
    border-left: 4px solid #d97706; color: #44403c; page-break-inside: avoid;
  }
  blockquote p { margin: 4px 0; }
  img {
    display: block; max-width: 100%; height: auto; margin: 16px auto;
    border: 1px solid var(--line); border-radius: 8px; page-break-inside: avoid;
  }
  /* 打印用：去掉屏幕提示、收紧留白 */
  @media print {
    body { padding: 0; max-width: none; font-size: 10.5pt; line-height: 1.7; }
    .screen-only { display: none !important; }
    h1 { font-size: 20pt; }
    h2 { font-size: 15pt; margin-top: 22pt; }
    h3 { font-size: 12pt; }
    pre { background: #f5f5f4; color: #1c1917; border: 1px solid var(--line); font-size: 8.5pt; }
    table { font-size: 9pt; }
    th, td { padding: 4px 6px; }
    img { max-height: 215mm; border-radius: 0; }
    a { color: var(--ink); text-decoration: none; }
  }
  .screen-only {
    margin: 0 0 26px; padding: 12px 16px; border-radius: 8px;
    background: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a; font-size: 13.5px;
  }
  .screen-only b { color: #1e40af; }
  @media (max-width: 640px) { body { padding: 16px 14px 48px; font-size: 14px; } }
</style>
</head>
<body>
<div class="screen-only">
  <b>打印提示：</b>本文件已内嵌全部截图，可离线打开。需要 PDF 时按 <b>⌘P</b>，
  目标选择「存储为 PDF」；在「更多设置」里取消勾选「页眉和页脚」效果更干净。
  需要 Word 时用 Word 直接打开本文件另存为 .docx。
</div>
${body}
</body>
</html>
`;

writeFileSync(OUT, html, "utf8");
console.log(`已生成：${OUT}`);
console.log(`内嵌截图 ${embedded} 张，HTML 体积 ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB`);
if (missing.length) console.log(`⚠️ 找不到的图片：${missing.join("、")}`);
