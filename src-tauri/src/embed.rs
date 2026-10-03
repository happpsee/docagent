//! 本地哈希向量：字符 2-gram / 3-gram 散列到固定维度后归一化。
//!
//! 只做字面匹配，不理解语义，但完全离线、零依赖。
//! 维度与 n-gram 范围是实测定的：256 维或带 1-gram 时，无关文本的相似度底噪
//! 高到和相关文本分不开；1024 维 + 2/3-gram 下相关约 0.29、无关约 0.08。

pub const DIM: usize = 1024;

/// 归一化向量的 L2 距离超过这个值，基本等于没命中（相关约 1.19，无关约 1.36）
pub const NO_MATCH_DISTANCE: f64 = 1.3;

pub fn hash_embed(text: &str) -> Vec<f32> {
    let chars: Vec<char> = text
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .collect();
    let mut v = vec![0f64; DIM];
    for n in 2..=3usize {
        if chars.len() < n {
            continue;
        }
        for win in chars.windows(n) {
            // FNV-1a
            let mut h: u32 = 2166136261;
            for c in win {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    h ^= b as u32;
                    h = h.wrapping_mul(16777619);
                }
            }
            v[(h as usize) % DIM] += 1.0 / n as f64;
        }
    }
    let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    let norm = if norm == 0.0 { 1.0 } else { norm };
    v.into_iter().map(|x| (x / norm) as f32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dot(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[test]
    fn 维度固定且归一化() {
        let v = hash_embed("随便一句话");
        assert_eq!(v.len(), DIM);
        assert!((dot(&v, &v) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn 空串不出错() {
        let v = hash_embed("");
        assert!(v.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn 相关文本明显比无关文本相似() {
        let doc = hash_embed(
            "第四条 质保：质保期为验收合格之日起 24 个月。质保期内非人为损坏，乙方免费维修或更换。",
        );
        let related = dot(&doc, &hash_embed("质保期多久"));
        let unrelated = dot(&doc, &hash_embed("午饭吃什么比较好"));
        assert!(
            related > unrelated * 2.0,
            "related={related} unrelated={unrelated}"
        );
    }
}
