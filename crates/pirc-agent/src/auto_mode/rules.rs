//! Static shell-command classifier for auto mode (`auto-mode/rules.ts`).
//! It decides, without a model, whether a command only reads, writes inside
//! the workspace, is dangerous, or cannot be judged statically (`unknown`,
//! handed to the model classifier).
//!
//! The rules err on the side of `unknown`: anything the lexer does not
//! fully understand (command substitution, heredocs, interpreters,
//! unresolvable paths) is never declared `read`.

use std::sync::OnceLock;

use indexmap::IndexMap;
use pirc_policy::{
    BUILD_CREDENTIAL_HOME_PATHS, SENSITIVE_HOME_PATHS, is_inside as inside, real_resolve,
    resolve_path,
};

use crate::tools::js::{self, JsRegex, js_regex};

/// `Verdict`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Read,
    Write,
    Danger,
    Unknown,
}

impl Verdict {
    fn rank(self) -> u8 {
        match self {
            Self::Read => 0,
            Self::Write => 1,
            Self::Unknown => 2,
            Self::Danger => 3,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Danger => "danger",
            Self::Unknown => "unknown",
        }
    }
}

/// `Classification`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classification {
    pub verdict: Verdict,
    pub reason: String,
    /// Danger because of the user's deny-list (holds even with auto mode
    /// disabled).
    pub denied: bool,
    /// With verdict `write`: every path the command writes, when the rules
    /// know all of them; `None` when any write has no known target.
    pub writes: Option<Vec<String>>,
}

/// `RuleContext`.
pub struct RuleContext<'a> {
    /// Directory the command starts in.
    pub cwd: &'a str,
    /// Canonical roots the agent may write (workspace and allowed paths).
    pub roots: &'a [String],
    /// Paths the agent may never write (its own configuration).
    pub protected_paths: &'a [String],
    pub home: Option<&'a str>,
    /// The user's deny-list ([`compile_deny`]).
    pub deny: &'a [JsRegex],
}

fn worst(a: Classification, b: Classification) -> Classification {
    // Two writes: their targets are known only if both are.
    if a.verdict == Verdict::Write && b.verdict == Verdict::Write {
        return match (&a.writes, &b.writes) {
            (Some(first), Some(second)) => {
                let mut all = first.clone();
                all.extend(second.iter().cloned());
                Classification {
                    writes: Some(all),
                    ..a
                }
            }
            (Some(_), None) => b,
            _ => a,
        };
    }
    if b.verdict.rank() > a.verdict.rank() {
        b
    } else {
        a
    }
}

fn classification(verdict: Verdict, reason: impl Into<String>) -> Classification {
    Classification {
        verdict,
        reason: reason.into(),
        denied: false,
        writes: None,
    }
}

fn read(reason: &str) -> Classification {
    classification(Verdict::Read, reason)
}

fn read_only() -> Classification {
    read("read-only command")
}

fn write(reason: impl Into<String>) -> Classification {
    classification(Verdict::Write, reason)
}

fn danger(reason: impl Into<String>) -> Classification {
    classification(Verdict::Danger, reason)
}

fn unknown(reason: impl Into<String>) -> Classification {
    classification(Verdict::Unknown, reason)
}

// ---------------------------------------------------------------------------
// Lexer

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Word {
    text: String,
    quoted: bool,
    /// Contains an unresolved expansion (`$VAR`, globs, braces).
    dynamic: bool,
    /// Starts with an unquoted `~`.
    tilde: bool,
}

impl Word {
    fn plain(text: &str) -> Self {
        Self {
            text: text.to_owned(),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug)]
struct Redirect {
    op: String,
    target: Option<Word>,
}

#[derive(Clone, Debug, Default)]
struct Command {
    words: Vec<Word>,
    redirects: Vec<Redirect>,
}

/// Commands joined by `|`; pipelines are joined by `;`, `&&`, `||`, `&` or
/// newlines.
type Pipeline = Vec<Command>;

enum Lexed {
    Pipelines(Vec<Pipeline>),
    Complex(&'static str),
}

#[derive(Default)]
struct Lexer {
    pipelines: Vec<Pipeline>,
    pipeline: Pipeline,
    command: Command,
    word: Option<Word>,
    pending: Option<String>,
}

impl Lexer {
    fn current(&mut self) -> &mut Word {
        self.word.get_or_insert_with(Word::default)
    }

    fn push_word(&mut self) {
        let Some(word) = self.word.take() else {
            return;
        };
        match self.pending.take() {
            Some(op) => self.command.redirects.push(Redirect {
                op,
                target: Some(word),
            }),
            None => self.command.words.push(word),
        }
    }

    fn end_command(&mut self) {
        self.push_word();
        if let Some(op) = self.pending.take() {
            self.command.redirects.push(Redirect { op, target: None });
        }
        let command = std::mem::take(&mut self.command);
        if !command.words.is_empty() || !command.redirects.is_empty() {
            self.pipeline.push(command);
        }
    }

    fn end_pipeline(&mut self) {
        self.end_command();
        let pipeline = std::mem::take(&mut self.pipeline);
        if !pipeline.is_empty() {
            self.pipelines.push(pipeline);
        }
    }
}

fn lex(source: &str) -> Lexed {
    let chars: Vec<char> = source.chars().collect();
    let mut lexer = Lexer::default();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '\\' {
            if next != Some('\n')
                && let Some(next) = next
            {
                lexer.current().text.push(next);
            }
            if next.is_none() {
                lexer.current();
            }
            i += 2;
            continue;
        }
        if c == '\'' {
            let Some(end) = chars[i + 1..].iter().position(|c| *c == '\'') else {
                return Lexed::Complex("unterminated quote");
            };
            let target = lexer.current();
            target.text.extend(&chars[i + 1..i + 1 + end]);
            target.quoted = true;
            i += end + 2;
            continue;
        }
        if c == '"' {
            let target = lexer.current();
            target.quoted = true;
            let mut j = i + 1;
            while j < chars.len() && chars[j] != '"' {
                let ch = chars[j];
                if ch == '\\' && j + 1 < chars.len() {
                    target.text.push(chars[j + 1]);
                    j += 2;
                    continue;
                }
                if ch == '`' || (ch == '$' && chars.get(j + 1) == Some(&'(')) {
                    return Lexed::Complex("command substitution");
                }
                if ch == '$' {
                    target.dynamic = true;
                }
                target.text.push(ch);
                j += 1;
            }
            if j >= chars.len() {
                return Lexed::Complex("unterminated quote");
            }
            i = j + 1;
            continue;
        }
        if c == '`' || (c == '$' && next == Some('(')) {
            return Lexed::Complex("command substitution");
        }
        if (c == '<' || c == '>') && next == Some('(') {
            return Lexed::Complex("process substitution");
        }
        if c == '#' && lexer.word.is_none() {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if matches!(c, '\n' | ';' | '(' | ')') {
            lexer.end_pipeline();
            i += 1;
            continue;
        }
        if c == '&' {
            if next == Some('&') {
                lexer.end_pipeline();
                i += 2;
                continue;
            }
            if next == Some('>') {
                lexer.push_word();
                let op = if chars.get(i + 2) == Some(&'>') {
                    "&>>"
                } else {
                    "&>"
                };
                lexer.pending = Some(op.to_owned());
                i += op.len();
                continue;
            }
            lexer.end_pipeline();
            i += 1;
            continue;
        }
        if c == '|' {
            if next == Some('|') {
                lexer.end_pipeline();
                i += 2;
                continue;
            }
            lexer.end_command();
            i += if next == Some('&') { 2 } else { 1 };
            continue;
        }
        if c == '>' || c == '<' {
            let mut fd = String::new();
            let numeric = lexer.word.as_ref().is_some_and(|last| {
                !last.quoted
                    && !last.text.is_empty()
                    && last.text.chars().all(|c| c.is_ascii_digit())
            });
            if numeric {
                fd = lexer.word.take().expect("a word").text;
            } else {
                lexer.push_word();
            }
            if c == '<' && next == Some('<') {
                return Lexed::Complex("heredoc");
            }
            let mut op = c.to_string();
            i += 1;
            if c == '>' && matches!(chars.get(i), Some('>' | '|')) {
                op.push(chars[i]);
                i += 1;
            }
            if chars.get(i) == Some(&'&') {
                i += 1;
                let mut dup = String::new();
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '-') {
                    dup.push(chars[i]);
                    i += 1;
                }
                if !dup.is_empty() {
                    // `2>&1`, `>&2`: fd duplication, no file involved.
                    continue;
                }
                op = "&>".to_owned();
            }
            lexer.pending = Some(fd + &op);
            continue;
        }
        if js::is_space(c) {
            lexer.push_word();
            i += 1;
            continue;
        }
        if c == '~' && lexer.word.is_none() {
            lexer.current().tilde = true;
        }
        if matches!(c, '$' | '*' | '?' | '[' | '{') {
            lexer.current().dynamic = true;
        }
        lexer.current().text.push(c);
        i += 1;
    }
    lexer.end_pipeline();
    Lexed::Pipelines(lexer.pipelines)
}

// ---------------------------------------------------------------------------
// Paths

/// `os.tmpdir()`.
fn tmpdir() -> String {
    let dir = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "/tmp".to_owned());
    if dir.len() > 1 && dir.ends_with('/') {
        dir[..dir.len() - 1].to_owned()
    } else {
        dir
    }
}

/// Scratch directories: writes there are ordinary.
fn scratch() -> &'static [String] {
    static SCRATCH: OnceLock<Vec<String>> = OnceLock::new();
    SCRATCH.get_or_init(|| {
        let mut out: Vec<String> = Vec::new();
        for item in ["/tmp", "/private/tmp", "/var/tmp", &tmpdir()] {
            let item = item.to_owned();
            if !out.contains(&item) {
                out.push(item);
            }
        }
        out.iter().map(|item| real_resolve(item)).collect()
    })
}

const HARMLESS: [&str; 4] = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"];

const SECRET_SYSTEM_PATHS: [&str; 3] = ["/etc/shadow", "/etc/sudoers", "/etc/master.passwd"];

fn is_glob_char(c: char) -> bool {
    matches!(c, '$' | '*' | '?' | '[' | '{')
}

struct Paths {
    home: String,
    roots: Vec<String>,
    protected_roots: Vec<String>,
    secrets: Vec<String>,
}

