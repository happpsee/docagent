//! 把 Markdown / TXT / DOCX 排成「书」：分好节的 HTML + 目录。
//!
//! 阅读器的排版引擎吃的是一节一节的 HTML（和 EPUB 一样）。把这几种格式也转成同样的
//! 形状，它们就自动有了分页、目录、书内搜索、高亮和笔记，不用为每种格式各写一套。

use crate::markup::{attr, escape, local, tokens, unescape, Tok};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

#[derive(Serialize, Debug)]
pub struct Section {
    pub id: String,
    pub html: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct TocItem {
    pub label: String,
    pub href: String,
    pub subitems: Vec<TocItem>,
}

#[derive(Serialize, Debug)]
pub struct Book {
    pub sections: Vec<Section>,
    pub toc: Vec<TocItem>,
}

/// 一节攒到这么多字就在下一个大标题处换节：节太大，分页会慢
const SECTION_CHARS: usize = 20_000;

pub fn book_for(path: &Path) -> Result<Book> {
    let kind = crate::parse::kind_of(path).ok_or_else(|| anyhow!("不支持的文件类型"))?;
    let bytes = std::fs::read(path).with_context(|| format!("读不到文件 {}", path.display()))?;
    match kind {
        "md" => Ok(markdown(&crate::parse::decode_text(&bytes))),
        "txt" => Ok(plain(&crate::parse::decode_text(&bytes))),
        "docx" => docx(&bytes),
        _ => Err(anyhow!("这种格式由阅读器直接打开原文件")),
    }
}

/// 扁平的 (层级, 标题, 链接) 列表 → 嵌套目录
fn nest(flat: Vec<(u8, String, String)>) -> Vec<TocItem> {
    fn build(flat: &[(u8, String, String)], pos: &mut usize, level: u8) -> Vec<TocItem> {
        let mut out = Vec::new();
        while *pos < flat.len() {
            let (l, label, href) = &flat[*pos];
            if *l < level {
                break;
            }
            *pos += 1;
            let subitems = match flat.get(*pos) {
                Some((next, _, _)) if next > l => build(flat, pos, *next),
                _ => vec![],
            };
            out.push(TocItem {
                label: label.clone(),
                href: href.clone(),
                subitems,
            });
        }
        out
    }
    let top = flat.iter().map(|f| f.0).min().unwrap_or(1);
    build(&flat, &mut 0, top)
}

struct Builder {
    sections: Vec<Section>,
    flat: Vec<(u8, String, String)>,
    html: String,
    chars: usize,
    headings: usize,
}

impl Builder {
    fn new() -> Self {
        Builder {
            sections: vec![],
            flat: vec![],
            html: String::new(),
            chars: 0,
            headings: 0,
        }
    }
    fn section_id(&self) -> String {
        format!("s{}", self.sections.len())
    }
    fn flush(&mut self) {
        if self.html.trim().is_empty() {
            return;
        }
        let id = self.section_id();
        self.sections.push(Section {
            id,
            html: std::mem::take(&mut self.html),
        });
        self.chars = 0;
    }
    /// 开一个标题：必要时先换节，返回这个标题的锚点 id
    fn heading(&mut self, level: u8, label: &str) -> String {
        if level <= 2 && self.chars >= SECTION_CHARS {
            self.flush();
        }
        self.headings += 1;
        let anchor = format!("h{}", self.headings);
        let label = label.trim();
        if !label.is_empty() {
            self.flat.push((
                level,
                label.to_string(),
                format!("{}#{}", self.section_id(), anchor),
            ));
        }
        anchor
    }
    fn push(&mut self, html: &str, chars: usize) {
        self.html.push_str(html);
        self.chars += chars;
    }
    /// 在两个块之间调用：没有标题的长文档（很多 Word 文档用加粗代替标题样式）
    /// 不能排成一个几十万字的节，攒够了就在这里强制换节
    fn break_if_long(&mut self) {
        if self.chars >= SECTION_CHARS * 2 {
            self.flush();
        }
    }
    fn finish(mut self) -> Book {
        self.flush();
        if self.sections.is_empty() {
            self.sections.push(Section {
                id: "s0".into(),
                html: "<p></p>".into(),
            });
        }
        Book {
            sections: self.sections,
            toc: nest(self.flat),
        }
    }
}

pub fn markdown(src: &str) -> Book {
    use pulldown_cmark::{html, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    // 文档里夹带的原始 HTML 当成文字显示，不让它进页面：<style> 能把阅读器排版弄乱，
    // <script>、<iframe> 更不该从一份文档里跑出来
    let events: Vec<Event> = Parser::new_ext(src, opts)
        .map(|e| match e {
            Event::Html(h) | Event::InlineHtml(h) => Event::Text(h),
            other => other,
        })
        .collect();
    let mut b = Builder::new();
    let mut i = 0;
    // 按顶层块切：标题单独处理（要加锚点、进目录），其它块原样交给 pulldown 出 HTML
    while i < events.len() {
        if let Event::Start(Tag::Heading { level, .. }) = &events[i] {
            let end = events[i..]
                .iter()
                .position(|e| matches!(e, Event::End(TagEnd::Heading(_))))
                .map(|p| i + p)
                .unwrap_or(events.len() - 1);
            let inner = &events[i + 1..end];
            let label: String = inner
                .iter()
                .filter_map(|e| match e {
                    Event::Text(t) | Event::Code(t) => Some(t.as_ref()),
                    _ => None,
                })
                .collect();
            let n = match level {
                HeadingLevel::H1 => 1,
                HeadingLevel::H2 => 2,
                HeadingLevel::H3 => 3,
                HeadingLevel::H4 => 4,
                HeadingLevel::H5 => 5,
                HeadingLevel::H6 => 6,
            };
            let anchor = b.heading(n, &label);
            let mut body = String::new();
            html::push_html(&mut body, inner.iter().cloned());
            b.push(
                &format!("<h{n} id=\"{anchor}\">{body}</h{n}>\n"),
                label.chars().count(),
            );
            i = end + 1;
            continue;
        }
        // 找到这个顶层块的结尾
        let mut depth = 0i32;
        let mut end = i;
        for (j, e) in events[i..].iter().enumerate() {
            match e {
                Event::Start(_) => depth += 1,
                Event::End(_) => depth -= 1,
                _ => {}
            }
            if depth <= 0 {
                end = i + j;
                break;
            }
        }
        let block = &events[i..=end];
        let chars: usize = block
            .iter()
            .map(|e| match e {
                Event::Text(t) | Event::Code(t) => t.chars().count(),
                _ => 0,
            })
            .sum();
        let mut body = String::new();
        html::push_html(&mut body, block.iter().cloned());
        b.push(&body, chars);
        b.break_if_long();
        i = end + 1;
    }
    b.finish()
}

/// 像不像章节标题：「第十二章 xxx」「Chapter 3」「序章」这类短行
fn chapter_title(line: &str) -> bool {
    let t = line.trim();
    let n = t.chars().count();
    if n == 0 || n > 40 {
        return false;
    }
    if let Some(rest) = t.strip_prefix('第') {
        let num: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || "零〇一二三四五六七八九十百千万两".contains(*c))
            .collect();
        if !num.is_empty() {
            let after = &rest[num.len()..];
            return after.starts_with(['章', '回', '节', '卷', '篇', '部', '集', '幕']);
        }
    }
    let lower = t.to_ascii_lowercase();
    if ["chapter ", "part ", "book "]
        .iter()
        .any(|p| lower.starts_with(p))
        && n <= 30
    {
        return true;
    }
    [
        "序章", "序言", "楔子", "引子", "前言", "尾声", "后记", "番外", "终章",
    ]
    .iter()
    .any(|k| t == *k || t.starts_with(&format!("{k} ")) || t.starts_with(&format!("{k}：")))
}

pub fn plain(src: &str) -> Book {
    let src = crate::parse::normalize(src).replace("\r\n", "\n");
    let mut b = Builder::new();
    for line in src.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if chapter_title(t) {
            // 小说一章一节：翻页和进度都按章算
            b.flush();
            let anchor = b.heading(2, t);
            b.push(
                &format!("<h2 id=\"{anchor}\">{}</h2>\n", escape(t)),
                t.chars().count(),
            );
        } else {
            if b.chars >= SECTION_CHARS * 2 {
                b.flush();
            }
            b.push(&format!("<p>{}</p>\n", escape(t)), t.chars().count());
        }
    }
    b.finish()
}

