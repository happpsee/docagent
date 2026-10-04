//! 学习闭环：读完一段 → 出题 → 读者用自己的话答 → 对照原文批改 → 记下每个概念掌握得怎么样 → 到期复习。
//!
//! 概念就是透视里整理出来的人物与概念（按名字认）。每个概念一份记忆状态，用 FSRS 排下次什么时候复习；
//! 「掌握度」是此刻还记得的概率，会随时间往下掉——不复习，「学会了 73%」就不再是 73%。
//! 出题和批改是两次互不相干的模型调用：批改的那次只看题、评分要点、原文依据和回答。

use anyhow::Result;
use chrono::{DateTime, Utc};
use rs_fsrs::{Card, Parameters, Rating, State, FSRS};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};

use crate::llm;

/// 一段出几道题
const PER_UNIT: usize = 3;

pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS quiz_items (
            id         INTEGER PRIMARY KEY,
            book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            doc_id     TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
            unit       INTEGER NOT NULL,
            concept    TEXT NOT NULL,
            question   TEXT NOT NULL,
            rubric     TEXT NOT NULL,
            evidence   TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS quiz_items_unit ON quiz_items(doc_id, unit);
        CREATE TABLE IF NOT EXISTS concept_state (
            book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            concept     TEXT NOT NULL,
            stability   REAL NOT NULL,
            difficulty  REAL NOT NULL,
            state       INTEGER NOT NULL,
            reps        INTEGER NOT NULL,
            lapses      INTEGER NOT NULL,
            scheduled   INTEGER NOT NULL,
            last_review INTEGER NOT NULL,
            due         INTEGER NOT NULL,
            last_grade  TEXT NOT NULL,
            PRIMARY KEY (book_id, concept)
        );
        CREATE TABLE IF NOT EXISTS quiz_reviews (
            id       INTEGER PRIMARY KEY,
            item_id  INTEGER NOT NULL,
            book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            concept  TEXT NOT NULL,
            answer   TEXT NOT NULL,
            grade    TEXT NOT NULL,
            missing  TEXT NOT NULL,
            feedback TEXT NOT NULL,
            at       INTEGER NOT NULL
        );",
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub book_id: String,
    pub doc_id: String,
    pub unit: i64,
    pub concept: String,
    pub question: String,
    pub rubric: Vec<String>,
    /// 原文里一字不差的一句：批改的依据，也是「看原文」跳过去的地方
    pub evidence: String,
}

const ITEM_COLUMNS: &str = "id, book_id, doc_id, unit, concept, question, rubric, evidence";

fn item_row(r: &rusqlite::Row) -> rusqlite::Result<Item> {
    let rubric: String = r.get(6)?;
    Ok(Item {
        id: r.get(0)?,
        book_id: r.get(1)?,
        doc_id: r.get(2)?,
        unit: r.get(3)?,
        concept: r.get(4)?,
        question: r.get(5)?,
        rubric: serde_json::from_str(&rubric).unwrap_or_default(),
        evidence: r.get(7)?,
    })
}