impl Paths {
    fn new(context: &RuleContext<'_>) -> Self {
        let home = context
            .home
            .map(str::to_owned)
            .unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());
        let mut secrets: Vec<String> = Vec::new();
        let home_items = SENSITIVE_HOME_PATHS
            .iter()
            .chain(BUILD_CREDENTIAL_HOME_PATHS.iter())
            .map(|item| real_resolve(&resolve_path(&home, item)));
        let system = SECRET_SYSTEM_PATHS.iter().map(|item| (*item).to_owned());
        let system_real = SECRET_SYSTEM_PATHS.iter().map(|item| real_resolve(item));
        for item in home_items.chain(system).chain(system_real) {
            if !secrets.contains(&item) {
                secrets.push(item);
            }
        }
        Self {
            roots: context
                .roots
                .iter()
                .map(|root| real_resolve(root))
                .collect(),
            protected_roots: context
                .protected_paths
                .iter()
                .map(|item| real_resolve(item))
                .collect(),
            secrets,
            home,
        }
    }

    /// A word's text after the expansions known statically: a leading `~`,
    /// and a leading `$HOME` / `$PWD`. `None` for `~user` and friends.
    fn expand(&self, word: &Word, cwd: Option<&str>) -> Option<String> {
        let mut text = word.text.clone();
        if word.tilde {
            if text == "~" || text.starts_with("~/") {
                text = format!("{}{}", self.home, &text[1..]);
            } else {
                return None;
            }
        }
        if word.dynamic {
            let known = [("${HOME}", "HOME"), ("${PWD}", "PWD")]
                .into_iter()
                .find(|(prefix, _)| text.starts_with(prefix))
                .or_else(|| {
                    [("$HOME", "HOME"), ("$PWD", "PWD")]
                        .into_iter()
                        .find(|(prefix, _)| {
                            text.starts_with(prefix)
                                && !text[prefix.len()..]
                                    .chars()
                                    .next()
                                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
                        })
                });
            if let Some((prefix, name)) = known {
                let value = if name == "HOME" {
                    self.home.clone()
                } else {
                    cwd?.to_owned()
                };
                text = format!("{value}{}", &text[prefix.len()..]);
            }
        }
        Some(text)
    }

    /// Absolute path of a word, or `None` when it cannot be known statically.
    fn resolve(&self, word: &Word, cwd: Option<&str>) -> Option<String> {
        let mut text = self.expand(word, cwd)?;
        if word.dynamic && text.contains(is_glob_char) {
            return None;
        }
        if !text.starts_with('/') {
            text = resolve_path(cwd?, &text);
        }
        Some(real_resolve(&text))
    }

    /// For an operand [`Paths::resolve`] cannot pin down: why its expansion
    /// might reach credentials, or `None` when every expansion stays clear
    /// of them.
    fn unresolved_risk(&self, word: &Word, cwd: Option<&str>) -> Option<String> {
        let Some(text) = self.expand(word, cwd) else {
            return Some(format!("{} cannot be resolved statically", word.text));
        };
        let Some(cut) = text.find(is_glob_char) else {
            return if text.starts_with('/') || cwd.is_some() {
                None
            } else {
                Some(format!("{} is relative to an unknown directory", word.text))
            };
        };
        if text[cut..].contains('$') {
            return Some(format!(
                "{} expands a variable whose value is unknown",
                word.text
            ));
        }
        let literal = &text[..cut];
        let start = literal.rfind('/').map_or(0, |slash| slash + 1);
        let dir = &literal[..start];
        // A glob component may itself match `..`, and `..` after a glob
        // climbs anywhere.
        if text[start..].split('/').any(|part| {
            part == ".." || (part.starts_with('.') && part.contains(['*', '?', '[', '{']))
        }) {
            return Some(format!("{} may climb out of its directory", word.text));
        }
        if !dir.starts_with('/') && cwd.is_none() {
            return Some(format!("{} is relative to an unknown directory", word.text));
        }
        let base = real_resolve(&resolve_path(
            cwd.unwrap_or("/"),
            if dir.is_empty() { "." } else { dir },
        ));
        let stem = format!(
            "{}{}",
            if base.ends_with('/') {
                base.clone()
            } else {
                format!("{base}/")
            },
            &literal[start..]
        );
        self.secrets
            .iter()
            .find(|item| inside(&base, item) || item.starts_with(&stem))
            .map(|secret| format!("{} may expand to credentials at {secret}", word.text))
    }

    fn is_secret(&self, absolute: &str) -> bool {
        self.secrets.iter().any(|secret| inside(absolute, secret))
    }

    /// Why writing/deleting `absolute` is dangerous, or `None` when it is
    /// ordinary workspace work.
    fn write_risk(&self, absolute: &str, destructive: bool) -> Option<String> {
        if HARMLESS.contains(&absolute) {
            return None;
        }
        if self.is_secret(absolute) {
            return Some(format!("modifies credentials at {absolute}"));
        }
        if self
            .protected_roots
            .iter()
            .any(|root| inside(absolute, root))
        {
            return Some(format!(
                "modifies protected agent configuration at {absolute}"
            ));
        }
        // Project agent config at any depth: a nested .pirc/ would be a
        // subagent's project config.
        for root in &self.roots {
            if inside(absolute, root)
                && js::relative(root, absolute)
                    .split('/')
                    .any(|part| part.to_lowercase() == ".pirc")
            {
                return Some(format!("modifies agent configuration at {absolute}"));
            }
        }
        if destructive && self.roots.iter().any(|root| inside(root, absolute)) {
            return Some(format!("deletes an entire workspace root ({absolute})"));
        }
        if destructive
            && self
                .roots
                .iter()
                .any(|root| absolute == js::join(root, ".git"))
        {
            return Some(format!("deletes the repository metadata at {absolute}"));
        }
        if self.roots.iter().any(|root| inside(absolute, root)) {
            return None;
        }
        if scratch()
            .iter()
            .any(|root| inside(absolute, root) && absolute != root)
        {
            return None;
        }
        Some(format!(
            "{} {absolute}, outside the workspace",
            if destructive { "deletes" } else { "modifies" }
        ))
    }
}

// ---------------------------------------------------------------------------
// Command rules

const READ_ONLY: &[&str] = &[
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "ag",
    "fd",
    "stat",
    "file",
    "pwd",
    "echo",
    "printf",
    "which",
    "whereis",
    "type",
    "date",
    "uname",
    "whoami",
    "id",
    "hostname",
    "du",
    "df",
    "tree",
    "uniq",
    "cut",
    "tr",
    "diff",
    "cmp",
    "comm",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "jq",
    "yq",
    "true",
    "false",
    "test",
    "[",
    "nl",
    "column",
    "xxd",
    "hexdump",
    "od",
    "strings",
    "sha1sum",
    "sha256sum",
    "sha512sum",
    "md5sum",
    "md5",
    "shasum",
    "cksum",
    "seq",
    "sleep",
    "ps",
    "pgrep",
    "lsof",
    "uptime",
    "free",
    "nproc",
    "locale",
    "printenv",
    "tac",
    "rev",
    "fold",
    "fmt",
    "expand",
    "unexpand",
    "paste",
    "join",
    "look",
    "bat",
    "eza",
    "exa",
    "tokei",
    "cloc",
    "scc",
    "exit",
    "return",
    ":",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Writer {
    All,
    Last,
    AfterFirst,
}

/// Commands whose file operands are written.
fn path_writer(name: &str) -> Option<Writer> {
    Some(match name {
        "rm" | "rmdir" | "unlink" | "shred" | "touch" | "mkdir" | "tee" | "truncate" | "mv" => {
            Writer::All
        }
        "cp" | "ln" | "install" | "rsync" => Writer::Last,
        "chmod" | "chown" | "chgrp" => Writer::AfterFirst,
        _ => return None,
    })
}

const DESTRUCTIVE: &[&str] = &["rm", "rmdir", "unlink", "shred", "mv"];
const PRIVILEGE: &[&str] = &["sudo", "doas", "su", "pkexec", "runas"];
const SYSTEM_DANGER: &[&str] = &[
    "shutdown", "reboot", "halt", "poweroff", "fdisk", "sfdisk", "parted", "wipefs", "passwd",
    "chsh", "visudo", "useradd", "userdel", "usermod", "groupadd", "groupdel", "iptables", "nft",
    "pfctl", "csrutil", "spctl", "nvram",
];
const SHELLS: &[&str] = &["sh", "bash", "zsh", "fish", "dash", "ksh"];
const OTHER_INTERPRETERS: &[&str] = &[
    "python",
    "python3",
    "node",
    "deno",
    "ruby",
    "perl",
    "php",
    "lua",
    "osascript",
];

fn is_interpreter(name: &str) -> bool {
    SHELLS.contains(&name) || OTHER_INTERPRETERS.contains(&name)
}

/// Wrappers that run the rest of their arguments as a command.
const WRAPPERS: &[&str] = &[
    "command", "builtin", "nohup", "time", "nice", "ionice", "stdbuf",
];
const PACKAGE_MANAGERS: &[&str] = &["npm", "pnpm", "yarn", "bun"];
const BUILD_TOOLS: &[&str] = &[
    "make",
    "cmake",
    "ninja",
    "tsc",
    "prettier",
    "eslint",
    "biome",
    "vitest",
    "jest",
    "pytest",
    "mypy",
    "ruff",
    "black",
    "rustfmt",
    "gofmt",
    "patch",
    "svelte-check",
    "vite",
];

/// Commands whose operands are not file paths.
const NON_PATH_ARGS: &[&str] = &[
    "echo", "printf", "true", "false", "sleep", "seq", "exit", "return", ":", "date", "export",
    "unset", "set", "shopt", "alias", "test", "[", "which", "whereis", "type", "basename",
    "dirname", "printenv",
];

/// Options whose value is a file or directory the tool writes.
fn output_options(name: &str) -> &'static [&'static str] {
    match name {
        "sort" => &["-o", "--output"],
        "find" => &["-fprint", "-fprint0", "-fprintf", "-fls"],
        "wget" => &[
            "-O",
            "--output-document",
            "-P",
            "--directory-prefix",
            "-o",
            "--output-file",
            "-a",
            "--append-output",
        ],
        "curl" => &[
            "-o",
            "--output",
            "--output-dir",
            "-D",
            "--dump-header",
            "-c",
            "--cookie-jar",
            "--trace",
            "--trace-ascii",
            "--stderr",
            "--libcurl",
            "--etag-save",
            "--hsts",
            "--alt-svc",
        ],
        "tsc" => &[
            "--outDir",
            "--outFile",
            "--out",
            "--declarationDir",
            "--tsBuildInfoFile",
        ],
        "eslint" => &["-o", "--output-file", "--cache-location"],
        "prettier" => &["--cache-location"],
        "patch" => &[
            "-o",
            "--output",
            "-d",
            "--directory",
            "-r",
            "--reject-file",
            "-B",
            "--prefix",
        ],
        "vite" => &["--outDir"],
        "go" => &["-o"],
        "cargo" => &["--target-dir", "--out-dir", "--artifact-dir"],
        "bun" => &["--outdir", "--outfile", "--cwd"],
        "npm" => &["--prefix"],
        "pnpm" => &["-C", "--dir", "--prefix"],
        "yarn" => &["--cwd"],
        "make" => &["-C", "--directory"],
        "cmake" => &["-B"],
        "ninja" => &["-C"],
        _ => &[],
    }
}

