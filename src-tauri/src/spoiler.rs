//! 防剧透：一本书里用户还没读到的地方，检索和读原文都不拿出来。
//!
//! 开没开是按书定的（books.spoiler_free；没设过按格式给默认值，见 books.rs）。
//! 「读到哪了」按篇记（reading_state 的 furthest / furthest_page，只增不减）。正开着的那一篇
//! 可能刚往后翻了几页还没存，所以调用方把阅读器此刻的位置（Live）一起送来，两边取大的。
//!
//! 规则只有这一份：/search 和 /section 都从这里拿每一篇的界线。界面上的透视面板
//! 拿 list_books 给的同样几个字段（opened、furthest、position）照着同一条规则算。

use crate::books;
use anyhow::Result;
use rusqlite::types::Value;
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

/// 阅读器此刻开着哪一篇、翻到了哪
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Live {
    pub doc_id: String,
    /// 第几页 / 第几节（PDF、EPUB 才有）
    pub page: Option<i64>,
    /// 读到这一篇的几分之几
    pub fraction: f64,
}

/// 一篇能看到哪儿
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Bound {
    /// 整篇都能看
    Open,
    /// 一点都不能看：排在读到的那一篇后面、还没打开过
    Blocked,
    /// 看到读过的地方为止。片段带页码、这里也知道读到第几页时按页比；
    /// 不然（没有页码的格式，或者老库升上来还没记过页码）按片段的先后比
    UpTo { page: Option<i64>, fraction: f64 },
}

impl Bound {
    /// 按先后比的时候，一篇 total 个片段里读到了第几个（从 0 数，含）
    pub fn last_idx(fraction: f64, total: i64) -> i64 {
        (fraction * total as f64).floor() as i64
    }

    /// 这个片段读没读到。total 是它那一篇一共多少个片段
    pub fn allows(&self, page: Option<i64>, idx: i64, total: i64) -> bool {
        match *self {
            Bound::Open => true,
            Bound::Blocked => false,
            Bound::UpTo {
                page: limit,
                fraction,
            } => match (page, limit) {
                (Some(p), Some(limit)) => p <= limit,
                _ => idx <= Bound::last_idx(fraction, total),
            },
        }
    }
}

/// 一篇的阅读记录里和界线有关的那几样
#[derive(Debug, Clone)]
pub struct PartState {
    pub doc_id: String,
    /// 打开过（有阅读记录）
    pub opened: bool,
    pub furthest: f64,
    pub furthest_page: Option<i64>,
}

