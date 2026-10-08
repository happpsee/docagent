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
        );
        -- 关于读者本人：背景、偏好、强项、弱项、易错点。易错点可以是批改时自动记下的（auto = 1，带着是哪本书的哪个概念）
        CREATE TABLE IF NOT EXISTS learner_notes (
            id         INTEGER PRIMARY KEY,
            kind       TEXT NOT NULL,
            content    TEXT NOT NULL,
            evidence   TEXT NOT NULL DEFAULT '',
            book_id    TEXT,
            concept    TEXT,
            auto       INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        -- 模型看过、觉得没什么可考的划线：记下来，别每次合上书都再问一遍
        CREATE TABLE IF NOT EXISTS quiz_skipped_marks (annotation_id TEXT PRIMARY KEY);",
    )?;
    // 后来加的列：老库补上（已经有了会报重复，忽略）
    let _ = conn.execute(
        "ALTER TABLE concept_state ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute("ALTER TABLE quiz_items ADD COLUMN annotation_id TEXT", []);
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
pub fn variant_prompt(
    text: &str,
    concept: &str,
    asked: &[String],
    misconception: Option<&str>,
) -> String {
    let mut asked: String = asked.iter().map(|q| format!("- {q}\n")).collect();
    if let Some(m) = misconception {
        asked.push_str(&format!(
            "读者之前在这上面有个误解：{m}\n这道题要能检验出他纠正过来了没有，但不要把误解直接写在题目里提示他。\n"
        ));
    }
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
                        .map(|r| {
                            r.iter()
                                .map(str_of)
                                .filter(|s| !s.is_empty())
                                .take(4)
                                .collect()
                        })
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
         如果回答暴露出一个具体的误解（把甲当成了乙、因果说反了、范围搞错了），用一句话写进 misconception，以「你」开头；只是没答全、没有误解就留空字符串。\n\
         输出：{{\"missing\":[没答到的要点序号],\"grade\":\"recalled|partial|lapsed\",\"feedback\":\"一两句话，直接对读者说哪里对、缺了什么；不要复述题目\",\"misconception\":\"\"}}",
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
    /// 回答里暴露出的具体误解（一句话）；没有是空串
    pub misconception: String,
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
        misconception: if grade == Grade::Recalled {
            String::new()
        } else {
            v["misconception"]
                .as_str()
                .unwrap_or("")
                .trim()
                .chars()
                .take(120)
                .collect()
        },
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
pub fn apply(
    conn: &Connection,
    book_id: &str,
    concept: &str,
    grade: Grade,
    now: i64,
) -> Result<i64> {
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

pub fn log_review(
    conn: &Connection,
    item: &Item,
    answer: &str,
    v: &Verdict,
    now: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO quiz_reviews(item_id, book_id, concept, answer, grade, missing, feedback, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            item.id,
            item.book_id,
            item.concept,
            answer,
            v.grade.as_str(),
            serde_json::to_string(&v.missing)?,
            v.feedback,
            now
        ],
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
    /// 用户说这个不用管：不提醒复习，也不算进「学会了多少」
    pub ignored: bool,
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
        "SELECT concept, stability, last_review, due, reps, lapses, last_grade, ignored
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
                ignored: r.get(7)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut names = concept_names(conn, book_id)?;
    names.extend(concepts.iter().map(|c| c.concept.clone()));
    for c in concepts.iter().filter(|c| c.ignored) {
        names.remove(&c.concept);
    }
    let total = names.len() as i64;
    // 最后一次没答上来的不算记得（FSRS 给的稳定度再高，也是「刚忘过」）
    let sum: f64 = concepts
        .iter()
        .filter(|c| !c.ignored)
        .map(|c| {
            if c.last_grade == "lapsed" {
                0.0
            } else {
                c.mastery
            }
        })
        .sum();
    Ok(Overview {
        book_id: book_id.to_string(),
        due: concepts
            .iter()
            .filter(|c| !c.ignored && c.due <= now)
            .count() as i64,
        learned: if total > 0 { sum / total as f64 } else { 0.0 },
        total,
        concepts,
    })
}

/// 书架上每本书的学习概况（只列考过题的书）
pub fn overviews(conn: &Connection, now: i64) -> Result<Vec<Overview>> {
    let mut stmt = conn.prepare("SELECT DISTINCT book_id FROM concept_state")?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    ids.iter().map(|id| overview(conn, id, now)).collect()
}

/// 现在该复习的题：每个到期的概念挑一道（最近出的那道）。book_id 为空是所有书
pub fn due_items(
    conn: &Connection,
    book_id: Option<&str>,
    now: i64,
    limit: i64,
) -> Result<Vec<Item>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ITEM_COLUMNS} FROM quiz_items q
         WHERE id = (SELECT MAX(id) FROM quiz_items WHERE book_id = q.book_id AND concept = q.concept)
           AND EXISTS (SELECT 1 FROM concept_state s WHERE s.book_id = q.book_id AND s.concept = q.concept AND s.due <= ?1 AND s.ignored = 0)
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
    for row in stmt.query_map(params![book_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (concept, missing) = row?;
        out.insert(concept, serde_json::from_str(&missing).unwrap_or_default());
    }
    Ok(out)
}

// ---------- 忽略、每段的掌握情况 ----------

/// 忽略 / 恢复一个概念。没考过的概念也能忽略（先占一行）
pub fn set_ignored(
    conn: &Connection,
    book_id: &str,
    concept: &str,
    on: bool,
    now: i64,
) -> Result<()> {
    seed(conn, book_id, concept, now)?;
    conn.execute(
        "UPDATE concept_state SET ignored = ?3 WHERE book_id = ?1 AND concept = ?2",
        params![book_id, concept, on],
    )?;
    Ok(())
}

/// 给一个还没考过的概念占一行：现在就该考（划线变成的题靠它进复习队列）
pub fn seed(conn: &Connection, book_id: &str, concept: &str, now: i64) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO concept_state(book_id, concept, stability, difficulty, state, reps, lapses, scheduled, last_review, due, last_grade)
         VALUES (?1, ?2, 0, 0, 0, 0, 0, 0, ?3, ?3, '')",
        params![book_id, concept, now],
    )?;
    Ok(())
}

/// 一篇里每一段掌握得怎么样：这一段考的那些概念的掌握度平均（没答对过的算 0，忽略的不算）。没出过题的段不在里面
pub fn unit_mastery(conn: &Connection, doc_id: &str, now: i64) -> Result<HashMap<i64, f64>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT q.unit, q.concept, s.stability, s.last_review, s.last_grade, s.reps
         FROM quiz_items q LEFT JOIN concept_state s ON s.book_id = q.book_id AND s.concept = q.concept
         WHERE q.doc_id = ?1 AND q.unit >= 0 AND COALESCE(s.ignored, 0) = 0",
    )?;
    let mut sums: HashMap<i64, (f64, f64)> = HashMap::new();
    let rows = stmt.query_map(params![doc_id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, Option<f64>>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<i64>>(5)?,
        ))
    })?;
    for row in rows {
        let (unit, stability, last, grade, reps) = row?;
        let m = match (stability, last, grade.as_deref(), reps) {
            (Some(s), Some(l), Some(g), Some(n)) if n > 0 && g != "lapsed" => {
                retrievability(s, l, now)
            }
            _ => 0.0,
        };
        let e = sums.entry(unit).or_insert((0.0, 0.0));
        e.0 += m;
        e.1 += 1.0;
    }
    Ok(sums.into_iter().map(|(u, (sum, n))| (u, sum / n)).collect())
}

