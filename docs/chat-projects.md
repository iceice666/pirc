# Chat projects: capabilities and instructions

A chat project is a chat workspace on the chat node (`PIRC_CHAT=1`): the top-level **Chats** workspace, or one you created with **New project** in the web app (see [`apps/gateway/README.md`](../apps/gateway/README.md)). Each chat project has two settings of its own, both under **Settings → Projects** in the web app:

- **Capabilities** turn off assistant features for every chat in the project. The gateway enforces them.
- **Instructions** are text that every new chat in the project gets in its system prompt. The node stores them.

Directory workspaces (repositories) have neither setting.

Both are also available through the gateway API, with the same authentication as the rest of the browser API (forward auth through your proxy, or a device token). Workspace IDs are `<nodeId>:<workspaceId>`, as listed by `GET /api/workspaces`. Encode the `:` as `%3A` in URLs.

## Capabilities

| Capability      | When turned off, chats in the project…                                                                                                            | Gateway operations refused |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `delegation`    | lose `delegate` and `delegation_status`, and the list of workspaces in their system prompt                                                        | `delegation.*`             |
| `memory_search` | lose `memory_search` (searching your coding sessions' workspace memory and delegation reports)                                                    | `memory.search`            |
| `remote_recall` | can no longer use `recall` to open notes held on other nodes; `recall` on the chat's own memory still works                                       | `recall.remote`            |
| `schedules`     | lose the `schedule` tool and the `/cron` command; schedules that would run in this project cannot be created, changed, resumed or run (see below) | `schedule.*`               |
| `web_search`    | lose `web_search`; `web_fetch` and the `browser_*` tools are not affected (see [Limits](#limits))                                                 | `web.search`               |

All capabilities are allowed by default. A project whose capabilities you never changed behaves exactly as before, and upgrading needs no migration.

The gateway enforces them, not the agent. Every gateway operation a chat makes is checked against the project's current policy, so an agent cannot get around a switch by calling an operation directly. A refused operation fails with a `capability_disabled` error that says which capability is off, and the agent tells you. If a chat tries a tool that was turned off after it started, the call fails with an error naming the capability.

### Changing capabilities

In the web app, open **Settings → Projects**, pick the project, and flip the switches. Each change is saved to the gateway as soon as you make it.

Through the API, for example to stop a project from delegating:

```sh
curl -X PATCH 'https://pirc.example.org/api/workspaces/chat%3Aworkspace_1234/capabilities' \
  -H 'Authorization: Bearer pirc_dev_…' \
  -H 'Content-Type: application/json' \
  -d '{"capabilities": {"delegation": false}}'
```

```json
{
  "capabilities": {
    "version": 1,
    "delegation": false,
    "memory_search": true,
    "remote_recall": true,
    "schedules": true,
    "web_search": true
  }
}
```

`GET` on the same URL returns the current policy. A `PATCH` changes only the capabilities it names. Unknown names, values that are not booleans, and a `version` other than `1` are rejected with `400`, and so is a `PATCH` for a directory workspace.

### What happens to work already in progress

Turning a capability off takes effect at the gateway right away. Running chats also stop being offered the tools on their next run, and `/cron` checks the gateway before it acts.

- **Proposals waiting for approval.** A delegation or schedule a chat proposed before the change can no longer be approved: approving it fails with `capability_disabled`. You can still reject it.
- **Approved delegations not yet started.** They are checked again before the gateway starts the target session and before it hands over the task. If the capability is off by then, the delegation fails and nothing is sent.
- **Existing schedules.** A schedule that runs in the project, or that one of its chats created, is checked each time it would run. At a timed run, it records a failed run and pauses the schedule. When you run it now or allow a missed run, it refuses with the error. You cannot resume it or change it to run in the project while `schedules` is off. After turning `schedules` back on, resume the schedule yourself.
- **Already done.** Delegations already handed over, runs already started, and anything already in a chat's history are not undone. Turning a capability off does not cancel, delete or hide that work.

### Teammates and subagents

A chat's teammates and subagents get the project's policy as it stands when they start. Their tools are the ones allowed by **both** the project policy and their kind's `tools` allowlist (`features.agentTeam.kinds`). A kind cannot give back a capability the project turned off. (Today teammates and subagents have no gateway access at all, so they could not use these features even with the capability on.)

## Instructions

Project instructions are standing instructions you write for one project, for example "Answer in French" or "This project is about planning a kitchen renovation; keep a running budget table". They differ from the other places the assistant gets context:

- **`AGENTS.md`** in the node's config directory (`$PIRC_CONFIG_DIR/AGENTS.md`) applies to every session on the node, chats and repositories alike. Project instructions apply only to that project's chats.
- **USER and MEMORY** (Settings → Memory) are the assistant's memory of you. They are shared by all chats, the assistant proposes or writes them, and you review them. The assistant never writes project instructions. They change only when you edit them, and they do not change what is in memory.

### Editing

In the web app, open **Settings → Projects** and pick the project. The instructions editor is below the capability switches. It shows a character count against the limit and saves when you press **Save**.

Through the API:

```sh
curl 'https://pirc.example.org/api/workspaces/chat%3Aworkspace_1234/instructions' \
  -H 'Authorization: Bearer pirc_dev_…'

curl -X PATCH 'https://pirc.example.org/api/workspaces/chat%3Aworkspace_1234/instructions' \
  -H 'Authorization: Bearer pirc_dev_…' \
  -H 'Content-Type: application/json' \
  -d '{"text": "Answer in French. Keep a running budget table."}'
```

Both return `{"instructions": {"text": "…", "maxChars": 8000}}`.

- **Limit:** 8,000 characters. Longer text is refused with `413`, and the saved instructions stay as they were.
- **Removing them:** save empty text. This deletes the file.
- **The node must be online.** Otherwise the gateway answers `503`.

### Where they are stored

The chat node stores the instructions in `<stateDir>/chat/<workspaceId>/instructions.md`, with mode `0600`. `<stateDir>` is the node's `PIRC_STATE_DIR`, and `<workspaceId>` is the node-local ID, without the `<nodeId>:` prefix. The gateway only relays your edit to the node and stores nothing: the text is not in the gateway's database or its memory. It does travel through the gateway when you edit or view it.

### When a change takes effect

The instructions are **frozen when a chat first runs**, just like USER and MEMORY. That chat keeps the text it started with for the rest of its life, and an edit reaches **new chats only**. Chats that had already started before this feature was installed keep running without project instructions, even after you write some; start a new chat to use them. A chat's teammates and subagents follow the instructions the chat started with.

### Where they appear in the prompt

They come after the chat prompt and `AGENTS.md`, and before USER/MEMORY, under the heading `## Project instructions`. The assistant is told to follow them unless you say otherwise in that chat.

### Who can change them

- **File tools** (`write`, `edit`, and the same calls from `code`) cannot write the file. It is outside every chat's working directory, and it is on the agent's protected paths, so writes are refused even if you add its directory to `allowedPaths`.
- **In the [agent sandbox](../README.md#agent-sandbox)**, the node's state directory can be neither read nor written. The instructions file is also on the sandbox's write-deny list, so bash, `code` scripts and hooks cannot change it either, even if your `sandbox.filesystem.allowWrite` includes the state directory.
- **Without the sandbox**, the agent is **not** kept out. When srt is missing, fails its check, or is turned off (`PIRC_SANDBOX=off`, `"sandbox": {"enabled": false}`, or `services.pirc.sandbox.enable = false` in the NixOS module), `bash`, `code`, `background_task` and hooks run with the node account's full permissions. They can rewrite this file like any other file the node owns. Such sessions show a "Not sandboxed" badge. If it matters to you that only you can change a project's instructions, install srt and leave the sandbox on. See [Agent sandbox](../README.md#agent-sandbox) for requirements, such as bubblewrap and user namespaces on Linux.

## Limits

Capabilities are a **policy on assistant features, not a sandbox**. They control five gateway-backed features and nothing else:

- `bash`, `code`, `background_task`, hooks and the file tools keep whatever access the node and its [sandbox](../README.md#agent-sandbox) give them. A chat with `web_search` off can still reach the network through `web_fetch`, the `browser_*` tools, or `curl` in `bash` where the sandbox allows it.
- The assistant's USER/MEMORY notes and `memory_note`/`memory_propose_user` are not capabilities. Every project still reads and writes the same global memory.
- Turning a capability off does not remove data that already exists: chat history, delegation results, schedule runs, and memory.

Project instructions are prompt text and do not restrict what the agent can do. For restrictions, use capabilities and the sandbox.
