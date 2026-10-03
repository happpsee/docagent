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

/// 超长段落按句子边界切，带重叠；连标点都没有的长串按长度硬切。
///
/// 全程在字符数组上用下标前进：之前每切一块都把剩下的整段重新复制、重新数一遍字数，
/// 一个 10 MB 的单行文件要切上万次，导入会卡死在它上面。
fn hard_split(text: &str, target: usize, overlap: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let is_end = |i: usize| {
        matches!(chars[i], '。' | '！' | '？' | '!' | '?' | '；' | ';' | '\n')
            // 英文句号后面跟着空白才算一句的结尾（不然小数、缩写都会被切开）
            || (chars[i] == '.' && chars.get(i + 1).is_some_and(|c| c.is_whitespace()))
    };
    let mut out = Vec::new();
    let mut start = 0;
    while start < n {
        let hi = (start + target).min(n);
        // 在后半段里找最后一个句子结尾；没有就按目标长度硬切
        let cut = if hi == n {
            n
        } else {
            (start + target / 2..hi)
                .rev()
                .find(|&i| is_end(i))
                .map(|i| i + 1)
                .unwrap_or(hi)
        };
        out.push(chars[start..cut].iter().collect::<String>());
        if cut == n {
            break;
        }
        // 下一块往回带一点重叠，但必须往前走
        start = if cut > start + overlap {
            cut - overlap
        } else {
            cut
        };
    }
    out.into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
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
    fn 巨大的单行文本很快切完_英文按句号断开() {
        let big = "0123456789".repeat(300_000); // 3 MB，一个标点都没有
        let t = std::time::Instant::now();
        let parts = split_text(&big, TARGET, OVERLAP);
        assert!(t.elapsed().as_secs() < 5, "切得太慢：{:?}", t.elapsed());
        assert!(parts.len() > 3000 && parts.iter().all(|p| len(p) <= TARGET * 3 / 2));

        let english = "This is a sentence about version 3.14 of the engine. ".repeat(60);
        let parts = split_text(&english, 300, 40);
        assert!(parts.len() > 5);
        assert!(
            parts.iter().all(|p| p.ends_with('.')),
            "应在句号处断开：{parts:?}"
        );
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
