//! The Seatbelt profiles `sandbox::macos` generates. Runs on every
//! platform: profile generation is plain text.
//!
//! - [`profiles_match_srts`]: `profile::generate` with srt's settings
//!   against the profiles srt 0.0.78 generated for the same settings and
//!   files (`tests/fixtures/sbpl/<case>.sb`, recorded by `record.ts`
//!   there from `cases.json`).
//! - [`production_profiles_match_their_recordings`]: the profiles the
//!   backend builds from a session policy (`macos::policy_profile`, with
//!   pirc's deviations: resolved and literal extra denies, literal allows,
//!   move-blocked links, SBPL escapes, the read-only profile) for the same
//!   cases and those of `pirc-cases.json`, against
//!   `tests/fixtures/sbpl/pirc/<case>.sb`. srt cannot record these: they
//!   were recorded from pirc (`PIRC_BLESS_SBPL=1` rewrites them, on a host
//!   without `/tmp/claude`) and reviewed by hand; a change shows up as a
//!   diff to review.
//!
//! Each case's tree is built in a fresh directory, whose path replaces
//! `{ROOT}`; `{ROOT_ANCESTORS}` stands for the `(literal …)` lines of its
//! ancestors, `{TAG}` for the log tag and `{PORT}` for the proxy port.
//! Where `/tmp/claude` exists (a Mac that ran Claude Code), srt resolves
//! srt's two default write paths `/tmp/claude` and `/private/tmp/claude`
//! to one: the recordings are adjusted to match ([`tmp_claude`]).

use std::fs;
use std::path::Path;

use pirc_node::sandbox::macos::paths::{Context, normalize_path_for_sandbox};
use pirc_node::sandbox::macos::profile::{self, ProfileInput};
use pirc_node::sandbox::macos::{Settings, policy_profile};
use pirc_policy::PathPolicy;
use pirc_policy::session::{NetworkPolicy, SessionPolicy, linked_path};
use serde_json::Value;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sbpl");
const TAG: &str = "CMD64_dHJ1ZQ==_END__abcdefghi_SBX";
const PORT: u16 = 40000;
const BLESS: &str = "PIRC_BLESS_SBPL";

fn strings(value: &Value, root: &str) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| item.as_str().unwrap().replace("{ROOT}", root))
                .collect()
        })
        .unwrap_or_default()
}

/// A directory whose path is free of characters a regex or JSON string
/// would escape, so `{ROOT}` can be replaced as plain text.
fn root_dir() -> (tempfile::TempDir, String) {
    let dir = tempfile::Builder::new()
        .prefix("sbpl")
        .rand_bytes(8)
        .tempdir_in(env!("CARGO_TARGET_TMPDIR"))
        .unwrap();
    let root = fs::canonicalize(dir.path()).unwrap().display().to_string();
    assert!(
        root.chars()
            .all(|c| c.is_ascii_alphanumeric() || "/_-".contains(c)),
        "the test directory {root} needs escaping: use a plainer target directory"
    );
    (dir, root)
}

fn build_tree(root: &str, tree: &Value) {
    for dir in tree["dirs"].as_array().unwrap() {
        fs::create_dir_all(Path::new(root).join(dir.as_str().unwrap())).unwrap();
    }
    for file in tree["files"].as_array().unwrap() {
        fs::write(Path::new(root).join(file.as_str().unwrap()), "").unwrap();
    }
    for (link, target) in tree["symlinks"].as_object().unwrap() {
        std::os::unix::fs::symlink(target.as_str().unwrap(), Path::new(root).join(link)).unwrap();
    }
}

/// The `{ROOT_ANCESTORS}` run.
fn ancestors(root: &str) -> String {
    Path::new(root)
        .ancestors()
        .skip(1)
        .filter(|dir| *dir != Path::new("/"))
        .map(|dir| {
            format!(
                "  (literal {})\n",
                serde_json::to_string(&dir.display().to_string()).unwrap()
            )
        })
        .collect()
}

