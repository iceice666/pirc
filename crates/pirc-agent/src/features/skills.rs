//! `skills` (`agent/features/skills.ts`): Agent Skills from
//! `~/.agents/skills`, `$PIRC_CONFIG_DIR/skills/` and
//! `<workspace>/.pirc/skills/` (see `crate::skills`). Rescanned before
//! every run and command, so a new skill is listed without restarting; the
//! file tools can read skill directories that existed when the agent
//! started. `/skill:<name> [request]` loads one explicitly, `/skill` lists
//! them.

use std::cell::RefCell;
use std::path::Path;
use std::rc::{Rc, Weak};

use serde_json::{Value, json};

use crate::LocalBoxFuture;
use crate::agent::{Agent, Delivery};
use crate::feature::{BeforeStart, Feature, FeatureCommand, PromptAddition};
use crate::messages::js;
use crate::skills::{Skill, discover_skills, parse_skill_file, skill_roots};
use crate::ui::NotifyLevel;

/// `SKILL_MESSAGE`: the custom type of a loaded skill.
pub const SKILL_MESSAGE: &str = "skill";

/// `escape`: XML text and attribute escaping.
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `skillsPrompt`: the system-prompt section listing skills; empty when
/// there are none.
pub fn skills_prompt(skills: &[Skill]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let list = skills
        .iter()
        .map(|skill| {
            format!(
                "  <skill>\n    <name>{}</name>\n    <description>{}</description>\n    <location>{}</location>\n  </skill>",
                escape(&skill.name),
                escape(&skill.description),
                escape(&skill.file)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "## Skills

Skills are instructions for specialized tasks, installed by the user. When a task matches a skill's description, read its SKILL.md with the read tool before acting and follow it. Relative paths in a skill are relative to its directory; read referenced files only when needed.

<available_skills>
{list}
</available_skills>"
    )
}

/// `skillContent`: the hidden-context body for an explicitly invoked
/// skill. `Err` when its file cannot be read or parsed.
pub fn skill_content(skill: &Skill) -> Result<String, String> {
    let text = js::read_text(Path::new(&skill.file))?;
    let body = parse_skill_file(&text)?.body;
    Ok(format!(
        "<skill name=\"{}\" location=\"{}\">\nRelative paths in this skill are relative to {}.\n\n{body}\n</skill>",
        escape(&skill.name),
        escape(&skill.file),
        crate::tools::js::dirname(&skill.file)
    ))
}

/// `features.skills.enabled !== false`.
fn enabled(agent: &Agent) -> bool {
    agent
        .config()
        .features
        .get("skills")
        .and_then(|settings| settings.get("enabled"))
        != Some(&Value::Bool(false))
}

/// `skillsFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(SkillsFeature::default())
}

#[derive(Default)]
struct SkillsFeature {
    /// The agent, once `init` ran (`current`); weak, since the agent owns
    /// its features.
    current: RefCell<Option<Weak<Agent>>>,
}

impl SkillsFeature {
    fn current(&self) -> Option<Rc<Agent>> {
        self.current.borrow().as_ref().and_then(Weak::upgrade)
    }

    /// `scan`: the installed skills and the problems found, or nothing
    /// before `init` or while skills are off.
    fn scan(&self) -> (Vec<Skill>, Vec<String>) {
        match self.current() {
            Some(agent) if enabled(&agent) => {
                let config = agent.config();
                discover_skills(&skill_roots(&config.config_dir, &config.project_root))
            }
            _ => (Vec::new(), Vec::new()),
        }
    }

    /// `invoke`: the skill as a visible custom message, then the request
    /// (or a plain "use it") as steering.
    fn invoke(agent: &Rc<Agent>, skill: &Skill, args: &str) -> Result<(), String> {
        agent.deliver(
            Delivery {
                custom_type: SKILL_MESSAGE.to_owned(),
                content: skill_content(skill)?,
                display: true,
                details: Some(json!({ "name": skill.name, "file": skill.file })),
            },
            false,
            false,
        )?;
        let request = if args.is_empty() {
            format!("Use the {} skill.", skill.name)
        } else {
            args.to_owned()
        };
        agent.steer(request, Vec::new());
        Ok(())
    }
}

impl Feature for SkillsFeature {
    fn name(&self) -> &'static str {
        "skills"
    }

    fn init<'a>(&'a self, agent: &'a Rc<Agent>) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            *self.current.borrow_mut() = Some(Rc::downgrade(agent));
            for problem in self.scan().1 {
                agent
                    .ui()
                    .notify(&format!("Skill skipped: {problem}"), NotifyLevel::Warning);
            }
            Ok(())
        })
    }

    /// The `commands` getter: `skill`, then `skill:<name>` per skill.
    fn commands(&self) -> Vec<FeatureCommand> {
        let (skills, _) = self.scan();
        if !self.current().is_some_and(|agent| enabled(&agent)) {
            return Vec::new();
        }
        let mut commands = vec![FeatureCommand::new(
            "skill",
            "List skills (/skill), or load one with /skill:<name> [request]",
        )];
        commands.extend(
            skills.into_iter().map(|skill| {
                FeatureCommand::new(format!("skill:{}", skill.name), skill.description)
            }),
        );
        commands
    }

    fn run_command<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
        name: &'a str,
        args: String,
    ) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let (skills, _) = self.scan();
            if let Some(wanted) = name.strip_prefix("skill:") {
                return match skills.iter().find(|skill| skill.name == wanted) {
                    Some(skill) => Self::invoke(agent, skill, &args),
                    None => Ok(()),
                };
            }
            // `args.split(/\s/, 1)[0]`.
            let first = args.split(js::is_space).next().unwrap_or_default();
            let skill = if args.is_empty() {
                None
            } else {
                skills.iter().find(|skill| skill.name == first)
            };
            if let Some(skill) = skill {
                // `args.slice(skill.name.length).trim()`: the name is ASCII.
                return Self::invoke(agent, skill, js::trim(&args[skill.name.len()..]));
            }
            let text = if skills.is_empty() {
                "No skills installed.".to_owned()
            } else {
                skills
                    .iter()
                    .map(|skill| format!("/skill:{} — {}", skill.name, skill.description))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            agent.ui().notify(&text, NotifyLevel::Info);
            Ok(())
        })
    }

    fn before_agent_start<'a>(
        &'a self,
        _agent: &'a Rc<Agent>,
    ) -> LocalBoxFuture<'a, Result<Option<BeforeStart>, String>> {
        Box::pin(async move {
            let prompt = skills_prompt(&self.scan().0);
            Ok((!prompt.is_empty()).then(|| BeforeStart {
                system_prompt: Some(PromptAddition::Text(prompt)),
                messages: Vec::new(),
            }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str, description: &str, file: &str) -> Skill {
        Skill {
            name: name.to_owned(),
            description: description.to_owned(),
            dir: crate::tools::js::dirname(file),
            file: file.to_owned(),
        }
    }

    #[test]
    fn lists_skills_escaped() {
        assert_eq!(skills_prompt(&[]), "");
        let prompt = skills_prompt(&[skill("a-b", "Use <x> & \"y\"", "/s/a-b/SKILL.md")]);
        assert!(prompt.starts_with("## Skills\n\nSkills are instructions"));
        assert!(prompt.ends_with(
            "<available_skills>\n  <skill>\n    <name>a-b</name>\n    <description>Use &lt;x&gt; &amp; &quot;y&quot;</description>\n    <location>/s/a-b/SKILL.md</location>\n  </skill>\n</available_skills>"
        ));
    }

    #[test]
    fn loads_a_skill_body() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("SKILL.md");
        std::fs::write(&file, "---\nname: pdf\ndescription: x\n---\n\n  Body.\n").unwrap();
        let file = file.display().to_string();
        let content = skill_content(&skill("pdf", "x", &file)).unwrap();
        assert_eq!(
            content,
            format!(
                "<skill name=\"pdf\" location=\"{file}\">\nRelative paths in this skill are relative to {}.\n\nBody.\n</skill>",
                dir.path().display()
            )
        );
        let missing = skill_content(&skill("gone", "x", "/nonexistent/gone/SKILL.md"));
        assert_eq!(
            missing.unwrap_err(),
            "ENOENT: no such file or directory, open '/nonexistent/gone/SKILL.md'"
        );
    }
}
