//! Whether what a poll saw wakes the brain (decision #4, #17): Rust
//! decides, so a busy inbox does not spend the day's wakes. A change wakes
//! it when a room follows the source, or when it touches an open loop:
//! they share a distinctive term (a word with a digit like `hw3`, a word of
//! three letters or more that is not a common one, a pair of CJK
//! characters, as the search index cuts them), two when the loop has more
//! than two. Everything else is only kept in `source_items`.

use std::collections::BTreeSet;

use rusqlite::Connection;

use super::store::{Item, Source};
use crate::error::ApiResult;
use crate::memory::text::{fold, spaceless};

/// Words too common in subjects and loops to tell anything.
const COMMON: &[&str] = &[
    "the",
    "and",
    "for",
    "from",
    "with",
    "your",
    "you",
    "this",
    "that",
    "are",
    "was",
    "has",
    "have",
    "not",
    "but",
    "all",
    "new",
    "about",
    "into",
    "re",
    "fw",
    "fwd",
    "via",
    "our",
    "out",
    "get",
    "will",
    "can",
    "please",
    "update",
    "updated",
    "reminder",
    "notification",
    "notifications",
    "week",
    "today",
    "tomorrow",
    "due",
    "now",
    "just",
    "more",
    "info",
    "news",
    "hello",
    "dear",
];

/// What woke it, if anything.
#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    /// `followed` (a room follows the source) or `loop`.
    pub reason: &'static str,
    /// The room to wake in, when a room follows the source.
    pub room_id: Option<String>,
    /// The loops touched (by id), first the best.
    pub loop_ids: Vec<String>,
    /// The changes that woke it (all of them for a followed source).
    pub items: Vec<Item>,
}

/// A text's distinctive terms.
pub fn terms(text: &str) -> BTreeSet<String> {
    let folded = fold(text);
    let mut found = BTreeSet::new();
    let mut word = String::new();
    let mut cjk: Vec<char> = Vec::new();
    let flush_word = |word: &mut String, found: &mut BTreeSet<String>| {
        let keep = if word.chars().any(|c| c.is_ascii_digit()) {
            (word.chars().count() >= 2 && word.chars().any(char::is_alphabetic))
                || word.chars().count() >= 4
        } else {
            word.chars().count() >= 3 && !COMMON.contains(&word.as_str())
        };
        if keep {
            found.insert(std::mem::take(word));
        }
        word.clear();
    };
    let flush_cjk = |cjk: &mut Vec<char>, found: &mut BTreeSet<String>| {
        for pair in cjk.windows(2) {
            found.insert(pair.iter().collect());
        }
        cjk.clear();
    };
    for c in folded.chars() {
        if spaceless(c) {
            flush_word(&mut word, &mut found);
            cjk.push(c);
        } else if c.is_alphanumeric() {
            flush_cjk(&mut cjk, &mut found);
            word.push(c);
        } else {
            flush_word(&mut word, &mut found);
            flush_cjk(&mut cjk, &mut found);
        }
    }
    flush_word(&mut word, &mut found);
    flush_cjk(&mut cjk, &mut found);
    found
}

/// Whether an item touches a loop of these terms.
fn touches(loop_terms: &BTreeSet<String>, item: &Item) -> usize {
    let item_terms = terms(&format!(
        "{} {} {}",
        item.title,
        item.who.as_deref().unwrap_or_default(),
        item.summary
    ));
    let shared = loop_terms.intersection(&item_terms).count();
    let needed = if loop_terms.len() <= 2 { 1 } else { 2 };
    if shared >= needed { shared } else { 0 }
}

