//! Workspace modes: what a workspace's kind allows, as data.
//!
//! Every behavior that used to branch on `kind == Chat` asks a [`Mode`]
//! capability instead, so the code names *what* it needs (a per-session
//! working directory, the assistant's memory, delegation, …) rather than
//! which of two hard-coded kinds it is in. Phase 1 (plans/modes.md) keeps
//! the two built-in modes, [`CHAT`] and [`WORK`], equal to the former chat
//! and directory behavior; later phases load modes from the gateway's
//! configuration.
//!
//! A capability only ever *grants*; an unknown or missing mode must never
//! fall back to a wider one.

use crate::{NodeRole, WorkspaceKind};

/// Where a session's tools run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Workdir {
    /// The workspace directory itself (a repository).
    Workspace,
    /// `sessions/<id>` under the workspace, created per session.
    PerSession,
}

/// Which built-in system prompt a session gets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptStyle {
    /// The coding base prompt and the global/workspace/project `AGENTS.md`.
    Coding,
    /// `SOUL.md` (or the built-in persona), the chat environment, `CHAT.md`.
    Assistant,
}

/// How much of the gateway's assistant state a session reaches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssistantAccess {
    /// The approved USER entries only; memory operations are refused.
    User,
    /// USER and MEMORY, writes included, and the user's capability policy.
    Full,
}

/// Which workspaces a session's schedules may target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleScope {
    /// Its own workspace only.
    Own,
    /// Any directory workspace that is a delegation target, and its own.
    Any,
}

/// What a workspace of this mode can do. See plans/modes.md for the table
/// of the call sites each field replaced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mode {
    /// The stored and wire name (`workspaces.kind`, `PIRC_WORKSPACE_KIND`).
    pub id: &'static str,
    /// The only node role that may host workspaces of this mode.
    pub node_role: NodeRole,
    pub workdir: Workdir,
    pub prompt: PromptStyle,
    /// Agent features (`features.<key>`) that are off unless the node's
    /// config sets `enabled: true` explicitly.
    pub features_off: &'static [&'static str],
    pub assistant: AssistantAccess,
    /// May hand tasks to other workspaces with `delegate`.
    pub delegate: bool,
    /// May receive delegated tasks and be targeted by others' schedules.
    pub delegate_target: bool,
    pub schedule_scope: ScheduleScope,
    /// Has user-edited project instructions (`INSTRUCTIONS.md`).
    pub project_instructions: bool,
    /// Has uploaded project files (`files/`).
    pub project_files: bool,
    /// Reads a repository `.pirc/config.json`, behind project trust.
    pub project_config: bool,
    /// Keeps a workspace-memory ledger keyed by its repository.
    pub workspace_memory: bool,
    /// Is a repository: its `origin` is detected, and projects link to it.
    pub repository: bool,
    /// `/recap` reviews its sessions.
    pub recap: bool,
    /// The user may delete single sessions.
    pub delete_sessions: bool,
    /// Its workspaces other than the node's default one are projects: they
    /// can be linked to repositories and deleted.
    pub projects: bool,
}

/// The former `directory` kind: coding sessions in a repository.
pub const WORK: Mode = Mode {
    id: "directory",
    node_role: NodeRole::Node,
    workdir: Workdir::Workspace,
    prompt: PromptStyle::Coding,
    features_off: &[],
    assistant: AssistantAccess::User,
    delegate: false,
    delegate_target: true,
    schedule_scope: ScheduleScope::Own,
    project_instructions: false,
    project_files: false,
    project_config: true,
    workspace_memory: true,
    repository: true,
    recap: true,
    delete_sessions: false,
    projects: false,
};

/// The former `chat` kind: the personal assistant's chats and projects.
pub const CHAT: Mode = Mode {
    id: "chat",
    node_role: NodeRole::Chat,
    workdir: Workdir::PerSession,
    prompt: PromptStyle::Assistant,
    // Their tools cost context a personal assistant rarely needs, and chats
    // hand real work to a workspace with `delegate` (docs/architecture/assistant-memory.md).
    features_off: &["goal", "todo", "agentTeam", "background"],
    assistant: AssistantAccess::Full,
    delegate: true,
    delegate_target: false,
    schedule_scope: ScheduleScope::Any,
    project_instructions: true,
    project_files: true,
    project_config: false,
    workspace_memory: false,
    repository: false,
    recap: false,
    delete_sessions: true,
    projects: true,
};

impl WorkspaceKind {
    /// The built-in mode of this kind.
    pub const fn mode(self) -> &'static Mode {
        match self {
            Self::Directory => &WORK,
            Self::Chat => &CHAT,
        }
    }
}

impl Mode {
    /// Whether `feature` is off in this mode unless explicitly enabled.
    pub fn feature_off(&self, feature: &str) -> bool {
        self.features_off.contains(&feature)
    }

    /// Whether sessions reach the assistant's MEMORY and capabilities.
    pub fn full_assistant(&self) -> bool {
        self.assistant == AssistantAccess::Full
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_modes_match_their_kinds() {
        assert_eq!(WorkspaceKind::Chat.mode(), &CHAT);
        assert_eq!(WorkspaceKind::Directory.mode(), &WORK);
        for kind in [WorkspaceKind::Chat, WorkspaceKind::Directory] {
            let wire = serde_json::to_value(kind).unwrap();
            assert_eq!(wire, kind.mode().id);
            assert_eq!(
                kind.mode().node_role == NodeRole::Chat,
                kind == WorkspaceKind::Chat
            );
        }
    }

    /// The pairs that must never meet in one mode (plans/modes.md).
    #[test]
    fn built_in_modes_are_consistent() {
        for mode in [&CHAT, &WORK] {
            // Assistant memory next to a repository's content.
            assert!(!(mode.full_assistant() && mode.workdir == Workdir::Workspace));
            // Delegating to yourself.
            assert!(!(mode.delegate && mode.delegate_target));
            // Workspace memory is keyed by the repository.
            assert!(!mode.workspace_memory || mode.repository);
            // A project config is a repository's file.
            assert!(!mode.project_config || mode.repository);
            // Scheduling anywhere is a delegation.
            assert!(mode.schedule_scope == ScheduleScope::Own || mode.delegate);
        }
    }
}
