//! The search evaluation set (plans/memory-search.md phase 0): synthetic
//! notes (`eval/notes.txt`) and queries with the notes they should find
//! (`eval/queries.txt`). The test reports recall@8 and MRR per query class
//! and asserts floors, which each search change may raise but not lower.
//! Run `cargo test -p pirc-gateway search_evaluation -- --nocapture` to see
//! the table.

use std::collections::BTreeMap;

use serde_json::json;

use super::*;
use crate::util::sha256_hex;

const NOTES: &str = include_str!("eval/notes.txt");
const QUERIES: &str = include_str!("eval/queries.txt");
const ME: &str = "me@example.com";
const TOP: usize = 8;

/// `(name, content)` or `(class, query, expected names)` per line.
fn lines(text: &str) -> impl Iterator<Item = Vec<&str>> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.split(" | ").map(str::trim).collect())
}

fn note_id(name: &str) -> String {
    sha256_hex(name)[..12].to_owned()
}

pub struct Query {
    pub class: String,
    pub text: String,
    pub expected: Vec<String>,
}

pub fn notes() -> Vec<(String, String)> {
    lines(NOTES)
        .map(|parts| {
            assert_eq!(parts.len(), 2, "a note line: {parts:?}");
            (parts[0].to_owned(), parts[1].to_owned())
        })
        .collect()
}

pub fn queries() -> Vec<Query> {
    lines(QUERIES)
        .map(|parts| {
            assert_eq!(parts.len(), 3, "a query line: {parts:?}");
            Query {
                class: parts[0].to_owned(),
                text: parts[1].to_owned(),
                expected: parts[2].split(',').map(|n| n.trim().to_owned()).collect(),
            }
        })
        .collect()
}

/// A gateway with every note in one workspace ledger of `ME`.
fn loaded() -> (std::sync::Arc<App>, tempfile::TempDir) {
    let (app, dir) = crate::memory::tests::app();
    {
        let conn = app.db.lock();
        conn.sync_remote_workspaces(
            "n1",
            &[(
                "repo".into(),
                "pirc".into(),
                crate::db::ModeId::new("directory").unwrap(),
            )],
        )
        .unwrap();
        conn.create_session("n1:repo", "node://n1/s1", "n1", "s1", ME)
            .unwrap();
    }
    let items: Vec<Value> = notes()
        .iter()
        .map(|(name, content)| {
            json!({
                "id": note_id(name),
                "content": content,
                "relevance": "medium",
                "timestamp": "2026-10-01 10:00",
                "sessionId": "s1",
                "sourceMemoryIds": [],
            })
        })
        .collect();
    let line = json!({ "type": "recorded", "items": items });
    ingest(&app, "n1", "eval", 0, 100, false, &[line]).unwrap();
    (app, dir)
}

#[derive(Default)]
struct Score {
    queries: usize,
    recall: f64,
    reciprocal_rank: f64,
}

#[test]
fn search_evaluation() {
    let (app, _dir) = loaded();
    let names: BTreeMap<String, String> = notes()
        .into_iter()
        .map(|(name, _)| (note_id(&name), name))
        .collect();
    let mut classes: BTreeMap<String, Score> = BTreeMap::new();
    let mut misses = Vec::new();
    for query in queries() {
        for name in &query.expected {
            assert!(
                names.values().any(|known| known == name),
                "{name} is not a note"
            );
        }
        let hits = search(&app, ME, &query.text, None, Some(TOP as i64)).unwrap();
        let found: Vec<&str> = hits
            .iter()
            .filter_map(|hit| names.get(hit["id"].as_str()?).map(String::as_str))
            .collect();
        let relevant = |name: &str| query.expected.iter().any(|wanted| wanted == name);
        let recall =
            found.iter().filter(|name| relevant(name)).count() as f64 / query.expected.len() as f64;
        let reciprocal_rank = found
            .iter()
            .position(|name| relevant(name))
            .map_or(0.0, |rank| 1.0 / (rank + 1) as f64);
        if recall < 1.0 {
            misses.push(format!(
                "{} {:?}: found {found:?}, wanted {:?}",
                query.class, query.text, query.expected
            ));
        }
        let score = classes.entry(query.class.clone()).or_default();
        score.queries += 1;
        score.recall += recall;
        score.reciprocal_rank += reciprocal_rank;
    }
    println!("class        queries  recall@{TOP}  MRR");
    let mut report = BTreeMap::new();
    for (class, score) in &classes {
        let recall = score.recall / score.queries as f64;
        let mrr = score.reciprocal_rank / score.queries as f64;
        println!("{class:<12} {:>7}  {recall:>8.2}  {mrr:.2}", score.queries);
        report.insert(class.as_str(), (recall, mrr));
    }
    for miss in &misses {
        println!("miss: {miss}");
    }
    // Floors: the results of the current search (FTS5 + BM25, phase 1),
    // rounded down; the LIKE baseline is in plans/memory-search.md. Raise them
    // with each improvement; a change that lowers one needs a reason.
    for (class, (recall, mrr)) in FLOORS {
        let (got_recall, got_mrr) = report[class];
        assert!(
            got_recall >= *recall && got_mrr >= *mrr,
            "{class}: recall@{TOP} {got_recall:.2} (floor {recall}), MRR {got_mrr:.2} (floor {mrr})"
        );
    }
}

/// `(class, recall@8, MRR)` floors.
const FLOORS: &[(&str, (f64, f64))] = &[
    ("en", (0.79, 0.92)),
    ("zh", (0.99, 0.99)),
    ("mixed", (0.99, 0.99)),
    ("identifier", (0.99, 0.99)),
    ("paraphrase", (0.79, 0.99)),
    ("recall", (0.63, 0.7)),
];
