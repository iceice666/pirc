//! `Bun.Glob(pattern).match(path)`: `*`, `?`, `**` segments, character
//! classes (`[a-z]`, `[!x]`, `[^x]`), braces (nested), `\` escapes and
//! leading `!` negation, as Bun 1.x matches them (case-sensitive; `*` also
//! matches dotfiles).

/// Most alternatives a brace pattern expands to.
const MAX_ALTERNATIVES: usize = 4096;
/// Bun matches nothing for a pattern with more brace groups than this.
const MAX_BRACE_GROUPS: usize = 10;
/// Most characters all brace alternatives together may hold.
const MAX_EXPANDED_CHARS: usize = 1 << 22;
/// Most matcher steps (active states x path characters, summed over the
/// alternatives) one `is_match` may take; past it the path does not match,
/// so a pathological pattern costs bounded time per file.
const MAX_STEPS: usize = 1 << 20;

pub struct Glob {
    negated: bool,
    /// Compiled brace-free alternatives; `None` when the pattern can match
    /// nothing.
    alternatives: Option<Vec<Vec<Token>>>,
}

impl Glob {
    pub fn new(pattern: &str) -> Self {
        let mut chars: &[char] = &pattern.chars().collect::<Vec<_>>();
        let mut negated = false;
        while chars.first() == Some(&'!') {
            negated = !negated;
            chars = &chars[1..];
        }
        let alternatives = if brace_groups(chars) > MAX_BRACE_GROUPS {
            None
        } else {
            expand(chars).map(|all| all.iter().map(|p| compile(p)).collect())
        };
        Self {
            negated,
            alternatives,
        }
    }

    pub fn is_match(&self, path: &str) -> bool {
        let path: Vec<char> = path.chars().collect();
        let mut budget = MAX_STEPS;
        let matched = self
            .alternatives
            .as_ref()
            .is_some_and(|all| all.iter().any(|tokens| matches(tokens, &path, &mut budget)));
        matched != self.negated
    }
}

/// For every index `j`, where a class body scanned from `j` closes: the
/// first `]` at or after `j` that no `\\` escapes (`usize::MAX` if none).
/// One backward pass, so finding class ends is linear.
fn closes(p: &[char]) -> Vec<usize> {
    let mut close = vec![usize::MAX; p.len() + 2];
    for j in (0..p.len()).rev() {
        close[j] = match p[j] {
            '\\' => close[j + 2],
            ']' => j,
            _ => close[j + 1],
        };
    }
    close
}

/// Closed brace groups in the pattern (escapes and classes skipped).
fn brace_groups(p: &[char]) -> usize {
    let close = closes(p);
    let mut open = 0usize;
    let mut groups = 0;
    let mut i = 0;
    while i < p.len() {
        match p[i] {
            '\\' => i += 1,
            '[' => {
                if let Some(end) = class_end(p, &close, i) {
                    i = end;
                    continue;
                }
            }
            '{' => open += 1,
            '}' if open > 0 => {
                open -= 1;
                groups += 1;
            }
            _ => {}
        }
        i += 1;
    }
    groups
}

/// End (exclusive) of the class starting at `start` (`[`), if it closes;
/// `close` is [`closes`] of `p`.
fn class_end(p: &[char], close: &[usize], start: usize) -> Option<usize> {
    let mut first = start + 1;
    if matches!(p.get(first), Some('!' | '^')) {
        first += 1;
    }
    // A `]` right after the opening is part of the body.
    let from = if p.get(first) == Some(&']') {
        first + 1
    } else {
        first
    };
    let end = *close.get(from)?;
    (end != usize::MAX).then(|| end + 1)
}

/// The brace-free patterns `p` stands for.
fn expand(p: &[char]) -> Option<Vec<Vec<char>>> {
    let close = closes(p);
    let mut i = 0;
    while i < p.len() {
        match p[i] {
            '\\' => i += 2,
            '[' => i = class_end(p, &close, i).unwrap_or(i + 1),
            '{' => {
                let (parts, close) = brace_parts(p, &close, i);
                let prefix = &p[..i];
                let (parts, suffix): (Vec<&[char]>, &[char]) = match close {
                    Some(close) => (parts, &p[close + 1..]),
                    // Unclosed: the first alternative ends the pattern; without a
                    // comma nothing matches.
                    None if parts.len() > 1 => (parts[..1].to_vec(), &[]),
                    None => return None,
                };
                let tails = expand(suffix)?;
                let mut out = Vec::new();
                let mut total = 0usize;
                for part in parts {
                    for middle in expand(part)? {
                        for tail in &tails {
                            if out.len() >= MAX_ALTERNATIVES || total >= MAX_EXPANDED_CHARS {
                                return Some(out);
                            }
                            let mut pattern = prefix.to_vec();
                            pattern.extend(&middle);
                            pattern.extend(tail);
                            total += pattern.len();
                            out.push(pattern);
                        }
                    }
                }
                return Some(out);
            }
            _ => i += 1,
        }
    }
    Some(vec![p.to_vec()])
}

