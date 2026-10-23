# Prompt configuration and Context snapshots

This reference preserves the implemented contracts from the completed 2026-10-02 prompt-customization plan (baseline `main@69ae62c`), checked against the Context types and transport. Upgrade requirements are in [Upgrades](../deploy/upgrades.md).

## Two kinds of prompt

The same agent loop (`crates/pirc-agent`) runs in two hosts, and each puts its system prompt together differently (`HostProfile` in `crates/pirc-agent/src/host.rs`).

**Workers** (coding sessions on a node, `HostProfile::Worker`) take their sections from the workspace's mode: the base coding instructions, the global, workspace and project AGENTS.md, and the mode's body (`load_agent_config`). The agent adds what its features contribute for the run, the hook output of `sessionStart`, the capability index of the `ptc` surface and the working directory. There is no configurable section ordering. Edits apply at the next agent start, not immediately to running agents. A worker gets none of the brain's sections. What it is handed comes in its task message, not in the system prompt: the task, then the facts and loops the brain named, with where each came from, under `## Context from the assistant` (`details.context`; [workers](memory.md#workers)).

**The brain** (`HostProfile::Brain`, plans/rewrite/02-brain-host.md) runs in the gateway and speaks in rooms. Its sections are rebuilt before every turn (`crates/pirc-gateway/src/brain/identity.rs`) and handed to the agent with `Agent::set_base_prompt`, which replaces the base sections in place (there is no `fresh_each_turn` flag). A changed file therefore applies to the next turn, never to one already running:

| Section              | Source                                                                                                    | Without it                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `soul`               | `SOUL.md` in the gateway's `PIRC_CONFIG_DIR`                                                              | a built-in household-assistant identity                         |
| `room`               | built-in: the room's name and how batches read                                                            | always present                                                  |
| `face`, `face-rules` | built-in: the face it speaks as now and the other faces, and the default "Faces" rules (`brain/faces.rs`) | always present (plans/rewrite/10-faces.md)                      |
| `wake`, `wake-rules` | built-in: waking up, and the default "When to speak after waking" (`brain/waking.rs`)                     | only in a wake turn (plans/rewrite/05-self-wake.md)             |
| `chat-md`            | `CHAT.md` in the gateway's `PIRC_CONFIG_DIR`                                                              | left out                                                        |
| `memory:preferences` | built-in: the turn's people's preferences (`crates/pirc-gateway/src/brain/memory.rs`)                     | always present (says none yet)                                  |
| `loops`              | built-in: the time now and every open loop (`crates/pirc-gateway/src/brain/loops.rs`)                     | always present (says none)                                      |
| `memory:recalled`    | built-in: "You may remember", the facts closest to what was said                                          | left out when nothing matches, or recall took over 200 ms       |
| `workers`            | built-in: what workers are, the workspaces they can go to, those not done (`brain/worker_tools.rs`)       | always present (says when no workspace exists)                  |
| `sources`            | built-in: the sources by id, paused or failing, and which this room follows (`brain/source_tools.rs`)     | left out when no source was added (plans/rewrite/09-sources.md) |
| `move`               | built-in: suggest continuing the topic in the room that covers it (`brain/moving.rs`)                     | only in the turn after a topic passed the guards, once a day    |

Each file is at most 8000 characters. The brain gets no AGENTS.md, skills, hooks, capability index or working directory: it has no workspace, and its tools (`web_search` with `EXA_API_KEY`; `remember`, `memory_search`, `recall_note`, `save_preference`, `forget` and observational memory's `recall`, plan 03; `open_loop`, `close_loop`, `touch_loop`, `update_loop`, `reopen_loop`, plan 04; `schedule_wake`, `cancel_wake`, and in a wake turn only `speak`, plan 05; `call_worker`, `worker_status`, `stop_worker`, plan 06; `answer_worker_question`, plan 07; `workspace_read`, plan 08; `email_*`, `calendar_*`, `moodle_*`, `source_search` and `room_sources`, plan 09, the tools of kinds no source has hidden; `speak_as`, `topic`, `create_face`, `update_face`, `move_room`, `create_room` and `archive_room`, plan 10) are direct tools; a wake turn hides the tools that act for people (`stop_worker`, `answer_worker_question`, `room_sources`, `create_face`, `update_face`, `move_room`, `create_room`, `archive_room`, and `topic`; `Agent::set_hidden_tools`). A project's face sees its own open loops first, marked `yours`, and its linked workspaces first in `workers`. The `workers` section also lists the machines (OS, GPUs, agents running of how many) and the red-line questions waiting for an answer. How a room's workers ended since its last turn comes after what people said, as `worker-report` custom messages. The memory and loop sections come last, so the persona and rules stay a stable prefix ([memory](memory.md)). `GET /api/brain/prompts` and `PUT /api/brain/prompts/:name` read and write the files unless they are read-only (a Nix store link, a symlink or file permissions).

## Section and snapshot contracts

`crates/pirc-agent/src/context.rs` defines `PromptSection`: `id`, `title`, `source`, optional `frozen`, and `text`. Sections join with blank lines; trimming preserves interior whitespace. Features can supply section arrays or a string wrapped with their feature source. Sectioning is for inspection, not permission to reorder or rewrite the provider prompt.

A version-1 `ContextSnapshot` records an ID, timestamp, request model/context window, sections with estimated tokens, the actual provider tool specifications with estimates, optional internal capability metadata, and input-usage buckets. The hybrid surface's provider tools and script capabilities are distinct: capability metadata is not an extra provider schema list.

Estimates use the message estimator. Observational-memory tokens are allocated out of compaction-summary messages, bounded by their size, rather than counted twice. Matching provider usage supplies reported input including cache reads/writes, not output; the scale is reported input divided by estimated input. Remaining space uses the snapshot's request model window. These are approximate allocations, not exact tokenizer attribution.

## Node-local storage and relay

The agent retains `lastContext` and atomically replaces `<sessionDir>/context.json` with a mode-0600 exclusive temporary file and rename. The duplicated prompt and tool content is not appended to `session.jsonl`. Snapshots contain prompt/tool information, not raw conversation or provider credentials. They are removed with the session directory; there is no additional automatic retention policy.

Agent RPC `get_context` returns the live snapshot only below its bounded size allowance (at most 512 KiB). Node `GET /api/sessions/:id/panel/context` tries the live runner with an allowance below the RPC line limit, then falls back to the disk snapshot for large, stopped or older agents. Missing context returns `404 no_context` with a send-a-message-first explanation. The gateway relays under the existing session authorization and does not store the snapshot. Context updates use `panel_changed`.

The brain keeps one snapshot per room in `$PIRC_STATE_DIR/brain/rooms/<room>/context.json`, read by `GET /api/brain/context?room=` (`null` before its first model call).

The web Context panel shows sections, sources, frozen badges, tool definitions and usage. Workspace-readable sources can link to Files; global configuration sources are plain text. Copy all returns the joined prompt. Disk snapshots are labeled with their timestamp, not presented as freshly loaded configuration. Editing/reordering prompts from the inspector is not supported. Native Android inspector scope remains a [backlog decision](../../plans/README.md).

## Regression expectations and provenance

The completed design required byte-preserving section joins; usage allocation without memory double counting; and node-local stopped-agent fallback. These are preservation requirements, not a claim that this documentation change reran the suites.

The original plan's source investigation and tentative API descriptions are not new implementation authorization.