/// Output-option values, minus `-` (stdout).
fn outputs(args: &[Word], names: &[&str]) -> Vec<Word> {
    option_values(args, names)
        .into_iter()
        .filter(|word| word.text != "-")
        .collect()
}

/// The working directory, for tools that write into it.
fn cwd_word() -> Word {
    Word::plain(".")
}

/// Options taking a separate value, per in-place editor.
fn editor_valued(name: &str) -> &'static [&'static str] {
    match name {
        "prettier" => &[
            "--config",
            "--ignore-path",
            "--plugin",
            "--parser",
            "--log-level",
            "--cache-location",
            "--cache-strategy",
            "--stdin-filepath",
            "--config-precedence",
            "--end-of-line",
            "--trailing-comma",
            "--print-width",
            "--tab-width",
            "--arrow-parens",
            "--prose-wrap",
            "--quote-props",
        ],
        "eslint" => &[
            "-c",
            "--config",
            "--ext",
            "--rulesdir",
            "--resolve-plugins-relative-to",
            "--ignore-path",
            "--ignore-pattern",
            "-f",
            "--format",
            "-o",
            "--output-file",
            "--parser",
            "--parser-options",
            "--plugin",
            "--rule",
            "--env",
            "--global",
            "--max-warnings",
            "--cache-location",
            "--cache-strategy",
            "--fix-type",
        ],
        "biome" => &[
            "--config-path",
            "--max-diagnostics",
            "--reporter",
            "--log-level",
            "--log-kind",
            "--stdin-file-path",
        ],
        "black" => &[
            "-l",
            "--line-length",
            "-t",
            "--target-version",
            "--config",
            "--include",
            "--exclude",
            "--extend-exclude",
            "--force-exclude",
            "--stdin-filename",
            "-W",
            "--workers",
            "--required-version",
        ],
        "ruff" => &[
            "--config",
            "--line-length",
            "--target-version",
            "--select",
            "--ignore",
            "--extend-select",
            "--exclude",
            "--extend-exclude",
            "--stdin-filename",
            "--cache-dir",
        ],
        "rustfmt" => &[
            "--edition",
            "--config-path",
            "--config",
            "--emit",
            "--color",
        ],
        "gofmt" => &["-r"],
        "patch" => &[
            "-i",
            "--input",
            "-o",
            "--output",
            "-d",
            "--directory",
            "-r",
            "--reject-file",
            "-B",
            "--prefix",
            "-D",
            "--ifdef",
            "-F",
            "--fuzz",
            "-p",
            "--strip",
            "-V",
            "--version-control",
            "-z",
            "--suffix",
            "-Y",
            "--basename-prefix",
        ],
        _ => &[],
    }
}

/// Files a formatter or `patch` rewrites in place, or `None` when this
/// invocation edits nothing.
fn in_place_targets(name: &str, args: &[Word]) -> Option<Vec<Word>> {
    let files = |skip: usize| -> Vec<Word> {
        operands_skipping(args, editor_valued(name))
            .into_iter()
            .skip(skip)
            .collect()
    };
    let checking = has_flag(args, &["--check", "--diff"]);
    match name {
        "prettier" => has_flag(args, &["--write", "-w"]).then(|| files(0)),
        "eslint" => has_flag(args, &["--fix"]).then(|| files(0)),
        "biome" => {
            has_flag(args, &["--write", "--apply", "--apply-unsafe", "--fix"]).then(|| files(1))
        }
        "black" | "rustfmt" => (!checking).then(|| files(0)),
        "ruff" => {
            let sub = files(0).first().map(|word| word.text.clone());
            ((sub.as_deref() == Some("format") && !checking) || has_flag(args, &["--fix"]))
                .then(|| files(1))
        }
        "gofmt" => has_short(args, "w").then(|| files(0)),
        // `patch [file [patchfile]]`: the first operand is rewritten.
        "patch" => Some(files(0).into_iter().take(1).collect()),
        _ => None,
    }
}

/// `sed`: files edited with `-i`, and scripts that run commands or read or
/// write other files.
fn classify_sed(args: &[Word], state: &State<'_>) -> Classification {
    let valued = ["-e", "--expression", "-f", "--file", "-l", "--line-length"];
    let mut scripts = option_values(args, &["-e", "--expression"]);
    if !option_values(args, &["-f", "--file"]).is_empty() {
        return unknown("sed runs a script file that cannot be inspected");
    }
    let in_place = has_flag(args, &["--in-place"])
        || args
            .iter()
            .any(|word| js_regex!("^-[a-zA-Z]*i").test(&word.text));
    // BSD `sed -i '' …`: the empty word is the backup suffix.
    let words: Vec<Word> = args
        .iter()
        .enumerate()
        .filter(|(i, word)| !(word.text.is_empty() && *i > 0 && args[i - 1].text == "-i"))
        .map(|(_, word)| word.clone())
        .collect();
    let mut files = operands_skipping(&words, &valued);
    if scripts.is_empty() && !files.is_empty() {
        scripts.push(files.remove(0));
    }
    for script in &scripts {
        if script.dynamic {
            return unknown("sed script contains an expansion");
        }
        let subst = js_regex!(
            r"s([^\\\n])(?:\\.|(?!\1)[^\n])*\1(?:\\.|(?!\1)[^\n])*\1([^;\n}]*)",
            "g"
        );
        let flags: Vec<&str> = subst
            .find_iter(&script.text)
            .map(|found| found.group(2).map_or("", |range| &script.text[range]))
            .collect();
        let rest = js_regex!(r"\/(?:\\.|[^/\n])*\/", "g")
            .replace_all(&subst.replace_all(&script.text, ";"), "");
        if flags.iter().any(|flag| flag.contains(['e', 'w']))
            || js_regex!(r"(^|[;{}!$\s\d,])[eEwWrR](\s|$|;)").test(&rest)
        {
            return unknown("sed script runs commands or reads or writes other files");
        }
    }
    if !in_place {
        return read("sed");
    }
    worst(
        write("sed -i edits files in place"),
        check_writes(&files, state, false, "sed -i edits"),
    )
}

fn has_flag(words: &[Word], names: &[&str]) -> bool {
    words.iter().any(|word| {
        names.contains(&word.text.as_str())
            || names.iter().any(|name| {
                word.text
                    .strip_prefix(name)
                    .is_some_and(|rest| rest.starts_with('='))
            })
    })
}

/// A short-option cluster (`-rf`) containing any of `letters`.
fn has_short(words: &[Word], letters: &str) -> bool {
    words.iter().any(|word| {
        let text = &word.text;
        text.len() > 1
            && text.starts_with('-')
            && text[1..].chars().all(|c| c.is_ascii_alphabetic())
            && letters.chars().any(|letter| text.contains(letter))
    })
}

/// Operands (non-option words), honouring `--`.
fn operands(words: &[Word]) -> Vec<Word> {
    operands_skipping(words, &[])
}

/// Like [`operands`], also skipping the separate value of each option in
/// `valued`.
fn operands_skipping(words: &[Word], valued: &[&str]) -> Vec<Word> {
    let mut out = Vec::new();
    let mut options = true;
    let mut i = 0;
    while i < words.len() {
        let word = &words[i];
        if options && word.text == "--" {
            options = false;
            i += 1;
            continue;
        }
        if options && word.text.starts_with('-') && word.text != "-" {
            if valued.contains(&word.text.as_str()) {
                i += 1;
            }
            i += 1;
            continue;
        }
        out.push(word.clone());
        i += 1;
    }
    out
}

/// A word made from part of another (`--out=FILE`, `of=FILE`).
fn derived(word: &Word, text: &str) -> Word {
    Word {
        text: text.to_owned(),
        quoted: word.quoted,
        dynamic: word.dynamic,
        tilde: text.starts_with('~'),
    }
}

/// Values of the options in `names`: `--out V`, `--out=V`, `-o V`, `-oV`
/// and clustered short flags (`-sSLo V`).
fn option_values(args: &[Word], names: &[&str]) -> Vec<Word> {
    let is_short = |name: &str| {
        let bytes = name.as_bytes();
        bytes.len() == 2 && bytes[0] == b'-' && bytes[1].is_ascii_alphanumeric()
    };
    let shorts: Vec<char> = names
        .iter()
        .filter(|name| is_short(name))
        .map(|name| name.chars().nth(1).expect("a short option"))
        .collect();
    let longs: Vec<&str> = names
        .iter()
        .filter(|name| !is_short(name))
        .copied()
        .collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let word = &args[i];
        let text = &word.text;
        if text == "--" {
            break;
        }
        let long = longs.iter().find(|name| {
            text == *name
                || text
                    .strip_prefix(**name)
                    .is_some_and(|rest| rest.starts_with('='))
        });
        if let Some(long) = long {
            if text != long {
                out.push(derived(word, &text[long.len() + 1..]));
            } else if i + 1 < args.len() {
                i += 1;
                out.push(args[i].clone());
            }
            i += 1;
            continue;
        }
        let chars: Vec<char> = text.chars().collect();
        if shorts.is_empty()
            || chars.first() != Some(&'-')
            || !chars.get(1).is_some_and(|c| c.is_ascii_alphanumeric())
        {
            i += 1;
            continue;
        }
        for j in 1..chars.len() {
            if shorts.contains(&chars[j]) {
                let rest: String = chars[j + 1..].iter().collect();
                if !rest.is_empty() {
                    out.push(derived(word, &rest));
                } else if i + 1 < args.len() {
                    i += 1;
                    out.push(args[i].clone());
                }
                break;
            }
            if !chars[j].is_ascii_alphanumeric() {
                break;
            }
        }
        i += 1;
    }
    out
}

