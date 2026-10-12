//! The path helpers srt's Seatbelt backend uses: Node's POSIX `path`
//! functions, `normalizePathForSandbox` and its symlink boundary check,
//! the glob compilers and the default write paths.
//!
//! Ported from sandbox-runtime 0.0.78 `sandbox/sandbox-utils.js`
//! (Apache-2.0, see `crates/pirc-node/NOTICE`). Only the POSIX branches:
//! the Windows ones never run on macOS.

/// Node's `path.normalize` (POSIX): `.` and `..` folded, runs of `/`
/// collapsed, a trailing `/` kept.
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            part => parts.push(part),
        }
    }
    let joined = parts.join("/");
    if absolute {
        let mut out = format!("/{joined}");
        if trailing && !joined.is_empty() {
            out.push('/');
        }
        out
    } else if joined.is_empty() {
        if trailing { "./" } else { "." }.to_owned()
    } else if trailing {
        format!("{joined}/")
    } else {
        joined
    }
}

/// Node's `path.join` (POSIX).
pub fn join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".to_owned();
    }
    normalize(&joined.join("/"))
}

/// Node's `path.resolve(base, path)` (POSIX) with an absolute `base`.
pub fn resolve(base: &str, path: &str) -> String {
    let joined = if path.starts_with('/') {
        normalize(path)
    } else {
        normalize(&format!("{base}/{path}"))
    };
    if joined.len() > 1 {
        joined.trim_end_matches('/').to_owned()
    } else {
        joined
    }
}

/// Node's `path.dirname` (POSIX).
pub fn dirname(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_owned();
    }
    match trimmed.rfind('/') {
        None => ".".to_owned(),
        Some(0) => "/".to_owned(),
        Some(at) => trimmed[..at].to_owned(),
    }
}

/// Node's `path.basename` (POSIX).
pub fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    trimmed
        .rfind('/')
        .map_or(trimmed, |at| &trimmed[at + 1..])
        .to_owned()
}

/// `containsGlobChars`.
pub fn contains_glob_chars(pattern: &str) -> bool {
    pattern.contains(['*', '?', '[', ']'])
}

/// `isAtOrUnder`: `path` is `dir` or lies beneath it, by segment.
pub fn is_at_or_under(path: &str, dir: &str) -> bool {
    path == dir
        || if dir == "/" {
            path.starts_with('/')
        } else {
            path.strip_prefix(dir)
                .is_some_and(|rest| rest.starts_with('/'))
        }
}

/// `isStrictlyUnder`.
pub fn is_strictly_under(path: &str, dir: &str) -> bool {
    path != dir && is_at_or_under(path, dir)
}

/// `removeTrailingGlobSuffix`: `dir/**` is `dir`.
pub fn remove_trailing_glob_suffix(pattern: &str) -> String {
    let stripped = pattern.strip_suffix("/**").unwrap_or(pattern);
    if stripped.is_empty() {
        "/".to_owned()
    } else {
        stripped.to_owned()
    }
}

/// `isSymlinkOutsideBoundary`: whether resolving `original` to `resolved`
/// would widen what a rule names (an ancestor, a system root, a different
/// tree). Only resolutions to the same place, deeper, or `/tmp` and
/// `/var` to their `/private` forms are accepted.
pub fn is_symlink_outside_boundary(original: &str, resolved: &str) -> bool {
    let original = normalize(original);
    let resolved = normalize(resolved);
    if resolved == original {
        return false;
    }
    let private = |path: &str| {
        (path.starts_with("/tmp/") || path.starts_with("/var/")).then(|| format!("/private{path}"))
    };
    if private(&original).is_some_and(|canonical| canonical == resolved) {
        return false;
    }
    if resolved == "/" {
        return true;
    }
    if resolved.split('/').filter(|part| !part.is_empty()).count() <= 1 {
        return true;
    }
    if original.starts_with(&format!("{resolved}/")) {
        return true;
    }
    let canonical = private(&original).unwrap_or_else(|| original.clone());
    if canonical != original && canonical.starts_with(&format!("{resolved}/")) {
        return true;
    }
    let starts_with_original = resolved.starts_with(&format!("{original}/"));
    let starts_with_canonical =
        canonical != original && resolved.starts_with(&format!("{canonical}/"));
    let is_canonical = canonical != original && resolved == canonical;
    !is_canonical && !starts_with_original && !starts_with_canonical
}