/// `expected` as srt (and pirc) generate it on this host: where
/// `/tmp/claude` exists, both of srt's spellings of it resolve, and the
/// two filters become one.
fn tmp_claude(expected: &str) -> String {
    let ctx = Context {
        cwd: "/",
        home: "/",
    };
    let filter = |path: &str| format!("  (subpath \"{path}\")\n");
    let pair = format!("{}{}", filter("/tmp/claude"), filter("/private/tmp/claude"));
    let resolved: indexmap::IndexSet<String> = ["/tmp/claude", "/private/tmp/claude"]
        .iter()
        .map(|path| filter(&normalize_path_for_sandbox(path, true, ctx)))
        .collect();
    expected.replace(&pair, &resolved.into_iter().collect::<String>())
}

/// The case's recording with its placeholders filled in.
fn expected(file: &str, root: &str) -> String {
    let text = fs::read_to_string(file)
        .unwrap()
        .replace("  {ROOT_ANCESTORS}\n", &ancestors(root))
        .replace("{ROOT}", root)
        .replace("{TAG}", TAG)
        .replace("{PORT}", &PORT.to_string());
    tmp_claude(text.strip_suffix('\n').unwrap_or(&text))
}

/// `actual` against `expected`: the first differing line.
fn difference(name: &str, actual: &str, expected: &str) -> Option<String> {
    if actual == expected {
        return None;
    }
    let line = actual
        .lines()
        .zip(expected.lines())
        .position(|(a, e)| a != e)
        .unwrap_or_else(|| actual.lines().count().min(expected.lines().count()));
    Some(format!(
        "{name}: first difference at line {}\n  recorded: {:?}\n  pirc:     {:?}",
        line + 1,
        expected.lines().nth(line),
        actual.lines().nth(line)
    ))
}

/// A case of `cases.json` or `pirc-cases.json`, its tree built.
struct Case {
    name: String,
    _dir: tempfile::TempDir,
    root: String,
    cwd: String,
    home: String,
    deny_read: Vec<String>,
    allow_read: Vec<String>,
    allow_write: Vec<String>,
    deny_write: Vec<String>,
    allow_git_config: bool,
    allow_unix_sockets: Vec<String>,
    allow_local_binding: bool,
    proxy_port: Option<u16>,
    allow_pty: bool,
    /// pirc's read-only profile (not srt's: `readonly` in the case).
    readonly: bool,
    /// `linkedDenies`: spellings for `SessionPolicy::linked_denies`.
    linked: Vec<String>,
    /// `tmpdir`: one of pirc's own paths.
    tmpdir: String,
}

fn load(file: &str) -> Vec<Case> {
    let cases: Vec<Value> =
        serde_json::from_str(&fs::read_to_string(format!("{FIXTURES}/{file}")).unwrap()).unwrap();
    cases
        .iter()
        .map(|case| {
            let (dir, root) = root_dir();
            build_tree(&root, &case["tree"]);
            let fs_settings = &case["settings"]["filesystem"];
            let network = &case["settings"]["network"];
            let mut deny_write = strings(&fs_settings["denyWrite"], &root);
            if let Some(generate) = case.get("generate") {
                let spec = &generate["denyWrite"];
                let prefix = spec["prefix"].as_str().unwrap().replace("{ROOT}", &root);
                for n in 0..spec["count"].as_u64().unwrap() {
                    for leaf in spec["leaves"].as_array().unwrap() {
                        deny_write.push(format!("{prefix}{n}/{}", leaf.as_str().unwrap()));
                    }
                }
            }
            let rel = |key: &str| format!("{root}/{}", case[key].as_str().unwrap());
            Case {
                name: case["name"].as_str().unwrap().to_owned(),
                cwd: rel("cwd"),
                home: rel("home"),
                tmpdir: rel("tmpdir"),
                deny_read: strings(&fs_settings["denyRead"], &root),
                allow_read: strings(&fs_settings["allowRead"], &root),
                allow_write: strings(&fs_settings["allowWrite"], &root),
                deny_write,
                allow_git_config: fs_settings["allowGitConfig"].as_bool().unwrap_or(false),
                allow_unix_sockets: strings(&network["allowUnixSockets"], &root),
                allow_local_binding: network["allowLocalBinding"].as_bool().unwrap_or(false),
                proxy_port: case["proxy"].as_bool().unwrap().then_some(PORT),
                allow_pty: case["settings"]["allowPty"].as_bool().unwrap_or(false),
                readonly: case["readonly"].as_bool().unwrap_or(false),
                linked: strings(&case["linkedDenies"], &root),
                _dir: dir,
                root,
            }
        })
        .collect()
}

