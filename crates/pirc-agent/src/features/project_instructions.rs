//! `project-instructions` (`agent/features/project-instructions.ts`):
//! per-project instructions (docs/guides/chat-projects.md), the text the user
//! wrote for every chat of a project, kept by the node and handed to the
//! agent on its configure line. Like USER/MEMORY it is frozen when the
//! chat starts: an edit reaches new chats only. It is shown after the chat
//! prompt and before USER/MEMORY, next to the other instructions
//! (AGENTS.md) rather than among the remembered facts, and its frozen text
//! keeps the prompt prefix stable for the provider's cache.
//!
//! The agent never writes it: the file is outside every session directory
//! and protected from the file tools and the sandbox
//! (`PIRC_PROJECT_INSTRUCTIONS`).

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::json;

use crate::LocalBoxFuture;
use crate::agent::Agent;
use crate::config::WorkspaceKind;
use crate::context::PromptSection;
use crate::feature::{BeforeStart, Feature, PromptAddition};
use crate::session_store::EntryData;
use crate::tools::js;

/// `PROJECT_INSTRUCTIONS_SNAPSHOT`.
pub const PROJECT_INSTRUCTIONS_SNAPSHOT: &str = "project.instructions";

/// `frozenInstructions`: the instructions this chat started with, frozen in
/// the session on its first run. `Err` when the snapshot cannot be
/// written.
pub fn frozen_instructions(agent: &Agent) -> Result<String, String> {
    let branch = agent.branch();
    let existing = branch.iter().rev().find_map(|entry| match &entry.data {
        EntryData::Custom { custom_type, data } if custom_type == PROJECT_INSTRUCTIONS_SNAPSHOT => {
            Some(data)
        }
        _ => None,
    });
    if let Some(data) = existing {
        // `String(data?.text ?? '')`.
        return Ok(match data.get("text") {
            None | Some(serde_json::Value::Null) => String::new(),
            Some(text) => js::string_of(text),
        });
    }
    // A chat that began before instructions existed keeps starting without them.
    let started = branch
        .iter()
        .any(|entry| matches!(entry.data, EntryData::Message(_)));
    let text = if started {
        String::new()
    } else {
        js::trim(agent.project_instructions().unwrap_or_default()).to_owned()
    };
    agent.append_entry(EntryData::Custom {
        custom_type: PROJECT_INSTRUCTIONS_SNAPSHOT.to_owned(),
        data: json!({ "text": text }),
    })?;
    Ok(text)
}

/// `renderInstructions`.
pub fn render_instructions(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    [
        "## Project instructions",
        "",
        "The user wrote these for every chat in this project. Follow them unless the user says otherwise in this chat.",
        "",
        text,
    ]
    .join("\n")
}

/// `projectInstructionsFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(ProjectInstructionsFeature::default())
}

#[derive(Default)]
struct ProjectInstructionsFeature {
    /// The rendered section, once the first run read it.
    section: RefCell<Option<String>>,
}

impl Feature for ProjectInstructionsFeature {
    fn name(&self) -> &'static str {
        "project-instructions"
    }

    fn before_agent_start<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
    ) -> LocalBoxFuture<'a, Result<Option<BeforeStart>, String>> {
        Box::pin(async move {
            if agent.config().workspace_kind != WorkspaceKind::Chat {
                return Ok(None);
            }
            let cached = self.section.borrow().clone();
            let section = match cached {
                Some(section) => section,
                None => {
                    let section = render_instructions(&frozen_instructions(agent)?);
                    *self.section.borrow_mut() = Some(section.clone());
                    section
                }
            };
            if section.is_empty() {
                return Ok(None);
            }
            let mut prompt = PromptSection::new(
                "project-instructions",
                "Project instructions",
                "node:project-instructions",
                section,
            );
            prompt.frozen = Some(true);
            Ok(Some(BeforeStart {
                system_prompt: Some(PromptAddition::Sections(vec![prompt])),
                messages: Vec::new(),
            }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_instructions_only_when_there_are_some() {
        assert_eq!(render_instructions(""), "");
        assert_eq!(
            render_instructions("Be brief."),
            "## Project instructions\n\nThe user wrote these for every chat in this project. Follow them unless the user says otherwise in this chat.\n\nBe brief."
        );
    }
}