/// Variables that change which program runs or what it loads.
const RISKY_VARIABLES: &[&str] = &[
    "PATH",
    "HOME",
    "PWD",
    "CDPATH",
    "IFS",
    "ENV",
    "BASH_ENV",
    "PROMPT_COMMAND",
    "SHELLOPTS",
    "BASHOPTS",
    "PS4",
    "ZDOTDIR",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONHOME",
    "PERL5OPT",
    "PERL5LIB",
    "RUBYOPT",
    "RUBYLIB",
    "PAGER",
    "MANPAGER",
    "EDITOR",
    "VISUAL",
    "BROWSER",
    "LESSOPEN",
    "LESSCLOSE",
    "SSH_ASKPASS",
    "SUDO_ASKPASS",
];
const RISKY_PREFIXES: &[&str] = &["LD_", "DYLD_", "GIT_", "BASH_FUNC_", "NPM_CONFIG_"];

/// `ASSIGNMENT`: `NAME=`, `NAME+=`, `NAME[i]=`; the name.
fn assignment(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let first = *bytes.first()?;
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return None;
    }
    let mut end = 1;
    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
        end += 1;
    }
    let mut i = end;
    if bytes.get(i) == Some(&b'[') {
        i += 1 + bytes[i + 1..].iter().position(|b| *b == b']')? + 1;
    }
    if bytes.get(i) == Some(&b'+') {
        i += 1;
    }
    (bytes.get(i) == Some(&b'=')).then(|| &text[..end])
}

fn risky_assignment(text: &str) -> Option<String> {
    let name = assignment(text)?;
    let upper = name.to_ascii_uppercase();
    (RISKY_VARIABLES.contains(&upper.as_str())
        || upper.ends_with("_PROXY")
        || RISKY_PREFIXES
            .iter()
            .any(|prefix| upper.starts_with(prefix)))
    .then(|| name.to_owned())
}

/// `git -c` keys that cannot run programs.
const SAFE_GIT_CONFIG: &[&str] = &[
    "user.name",
    "user.email",
    "core.quotepath",
    "core.abbrev",
    "core.autocrlf",
    "core.safecrlf",
    "core.eol",
    "core.filemode",
    "core.ignorecase",
    "init.defaultbranch",
    "column.ui",
    "diff.renames",
    "diff.noprefix",
    "diff.mnemonicprefix",
    "diff.algorithm",
    "diff.colormoved",
    "merge.conflictstyle",
    "pull.rebase",
    "pull.ff",
    "push.default",
    "push.autosetupremote",
    "commit.gpgsign",
    "tag.gpgsign",
    "log.date",
    "log.decorate",
    "log.showsignature",
    "format.pretty",
    "status.short",
    "status.branch",
    "rebase.autosquash",
    "rebase.autostash",
    "fetch.prune",
    "branch.sort",
    "tag.sort",
];

fn safe_git_config(entry: &str) -> bool {
    let (key, value) = match entry.find('=') {
        Some(eq) => (&entry[..eq], &entry[eq + 1..]),
        None => (entry, "true"),
    };
    let key = key.to_lowercase();
    if SAFE_GIT_CONFIG.contains(&key.as_str())
        || key.starts_with("color.")
        || key.starts_with("advice.")
    {
        return true;
    }
    if key == "core.fsmonitor" {
        return ["false", "no", "off", "0"]
            .iter()
            .any(|off| value.eq_ignore_ascii_case(off));
    }
    if key == "core.pager" {
        return value == "cat" || value == "less" || value.is_empty();
    }
    false
}

#[derive(Clone)]
struct State<'a> {
    cwd: Option<String>,
    paths: &'a Paths,
    deny: &'a [JsRegex],
}

fn check_writes(
    targets: &[Word],
    state: &State<'_>,
    destructive: bool,
    what: &str,
) -> Classification {
    let mut writes = Vec::new();
    for target in targets {
        if HARMLESS.contains(&target.text.as_str()) {
            continue;
        }
        let Some(absolute) = state.paths.resolve(target, state.cwd.as_deref()) else {
            return unknown(format!("{what} a path that cannot be resolved statically"));
        };
        if let Some(risk) = state.paths.write_risk(&absolute, destructive) {
            return danger(risk);
        }
        writes.push(absolute);
    }
    if writes.is_empty() {
        read_only()
    } else {
        Classification {
            writes: Some(writes),
            ..write(format!("{what} files in the workspace"))
        }
    }
}

fn classify_git(args: &[Word], state: &State<'_>) -> Classification {
    let mut i = 0;
    let mut cwd = state.cwd.clone();
    while i < args.len() && args[i].text.starts_with('-') {
        let flag = args[i].text.as_str();
        if flag == "-C" {
            cwd = args
                .get(i + 1)
                .and_then(|target| state.paths.resolve(target, cwd.as_deref()));
            i += 2;
        } else if flag == "-c" {
            // Config such as core.fsmonitor or credential.helper runs programs.
            let entry = args.get(i + 1);
            match entry {
                Some(entry) if !entry.dynamic && safe_git_config(&entry.text) => {}
                _ => {
                    let text = entry.map_or("", |entry| entry.text.as_str());
                    return unknown(
                        js::trim(&format!("git -c {text} may make git run another program"))
                            .to_owned(),
                    );
                }
            }
            i += 2;
        } else if flag.starts_with("--config-env") || flag.starts_with("--exec-path=") {
            return unknown(format!("git {flag} may make git run another program"));
        } else if flag.starts_with("--git-dir") || flag.starts_with("--work-tree") {
            return unknown("git with an explicit git dir or work tree");
        } else {
            i += 1;
        }
    }
    let sub = args.get(i).map(|word| word.text.as_str());
    let rest = if i < args.len() { &args[i + 1..] } else { &[] };
    let Some(cwd) = cwd else {
        return unknown("git in a directory that cannot be resolved statically");
    };
    let here = State {
        cwd: Some(cwd.clone()),
        ..state.clone()
    };
    let mut inner = classify_git_subcommand(sub, rest);
    // `git log/diff/show --output=FILE` writes a file.
    let written = option_values(rest, &["--output"]);
    let shown_sub = sub.unwrap_or("undefined");
    if !written.is_empty() && sub != Some("format-patch") {
        inner = worst(
            inner,
            check_writes(&written, &here, false, &format!("git {shown_sub} writes")),
        );
    }
    if sub == Some("format-patch") {
        inner = worst(
            inner,
            check_writes(
                &option_values(rest, &["-o", "--output-directory"]),
                &here,
                false,
                "git format-patch writes",
            ),
        );
    }
    // Repository outside the workspace (or protected): reads are fine,
    // writes are not.
    if let Some(risk) = state.paths.write_risk(&cwd, false)
        && inner.verdict != Verdict::Read
    {
        let what = js::trim(&format!("git {}", sub.unwrap_or(""))).to_owned();
        return danger(format!("{what} in {cwd}: {risk}"));
    }
    inner
}

/// Built-in git subcommands that change local state without running other
/// programs.
const GIT_WRITERS: &[&str] = &[
    "add",
    "stage",
    "commit",
    "fetch",
    "pull",
    "merge",
    "rebase",
    "cherry-pick",
    "revert",
    "mv",
    "rm",
    "init",
    "clone",
    "apply",
    "am",
    "worktree",
    "notes",
    "format-patch",
    "archive",
    "bundle",
    "sparse-checkout",
    "maintenance",
    "fsck",
    "repack",
    "pack-refs",
    "rerere",
    "submodule",
    "bisect",
    "replace",
    "symbolic-ref",
    "update-index",
    "read-tree",
    "write-tree",
    "commit-tree",
    "hash-object",
    "mktree",
    "mktag",
    "cherry",
    "request-pull",
    "lfs",
    "commit-graph",
    "multi-pack-index",
    "restore",
];

