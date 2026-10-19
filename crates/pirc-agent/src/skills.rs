//! Skill locations the file tools may read (`agent/skills.ts`); listing
//! skills to the model is M5's `skills` feature.
//!
//! A skill is a directory holding `SKILL.md`: YAML front matter with `name`
//! and `description`, then instructions.

pub mod yaml;

use std::collections::HashSet;
use std::path::Path;

use indexmap::{IndexMap, IndexSet};

use crate::messages::js;
use yaml::Yaml;

/// `Skill`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// Real path of the skill's directory (symlinks resolved).
    pub dir: String,
    /// Real path of its `SKILL.md`.
    pub file: String,
    /// Index, in the roots given to [`discover_skills`], of the root the
    /// skill was found in ([`PROJECT_SKILL_ROOT`] for the repository's).
    pub root: usize,
}

/// The index of `<workspace>/.pirc/skills` in [`skill_roots`]: skills a
/// repository ships, not ones the user installed (L13).
pub const PROJECT_SKILL_ROOT: usize = 2;

/// `MAX_DESCRIPTION`.
pub const MAX_DESCRIPTION: usize = 1024;

/// `skillRoots(configDir, workspace)`: lowest precedence first, the user's
/// cross-tool `~/.agents/skills`, then node-wide, then the project's.
pub fn skill_roots(config_dir: &str, workspace: &str) -> Vec<String> {
    vec![
        js::path_join(&[&js::home_dir(), ".agents", "skills"]),
        js::path_join(&[config_dir, "skills"]),
        js::path_join(&[workspace, ".pirc", "skills"]),
    ]
}

/// Shared Markdown front matter, under the original skill API names.
pub use pirc_config::frontmatter::{MarkdownFile as SkillFile, parse as parse_skill_file};

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// `description.replace(/\s+/g, ' ').trim()`.
fn collapse_space(text: &str) -> String {
    let mut out = String::new();
    let mut in_space = false;
    for c in text.chars() {
        if js::is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    js::trim(&out).to_owned()
}

/// `discoverSkills(roots)`: a later root replaces an earlier skill of the
/// same name; invalid skills are skipped and reported.
pub fn discover_skills(roots: &[String]) -> (Vec<Skill>, Vec<String>) {
    let mut by_name: IndexMap<String, Skill> = IndexMap::new();
    let mut problems = Vec::new();
    for (index, root) in roots.iter().enumerate() {
        let Ok(entries) = js::sorted_dir_names(Path::new(root)) else {
            continue;
        };
        for entry in entries {
            if entry.starts_with('.') {
                continue;
            }
            let path = js::path_join(&[root, &entry]);
            let file = js::path_join(&[root, &entry, "SKILL.md"]);
            if !std::fs::metadata(&path).is_ok_and(|meta| meta.is_dir())
                || !Path::new(&file).exists()
            {
                continue;
            }
            let Ok(dir) = std::fs::canonicalize(&path) else {
                continue;
            };
            let Ok(text) = js::read_text(Path::new(&file)) else {
                continue;
            };
            let meta = match parse_skill_file(&text) {
                Ok(parsed) => parsed.meta,
                Err(error) => {
                    problems.push(format!("{file}: invalid front matter ({error})"));
                    continue;
                }
            };
            let name = match meta.get("name") {
                Some(Yaml::String(name)) => js::trim(name).to_owned(),
                _ => entry.clone(),
            };
            let description = match meta.get("description") {
                Some(Yaml::String(text)) => collapse_space(text),
                _ => String::new(),
            };
            if !valid_name(&name) {
                problems.push(format!(
                    "{file}: name must be lowercase letters, digits and hyphens (max 64)"
                ));
                continue;
            }
            if description.is_empty() {
                problems.push(format!("{file}: description is required"));
                continue;
            }
            let dir = dir.display().to_string();
            let description = if js::utf16_len(&description) > MAX_DESCRIPTION {
                format!("{}…", js::utf16_prefix(&description, MAX_DESCRIPTION - 1))
            } else {
                description
            };
            // `Map.set` keeps an existing key's place.
            by_name.insert(
                name.clone(),
                Skill {
                    name,
                    description,
                    file: js::path_join(&[&dir, "SKILL.md"]),
                    dir,
                    root: index,
                },
            );
        }
    }
    let mut skills: Vec<Skill> = by_name.into_values().collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    (skills, problems)
}

const LINK_SCAN_DEPTH: usize = 8;
const LINK_SCAN_ENTRIES: i64 = 2000;

/// `linkedTargets(dir, out)`: real targets of the symlinks inside a skill
/// directory (Home Manager links each file to its own store path).
fn linked_targets(dir: &str, out: &mut IndexSet<String>) {
    fn walk(
        current: &str,
        depth: usize,
        seen: &mut HashSet<String>,
        budget: &mut i64,
        out: &mut IndexSet<String>,
    ) {
        if depth > LINK_SCAN_DEPTH || seen.contains(current) {
            return;
        }
        seen.insert(current.to_owned());
        let Ok(entries) = std::fs::read_dir(current) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            *budget -= 1;
            if *budget < 0 {
                return;
            }
            let full = js::path_join(&[current, &entry.file_name().to_string_lossy()]);
            let Ok(stat) = std::fs::symlink_metadata(&full) else {
                continue;
            };
            if stat.file_type().is_symlink() {
                let Ok(real) = std::fs::canonicalize(&full) else {
                    continue;
                };
                let real = real.display().to_string();
                out.insert(real.clone());
                if std::fs::metadata(&real).is_ok_and(|meta| meta.is_dir()) {
                    walk(&real, depth + 1, seen, budget, out);
                }
            } else if stat.is_dir() {
                walk(&full, depth + 1, seen, budget, out);
            }
        }
    }
    let mut seen = HashSet::new();
    let mut budget = LINK_SCAN_ENTRIES;
    walk(dir, 0, &mut seen, &mut budget, out);
}

