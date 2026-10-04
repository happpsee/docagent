//! 文档解析：PDF / DOCX / Markdown / TXT / 电子书 → 按页的纯文本。
//!
//! 放在 Rust 里是因为这是 CPU 活：大文件在后台线程解析，不会卡住界面，
//! 也让「丢一整个文件夹进来」成为可能。

use anyhow::{anyhow, Context, Result};
use std::io::Read;
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

pub struct Parsed {
    pub kind: &'static str,
    /// (页码, 文本)。PDF 是页码，EPUB 是第几节，其它没有
    pub pages: Vec<(Option<i64>, String)>,
    pub page_count: Option<i64>,
    /// 书自带的书名、作者、封面原图（电子书才有）
    pub title: Option<String>,
    pub author: Option<String>,
    pub cover: Option<Vec<u8>>,
}

impl Parsed {
    fn plain(kind: &'static str, text: String) -> Self {
        Parsed {
            kind,
            pages: vec![(None, text)],
            page_count: None,
            title: None,
            author: None,
            cover: None,
        }
    }
}

/// 能导入的扩展名（和 kind_of 认的是同一批），给文件对话框做筛选用
pub const EXTENSIONS: [&str; 15] = [
    "pdf", "docx", "md", "markdown", "txt", "text", "epub", "mobi", "azw", "azw3", "kf8", "prc",
    "fb2", "fbz", "cbz",
];

pub fn kind_of(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_lowercase().as_str() {
        "pdf" => Some("pdf"),
        "docx" => Some("docx"),
        "md" | "markdown" => Some("md"),
        "txt" | "text" => Some("txt"),
        "epub" => Some("epub"),
        "mobi" | "azw" | "azw3" | "kf8" | "prc" => Some("mobi"),
        "fb2" | "fbz" => Some("fb2"),
        "cbz" => Some("cbz"),
        _ => None,
    }
}

/// NFKC：有些 PDF 把「日」「支」「金」存成康熙部首字符（U+2F00 段），
/// 看着一样、编码不同，不规范化的话检索和引文高亮都对不上。
pub fn normalize(s: &str) -> String {
    s.nfkc().collect()
}

pub fn extract(path: &Path) -> Result<Parsed> {
    let kind = kind_of(path).ok_or_else(|| anyhow!("不支持的文件类型"))?;
    let bytes = std::fs::read(path).with_context(|| format!("读不到文件 {}", path.display()))?;
    match kind {
        "pdf" => extract_pdf(&bytes),
        "docx" => Ok(Parsed::plain(kind, extract_docx(&bytes)?)),
        "epub" => crate::ebook::extract_epub(&bytes),
        "mobi" => crate::ebook::extract_mobi(&bytes),
        "fb2" => crate::ebook::extract_fb2(&bytes),
        "cbz" => crate::ebook::extract_cbz(&bytes),
        _ => Ok(Parsed::plain(kind, normalize(&decode_text(&bytes)))),
    }
}

fn extract_pdf(bytes: &[u8]) -> Result<Parsed> {
    // pdf-extract 遇到少见的 PDF 结构会 panic，这里兜住，变成普通错误
    let owned = bytes.to_vec();
    let pages =
        std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem_by_pages(&owned))
            .map_err(|_| anyhow!("这个 PDF 的结构解析不了"))?
            .map_err(|e| anyhow!("PDF 解析失败：{e}"))?;
    let page_count = pages.len() as i64;
    let pages: Vec<(Option<i64>, String)> = pages
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let flat = normalize(t)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            (Some(i as i64 + 1), flat)
        })
        .filter(|(_, t)| !t.is_empty())
        .collect();
    // 扫描件提不出文字：照样能导入阅读，只是搜不到里面的内容
    Ok(Parsed {
        kind: "pdf",
        pages,
        page_count: Some(page_count),
        title: None,
        author: None,
        cover: None,
    })
}

