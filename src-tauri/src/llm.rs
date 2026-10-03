//! 直接调模型接口（Anthropic 兼容的 /v1/messages），不经过 agent。
//!
//! 给「透视」这种批量的、不需要工具的活用：一段文字进去、一段 JSON 出来，
//! 几十段并行跑。走 agent 的话每段都要起一轮完整的对话，又慢又贵。

use crate::agent::Provider;
use anyhow::{anyhow, Result};
use std::time::Duration;

pub fn complete(p: &Provider, system: &str, user: &str, max_tokens: u32) -> Result<String> {
    let url = format!("{}/v1/messages", p.base_url.trim_end_matches('/'));
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(120))
        .build();
    let body = serde_json::json!({
        "model": p.model,
        "max_tokens": max_tokens,
        // 提取类的活不需要模型先想一大段；不关的话输出额度会被思考过程占掉
        "thinking": { "type": "disabled" },
        "system": system,
        "messages": [{ "role": "user", "content": user }],
    });
    let resp = agent
        .post(&url)
        .set("x-api-key", &p.api_key)
        .set("authorization", &format!("Bearer {}", p.api_key))
        .set("anthropic-version", "2023-06-01")
        .send_json(body);
    let v: serde_json::Value = match resp {
        Ok(r) => r.into_json()?,
        Err(ureq::Error::Status(code, r)) => {
            let detail: String = r
                .into_string()
                .unwrap_or_default()
                .chars()
                .take(200)
                .collect();
            return Err(anyhow!("模型接口返回 {code}：{detail}"));
        }
        Err(e) => return Err(anyhow!("连不上模型接口：{e}")),
    };
    let text: String = v["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(anyhow!("模型没有返回内容"));
    }
    Ok(text)
}

/// 模型说了「只输出 JSON」也常常包一层代码块或加一句开场白，取最外层的那对花括号
pub fn json_object(text: &str) -> Result<serde_json::Value> {
    let start = text.find('{').ok_or_else(|| anyhow!("返回里没有 JSON"))?;
    let end = text.rfind('}').ok_or_else(|| anyhow!("返回里没有 JSON"))?;
    if end <= start {
        return Err(anyhow!("返回里没有 JSON"));
    }
    serde_json::from_str(&text[start..=end]).map_err(|e| anyhow!("返回的 JSON 解析不了：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 从带包装的回答里取出json() {
        let v = json_object(
            "好的，结果如下：\n```json\n{\"summary\": \"两句话\", \"entities\": []}\n```",
        )
        .unwrap();
        assert_eq!(v["summary"], "两句话");
        assert!(json_object("没有结果").is_err());
        assert!(json_object("} 反了 {").is_err());
    }
}