pub fn items_for_unit(conn: &Connection, doc_id: &str, unit: i64) -> Result<Vec<Item>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ITEM_COLUMNS} FROM quiz_items WHERE doc_id = ?1 AND unit = ?2 ORDER BY id"
    ))?;
    let rows = stmt.query_map(params![doc_id, unit], item_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn item(conn: &Connection, id: i64) -> Result<Option<Item>> {
    Ok(conn
        .query_row(
            &format!("SELECT {ITEM_COLUMNS} FROM quiz_items WHERE id = ?1"),
            params![id],
            item_row,
        )
        .optional()?)
}

// ---------- 出题 ----------

pub const GEN_SYSTEM: &str = "你是出题老师。只输出一个 JSON 对象，不要解释，不要代码块。";

pub fn gen_prompt(text: &str, concepts: &[String]) -> String {
    let pick = if concepts.is_empty() {
        "concept 写这道题考的那个概念的名字（原文里的叫法，12 个字以内）".to_string()
    } else {
        format!(
            "concept 优先从这些里选，实在对不上再用原文里的叫法：{}",
            concepts.join("、")
        )
    };
    format!(
        "下面是读者刚读完的一段。出 {PER_UNIT} 道简答题，检查他是不是真的理解了，而不是只记住了字面。\n\
         要求：\n\
         - 每题考一个概念，各题考的概念不要重复；{pick}；\n\
         - 问「为什么」「怎么做」「有什么区别」「如果……会怎样」；不要问原文里一眼能抄到的定义，不要出选择题、判断题；\n\
         - 只凭这一段的内容就能答出来，不需要别的知识；\n\
         - rubric：2 到 4 条评分要点，每条一句话，是答对必须说到的意思；\n\
         - evidence：原文里一字不差的连续一句（15 到 60 个字），是答案的依据。\n\
         输出：{{\"items\":[{{\"concept\":\"…\",\"question\":\"…\",\"rubric\":[\"…\"],\"evidence\":\"…\"}}]}}\n\n\
         【原文】\n{text}"
    )
}

/// 复习时换个问法：同一个概念、同一段原文，避开已经问过的角度，只出一道
pub fn variant_prompt(text: &str, concept: &str, asked: &[String]) -> String {
    let asked: String = asked.iter().map(|q| format!("- {q}\n")).collect();
    format!(
        "读者在复习「{concept}」。下面是讲到它的那一段原文。再出 1 道简答题考他对「{concept}」的理解。\n\
         之前已经问过这些，换一个角度，不要只是改写措辞：\n{asked}\
         要求：\n\
         - concept 就写「{concept}」；\n\
         - 可以换成让他举例、比较、说出反例、解释后果、用自己的话讲给外行听；不要出选择题、判断题；\n\
         - 只凭这一段的内容就能答出来；\n\
         - rubric：2 到 4 条评分要点，每条一句话；\n\
         - evidence：原文里一字不差的连续一句（15 到 60 个字），是答案的依据。\n\
         输出：{{\"items\":[{{\"concept\":\"…\",\"question\":\"…\",\"rubric\":[\"…\"],\"evidence\":\"…\"}}]}}\n\n\
         【原文】\n{text}"
    )
}

/// 一个概念攒了这么多道题就不再出新的，在已有的里轮着问
pub const MAX_PER_CONCEPT: usize = 5;

/// 这个概念的所有题，按出题先后
pub fn items_for_concept(conn: &Connection, book_id: &str, concept: &str) -> Result<Vec<Item>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ITEM_COLUMNS} FROM quiz_items WHERE book_id = ?1 AND concept = ?2 ORDER BY id"
    ))?;
    let rows = stmt.query_map(params![book_id, concept], item_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// 这道题答过没有
pub fn answered(conn: &Connection, item_id: i64) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM quiz_reviews WHERE item_id = ?1)",
        params![item_id],
        |r| r.get(0),
    )?)
}

/// 已有的题里最久没问过的那道（没问过的排最前）
pub fn stalest(conn: &Connection, book_id: &str, concept: &str) -> Result<Option<Item>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {ITEM_COLUMNS} FROM quiz_items q WHERE book_id = ?1 AND concept = ?2
                 ORDER BY COALESCE((SELECT MAX(at) FROM quiz_reviews WHERE item_id = q.id), 0), id LIMIT 1"
            ),
            params![book_id, concept],
            item_row,
        )
        .optional()?)
}

/// 去掉所有空白再比：模型抄原文时常把换行、空格弄丢
fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

#[derive(Debug, PartialEq)]
pub struct NewItem {
    pub concept: String,
    pub question: String,
    pub rubric: Vec<String>,
    pub evidence: String,
}