/// `skillReadPaths(roots)`: real paths the file tools must be able to read
/// (but never write) for skills to work: each root, each skill directory,
/// and whatever the files inside a skill directory link to.
pub fn skill_read_paths(roots: &[String]) -> Vec<String> {
    let mut out = IndexSet::new();
    for root in roots {
        if !Path::new(root).exists() {
            continue;
        }
        out.insert(root.clone());
        for skill in discover_skills(std::slice::from_ref(root)).0 {
            out.insert(skill.dir.clone());
            linked_targets(&skill.dir, &mut out);
        }
    }
    out.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn write_skill(root: &Path, dir: &str, front_matter: &str) {
        fs::create_dir_all(root.join(dir)).unwrap();
        fs::write(
            root.join(dir).join("SKILL.md"),
            format!("---\n{front_matter}\n---\n\nDo the thing.\n"),
        )
        .unwrap();
    }

    #[test]
    fn orders_agents_skills_lowest_then_the_node_then_the_workspace() {
        assert_eq!(
            skill_roots("/config", "/workspace"),
            [
                format!("{}/.agents/skills", js::home_dir()),
                "/config/skills".to_owned(),
                "/workspace/.pirc/skills".to_owned(),
            ]
        );
        assert_eq!(
            skill_roots("/config", "/workspace")[PROJECT_SKILL_ROOT],
            "/workspace/.pirc/skills"
        );
    }

    #[test]
    fn splits_front_matter_and_body() {
        let file = parse_skill_file("---\nname: x\ndescription: y\n---\n\nBody text.\n").unwrap();
        assert_eq!(file.meta.get("name"), Some(&Yaml::String("x".into())));
        assert_eq!(file.body, "Body text.");
        let none = parse_skill_file("  no front matter \n").unwrap();
        assert!(none.meta.is_empty());
        assert_eq!(none.body, "no front matter");
        // The closing line may carry trailing blanks; CRLF works too.
        let crlf = parse_skill_file("---\r\na: 1\r\n---  \r\nrest").unwrap();
        assert_eq!(crlf.meta.get("a"), Some(&Yaml::Number(1.0)));
        assert_eq!(crlf.body, "rest");
        // An empty front matter block needs its own line.
        assert!(parse_skill_file("---\n---\nx").unwrap().meta.is_empty());
        let list = parse_skill_file("---\n- a\n---\n").unwrap();
        assert_eq!(list.meta.keys().collect::<Vec<_>>(), ["0"]);
        assert!(parse_skill_file("---\na: [\n---\n").is_err());
    }

    #[test]
    fn discovers_and_validates_skills_with_later_roots_winning() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        write_skill(&first, "pdf", "name: pdf\ndescription: Personal PDF skill");
        write_skill(&first, "gif-search", "description: >\n  Find\n  GIFs.");
        write_skill(&first, "Bad", "description: x");
        write_skill(&first, "nodesc", "name: nodesc");
        write_skill(&first, "broken", "name: [");
        write_skill(&first, ".hidden", "description: x");
        fs::write(first.join("file.md"), "x").unwrap();
        write_skill(
            &second,
            "pdf",
            &format!("description: {}", "d ".repeat(600)),
        );
        let roots = [
            first.display().to_string(),
            second.display().to_string(),
            root.path().join("missing").display().to_string(),
        ];
        let (skills, problems) = discover_skills(&roots);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["gif-search", "pdf"]);
        assert_eq!(skills[0].description, "Find GIFs.");
        let pdf = &skills[1];
        assert_eq!(js::utf16_len(&pdf.description), MAX_DESCRIPTION);
        assert!(pdf.description.ends_with('…'));
        assert_eq!(
            pdf.dir,
            fs::canonicalize(second.join("pdf"))
                .unwrap()
                .display()
                .to_string()
        );
        assert_eq!(pdf.file, format!("{}/SKILL.md", pdf.dir));
        assert_eq!((skills[0].root, pdf.root), (0, 1));
        let first = first.display();
        assert_eq!(
            problems,
            [
                format!(
                    "{first}/Bad/SKILL.md: name must be lowercase letters, digits and hyphens (max 64)"
                ),
                format!(
                    "{first}/broken/SKILL.md: invalid front matter (YAML Parse error: Unexpected token)"
                ),
                format!("{first}/nodesc/SKILL.md: description is required"),
            ]
        );
    }

    #[test]
    fn allows_the_targets_of_files_linked_individually_into_a_skill_directory() {
        let root = fs::canonicalize(tempfile::tempdir().unwrap().keep()).unwrap();
        let store = root.join("store");
        fs::create_dir_all(store.join("refs")).unwrap();
        fs::write(
            store.join("hm_SKILL.md"),
            "---\nname: commit\ndescription: Commit.\n---\n",
        )
        .unwrap();
        fs::write(store.join("hm_openai.yaml"), "x: 1").unwrap();
        fs::write(store.join("refs/guide.md"), "guide").unwrap();
        let skills = root.join("skills");
        fs::create_dir_all(skills.join("commit/agents")).unwrap();
        symlink(store.join("hm_SKILL.md"), skills.join("commit/SKILL.md")).unwrap();
        symlink(
            store.join("hm_openai.yaml"),
            skills.join("commit/agents/openai.yaml"),
        )
        .unwrap();
        symlink(store.join("refs"), skills.join("commit/refs")).unwrap();
        symlink(store.join("missing"), skills.join("commit/dangling")).unwrap();
        let skills_text = skills.display().to_string();
        let targets = skill_read_paths(&[
            skills_text.clone(),
            root.join("absent").display().to_string(),
        ]);
        let set: HashSet<String> = targets.iter().cloned().collect();
        let expect = [
            skills_text.clone(),
            skills.join("commit").display().to_string(),
            store.join("hm_SKILL.md").display().to_string(),
            store.join("hm_openai.yaml").display().to_string(),
            store.join("refs").display().to_string(),
        ];
        assert_eq!(targets[0], skills_text);
        assert_eq!(targets[1], expect[1]);
        assert_eq!(set, expect.iter().cloned().collect());
        // Unrelated store paths are not skill configuration.
        assert!(!set.contains(&store.join("refs/guide.md").display().to_string()));
        fs::remove_dir_all(root).unwrap();
    }
}