#[test]
fn profiles_match_srts() {
    let mut failures = Vec::new();
    for case in load("cases.json") {
        let input = ProfileInput {
            deny_read: &case.deny_read,
            allow_read: &case.allow_read,
            allow_write: &case.allow_write,
            deny_write: &case.deny_write,
            allow_git_config: case.allow_git_config,
            allow_unix_sockets: &case.allow_unix_sockets,
            allow_local_binding: case.allow_local_binding,
            proxy_port: case.proxy_port,
            allow_pty: case.allow_pty,
            cwd: &case.cwd,
            home: &case.home,
            log_tag: TAG,
            extra_read_denies: &[],
            extra_write_denies: &[],
            extra_move_blocks: &[],
            literal_roots: &[],
            // srt has no read-only profile.
            readonly: false,
            temp_parent: None,
        };
        let actual = profile::generate(&input).unwrap();
        let expected = expected(&format!("{FIXTURES}/{}.sb", case.name), &case.root);
        failures.extend(difference(&case.name, &actual, &expected));
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The profile [`policy_profile`] builds for `case` as a session policy.
fn production_profile(case: &Case) -> String {
    let policy = SessionPolicy {
        paths: PathPolicy {
            deny_read: case.deny_read.clone(),
            allow_read: case.allow_read.clone(),
            allow_write: case.allow_write.clone(),
            deny_write: case.deny_write.clone(),
            shared_write: None,
        },
        network: NetworkPolicy {
            allow_local_binding: case.allow_local_binding,
            allow_unix_sockets: case.allow_unix_sockets.clone(),
            ..NetworkPolicy::default()
        },
        allow_git_config: case.allow_git_config,
        linked_denies: case
            .linked
            .iter()
            .map(|spelled| {
                linked_path(spelled)
                    .unwrap_or_else(|| panic!("{}: {spelled} crosses no link", case.name))
            })
            .collect(),
    };
    // What the backend counts as pirc's own: the home directory, the
    // node's state and the session's temp directory (and the cwd).
    let literal_roots = [
        case.home.clone(),
        format!("{}/state", case.root),
        case.tmpdir.clone(),
    ];
    policy_profile(
        &policy,
        &Settings {
            cwd: &case.cwd,
            home: &case.home,
            proxy_port: case.proxy_port,
            allow_pty: case.allow_pty,
            log_tag: TAG,
            readonly: case.readonly,
            literal_roots: &literal_roots,
            temp_parent: None,
        },
    )
    .unwrap()
}

/// `actual` with its placeholders put back (for [`BLESS`]).
fn record(actual: &str, root: &str) -> String {
    let run = ancestors(root);
    let text = actual
        .replace(&run, "  {ROOT_ANCESTORS}\n")
        .replace(TAG, "{TAG}")
        .replace(root, "{ROOT}")
        .replace(&format!("localhost:{PORT}"), "localhost:{PORT}");
    let parent = Path::new(root).parent().unwrap().display().to_string();
    assert!(
        !text.contains(&format!("\"{parent}\"")),
        "a partial run of the root's ancestors: cannot record this case"
    );
    format!("{text}\n")
}

#[test]
fn production_profiles_match_their_recordings() {
    let bless = std::env::var_os(BLESS).is_some();
    if bless {
        assert!(
            !Path::new("/tmp/claude").exists(),
            "record where /tmp/claude does not exist"
        );
    }
    let mut failures = Vec::new();
    let mut names = Vec::new();
    for case in load("cases.json")
        .into_iter()
        .chain(load("pirc-cases.json"))
    {
        assert!(!names.contains(&case.name), "two cases named {}", case.name);
        names.push(case.name.clone());
        let actual = production_profile(&case);
        let file = format!("{FIXTURES}/pirc/{}.sb", case.name);
        if bless {
            fs::write(&file, record(&actual, &case.root)).unwrap();
            continue;
        }
        let expected = expected(&file, &case.root);
        failures.extend(difference(&case.name, &actual, &expected));
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// What the production profiles add to srt's, case by case: the checks
/// the recordings are reviewed against.
#[test]
fn production_profiles_hold_pircs_deviations() {
    let cases: Vec<Case> = load("cases.json")
        .into_iter()
        .chain(load("pirc-cases.json"))
        .collect();
    let case = |name: &str| cases.iter().find(|case| case.name == name).unwrap();
    // Every line of srt's profile stays, but srt's glob reading of a
    // workspace with glob characters and what the read-only profile drops.
    for case in load("cases.json") {
        if case.name == "readonly" || case.name == "special-chars" {
            continue;
        }
        let srt = expected(&format!("{FIXTURES}/{}.sb", case.name), &case.root);
        let pirc = production_profile(&case);
        let lines: std::collections::HashSet<&str> = pirc.lines().collect();
        let lost: Vec<&str> = srt.lines().filter(|line| !lines.contains(line)).collect();
        assert!(lost.is_empty(), "{}: {lost:#?}", case.name);
    }
    // A `.git` linking elsewhere: denied where it leads, the link kept.
    let symlinks = case("symlinks");
    let profile = production_profile(symlinks);
    let r = |rest: &str| format!("{}/{rest}", symlinks.root);
    assert!(profile.contains(&format!("(subpath \"{}\")", r("repo/config"))));
    assert!(profile.contains(&format!("(literal \"{}\")", r("ws/.git"))));
    // A chain of links, and a linked credential store.
    let chain = case("chain");
    let profile = production_profile(chain);
    let r = |rest: &str| format!("{}/{rest}", chain.root);
    for link in [
        "ws/.git",
        "home/hop",
        "home/.ssh",
        "home/.aws",
        "home/aws-hop",
    ] {
        assert!(
            profile.contains(&format!("(literal \"{}\")", r(link))),
            "{link}"
        );
    }
    assert!(profile.contains(&format!("(subpath \"{}\")", r("repo/hooks"))));
    // Control characters: SBPL escapes, never JSON's.
    let control = production_profile(case("control-chars"));
    assert!(
        control.contains("w\\x01\\x1b\\t\\x7f\\\\x/.git/hooks"),
        "{control}"
    );
    assert!(!control.contains("\\u00"));
    // A workspace with glob characters: literal allows and denies; the
    // user's globs stay patterns.
    let special = production_profile(case("special-chars"));
    let ws = format!("{}/w[s] \\\"q\\\" ü*?", case("special-chars").root);
    assert!(
        special.contains(&format!("(subpath \"{ws}\")")),
        "{special}"
    );
    assert!(special.contains(&format!("(subpath \"{ws}/.pirc\")")));
    let globs = production_profile(case("user-globs"));
    let r = |rest: &str| format!("{}/{rest}", case("user-globs").root);
    for literal in ["w[1]", "w[1]/.pirc", "w[1]/.git/hooks"] {
        assert!(
            globs.contains(&format!("(subpath \"{}\")", r(literal))),
            "{literal}"
        );
    }
    for glob in ["w[1]/gen/*", "w[1]/*.lock", "w[1]/**/*.key"] {
        assert!(
            !globs.contains(&format!("(subpath \"{}\")", r(glob))),
            "{glob}"
        );
    }
    // The read-only profile.
    let readonly = production_profile(case("readonly"));
    assert!(!readonly.contains("tmp/claude"));
    assert!(!readonly.contains("(allow ipc-posix-shm)"));
}