/// The top-level alternatives of the brace at `open` and its closing index.
fn brace_parts<'p>(
    p: &'p [char],
    close: &[usize],
    open: usize,
) -> (Vec<&'p [char]>, Option<usize>) {
    let mut parts = Vec::new();
    let mut depth = 0;
    let mut start = open + 1;
    let mut i = open + 1;
    while i < p.len() {
        match p[i] {
            '\\' => {
                i += 2;
                continue;
            }
            '[' => {
                i = class_end(p, close, i).unwrap_or(i + 1);
                continue;
            }
            '{' => depth += 1,
            '}' if depth > 0 => depth -= 1,
            '}' => {
                parts.push(&p[start..i]);
                return (parts, Some(i));
            }
            ',' if depth == 0 => {
                parts.push(&p[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(&p[start.min(p.len())..]);
    (parts, None)
}

/// One step of a compiled alternative.
#[derive(Debug)]
enum Token {
    Char(char),
    /// `?`: one character other than `/`.
    Any,
    /// `[...]` with its body.
    Class(Vec<char>),
    /// `*` (a run of them): any characters other than `/`.
    Star,
    /// `**/`: zero or more whole segments.
    Segments,
    /// A trailing `**`: everything that is left.
    Rest,
    /// What can match nothing (an unclosed class, a trailing `\\`).
    Never,
}

/// Compiles a brace-free pattern.
fn compile(p: &[char]) -> Vec<Token> {
    let close = closes(p);
    let mut tokens = Vec::new();
    let mut pi = 0;
    while pi < p.len() {
        match p[pi] {
            '*' => {
                let globstar = p.get(pi + 1) == Some(&'*')
                    && (pi == 0 || p[pi - 1] == '/')
                    && (pi + 2 == p.len() || p[pi + 2] == '/');
                if globstar && pi + 2 == p.len() {
                    tokens.push(Token::Rest);
                    pi += 2;
                } else if globstar {
                    tokens.push(Token::Segments);
                    pi += 3;
                } else {
                    tokens.push(Token::Star);
                    while p.get(pi) == Some(&'*') {
                        pi += 1;
                    }
                }
            }
            '?' => {
                tokens.push(Token::Any);
                pi += 1;
            }
            '[' => match class_end(p, &close, pi) {
                Some(end) => {
                    tokens.push(Token::Class(p[pi + 1..end - 1].to_vec()));
                    pi = end;
                }
                None => {
                    tokens.push(Token::Never);
                    break;
                }
            },
            '\\' => match p.get(pi + 1) {
                Some(&c) => {
                    tokens.push(Token::Char(c));
                    pi += 2;
                }
                None => {
                    tokens.push(Token::Never);
                    break;
                }
            },
            c => {
                tokens.push(Token::Char(c));
                pi += 1;
            }
        }
    }
    tokens
}

/// Runs the tokens over the path as a set of active positions, one path
/// character at a time: no recursion, no table, and a mismatch ends as soon
/// as no position is left. `budget` counts the steps all alternatives of
/// one `is_match` may still take.
fn matches(tokens: &[Token], s: &[char], budget: &mut usize) -> bool {
    let n = tokens.len();
    // States `0..=n` are token positions; `n + 1 + at` is "inside the
    // segments of the `**/` at `at`", which may only move on after a `/`.
    let inside = |at: usize| n + 1 + at;
    let mut current: Vec<usize> = Vec::new();
    let mut next: Vec<usize> = Vec::new();
    let mut seen = vec![usize::MAX; 2 * n + 2];
    // Adds `state` and what a position reaches without consuming (stars may
    // match nothing, `**/` zero segments); true when a trailing `**` is
    // reached.
    let add = |state: usize, round: usize, set: &mut Vec<usize>, seen: &mut Vec<usize>| -> bool {
        let mut state = state;
        loop {
            if seen[state] == round {
                return false;
            }
            seen[state] = round;
            set.push(state);
            if state > n {
                return false;
            }
            match tokens.get(state) {
                Some(Token::Rest) => return true,
                Some(Token::Star | Token::Segments) => state += 1,
                _ => return false,
            }
        }
    };
    if add(0, 0, &mut current, &mut seen) {
        return true;
    }
    for (si, &c) in s.iter().enumerate() {
        let round = si + 1;
        next.clear();
        for &state in &current {
            if *budget == 0 {
                return false;
            }
            *budget -= 1;
            let at = if state > n { state - n - 1 } else { state };
            let token = if state > n {
                Some(&Token::Segments)
            } else {
                tokens.get(at)
            };
            let advance = match token {
                None | Some(Token::Never | Token::Rest) => false,
                Some(Token::Char(want)) => c == *want,
                Some(Token::Any) => c != '/',
                Some(Token::Class(body)) => in_class(body, c),
                Some(Token::Star) => {
                    if c != '/' && add(at, round, &mut next, &mut seen) {
                        return true;
                    }
                    false
                }
                Some(Token::Segments) => {
                    if add(inside(at), round, &mut next, &mut seen) {
                        return true;
                    }
                    c == '/'
                }
            };
            if advance && add(at + 1, round, &mut next, &mut seen) {
                return true;
            }
        }
        if next.is_empty() {
            return false;
        }
        std::mem::swap(&mut current, &mut next);
    }
    current.contains(&n)
}

/// Whether `c` is in the class body (between `[` and `]`).
fn in_class(body: &[char], c: char) -> bool {
    let (negated, body) = match body.first() {
        Some('!' | '^') => (true, &body[1..]),
        _ => (false, body),
    };
    let item = |i: usize| -> Option<(char, usize)> {
        match body.get(i)? {
            '\\' => body.get(i + 1).map(|c| (*c, i + 2)),
            c => Some((*c, i + 1)),
        }
    };
    let mut found = false;
    let mut i = 0;
    while let Some((low, next)) = item(i) {
        if body.get(next) == Some(&'-')
            && let Some((high, after)) = item(next + 1)
        {
            found |= low <= c && c <= high;
            i = after;
            continue;
        }
        found |= low == c;
        i = next;
    }
    found != negated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backtracking_patterns_stay_fast() {
        let started = std::time::Instant::now();
        let name = "a".repeat(60);
        assert!(!Glob::new("*a*a*a*a*a*a*a*a*a*b").is_match(&name));
        assert!(Glob::new("*a*a*a*a*a*a*a*a*a*").is_match(&name));
        let deep = "d/".repeat(30) + "x";
        assert!(Glob::new("**/**/**/**/**/**/**/**/x").is_match(&deep));
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn long_globstar_chains_do_not_overflow_the_stack() {
        // About 90 KB of `**/`, matched on a thread with a small stack.
        let pattern = "**/".repeat(30_000) + "zz";
        let found = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(move || {
                let glob = Glob::new(&pattern);
                (glob.is_match("a/b/zz"), glob.is_match("a/b/z"))
            })
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(found, (true, false));
    }

    #[test]
    fn huge_patterns_stay_fast() {
        let started = std::time::Instant::now();
        let braces = "{a,b}".repeat(10) + &"x".repeat(100_000);
        assert!(!Glob::new(&braces).is_match("abababababx"));
        let classes = Glob::new(&"[".repeat(50_000));
        assert!(!classes.is_match("a/b/c"));
        let wide = Glob::new(&("{a,b}".repeat(10) + &"x".repeat(1000)));
        let long = "c".repeat(4000);
        for _ in 0..100 {
            assert!(!wide.is_match(&long));
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn more_than_ten_brace_groups_match_nothing() {
        let groups = |n: usize| "{a,b}".repeat(n);
        assert!(Glob::new(&groups(10)).is_match(&"a".repeat(10)));
        assert!(!Glob::new(&groups(11)).is_match(&"a".repeat(11)));
    }

    /// Recorded from `new Bun.Glob(pattern).match(path)` (Bun 1.4).
    const CASES: &[(&str, &str, bool)] = &[
        ("*.ts", "a.ts", true),
        ("*.ts", ".a.ts", true),
        ("*.ts", "src/a.ts", false),
        ("**/*.ts", "a.ts", true),
        ("**/*.ts", "src/a.ts", true),
        ("**/*.ts", "src/.hidden/a.ts", true),
        ("**", "a/b/c", true),
        ("src/**", "src/a/b", true),
        ("src/**", "src", false),
        ("src/**/x.ts", "src/x.ts", true),
        ("?.ts", "a.ts", true),
        ("?.ts", "ab.ts", false),
        ("*.{ts,js}", "a.js", true),
        ("*.{ts,{j,c}s}", "a.cs", true),
        ("[abc].ts", "b.ts", true),
        ("[!abc].ts", "b.ts", false),
        ("[^abc].ts", "d.ts", true),
        ("[a-c].ts", "b.ts", true),
        ("a\\*b", "a*b", true),
        ("a\\*b", "axb", false),
        ("!*.ts", "a.js", true),
        ("!*.ts", "a.ts", false),
        ("*", ".git", true),
        ("a/*/b", "a/x/y/b", false),
        ("a/**/b", "a/b", true),
        ("**/b", "b", true),
        ("*a", "ba/ca", false),
        ("x*", "x/y", false),
        ("{a,b}/*.ts", "b/c.ts", true),
        ("[a-", "[a-", false),
        ("a{b", "a{b", false),
        ("a}", "a}", true),
        ("**.ts", "x/a.ts", false),
        ("**.ts", "a.ts", true),
        ("a**b", "axxb", true),
        ("a**b", "ax/xb", false),
        ("src/**/*", "src/a", true),
        ("src/**/*", "src/a/b", true),
        ("./a.ts", "a.ts", false),
        ("*.TS", "a.ts", false),
        ("[[]", "[", true),
        ("[]]", "]", true),
        ("[!]]", "a", true),
        ("a/", "a", false),
        ("a", "a/", false),
        ("**/", "a/", true),
        ("{,a}b", "b", true),
        ("{a,}b", "ab", true),
        ("*/", "a/", true),
        ("a/**", "a/", true),
        ("[\\]]", "]", true),
        ("[a\\-z]", "-", true),
        ("**/*.md", "README.md", true),
        ("**/notes.md", "src/notes.md", true),
        ("*.md", "src/notes.md", false),
        ("**/**/x", "x", true),
        ("a/**/**/b", "a/b", true),
        ("{a,b", "a", true),
        ("{a,b", "{a,b", false),
        ("*{", "a{", false),
        ("[a", "[a", false),
        ("[a", "a", false),
        ("\\", "\\", false),
        ("a\\", "a", false),
        ("a\\", "a\\", false),
        ("[ab]]", "a]", true),
        ("[!a-c]x", "dx", true),
        ("**/a/**", "a", false),
        ("**/a/**", "x/a/y", true),
        ("*/**/a", "x/a", true),
        ("ab*", "ab", true),
        ("*b*", "abc", true),
        ("{a,b}{c,d}", "bd", true),
        ("{*.ts,*.js}", "x.js", true),
        ("{src/**,lib}/*.rs", "src/x/y.rs", true),
        ("a{b", "ab", false),
        ("a{b", "a", false),
        ("{a,b", "b", false),
        ("x{a,b", "xb", false),
        ("x{a,b", "x", false),
        ("[!a]", "/", true),
        ("a[!b]c", "a/c", true),
        ("*", "", true),
        ("?", "/", false),
        ("", "", true),
        ("", "a", false),
        ("{a,b}c}", "ac}", true),
        ("{a,{b,c}", "c", false),
        ("a\\{b,c}", "a{b,c}", true),
        ("a\\{b,c}", "ab", false),
        ("\\a", "a", true),
        ("[a-c-e]", "d", false),
        ("[a-c-e]", "-", true),
        ("[z-a]", "m", false),
        ("**a", "xa", true),
        ("a/**b", "a/xb", true),
        ("a/**b", "a/x/b", false),
        ("**/", "a/b/", true),
        ("**", "", true),
        ("a/**/", "a/", true),
        ("a/**/", "a/b/", true),
        ("{**/,}x", "y/x", true),
        ("*.*", "a", false),
        ("[[:alpha:]]", "a", false),
        ("{a,b}*", "bz", true),
        ("!!a", "a", true),
        ("!", "a", true),
        ("!", "", false),
        ("[]", "a", false),
        ("[]a]", "a", true),
        ("[!]", "a", false),
        ("[a-]", "-", true),
        ("[-a]", "-", true),
        ("a/**/b", "a/x/y/b", true),
        ("**/*", "a", true),
        ("**/*", ".a/b", true),
        ("a//b", "a//b", true),
        ("a//b", "a/b", false),
        ("{a/b,c}/d", "a/b/d", true),
        ("é?", "éx", true),
        ("?", "é", true),
        ("*.ts", "é.ts", true),
        ("[à-ü]", "é", true),
        ("a{,}", "a", true),
        ("{}", "{}", false),
        ("{}", "", true),
        ("{,}", "", true),
    ];

    #[test]
    fn matches_like_bun() {
        for (pattern, path, expected) in CASES {
            assert_eq!(
                Glob::new(pattern).is_match(path),
                *expected,
                "{pattern:?} against {path:?}"
            );
        }
    }
}
