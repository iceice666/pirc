//! srt's Seatbelt (SBPL) profile for the settings pirc passes on macOS
//! (`srtSettings` in `node/sandbox.ts`: `allowUnixSockets` from the policy,
//! `allowLocalBinding`, `allowPty`, no seccomp), as `SandboxManager`'s
//! `wrapWithSandbox` and `wrapCommandWithSandboxMacOS` build it.
//!
//! Ported from sandbox-runtime 0.0.78 `sandbox/macos-sandbox-utils.js`
//! (with what it uses from `sandbox/sandbox-manager.js`; Apache-2.0, see
//! `crates/pirc-node/NOTICE`). Plain text, so it compiles and is tested
//! everywhere: `tests/sandbox_macos_profiles.rs` compares [`generate`] with
//! profiles recorded from srt (`tests/fixtures/sbpl/record.ts`).
//!
//! Not ported, as pirc never configures them: credential masking (the
//! "library denies" are pirc's [`ProfileInput::extra_read_denies`]
//! instead), `allowAllUnixSockets` (Linux only in pirc), `allowMachLookup`,
//! `enableWeakerNetworkIsolation`, `allowAppleEvents`, unrestricted network
//! or filesystem (pirc always passes both), the JVM proxy agent's jar.
//!
//! Seatbelt is last-match-wins; every comment on rule order below is srt's.

use indexmap::IndexSet;

use super::paths::{
    self, Context, basename, compile, contains_glob_chars, deny_glob_regex, dirname,
    escape_regex_literal, glob_to_regex, is_strictly_under, join, normalize_path_for_sandbox,
    remove_trailing_glob_suffix,
};

/// The profile's fixed part after the log tag: process, Mach, IPC, IOKit,
/// sysctl and device rules (srt's `generateSandboxProfile` prelude, with
/// none of the opt-in Mach services).
const BASE: &str = include_str!("base.sb");

/// `DANGEROUS_FILES`.
const DANGEROUS_FILES: [&str; 9] = [
    ".gitconfig",
    ".gitmodules",
    ".bashrc",
    ".bash_profile",
    ".zshrc",
    ".zprofile",
    ".profile",
    ".ripgreprc",
    ".mcp.json",
];

/// `getDangerousDirectories()`.
const DANGEROUS_DIRECTORIES: [&str; 4] = [".vscode", ".idea", ".claude/commands", ".claude/agents"];

/// `SBPL_STRING_MAX_BYTES`: sandbox-exec refuses longer string literals.
const SBPL_STRING_MAX_BYTES: usize = 900;
/// `MIN_DENY_GROUP_SIZE`.
const MIN_DENY_GROUP_SIZE: usize = 4;

/// What one profile is built from.
#[derive(Clone, Debug)]
pub struct ProfileInput<'a> {
    /// srt's `filesystem.denyRead`.
    pub deny_read: &'a [String],
    /// `filesystem.allowRead`.
    pub allow_read: &'a [String],
    /// `filesystem.allowWrite`.
    pub allow_write: &'a [String],
    /// `filesystem.denyWrite`.
    pub deny_write: &'a [String],
    /// `filesystem.allowGitConfig`.
    pub allow_git_config: bool,
    /// `network.allowUnixSockets`.
    pub allow_unix_sockets: &'a [String],
    /// `network.allowLocalBinding`.
    pub allow_local_binding: bool,
    /// The proxy's loopback port (srt's mux serves HTTP and SOCKS5 on it);
    /// `None`: no network at all.
    pub proxy_port: Option<u16>,
    /// `allowPty`.
    pub allow_pty: bool,
    /// srt's `process.cwd()`: where the mandatory denies are anchored.
    pub cwd: &'a str,
    /// srt's `os.homedir()`.
    pub home: &'a str,
    /// The `(with message …)` tag ([`log_tag`]).
    pub log_tag: &'a str,
    /// Literal read denies besides `deny_read` (srt's library denies). Not
    /// srt's: pirc's resolved spellings ([`super::extra_denies`]).
    pub extra_read_denies: &'a [String],
    /// Literal write denies besides `deny_write`. Not srt's either.
    pub extra_write_denies: &'a [String],
    /// Not srt's: paths kept in place (unlinking and creating them denied,
    /// as for every ancestor of a deny), with their ancestors. The symlinks
    /// a protected path's spelling crosses (`SessionPolicy::linked_denies`,
    /// [`super::extra_denies`]): a deny names where the link leads, so the
    /// link itself must not be replaced.
    pub extra_move_blocks: &'a [String],
    /// Not srt's: an allow (read or write) spelled with glob characters
    /// that names an existing path is that path ([`allow_entry`]).
    pub literal_existing_allows: bool,
}