/// Classify a git subcommand on its own, independently of the repository
/// location.
fn classify_git_subcommand(sub: Option<&str>, rest: &[Word]) -> Classification {
    let words: Vec<&str> = rest.iter().map(|word| word.text.as_str()).collect();
    let s = sub.unwrap_or("");
    let shown = sub.unwrap_or("undefined");
    // Options and subcommands that name a program for git to run.
    let runs = rest.iter().find(|word| {
        let text = word.text.as_str();
        js_regex!("^--(upload-pack|receive-pack|exec|extcmd|open-files-in-pager|tool)(=|$)")
            .test(text)
            || (text.starts_with("-u")
                && ["ls-remote", "fetch", "clone", "pull", "archive"].contains(&s))
            || (js_regex!("^-[A-Za-z]*x").test(text) && ["rebase", "difftool"].contains(&s))
            || (text.starts_with("-O") && s == "grep")
    });
    if let Some(runs) = runs {
        return unknown(format!(
            "git {shown} {} may make git run another program",
            runs.text
        ));
    }
    if s == "mergetool"
        || s == "difftool"
        || s == "credential"
        || (s == "submodule" && words.contains(&"foreach"))
        || (s == "bisect" && words.first() == Some(&"run"))
    {
        return unknown(format!("git {shown} runs other programs"));
    }
    let first = words.first().copied();
    match sub {
        None
        | Some(
            "status" | "log" | "diff" | "show" | "blame" | "annotate" | "rev-parse" | "ls-files"
            | "ls-tree" | "ls-remote" | "cat-file" | "describe" | "shortlog" | "grep"
            | "merge-base" | "whatchanged" | "name-rev" | "rev-list" | "count-objects"
            | "check-ignore" | "check-attr" | "var" | "help" | "version" | "range-diff"
            | "for-each-ref" | "show-ref" | "verify-commit" | "verify-tag",
        ) => read(js::trim(&format!("git {s}"))),
        Some("branch") => {
            if has_flag(rest, &["-D"])
                || (has_flag(rest, &["-d", "--delete"]) && has_flag(rest, &["-f", "--force"]))
            {
                return danger("force-deletes a git branch, possibly losing unmerged commits");
            }
            let listing = rest.iter().all(|word| {
                js_regex!(
                    "^(-a|-r|-v|-vv|--all|--remotes|--list|-l|--show-current|--contains|--no-contains|--merged|--no-merged|--sort=.*|--format=.*|--points-at|--color.*|--no-color|--column.*)$"
                )
                .test(&word.text)
            });
            if listing {
                read("git branch listing")
            } else {
                write("git branch")
            }
        }
        Some("tag") => {
            if rest.is_empty()
                || has_flag(rest, &["-l", "--list", "-n", "--contains", "--points-at"])
            {
                read("git tag listing")
            } else {
                write("git tag")
            }
        }
        Some("remote") => {
            if rest.is_empty()
                || ["-v", "show", "get-url", "--verbose"].contains(&first.unwrap_or(""))
            {
                read("git remote listing")
            } else {
                write("git remote")
            }
        }
        Some("config") => {
            let lookups = ["--get", "--get-all", "--get-regexp", "--list", "-l"];
            if has_flag(rest, &["--global", "--system"]) {
                return if has_flag(rest, &lookups) {
                    read("git config lookup")
                } else {
                    danger("changes global git configuration")
                };
            }
            let ops = operands(rest);
            if has_flag(rest, &lookups)
                || ops.len() == 1
                || ["get", "list"].contains(&ops.first().map_or("", |w| w.text.as_str()))
            {
                return read("git config lookup");
            }
            // Aliases, hooks, pagers, filters and helpers run programs.
            let key = ops.iter().find(|word| word.text.contains('.'));
            if has_flag(rest, &["--unset", "--unset-all", "--remove-section"])
                || first == Some("unset")
            {
                return write("git config");
            }
            match key {
                Some(key) if !key.dynamic && safe_git_config(&key.text) => write("git config"),
                _ => {
                    let text = key.map_or("", |key| key.text.as_str());
                    unknown(
                        js::trim(&format!(
                            "git config {text} may make git run another program"
                        ))
                        .to_owned(),
                    )
                }
            }
        }
        Some("stash") => match first {
            Some("list" | "show") => read("git stash listing"),
            Some("drop" | "clear") => danger("permanently discards stashed changes"),
            _ => write("git stash"),
        },
        Some("reflog") => {
            if words.is_empty() || first == Some("show") {
                read("git reflog")
            } else {
                danger("rewrites the reflog, removing recovery points")
            }
        }
        Some("push") => {
            if has_flag(
                rest,
                &[
                    "--force",
                    "-f",
                    "--force-with-lease",
                    "--mirror",
                    "--delete",
                    "-d",
                    "--prune",
                ],
            ) || has_short(rest, "fd")
                || operands(rest)
                    .iter()
                    .any(|word| word.text.starts_with('+') || word.text.starts_with(':'))
            {
                danger("force-pushes or deletes remote refs, rewriting shared history")
            } else {
                write("git push")
            }
        }
        Some("reset") => {
            if has_flag(rest, &["--hard", "--merge", "--keep"]) {
                danger("git reset --hard discards uncommitted work")
            } else {
                write("git reset")
            }
        }
        Some("clean") => {
            if has_flag(rest, &["-n", "--dry-run"])
                || (has_short(rest, "n") && !has_short(rest, "f"))
            {
                read("git clean dry run")
            } else {
                danger("git clean permanently deletes untracked files")
            }
        }
        Some("checkout") => {
            if has_flag(rest, &["-f", "--force"]) || words.contains(&"--") || words.contains(&".") {
                danger("git checkout over paths discards uncommitted changes")
            } else {
                write("git checkout")
            }
        }
        Some("restore") => {
            if !has_flag(rest, &["--staged", "-S"]) || has_flag(rest, &["--worktree", "-W"]) {
                danger("git restore discards uncommitted changes")
            } else {
                write("git restore --staged")
            }
        }
        Some("switch") => {
            if has_flag(rest, &["--discard-changes", "-f", "--force"]) {
                danger("git switch --discard-changes discards uncommitted work")
            } else {
                write("git switch")
            }
        }
        Some("filter-branch" | "filter-repo") => danger("rewrites the entire repository history"),
        Some("update-ref") => {
            if has_flag(rest, &["-d"]) {
                danger("deletes a git ref")
            } else {
                write("git update-ref")
            }
        }
        Some("gc" | "prune") => {
            if has_flag(rest, &["--prune", "--aggressive"]) || s == "prune" {
                danger("prunes unreachable objects, removing recovery points")
            } else {
                write("git gc")
            }
        }
        Some(other) => {
            if GIT_WRITERS.contains(&other) {
                write(format!("git {other}"))
            } else {
                unknown(format!(
                    "git {other} may be an alias or extension that runs other programs"
                ))
            }
        }
    }
}

fn classify_package_manager(name: &str, args: &[Word]) -> Classification {
    let ops = operands(args);
    let sub = ops.first().map(|word| word.text.as_str());
    let s = sub.unwrap_or("");
    if [
        "publish",
        "unpublish",
        "deprecate",
        "dist-tag",
        "owner",
        "access",
        "token",
        "login",
        "adduser",
    ]
    .contains(&s)
    {
        return danger(format!(
            "{name} {s} changes a package registry or credentials"
        ));
    }
    if name == "bun" && js_regex!(r"\.[cm]?[jt]sx?$").test(s) && sub.is_some() {
        return unknown("runs a script");
    }
    if name == "bun" && has_flag(args, &["-e", "--eval", "-p", "--print"]) {
        return unknown("evaluates inline code");
    }
    if ["x", "dlx", "exec", "create"].contains(&s) {
        return unknown(format!("{name} {s} runs an arbitrary package"));
    }
    if [
        "ls",
        "list",
        "outdated",
        "view",
        "info",
        "why",
        "audit",
        "config",
        "pm",
        "help",
        "--version",
        "-v",
    ]
    .contains(&s)
    {
        let second = ops.get(1).map(|word| word.text.as_str());
        if (s == "config" && second != Some("get") && second != Some("list"))
            || (s == "pm" && second != Some("ls"))
        {
            return write(format!("{name} {s}"));
        }
        return read(&format!("{name} {s}"));
    }
    if has_flag(args, &["-g", "--global"]) {
        return danger(format!("{name} changes global packages"));
    }
    write(js::trim(&format!("{name} {s}")).to_owned())
}

