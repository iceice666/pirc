//! The Seatbelt profiles `sandbox::macos::profile` generates, against the
//! ones srt 0.0.78 generated for the same settings and files
//! (`tests/fixtures/sbpl/`, recorded by `record.ts` there). Runs on every
//! platform: profile generation is plain text.
//!
//! Each case's tree is built in a fresh directory, whose path replaces
//! `{ROOT}`; `{ROOT_ANCESTORS}` stands for the `(literal …)` lines of its
//! ancestors, `{TAG}` for the log tag and `{PORT}` for the proxy port.

use std::fs;
use std::path::Path;

use pirc_node::sandbox::macos::profile::{self, ProfileInput};
use serde_json::Value;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sbpl");
const TAG: &str = "CMD64_dHJ1ZQ==_END__abcdefghi_SBX";
const PORT: u16 = 40000;

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

#[test]
fn profiles_match_srts() {
    let cases: Vec<Value> =
        serde_json::from_str(&fs::read_to_string(format!("{FIXTURES}/cases.json")).unwrap())
            .unwrap();
    let mut failures = Vec::new();
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let (_dir, root) = root_dir();
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
        let (cwd, home) = (rel("cwd"), rel("home"));
        let input = ProfileInput {
            deny_read: &strings(&fs_settings["denyRead"], &root),
            allow_read: &strings(&fs_settings["allowRead"], &root),
            allow_write: &strings(&fs_settings["allowWrite"], &root),
            deny_write: &deny_write,
            allow_git_config: fs_settings["allowGitConfig"].as_bool().unwrap_or(false),
            allow_unix_sockets: &strings(&network["allowUnixSockets"], &root),
            allow_local_binding: network["allowLocalBinding"].as_bool().unwrap_or(false),
            proxy_port: case["proxy"].as_bool().unwrap().then_some(PORT),
            allow_pty: case["settings"]["allowPty"].as_bool().unwrap_or(false),
            cwd: &cwd,
            home: &home,
            log_tag: TAG,
            extra_read_denies: &[],
            extra_write_denies: &[],
            extra_move_blocks: &[],
            readonly: false,
            literal_roots: &[],
        };
        let actual = profile::generate(&input).unwrap();
        let expected = fs::read_to_string(format!("{FIXTURES}/{name}.sb"))
            .unwrap()
            .replace("  {ROOT_ANCESTORS}\n", &ancestors(&root))
            .replace("{ROOT}", &root)
            .replace("{TAG}", TAG)
            .replace("{PORT}", &PORT.to_string());
        let expected = expected.strip_suffix('\n').unwrap_or(&expected);
        if actual != expected {
            let line = actual
                .lines()
                .zip(expected.lines())
                .position(|(a, e)| a != e)
                .unwrap_or_else(|| actual.lines().count().min(expected.lines().count()));
            failures.push(format!(
                "{name}: first difference at line {}\n  srt:  {:?}\n  pirc: {:?}",
                line + 1,
                expected.lines().nth(line),
                actual.lines().nth(line)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
