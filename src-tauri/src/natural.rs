//! 自然顺序：一本书里各篇第一次进来时怎么排。
//!
//! 按字符编码排的话「第十章」会排在「第二章」前面、ch10 排在 ch2 前面，目录就乱了。
//! 这里把名字里的数字当数来比：阿拉伯数字、中文数字（第十二章）、上中下（卷上 / 卷下）都认。
//! 只用在第一次导入和新加进来的篇上；之后顺序以库里的 position 为准，用户可以手动调。

use std::cmp::Ordering;
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

/// 名字切出来的一小段。数字排在文字前面（派生的 Ord 按声明顺序比）
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Token {
    Num(u64),
    Text(String),
}

fn digit(c: char) -> Option<u64> {
    Some(match c {
        '零' | '〇' => 0,
        '一' => 1,
        '二' | '两' => 2,
        '三' => 3,
        '四' => 4,
        '五' => 5,
        '六' => 6,
        '七' => 7,
        '八' => 8,
        '九' => 9,
        _ => return None,
    })
}

fn unit(c: char) -> Option<u64> {
    Some(match c {
        '十' => 10,
        '百' => 100,
        '千' => 1000,
        _ => return None,
    })
}

/// 一串中文数字的值。带「十百千」的按读法算（一百零三 = 103，十二 = 12）；
/// 不带的是一位一位写的（二〇二四 = 2024）
fn chinese_value(run: &[char]) -> u64 {
    if !run.iter().any(|c| unit(*c).is_some()) {
        return run
            .iter()
            .filter_map(|c| digit(*c))
            .fold(0u64, |n, d| n.saturating_mul(10).saturating_add(d));
    }
    let (mut total, mut current) = (0u64, 0u64);
    for c in run {
        if let Some(d) = digit(*c) {
            current = d;
        } else if let Some(u) = unit(*c) {
            // 「十二」开头的十前面没有数，当一十
            total = total.saturating_add(current.max(1).saturating_mul(u));
            current = 0;
        }
    }
    total.saturating_add(current)
}

fn is_han(c: char) -> bool {
    matches!(c, '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}')
}

/// 上中下当序号用的时候按 1、2、3 排：后面没有字了（卷上、红楼梦下）、跟着的不是汉字（「（上）」「上 01」）、
/// 或者跟着册卷篇这类量词（上册、下卷）。
/// 夹在词里的不算（中文说明、下载、上手指南）——不然这些再普通不过的名字会被当成数字开头，
/// 排到所有文字开头的名字前面去。
fn ordinal(chars: &[char], i: usize) -> Option<u64> {
    let n = match chars[i] {
        '上' => 1,
        '中' => 2,
        '下' => 3,
        _ => return None,
    };
    let marker = match chars.get(i + 1) {
        None => true,
        Some(next) => !is_han(*next) || "卷册篇部集辑编章节回季期半".contains(*next),
    };
    marker.then_some(n)
}

/// 把一段名字切成数字和文字相间的小段。先做 NFKC（全角数字变半角）再转小写
fn tokens(s: &str) -> Vec<Token> {
    let chars: Vec<char> = s.nfkc().flat_map(char::to_lowercase).collect();
    let mut out = Vec::new();
    let mut text = String::new();
    let mut i = 0;
    let flush = |text: &mut String, out: &mut Vec<Token>| {
        if !text.is_empty() {
            out.push(Token::Text(std::mem::take(text)));
        }
    };
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_digit() {
            flush(&mut text, &mut out);
            let mut n = 0u64;
            while i < chars.len() && chars[i].is_ascii_digit() {
                n = n
                    .saturating_mul(10)
                    .saturating_add(chars[i].to_digit(10).unwrap_or(0) as u64);
                i += 1;
            }
            out.push(Token::Num(n));
        } else if digit(c).is_some() || unit(c).is_some() {
            flush(&mut text, &mut out);
            let start = i;
            while i < chars.len() && (digit(chars[i]).is_some() || unit(chars[i]).is_some()) {
                i += 1;
            }
            out.push(Token::Num(chinese_value(&chars[start..i])));
        } else if let Some(n) = ordinal(&chars, i) {
            flush(&mut text, &mut out);
            out.push(Token::Num(n));
            i += 1;
        } else {
            text.push(c);
            i += 1;
        }
    }
    flush(&mut text, &mut out);
    out
}