/// Whether the changes of a poll wake the brain.
pub fn decide(conn: &Connection, source: &Source, changed: &[Item]) -> ApiResult<Option<Decision>> {
    if changed.is_empty() {
        return Ok(None);
    }
    if let Some(room_id) = super::following_rooms(conn, &source.id)?.into_iter().next() {
        return Ok(Some(Decision {
            reason: "followed",
            room_id: Some(room_id),
            loop_ids: Vec::new(),
            items: changed.to_vec(),
        }));
    }
    let loops: Vec<(String, String)> = {
        let mut statement = conn.prepare(
            "SELECT id, what || ' ' || why || ' ' || coalesce(next_check,'') FROM open_loops WHERE status='open' ORDER BY last_touched_at DESC",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut touched: Vec<(usize, String)> = Vec::new();
    let mut items = Vec::new();
    for (loop_id, text) in &loops {
        let loop_terms = terms(text);
        if loop_terms.is_empty() {
            continue;
        }
        let mut best = 0;
        for item in changed {
            let shared = touches(&loop_terms, item);
            if shared > 0 {
                best = best.max(shared);
                if !items.iter().any(|found: &Item| found.id == item.id) {
                    items.push(item.clone());
                }
            }
        }
        if best > 0 {
            touched.push((best, loop_id.clone()));
        }
    }
    if touched.is_empty() {
        return Ok(None);
    }
    touched.sort_by_key(|(shared, _)| std::cmp::Reverse(*shared));
    Ok(Some(Decision {
        reason: "loop",
        room_id: None,
        loop_ids: touched.into_iter().map(|(_, id)| id).collect(),
        items,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(title: &str, who: &str) -> Item {
        Item {
            id: format!("item_{title}"),
            source_id: "email:school".to_owned(),
            external_id: title.to_owned(),
            kind: "message".to_owned(),
            title: title.to_owned(),
            who: Some(who.to_owned()),
            at: None,
            summary: format!("{who}: {title}"),
            url: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn distinctive_terms() {
        let found: Vec<String> = terms("Re: HW3 is due on 10/24 — 資料庫期中考")
            .into_iter()
            .collect();
        assert_eq!(found, ["hw3", "中考", "庫期", "料庫", "期中", "資料"]);
        assert!(terms("the new update for you").is_empty());
        assert!(terms("2026").contains("2026"));
    }

    #[test]
    fn what_wakes_and_what_does_not() {
        let db = crate::db::Db::memory();
        let conn = db.lock();
        let source = super::super::store::insert(
            &conn,
            &super::super::store::NewSource {
                id: "email:school",
                kind: "email",
                name: "School",
                owner: "me",
                config: &json!({}),
            },
            1,
        )
        .unwrap();
        let open = |id: &str, what: &str| {
            conn.execute(
                "INSERT INTO open_loops (id, owner_user, what, origin, status, created_at, last_touched_at) VALUES (?, 'me', ?, 'user', 'open', 1, 1)",
                [id, what],
            )
            .unwrap();
        };
        open("loop_1", "HW3 is due on 10/24");
        open("loop_2", "Tune the laptop's power policy with TLP");
        let newsletter = item("Your weekly digest", "Medium <noreply@medium.com>");
        assert_eq!(
            decide(&conn, &source, std::slice::from_ref(&newsletter)).unwrap(),
            None
        );
        let extended = item("HW3 extended to Friday", "Prof. Lin");
        let decision = decide(&conn, &source, &[newsletter.clone(), extended.clone()])
            .unwrap()
            .unwrap();
        assert_eq!(decision.reason, "loop");
        assert_eq!(decision.loop_ids, ["loop_1"]);
        assert_eq!(decision.items, std::slice::from_ref(&extended));
        // One shared word is not enough for a loop of more than two terms.
        assert_eq!(
            decide(&conn, &source, &[item("Laptop sale", "Shop")]).unwrap(),
            None
        );
        assert!(
            decide(&conn, &source, &[item("TLP power profiles", "Arch forums")])
                .unwrap()
                .is_some()
        );
        // A room that follows the source wakes for everything.
        conn.execute(
            "UPDATE rooms SET source_scope_json=? WHERE id='general'",
            [json!({ "sources": ["email:school"] }).to_string()],
        )
        .unwrap();
        let decision = decide(&conn, &source, std::slice::from_ref(&newsletter))
            .unwrap()
            .unwrap();
        assert_eq!(
            (decision.reason, decision.room_id.as_deref()),
            ("followed", Some("general"))
        );
    }
}
