//! 分块：按段落聚合到目标长度，块间留重叠，保留页码。
//! 长度按字符数算（中文一个字算一个）。

pub const TARGET: usize = 800; // 中文约 500-800 字一块：检索粒度和上下文成本的折中
pub const OVERLAP: usize = 120; // 相邻块重叠，避免答案正好被切断

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub idx: i64,
    pub page: Option<i64>,
    pub text: String,
}

pub fn chunk_pages(pages: &[(Option<i64>, String)]) -> Vec<Chunk> {
    let mut out = Vec::new();
    for (page, text) in pages {
        for piece in split_text(text, TARGET, OVERLAP) {
            out.push(Chunk {
                idx: out.len() as i64,
                page: *page,
                text: piece,
            });
        }
    }
    out
}

fn len(s: &str) -> usize {
    s.chars().count()
}

/// 取末尾 n 个字符
fn tail(s: &str, n: usize) -> String {
    let total = len(s);
    s.chars().skip(total.saturating_sub(n)).collect()
}

pub fn split_text(text: &str, target: usize, overlap: usize) -> Vec<String> {
    let clean = text.replace("\r\n", "\n");
    let clean = clean.trim();
    if clean.is_empty() {
        return vec![];
    }
    if len(clean) <= target {
        return vec![clean.to_string()];
    }

    // 先按空行切段，短段落拼到目标长度
    let mut pieces: Vec<String> = Vec::new();
    let mut buf = String::new();
    for para in clean.split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        if len(para) > target {
            if !buf.trim().is_empty() {
                pieces.push(buf.trim().to_string());
            }
            buf.clear();
            pieces.extend(hard_split(para, target, overlap));
            continue;
        }
        if len(&buf) + len(para) + 1 > target && !buf.trim().is_empty() {
            pieces.push(buf.trim().to_string());
            buf.clear();
        }
        if !buf.is_empty() {
            buf.push('\n');
        }
        buf.push_str(para);
    }
    if !buf.trim().is_empty() {
        pieces.push(buf.trim().to_string());
    }
    pieces
}

/// 超长段落按句子边界切，带重叠；连标点都没有的长串按长度硬切
fn hard_split(text: &str, target: usize, overlap: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut sentence = String::new();
    let flush_sentence = |sentence: &mut String, buf: &mut String, out: &mut Vec<String>| {
        if len(buf) + len(sentence) > target && !buf.is_empty() {
            out.push(buf.trim().to_string());
            *buf = tail(buf, overlap);
        }
        buf.push_str(sentence);
        sentence.clear();
        while len(buf) > target * 3 / 2 {
            let head: String = buf.chars().take(target).collect();
            out.push(head.trim().to_string());
            *buf = buf.chars().skip(target - overlap).collect();
        }
    };
    for c in text.chars() {
        sentence.push(c);
        if matches!(c, '。' | '！' | '？' | '!' | '?' | '；' | ';' | '\n') {
            flush_sentence(&mut sentence, &mut buf, &mut out);
        }
    }
    flush_sentence(&mut sentence, &mut buf, &mut out);
    if !buf.trim().is_empty() {
        out.push(buf.trim().to_string());
    }
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 短文本不切_空白返回空() {
        assert_eq!(split_text("一句话。", TARGET, OVERLAP), vec!["一句话。"]);
        assert!(split_text("   \n\n  ", TARGET, OVERLAP).is_empty());
    }

    #[test]
    fn 超长文本切开且每块不超过上限() {
        let text = "这是一个句子。".repeat(400);
        let parts = split_text(&text, 300, 50);
        assert!(parts.len() > 5);
        assert!(parts.iter().all(|p| len(p) <= 450), "有块超过上限");
    }

    #[test]
    fn 没有标点的长串也能切完不死循环() {
        let parts = split_text(&"x".repeat(5000), 400, 40);
        assert!(parts.len() > 5);
        assert!(parts.iter().map(|p| len(p)).sum::<usize>() >= 5000);
    }

    #[test]
    fn 短段落合并_页码保留_序号连续() {
        assert_eq!(
            split_text("第一段。\n\n第二段。\n\n第三段。", 100, 10).len(),
            1
        );
        let chunks = chunk_pages(&[(Some(1), "甲".repeat(2600)), (Some(2), "乙段落。".into())]);
        assert!(chunks.len() > 2);
        assert_eq!(chunks[0].page, Some(1));
        assert_eq!(chunks.last().unwrap().page, Some(2));
        assert!(chunks.iter().enumerate().all(|(i, c)| c.idx == i as i64));
    }
}