/// 一个相对路径的排序键：一层目录一组；最后一层（文件名）不带扩展名，
/// 不然「a.md」和「a-1.md」会因为点和横线的编码先后排反
fn key(rel: &Path) -> Vec<Vec<Token>> {
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    let last = parts.len().saturating_sub(1);
    parts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            if i == last {
                let stem = Path::new(p)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone());
                tokens(&stem)
            } else {
                tokens(p)
            }
        })
        .collect()
}

/// 比较两个相对路径：一层一层比，数字按大小、文字不分大小写。
/// 完全比不出先后时（ch02 和 ch2）退回按原样的字符串比，保证结果稳定
pub fn cmp(a: &Path, b: &Path) -> Ordering {
    key(a).cmp(&key(b)).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(names: &[&str]) -> Vec<String> {
        let mut v: Vec<&str> = names.to_vec();
        v.sort_by(|a, b| cmp(Path::new(a), Path::new(b)));
        v.into_iter().map(String::from).collect()
    }

    #[test]
    fn 中文数字按数值排_第一章到第十二章() {
        let chapters = [
            "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二",
        ];
        let want: Vec<String> = chapters.iter().map(|n| format!("第{n}章.md")).collect();
        // 按字符编码排的顺序是乱的，拿它当输入
        let mut shuffled: Vec<&str> = want.iter().map(String::as_str).collect();
        shuffled.sort();
        assert_ne!(
            shuffled,
            want.iter().map(String::as_str).collect::<Vec<_>>()
        );
        assert_eq!(sorted(&shuffled), want);
        assert_eq!(chinese_value(&['一', '百', '零', '三']), 103);
        assert_eq!(chinese_value(&['二', '〇', '二', '四']), 2024);
        assert_eq!(chinese_value(&['两', '千']), 2000);
    }

    #[test]
    fn 卷上卷中卷下按上中下排() {
        assert_eq!(
            sorted(&["卷下.txt", "卷中.txt", "卷上.txt"]),
            vec!["卷上.txt", "卷中.txt", "卷下.txt"]
        );
        assert_eq!(
            sorted(&["下册.epub", "上册.epub", "中册.epub"]),
            vec!["上册.epub", "中册.epub", "下册.epub"]
        );
        assert_eq!(
            sorted(&["红楼梦（下）.txt", "红楼梦（上）.txt"]),
            vec!["红楼梦（上）.txt", "红楼梦（下）.txt"]
        );
        // 词里的上中下不是序号：这几个名字照常按文字排，不会被提到最前面
        assert_eq!(
            sorted(&["中文说明.md", "下载.md", "api.md", "上手指南.md"]),
            vec!["api.md", "上手指南.md", "下载.md", "中文说明.md"]
        );
    }

    #[test]
    fn 阿拉伯数字按数值排_不分大小写_全角也认() {
        assert_eq!(
            sorted(&["ch10.md", "CH2.md", "ch1.md"]),
            vec!["ch1.md", "CH2.md", "ch10.md"]
        );
        assert_eq!(
            sorted(&["第１０回.txt", "第9回.txt"]),
            vec!["第9回.txt", "第１０回.txt"]
        );
        // 扩展名不参与：a 排在 a-1 前面
        assert_eq!(sorted(&["a-1.md", "a.md"]), vec!["a.md", "a-1.md"]);
    }

    #[test]
    fn 先比目录再比文件名() {
        assert_eq!(
            sorted(&["b/x.md", "a/x.md", "b/a.md", "a/y.md"]),
            vec!["a/x.md", "a/y.md", "b/a.md", "b/x.md"]
        );
        assert_eq!(
            sorted(&["part10/intro.md", "part2/intro.md"]),
            vec!["part2/intro.md", "part10/intro.md"]
        );
    }
}