/// 整理模型出的题。依据在原文里找不到的丢掉：那多半是模型自己编的，批改时没法对照
pub fn parse_items(reply: &str, text: &str) -> Result<Vec<NewItem>> {
    let v = llm::json_object(reply)?;
    let source = squash(text);
    let str_of = |v: &serde_json::Value| v.as_str().unwrap_or("").trim().to_string();
    let items: Vec<NewItem> = v["items"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|i| NewItem {
                    concept: str_of(&i["concept"]),
                    question: str_of(&i["question"]),
                    rubric: i["rubric"]
                        .as_array()
                        .map(|r| r.iter().map(str_of).filter(|s| !s.is_empty()).take(4).collect())
                        .unwrap_or_default(),
                    evidence: str_of(&i["evidence"]),
                })
                .filter(|i| {
                    !i.concept.is_empty()
                        && !i.question.is_empty()
                        && !i.rubric.is_empty()
                        && squash(&i.evidence).chars().count() >= 6
                        && source.contains(&squash(&i.evidence))
                })
                .take(PER_UNIT)
                .collect()
        })
        .unwrap_or_default();
    if items.is_empty() {
        anyhow::bail!("这一段没出成题（模型给的题对不上原文）");
    }
    Ok(items)
}

pub fn save_items(
    conn: &Connection,
    book_id: &str,
    doc_id: &str,
    unit: i64,
    items: &[NewItem],
    now: i64,
) -> Result<()> {
    for i in items {
        conn.execute(
            "INSERT INTO quiz_items(book_id, doc_id, unit, concept, question, rubric, evidence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![book_id, doc_id, unit, i.concept, i.question, serde_json::to_string(&i.rubric)?, i.evidence, now],
        )?;
    }
    Ok(())
}

// ---------- 批改 ----------

pub const GRADE_SYSTEM: &str = "你是严格的阅卷人。只根据评分要点和原文依据判断读者的回答，不要替他补上他没说的意思。只输出一个 JSON 对象，不要解释，不要代码块。";