/// styles.xml：样式 id → 标题层级。中文 Word 的标题样式 id 常常是 "1" "2" 这种，
/// 只看 id 猜不准，要看样式的名字（heading 1 / 标题 1）。
fn heading_styles(xml: &str) -> HashMap<String, u8> {
    let mut map = HashMap::new();
    let mut current: Option<String> = None;
    for tok in tokens(xml) {
        if let Tok::Open { name, attrs, .. } = tok {
            match local(name) {
                "style" => current = attr(attrs, "styleId"),
                "name" => {
                    if let (Some(id), Some(val)) = (&current, attr(attrs, "val")) {
                        let v = val.to_lowercase();
                        let level = v
                            .strip_prefix("heading")
                            .or_else(|| v.strip_prefix("标题"))
                            .and_then(|r| r.trim().parse::<u8>().ok());
                        if let Some(l) = level.filter(|l| (1..=6).contains(l)) {
                            map.insert(id.clone(), l);
                        } else if v == "title" {
                            map.insert(id.clone(), 1);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    map
}

pub fn docx(bytes: &[u8]) -> Result<Book> {
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).context("不是有效的 DOCX 文件")?;
    let mut read = |name: &str| -> Option<String> {
        let mut s = String::new();
        zip.by_name(name)
            .ok()?
            .take(crate::ebook::MAX_ENTRY)
            .read_to_string(&mut s)
            .ok()?;
        Some(s)
    };
    let xml = read("word/document.xml").ok_or_else(|| anyhow!("DOCX 里找不到正文"))?;
    let styles = read("word/styles.xml")
        .map(|s| heading_styles(&s))
        .unwrap_or_default();

    let mut b = Builder::new();
    // 当前段落
    let mut para = String::new();
    let mut para_text = String::new();
    let mut level: Option<u8> = None;
    // 当前这段文字的格式
    let (mut bold, mut italic, mut in_rpr, mut in_text) = (false, false, false, false);
    let mut table_depth = 0usize;
    let on = |attrs: &str| !matches!(attr(attrs, "val").as_deref(), Some("0") | Some("false"));

    for tok in tokens(&xml) {
        match tok {
            Tok::Open {
                name,
                attrs,
                self_close,
            } => match name {
                "w:p" if !self_close => {
                    para.clear();
                    para_text.clear();
                    level = None;
                }
                "w:pStyle" => {
                    if let Some(id) = attr(attrs, "val") {
                        level = styles.get(&id).copied().or_else(|| {
                            // 没有 styles.xml 时退回按 id 猜
                            id.to_lowercase()
                                .strip_prefix("heading")
                                .and_then(|r| r.parse().ok())
                                .filter(|l| (1..=6).contains(l))
                        });
                    }
                }
                "w:r" => {
                    bold = false;
                    italic = false;
                }
                "w:rPr" if !self_close => in_rpr = true,
                "w:b" if in_rpr => bold = on(attrs),
                "w:i" if in_rpr => italic = on(attrs),
                "w:t" if !self_close => in_text = true,
                "w:tab" => para.push_str("&emsp;"),
                "w:br" | "w:cr" => para.push_str("<br/>"),
                "w:tbl" => {
                    table_depth += 1;
                    b.push("<table>", 0);
                }
                "w:tr" if !self_close => b.push("<tr>", 0),
                "w:tc" if !self_close => b.push("<td>", 0),
                _ => {}
            },
            Tok::Close(name) => match name {
                "w:rPr" => in_rpr = false,
                "w:t" => in_text = false,
                "w:p" => {
                    let text = para_text.trim();
                    if text.is_empty() && !para.contains("<br/>") {
                        continue;
                    }
                    let chars = text.chars().count();
                    let html = match level.filter(|_| table_depth == 0) {
                        Some(l) => {
                            let anchor = b.heading(l, text);
                            format!("<h{l} id=\"{anchor}\">{para}</h{l}>\n")
                        }
                        None => format!("<p>{para}</p>\n"),
                    };
                    b.push(&html, chars);
                    if table_depth == 0 {
                        b.break_if_long();
                    }
                }
                "w:tc" => b.push("</td>", 0),
                "w:tr" => b.push("</tr>", 0),
                "w:tbl" => {
                    table_depth = table_depth.saturating_sub(1);
                    b.push("</table>\n", 0);
                }
                _ => {}
            },
            Tok::Text(t) if in_text => {
                let plain = crate::parse::normalize(&unescape(t));
                para_text.push_str(&plain);
                let mut piece = escape(&plain);
                if italic {
                    piece = format!("<em>{piece}</em>");
                }
                if bold {
                    piece = format!("<strong>{piece}</strong>");
                }
                para.push_str(&piece);
            }
            _ => {}
        }
    }
    Ok(b.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_标题进目录_表格能出来() {
        let book = markdown("# 合同\n\n前言 **加粗**\n\n## 第一条\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n### 细则\n\n内容\n\n## 第二条\n\n完");
        assert_eq!(book.sections.len(), 1);
        let html = &book.sections[0].html;
        assert!(html.contains("<h1 id=\"h1\">合同</h1>"), "{html}");
        assert!(html.contains("<table>") && html.contains("<strong>加粗</strong>"));
        assert_eq!(book.toc.len(), 1);
        assert_eq!(book.toc[0].label, "合同");
        assert_eq!(book.toc[0].subitems.len(), 2);
        assert_eq!(book.toc[0].subitems[0].subitems[0].label, "细则");
        assert_eq!(book.toc[0].subitems[1].href, "s0#h4");
    }

    #[test]
    fn 文本_按章分节() {
        let book = plain("楔子\n很久以前。\n\n第一章 雨夜\n雨下了一夜。\n第二段。\n\n第二章 底片\n洗出来了。\n这句话里有第三章三个字但不是标题，因为它很长很长很长很长很长很长很长很长很长很长很长。");
        assert_eq!(book.sections.len(), 3);
        assert_eq!(book.toc.len(), 3);
        assert_eq!(book.toc[1].label, "第一章 雨夜");
        assert_eq!(book.toc[1].href, "s1#h2");
        assert!(book.sections[1].html.contains("<p>第二段。</p>"));
        assert!(chapter_title("第十二回 风雪"));
        assert!(chapter_title("Chapter 3"));
        assert!(!chapter_title("第一次见面"));
    }

    #[test]
    fn 没有标题的长文也会分节_原始html不进页面() {
        let para = format!("{}\n\n", "字".repeat(1000));
        let book = markdown(&para.repeat(100));
        assert!(book.sections.len() >= 2, "10 万字不该排成一节");
        let book =
            markdown("正文 <script>alert(1)</script>\n\n<style>body{display:none}</style>\n");
        let html = &book.sections[0].html;
        assert!(
            !html.contains("<script>") && !html.contains("<style>"),
            "{html}"
        );
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn 长文按大标题换节() {
        let mut src = String::new();
        for i in 0..4 {
            src.push_str(&format!(
                "## 第{}部分\n\n{}\n\n",
                i,
                "字".repeat(SECTION_CHARS)
            ));
        }
        let book = markdown(&src);
        assert_eq!(book.sections.len(), 4);
        assert_eq!(book.toc[3].href, "s3#h4");
    }
}