fn clean(fraction: f64) -> f64 {
    if fraction.is_finite() {
        fraction.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// 一本书各篇（按书里的顺序给）的界线。
///
/// - 没开防剧透：都不设限。
/// - 开了但还没开始读（没有哪一篇打开过，也不是正开着的）：都不设限——用户没在读它，
///   拿它当资料查的时候不该什么都搜不到。
/// - 开始读了：以「打开过的最靠后的那一篇」为准。排在它前面的整篇算读过；
///   它自己看到读过的地方为止；排在它后面的还没打开过，不给看。
pub fn book_bounds(spoiler_free: bool, parts: &[PartState], live: Option<&Live>) -> Vec<Bound> {
    let is_live = |p: &PartState| live.is_some_and(|l| l.doc_id == p.doc_id);
    let last = parts
        .iter()
        .rposition(|p| p.opened || is_live(p))
        .filter(|_| spoiler_free);
    let Some(last) = last else {
        return vec![Bound::Open; parts.len()];
    };
    parts
        .iter()
        .enumerate()
        .map(|(i, p)| match i.cmp(&last) {
            std::cmp::Ordering::Less => Bound::Open,
            std::cmp::Ordering::Greater => Bound::Blocked,
            std::cmp::Ordering::Equal => {
                // 存下来的最远处和此刻的位置取大的：往回翻不会把读过的又藏起来，
                // 刚往后翻的几页不用等存盘
                let here = live.filter(|_| is_live(p));
                let (stored, now) = (clean(p.furthest), here.map(|l| clean(l.fraction)));
                let page = match (p.furthest_page, here.and_then(|l| l.page)) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (Some(a), None) => Some(a),
                    // 存下来的记录里没有页码（老库升上来的还没记过）、而此刻又翻回了前面：
                    // 此刻的页码代表不了「读到过的最远处」，不能拿它当界线，退回按比例比
                    (None, Some(b)) => (!p.opened || now.is_some_and(|f| f >= stored)).then_some(b),
                    (None, None) => None,
                };
                Bound::UpTo {
                    page,
                    fraction: stored.max(now.unwrap_or(0.0)),
                }
            }
        })
        .collect()
}

/// 每一篇的界线（文档 id → 界线）。live 是阅读器此刻的位置，没开着书就不给
pub fn bounds(conn: &Connection, live: Option<&Live>) -> Result<HashMap<String, Bound>> {
    load(conn, live, None)
}

/// 某一篇的界线。只算它所在的那本书；这一篇不在了当作不设限（反正也读不出东西）
pub fn bound_of(conn: &Connection, doc_id: &str, live: Option<&Live>) -> Result<Bound> {
    let Some(book_id) = books::book_of(conn, doc_id)? else {
        return Ok(Bound::Open);
    };
    Ok(load(conn, live, Some(&book_id))?
        .remove(doc_id)
        .unwrap_or(Bound::Open))
}

fn load(
    conn: &Connection,
    live: Option<&Live>,
    only_book: Option<&str>,
) -> Result<HashMap<String, Bound>> {
    struct Row {
        book_id: Option<String>,
        kind: String,
        spoiler: Option<bool>,
        state: PartState,
    }
    let sql = format!(
        "SELECT d.id, d.book_id, d.kind, b.spoiler_free,
                r.doc_id IS NOT NULL, COALESCE(r.furthest, 0), r.furthest_page
         FROM docs d
         LEFT JOIN books b ON b.id = d.book_id
         LEFT JOIN reading_state r ON r.doc_id = d.id
         {}
         ORDER BY d.book_id, d.position, d.created_at, d.rowid",
        if only_book.is_some() {
            "WHERE d.book_id = ?1"
        } else {
            ""
        }
    );
    let mut stmt = conn.prepare(&sql)?;
    let read = |r: &rusqlite::Row| {
        Ok(Row {
            book_id: r.get(1)?,
            kind: r.get(2)?,
            spoiler: r.get(3)?,
            state: PartState {
                doc_id: r.get(0)?,
                opened: r.get(4)?,
                furthest: r.get(5)?,
                furthest_page: r.get(6)?,
            },
        })
    };
    let rows: Vec<Row> = match only_book {
        Some(book) => stmt
            .query_map(params![book], read)?
            .collect::<Result<_, _>>()?,
        None => stmt.query_map([], read)?.collect::<Result<_, _>>()?,
    };
    let mut out = HashMap::with_capacity(rows.len());
    // 不属于任何一本书的篇（正常不会有，打开库时会补上）各算各的，不设限
    for group in rows.chunk_by(|a, b| a.book_id.is_some() && a.book_id == b.book_id) {
        let spoiler_free = group[0].book_id.is_some()
            && group[0]
                .spoiler
                .unwrap_or_else(|| books::spoiler_default(group.iter().map(|r| r.kind.as_str())));
        let parts: Vec<PartState> = group.iter().map(|r| r.state.clone()).collect();
        for (part, bound) in parts.iter().zip(book_bounds(spoiler_free, &parts, live)) {
            out.insert(part.doc_id.clone(), bound);
        }
    }
    Ok(out)
}

/// 一次检索能碰哪些片段：用户在界面上选的范围（哪几篇），加上各篇防剧透的界线。
///
/// 两样都交给查询在数据库里面筛，不是搜出来之后再筛——不然「只在这本书里找」的时候，
/// 别的书把名额占满，这本书里明明有的内容会一条都排不进来。
#[derive(Debug, Clone, Default)]
pub struct Access {
    /// 限定在这几篇里（JSON 数组）；None 是整个书架
    scope: Option<String>,
    /// 有界线的篇（JSON：[[篇 id, 读到第几页或 null, 读到第几个片段], …]）。
    /// 整篇被挡住的，片段序号写 -1。None 是哪一篇都不设限
    limits: Option<String>,
}

impl Access {
    /// 什么都不拦：整个书架，不管读没读到
    pub fn all() -> Access {
        Access::default()
    }

    /// 这次查询有没有哪一篇被防剧透的界线挡掉了一部分。调用方要把这件事告诉模型：
    /// 不然它搜不到后文，会当成「书里没写」
    pub fn bounded(&self) -> bool {
        self.limits.is_some()
    }

    /// doc_ids 是限定的范围（None 或空是整个书架），live 是阅读器此刻的位置
    pub fn of(
        conn: &Connection,
        doc_ids: Option<&[String]>,
        live: Option<&Live>,
    ) -> Result<Access> {
        let scope = doc_ids.filter(|ids| !ids.is_empty());
        let in_scope: Option<HashSet<&str>> =
            scope.map(|ids| ids.iter().map(String::as_str).collect());
        let mut bounded: Vec<(String, Bound)> = bounds(conn, live)?
            .into_iter()
            .filter(|(id, bound)| {
                *bound != Bound::Open && in_scope.as_ref().is_none_or(|s| s.contains(id.as_str()))
            })
            .collect();
        bounded.sort_by(|a, b| a.0.cmp(&b.0));
        let mut count = conn.prepare("SELECT COUNT(*) FROM chunks WHERE doc_id = ?1")?;
        let mut limits = Vec::with_capacity(bounded.len());
        for (id, bound) in bounded {
            if let Bound::UpTo { page, fraction } = bound {
                let total: i64 = count.query_row(params![id], |r| r.get(0))?;
                limits.push(serde_json::json!([
                    id,
                    page,
                    Bound::last_idx(fraction, total)
                ]));
            } else {
                limits.push(serde_json::json!([id, null, -1]));
            }
        }
        Ok(Access {
            scope: scope.map(serde_json::to_string).transpose()?,
            limits: (!limits.is_empty()).then(|| serde_json::Value::Array(limits).to_string()),
        })
    }

    /// 拼进查询的筛选条件：一段针对片段表（别名 c）的 SQL 和它的参数，参数从 ?first 开始编号。
    /// 什么都不拦时是 None，查询保持原样。
    ///
    /// 条件里的子查询都和外层的行无关，SQLite 只算一次、存成临时索引，
    /// 之后每个片段只是查一下在不在里面——篇数多也不会变慢。
    pub(crate) fn filter(&self, first: usize) -> Option<(String, Vec<Value>)> {
        let mut clauses = Vec::new();
        let mut args = Vec::new();
        if let Some(scope) = &self.scope {
            args.push(Value::Text(scope.clone()));
            clauses.push(format!(
                "c.doc_id IN (SELECT value FROM json_each(?{}))",
                first + args.len() - 1
            ));
        }
        if let Some(limits) = &self.limits {
            args.push(Value::Text(limits.clone()));
            let n = first + args.len() - 1;
            // 没有界线的篇整篇放行；有界线的篇，先把它读过的那些片段挑出来，只放行这些
            clauses.push(format!(
                "(c.doc_id NOT IN (SELECT j.value ->> 0 FROM json_each(?{n}) j)
                  OR c.id IN (
                     SELECT r.id FROM json_each(?{n}) j
                     CROSS JOIN chunks r ON r.doc_id = j.value ->> 0
                     WHERE CASE WHEN r.page IS NOT NULL AND j.value ->> 1 IS NOT NULL
                                THEN r.page <= j.value ->> 1
                                ELSE r.idx <= j.value ->> 2 END))"
            ));
        }
        (!clauses.is_empty()).then(|| (clauses.join(" AND "), args))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::books::Scan;
    use crate::db::{self, NewDoc, TextChunk};

    fn part(id: &str, opened: bool, furthest: f64, page: Option<i64>) -> PartState {
        PartState {
            doc_id: id.into(),
            opened,
            furthest,
            furthest_page: page,
        }
    }

    fn live(id: &str, page: Option<i64>, fraction: f64) -> Live {
        Live {
            doc_id: id.into(),
            page,
            fraction,
        }
    }

    #[test]
    fn 没开防剧透_或者还没开始读_都不设限() {
        let parts = [part("a", true, 0.4, None), part("b", false, 0.0, None)];
        assert_eq!(
            book_bounds(false, &parts, Some(&live("a", None, 0.5))),
            vec![Bound::Open, Bound::Open]
        );
        // 开了防剧透，但一篇都没打开过：用户没在读这本，整本都能查
        let unread = [part("a", false, 0.0, None), part("b", false, 0.0, None)];
        assert_eq!(
            book_bounds(true, &unread, None),
            vec![Bound::Open, Bound::Open]
        );
        // 正开着的是别的书里的一篇，不算这本书开始读了
        assert_eq!(
            book_bounds(true, &unread, Some(&live("别的书", None, 0.9))),
            vec![Bound::Open, Bound::Open]
        );
        assert!(book_bounds(true, &[], None).is_empty());
    }

    #[test]
    fn 开始读了_打开过的最靠后那篇之前整篇算读过_它自己到读过的地方_之后的不给看() {
        let parts = [
            part("一", true, 0.2, None),
            part("二", false, 0.0, None),
            part("三", true, 0.5, None),
            part("四", false, 0.0, None),
            part("五", false, 0.0, None),
        ];
        let b = book_bounds(true, &parts, None);
        // 第一篇只读了两成、第二篇压根没打开过，但用户已经读到第三篇了：前面的都算读过
        assert_eq!(b[0], Bound::Open);
        assert_eq!(b[1], Bound::Open);
        assert_eq!(
            b[2],
            Bound::UpTo {
                page: None,
                fraction: 0.5
            }
        );
        assert_eq!((b[3], b[4]), (Bound::Blocked, Bound::Blocked));

        // 用户回头重读第一篇：界线不往回缩
        assert_eq!(book_bounds(true, &parts, Some(&live("一", None, 0.1))), b);
        // 刚翻开第四篇，还没来得及存进度：它成了最靠后的那篇，第三篇整篇算读过
        let b = book_bounds(true, &parts, Some(&live("四", None, 0.0)));
        assert_eq!(b[2], Bound::Open);
        assert_eq!(
            b[3],
            Bound::UpTo {
                page: None,
                fraction: 0.0
            }
        );
        assert_eq!(b[4], Bound::Blocked);
    }

    #[test]
    fn 界线取存下来的最远处和此刻位置里大的_页码和比例各比各的() {
        let parts = [part("书", true, 0.6, Some(7))];
        let at = |l: Option<Live>| book_bounds(true, &parts, l.as_ref())[0];
        assert_eq!(
            at(None),
            Bound::UpTo {
                page: Some(7),
                fraction: 0.6
            }
        );
        // 往回翻到第 3 页：读过的第 4 到 7 页还是读过
        assert_eq!(
            at(Some(live("书", Some(3), 0.2))),
            Bound::UpTo {
                page: Some(7),
                fraction: 0.6
            }
        );
        // 往后翻到第 9 页，进度还没存
        assert_eq!(
            at(Some(live("书", Some(9), 0.8))),
            Bound::UpTo {
                page: Some(9),
                fraction: 0.8
            }
        );
        // 老库升上来的记录没有页码，只有比例。此刻的位置比它靠后：用此刻的页码
        let old = [part("书", true, 0.6, None)];
        assert_eq!(
            book_bounds(true, &old, Some(&live("书", Some(9), 0.8)))[0],
            Bound::UpTo {
                page: Some(9),
                fraction: 0.8
            }
        );
        // 此刻翻回了前面：第 4 页不是读到过的最远处，不能当界线，只按比例比
        assert_eq!(
            book_bounds(true, &old, Some(&live("书", Some(4), 0.3)))[0],
            Bound::UpTo {
                page: None,
                fraction: 0.6
            }
        );
        // 头一回打开（还没有记录）：此刻的位置就是全部
        let fresh = [part("书", false, 0.0, None)];
        assert_eq!(
            book_bounds(true, &fresh, Some(&live("书", Some(2), 0.1)))[0],
            Bound::UpTo {
                page: Some(2),
                fraction: 0.1
            }
        );
        // 界面送来的比例不像话也不至于把整篇放开
        assert_eq!(
            book_bounds(true, &old, Some(&live("书", None, f64::NAN)))[0],
            Bound::UpTo {
                page: None,
                fraction: 0.6
            }
        );
    }

    #[test]
    fn 片段读没读到_有页码按页_没有按先后() {
        let by_page = Bound::UpTo {
            page: Some(3),
            fraction: 0.1,
        };
        assert!(by_page.allows(Some(3), 90, 100));
        assert!(!by_page.allows(Some(4), 5, 100));
        // 这一篇的片段没有页码：退回按先后比
        assert!(by_page.allows(None, 10, 100));
        assert!(!by_page.allows(None, 11, 100));
        // 知道片段的页码、不知道读到第几页（老记录）：也按先后比
        let by_fraction = Bound::UpTo {
            page: None,
            fraction: 0.5,
        };
        assert!(by_fraction.allows(Some(9), 2, 4));
        assert!(!by_fraction.allows(Some(1), 3, 4));
        assert!(Bound::Open.allows(Some(99), 99, 1));
        assert!(!Bound::Blocked.allows(None, 0, 10));
    }

    fn add(conn: &mut Connection, title: &str, path: &str, kind: &str) -> String {
        let chunks: Vec<TextChunk> = (0..4)
            .map(|i| TextChunk {
                idx: i,
                page: None,
                text: format!("{title} 第 {i} 块"),
            })
            .collect();
        let doc = NewDoc {
            title,
            path,
            kind,
            pages: None,
            author: None,
            cover: None,
        };
        db::import_document(conn, &doc, &chunks).unwrap()
    }

    #[test]
    fn 按库里的记录算每一篇_防剧透开没开按书走() {
        let mut conn = db::open_in_memory().unwrap();
        // 一本三卷的小说（都是 txt，防剧透默认开）、一本合同（pdf，默认关）、一本没打开过的小说
        let serial = books::create_book(&conn, "连载", None, Some("/n"), Scan::None).unwrap();
        let v: Vec<String> = ["卷一.txt", "卷二.txt", "卷三.txt"]
            .iter()
            .map(|n| add(&mut conn, n, &format!("/n/{n}"), "txt"))
            .collect();
        let contract = add(&mut conn, "合同.pdf", "/c/合同.pdf", "pdf");
        let unread = add(&mut conn, "没读的小说", "/u.epub", "epub");
        db::save_reading_state(&conn, &v[1], "loc", 0.5, None).unwrap();
        db::save_reading_state(&conn, &contract, "loc", 0.1, Some(1)).unwrap();

        let b = bounds(&conn, None).unwrap();
        assert_eq!(b.len(), 5);
        assert_eq!(b[&v[0]], Bound::Open);
        assert_eq!(
            b[&v[1]],
            Bound::UpTo {
                page: None,
                fraction: 0.5
            }
        );
        assert_eq!(b[&v[2]], Bound::Blocked);
        assert_eq!(b[&contract], Bound::Open);
        assert_eq!(b[&unread], Bound::Open);
        assert_eq!(bound_of(&conn, &v[2], None).unwrap(), Bound::Blocked);
        assert_eq!(bound_of(&conn, "没有这一篇", None).unwrap(), Bound::Open);

        // 正开着第三卷：它不再被挡，第二卷整篇算读过
        let now = live(&v[2], None, 0.25);
        let b = bounds(&conn, Some(&now)).unwrap();
        assert_eq!(b[&v[1]], Bound::Open);
        assert_eq!(
            bound_of(&conn, &v[2], Some(&now)).unwrap(),
            Bound::UpTo {
                page: None,
                fraction: 0.25
            }
        );

        // 用户把连载的防剧透关了、给合同开了
        books::set_spoiler(&conn, &serial, Some(false)).unwrap();
        let contract_book = books::book_of(&conn, &contract).unwrap().unwrap();
        books::set_spoiler(&conn, &contract_book, Some(true)).unwrap();
        let b = bounds(&conn, None).unwrap();
        assert!(v.iter().all(|id| b[id] == Bound::Open));
        assert_eq!(
            b[&contract],
            Bound::UpTo {
                page: Some(1),
                fraction: 0.1
            }
        );

        // 调了篇的顺序，界线跟着新的顺序走：第二卷挪到最后，前两篇都算读过
        books::set_spoiler(&conn, &serial, None).unwrap();
        books::move_part(&mut conn, &v[1], 1).unwrap();
        let b = bounds(&conn, None).unwrap();
        assert_eq!((b[&v[0]], b[&v[2]]), (Bound::Open, Bound::Open));
    }

    #[test]
    fn 筛选条件_没什么可拦时不加_范围外的界线不带进去() {
        let mut conn = db::open_in_memory().unwrap();
        books::create_book(&conn, "连载", None, Some("/n"), Scan::None).unwrap();
        let a = add(&mut conn, "卷一.txt", "/n/卷一.txt", "txt");
        let b = add(&mut conn, "卷二.txt", "/n/卷二.txt", "txt");
        let other = add(&mut conn, "合同.md", "/c/合同.md", "md");
        assert!(Access::all().filter(3).is_none());
        // 没开始读、也没限定范围：查询保持原样；空的范围等于没限定
        assert!(Access::of(&conn, None, None).unwrap().filter(3).is_none());
        assert!(Access::of(&conn, Some(&[]), None)
            .unwrap()
            .filter(3)
            .is_none());

        db::save_reading_state(&conn, &a, "loc", 0.5, None).unwrap();
        let (sql, args) = Access::of(&conn, None, None).unwrap().filter(3).unwrap();
        assert!(sql.contains("?3") && !sql.contains("?4"), "{sql}");
        // 卷一读到一半（4 块里到第 2 块为止），卷二整篇挡住
        let limits: serde_json::Value = match &args[0] {
            Value::Text(t) => serde_json::from_str(t).unwrap(),
            other => panic!("{other:?}"),
        };
        let mut want = vec![
            serde_json::json!([a, null, 2]),
            serde_json::json!([b, null, -1]),
        ];
        want.sort_by_key(|v| v[0].as_str().unwrap().to_string());
        assert_eq!(limits, serde_json::Value::Array(want));

        // 只在合同里找：连载的界线用不上，只剩范围这一条
        let scope = [other];
        let (sql, args) = Access::of(&conn, Some(&scope), None)
            .unwrap()
            .filter(3)
            .unwrap();
        assert_eq!(args.len(), 1);
        assert!(!sql.contains("NOT IN"), "{sql}");
        // 范围和界线都有：两个参数，编号接着排
        let scope = [a, b];
        let (sql, args) = Access::of(&conn, Some(&scope), None)
            .unwrap()
            .filter(3)
            .unwrap();
        assert_eq!(args.len(), 2);
        assert!(sql.contains("?3") && sql.contains("?4"), "{sql}");
    }
}