pub fn grade_prompt(item: &Item, answer: &str) -> String {
    let rubric: String = item
        .rubric
        .iter()
        .enumerate()
        .map(|(i, r)| format!("{}. {r}\n", i + 1))
        .collect();
    format!(
        "【题目】{}\n【评分要点】\n{rubric}【原文依据】{}\n【读者的回答】{}\n\n\
         先逐条判断每个要点答到了没有（意思对就算，不要求原话），再给总评 grade：\n\
         - recalled：要点基本都答到了；\n\
         - partial：只答到一部分，或者说得含糊；\n\
         - lapsed：没答到要点、答错了，或者说不知道。\n\
         拿不准时往低了判。\n\
         输出：{{\"missing\":[没答到的要点序号],\"grade\":\"recalled|partial|lapsed\",\"feedback\":\"一两句话，直接对读者说哪里对、缺了什么；不要复述题目\"}}",
        item.question, item.evidence, answer
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grade {
    Recalled,
    Partial,
    Lapsed,
}

impl Grade {
    pub fn as_str(self) -> &'static str {
        match self {
            Grade::Recalled => "recalled",
            Grade::Partial => "partial",
            Grade::Lapsed => "lapsed",
        }
    }
    fn rating(self) -> Rating {
        match self {
            Grade::Recalled => Rating::Good,
            Grade::Partial => Rating::Hard,
            Grade::Lapsed => Rating::Again,
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct Verdict {
    pub grade: Grade,
    /// 没答到的评分要点（原话）
    pub missing: Vec<String>,
    pub feedback: String,
}

pub fn parse_verdict(reply: &str, item: &Item) -> Result<Verdict> {
    let v = llm::json_object(reply)?;
    let missing: Vec<String> = v["missing"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|n| n.as_i64().or_else(|| n.as_str()?.trim().parse().ok()))
                .filter_map(|n| item.rubric.get((n - 1).max(0) as usize).cloned())
                .collect()
        })
        .unwrap_or_default();
    let grade = match v["grade"].as_str().unwrap_or("").trim() {
        "recalled" => Grade::Recalled,
        "partial" => Grade::Partial,
        "lapsed" => Grade::Lapsed,
        other => anyhow::bail!("批改结果看不懂：{other}"),
    };
    // 说是全对、又列了一半以上的要点没答到：自相矛盾，按低的算
    let grade = if grade == Grade::Recalled && missing.len() * 2 > item.rubric.len() {
        Grade::Partial
    } else {
        grade
    };
    Ok(Verdict {
        grade,
        missing,
        feedback: v["feedback"].as_str().unwrap_or("").trim().to_string(),
    })
}

// ---------- 记忆状态 ----------

fn at(secs: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(secs, 0).unwrap_or_default()
}

fn scheduler() -> FSRS {
    // 不走「学习中」的分钟级小步：读书不是背单词，答完一题下次最早也是明天
    FSRS::new(Parameters {
        enable_short_term: false,
        ..Parameters::default()
    })
}

fn load_card(conn: &Connection, book_id: &str, concept: &str) -> Result<Option<Card>> {
    Ok(conn
        .query_row(
            "SELECT stability, difficulty, state, reps, lapses, scheduled, last_review, due
             FROM concept_state WHERE book_id = ?1 AND concept = ?2",
            params![book_id, concept],
            |r| {
                Ok(Card {
                    stability: r.get(0)?,
                    difficulty: r.get(1)?,
                    state: match r.get::<_, i64>(2)? {
                        1 => State::Learning,
                        2 => State::Review,
                        3 => State::Relearning,
                        _ => State::New,
                    },
                    reps: r.get(3)?,
                    lapses: r.get(4)?,
                    scheduled_days: r.get(5)?,
                    last_review: at(r.get(6)?),
                    due: at(r.get(7)?),
                    elapsed_days: 0,
                })
            },
        )
        .optional()?)
}

/// 此刻还记得的概率。按小数天算（库里按整天算，刚答完和 23 小时后是一个数）
fn retrievability(stability: f64, last_review: i64, now: i64) -> f64 {
    if stability <= 0.0 {
        return 0.0;
    }
    let days = (now - last_review).max(0) as f64 / 86400.0;
    Parameters::forgetting_curve(days, stability)
}

/// 记一次作答：更新这个概念的记忆状态，返回下次复习的时间
pub fn apply(conn: &Connection, book_id: &str, concept: &str, grade: Grade, now: i64) -> Result<i64> {
    let card = load_card(conn, book_id, concept)?.unwrap_or_else(|| Card {
        due: at(now),
        last_review: at(now),
        ..Card::default()
    });
    let next = scheduler().next(card, at(now), grade.rating()).card;
    // 没答上来的当天就该再看一遍；其余至少隔一天
    let due = if grade == Grade::Lapsed {
        now + 10 * 60
    } else {
        next.due.timestamp().max(now + 86400)
    };
    conn.execute(
        "INSERT OR REPLACE INTO concept_state(book_id, concept, stability, difficulty, state, reps, lapses, scheduled, last_review, due, last_grade)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            book_id,
            concept,
            next.stability,
            next.difficulty,
            next.state as i64,
            next.reps,
            next.lapses,
            next.scheduled_days,
            now,
            due,
            grade.as_str()
        ],
    )?;
    Ok(due)
}

pub fn log_review(conn: &Connection, item: &Item, answer: &str, v: &Verdict, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO quiz_reviews(item_id, book_id, concept, answer, grade, missing, feedback, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![item.id, item.book_id, item.concept, answer, v.grade.as_str(), serde_json::to_string(&v.missing)?, v.feedback, now],
    )?;
    Ok(())
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConceptState {
    pub concept: String,
    /// 此刻还记得的概率，0–1
    pub mastery: f64,
    pub due: i64,
    pub reps: i64,
    pub lapses: i64,
    pub last_grade: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub book_id: String,
    /// 考过的概念
    pub concepts: Vec<ConceptState>,
    /// 这本书一共有多少个概念（透视整理出来的，加上考过但透视里没有的）
    pub total: i64,
    /// 学会了多少：所有概念掌握度的平均，没考过的算 0
    pub learned: f64,
    /// 现在该复习的概念数
    pub due: i64,
}

/// 透视里这本书所有的人物与概念名
fn concept_names(conn: &Connection, book_id: &str) -> Result<BTreeSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT u.entities FROM xray_units u JOIN docs d ON d.id = u.doc_id WHERE d.book_id = ?1",
    )?;
    let mut names = BTreeSet::new();
    for raw in stmt.query_map(params![book_id], |r| r.get::<_, String>(0))? {
        let list: Vec<crate::xray::Entity> = serde_json::from_str(&raw?).unwrap_or_default();
        names.extend(list.into_iter().map(|e| e.name));
    }
    Ok(names)
}

