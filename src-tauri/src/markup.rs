//! 宽容的标记扫描器：把 XML / HTML 切成「开标签、闭标签、文字」。
//!
//! 电子书里的标记经常不规范（没闭合、带 HTML 实体、编码声明乱写），严格的 XML
//! 解析器遇到就整本失败。这里只做词法切分，不建树、不校验，够提取文字和读清单用。

pub enum Tok<'a> {
    Open {
        name: &'a str,
        attrs: &'a str,
        self_close: bool,
    },
    Close(&'a str),
    /// 原始文字，实体还没解码；CDATA 里的内容也走这里
    Text(&'a str),
    /// CDATA：不需要解码实体
    Raw(&'a str),
}

pub struct Tokens<'a> {
    src: &'a str,
    pos: usize,
}

pub fn tokens(src: &str) -> Tokens<'_> {
    Tokens { src, pos: 0 }
}

impl<'a> Iterator for Tokens<'a> {
    type Item = Tok<'a>;
    fn next(&mut self) -> Option<Tok<'a>> {
        loop {
            let rest = &self.src[self.pos..];
            if rest.is_empty() {
                return None;
            }
            if !rest.starts_with('<') {
                let end = rest.find('<').unwrap_or(rest.len());
                self.pos += end;
                return Some(Tok::Text(&rest[..end]));
            }
            if let Some(body) = rest.strip_prefix("<!--") {
                self.pos += body.find("-->").map(|i| i + 7).unwrap_or(rest.len());
                continue;
            }
            if let Some(body) = rest.strip_prefix("<![CDATA[") {
                let end = body.find("]]>").unwrap_or(body.len());
                self.pos += (9 + end + 3).min(rest.len());
                return Some(Tok::Raw(&body[..end]));
            }
            let Some(end) = rest.find('>') else {
                // 尾巴上一个没闭合的 <，当文字
                self.pos = self.src.len();
                return Some(Tok::Text(rest));
            };
            self.pos += end + 1;
            let inner = &rest[1..end];
            if inner.starts_with('!') || inner.starts_with('?') {
                continue;
            }
            if let Some(name) = inner.strip_prefix('/') {
                return Some(Tok::Close(name.trim()));
            }
            let self_close = inner.ends_with('/');
            let inner = inner.trim_end_matches('/');
            let cut = inner
                .find(|c: char| c.is_whitespace())
                .unwrap_or(inner.len());
            let name = &inner[..cut];
            if name.is_empty() {
                continue;
            }
            return Some(Tok::Open {
                name,
                attrs: &inner[cut..],
                self_close,
            });
        }
    }
}

/// 去掉命名空间前缀：`dc:title` → `title`
pub fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

/// 从标签的属性串里取一个属性。key 不带前缀时，带前缀的同名属性也算（`w:val` 匹配 `val`）
pub fn attr(attrs: &str, key: &str) -> Option<String> {
    let b = attrs.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i] != b'=' && !b[i].is_ascii_whitespace() {
            i += 1;
        }
        let name = &attrs[start..i];
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() || b[i] != b'=' {
            continue;
        }
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let value = if b[i] == b'"' || b[i] == b'\'' {
            let q = b[i];
            i += 1;
            let vs = i;
            while i < b.len() && b[i] != q {
                i += 1;
            }
            let v = &attrs[vs..i];
            i += 1;
            v
        } else {
            let vs = i;
            while i < b.len() && !b[i].is_ascii_whitespace() {
                i += 1;
            }
            &attrs[vs..i]
        };
        if name == key || (!key.contains(':') && local(name) == key) {
            return Some(unescape(value));
        }
    }
    None
}