// ---------- 关于读者本人 ----------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LearnerNote {
    pub id: i64,
    /// background / preference / strength / weakness / misconception
    pub kind: String,
    pub content: String,
    /// 自动记下的：依据是哪道题、怎么答的
    pub evidence: String,
    pub book_id: Option<String>,
    pub concept: Option<String>,
    pub auto: bool,
    pub updated_at: i64,
}

pub fn notes(conn: &Connection) -> Result<Vec<LearnerNote>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, content, evidence, book_id, concept, auto, updated_at FROM learner_notes ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(LearnerNote {
            id: r.get(0)?,
            kind: r.get(1)?,
            content: r.get(2)?,
            evidence: r.get(3)?,
            book_id: r.get(4)?,
            concept: r.get(5)?,
            auto: r.get(6)?,
            updated_at: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// 用户自己写一条，或者改一条（改过的就算他自己的了，之后批改不会再覆盖它）
pub fn save_note(
    conn: &Connection,
    id: Option<i64>,
    kind: &str,
    content: &str,
    now: i64,
) -> Result<()> {
    match id {
        Some(id) => conn.execute(
            "UPDATE learner_notes SET kind = ?2, content = ?3, auto = 0, updated_at = ?4 WHERE id = ?1",
            params![id, kind, content, now],
        )?,
        None => conn.execute(
            "INSERT INTO learner_notes(kind, content, auto, updated_at) VALUES (?1, ?2, 0, ?3)",
            params![kind, content, now],
        )?,
    };
    Ok(())
}

pub fn delete_note(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM learner_notes WHERE id = ?1", params![id])?;
    Ok(())
}

/// 助手在对话里记下 / 改写的一条（auto = 1：是它观察到的，不是用户自己写的）。
/// 一模一样的话不重复记；改用户自己写过的那条时，仍然算用户的
pub fn agent_note(
    conn: &Connection,
    id: Option<i64>,
    kind: &str,
    content: &str,
    evidence: &str,
    now: i64,
) -> Result<i64> {
    if let Some(id) = id {
        let n = conn.execute(
            "UPDATE learner_notes SET kind = ?2, content = ?3, evidence = CASE WHEN ?4 = '' THEN evidence ELSE ?4 END, updated_at = ?5 WHERE id = ?1",
            params![id, kind, content, evidence, now],
        )?;
        if n == 0 {
            anyhow::bail!("没有编号为 {id} 的这一条");
        }
        return Ok(id);
    }
    if let Some(had) = conn
        .query_row(
            "SELECT id FROM learner_notes WHERE content = ?1",
            params![content],
            |r| r.get(0),
        )
        .optional()?
    {
        return Ok(had);
    }
    conn.execute(
        "INSERT INTO learner_notes(kind, content, evidence, auto, updated_at) VALUES (?1, ?2, ?3, 1, ?4)",
        params![kind, content, evidence, now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub const NOTE_KINDS: [&str; 5] = [
    "background",
    "preference",
    "strength",
    "weakness",
    "misconception",
];

/// 这个概念上记着的误解（自动记的或者用户改过的）
pub fn misconception(conn: &Connection, book_id: &str, concept: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT content FROM learner_notes WHERE kind = 'misconception' AND book_id = ?1 AND concept = ?2
             ORDER BY updated_at DESC LIMIT 1",
            params![book_id, concept],
            |r| r.get(0),
        )
        .optional()?)
}

/// 批改完一题：暴露出误解就记下（同一个概念只留最新的一条自动记录）；这回答对了，之前自动记的那条就算纠正了
pub fn note_verdict(
    conn: &Connection,
    item: &Item,
    answer: &str,
    v: &Verdict,
    now: i64,
) -> Result<()> {
    if v.grade == Grade::Recalled || !v.misconception.is_empty() {
        conn.execute(
            "DELETE FROM learner_notes WHERE auto = 1 AND kind = 'misconception' AND book_id = ?1 AND concept = ?2",
            params![item.book_id, item.concept],
        )?;
    }
    if !v.misconception.is_empty() {
        let answer: String = answer.chars().take(80).collect();
        conn.execute(
            "INSERT INTO learner_notes(kind, content, evidence, book_id, concept, auto, updated_at)
             VALUES ('misconception', ?1, ?2, ?3, ?4, 1, ?5)",
            params![
                v.misconception,
                format!("问「{}」时答：{answer}", item.question),
                item.book_id,
                item.concept,
                now
            ],
        )?;
    }
    Ok(())
}

// ---------- 划线变成题、合上书的小结 ----------

/// 一条还没变成题的划线
#[derive(Debug, PartialEq)]
pub struct Mark {
    pub id: String,
    pub doc_id: String,
    pub text: String,
    pub note: String,
}

/// 这本书里够长、还没出过题的划线（最早的在前）
pub fn pending_marks(conn: &Connection, book_id: &str, limit: i64) -> Result<Vec<Mark>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.doc_id, a.text, a.note FROM annotations a JOIN docs d ON d.id = a.doc_id
         WHERE d.book_id = ?1 AND a.kind = 'highlight' AND length(a.text) >= 12
           AND NOT EXISTS (SELECT 1 FROM quiz_items q WHERE q.annotation_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM quiz_skipped_marks k WHERE k.annotation_id = a.id)
         ORDER BY a.created_at LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![book_id, limit], |r| {
        Ok(Mark {
            id: r.get(0)?,
            doc_id: r.get(1)?,
            text: r.get(2)?,
            note: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn marks_prompt(marks: &[Mark], concepts: &[String]) -> String {
    let list: String = marks
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let note = if m.note.trim().is_empty() {
                String::new()
            } else {
                format!("（读者写的想法：{}）", m.note.trim())
            };
            format!("{}. {}{note}\n", i + 1, m.text.trim())
        })
        .collect();
    let known = if concepts.is_empty() {
        String::new()
    } else {
        format!("concept 优先用这些已有的名字：{}。", concepts.join("、"))
    };
    format!(
        "下面是读者读书时自己划下的句子——他觉得这些重要。给每一句出 1 道简答题，过一阵拿来考他还记不记得、懂不懂。\n\
         要求：\n\
         - 只凭那一句的内容就能答出来；问它说明了什么、为什么、意味着什么，不要让他默写原句；\n\
         - 划的句子本身没什么可考的（只是一句感慨、一个标题）就跳过，不要硬出；\n\
         - concept：这道题考的概念，12 个字以内。{known}\n\
         - rubric：1 到 3 条评分要点。\n\
         输出：{{\"items\":[{{\"n\":句子序号,\"concept\":\"…\",\"question\":\"…\",\"rubric\":[\"…\"]}}]}}\n\n\
         【划线】\n{list}"
    )
}

/// 模型给划线出的题存下来：依据就是划的那一句，概念进复习队列。返回存了几道
pub fn save_mark_items(
    conn: &Connection,
    book_id: &str,
    marks: &[Mark],
    reply: &str,
    now: i64,
) -> Result<usize> {
    let v = llm::json_object(reply)?;
    let mut saved = 0;
    for i in v["items"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let Some(mark) = i["n"]
            .as_i64()
            .and_then(|n| marks.get((n - 1).max(0) as usize))
        else {
            continue;
        };
        let concept = i["concept"].as_str().unwrap_or("").trim();
        let question = i["question"].as_str().unwrap_or("").trim();
        let rubric: Vec<&str> = i["rubric"]
            .as_array()
            .map(|r| r.iter().filter_map(|x| x.as_str()).take(3).collect())
            .unwrap_or_default();
        if concept.is_empty() || question.is_empty() || rubric.is_empty() {
            continue;
        }
        let evidence: String = mark.text.trim().chars().take(300).collect();
        let fresh = conn.execute(
            "INSERT INTO quiz_items(book_id, doc_id, unit, concept, question, rubric, evidence, created_at, annotation_id)
             SELECT ?1, ?2, -1, ?3, ?4, ?5, ?6, ?7, ?8
             WHERE NOT EXISTS (SELECT 1 FROM quiz_items WHERE annotation_id = ?8)",
            params![book_id, mark.doc_id, concept, question, serde_json::to_string(&rubric)?, evidence, now, mark.id],
        )?;
        if fresh > 0 {
            seed(conn, book_id, concept, now)?;
            saved += 1;
        }
    }
    for m in marks {
        conn.execute(
            "INSERT OR IGNORE INTO quiz_skipped_marks(annotation_id)
             SELECT ?1 WHERE NOT EXISTS (SELECT 1 FROM quiz_items WHERE annotation_id = ?1)",
            params![m.id],
        )?;
    }
    Ok(saved)
}

/// 这一程读下来：划了几句、答了几题、还有几句划线没变成题
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trip {
    pub highlights: i64,
    pub recalled: i64,
    pub partial: i64,
    pub lapsed: i64,
    pub pending_marks: i64,
}

pub fn trip(conn: &Connection, book_id: &str, since: i64) -> Result<Trip> {
    let count = |grade: &str| -> Result<i64> {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM quiz_reviews WHERE book_id = ?1 AND at >= ?2 AND grade = ?3",
            params![book_id, since, grade],
            |r| r.get(0),
        )?)
    };
    Ok(Trip {
        highlights: conn.query_row(
            "SELECT COUNT(*) FROM annotations a JOIN docs d ON d.id = a.doc_id
             WHERE d.book_id = ?1 AND a.kind = 'highlight' AND a.created_at >= ?2",
            params![book_id, since],
            |r| r.get(0),
        )?,
        recalled: count("recalled")?,
        partial: count("partial")?,
        lapsed: count("lapsed")?,
        pending_marks: pending_marks(conn, book_id, 50)?.len() as i64,
    })
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
             CREATE TABLE annotations(id TEXT PRIMARY KEY, doc_id TEXT, kind TEXT, text TEXT, note TEXT, created_at INTEGER);
             INSERT INTO books VALUES ('b');
             INSERT INTO docs VALUES ('d', 'b');",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    const TEXT: &str =
        "通知没有 id 字段，\n服务端收到后不会回任何东西。请求带 id，响应用同一个 id 对上。";

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
        let v = parse_verdict(
            r#"{"missing":[2],"grade":"partial","feedback":"只说了一半"}"#,
            &item,
        )
        .unwrap();
        assert_eq!(v.grade, Grade::Partial);
        assert_eq!(v.missing, vec!["服务端不回".to_string()]);
        let v = parse_verdict(r#"{"missing":[1,2],"grade":"recalled","feedback":"","misconception":"你把通知当成了请求"}"#, &item).unwrap();
        assert_eq!(v.grade, Grade::Partial);
        assert!(parse_verdict(r#"{"grade":"很好"}"#, &item).is_err());
    }

    #[test]
    fn 答对了隔得越来越久_掌握度随时间掉_答错当天再来() {
        let conn = db();
        let item = sample(&conn);
        conn.execute(
            "INSERT INTO xray_units VALUES ('d', ?1)",
            [r#"[{"name":"通知"},{"name":"请求"}]"#],
        )
        .unwrap();
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
        assert_eq!(
            due_items(&conn, Some("b"), due1 + day, 10).unwrap(),
            vec![item.clone()]
        );

        // 这道题答过了；同一个概念再加一道没答过的，轮换时先挑它
        log_review(
            &conn,
            &item,
            "没有 id",
            &Verdict {
                grade: Grade::Recalled,
                missing: vec![],
                feedback: String::new(),
                misconception: String::new(),
            },
            t0,
        )
        .unwrap();
        assert!(answered(&conn, item.id).unwrap());
        let other = NewItem {
            concept: "通知".into(),
            question: "举个通知的例子".into(),
            rubric: vec!["不要响应".into()],
            evidence: "服务端收到后不会回任何东西".into(),
        };
        save_items(&conn, "b", "d", 0, &[other], 200).unwrap();
        assert_eq!(
            stalest(&conn, "b", "通知").unwrap().unwrap().question,
            "举个通知的例子"
        );
        assert_eq!(items_for_concept(&conn, "b", "通知").unwrap().len(), 2);

        // 再答对一次，间隔比第一次长
        let due2 = apply(&conn, "b", "通知", Grade::Recalled, due1).unwrap();
        assert!(due2 - due1 > due1 - t0, "{} vs {}", due2 - due1, due1 - t0);

        // 没答上来：不算记得，当天就该再看
        let due3 = apply(&conn, "b", "通知", Grade::Lapsed, due2).unwrap();
        assert!(due3 < due2 + day);
        assert_eq!(overview(&conn, "b", due2).unwrap().learned, 0.0);
    }

    #[test]
    fn 误解记下来_答对了就划掉_用户改过的不动() {
        let conn = db();
        let item = sample(&conn);
        let wrong = Verdict {
            grade: Grade::Partial,
            missing: vec![],
            feedback: String::new(),
            misconception: "你把通知当成了不需要 id 的请求".into(),
        };
        note_verdict(&conn, &item, "通知就是请求", &wrong, 1).unwrap();
        note_verdict(&conn, &item, "还是请求", &wrong, 2).unwrap();
        assert_eq!(notes(&conn).unwrap().len(), 1);
        assert_eq!(
            misconception(&conn, "b", "通知").unwrap().as_deref(),
            Some("你把通知当成了不需要 id 的请求")
        );
        let right = Verdict {
            grade: Grade::Recalled,
            missing: vec![],
            feedback: String::new(),
            misconception: String::new(),
        };
        note_verdict(&conn, &item, "对了", &right, 3).unwrap();
        assert!(notes(&conn).unwrap().is_empty());

        // 用户自己改过的一条：之后答对也不删
        note_verdict(&conn, &item, "又错", &wrong, 4).unwrap();
        let id = notes(&conn).unwrap()[0].id;
        save_note(&conn, Some(id), "misconception", "我老把通知和请求弄混", 5).unwrap();
        // 助手在对话里记的：同一句话不重复记，可以按编号改写
        let a = agent_note(&conn, None, "background", "做前端三年", "用户说的", 7).unwrap();
        assert_eq!(
            agent_note(&conn, None, "background", "做前端三年", "", 8).unwrap(),
            a
        );
        agent_note(&conn, Some(a), "background", "做前端三年，在学 Rust", "", 9).unwrap();
        assert!(agent_note(&conn, Some(9999), "background", "x", "", 9).is_err());
        assert_eq!(
            notes(&conn)
                .unwrap()
                .iter()
                .filter(|n| n.kind == "background")
                .count(),
            1
        );
        delete_note(&conn, a).unwrap();
        note_verdict(&conn, &item, "对了", &right, 6).unwrap();
        assert_eq!(notes(&conn).unwrap()[0].content, "我老把通知和请求弄混");
    }

    #[test]
    fn 划线变成题_进复习队列_忽略的不提醒也不算分() {
        let conn = db();
        conn.execute("INSERT INTO annotations VALUES ('a1', 'd', 'highlight', '通知没有 id 字段，服务端收到后不会回任何东西。', '', 10)", []).unwrap();
        conn.execute(
            "INSERT INTO annotations VALUES ('a2', 'd', 'highlight', '太短', '', 11)",
            [],
        )
        .unwrap();
        let marks = pending_marks(&conn, "b", 10).unwrap();
        assert_eq!(marks.len(), 1);
        let reply = r#"{"items":[{"n":1,"concept":"通知","question":"通知为什么收不到响应？","rubric":["没有 id"]},{"n":9,"concept":"x","question":"y","rubric":["z"]}]}"#;
        assert_eq!(save_mark_items(&conn, "b", &marks, reply, 100).unwrap(), 1);
        assert!(pending_marks(&conn, "b", 10).unwrap().is_empty());
        assert_eq!(due_items(&conn, Some("b"), 100, 10).unwrap().len(), 1);
        assert_eq!(
            trip(&conn, "b", 0).unwrap(),
            Trip {
                highlights: 2,
                recalled: 0,
                partial: 0,
                lapsed: 0,
                pending_marks: 0
            }
        );
        // 划线出的题不属于哪一段
        assert!(unit_mastery(&conn, "d", 100).unwrap().is_empty());

        set_ignored(&conn, "b", "通知", true, 100).unwrap();
        let o = overview(&conn, "b", 100).unwrap();
        assert_eq!((o.due, o.total), (0, 0));
        assert!(due_items(&conn, Some("b"), 100, 10).unwrap().is_empty());
        set_ignored(&conn, "b", "通知", false, 100).unwrap();
        assert_eq!(overview(&conn, "b", 100).unwrap().due, 1);
    }

    #[test]
    fn 每段的掌握度_按这一段考的概念算() {
        let conn = db();
        sample(&conn);
        assert_eq!(unit_mastery(&conn, "d", 100).unwrap().get(&0), Some(&0.0));
        apply(&conn, "b", "通知", Grade::Recalled, 100).unwrap();
        assert!(unit_mastery(&conn, "d", 100).unwrap()[&0] > 0.95);
    }
}
