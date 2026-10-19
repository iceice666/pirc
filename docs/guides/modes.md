# Workspace modes

[Guides](README.md) · [Implementation plan](../../plans/modes.md)

Workspace modes are gateway-managed combinations of capabilities, prompt
sections, features and tools. Chat and Work are default files, not reserved
built-in kinds. Gateway and nodes must run **protocol 12 together**.

Web and Android still show the existing Chat / Work interface; catalog-driven
client navigation belongs to phase 3. Use the API to create a workspace in a
custom mode. Existing clients keep their default behavior.

## Configuration ownership

Modes belong to the gateway host's `$PIRC_CONFIG_DIR/modes/<id>.md`, not a
repository's `.pirc/`. The gateway distributes validated definitions to nodes
after registration and on SIGHUP. Agents receive a validated JSON snapshot in
`PIRC_MODE` and never read mode files.

At first startup the gateway creates `chat.md` and `directory.md` only when
the modes directory is absent, with private `0600` files. An existing directory,
including an empty or read-only Nix-provided one, is authoritative. Edits and
deletions are never undone. Invalid files are skipped individually; diagnostics
include the source path and validation rule. A directory-level reload failure
keeps the last catalog and logs the error.

An initialization I/O failure may leave an incomplete newly created directory.
It remains authoritative: inspect and finish its files, or explicitly remove
that directory before retrying initialization. The library does not delete
configuration or silently restore defaults. Initialization errors stop gateway
startup before the listening port is opened.

Keep gateway configuration and symlinked mode sources outside every agent
write root. Prefer separate gateway/node accounts or hosts, or read-only Nix
store targets. On a colocated same-account deployment with different config
directories, the node cannot discover the gateway's private source paths;
explicitly deny writes to them in the node sandbox policy. Node-local config
mode paths and existing symlink targets are write-protected at agent start;
restart sessions after adding or redirecting configuration symlinks.

Compare shipped defaults after an upgrade with
`pirc-gateway modes --print-defaults`; this requires no credentials and writes
no configuration. `GET /api/modes` lists the validated catalog.

## File format

The filename supplies the id (`[a-z][a-z0-9_-]{0,39}`); no id is reserved.
Front matter supplies capabilities, and the Markdown body supplies the mode's
own instructions. `id` and `body` are not allowed in front matter.

For example, save this as `research.md` on the gateway:

```yaml
---
label: Research
description: Research sessions without delegation.
ui:
  group: chat
  noun: research session
workdir: per-session
prompt: [soul, chat-env, chat-md, body]
features_off: [goal, todo, agentTeam, background]
features_on: []
tools: [read, find, grep, ls, web_search, web_fetch]
assistant: full
delegate: false
delegate_target: false
schedule_scope: own
project_instructions: true
project_files: true
project_config: false
workspace_memory: false
repository: false
recap: false
delete_sessions: true
projects: true
---
Cite sources and distinguish evidence from inference.
```

### Node acceptance and creation

Nodes accept mode **ids**, not definitions: set `PIRC_MODES=chat,research` on a
chat node or `PIRC_MODES=directory,research` on a coding node, then restart that
node. Without an override, a chat node accepts only `chat`, a coding node only
`directory`. An explicitly empty `PIRC_MODES` accepts none. Duplicate or
malformed ids are errors. A node cannot grant itself capabilities by accepting
an id: the gateway must supply its definition.

Reload the gateway with SIGHUP, then create a workspace:

```http
POST /api/workspaces
Content-Type: application/json

{"nodeId":"my-node","mode":"research","displayName":"Research"}
```

For `workdir: workspace`, include an existing `path`, as for a Work workspace.
`PIRC_WORKSPACES` entries can also set `mode` (default `directory`). The node
must explicitly accept every configured workspace's mode. The API rejects
unknown modes and modes the target node does not accept. Legacy `kind` remains
an accepted creation alias; conflicting `mode` and `kind` are rejected. For
legacy callers omitting both, an existing `path` requests `directory` regardless
of node role; a name-only request is invalid. Include `mode` or `kind` explicitly
to create a per-session workspace.

For a review mode, copy `directory.md` to `review.md`, change its display
metadata and set `tools: [read, find, grep, ls]`. Add `review` to the node's
`PIRC_MODES`, reload the gateway and create a workspace with mode `review` and
a repository path. Select **read-only** approval separately through the
node/session settings; a mode never silently changes approvals.

### Fields