/// 解码实体。不认识的原样留着
pub fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let end = rest.find(';').filter(|&e| e <= 10);
        let decoded = end.and_then(|e| {
            let name = &rest[1..e];
            let c = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" | "ensp" | "emsp" | "thinsp" => Some(' '),
                "mdash" => Some('—'),
                "ndash" => Some('–'),
                "hellip" => Some('…'),
                "lsquo" => Some('‘'),
                "rsquo" => Some('’'),
                "ldquo" => Some('“'),
                "rdquo" => Some('”'),
                "middot" => Some('·'),
                "copy" => Some('©'),
                _ => {
                    let num = name.strip_prefix('#')?;
                    let code = match num.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                        None => num.parse().ok()?,
                    };
                    char::from_u32(code)
                }
            };
            c.map(|c| (c, e))
        });
        match decoded {
            Some((c, e)) => {
                out.push(c);
                rest = &rest[e + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

const BLOCK: [&str; 24] = [
    "p",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "tr",
    "table",
    "section",
    "article",
    "blockquote",
    "pre",
    "dt",
    "dd",
    "ul",
    "ol",
    "title",
    "subtitle",
    "v",
    "stanza",
    "hr",
];
const SKIP: [&str; 4] = ["script", "style", "head", "binary"];

/// HTML / XHTML / FB2 → 纯文本。块级标签变成空行，脚本和样式丢掉。
pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut skip: Option<String> = None;
    for tok in tokens(html) {
        if let Some(until) = &skip {
            if let Tok::Close(name) = &tok {
                if local(name).eq_ignore_ascii_case(until) {
                    skip = None;
                }
            }
            continue;
        }
        match tok {
            Tok::Open {
                name, self_close, ..
            } => {
                let n = local(name).to_ascii_lowercase();
                if SKIP.contains(&n.as_str()) && !self_close {
                    skip = Some(n);
                } else if n == "br" {
                    out.push('\n');
                } else if n == "td" || n == "th" {
                    out.push(' ');
                } else if BLOCK.contains(&n.as_str()) {
                    out.push_str("\n\n");
                }
            }
            Tok::Close(name) => {
                if BLOCK.contains(&local(name).to_ascii_lowercase().as_str()) {
                    out.push_str("\n\n");
                }
            }
            Tok::Text(t) => {
                // 源码里的换行和缩进只是排版，折成一个空格
                let t = unescape(t);
                let mut last_space = out.ends_with([' ', '\n']) || out.is_empty();
                for c in t.chars() {
                    if c.is_whitespace() {
                        if !last_space {
                            out.push(' ');
                            last_space = true;
                        }
                    } else {
                        out.push(c);
                        last_space = false;
                    }
                }
            }
            Tok::Raw(t) => out.push_str(t),
        }
    }
    // 连续空行压成一个
    let mut clean = String::with_capacity(out.len());
    for para in out.split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        if !clean.is_empty() {
            clean.push_str("\n\n");
        }
        clean.push_str(para);
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 去标签_解实体_丢脚本() {
        let html = "<html><head><title>x</title><style>p{color:red}</style></head><body>\n<h1>第一章</h1>\n<p>他说：&ldquo;A&amp;B&rdquo;&#x4E2D;&#25991;<br/>下一行</p><script>alert(1)</script><p>第二段</p></body></html>";
        assert_eq!(
            html_to_text(html),
            "第一章\n\n他说：“A&B”中文\n下一行\n\n第二段"
        );
    }

    #[test]
    fn 属性_带前缀和不带前缀都能取() {
        let a = r#" w:val="Heading1" id='x' full-path="OEBPS/a&amp;b.opf""#;
        assert_eq!(attr(a, "val").as_deref(), Some("Heading1"));
        assert_eq!(attr(a, "w:val").as_deref(), Some("Heading1"));
        assert_eq!(attr(a, "id").as_deref(), Some("x"));
        assert_eq!(attr(a, "full-path").as_deref(), Some("OEBPS/a&b.opf"));
        assert_eq!(attr(a, "nope"), None);
    }

    #[test]
    fn 不规范的标记不崩() {
        assert_eq!(
            html_to_text("<p>没闭合 <b>加粗 & 符号"),
            "没闭合 加粗 & 符号"
        );
        assert_eq!(html_to_text("a < b"), "a < b");
        assert_eq!(html_to_text("<![CDATA[原样 <x>]]>"), "原样 <x>");
    }
}
