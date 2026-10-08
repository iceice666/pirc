# Agent configuration

[User guides](README.md) · [All documentation](../README.md)

The built-in agent (`apps/gateway/src/agent/`) is configured in three layers. **Models (gateway)** and credentials are documented in [Model backends](./model-backends.md); node and project settings follow:

- **Node**: `~/.config/.pirc/config.json` on each node (override the directory with `PIRC_CONFIG_DIR`) holds limits, features, hooks, `env`, `allowedPaths` and `sandbox`. Coding rules go in `AGENTS.md` in the same directory. Chats instead use global `SOUL.md` (persona) and `CHAT.md` (general rules), editable in Settings → Assistant when the files are writable. Changes apply at the next agent start; move chat-relevant rules out of `AGENTS.md` when upgrading.
- **Project**: `<workspace>/.pirc/config.json` can only add `allowedPaths`, `env`, `hooks`, and a `defaultModel` (which must name one of the gateway's models). Its `allowedPaths`, `env` and `hooks` are ignored until you trust them in the workspace's Settings (trust is tied to their content, so a later change needs trusting again), and its `allowedPaths` never widen the sandbox. `<workspace>/.pirc/AGENTS.md` is appended to the system prompt, and `<workspace>/.pirc/roles/<name>.md` adds or replaces roles. The agent cannot write to any `.pirc/` directory.

## Agent sandbox

A node starts every agent inside [srt](https://github.com/anthropic-experimental/sandbox-runtime) (Seatbelt on macOS, bubblewrap with a seccomp filter on Linux). The agent's tools, shells, `ptc` scripts, hooks, teammates and subagents all run inside it. The file tools apply the same rules, so they refuse what the sandbox would:

- **Reads** work anywhere except credential stores (`~/.ssh`, `~/.gnupg`, cloud and git credentials, keychains, browser profiles) and the node's own state (other sessions, uploads, its database, browser profiles, its credentials).
- **Writes** go only to the workspace (or a chat's own directory), the node's `allowedPaths`, the session's temporary directory, `/tmp` and build caches. `.pirc/`, git hooks, `.git/config` and shell startup files stay read-only.
- **Network** goes through a filtering proxy. Only common code hosts and package registries are allowed, plus hosts you add. When a task needs another host, the agent calls `sandbox_allow_domains` and the node asks you. An approved host stays allowed for the rest of the session.
- **Outside the sandbox**: for what the sandbox blocks (a nix build, changing the system), the agent calls `unsandboxed_bash`. The node asks you first, then runs the command with the node account's permissions, but without the node's own secrets. `gh` and pushing with git (HTTPS or SSH) can work inside the sandbox once the node is set up for them: see [Git and the GitHub CLI](../deploy/sandbox-and-browser.md#git-and-the-github-cli).

The node itself asks for both approvals, not the agent: nothing the agent says counts as your answer. Teammates and subagents share the sandbox; their requests go through the agent that started them and name who is asking.

Set it in the node's `config.json` (never a project's):

```json
{
  "sandbox": {
    "network": {
      "defaultDomains": true,
      "allowedDomains": ["api.example.com", "*.internal.example.org", "127.0.0.1:8080"],
      "deniedDomains": [],
      "allowLocalBinding": true,
      "allowUnixSockets": []
    },
    "filesystem": {
      "denyRead": ["~/.local/pirc-node"],
      "allowRead": [],
      "allowWrite": [],
      "denyWrite": [],
      "allowGitConfig": false
    }
  }
}
```

Notes on these settings:

- If the `sandbox` settings are invalid, the defaults stay in force and the session shows a warning.
- Put the directory holding the node's own env file (with `PIRC_NODE_TOKEN`) in `denyRead` when it sits outside `PIRC_STATE_DIR`.
- The node runs the srt built into its executable (`pirc-node srt`); `PIRC_SANDBOX_SRT` names an external one instead, as the Nix package does. Linux hosts still need bubblewrap, socat and ripgrep.
- The sandbox cannot be turned off. When srt cannot sandbox on the host, no agent starts and prompts fail with the reason; for example, Linux may refuse unprivileged user namespaces (Ubuntu 24.04 needs `kernel.apparmor_restrict_unprivileged_userns=0`). `PIRC_SANDBOX=off` makes the node refuse to start.

The sandbox does not cover `web_fetch`, the `browser_*` tools or `web_search`: the node's browser and the gateway run those, so they remain a way to send data out, like anything sent to the model.

## Skills, recap and hooks

- **Skills**: [Agent Skills](https://agentskills.io) — directories holding a `SKILL.md` (YAML front matter with `name` and `description`, then instructions, plus any scripts or references it points to) — loaded from, lowest precedence first: `~/.agents/skills/` (a personal skill directory shared across agent harnesses such as OpenClaw and Hermes; every session on the node), `$PIRC_CONFIG_DIR/skills/` (every session on the node, chats included), and `<workspace>/.pirc/skills/` (that project). A later source wins on a name clash. Only each skill's name, description and path go in the system prompt; the model reads the skill when a task matches. `/skill:<name> [request]` loads one explicitly and `/skill` lists them. Skill directories, including symlinked ones, are readable but not writable by the file tools; a skill added after a session's agent started is listed at once, but if it is a symlink (or the directory did not exist yet) its files become readable only in a new session. Invalid skills are skipped with a warning. `features.skills.enabled: false` turns skills off.

- **Project recap**: `/recap` reviews a bounded sample from the last 14 days of this directory workspace (at most 20 sessions); `/recap 7` changes the window, and `/recap --days 14 focus on skills` adds a focus. Only the same owner's sessions in the exact workspace are eligible, not other projects or worktrees. The current session, scheduled runs and recap-marked sessions are excluded. The report proposes skills, project rules, role/settings changes or workflow improvements with source session/entry references, comparing the available current configuration. It never applies changes. Evidence is collected by the node and sent transiently to the session's configured model in a separate, **no-tools** request; it is not added to chat history or gateway storage. Only the report is recorded, and it is excluded from observational-memory extraction. Thinking, images and tool arguments/results are not included; tool names and error flags may be sampled. Oversized, unsafe or unreadable transcripts are skipped, with coverage and sampling limitations reported. This is not a complete transcript audit or a guarantee of secret removal; text excerpts still go to the configured model. Chat workspaces and headless agents do not offer this command.

Hooks (`sessionStart`, `beforePrompt`, `beforeTool`, `afterTool`, `agentSettled`) are shell commands that receive JSON on stdin. A `beforeTool` hook can reject a tool call (exit 2) or rewrite its arguments. Hooks run for each operation, whether the model calls it directly or from a `ptc` script, and for the `ptc` call itself; a matcher naming the retired `code` tool applies to `ptc`, with a warning.

## Tools and workflows

See [Tools and workflows](./tools.md), [Browser](./browser.md), [Schedules and notifications](./schedules.md), and [Chat projects](./chat-projects.md).
