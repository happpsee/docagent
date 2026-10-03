//! 电子书：EPUB / MOBI / AZW3 / FB2 / CBZ → 可索引的文字、书名作者、封面。
//!
//! 排版显示在 WebView 里做（分页靠浏览器的排版引擎），这里只管把字拿出来建索引，
//! 所以不需要理解样式，按阅读顺序把每一节的文字抽出来就行。

use crate::markup::{attr, html_to_text, local, tokens, Tok};
use crate::parse::{normalize, Parsed};
use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::io::{Cursor, Read};

type Zip<'a> = zip::ZipArchive<Cursor<&'a [u8]>>;

fn read_entry(zip: &mut Zip, name: &str) -> Option<Vec<u8>> {
    let mut f = zip.by_name(name).ok()?;
    let mut buf = Vec::with_capacity(f.size() as usize);
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn read_text(zip: &mut Zip, name: &str) -> Option<String> {
    read_entry(zip, name).map(|b| crate::parse::decode_text(&b))
}

/// 清单里的 href 是相对 OPF 所在目录的，还可能带 %20 和 ../
fn resolve(base_dir: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or(href);
    let mut bytes = Vec::with_capacity(href.len());
    let raw = href.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let Ok(v) = u8::from_str_radix(&href[i + 1..i + 3], 16) {
                bytes.push(v);
                i += 3;
                continue;
            }
        }
        bytes.push(raw[i]);
        i += 1;
    }
    let href = String::from_utf8_lossy(&bytes);
    let mut parts: Vec<&str> = if href.starts_with('/') {
        vec![]
    } else {
        base_dir.split('/').filter(|p| !p.is_empty()).collect()
    };
    for p in href.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

struct Item {
    href: String,
    media: String,
    props: String,
}

pub fn extract_epub(bytes: &[u8]) -> Result<Parsed> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).context("不是有效的 EPUB 文件")?;
    let container = read_text(&mut zip, "META-INF/container.xml")
        .ok_or_else(|| anyhow!("EPUB 缺少 container.xml"))?;
    let opf_path = tokens(&container)
        .find_map(|t| match t {
            Tok::Open { name, attrs, .. } if local(name) == "rootfile" => attr(attrs, "full-path"),
            _ => None,
        })
        .ok_or_else(|| anyhow!("EPUB 里找不到内容清单"))?;
    let opf = read_text(&mut zip, &opf_path).ok_or_else(|| anyhow!("EPUB 的内容清单读不出来"))?;
    let base = opf_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");

    let mut items: HashMap<String, Item> = HashMap::new();
    let mut spine: Vec<String> = Vec::new();
    let mut title = None;
    let mut author = None;
    let mut cover_id = None;
    let mut capture: Option<&'static str> = None;
    for tok in tokens(&opf) {
        match tok {
            Tok::Open { name, attrs, .. } => match local(name) {
                "item" => {
                    if let (Some(id), Some(href)) = (attr(attrs, "id"), attr(attrs, "href")) {
                        items.insert(
                            id,
                            Item {
                                href: resolve(base, &href),
                                media: attr(attrs, "media-type").unwrap_or_default(),
                                props: attr(attrs, "properties").unwrap_or_default(),
                            },
                        );
                    }
                }
                "itemref" => {
                    if let Some(id) = attr(attrs, "idref") {
                        spine.push(id);
                    }
                }
                "meta" if attr(attrs, "name").as_deref() == Some("cover") => {
                    cover_id = attr(attrs, "content");
                }
                "title" if title.is_none() => capture = Some("title"),
                "creator" if author.is_none() => capture = Some("creator"),
                _ => {}
            },
            Tok::Text(t) | Tok::Raw(t) => {
                let v = crate::markup::unescape(t).trim().to_string();
                if !v.is_empty() {
                    match capture {
                        Some("title") => title = Some(v),
                        Some("creator") => author = Some(v),
                        _ => {}
                    }
                }
                capture = None;
            }
            Tok::Close(_) => capture = None,
        }
    }

    // 页码就是书脊里的第几节：阅读器按同样的顺序排，引用可以直接跳过去
    let mut pages = Vec::new();
    for (i, id) in spine.iter().enumerate() {
        let Some(item) = items.get(id) else { continue };
        if !item.media.contains("html") && !item.media.contains("xml") {
            continue;
        }
        let Some(html) = read_text(&mut zip, &item.href) else {
            continue;
        };
        let text = normalize(&html_to_text(&html));
        if !text.is_empty() {
            pages.push((Some(i as i64 + 1), text));
        }
    }

    // 封面：EPUB3 的 cover-image 属性 → EPUB2 的 meta cover → 清单里名字带 cover 的图
    let cover_href = items
        .values()
        .find(|it| it.props.split_whitespace().any(|p| p == "cover-image"))
        .or_else(|| cover_id.as_ref().and_then(|id| items.get(id)))
        .or_else(|| {
            items.values().find(|it| {
                it.media.starts_with("image/") && it.href.to_lowercase().contains("cover")
            })
        })
        .map(|it| it.href.clone());
    let cover = cover_href.and_then(|h| read_entry(&mut zip, &h));

    Ok(Parsed {
        kind: "epub",
        pages,
        page_count: None,
        title,
        author,
        cover,
    })
}