/// `expandTilde` (POSIX).
fn expand_tilde(path: &str, home: &str) -> String {
    if path == "~" {
        return home.to_owned();
    }
    match path.strip_prefix("~/") {
        Some(rest) => format!("{home}/{rest}"),
        None => path.to_owned(),
    }
}

/// `collapseInteriorSpellings`: runs of `/` collapsed, `/./` dropped.
fn collapse_interior_spellings(path: &str) -> String {
    let mut collapsed = String::with_capacity(path.len());
    for c in path.chars() {
        if c == '/' && collapsed.ends_with('/') {
            continue;
        }
        collapsed.push(c);
    }
    // `/\.(?=\/)` removed, left to right.
    let mut out = String::with_capacity(collapsed.len());
    let bytes = collapsed.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'/' && bytes.get(at + 1) == Some(&b'.') && bytes.get(at + 2) == Some(&b'/')
        {
            at += 2;
            continue;
        }
        let c = collapsed[at..].chars().next().unwrap_or_default();
        out.push(c);
        at += c.len_utf8();
    }
    out
}

/// `fs.realpathSync`.
pub fn realpath(path: &str) -> Option<String> {
    std::fs::canonicalize(path)
        .ok()
        .and_then(|real| real.to_str().map(str::to_owned))
}

/// Where srt's paths are resolved from: `process.cwd()` and `os.homedir()`.
#[derive(Clone, Copy, Debug)]
pub struct Context<'a> {
    pub cwd: &'a str,
    pub home: &'a str,
}

/// `normalizePathForSandbox`: `~` and relative spellings made absolute,
/// interior `//` and `/./` collapsed, symlinks resolved (for a glob, in its
/// static directory only) unless the resolution leaves the boundary
/// [`is_symlink_outside_boundary`] draws. `literal` marks a path that
/// names one file whatever characters it holds.
pub fn normalize_path_for_sandbox(pattern: &str, literal: bool, ctx: Context<'_>) -> String {
    let is_glob = |path: &str| !literal && contains_glob_chars(path);
    let mut pattern = pattern.to_owned();
    if pattern.ends_with('/') && !is_glob(&pattern) {
        let trimmed = pattern.trim_end_matches('/');
        pattern = if trimmed.is_empty() {
            "/".to_owned()
        } else {
            trimmed.to_owned()
        };
    }
    let mut normalized = expand_tilde(&pattern, ctx.home);
    if normalized == pattern && !pattern.starts_with('/') {
        normalized = resolve(ctx.cwd, &pattern);
    }
    normalized = collapse_interior_spellings(&normalized);
    if is_glob(&normalized) {
        let prefix = normalized
            .split(['*', '?', '[', ']'])
            .next()
            .unwrap_or_default();
        if !prefix.is_empty() && prefix != "/" {
            let base = match prefix.strip_suffix('/') {
                Some(base) => base.to_owned(),
                None => dirname(prefix),
            };
            if let Some(resolved) = realpath(&base)
                && !is_symlink_outside_boundary(&base, &resolved)
            {
                // `slice(baseDir.length)`: the base is a prefix of the
                // spelling unless dirname folded something.
                let suffix = normalized.get(base.len()..).unwrap_or_default();
                return format!("{resolved}{suffix}");
            }
        }
        return normalized;
    }
    if !normalized.is_empty() {
        let without_dot = normalized.strip_suffix("/.").unwrap_or(&normalized);
        let trimmed = without_dot.trim_end_matches('/');
        normalized = if trimmed.is_empty() {
            "/".to_owned()
        } else {
            trimmed.to_owned()
        };
    }
    if let Some(resolved) = realpath(&normalized)
        && !is_symlink_outside_boundary(&normalized, &resolved)
    {
        return resolved;
    }
    normalized
}