/// DOCX 是个 zip，正文在 word/document.xml：w:t 是文字，w:p 结束换段
pub fn extract_docx(bytes: &[u8]) -> Result<String> {
    use quick_xml::events::Event;
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).context("不是有效的 DOCX 文件")?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .context("DOCX 里找不到正文")?
        .take(crate::ebook::MAX_ENTRY)
        .read_to_string(&mut xml)?;

    let mut reader = quick_xml::Reader::from_str(&xml);
    let mut out = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.name().as_ref() == b"w:t" => in_text = true,
            Ok(Event::End(e)) if e.name().as_ref() == b"w:t" => in_text = false,
            Ok(Event::End(e)) if e.name().as_ref() == b"w:p" => out.push_str("\n\n"),
            Ok(Event::Empty(e)) if e.name().as_ref() == b"w:tab" => out.push('\t'),
            Ok(Event::Empty(e)) if e.name().as_ref() == b"w:br" => out.push('\n'),
            Ok(Event::Text(t)) if in_text => out.push_str(&t.decode().unwrap_or_default()),
            // &amp; 这类实体在新版 quick-xml 里是单独的事件
            Ok(Event::GeneralRef(r)) if in_text => {
                if let Ok(Some(c)) = r.resolve_char_ref() {
                    out.push(c);
                } else {
                    match r.decode().unwrap_or_default().as_ref() {
                        "amp" => out.push('&'),
                        "lt" => out.push('<'),
                        "gt" => out.push('>'),
                        "quot" => out.push('"'),
                        "apos" => out.push('\''),
                        _ => {}
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow!("DOCX 正文解析失败：{e}")),
            _ => {}
        }
    }
    let text = normalize(out.trim());
    if text.is_empty() {
        return Err(anyhow!("DOCX 解析后是空的"));
    }
    Ok(text)
}

/// 文本文件不一定是 UTF-8（老的中文文档常见 GBK），先按 UTF-8 试，不行再猜编码
pub fn decode_text(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.trim_start_matches('\u{feff}').to_string();
    }
    let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    det.feed(bytes, true);
    let (text, _, _) = det
        .guess(None, chardetng::Utf8Detection::Allow)
        .decode(bytes);
    text.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn doc(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../test-docs")
            .join(name)
    }

    #[test]
    fn pdf_按页提取_中文正确_康熙部首已规范化() {
        let p = extract(&doc("采购合同.pdf")).unwrap();
        assert_eq!(p.kind, "pdf");
        assert_eq!(p.page_count, Some(3));
        let first = &p.pages[0];
        assert_eq!(first.0, Some(1));
        // 原始提取里「日」「支」是康熙部首，规范化后才能按普通汉字匹配到
        assert!(
            first.1.contains("工作日内支付"),
            "第一页: {}",
            &first.1[..first.1.len().min(300)]
        );
        assert!(first.1.contains("质保期"));
    }

    #[test]
    fn markdown_原样读取() {
        let p = extract(&doc("服务协议.md")).unwrap();
        assert_eq!(p.kind, "md");
        assert!(p.pages[0].1.contains("每年 96000 元"));
        assert_eq!(p.pages[0].0, None);
    }

    #[test]
    fn gbk_编码的文本能读对() {
        let (bytes, _, _) =
            encoding_rs::GBK.encode("这是一份用旧编码保存的合同文本，付款期限为三十天。");
        assert!(std::str::from_utf8(&bytes).is_err());
        assert!(decode_text(&bytes).contains("付款期限为三十天"));
    }

    #[test]
    fn 不支持的类型报错() {
        assert!(extract(Path::new("/tmp/a.xyz")).is_err());
        assert_eq!(kind_of(Path::new("a.PDF")), Some("pdf"));
        // 文件对话框里列的扩展名都得是真能导入的
        assert!(EXTENSIONS
            .iter()
            .all(|ext| kind_of(Path::new(&format!("a.{ext}"))).is_some()));
    }
}