fn classify_command(command: &Command, state: &mut State<'_>) -> Classification {
    let mut words: Vec<Word> = command.words.clone();
    let mut result = read_only();
    // Leading environment assignments; `PATH=./bin cat x` runs another `cat`.
    let assign = |text: &str, result: &mut Classification| {
        if let Some(risky) = risky_assignment(text) {
            *result = worst(
                result.clone(),
                unknown(format!(
                    "sets {risky}, which changes what programs run or load"
                )),
            );
        }
    };
    while words
        .first()
        .is_some_and(|word| assignment(&word.text).is_some())
    {
        let word = words.remove(0);
        assign(&word.text, &mut result);
    }
    // `env [-i] [NAME=value…] cmd`, `timeout 10 cmd`, `nohup cmd`, …
    loop {
        let head = words.first().map(|word| word.text.clone());
        match head.as_deref() {
            Some("env") => {
                words.remove(0);
                while let Some(first) = words.first() {
                    let text = first.text.clone();
                    if assignment(&text).is_some() {
                        assign(&text, &mut result);
                    } else if text == "-u" || text == "--unset" {
                        words.remove(0);
                    } else if !js_regex!("^(-i|-0|--ignore-environment|--null|-|--unset=.*|-u.+)$")
                        .test(&text)
                    {
                        if text.starts_with('-') {
                            result = worst(
                                result,
                                unknown(format!("env {text} changes how the command runs")),
                            );
                        }
                        break;
                    }
                    if !words.is_empty() {
                        words.remove(0);
                    }
                }
            }
            Some("timeout") => {
                words.remove(0);
                while words.first().is_some_and(|word| word.text.starts_with('-')) {
                    words.remove(0);
                }
                if !words.is_empty() {
                    words.remove(0);
                }
            }
            Some(head) if WRAPPERS.contains(&head) => {
                words.remove(0);
                while words.first().is_some_and(|word| word.text.starts_with('-')) {
                    words.remove(0);
                }
            }
            _ => break,
        }
    }

    for redirect in &command.redirects {
        if redirect.op.contains('<') {
            let Some(target) = &redirect.target else {
                continue;
            };
            let source = state.paths.resolve(target, state.cwd.as_deref());
            if let Some(source) = &source
                && state.paths.is_secret(source)
            {
                return danger(format!("reads credentials at {source}"));
            }
            if source.is_none()
                && let Some(risk) = state.paths.unresolved_risk(target, state.cwd.as_deref())
            {
                result = worst(result, unknown(format!("reads {risk}")));
            }
            continue;
        }
        let Some(target) = &redirect.target else {
            return unknown("redirection without a target");
        };
        result = worst(
            result,
            check_writes(
                std::slice::from_ref(target),
                state,
                false,
                "redirects output to",
            ),
        );
    }

    let Some(head) = words.first().cloned() else {
        return result;
    };
    if head.dynamic {
        return worst(result, unknown("command name is an expansion"));
    }
    let name = js::basename(&head.text).to_owned();
    let name = name.as_str();
    let args: Vec<Word> = words[1..].to_vec();
    let args = args.as_slice();

    // Credentials are dangerous to read too: the output lands in the
    // model's context. An operand whose expansion cannot be known might be
    // one.
    for word in args {
        let absolute = state.paths.resolve(word, state.cwd.as_deref());
        if let Some(absolute) = &absolute
            && state.paths.is_secret(absolute)
        {
            return danger(format!("touches credentials at {absolute}"));
        }
        if absolute.is_none()
            && !NON_PATH_ARGS.contains(&name)
            && let Some(risk) = state.paths.unresolved_risk(word, state.cwd.as_deref())
        {
            result = worst(result, unknown(risk));
        }
    }

    match deny_scripts(&head, args, state) {
        Some(scripts) if scripts.verdict == Verdict::Danger => return scripts,
        Some(scripts) => result = worst(result, scripts),
        None => {}
    }

    if PRIVILEGE.contains(&name) {
        return danger(format!("{name} escalates privileges"));
    }
    if SYSTEM_DANGER.contains(&name) || name.starts_with("mkfs") {
        return danger(format!("{name} changes system configuration or storage"));
    }

    if name == "cd" || name == "pushd" {
        state.cwd = match args.first() {
            None => Some(state.paths.home.clone()),
            Some(target) if target.text == "-" => None,
            Some(target) => state.paths.resolve(target, state.cwd.as_deref()),
        };
        return result;
    }
    if name == "popd" {
        state.cwd = None;
        return result;
    }
    if name == "export" {
        if let Some(risky) = args.iter().find_map(|word| risky_assignment(&word.text)) {
            return worst(
                result,
                unknown(format!(
                    "sets {risky}, which changes what programs run or load"
                )),
            );
        }
        return if has_flag(args, &["-f", "-n"]) {
            worst(result, unknown("export -f/-n changes shell functions"))
        } else {
            result
        };
    }
    if name == "unset" {
        return result;
    }
    if name == "set" {
        // `set -euo pipefail` and friends; anything else is unclear.
        let mut i = 0;
        while i < args.len() {
            let text = &args[i].text;
            if js_regex!("^[-+][euxvETCfnah]+$").test(text) {
                i += 1;
                continue;
            }
            if js_regex!("^[-+][euxvETCfnah]*o$").test(text)
                && js_regex!(
                    "^(errexit|nounset|pipefail|xtrace|verbose|noclobber|noglob|errtrace|functrace|posix)$"
                )
                .test(args.get(i + 1).map_or("", |word| word.text.as_str()))
            {
                i += 2;
                continue;
            }
            break;
        }
        return if i == args.len() {
            result
        } else {
            worst(result, unknown("set changes shell state"))
        };
    }
    if name == "shopt" {
        return if args.iter().any(|word| word.text == "expand_aliases") {
            worst(
                result,
                unknown(
                    "enables alias expansion, so later commands may not be what they look like",
                ),
            )
        } else {
            result
        };
    }
    if name == "alias" {
        return if args.iter().any(|word| word.text.contains('=')) {
            worst(
                result,
                unknown("defines an alias, so later commands may not be what they look like"),
            )
        } else {
            result
        };
    }
    if name == "printf" {
        // `printf -v PATH …` assigns a variable.
        if let Some(target) = option_values(args, &["-v"]).first()
            && (target.dynamic || risky_assignment(&format!("{}=", target.text)).is_some())
        {
            return worst(result, unknown(format!("printf -v sets {}", target.text)));
        }
    }

    if READ_ONLY.contains(&name) {
        return result;
    }

    if let Some(writer) = path_writer(name) {
        if name == "tee" && operands(args).is_empty() {
            return result;
        }
        let mut targets = operands(args);
        if writer == Writer::Last {
            targets = targets.split_off(targets.len().saturating_sub(1));
        }
        if writer == Writer::AfterFirst {
            targets = targets.into_iter().skip(1).collect();
        }
        if name == "install" && has_short(args, "d") {
            targets = operands(args);
        }
        if name == "cp" || name == "install" || name == "ln" {
            let t = option_values(args, &["-t", "--target-directory"]);
            if !t.is_empty() {
                targets = t;
            }
        }
        let recursive = has_short(args, "rR") || has_flag(args, &["--recursive"]);
        let destructive = DESTRUCTIVE.contains(&name)
            || (recursive && ["chmod", "chown", "chgrp"].contains(&name))
            || (name == "rsync"
                && has_flag(args, &["--delete", "--delete-after", "--delete-before"]));
        if name == "mv" || name == "rsync" {
            // A destination outside the workspace is dangerous too, but not
            // "destructive".
            let all = operands(args);
            let split = all.len().saturating_sub(1);
            let dest = check_writes(&all[split..], state, false, &format!("{name} into"));
            let sources = check_writes(&all[..split], state, name == "mv", &format!("{name} from"));
            return worst(result, worst(dest, sources));
        }
        return worst(result, check_writes(&targets, state, destructive, name));
    }

    let first_operand = || operands(args).first().map(|word| word.text.clone());
    match name {
        "git" => return worst(result, classify_git(args, state)),
        "sed" => return worst(result, classify_sed(args, state)),
        "sort" => {
            let out = outputs(args, output_options("sort"));
            return if out.is_empty() {
                result
            } else {
                worst(result, check_writes(&out, state, false, "sort -o writes"))
            };
        }
        "find" => {
            if has_flag(args, &["-exec", "-execdir", "-ok", "-okdir"]) {
                return worst(result, unknown("find -exec runs commands"));
            }
            let out = outputs(args, output_options("find"));
            if !out.is_empty() {
                result = worst(result, check_writes(&out, state, false, "find writes"));
            }
            if has_flag(args, &["-delete"]) {
                let first_option = args.iter().position(|word| word.text.starts_with('-'));
                let starts = &args[..first_option.unwrap_or(args.len())];
                let roots = if starts.is_empty() {
                    vec![Word::plain(".")]
                } else {
                    starts.to_vec()
                };
                return worst(result, check_writes(&roots, state, true, "find -delete in"));
            }
            return result;
        }
        "awk" | "gawk" | "mawk" => {
            let program = first_operand().unwrap_or_default();
            let all = args
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            let effects = js_regex!(r#"system\s*\(|\|\s*"|>\s*"|getline|-i\s*inplace"#)
                .test(&format!("{program}{all}"));
            return worst(
                result,
                if effects {
                    unknown("awk program with side effects")
                } else {
                    read("awk")
                },
            );
        }
        "curl" => {
            if has_flag(args, &["-T", "--upload-file", "-F", "--form"])
                || args
                    .iter()
                    .any(|word| js_regex!("^(-d|--data.*)$").test(&word.text))
            {
                return worst(result, unknown("curl sends data to a remote host"));
            }
            if has_flag(args, &["-K", "--config"])
                || args
                    .iter()
                    .any(|word| js_regex!("^file:", "i").test(&word.text))
            {
                return worst(result, unknown("curl reads a local file or config"));
            }
            let out = outputs(args, output_options("curl"));
            if !out.is_empty() {
                result = worst(result, check_writes(&out, state, false, "curl writes"));
            }
            if !has_flag(args, &["--output-dir"])
                && (has_flag(args, &["-O", "--remote-name", "--remote-name-all"])
                    || has_short(args, "O"))
            {
                result = worst(
                    result,
                    check_writes(&[cwd_word()], state, false, "curl downloads into"),
                );
            }
            return worst(
                result,
                if has_short(args, "X") || has_flag(args, &["--request"]) {
                    unknown("curl with a custom method")
                } else {
                    read("curl GET")
                },
            );
        }
        "wget" => {
            if args
                .iter()
                .any(|word| js_regex!("^file:", "i").test(&word.text))
            {
                return worst(result, unknown("wget reads a local file"));
            }
            let mut out = outputs(args, output_options("wget"));
            // Without -O / -P the download lands in the working directory.
            let document = option_values(
                args,
                &["-O", "--output-document", "-P", "--directory-prefix"],
            );
            if document.is_empty() {
                out.push(cwd_word());
            }
            return worst(
                result,
                worst(
                    write("wget downloads files"),
                    check_writes(&out, state, false, "wget writes"),
                ),
            );
        }
        "dd" => {
            let Some(of) = args.iter().find(|word| word.text.starts_with("of=")) else {
                return result;
            };
            if of.text.starts_with("of=/dev/") && !HARMLESS.contains(&&of.text[3..]) {
                return danger("dd writes to a raw device");
            }
            return worst(
                result,
                check_writes(&[derived(of, &of.text[3..])], state, false, "dd writes"),
            );
        }
        "kill" => {
            if args.iter().any(|word| word.text == "-1") {
                return danger("kills every process of the user");
            }
            return worst(result, unknown("kill signals a process"));
        }
        "killall" | "pkill" => {
            return worst(result, unknown(format!("{name} signals processes by name")));
        }
        "crontab" => {
            return if has_flag(args, &["-l"]) {
                result
            } else {
                danger("modifies scheduled jobs")
            };
        }
        "systemctl" | "launchctl" | "service" => {
            let sub = first_operand().unwrap_or_default();
            return if [
                "status",
                "list",
                "show",
                "is-active",
                "is-enabled",
                "print",
                "list-units",
            ]
            .contains(&sub.as_str())
            {
                result
            } else {
                danger(format!("{name} changes system services"))
            };
        }
        "npx" | "bunx" | "pnpx" => {
            return worst(result, unknown(format!("{name} runs an arbitrary package")));
        }
        "cargo" => {
            let sub = first_operand();
            let s = sub.as_deref().unwrap_or("");
            if ["publish", "yank", "login", "owner"].contains(&s) {
                return danger(format!("cargo {s} changes a package registry"));
            }
            if s == "install" || s == "uninstall" {
                return danger(format!("cargo {s} changes globally installed tools"));
            }
            return worst(
                result,
                worst(
                    write(js::trim(&format!("cargo {s}")).to_owned()),
                    check_writes(
                        &outputs(args, output_options("cargo")),
                        state,
                        false,
                        "cargo writes",
                    ),
                ),
            );
        }
        "go" => {
            let sub = first_operand();
            let s = sub.as_deref().unwrap_or("");
            if ["env", "version", "list", "doc", "vet"].contains(&s) {
                return if has_flag(args, &["-w"]) {
                    danger("go env -w changes global Go settings")
                } else {
                    result
                };
            }
            if s == "install" {
                return danger("go install changes globally installed tools");
            }
            return worst(
                result,
                worst(
                    write(js::trim(&format!("go {s}")).to_owned()),
                    check_writes(
                        &outputs(args, output_options("go")),
                        state,
                        false,
                        "go writes",
                    ),
                ),
            );
        }
        "pip" | "pip3" | "uv" => {
            let sub = first_operand();
            let s = sub.as_deref().unwrap_or("");
            if ["list", "show", "freeze", "check", "--version"].contains(&s) {
                return result;
            }
            if s == "upload" || s == "publish" {
                return danger(format!("{name} {s} publishes a package"));
            }
            return worst(result, write(js::trim(&format!("{name} {s}")).to_owned()));
        }
        "twine" | "gem" => {
            let sub = first_operand();
            return if matches!(sub.as_deref(), Some("upload" | "push")) {
                danger(format!("{name} publishes a package"))
            } else {
                worst(result, unknown(name))
            };
        }
        "docker" | "podman" => {
            let sub = first_operand();
            let s = sub.as_deref().unwrap_or("");
            if [
                "ps", "images", "logs", "inspect", "version", "info", "stats", "top", "port",
                "diff", "history",
            ]
            .contains(&s)
            {
                return result;
            }
            if s == "push" || s == "login" {
                return danger(format!("{name} {s} changes a registry or credentials"));
            }
            if ["system", "volume", "rm", "rmi", "prune"].contains(&s) {
                return worst(
                    result,
                    unknown(format!("{name} {s} may delete containers or data")),
                );
            }
            return worst(result, unknown(js::trim(&format!("{name} {s}")).to_owned()));
        }
        "kubectl" | "helm" => {
            let ops = operands(args);
            let sub = ops.first().map(|word| word.text.as_str());
            let s = sub.unwrap_or("");
            let setting =
                s == "config" && ops.get(1).is_some_and(|word| word.text.starts_with("set"));
            if [
                "get",
                "describe",
                "logs",
                "version",
                "explain",
                "list",
                "status",
                "top",
                "api-resources",
                "config",
            ]
            .contains(&s)
                && !setting
            {
                return result;
            }
            let what = if s.is_empty() {
                name.to_owned()
            } else {
                format!("{name} {s}")
            };
            return danger(format!("{what} changes a cluster"));
        }
        "terraform" | "tofu" | "pulumi" => {
            let sub = first_operand();
            let s = sub.as_deref().unwrap_or("");
            if [
                "plan",
                "validate",
                "fmt",
                "show",
                "output",
                "version",
                "preview",
                "providers",
                "graph",
            ]
            .contains(&s)
            {
                return worst(result, write(format!("{name} {s}")));
            }
            if s == "init" {
                return worst(result, write(format!("{name} init")));
            }
            let what = if s.is_empty() {
                name.to_owned()
            } else {
                format!("{name} {s}")
            };
            return danger(format!("{what} changes real infrastructure"));
        }
        "gh" => {
            let ops = operands(args);
            let group = ops.first().map(|word| word.text.as_str());
            let action = ops.get(1).map(|word| word.text.as_str());
            // `gh`, `gh --version`, `gh --help`, `gh version` only print.
            if (group.is_none()
                && args
                    .iter()
                    .all(|word| ["--version", "--help", "-h"].contains(&word.text.as_str())))
                || (group == Some("version") && args.len() == 1)
            {
                return result;
            }
            if group == Some("api") {
                let method = args
                    .iter()
                    .position(|word| word.text == "-X" || word.text == "--method");
                let verb = method
                    .and_then(|index| args.get(index + 1))
                    .map(|word| word.text.to_uppercase());
                if let Some(verb) = verb
                    && verb != "GET"
                {
                    return danger(format!("gh api {verb} changes GitHub state"));
                }
                if has_flag(args, &["-f", "-F", "--field", "--raw-field", "--input"]) {
                    return danger("gh api with fields sends a mutating request");
                }
                return result;
            }
            if [
                "view", "list", "status", "diff", "checks", "search", "browse",
            ]
            .contains(&action.unwrap_or(""))
                || group == Some("search")
                || group == Some("status")
            {
                return result;
            }
            if let Some(group @ ("auth" | "secret" | "ssh-key" | "gpg-key")) = group {
                return if action == Some("status") {
                    result
                } else {
                    danger(format!("gh {group} changes credentials"))
                };
            }
            if matches!(action, Some("delete" | "merge" | "close")) || group == Some("release") {
                return danger(format!(
                    "gh {} {} changes shared GitHub state",
                    group.unwrap_or("undefined"),
                    action.unwrap_or("undefined")
                ));
            }
            return worst(
                result,
                unknown(
                    js::trim(&format!(
                        "gh {} {}",
                        group.unwrap_or(""),
                        action.unwrap_or("")
                    ))
                    .to_owned(),
                ),
            );
        }
        "nix" => {
            let ops = operands(args);
            let s = ops.first().map_or("", |word| word.text.as_str());
            if [
                "eval",
                "search",
                "show-config",
                "path-info",
                "why-depends",
                "log",
            ]
            .contains(&s)
            {
                return result;
            }
            if s == "profile" || s == "store" || s == "registry" {
                return worst(result, unknown(format!("nix {s}")));
            }
            if s == "flake" && ops.get(1).is_some_and(|word| word.text == "show") {
                return result;
            }
            return worst(result, write(js::trim(&format!("nix {s}")).to_owned()));
        }
        "xargs" => {
            let mut i = 0;
            while i < args.len() && args[i].text.starts_with('-') {
                i += if js_regex!("^-[IdLnPsE]$").test(&args[i].text) {
                    2
                } else {
                    1
                };
            }
            // The items read from stdin become unknown operands.
            let stdin_items = Word {
                text: "$XARGS_INPUT".to_owned(),
                dynamic: true,
                ..Word::default()
            };
            let mut inner_words: Vec<Word> = args.get(i..).unwrap_or(&[]).to_vec();
            inner_words.push(stdin_items);
            let inner = classify_command(
                &Command {
                    words: inner_words,
                    redirects: Vec::new(),
                },
                &mut state.clone(),
            );
            return worst(
                result,
                if inner.verdict == Verdict::Read {
                    inner
                } else {
                    worst(inner, unknown("xargs runs a command on unknown input"))
                },
            );
        }
        _ => {}
    }

    if PACKAGE_MANAGERS.contains(&name) {
        let out = outputs(args, output_options(name));
        return worst(
            result,
            worst(
                classify_package_manager(name, args),
                check_writes(&out, state, false, &format!("{name} writes in")),
            ),
        );
    }
    if BUILD_TOOLS.contains(&name) {
        let edited = in_place_targets(name, args);
        if name == "prettier" && edited.is_none() {
            return result;
        }
        let mut out = outputs(args, output_options(name));
        out.extend(edited.unwrap_or_default());
        return worst(
            result,
            worst(
                write(format!("{name} builds, formats or tests the workspace")),
                check_writes(&out, state, false, &format!("{name} writes")),
            ),
        );
    }
    if is_interpreter(name) || ["eval", "exec", "source", "."].contains(&name) {
        return worst(result, unknown(format!("{name} runs arbitrary code")));
    }
    if name.starts_with("./") || head.text.contains('/') {
        return worst(result, unknown("runs a local program"));
    }
    worst(result, unknown(format!("unrecognised command {name}")))
}

// ---------------------------------------------------------------------------
// User deny-list

/// `compileDeny`: a pattern is a JavaScript regular expression searched
/// (unanchored) in the command; `/source/flags` sets flags. A pattern that
/// does not compile is matched as literal text rather than dropped. Returns
/// the patterns and the invalid ones.
pub fn compile_deny(patterns: &[String]) -> (Vec<JsRegex>, Vec<String>) {
    let mut deny = Vec::new();
    let mut invalid = Vec::new();
    for pattern in patterns {
        if js::trim(pattern).is_empty() {
            continue;
        }
        let literal = pattern.strip_prefix('/').and_then(|rest| {
            let slash = rest.rfind('/')?;
            let (source, flags) = (&rest[..slash], &rest[slash + 1..]);
            (!source.is_empty() && flags.chars().all(|c| c.is_ascii_lowercase()))
                .then_some((source, flags))
        });
        let compiled = match literal {
            Some((source, flags)) => JsRegex::new(source, flags),
            None => JsRegex::new(pattern, ""),
        };
        match compiled {
            Ok(regex) => deny.push(regex),
            Err(_) => {
                invalid.push(pattern.clone());
                let mut escaped = String::new();
                for c in pattern.chars() {
                    if ".*+?^${}()|[]\\/".contains(c) {
                        escaped.push('\\');
                    }
                    escaped.push(c);
                }
                deny.push(JsRegex::new(&escaped, "").expect("an escaped pattern"));
            }
        }
    }
    (deny, invalid)
}

fn denied(deny: &[JsRegex], text: &str, place: &str) -> Option<Classification> {
    deny.iter()
        .find(|pattern| pattern.test(text))
        .map(|pattern| Classification {
            denied: true,
            ..danger(format!("{place} matches the deny-list pattern {pattern}"))
        })
}

/// `denyMatch`: the deny-list against the raw text, and against each lexed
/// command with quotes and escapes removed and words single-spaced.
pub fn deny_match(text: &str, deny: &[JsRegex]) -> Option<Classification> {
    if deny.is_empty() {
        return None;
    }
    if let Some(hit) = denied(deny, text, "the command") {
        return Some(hit);
    }
    let Lexed::Pipelines(pipelines) = lex(text) else {
        return None;
    };
    for pipeline in &pipelines {
        for command in pipeline {
            let joined = command
                .words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if let Some(hit) = denied(deny, &joined, "the command") {
                return Some(hit);
            }
        }
    }
    None
}

const MAX_SCRIPT_BYTES: u64 = 1024 * 1024;

fn read_script(file: Option<&str>) -> Option<String> {
    let file = file?;
    let info = std::fs::metadata(file).ok()?;
    if !info.is_file() || info.len() > MAX_SCRIPT_BYTES {
        return None;
    }
    crate::tools::files::read_text(file).ok()
}

/// One recipe: its dependencies and body.
#[derive(Default)]
struct Recipe {
    deps: Vec<String>,
    body: String,
}

fn split_ws(text: &str) -> Vec<&str> {
    text.split(js::is_space)
        .filter(|part| !part.is_empty())
        .collect()
}

/// Recipes of a Makefile or justfile: header `name … :` then indented body
/// lines.
fn recipes(text: &str) -> IndexMap<String, Recipe> {
    let mut out: IndexMap<String, Recipe> = IndexMap::new();
    let mut current: Vec<String> = Vec::new();
    for line in text.split('\n') {
        if line.starts_with([' ', '\t']) {
            for name in &current {
                if let Some(recipe) = out.get_mut(name) {
                    recipe.body.push_str(line);
                    recipe.body.push('\n');
                }
            }
            continue;
        }
        let header = js_regex!(r"^@?([^\s:#=][^:=]*?)\s*::?(?!=)\s*(.*)$");
        let Some(found) = header.captures(line) else {
            if !js::trim(line).is_empty() && !line.starts_with('#') {
                current.clear();
            }
            continue;
        };
        let targets = found.group(1).map_or("", |range| &line[range]);
        let rest = found.group(2).map_or("", |range| &line[range]);
        // `split(';', 2)`: the first two pieces only.
        let mut pieces = rest.split(';');
        let deps = pieces.next().unwrap_or("");
        let inline = pieces.next();
        current.clear();
        for target in split_ws(targets) {
            let name = target.strip_prefix('@').unwrap_or(target).to_owned();
            out.entry(name.clone()).or_insert_with(|| Recipe {
                deps: split_ws(deps).into_iter().map(str::to_owned).collect(),
                body: match inline {
                    Some(inline) if !inline.is_empty() => format!("{inline}\n"),
                    _ => String::new(),
                },
            });
            current.push(name);
        }
    }
    out
}

/// Bodies of `names` and, transitively, of the recipes they depend on.
fn recipe_bodies(text: &str, names: &[String], skip_missing: bool) -> Option<Vec<String>> {
    let all = recipes(text);
    let mut queue: std::collections::VecDeque<String> = if names.is_empty() {
        all.keys()
            .filter(|name| !name.starts_with('.'))
            .take(1)
            .cloned()
            .collect()
    } else {
        names.iter().cloned().collect()
    };
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    while seen.len() < 64 {
        let Some(name) = queue.pop_front() else {
            break;
        };
        if seen.contains(&name) {
            continue;
        }
        seen.push(name.clone());
        let key = name.split(js::is_space).next().unwrap_or("");
        let Some(recipe) = all.get(key) else {
            if skip_missing {
                continue;
            }
            return None;
        };
        out.push(recipe.body.clone());
        for dep in &recipe.deps {
            let dep = dep.split('(').next().unwrap_or("");
            if !dep.is_empty() {
                queue.push_back(dep.to_owned());
            }
        }
        let calls = js_regex!(r"\b(?:\$\(MAKE\)|make|just)\s+([A-Za-z0-9_.\-/]+)", "g");
        for found in calls.find_iter(&recipe.body) {
            if let Some(range) = found.group(1) {
                queue.push_back(recipe.body[range].to_owned());
            }
        }
    }
    Some(out)
}

/// Bodies of the package.json scripts `names` runs, with pre/post hooks and
/// nested `run`s.
fn package_script_bodies(dir: &str, names: &[String]) -> Vec<String> {
    let text = read_script(Some(&js::join(dir, "package.json"))).unwrap_or_else(|| "{}".to_owned());
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    if parsed.is_null() {
        return Vec::new();
    }
    let scripts = parsed
        .get("scripts")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    let mut queue: std::collections::VecDeque<String> = names.iter().cloned().collect();
    let mut seen: Vec<String> = Vec::new();
    while seen.len() < 64 {
        let Some(name) = queue.pop_front() else {
            break;
        };
        if seen.contains(&name) {
            continue;
        }
        seen.push(name.clone());
        for key in [format!("pre{name}"), name.clone(), format!("post{name}")] {
            let Some(serde_json::Value::String(body)) = scripts.get(&key) else {
                continue;
            };
            out.push(body.clone());
            let runs = js_regex!(
                r"\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.\-/@]+)",
                "g"
            );
            for found in runs.find_iter(body) {
                if let Some(range) = found.group(1) {
                    queue.push_back(body[range].to_owned());
                }
            }
        }
    }
    out
}

/// What a command runs indirectly (package scripts, make/just recipes,
/// shell script files), checked against the deny-list. Danger on a match;
/// unknown when the scripts cannot be determined; `None` otherwise.
fn deny_scripts(head: &Word, args: &[Word], state: &State<'_>) -> Option<Classification> {
    if state.deny.is_empty() {
        return None;
    }
    let name = js::basename(&head.text);
    let at = |dirs: &[Word]| match dirs.last() {
        Some(last) => state.paths.resolve(last, state.cwd.as_deref()),
        None => state.cwd.clone(),
    };
    let check = |bodies: &[String], place: &str| {
        bodies.iter().find_map(|body| {
            deny_match(body, state.deny).map(|hit| {
                let reason = hit
                    .reason
                    .strip_prefix("the command ")
                    .unwrap_or(&hit.reason)
                    .to_owned();
                Classification {
                    reason: format!("{place} {reason}"),
                    ..hit
                }
            })
        })
    };
    if PACKAGE_MANAGERS.contains(&name) {
        if has_flag(
            args,
            &[
                "--filter",
                "-F",
                "-r",
                "--recursive",
                "--workspaces",
                "--workspace",
                "-w",
                "-ws",
            ],
        ) {
            return Some(unknown(format!(
                "{name} runs scripts across workspaces that the deny-list cannot inspect"
            )));
        }
        let dir = at(&outputs(args, output_options(name)));
        let ops: Vec<String> = operands(args).into_iter().map(|word| word.text).collect();
        let mut names: Vec<String> = if ops
            .first()
            .is_some_and(|op| op == "run" || op == "run-script")
        {
            ops.iter().skip(1).take(1).cloned().collect()
        } else {
            ops.iter().take(1).cloned().collect()
        };
        // Installing runs the project's lifecycle scripts.
        if ["install", "i", "ci", "add"].contains(&names.first().map_or("", String::as_str))
            || ops.is_empty()
        {
            names.push("install".to_owned());
            names.push("prepare".to_owned());
        }
        let Some(dir) = dir else {
            return Some(unknown("package scripts in an unknown directory"));
        };
        return check(
            &package_script_bodies(&dir, &names),
            &format!("{name} {} runs a package script that", names.join(" ")),
        );
    }
    if name == "make" || name == "just" {
        let dir_options: &[&str] = if name == "make" {
            &["-C", "--directory"]
        } else {
            &["-d", "--working-directory"]
        };
        let Some(dir) = at(&option_values(args, dir_options)) else {
            return Some(unknown(format!("{name} in an unknown directory")));
        };
        let file_options: &[&str] = if name == "make" {
            &["-f", "--file", "--makefile"]
        } else {
            &["-f", "--justfile"]
        };
        let given = option_values(args, file_options);
        let candidates: Vec<Option<String>> = match given.last() {
            Some(last) => vec![state.paths.resolve(last, Some(&dir))],
            None if name == "make" => ["GNUmakefile", "makefile", "Makefile"]
                .iter()
                .map(|file| Some(js::join(&dir, file)))
                .collect(),
            None => ["justfile", "Justfile", ".justfile"]
                .iter()
                .map(|file| Some(js::join(&dir, file)))
                .collect(),
        };
        let file = candidates
            .into_iter()
            .find(|item| read_script(item.as_deref()).is_some())
            .flatten();
        let text = read_script(file.as_deref()).filter(|text| !text.is_empty());
        let Some(text) = text else {
            return if given.is_empty() {
                None
            } else {
                Some(unknown(format!("{name} file cannot be read")))
            };
        };
        let targets: Vec<String> = operands_skipping(
            args,
            &[
                "-f",
                "--file",
                "--makefile",
                "-C",
                "--directory",
                "-d",
                "--working-directory",
                "--justfile",
                "-j",
                "-l",
            ],
        )
        .into_iter()
        .map(|word| word.text)
        .filter(|word| !word.contains('='))
        .collect();
        // make: an unknown target may come from a pattern rule or include,
        // so check the whole file. just: words after the recipe may be its
        // parameters.
        let bodies = recipe_bodies(&text, &targets, name == "just").unwrap_or_else(|| vec![text]);
        let place = format!("{name} {} runs a recipe that", targets.join(" "));
        let place = js_regex!(" +", "g").replace_all(&place, " ");
        return check(&bodies, &place);
    }
    // `bash s.sh`, `source s.sh`, `./s.sh`: the script file.
    let file = if SHELLS.contains(&name) || name == "source" || name == "." {
        if has_short(args, "c") {
            // Inline text: already matched as raw text.
            return None;
        }
        operands_skipping(args, &["-o", "+o", "-O", "+O"])
            .into_iter()
            .next()
    } else if head.text.contains('/') {
        Some(head.clone())
    } else {
        None
    };
    let file = file?;
    let resolved = state.paths.resolve(&file, state.cwd.as_deref());
    let Some(text) = read_script(resolved.as_deref()) else {
        return if resolved.is_some() {
            None
        } else {
            Some(unknown(format!(
                "runs {}, which cannot be checked against the deny-list",
                file.text
            )))
        };
    };
    check(&[text], &format!("{} is a script that", file.text))
}

/// The link-creating program a command runs (`ln`, `cp -s`, also behind
/// wrappers), if any.
fn creates_link(command: &Command) -> Option<&'static str> {
    let names: Vec<&str> = command
        .words
        .iter()
        .map(|word| js::basename(&word.text))
        .collect();
    let linkers = ["ln", "link", "mklink"];
    if let Some(name) = names.iter().find(|name| linkers.contains(*name)) {
        return linkers.into_iter().find(|link| link == name);
    }
    if names.contains(&"cp")
        && (has_short(&command.words, "s") || has_flag(&command.words, &["--symbolic-link"]))
    {
        return Some("cp -s");
    }
    None
}