/// `escapeRegexLiteral`.
pub fn escape_regex_literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `globToRegex`: gitignore-style `*`, `**`, `?` and `[…]`, anchored.
/// Reproduces srt's chain of replacements, placeholders included.
pub fn glob_to_regex(glob: &str) -> String {
    let mut text = String::with_capacity(glob.len() * 2);
    for c in glob.chars() {
        if ".^$+{}()|\\".contains(c) {
            text.push('\\');
        }
        text.push(c);
    }
    // `/\[([^\]]*?)$/g`: the first `[` that nothing after it closes.
    let unclosed = text
        .char_indices()
        .filter(|(_, c)| *c == '[')
        .map(|(at, _)| at)
        .find(|at| !text[at + 1..].contains(']'));
    if let Some(at) = unclosed {
        text.insert(at, '\\');
    }
    let text = text
        .replace("**/", "__GLOBSTAR_SLASH__")
        .replace("**", "__GLOBSTAR__")
        .replace('*', "[^/]*")
        .replace('?', "[^/]")
        .replace("__GLOBSTAR_SLASH__", "(.*/)?")
        .replace("__GLOBSTAR__", ".*");
    format!("^{text}$")
}

/// `denyGlobRegex`: [`glob_to_regex`] plus an optional `/…` tail, so a deny
/// covers everything beneath each match.
pub fn deny_glob_regex(glob: &str) -> String {
    let regex = glob_to_regex(glob);
    format!("{}(/.*)?$", &regex[..regex.len() - 1])
}

/// A compiled JavaScript-style regex test. srt's patterns are `^…$`
/// globs, which `regex-lite` reads alike.
pub fn compile(regex: &str) -> Result<regex_lite::Regex, String> {
    regex_lite::Regex::new(regex).map_err(|error| format!("invalid pattern {regex}: {error}"))
}

/// `SANDBOX_OWN_WRITE_PATHS`.
const SANDBOX_OWN_WRITE_PATHS: [&str; 8] = [
    "/dev/stdout",
    "/dev/stderr",
    "/dev/null",
    "/dev/tty",
    "/dev/dtracehelper",
    "/dev/autofs_nowait",
    "/tmp/claude",
    "/private/tmp/claude",
];

/// `HOME_CONVENIENCE_WRITE_DIRS`.
const HOME_CONVENIENCE_WRITE_DIRS: [&str; 2] = [".npm/_logs", ".claude/debug"];

/// `getDefaultWritePaths({ denyRead, allowRead })`: what the sandbox needs
/// writable itself, and the home convenience directories no `denyRead`
/// entry covers (unless an `allowRead` entry beneath it re-opens them).
pub fn default_write_paths(
    deny_read: &[String],
    allow_read: &[String],
    ctx: Context<'_>,
) -> Vec<String> {
    let kept: Vec<&str> = if deny_read.is_empty() {
        HOME_CONVENIENCE_WRITE_DIRS.to_vec()
    } else {
        home_dirs_not_read_denied(deny_read, allow_read, ctx)
    };
    SANDBOX_OWN_WRITE_PATHS
        .iter()
        .map(|path| (*path).to_owned())
        .chain(kept.iter().map(|rel| join(&[ctx.home, rel])))
        .collect()
}

/// `readRuleCovers`: whether a read rule covers a path.
enum Covers {
    Regex(regex_lite::Regex),
    Under(String),
}

impl Covers {
    fn new(entry: &str, ctx: Context<'_>) -> Self {
        let stripped = remove_trailing_glob_suffix(entry);
        if contains_glob_chars(&stripped)
            && let Ok(regex) = compile(&deny_glob_regex(&normalize_path_for_sandbox(
                &stripped, false, ctx,
            )))
        {
            return Self::Regex(regex);
        }
        Self::Under(normalize_path_for_sandbox(&stripped, true, ctx))
    }