/// `generateLogTag`: `CMD64_<base64 of the command's first 100
/// characters>_END_` and the session's `_<9 random base36>_SBX` suffix.
pub fn log_tag(command: &str, session_suffix: &str) -> String {
    use base64::Engine as _;
    // `slice(0, 100)` counts UTF-16 units; `Buffer.from` writes UTF-8.
    let units: Vec<u16> = command.encode_utf16().take(100).collect();
    let truncated = String::from_utf16_lossy(&units);
    let encoded = base64::engine::general_purpose::STANDARD.encode(truncated.as_bytes());
    format!("CMD64_{encoded}_END_{session_suffix}")
}

/// srt's `sessionSuffix`: `_` and nine random base-36 characters, `_SBX`.
pub fn session_suffix() -> String {
    const CHARS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let random = crate::util::random_bytes::<9>();
    let text: String = random
        .iter()
        .map(|byte| CHARS[usize::from(*byte) % CHARS.len()] as char)
        .collect();
    format!("_{text}_SBX")
}

/// A normalized rule path: a literal (one file or directory, `subpath`) or
/// a glob (`regex`), whose `anchor`, when the library joined it onto a
/// directory of its own, stays literal.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    glob: bool,
    path: String,
    anchor: Option<String>,
}

/// `escapePath`: `JSON.stringify`.
fn escape(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// `toPathEntry`: a caller's spelling, a glob when it reads as one.
fn to_path_entry(pattern: &str, ctx: Context<'_>) -> Entry {
    let glob = contains_glob_chars(pattern);
    Entry {
        glob,
        path: normalize_path_for_sandbox(pattern, !glob, ctx),
        anchor: None,
    }
}

/// [`to_path_entry`] for an allow; with `literal_existing`, a spelling
/// with glob characters that names an existing path is a literal (srt
/// reads it as a pattern, which no longer matches that path: a workspace
/// named `notes [draft]` would not be writable). Not srt's.
fn allow_entry(pattern: &str, literal_existing: bool, ctx: Context<'_>) -> Entry {
    if literal_existing && contains_glob_chars(pattern) {
        let literal = normalize_path_for_sandbox(pattern, true, ctx);
        if std::fs::symlink_metadata(&literal).is_ok() {
            return Entry {
                glob: false,
                path: literal,
                anchor: None,
            };
        }
    }
    to_path_entry(pattern, ctx)
}

/// `toLiteralPathEntry`: a path the library produced.
fn to_literal_path_entry(path: &str, ctx: Context<'_>) -> Entry {
    Entry {
        glob: false,
        path: normalize_path_for_sandbox(path, true, ctx),
        anchor: None,
    }
}

/// `anchoredGlobEntry`.
fn anchored_glob_entry(anchor: &str, pattern: &str) -> Entry {
    Entry {
        glob: true,
        path: join(&[anchor, pattern]),
        anchor: Some(anchor.to_owned()),
    }
}

/// `anchorRegex`: the anchor escaped, the tail compiled.
fn anchor_regex(entry: &Entry, compile: fn(&str) -> String) -> String {
    match &entry.anchor {
        Some(anchor) => match entry.path.strip_prefix(anchor.as_str()) {
            Some(tail) => format!("^{}{}", escape_regex_literal(anchor), &compile(tail)[1..]),
            None => compile(&entry.path),
        },
        None => compile(&entry.path),
    }
}

fn glob_regex(entry: &Entry) -> String {
    anchor_regex(entry, glob_to_regex)
}

fn deny_glob_entry_regex(entry: &Entry) -> String {
    anchor_regex(entry, deny_glob_regex)
}

/// `pathFilter`.
fn path_filter(entry: &Entry) -> String {
    if entry.glob {
        format!("(regex {})", escape(&glob_regex(entry)))
    } else {
        format!("(subpath {})", escape(&entry.path))
    }
}

/// `denyPathFilter`.
fn deny_path_filter(entry: &Entry) -> String {
    if entry.glob {
        format!("(regex {})", escape(&deny_glob_entry_regex(entry)))
    } else {
        format!("(subpath {})", escape(&entry.path))
    }
}

/// `entrySamplePath`: every glob segment of the tail replaced by `x`.
fn entry_sample_path(entry: &Entry) -> String {
    if !entry.glob {
        return entry.path.clone();
    }
    let anchor = entry.anchor.as_deref().unwrap_or("");
    let tail = entry.path.strip_prefix(anchor).unwrap_or(&entry.path);
    // `/\[[^\]]*\]|[*?]+/g` → `x`.
    let mut out = anchor.to_owned();
    let mut rest = tail;
    while let Some(c) = rest.chars().next() {
        if c == '['
            && let Some(close) = rest[1..].find(']')
        {
            out.push('x');
            rest = &rest[close + 2..];
        } else if c == '*' || c == '?' {
            out.push('x');
            rest = rest.trim_start_matches(['*', '?']);
        } else {
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

/// `carveFilter`: `filter` minus everything `carve_outs` match.
fn carve_filter(filter: String, carve_outs: Vec<String>) -> String {
    let unique: IndexSet<String> = carve_outs.into_iter().collect();
    if unique.is_empty() {
        return filter;
    }
    let nots: Vec<String> = unique
        .iter()
        .map(|carve| format!("(require-not {carve})"))
        .collect();
    format!("(require-all {filter} {})", nots.join(" "))
}

/// `isStrictlyUnder(entry, dir)`.
fn entry_strictly_under(entry: &Entry, dir: &str) -> bool {
    is_strictly_under(&entry_sample_path(entry), dir)
}

/// `globBaseDir`.
fn glob_base_dir(glob: &str) -> String {
    let prefix = glob.split(['*', '?', '[', ']']).next().unwrap_or_default();
    if prefix.is_empty() || prefix == "/" {
        return "/".to_owned();
    }
    match prefix.strip_suffix('/') {
        Some(base) => base.to_owned(),
        None => dirname(prefix),
    }
}

/// `entryBaseDir`.
fn entry_base_dir(entry: &Entry) -> String {
    if !entry.glob {
        return entry.path.clone();
    }
    entry
        .anchor
        .clone()
        .unwrap_or_else(|| glob_base_dir(&entry.path))
}

/// `getAncestorDirectories`: up to, not including, `/`.
fn ancestor_directories(path: &str) -> Vec<String> {
    let mut ancestors = Vec::new();
    let mut current = dirname(path);
    while current != "/" && current != "." {
        ancestors.push(current.clone());
        let parent = dirname(&current);
        if parent == current {
            break;
        }
        current = parent;
    }
    ancestors
}

/// `renderRule`: nothing for no filters (a rule without one matches
/// every path).
fn render_rule(
    action: &str,
    operations: &[&str],
    filters: &IndexSet<String>,
    tag: &str,
) -> Vec<String> {
    if filters.is_empty() {
        return Vec::new();
    }
    let mut lines = vec![format!("({action} {}", operations.join(" "))];
    lines.extend(filters.iter().map(|filter| format!("  {filter}")));
    lines.push(format!("  (with message \"{tag}\"))"));
    lines
}

/// `resolveReadConfig`'s result.
struct ResolvedRead {
    denies: Vec<Entry>,
    allows: Vec<Entry>,
    write_roots: Vec<Entry>,
}

/// `lateReadDenyFilters`: the denies that must follow the allows.
fn late_read_deny_filters(resolved: &ResolvedRead) -> Result<(Vec<String>, bool), String> {
    let mut filters = Vec::new();
    let mut covers_root = false;
    let literal_allow_dirs: Vec<&str> = resolved
        .allows
        .iter()
        .filter(|allow| !allow.glob)
        .map(|allow| allow.path.as_str())
        .collect();
    for deny in &resolved.denies {
        if !deny.glob {
            if literal_allow_dirs
                .iter()
                .any(|dir| entry_strictly_under(deny, dir))
            {
                filters.push(deny_path_filter(deny));
            }
            continue;
        }
        let regex = compile(&deny_glob_entry_regex(deny))?;
        if regex.is_match("/") {
            covers_root = true;
        }
        let carve_outs = resolved
            .allows
            .iter()
            .filter(|allow| regex.is_match(&entry_sample_path(allow)))
            .map(path_filter)
            .collect();
        filters.push(carve_filter(deny_path_filter(deny), carve_outs));
    }
    Ok((filters, covers_root))
}

/// `generateReadDenyUnlinkRules`: read-denied paths inside write roots
/// kept in place (the read section re-allowed unlinking in write roots).
fn read_deny_unlink_rules(resolved: &ResolvedRead, tag: &str) -> Result<Vec<String>, String> {
    let ResolvedRead {
        denies,
        allows,
        write_roots,
    } = resolved;
    if write_roots.is_empty() {
        return Ok(Vec::new());
    }
    let write_root_regexes = write_roots
        .iter()
        .filter(|root| root.glob)
        .map(|root| compile(&glob_regex(root)))
        .collect::<Result<Vec<_>, _>>()?;
    let literal_write_roots: Vec<&str> = write_roots
        .iter()
        .filter(|root| !root.glob)
        .map(|root| root.path.as_str())
        .collect();
    let strictly_below_write_root = |path: &str| {
        literal_write_roots
            .iter()
            .any(|root| is_strictly_under(path, root))
            || write_root_regexes.iter().any(|regex| regex.is_match(path))
    };
    let both = || allows.iter().chain(write_roots.iter());
    let mut filters: IndexSet<String> = IndexSet::new();
    let protect_dirs = |filters: &mut IndexSet<String>, dirs: Vec<String>| {
        for dir in dirs {
            if strictly_below_write_root(&dir) {
                filters.insert(format!("(literal {})", escape(&dir)));
            }
        }
    };
    for deny in denies {
        if deny.glob {
            let base = entry_base_dir(deny);
            let intersects = !write_root_regexes.is_empty()
                || literal_write_roots.iter().any(|root| {
                    base == *root
                        || is_strictly_under(&base, root)
                        || is_strictly_under(root, &base)
                });
            if !intersects {
                continue;
            }
            let regex = compile(&deny_glob_entry_regex(deny))?;
            let carve_outs = both()
                .filter(|entry| regex.is_match(&entry_sample_path(entry)))
                .map(path_filter)
                .collect();
            filters.insert(carve_filter(deny_path_filter(deny), carve_outs));
            if base != "/" {
                let mut dirs = vec![base.clone()];
                dirs.extend(ancestor_directories(&base));
                protect_dirs(&mut filters, dirs);
            }
        } else {
            if !strictly_below_write_root(&deny.path) {
                continue;
            }
            let carve_outs = both()
                .filter(|entry| entry_strictly_under(entry, &deny.path))
                .map(path_filter)
                .collect();
            filters.insert(carve_filter(deny_path_filter(deny), carve_outs));
            protect_dirs(&mut filters, ancestor_directories(&deny.path));
        }
    }
    Ok(render_rule("deny", &["file-write-unlink"], &filters, tag))
}

/// `moveBlockingFilters`: the paths and every ancestor directory, so
/// nothing protected can be moved (or replaced) from under its rule.
fn move_blocking_filters(entries: &[Entry]) -> IndexSet<String> {
    let mut filters = IndexSet::new();
    for entry in entries {
        filters.insert(deny_path_filter(entry));
        let base = entry_base_dir(entry);
        if entry.glob {
            if base == "/" {
                continue;
            }
            filters.insert(format!("(literal {})", escape(&base)));
        }
        for ancestor in ancestor_directories(&base) {
            filters.insert(format!("(literal {})", escape(&ancestor)));
        }
    }
    filters
}

/// `generateReadRules`.
fn read_rules(resolved: &ResolvedRead, tag: &str) -> Result<Vec<String>, String> {
    let mut rules = vec!["(allow file-read*)".to_owned()];
    let denies_root = resolved.denies.iter().any(|deny| deny.path == "/");
    let deny_filters: IndexSet<String> = resolved.denies.iter().map(deny_path_filter).collect();
    rules.extend(render_rule("deny", &["file-read*"], &deny_filters, tag));
    let allow_filters: IndexSet<String> = resolved.allows.iter().map(path_filter).collect();
    rules.extend(render_rule("allow", &["file-read*"], &allow_filters, tag));
    let (late, covers_root) = late_read_deny_filters(resolved)?;
    rules.extend(render_rule(
        "deny",
        &["file-read*"],
        &late.into_iter().collect(),
        tag,
    ));
    if denies_root || covers_root {
        rules.push("(allow file-read* (literal \"/\"))".to_owned());
    }
    if !resolved.denies.is_empty() {
        rules.push("(allow file-read-metadata".to_owned());
        rules.push("  (vnode-type DIRECTORY))".to_owned());
    }
    rules.extend(render_rule(
        "deny",
        &["file-write-unlink", "file-write-create"],
        &move_blocking_filters(&resolved.denies),
        tag,
    ));
    let write_allow: IndexSet<String> = resolved.write_roots.iter().map(path_filter).collect();
    rules.extend(render_rule(
        "allow",
        &["file-write-unlink", "file-write-create"],
        &write_allow,
        tag,
    ));
    Ok(rules)
}

/// `macGetMandatoryDenyEntries`: srt's dangerous files and directories in
/// the cwd and anywhere beneath it, `.git/hooks`, and `.git/config` unless
/// `allowGitConfig`.
fn mandatory_deny_entries(allow_git_config: bool, ctx: Context<'_>) -> Vec<Entry> {
    let cwd = normalize_path_for_sandbox(ctx.cwd, true, ctx);
    let literal = |rel: &str| to_literal_path_entry(&paths::resolve(&cwd, rel), ctx);
    let mut entries = Vec::new();
    for name in DANGEROUS_FILES {
        entries.push(literal(name));
        entries.push(anchored_glob_entry(&cwd, &format!("**/{name}")));
    }
    for name in DANGEROUS_DIRECTORIES {
        entries.push(literal(name));
        entries.push(anchored_glob_entry(&cwd, &format!("**/{name}/**")));
    }
    entries.push(literal(".git/hooks"));
    entries.push(anchored_glob_entry(&cwd, "**/.git/hooks/**"));
    if !allow_git_config {
        entries.push(literal(".git/config"));
        entries.push(anchored_glob_entry(&cwd, "**/.git/config"));
    }
    entries
}

/// The names srt protects in the cwd ([`mandatory_deny_entries`]'s
/// literals), relative to it.
pub fn mandatory_names(allow_git_config: bool) -> Vec<&'static str> {
    let mut names: Vec<&str> = DANGEROUS_FILES.to_vec();
    names.extend(DANGEROUS_DIRECTORIES);
    names.push(".git/hooks");
    if !allow_git_config {
        names.push(".git/config");
    }
    names
}

/// `LiteralDenyGroup`: `<dir>/<name>/<leaf>` paths sharing their leaves.
struct Group {
    dir: String,
    names: Vec<String>,
    leaves: Vec<String>,
}

/// `regexLength`: bytes inside an SBPL string literal.
fn regex_length(fragment: &str) -> usize {
    escape(fragment).len() - 2
}

fn group_regex_prefix(group: &Group) -> String {
    format!("^{}/(", escape_regex_literal(&group.dir))
}

fn group_deny_tail(group: &Group) -> String {
    let leaves: Vec<String> = group
        .leaves
        .iter()
        .map(|l| escape_regex_literal(l))
        .collect();
    format!(")/({})(/.*)?$", leaves.join("|"))
}

/// `groupLiteralDenyPaths`: many same-shaped literal denies as a few
/// regexes (sandbox-exec compiles thousands of path filters slowly).
fn group_literal_deny_paths(entries: Vec<Entry>) -> (Vec<Group>, Vec<Entry>) {
    let mut by_dir: indexmap::IndexMap<String, indexmap::IndexMap<String, IndexSet<String>>> =
        indexmap::IndexMap::new();
    for entry in entries.iter().filter(|entry| !entry.glob) {
        let parent = dirname(&entry.path);
        let dir = dirname(&parent);
        if dir == parent || parent == entry.path || dir == "/" {
            continue;
        }
        by_dir
            .entry(dir)
            .or_default()
            .entry(basename(&parent))
            .or_default()
            .insert(basename(&entry.path));
    }
    let mut grouped: IndexSet<String> = IndexSet::new();
    let mut groups = Vec::new();
    for (dir, names) in by_dir {
        let mut by_signature: indexmap::IndexMap<String, Group> = indexmap::IndexMap::new();
        for (name, leaf_set) in names {
            let mut leaves: Vec<String> = leaf_set.into_iter().collect();
            // JavaScript's default sort: UTF-16 code units (code points
            // outside the BMP may order differently).
            leaves.sort();
            let signature = leaves.join("\0");
            by_signature
                .entry(signature)
                .or_insert_with(|| Group {
                    dir: dir.clone(),
                    names: Vec::new(),
                    leaves,
                })
                .names
                .push(name);
        }
        for (_, mut group) in by_signature {
            let fixed =
                regex_length(&group_regex_prefix(&group)) + regex_length(&group_deny_tail(&group));
            group.names.retain(|name| {
                fixed + regex_length(&escape_regex_literal(name)) <= SBPL_STRING_MAX_BYTES
            });
            if group.names.len() < MIN_DENY_GROUP_SIZE {
                continue;
            }
            for name in &group.names {
                for leaf in &group.leaves {
                    grouped.insert(join(&[&group.dir, name, leaf]));
                }
            }
            groups.push(group);
        }
    }
    let rest = entries
        .into_iter()
        .filter(|entry| !grouped.contains(&entry.path))
        .collect();
    (groups, rest)
}

/// `literalDenyGroupFilters`: the group's deny regexes and the pins of
/// its `<dir>/<name>` directories, chunked under the string limit.
fn literal_deny_group_filters(group: &Group) -> (Vec<String>, Vec<String>) {
    let prefix = group_regex_prefix(group);
    let deny_tail = group_deny_tail(group);
    let fixed = regex_length(&prefix) + regex_length(&deny_tail);
    let mut chunks: Vec<Vec<String>> = Vec::new();
    let mut chunk: Vec<String> = Vec::new();
    let mut chunk_length = 0;
    for name in group.names.iter().map(|name| escape_regex_literal(name)) {
        let name_length = regex_length(&name) + usize::from(!chunk.is_empty());
        if !chunk.is_empty() && fixed + chunk_length + name_length > SBPL_STRING_MAX_BYTES {
            chunks.push(std::mem::take(&mut chunk));
            chunk_length = 0;
        }
        chunk.push(name.clone());
        chunk_length += if chunk.len() == 1 {
            regex_length(&name)
        } else {
            name_length
        };
    }
    chunks.push(chunk);
    let alternations: Vec<String> = chunks.iter().map(|names| names.join("|")).collect();
    (
        alternations
            .iter()
            .map(|names| format!("(regex {})", escape(&format!("{prefix}{names}{deny_tail}"))))
            .collect(),
        alternations
            .iter()
            .map(|names| format!("(regex {})", escape(&format!("{prefix}{names})$"))))
            .collect(),
    )
}

/// `generateWriteRules`.
fn write_rules(
    allow_only: &[String],
    deny_within_allow: &[String],
    extra_denies: &[String],
    input: &ProfileInput<'_>,
    ctx: Context<'_>,
) -> Vec<String> {
    let tag = input.log_tag;
    let mut rules = Vec::new();
    let allow_filters: IndexSet<String> = allow_only
        .iter()
        .map(|pattern| path_filter(&allow_entry(pattern, input.literal_existing_allows, ctx)))
        .collect();
    rules.extend(render_rule("allow", &["file-write*"], &allow_filters, tag));
    let deny_entries: Vec<Entry> = deny_within_allow
        .iter()
        .map(|pattern| to_path_entry(pattern, ctx))
        .chain(
            extra_denies
                .iter()
                .map(|path| to_literal_path_entry(path, ctx)),
        )
        .chain(mandatory_deny_entries(input.allow_git_config, ctx))
        .collect();
    let (groups, ungrouped) = group_literal_deny_paths(deny_entries);
    let group_filters: Vec<(Vec<String>, Vec<String>)> =
        groups.iter().map(literal_deny_group_filters).collect();
    let mut deny_filters: IndexSet<String> = IndexSet::new();
    for (deny, _) in &group_filters {
        deny_filters.extend(deny.iter().cloned());
    }
    deny_filters.extend(ungrouped.iter().map(deny_path_filter));
    rules.extend(render_rule("deny", &["file-write*"], &deny_filters, tag));
    let mut move_filters = move_blocking_filters(&ungrouped);
    for (group, (deny, pins)) in groups.iter().zip(&group_filters) {
        move_filters.extend(deny.iter().chain(pins).cloned());
        let mut dirs = vec![group.dir.clone()];
        dirs.extend(ancestor_directories(&group.dir));
        for dir in dirs {
            move_filters.insert(format!("(literal {})", escape(&dir)));
        }
    }
    for path in input.extra_move_blocks {
        let path = paths::normalize(path);
        move_filters.insert(format!("(literal {})", escape(&path)));
        for ancestor in ancestor_directories(&path) {
            move_filters.insert(format!("(literal {})", escape(&ancestor)));
        }
    }
    rules.extend(render_rule(
        "deny",
        &["file-write-unlink", "file-write-create"],
        &move_filters,
        tag,
    ));
    rules
}

/// The profile (`generateSandboxProfile`, with `SandboxManager`'s
/// preparation of the settings). `Err` where srt would throw: a glob that
/// does not compile as a regex.
pub fn generate(input: &ProfileInput<'_>) -> Result<String, String> {
    let ctx = Context {
        cwd: input.cwd,
        home: input.home,
    };
    let tag = input.log_tag;
    // `wrapWithSandbox`: the default write paths, `/**` stripped (macOS
    // keeps globs).
    let allow_only: Vec<String> =
        paths::default_write_paths(input.deny_read, input.allow_read, ctx)
            .into_iter()
            .chain(
                input
                    .allow_write
                    .iter()
                    .map(|p| remove_trailing_glob_suffix(p)),
            )
            .collect();
    let deny_within_allow: Vec<String> = input
        .deny_write
        .iter()
        .map(|p| remove_trailing_glob_suffix(p))
        .collect();
    let deny_only: Vec<String> = input
        .deny_read
        .iter()
        .map(|p| remove_trailing_glob_suffix(p))
        .collect();
    let allow_within_deny: Vec<String> = input
        .allow_read
        .iter()
        .map(|p| remove_trailing_glob_suffix(p))
        .collect();

    let mut profile: Vec<String> = vec![
        "(version 1)".to_owned(),
        format!("(deny default (with message \"{tag}\"))"),
        String::new(),
        format!("; LogTag: {tag}"),
        String::new(),
    ];
    // BASE ends with the blank line before the network section.
    profile.extend(BASE.trim_end_matches('\n').split('\n').map(str::to_owned));
    profile.push(String::new());

    profile.push("; Network".to_owned());
    if input.allow_local_binding {
        profile.push("(allow network-bind (local ip \"*:*\"))".to_owned());
        profile.push("(allow network-inbound (local ip \"*:*\"))".to_owned());
        profile.push("(allow network-outbound (remote ip \"localhost:*\"))".to_owned());
    }
    if !input.allow_unix_sockets.is_empty() {
        profile.push("(allow system-socket (socket-domain AF_UNIX))".to_owned());
        for socket in input.allow_unix_sockets {
            let path = escape(&normalize_path_for_sandbox(socket, false, ctx));
            profile.push(format!(
                "(allow network-bind (local unix-socket (subpath {path})))"
            ));
            profile.push(format!(
                "(allow network-outbound (remote unix-socket (subpath {path})))"
            ));
        }
    }
    if let Some(port) = input.proxy_port {
        profile.push(format!(
            "(allow network-bind (local ip \"localhost:{port}\"))"
        ));
        profile.push(format!(
            "(allow network-inbound (local ip \"localhost:{port}\"))"
        ));
        profile.push(format!(
            "(allow network-outbound (remote ip \"localhost:{port}\"))"
        ));
    }
    profile.push(String::new());

    let resolved = ResolvedRead {
        denies: deny_only
            .iter()
            .map(|p| to_path_entry(p, ctx))
            .chain(
                input
                    .extra_read_denies
                    .iter()
                    .map(|p| to_literal_path_entry(p, ctx)),
            )
            .collect(),
        allows: allow_within_deny
            .iter()
            .map(|p| allow_entry(p, input.literal_existing_allows, ctx))
            .collect(),
        write_roots: allow_only
            .iter()
            .map(|p| allow_entry(p, input.literal_existing_allows, ctx))
            .collect(),
    };
    profile.push("; File read".to_owned());
    profile.extend(read_rules(&resolved, tag)?);
    profile.push(String::new());

    profile.push("; File write".to_owned());
    profile.extend(write_rules(
        &allow_only,
        &deny_within_allow,
        input.extra_write_denies,
        input,
        ctx,
    ));
    let unlink = read_deny_unlink_rules(&resolved, tag)?;
    if !unlink.is_empty() {
        profile.push(String::new());
        profile.push("; File read: keep read-denied paths inside write roots in place".to_owned());
        profile.extend(unlink);
    }

    if input.allow_pty {
        profile.extend(
            [
                "",
                "; Pseudo-terminal (pty) support",
                "(allow pseudo-tty)",
                "(allow file-ioctl",
                "  (literal \"/dev/ptmx\")",
                "  (regex #\"^/dev/ttys\")",
                ")",
                "(allow file-read* file-write*",
                "  (literal \"/dev/ptmx\")",
                "  (regex #\"^/dev/ttys\")",
                ")",
            ]
            .map(str::to_owned),
        );
    }
    Ok(profile.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_tags_have_srts_shape() {
        let suffix = session_suffix();
        assert!(suffix.starts_with('_') && suffix.ends_with("_SBX") && suffix.len() == 14);
        assert_eq!(log_tag("true", "_abc_SBX"), "CMD64_dHJ1ZQ==_END__abc_SBX");
        let long = "é".repeat(150);
        let tag = log_tag(&long, "_x_SBX");
        assert!(tag.len() < 300, "{tag}");
    }

    #[test]
    fn sample_paths_replace_glob_segments() {
        let entry = Entry {
            glob: true,
            path: "/a[b]/x/[cd]e*?f[g".to_owned(),
            anchor: Some("/a[b]".to_owned()),
        };
        assert_eq!(entry_sample_path(&entry), "/a[b]/x/xexf[g");
    }

    #[test]
    fn literal_deny_groups_need_four_names() {
        let ctx = Context {
            cwd: "/w",
            home: "/h",
        };
        let entries: Vec<Entry> = ["a", "b", "c"]
            .iter()
            .map(|n| to_literal_path_entry(&format!("/nonexistent/p/{n}/.env"), ctx))
            .collect();
        let (groups, rest) = group_literal_deny_paths(entries.clone());
        assert!(groups.is_empty());
        assert_eq!(rest, entries);
    }
}