/// Patterns recognisable only on the raw text.
fn raw_danger(command: &str) -> Option<Classification> {
    if js_regex!(r":\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:").test(command) {
        return Some(danger("fork bomb"));
    }
    if js_regex!(r">\s*\/dev\/(?:sd|nvme|disk|hd|mmcblk)").test(command) {
        return Some(danger("overwrites a raw disk device"));
    }
    if js_regex!(r"\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b").test(command) {
        return Some(danger("pipes a remote download into a shell"));
    }
    None
}

/// `classifyShell`: classify a shell command statically.
pub fn classify_shell(command: &str, context: &RuleContext<'_>) -> Classification {
    let trimmed = js::trim(command);
    if trimmed.is_empty() {
        return read("empty command");
    }
    if let Some(listed) = deny_match(trimmed, context.deny) {
        return listed;
    }
    if let Some(raw) = raw_danger(trimmed) {
        return raw;
    }
    let pipelines = match lex(trimmed) {
        Lexed::Complex(what) => return unknown(format!("uses {what}")),
        Lexed::Pipelines(pipelines) => pipelines,
    };
    let paths = Paths::new(context);
    let mut state = State {
        cwd: Some(real_resolve(context.cwd)),
        paths: &paths,
        deny: context.deny,
    };
    let mut result = read_only();
    // Paths are resolved now, before the command runs: once it creates a
    // link, later paths may lead anywhere.
    let mut linked: Option<&'static str> = None;
    for pipeline in &pipelines {
        for (index, command) in pipeline.iter().enumerate() {
            let name = js::basename(command.words.first().map_or("", |word| word.text.as_str()));
            if index > 0
                && (is_interpreter(name) || name == "xargs")
                && !command
                    .words
                    .get(1..)
                    .unwrap_or(&[])
                    .iter()
                    .any(|word| !word.text.starts_with('-'))
            {
                let source = js::basename(
                    pipeline[index - 1]
                        .words
                        .first()
                        .map_or("", |word| word.text.as_str()),
                );
                if source == "curl" || source == "wget" {
                    return danger("pipes a remote download into an interpreter");
                }
            }
            result = worst(result, classify_command(command, &mut state));
            if result.verdict == Verdict::Danger {
                return result;
            }
            if let Some(linked) = linked {
                result = worst(
                    result,
                    unknown(format!(
                        "runs after {linked} creates a link; its paths may resolve elsewhere"
                    )),
                );
            }
            if linked.is_none() {
                linked = creates_link(command);
            }
        }
    }
    result
}

#[cfg(test)]
mod tests;