    fn test(&self, path: &str) -> bool {
        match self {
            Self::Regex(regex) => regex.is_match(path),
            Self::Under(rule) => is_at_or_under(path, rule),
        }
    }
}

/// `homeDirsNotReadDenied`.
fn home_dirs_not_read_denied(
    deny_read: &[String],
    allow_read: &[String],
    ctx: Context<'_>,
) -> Vec<&'static str> {
    let mut homes = vec![ctx.home.to_owned()];
    let resolved_home = normalize_path_for_sandbox(ctx.home, true, ctx);
    if !homes.contains(&resolved_home) {
        homes.push(resolved_home);
    }
    let denies: Vec<Covers> = deny_read.iter().map(|e| Covers::new(e, ctx)).collect();
    let reopened: Vec<String> = allow_read
        .iter()
        .map(|entry| remove_trailing_glob_suffix(entry))
        .filter(|entry| !contains_glob_chars(entry))
        .map(|entry| normalize_path_for_sandbox(&entry, true, ctx))
        .collect();
    HOME_CONVENIENCE_WRITE_DIRS
        .iter()
        .copied()
        .filter(|rel| {
            let spellings: Vec<String> = homes.iter().map(|home| join(&[home, rel])).collect();
            !denies.iter().any(|covers| {
                spellings.iter().any(|s| covers.test(s))
                    && !reopened.iter().any(|allow| {
                        covers.test(allow) && spellings.iter().any(|s| is_at_or_under(s, allow))
                    })
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_path_functions() {
        assert_eq!(normalize("/a//b/./c/../d/"), "/a/b/d/");
        assert_eq!(normalize("/.."), "/");
        assert_eq!(normalize("a/../.."), "..");
        assert_eq!(join(&["/a", "**/x"]), "/a/**/x");
        assert_eq!(resolve("/w", ".git/hooks"), "/w/.git/hooks");
        assert_eq!(resolve("/w", "/x/"), "/x");
        assert_eq!(dirname("/a/b/"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("/"), "/");
        assert_eq!(dirname("a"), ".");
        assert_eq!(basename("/a/b/"), "b");
    }

    #[test]
    fn symlink_boundaries() {
        assert!(!is_symlink_outside_boundary("/tmp/x", "/private/tmp/x"));
        assert!(!is_symlink_outside_boundary("/var/f/x", "/private/var/f/x"));
        assert!(is_symlink_outside_boundary("/a/link", "/a"));
        assert!(is_symlink_outside_boundary("/a/link", "/b/c"));
        assert!(is_symlink_outside_boundary("/a/link", "/usr"));
        assert!(!is_symlink_outside_boundary("/a/link", "/a/link/deeper"));
    }

    #[test]
    fn globs_compile_as_in_srt() {
        assert_eq!(glob_to_regex("/a/**/*.key"), "^/a/(.*/)?[^/]*\\.key$");
        assert_eq!(glob_to_regex("/a/[ab]c?"), "^/a/[ab]c[^/]$");
        assert_eq!(glob_to_regex("/a/[x/b**"), "^/a/\\[x/b.*$");
        assert_eq!(deny_glob_regex("/a/*"), "^/a/[^/]*(/.*)?$");
        assert_eq!(escape_regex_literal("/a.b[c]"), "/a\\.b\\[c\\]");
    }

    #[test]
    fn interior_spellings_collapse() {
        assert_eq!(collapse_interior_spellings("/a//./b/././c/."), "/a/b/c/.");
        let ctx = Context {
            cwd: "/nonexistent-cwd",
            home: "/nonexistent-home/",
        };
        assert_eq!(
            normalize_path_for_sandbox("~/x//y/", true, ctx),
            "/nonexistent-home/x/y"
        );
        assert_eq!(
            normalize_path_for_sandbox("rel/./p", false, ctx),
            "/nonexistent-cwd/rel/p"
        );
        assert_eq!(normalize_path_for_sandbox("/", true, ctx), "/");
    }
}