| Field                                   | Meaning / validation                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`                                 | Required nonblank display name, at most 100 characters.                                                                                            |
| `description`                           | Optional description, at most 500 characters.                                                                                                      |
| `ui`                                    | Required presentation hints: nonblank `group` and `noun`, optional nonblank `icon`; each at most 100 characters. Clients do not consume these yet. |
| `workdir`                               | Required `per-session` or `workspace`.                                                                                                             |
| `prompt`                                | Required ordered list of 1–8 unique named sections, listed below. A nonempty Markdown body requires `body` in this list.                           |
| `features_off`, `features_on`           | Optional lists of known feature configuration keys. A key cannot appear twice or in both lists.                                                    |
| `tools`                                 | Optional operation allowlist, at most 64 known unique names. Absent or `null` means unrestricted; `[]` means no operations.                        |
| `assistant`                             | Required `user` (approved USER entries) or `full` (full assistant state).                                                                          |
| `delegate`, `delegate_target`           | May initiate delegation / receive delegated work. Default false.                                                                                   |
| `schedule_scope`                        | Required `own` or `any`.                                                                                                                           |
| `project_instructions`, `project_files` | User-managed project instructions / shared uploaded files. Default false.                                                                          |
| `project_config`, `workspace_memory`    | Repository configuration / workspace-memory ledger. Default false.                                                                                 |
| `repository`                            | Repository identity and linking capability. Default false.                                                                                         |
| `recap`, `delete_sessions`, `projects`  | Session recap / individual session deletion / project workspaces. Default false.                                                                   |

String bounds count UTF-16 code units, matching role instruction limits. The
Markdown body is limited to 8,000 units. Unknown schema fields, unknown enum
values, duplicate explicit YAML keys (also in nested mappings), unsupported
tags, non-string mapping keys and nonfinite numbers are errors. Required
metadata must be one YAML mapping, not a scalar or sequence. Skill and role
files retain their existing permissive parser semantics.

Prompt section names are `base`, `agents:global`, `agents:workspace`,
`agents:project`, `soul`, `chat-env`, `chat-md`, and `body`. Sections render in
order; unselected files are not read. Default Chat and Work section lists
preserve the former prompt text and section metadata.

Selectable feature configuration keys are `sessionTitle`, `todo`,
`observationalMemory`, `skills`, `browser`, `webSearch`, `schedules`,
`background`, `agentTeam`, and `goal`. These are not runtime hook names.
`autoMode` is deliberately excluded: modes do not choose approvals. Explicit
node `enabled: false` wins over mode defaults; explicit `enabled: true` can
bring back a default-off feature. Otherwise `features_on` enables and
`features_off` disables it, and a key in neither follows the node configuration.
Feature readiness requirements (such as an available browser or gateway) still
apply.

Known operation names are defined in
[`pirc-protocol/src/mode.rs`](../../crates/pirc-protocol/src/mode.rs).
A mode's tool list is a ceiling: CLI/role lists and recorded role changes are
intersected with it, never widened; team/subagent children receive the parent's
validated snapshot. PTC wrappers (`ptc`, `ptc_docs`) are not allowlist operations
and are rejected as entries; operations inside scripts remain restricted.

### Forbidden capability combinations

Loading or deserializing a mode refuses:

- `assistant: full` with `workdir: workspace`.
- `delegate` together with `delegate_target`.
- `workspace_memory` or `project_config` without `repository`.
- `schedule_scope: any` without `delegate`.
- `projects` with `workdir: workspace`.
- `project_files` or `project_instructions` with `repository`.

## Reload and unavailable workspaces

SIGHUP reloads models and modes independently. When a definition changes or
disappears, the node stops affected running agents and their terminals, and
cancels in-flight inference. A subsequent allowed action starts an agent with
the new snapshot. A missing/invalid mode makes the workspace unavailable:
no new sessions or session mutations, but existing history remains readable.
Stopping a session remains allowed. Restoring a valid file and reloading makes
the mode available again; defaults are never silently restored.

Changing a mode's working-directory strategy does not move existing data.
Per-session workspaces must remain in node-managed `state/chat/<id>`;
workspace-directory modes cannot reinterpret that managed state as a repository.
An incompatible existing layout is refused, not migrated or widened. Create a
new workspace with the desired mode/layout instead.

The existing SQL `workspaces.kind` column now stores mode ids; no schema change
or data migration is needed. Syntactically invalid historical values fail
closed with a database error rather than being converted to Work. Valid ids
missing from the catalog retain unavailable/read-only behavior.
