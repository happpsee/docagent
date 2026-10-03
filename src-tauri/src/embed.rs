//! 向量：调用户配置的向量接口（OpenAI 兼容的 /embeddings）。
//!
//! 不带本地模型——带一个进来安装包要大一百多 MB。没配接口时这一路就不工作，
//! 检索只走全文那一路（fts.rs）。

use anyhow::{anyhow, Result};
use rusqlite::Connection;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub struct EmbedConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// 一次请求送多少段。大多数服务商的上限在 32 到 100 之间，取小的
pub const BATCH: usize = 16;

/// 从应用设置里读向量接口的配置；三项没填全就当没配
pub fn config(conn: &Connection) -> Option<EmbedConfig> {
    let raw = crate::db::get_setting(conn, "settings").ok()??;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let field = |k: &str| {
        v[k].as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(EmbedConfig {
        base_url: field("embedBaseUrl")?,
        api_key: field("embedApiKey")?,
        model: field("embedModel")?,
    })
}

/// 算一批文字的向量。结果已归一化，顺序和输入一致
pub fn embed(cfg: &EmbedConfig, texts: &[&str], timeout: Duration) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    let url = format!("{}/embeddings", cfg.base_url.trim_end_matches('/'));
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let resp = agent
        .post(&url)
        .set("Authorization", &format!("Bearer {}", cfg.api_key))
        .send_json(serde_json::json!({ "model": cfg.model, "input": texts }));
    let body: serde_json::Value = match resp {
        Ok(r) => r.into_json()?,
        Err(ureq::Error::Status(code, r)) => {
            let detail: String = r
                .into_string()
                .unwrap_or_default()
                .chars()
                .take(200)
                .collect();
            return Err(anyhow!("向量接口返回 {code}：{detail}"));
        }
        Err(e) => return Err(anyhow!("连不上向量接口：{e}")),
    };
    let data = body["data"]
        .as_array()
        .ok_or_else(|| anyhow!("向量接口的返回里没有 data"))?;
    if data.len() != texts.len() {
        return Err(anyhow!(
            "向量接口返回了 {} 条，应该是 {} 条",
            data.len(),
            texts.len()
        ));
    }
    let mut out: Vec<Vec<f32>> = vec![vec![]; texts.len()];
    for (pos, item) in data.iter().enumerate() {
        // 规范里每条带 index；没带就按返回顺序
        let at = item["index"].as_u64().map(|i| i as usize).unwrap_or(pos);
        let v: Vec<f32> = item["embedding"]
            .as_array()
            .ok_or_else(|| anyhow!("向量接口的返回里没有 embedding"))?
            .iter()
            .map(|x| x.as_f64().unwrap_or(0.0) as f32)
            .collect();
        if v.is_empty() || at >= out.len() {
            return Err(anyhow!("向量接口返回的数据不完整"));
        }
        out[at] = normalize(v);
    }
    if out.iter().any(Vec::is_empty) {
        return Err(anyhow!("向量接口返回的数据不完整"));
    }
    Ok(out)
}

/// 归一化后，距离和余弦相似度一一对应，不同服务商的结果才可比
fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v
        .iter()
        .map(|x| (*x as f64) * (*x as f64))
        .sum::<f64>()
        .sqrt();
    if norm > 0.0 {
        for x in &mut v {
            *x = (*x as f64 / norm) as f32;
        }
    }
    v
}

#[cfg(test)]
pub mod testing {
    //! 测试用的假向量接口：按「文字里有没有某几个概念」给出向量，
    //! 同义的说法落在同一个方向上，用来验证语义这一路确实起作用。
    use super::EmbedConfig;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const CONCEPTS: [&[&str]; 4] = [
        &["违约金", "罚", "滞纳金"],
        &["质保", "保修", "免费维修"],
        &["付款", "支付", "预付款"],
        &["跑步", "音乐", "歌"],
    ];

    /// 前几维是概念（同义的说法落在同一维），后面 256 维是字面的散列，
    /// 长度压到概念的一半：没有共同概念的两段文字基本正交
    pub fn vector(text: &str) -> Vec<f32> {
        let mut v: Vec<f32> = CONCEPTS
            .iter()
            .map(|words| {
                if words.iter().any(|w| text.contains(w)) {
                    1.0
                } else {
                    0.0
                }
            })
            .collect();
        let mut hash = vec![0f32; 256];
        let chars: Vec<char> = text.chars().collect();
        for pair in chars.windows(2) {
            let h = (pair[0] as usize)
                .wrapping_mul(31)
                .wrapping_add(pair[1] as usize);
            hash[h % 256] += 1.0;
        }
        let norm = hash.iter().map(|x| x * x).sum::<f32>().sqrt().max(1.0);
        v.extend(hash.into_iter().map(|x| x / norm * 0.5));
        v
    }

    pub struct Fake {
        pub cfg: EmbedConfig,
        /// 收到了多少次请求
        pub calls: Arc<AtomicUsize>,
    }

    /// 起一个本机的假接口。fail_from：从第几次请求开始返回 500
    pub fn serve(fail_from: Option<usize>) -> Fake {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        std::thread::spawn(move || {
            for mut req in server.incoming_requests() {
                let n = seen.fetch_add(1, Ordering::SeqCst);
                if fail_from.is_some_and(|f| n >= f) {
                    let _ =
                        req.respond(tiny_http::Response::from_string("boom").with_status_code(500));
                    continue;
                }
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let v: serde_json::Value = serde_json::from_str(&body).unwrap();
                let data: Vec<_> = v["input"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .enumerate()
                    .map(|(i, t)| serde_json::json!({ "index": i, "embedding": vector(t.as_str().unwrap()) }))
                    .collect();
                let _ = req.respond(tiny_http::Response::from_string(
                    serde_json::json!({ "data": data }).to_string(),
                ));
            }
        });
        Fake {
            cfg: EmbedConfig {
                base_url: format!("http://127.0.0.1:{port}/v1"),
                api_key: "test".into(),
                model: "fake-embed".into(),
            },
            calls,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 配置_三项填全才算数() {
        let conn = crate::db::open_in_memory().unwrap();
        assert_eq!(config(&conn), None);
        crate::db::set_setting(
            &conn,
            "settings",
            r#"{"embedBaseUrl":"https://x/v1","embedApiKey":" ","embedModel":"m"}"#,
        )
        .unwrap();
        assert_eq!(config(&conn), None);
        crate::db::set_setting(
            &conn,
            "settings",
            r#"{"embedBaseUrl":"https://x/v1","embedApiKey":"k","embedModel":"m"}"#,
        )
        .unwrap();
        assert_eq!(config(&conn).unwrap().model, "m");
    }

    #[test]
    fn 调接口_结果归一化_顺序对得上() {
        let fake = testing::serve(None);
        let out = embed(
            &fake.cfg,
            &["违约金怎么算", "质保期多久"],
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(out.len(), 2);
        let norm: f32 = out[0].iter().map(|x| x * x).sum();
        assert!((norm - 1.0).abs() < 1e-4);
        assert!(out[0][0] > 0.8 && out[1][1] > 0.8);
    }

    #[test]
    fn 接口报错时给出看得懂的原因() {
        let fake = testing::serve(Some(0));
        let err = embed(&fake.cfg, &["x"], Duration::from_secs(5))
            .unwrap_err()
            .to_string();
        assert!(err.contains("500") && err.contains("boom"), "{err}");
    }
}
