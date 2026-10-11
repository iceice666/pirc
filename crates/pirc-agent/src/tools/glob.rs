//! `Bun.Glob(pattern).match(path)`: `*`, `?`, `**` segments, character
//! classes (`[a-z]`, `[!x]`, `[^x]`), braces (nested), `\` escapes and
//! leading `!` negation, as Bun 1.x matches them (case-sensitive; `*` also
//! matches dotfiles).

/// Most alternatives a brace pattern expands to.
const MAX_ALTERNATIVES: usize = 4096;
/// Bun matches nothing for a pattern with more brace groups than this.
const MAX_BRACE_GROUPS: usize = 10;

pub struct Glob {
    negated: bool,
    /// Brace-free alternatives; `None` when the pattern can match nothing.
    alternatives: Option<Vec<Vec<char>>>,
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
            expand(chars)
        };
        Self {
            negated,
            alternatives,
        }
    }

    pub fn is_match(&self, path: &str) -> bool {
        let path: Vec<char> = path.chars().collect();
        let matched = self.alternatives.as_ref().is_some_and(|all| {
            all.iter()
                .any(|pattern| Matcher::new(pattern, &path).matches(0, 0))
        });
        matched != self.negated
    }
}

/// Closed brace groups in the pattern (escapes and classes skipped).
fn brace_groups(p: &[char]) -> usize {
    let mut open = 0usize;
    let mut groups = 0;
    let mut i = 0;
    while i < p.len() {
        match p[i] {
            '\\' => i += 1,
            '[' => {
                if let Some(end) = class_end(p, i) {
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

/// End (exclusive) of the class starting at `start` (`[`), if it closes.
fn class_end(p: &[char], start: usize) -> Option<usize> {
    let mut i = start + 1;
    if matches!(p.get(i), Some('!' | '^')) {
        i += 1;
    }
    let first = i;
    while i < p.len() {
        match p[i] {
            '\\' => i += 2,
            ']' if i > first => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// The brace-free patterns `p` stands for.
fn expand(p: &[char]) -> Option<Vec<Vec<char>>> {
    let mut i = 0;
    while i < p.len() {
        match p[i] {
            '\\' => i += 2,
            '[' => i = class_end(p, i).unwrap_or(i + 1),
            '{' => {
                let (parts, close) = brace_parts(p, i);
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
                for part in parts {
                    for middle in expand(part)? {
                        for tail in &tails {
                            if out.len() >= MAX_ALTERNATIVES {
                                return Some(out);
                            }
                            let mut pattern = prefix.to_vec();
                            pattern.extend(&middle);
                            pattern.extend(tail);
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
fn brace_parts(p: &[char], open: usize) -> (Vec<&[char]>, Option<usize>) {
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
                i = class_end(p, i).unwrap_or(i + 1);
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

/// Matching with memoized states: each (pattern position, path position)
/// is decided once, so stars cannot backtrack exponentially.
struct Matcher<'a> {
    p: &'a [char],
    s: &'a [char],
    /// 0 unknown, 1 no, 2 yes; indexed `pi * (s.len() + 1) + si`.
    memo: Vec<u8>,
}

impl<'a> Matcher<'a> {
    fn new(p: &'a [char], s: &'a [char]) -> Self {
        Self {
            p,
            s,
            memo: vec![0; (p.len() + 1) * (s.len() + 1)],
        }
    }

    fn matches(&mut self, pi: usize, si: usize) -> bool {
        let slot = pi * (self.s.len() + 1) + si;
        match self.memo[slot] {
            1 => return false,
            2 => return true,
            _ => {}
        }
        let found = self.decide(pi, si);
        self.memo[slot] = if found { 2 } else { 1 };
        found
    }

    fn decide(&mut self, pi: usize, si: usize) -> bool {
        let (p, s) = (self.p, self.s);
        if pi == p.len() {
            return si == s.len();
        }
        match p[pi] {
            '*' => {
                let globstar = p.get(pi + 1) == Some(&'*')
                    && (pi == 0 || p[pi - 1] == '/')
                    && (pi + 2 == p.len() || p[pi + 2] == '/');
                if globstar {
                    if pi + 2 == p.len() {
                        return true;
                    }
                    // `**/`: zero or more whole segments.
                    let rest = pi + 3;
                    if self.matches(rest, si) {
                        return true;
                    }
                    return (si..s.len()).any(|j| s[j] == '/' && self.matches(rest, j + 1));
                }
                let mut next = pi + 1;
                while p.get(next) == Some(&'*') {
                    next += 1;
                }
                let mut k = si;
                loop {
                    if self.matches(next, k) {
                        return true;
                    }
                    if k == s.len() || s[k] == '/' {
                        return false;
                    }
                    k += 1;
                }
            }
            '?' => si < s.len() && s[si] != '/' && self.matches(pi + 1, si + 1),
            '[' => {
                let Some(end) = class_end(p, pi) else {
                    return false;
                };
                si < s.len() && in_class(&p[pi + 1..end - 1], s[si]) && self.matches(end, si + 1)
            }
            '\\' => {
                pi + 1 < p.len()
                    && si < s.len()
                    && s[si] == p[pi + 1]
                    && self.matches(pi + 2, si + 1)
            }
            c => si < s.len() && s[si] == c && self.matches(pi + 1, si + 1),
        }
    }
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