pub fn overview(conn: &Connection, book_id: &str, now: i64) -> Result<Overview> {
    let mut stmt = conn.prepare(
        "SELECT concept, stability, last_review, due, reps, lapses, last_grade
         FROM concept_state WHERE book_id = ?1 ORDER BY due",
    )?;
    let concepts: Vec<ConceptState> = stmt
        .query_map(params![book_id], |r| {
            Ok(ConceptState {
                concept: r.get(0)?,
                mastery: retrievability(r.get(1)?, r.get(2)?, now),
                due: r.get(3)?,
                reps: r.get(4)?,
                lapses: r.get(5)?,
                last_grade: r.get(6)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut names = concept_names(conn, book_id)?;
    names.extend(concepts.iter().map(|c| c.concept.clone()));
    let total = names.len() as i64;
    // 最后一次没答上来的不算记得（FSRS 给的稳定度再高，也是「刚忘过」）
    let sum: f64 = concepts
        .iter()
        .map(|c| if c.last_grade == "lapsed" { 0.0 } else { c.mastery })
        .sum();
    Ok(Overview {
        book_id: book_id.to_string(),
        due: concepts.iter().filter(|c| c.due <= now).count() as i64,
        learned: if total > 0 { sum / total as f64 } else { 0.0 },
        total,
        concepts,
    })
}

/// 书架上每本书的学习概况（只列考过题的书）
pub fn overviews(conn: &Connection, now: i64) -> Result<Vec<Overview>> {
    let mut stmt = conn.prepare("SELECT DISTINCT book_id FROM concept_state")?;
    let ids: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    ids.iter().map(|id| overview(conn, id, now)).collect()
}

/// 现在该复习的题：每个到期的概念挑一道（最近出的那道）。book_id 为空是所有书
pub fn due_items(conn: &Connection, book_id: Option<&str>, now: i64, limit: i64) -> Result<Vec<Item>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ITEM_COLUMNS} FROM quiz_items q
         WHERE id = (SELECT MAX(id) FROM quiz_items WHERE book_id = q.book_id AND concept = q.concept)
           AND EXISTS (SELECT 1 FROM concept_state s WHERE s.book_id = q.book_id AND s.concept = q.concept AND s.due <= ?1)
           AND (?2 IS NULL OR q.book_id = ?2)
         ORDER BY (SELECT due FROM concept_state s WHERE s.book_id = q.book_id AND s.concept = q.concept)
         LIMIT ?3"
    ))?;
    let rows = stmt.query_map(params![now, book_id, limit], item_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// 每个概念最近一次作答的结果，给「上次哪里没答到」用
pub fn last_missing(conn: &Connection, book_id: &str) -> Result<HashMap<String, Vec<String>>> {
    let mut stmt = conn.prepare(
        "SELECT concept, missing FROM quiz_reviews r WHERE book_id = ?1
         AND id = (SELECT MAX(id) FROM quiz_reviews WHERE book_id = r.book_id AND concept = r.concept)",
    )?;
    let mut out = HashMap::new();
    for row in stmt.query_map(params![book_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (concept, missing) = row?;
        out.insert(concept, serde_json::from_str(&missing).unwrap_or_default());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE books(id TEXT PRIMARY KEY);
             CREATE TABLE docs(id TEXT PRIMARY KEY, book_id TEXT);
             CREATE TABLE xray_units(doc_id TEXT, entities TEXT);
             INSERT INTO books VALUES ('b');
             INSERT INTO docs VALUES ('d', 'b');",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    const TEXT: &str = "通知没有 id 字段，\n服务端收到后不会回任何东西。请求带 id，响应用同一个 id 对上。";

    #[test]
    fn 依据对不上原文的题丢掉_换行空格不算() {
        let reply = r#"{"items":[
            {"concept":"通知","question":"为什么通知收不到响应？","rubric":["没有 id","服务端不回"],"evidence":"通知没有 id 字段，服务端收到后不会回任何东西"},
            {"concept":"批量","question":"批量请求怎么发？","rubric":["数组"],"evidence":"把多个请求放进一个数组里发出去"}
        ]}"#;
        let items = parse_items(reply, TEXT).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].concept, "通知");
        assert!(parse_items(r#"{"items":[]}"#, TEXT).is_err());
    }

    fn sample(conn: &Connection) -> Item {
        let new = NewItem {
            concept: "通知".into(),
            question: "为什么通知收不到响应？".into(),
            rubric: vec!["没有 id".into(), "服务端不回".into()],
            evidence: "通知没有 id 字段".into(),
        };
        save_items(conn, "b", "d", 0, &[new], 100).unwrap();
        items_for_unit(conn, "d", 0).unwrap().remove(0)
    }

    #[test]
    fn 批改_序号换回要点_自相矛盾按低的算() {
        let conn = db();
        let item = sample(&conn);
        let v = parse_verdict(r#"{"missing":[2],"grade":"partial","feedback":"只说了一半"}"#, &item).unwrap();
        assert_eq!(v.grade, Grade::Partial);
        assert_eq!(v.missing, vec!["服务端不回".to_string()]);
        let v = parse_verdict(r#"{"missing":[1,2],"grade":"recalled","feedback":""}"#, &item).unwrap();
        assert_eq!(v.grade, Grade::Partial);
        assert!(parse_verdict(r#"{"grade":"很好"}"#, &item).is_err());
    }

    #[test]
    fn 答对了隔得越来越久_掌握度随时间掉_答错当天再来() {
        let conn = db();
        let item = sample(&conn);
        conn.execute("INSERT INTO xray_units VALUES ('d', ?1)", [r#"[{"name":"通知"},{"name":"请求"}]"#]).unwrap();
        let day = 86400;
        let t0 = 1_000_000;

        let due1 = apply(&conn, "b", "通知", Grade::Recalled, t0).unwrap();
        assert!(due1 >= t0 + day);
        let o = overview(&conn, "b", t0).unwrap();
        // 两个概念考了一个：刚答对，学会了差不多一半
        assert_eq!((o.total, o.due), (2, 0));
        assert!(o.learned > 0.45 && o.learned <= 0.5, "{}", o.learned);
        assert!(due_items(&conn, None, t0, 10).unwrap().is_empty());

        // 到期了：出现在复习队列里，掌握度掉了
        let later = overview(&conn, "b", due1 + day).unwrap();
        assert_eq!(later.due, 1);
        assert!(later.learned < o.learned);
        assert_eq!(due_items(&conn, Some("b"), due1 + day, 10).unwrap(), vec![item.clone()]);


        // 这道题答过了；同一个概念再加一道没答过的，轮换时先挑它
        log_review(&conn, &item, "没有 id", &Verdict { grade: Grade::Recalled, missing: vec![], feedback: String::new() }, t0).unwrap();
        assert!(answered(&conn, item.id).unwrap());
        let other = NewItem { concept: "通知".into(), question: "举个通知的例子".into(), rubric: vec!["不要响应".into()], evidence: "服务端收到后不会回任何东西".into() };
        save_items(&conn, "b", "d", 0, &[other], 200).unwrap();
        assert_eq!(stalest(&conn, "b", "通知").unwrap().unwrap().question, "举个通知的例子");
        assert_eq!(items_for_concept(&conn, "b", "通知").unwrap().len(), 2);

        // 再答对一次，间隔比第一次长
        let due2 = apply(&conn, "b", "通知", Grade::Recalled, due1).unwrap();
        assert!(due2 - due1 > due1 - t0, "{} vs {}", due2 - due1, due1 - t0);

        // 没答上来：不算记得，当天就该再看
        let due3 = apply(&conn, "b", "通知", Grade::Lapsed, due2).unwrap();
        assert!(due3 < due2 + day);
        assert_eq!(overview(&conn, "b", due2).unwrap().learned, 0.0);
    }
}
