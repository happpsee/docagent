//! 学习教练：到了一个「决策点」（一段大致读完了、在一段上卡了很久），由模型决定要不要打断读者、提什么建议。
//!
//! 代码只负责两头：前面把行为数据整理成一份摘要（都是数字和概念名，不带原文），后面按频率规矩决定能不能推。
//! 中间这一步——此刻该不该打断、说哪句话——交给模型，因为它要综合读得怎么样、掌握得怎么样、以前在哪儿错过。

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::{learn, llm};

pub const SYSTEM: &str = "你是读者的学习教练，决定此刻要不要打断他。打断是有代价的：没有明确的好处就不要打断。只输出一个 JSON 对象，不要解释，不要代码块。";

/// 界面送来的这一段的阅读情况
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    /// done：这一段读完、翻过去了；stuck：在这一段上停了很久
    pub why: String,
    pub doc_id: String,
    pub unit: i64,
    /// 这一段的字数、实际停留的秒数、按字数估的「至少要读多久」
    pub chars: i64,
    pub seconds: i64,
    pub expected: i64,
    /// 往回翻了几次
    pub backs: i64,
    /// 这一段上划了几句、就这一段问过助手几次
    pub highlights: i64,
    pub asks: i64,
    /// 最近几次建议读者是接受还是关掉了，新的在后
    pub recent: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// quiz / explain / review / none
    pub action: String,
    /// 对读者说的那句话；none 时是空的
    pub message: String,
    /// 给开发者看的理由
    pub reason: String,
}

/// 这一段考过的概念和它们现在的掌握情况
fn unit_concepts(conn: &Connection, book_id: &str, doc_id: &str, unit: i64, now: i64) -> Result<Vec<String>> {
    let overview = learn::overview(conn, book_id, now)?;
    let mut stmt = conn.prepare("SELECT DISTINCT concept FROM quiz_items WHERE doc_id = ?1 AND unit = ?2")?;
    let names: Vec<String> = stmt.query_map(params![doc_id, unit], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(names
        .into_iter()
        .map(|n| match overview.concepts.iter().find(|c| c.concept == n) {
            Some(c) if c.reps > 0 => format!("{n}（考过 {} 次，现在记得 {}%{}）", c.reps, (c.mastery * 100.0).round(), if c.last_grade == "lapsed" { "，上次没答上来" } else { "" }),
            _ => format!("{n}（没考过）"),
        })
        .collect())
}

pub fn prompt(conn: &Connection, book_id: &str, title: &str, s: &Signal, now: i64) -> Result<String> {
    let overview = learn::overview(conn, book_id, now)?;
    let concepts = unit_concepts(conn, book_id, &s.doc_id, s.unit, now)?;
    let wrong: Vec<String> = learn::notes(conn)?
        .into_iter()
        .filter(|n| n.kind == "misconception" || n.kind == "weakness" || n.kind == "preference")
        .take(8)
        .map(|n| format!("- {}", n.content))
        .collect();
    let what = if s.why == "stuck" { "在这一段上停了很久，还没翻过去" } else { "刚读完这一段，翻到了下一段" };
    Ok(format!(
        "读者在读《{title}》，{what}。\n\
         【这一段】{} 字；实际停留 {} 秒（快速浏览一遍大约要 {} 秒）；往回翻了 {} 次；划了 {} 句；就这一段问过助手 {} 次。\n\
         【这一段考过的概念】{}\n\
         【这本书】学会 {}%，现在有 {} 个概念该复习。\n\
         【关于这位读者】\n{}\n\
         【最近几次建议他的反应】{}\n\n\
         可选的动作：\n\
         - quiz：考他这一段。读得认真、这一段还没考过或者掌握得不牢时合适。\n\
         - explain：主动提出讲一讲。停留远超正常、来回翻、反复问，像是卡住了时合适。\n\
         - review：提醒他先复习到期的概念。到期的多、而这一段没什么新东西可考时合适。\n\
         - none：不打断。这一段的概念都记得牢、他最近连着关掉建议、或者没有明确的好处时，选这个。\n\
         message：对读者说的一句话，30 个字以内，说清你为什么现在提这个（只用上面给的事实，不要编；不要客套）；none 时留空。\n\
         输出：{{\"action\":\"quiz|explain|review|none\",\"message\":\"…\",\"reason\":\"一句话理由\"}}",
        s.chars,
        s.seconds,
        s.expected,
        s.backs,
        s.highlights,
        s.asks,
        if concepts.is_empty() { "还没出过题".to_string() } else { concepts.join("、") },
        (overview.learned * 100.0).round(),
        overview.due,
        if wrong.is_empty() { "（还不了解）".to_string() } else { wrong.join("\n") },
        if s.recent.is_empty() { "（还没提过建议）".to_string() } else { s.recent.join("、") },
    ))
}

pub fn parse(reply: &str) -> Result<Decision> {
    let v = llm::json_object(reply)?;
    let action = v["action"].as_str().unwrap_or("").trim();
    let action = match action {
        "quiz" | "explain" | "review" | "none" => action,
        other => anyhow::bail!("看不懂的动作：{other}"),
    };
    let message: String = v["message"].as_str().unwrap_or("").trim().chars().take(60).collect();
    // 要打断却没说为什么：当成不打断
    let action = if action != "none" && message.is_empty() { "none" } else { action };
    Ok(Decision {
        action: action.to_string(),
        message: if action == "none" { String::new() } else { message },
        reason: v["reason"].as_str().unwrap_or("").trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 决定_动作不认识报错_没说理由的当成不打断() {
        let d = parse(r#"{"action":"quiz","message":"这段你读得很细，考两道？","reason":"停留充分"}"#).unwrap();
        assert_eq!((d.action.as_str(), d.message.as_str()), ("quiz", "这段你读得很细，考两道？"));
        assert_eq!(parse(r#"{"action":"explain","message":""}"#).unwrap().action, "none");
        assert_eq!(parse(r#"{"action":"none","message":"随便说点"}"#).unwrap().message, "");
        assert!(parse(r#"{"action":"弹窗"}"#).is_err());
    }
}