pub fn extract_fb2(bytes: &[u8]) -> Result<Parsed> {
    // .fbz / .fb2.zip：zip 里装着一份 .fb2
    let owned;
    let bytes = if bytes.starts_with(b"PK") {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).context("不是有效的 FB2 压缩包")?;
        let name = zip
            .file_names()
            .find(|n| n.to_lowercase().ends_with(".fb2"))
            .map(str::to_string)
            .ok_or_else(|| anyhow!("压缩包里没有 .fb2 文件"))?;
        owned = read_entry(&mut zip, &name).ok_or_else(|| anyhow!("FB2 读不出来"))?;
        &owned[..]
    } else {
        bytes
    };
    let xml = crate::parse::decode_text(bytes);
    let mut title = None;
    let mut first = None;
    let mut last = None;
    let mut capture: Option<&'static str> = None;
    let mut in_title_info = false;
    for tok in tokens(&xml) {
        match tok {
            Tok::Open { name, .. } => match local(name) {
                "title-info" => in_title_info = true,
                "book-title" if in_title_info => capture = Some("title"),
                "first-name" if in_title_info && first.is_none() => capture = Some("first"),
                "last-name" if in_title_info && last.is_none() => capture = Some("last"),
                "body" => break,
                _ => {}
            },
            Tok::Close(name) if local(name) == "title-info" => in_title_info = false,
            Tok::Text(t) => {
                let v = crate::markup::unescape(t).trim().to_string();
                if !v.is_empty() {
                    match capture.take() {
                        Some("title") => title = Some(v),
                        Some("first") => first = Some(v),
                        Some("last") => last = Some(v),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    let author = match (first, last) {
        (Some(f), Some(l)) => Some(format!("{f} {l}")),
        (a, b) => a.or(b),
    };
    let body = xml.find("<body").map(|i| &xml[i..]).unwrap_or(&xml);
    let text = normalize(&html_to_text(body));
    if text.is_empty() {
        return Err(anyhow!("FB2 解析后是空的"));
    }
    Ok(Parsed {
        kind: "fb2",
        pages: vec![(None, text)],
        page_count: None,
        title,
        author,
        cover: None,
    })
}

pub fn extract_mobi(bytes: &[u8]) -> Result<Parsed> {
    let owned = bytes.to_vec();
    // mobi 这个库遇到少见的文件结构会 panic，兜住
    let book = std::panic::catch_unwind(move || mobi::Mobi::new(owned))
        .map_err(|_| anyhow!("这个 MOBI 文件的结构解析不了"))?
        .map_err(|e| anyhow!("MOBI 解析失败：{e}"))?;
    let html = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        book.content_as_string_lossy()
    }))
    .map_err(|_| anyhow!("这个 MOBI 文件的正文解不出来（可能有 DRM）"))?;
    let text = normalize(&html_to_text(&html));
    if text.is_empty() {
        return Err(anyhow!("MOBI 里没有可提取的文字（可能有 DRM 保护）"));
    }
    let title = Some(book.title()).filter(|t| !t.trim().is_empty());
    let author = book.author().filter(|a| !a.trim().is_empty());
    // 没有可靠的封面指针时，取第一张能解码的图
    let cover = book
        .image_records()
        .into_iter()
        .map(|r| r.content.to_vec())
        .find(|b| image::guess_format(b).is_ok());
    Ok(Parsed {
        kind: "mobi",
        pages: vec![(None, text)],
        page_count: None,
        title,
        author,
        cover,
    })
}

/// 漫画包：一堆图片，没有文字可索引，第一张图当封面
pub fn extract_cbz(bytes: &[u8]) -> Result<Parsed> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).context("不是有效的 CBZ 文件")?;
    let mut names: Vec<String> = zip
        .file_names()
        .filter(|n| {
            let l = n.to_lowercase();
            [".jpg", ".jpeg", ".png", ".gif", ".webp"]
                .iter()
                .any(|e| l.ends_with(e))
        })
        .map(str::to_string)
        .collect();
    if names.is_empty() {
        return Err(anyhow!("CBZ 里没有图片"));
    }
    names.sort();
    let cover = read_entry(&mut zip, &names[0]);
    Ok(Parsed {
        kind: "cbz",
        pages: vec![],
        page_count: Some(names.len() as i64),
        title: None,
        author: None,
        cover,
    })
}

/// 封面缩成小图存库：书架只需要缩略图，原图动辄几 MB
pub fn thumbnail(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let small = img.thumbnail(320, 480).to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82)
        .encode_image(&small)
        .ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 路径解析() {
        assert_eq!(resolve("OEBPS", "ch1.xhtml#a"), "OEBPS/ch1.xhtml");
        assert_eq!(
            resolve("OEBPS/text", "../img/c%20v.jpg"),
            "OEBPS/img/c v.jpg"
        );
        assert_eq!(resolve("", "a/b.html"), "a/b.html");
    }

    #[test]
    fn epub_按节提取_带书名作者() {
        let path =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-docs/示例小说.epub");
        let p = extract_epub(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(p.title.as_deref(), Some("槐花开"));
        assert_eq!(p.author.as_deref(), Some("测试作者"));
        assert_eq!(p.pages.len(), 3);
        assert_eq!(p.pages[2].0, Some(3));
        assert!(p.pages[2].1.contains("等你到槐花开"));
        assert!(p.pages[0].1.starts_with("第一章 雨夜来客"));
    }

    #[test]
    fn fb2_提取() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><author><first-name>鲁</first-name><last-name>迅</last-name></author><book-title>故乡</book-title></title-info></description><body><section><title><p>一</p></title><p>我冒了严寒，回到相隔二千余里的故乡去。</p></section></body><binary id="c.jpg">AAAA</binary></FictionBook>"#;
        let p = extract_fb2(xml.as_bytes()).unwrap();
        assert_eq!(p.title.as_deref(), Some("故乡"));
        assert_eq!(p.author.as_deref(), Some("鲁 迅"));
        assert!(p.pages[0].1.starts_with("一\n\n我冒了严寒"));
        assert!(p.pages[0].1.contains("回到相隔二千余里的故乡去"));
    }
}
