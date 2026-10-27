# Chat projects: capabilities, instructions, files and linked workspaces

[User guides](README.md) · [All documentation](../README.md)

A chat project is a chat workspace on the chat node (`pirc-node chat`): the top-level **Chats** workspace, or one you created with **New project** in the web app (see [Gateway and node reference](../development/gateway-and-node.md#node)). Each chat project has two settings of its own, both under **Settings → Projects** in the web app:

- **Capabilities** turn off assistant features for every chat in the project, and set when its delegations wait for your approval ([Delegation](#delegation)). The gateway enforces them.
- **Instructions** are text that every new chat in the project gets in its system prompt. The node stores them.
- **Project files** are files every chat in the project can read. The node stores them.
- **Linked workspaces** (projects only, not the top-level Chats) name the repositories the project is about. The gateway stores them.

Directory workspaces (repositories) have none of these settings. Each one is a capability of the default `chat` [mode](modes.md) (`projects`, `project_instructions`, `project_files`), so a custom mode can enable or omit them; the clients show these settings only where the mode has them.

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
    "web_search": true,
    "delegation_approval": "always"
  }
}
```

`GET` on the same URL returns the current policy. A `PATCH` changes only the capabilities it names. Unknown names, values that are not booleans (or, for `delegation_approval`, not `always`, `untrusted` or `never`), and a `version` other than `1` are rejected with `400`, and so is a `PATCH` for a directory workspace.

### What happens to work already in progress

Turning a capability off takes effect at the gateway right away. Running chats also stop being offered the tools on their next run, and `/cron` checks the gateway before it acts.

- **Proposals waiting for approval.** A delegation or schedule a chat proposed before the change can no longer be approved: approving it fails with `capability_disabled`. You can still reject it.
- **Approved delegations not yet started.** They are checked again before the gateway starts the target session and before it hands over the task. If the capability is off by then, the delegation fails and nothing is sent.
- **Existing schedules.** A schedule that runs in the project, or that one of its chats created, is checked each time it would run. At a timed run, it records a failed run and pauses the schedule. When you run it now or allow a missed run, it refuses with the error. You cannot resume it or change it to run in the project while `schedules` is off. After turning `schedules` back on, resume the schedule yourself.
- **Already done.** Delegations already handed over, runs already started, and anything already in a chat's history are not undone. Turning a capability off does not cancel, delete or hide that work.

### Teammates and subagents

A chat's teammates and subagents get the project's policy as it stands when they start. Their tools are the ones allowed by **both** the project policy and their role's `tools` allowlist (`roles/<name>.md`). A role cannot give back a capability the project turned off. (Today teammates and subagents have no gateway access at all, so they could not use these features even with the capability on.)

## Delegation

With `delegation` on, the assistant can hand a task to a coding session in one of your directory workspaces with `delegate`. The assistant agrees the plan with you in the chat first; the **Delegation approval** setting next to the switch (`delegation_approval`) decides whether you then confirm each delegation again:

| Setting            | A delegation…                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `always` (default) | waits for you: the chat shows a card with the workspace and the whole task, where you can also pick the model and thinking level, and **Delegate** or **Don't**. Nothing runs until you do; the card lapses after `PIRC_DELEGATION_TTL_MS`. |
| `untrusted`        | starts at once, unless the chat has read outside content since your last message (any tool result, such as web search or pages, the browser, files, `memory_search`, or a delegation report): then it waits for the card.                   |
| `never`            | always starts at once.                                                                                                                                                                                                                      |

Existing projects and the top-level Chats keep `always` until you change it. Follow-ups (`follows`) follow the same setting. At most 4 delegations started without the card run at once per user; more wait for the card. A delegation that starts without the card runs on the role's model, or the workspace default: there is no card to pick one on. You can still change the model in the delegated session.

**What you give up with `untrusted` and `never`.** A chat reads content it does not control (web pages and search results, the browser, `memory_search`, delegation reports), and a prompt injection there can ask the assistant to delegate. `untrusted` refuses that only for content read since your last message; `never` not at all. In the delegated session, auto mode judges how destructive an action is, not whether you wanted it: an injected task can change and commit code in the workspace, and install packages from the default registries, without asking. What still stops it is the sandbox (no new hosts, no credential stores, no writes outside the workspace without your approval), auto mode's danger rules and your deny list. Delegated sessions never inherit a chat's full access. See [Security decisions](../architecture/security-decisions.md#delegation-approval).

**Your words as the request.** When the assistant delegates, it passes your exact words that asked for the work (`quote`), from one of your last three messages; the chat's agent checks them against those messages and refuses anything else. The delegated session's auto mode reads those words, never the assistant's task text, as your request for the run the delegation starts, so an action you asked for in so many words can pass without a prompt. This holds under every setting. On the card, **Treat this task as my request for auto mode** still counts the whole task too.

**In the chat.** A running delegation shows in its chat as a card, "Delegated to {workspace} — {title}", with **Open** and **Stop**, and in the session list with its delegation marker. Stop takes control of the delegated session when no other client holds it, stops the run and lets go; if another device controls that session, stop it there. You are notified when it finishes or fails, as before.

**Approvals reach the chat.** When the delegated session waits on a confirmation (auto mode's dangerous action, network access, a command outside the sandbox, a deny-list match), the chat that started it shows the same question, naming the session and workspace, and the notification says the session needs you. **Needs you** offers **Allow** and **Deny** on the waiting session. Answering in the chat, from Needs you or from the notification answers the original question on its node; it needs no control of the delegated session or the chat. Other questions (`ask_user_question`) are still answered in the delegated session.

**Audit.** Each delegation records how it started (`dispatch`: `approved` or `auto`), where the chat's context came from when the assistant asked (`origins_json`), and the quote with your message ids (`quote`, `quote_entry_ids`), in the gateway's `delegations` table; they are deleted with the delegation.

The baseline of approval prompts in delegated and ordinary sessions can be measured read-only with `bun scripts/approval-stats.ts --gateway-db <gateway.sqlite> --node-db <nodeId>=<node's gateway.sqlite>` (repeat `--node-db` per node; `--since`, `--json`); it opens both databases read-only.

## Instructions

Project instructions are standing instructions you write for one project, for example "Answer in French" or "This project is about planning a kitchen renovation; keep a running budget table". They differ from the other places the assistant gets context:

- **`SOUL.md` / `CHAT.md`** in the chat node's config directory define the global persona and chat rules. Coding sessions use `AGENTS.md` instead and never read these two files. Project instructions apply only to that project's chats.
- **USER and MEMORY** (Settings → Memory) are the assistant's memory of you. They are shared by all chats, the assistant proposes or writes them, and you review them. USER also reaches every coding session on every node (read-only there). The assistant never writes project instructions. They change only when you edit them, and they do not change what is in memory.

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

They come after `SOUL.md` (or the built-in identity), the fixed environment description and `CHAT.md`, and before USER/MEMORY, under the heading `## Project instructions`. The assistant is told to follow them unless you say otherwise in that chat.

### Who can change them

- **File tools** (`write`, `edit`, also when called from a `ptc` script) cannot write the file. It is outside every chat's working directory, and it is on the agent's protected paths, so writes are refused even if you add its directory to `allowedPaths`.
- **In the [agent sandbox](agent.md#agent-sandbox)**, which every agent runs in, the node's state directory can be neither read nor written. The instructions file is also on the sandbox's write-deny list, so bash, `ptc` scripts and hooks cannot change it either, even if your `sandbox.filesystem.allowWrite` includes the state directory.
- **Agent processes** never run without the sandbox: a chat node where the native sandbox cannot work starts no agents. See [Agent sandbox](agent.md#agent-sandbox) for requirements, such as bubblewrap and user namespaces on Linux.

## Project files

Project files are files you keep for every chat in a project: notes, documents, data the assistant should know about. Unlike an attachment, which belongs to one message of one chat, a project file is there for every chat in the project, including the ones already open.

### Managing them

In the web app, open the project, then its **Settings** tab. **Project files** lists the files with their sizes; **Upload files** adds one or more, and **Remove…** removes one after you confirm. Uploading a file with the name of an existing one replaces it. The top-level Chats workspace has project files too.

Through the API:

```sh
curl 'https://pirc.example.org/api/workspaces/chat%3Aworkspace_1234/files' \
  -H 'Authorization: Bearer pirc_dev_…'

curl -X POST 'https://pirc.example.org/api/workspaces/chat%3Aworkspace_1234/files?filename=budget.csv' \
  -H 'Authorization: Bearer pirc_dev_…' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @budget.csv

curl -X DELETE 'https://pirc.example.org/api/workspaces/chat%3Aworkspace_1234/files?name=budget.csv' \
  -H 'Authorization: Bearer pirc_dev_…'
```

`GET` returns `{"files": [{"name", "byteSize", "modifiedAt"}], "maxFiles": 50, "maxBytes": …}`, by name (`modifiedAt` in milliseconds since the epoch). `POST` takes the raw bytes (send `application/octet-stream`: a JSON body is parsed, not stored) and returns `201` with `{"file": {…}}`. `DELETE` returns `204`, or `404` when there is no such file.

- **Names:** the last `/`-separated part of `filename`, trimmed, at most 255 bytes, not starting with `.`, without control characters. Anything else is `400`.
- **Limits:** at most 50 files per project (`409` for one more; replacing one still works), each within the node's upload limit (`413`).
- **The node must be online.** Otherwise the gateway answers `503`. Directory workspaces have no project files (`400`).

### How chats see them

The chat node stores them in `<stateDir>/chat/<workspaceId>/files/`, files `0600` in a `0700` directory, beside the project's instructions. The gateway relays uploads and stores nothing.

A chat that starts while the project has that directory gets it **read-only** in its [sandbox](agent.md#agent-sandbox) and a `## Project files` section in its system prompt, after the project instructions, naming the directory. The assistant reads the files with its file tools or `bash` when they are relevant. Its file tools and the sandbox refuse to write there, so it cannot add, change or remove them, and the rest of the project's directory (its instructions, the other chats' directories) stays closed.

The directory is **shared, not copied**: unlike instructions, project files are not frozen when a chat starts. A file you upload, replace or remove is what every chat reads from then on, also in chats already running. The prompt names only the directory, not the files in it, so the assistant lists it to see what is there now.

The first upload creates the directory. Chats that started before the project ever had a file are not given it (their sandbox was set up without it); start a new chat to use the files. Removing every file keeps the (empty) directory, so later uploads still reach every chat.

Deleting the project deletes its files with it (see [Deleting a project](#deleting-a-project)). Copies the assistant made elsewhere (in a chat's working files, or written into memory) follow those places' rules.

## Linked workspaces

A project is usually about one or a few repositories. Linking them tells the project's assistant so, without you naming the workspace every time:

- **Workspace list.** New chats list the linked workspaces first in their `## Workspaces` section, marked "linked to this project", then the other clones of their repositories (workspaces whose node reports the same `origin`), then everything else. A linked workspace that is offline, or that its node no longer has, stays listed and is marked so.
- **Delegation.** `delegate` without a workspace goes to the linked workspace when exactly one is linked. With several linked, the assistant is asked to name one; with none, it must name one as before. If the one linked workspace was removed from its node, the assistant is told so (not that the node is offline) and must name another. A link is not a permission: delegations to linked and unlinked workspaces follow the same [Delegation approval](#delegation) setting.
- **Search.** `memory_search` without a workspace looks in the linked workspaces and the other clones of their repositories first. If nothing is found there it searches every workspace and says so. The assistant can pass `everywhere: true` to search every workspace at once, or name a workspace as before.

A link is **a default and an ordering, never a permission**. The assistant can still delegate to and search workspaces that are not linked, and the `delegation` and `memory_search` capabilities still decide whether it can do either at all.

### Editing links

In the web app, open the project, then its **Settings** tab. **Linked workspaces** lists your directory workspaces with their device; check the ones the project is about and press **Save**. A link to a workspace that is no longer listed stays (marked "no longer available") until you uncheck it.

Through the API:

```sh
curl 'https://pirc.example.org/api/workspaces/chat%3Aworkspace_1234/links' \
  -H 'Authorization: Bearer pirc_dev_…'

curl -X PUT 'https://pirc.example.org/api/workspaces/chat%3Aworkspace_1234/links' \
  -H 'Authorization: Bearer pirc_dev_…' \
  -H 'Content-Type: application/json' \
  -d '{"workspaceIds": ["laptop:workspace_5678"]}'
```

`PUT` replaces the whole set; links kept keep their creation time, and `{"workspaceIds": []}` removes them all. Both return `{"links": [{"workspaceId", "name", "node", "repo", "online", "removed", "createdAt"}]}`, oldest link first. Only directory workspaces can be linked (anything else is `400`), at most 20 per project, and only chat projects have links: the top-level Chats workspace and directory workspaces answer `400`. The project's node need not be online.

### When a change takes effect

The workspace list is part of the chat's frozen memory snapshot, so a chat keeps the list (and its "linked" marks) it started with; changed links reach **new chats**. `delegate` and `memory_search` read the links when they run, so they follow a change at once, also in chats already open. The confirmation card always shows where a delegation goes.

## Limits

Capabilities are a **policy on assistant features, not a sandbox**. They control five gateway-backed features and nothing else:

- `bash`, `background_task`, hooks and the file tools keep whatever access the node and its [sandbox](agent.md#agent-sandbox) give them, also when a `ptc` script calls them. A chat with `web_search` off can still reach the network through `web_fetch`, the `browser_*` tools, or `curl` in `bash` where the sandbox allows it.
- The assistant's USER/MEMORY notes and `memory_note`/`memory_propose_user` are not capabilities. Every project still reads and writes the same global memory.
- Turning a capability off does not remove data that already exists: chat history, delegation results, schedule runs, and memory.

Project instructions are prompt text and do not restrict what the agent can do. For restrictions, use capabilities and the sandbox.

## Global persona and chat rules

Settings → Assistant edits `$PIRC_CONFIG_DIR/SOUL.md` and `CHAT.md` on the chat node, never a gateway copy. Each is limited to 8000 characters. Empty Soul restores the built-in identity; the private-directory environment description always remains. Edits apply at the next agent start, including restarts of existing chats (unlike frozen project instructions). Nix-managed paths and symlinks are read-only; edit `services.pirc.soulPrompt` / `chatPrompt` or the symlink's source instead. All users allowed by both the gateway and chat node can manage these shared files.

The gateway persistently binds the first registered chat node's ID, including across disconnects and restarts. A second ID receives a registration error (`409 chat_node_exists` in a WebSocket frame). To replace it, stop the old chat node, then use **Release chat node binding** and confirm in Settings → Assistant. The next successful chat registration claims the binding; if the old process is still running it may reclaim it. Only the node ID is stored at the gateway, not the prompt files.

## Inspecting the context

Open **Context** in a session's side panel (available for chats and coding sessions). It shows the system prompt actually sent, divided into fixed-order sections with sources and frozen badges, plus the tool descriptions and schemas. Workspace-readable sources link to Files; global configuration paths remain plain text. **Copy all** copies the joined system prompt.

The usage bar estimates system, tool definitions, conversation messages, and observational-memory observations/reflections. Memory is allocated from the messages that contain it, not counted twice. USER/MEMORY and workspace-memory prompt sections remain in the system bucket. When a matching provider response reports usage, the buckets scale to its input tokens including cached input; output is excluded. Both the estimate and the reported figure are shown. The free amount uses the request's model context window, not a later model selection. These are approximate allocations, not a tokenizer-level accounting.

Stopped agents show the last request snapshot and its timestamp, not freshly loaded configuration. The node atomically replaces `<sessionDir>/context.json` with mode `0600`; it does not append this duplicated prompt/tool content to `session.jsonl`. The snapshot contains no raw conversation or provider credentials and is removed when its session directory is removed (there is no additional automatic retention policy). The gateway only relays the inspector response. Existing inference still passes through the gateway; this does not change chat privacy or memory mirroring. No Context inspector is added to the native Android UI in this milestone.

## Approving memories in a chat

A proposed USER change appears in its source chat with **Approve** / **Reject**, its proposed text, the current target text for replace/remove, and the user's exact quote. The browser needs the chat's control lease to answer. Settings → Memory and the chat resolve the same durable proposal, so a decision in either place updates both. A changed target invalidates an older card; refresh and review the current text before approving.

Pending proposals survive node disconnects and gateway restarts. A decision does not start a new agent turn. On its next run, the assistant receives the latest decisions for that chat alongside its existing frozen memory snapshot.

## Deleting a chat

Use the trash action in the chat list or a project's session list. The confirmation warns that deleting the chat also deletes the USER and MEMORY entries **originally created there**, their earlier revisions, and its proposals. Entries created by other chats remain, even if this chat read or edited them. **Settle** still only archives a chat.

Deletion requires the chat node online. It stops the running agent, closes its terminals and browser, removes the private transcript and observational memory, and removes the chat's working files. If the connection fails during deletion, reconnect and use Delete again; retrying is safe. Until cleanup completes the chat remains listed but cannot accept more work. Completed deletion also removes the chat from other connected clients.

The memory store retains only forgotten markers and content hashes to prevent exact re-adds; deleted memory cannot be restored through Settings. Copies already in other chats' frozen snapshots or messages, external files, backups, and original files in the node's upload store are outside this deletion (deleting the chat's project removes the uploads made in it; see [Deleting a project](#deleting-a-project)). The confirmation discloses the other-chat copy boundary. Project instructions and separately created schedules are preserved.

API: `DELETE /api/sessions/:id`, authenticated as the owner, returns `204` after both node and gateway cleanup. The same owner can retry a completed deletion. Other owners are refused. This route supports chat sessions only.

## Deleting a project

A project's page → Settings → **Delete project…** deletes the project with its chats. The confirmation first shows what goes and what stays, and lists the memory entries that need your decision; nothing changes until you confirm.

Deleted:

- Every chat in the project, as [Deleting a chat](#deleting-a-chat) describes: messages, working files, private transcripts and observational memory, terminals and browser.
- Files uploaded in the project's chats (originals included), the project's files, and the project's browser profile.
- The project's instructions, capability settings and links, the schedules that run in it with their history, and the records of delegations its chats started.
- The memory its chats wrote. Each entry is judged by its recorded write-time project origin, even if its author later moved or was deleted:
  - every version from the project: the entry is forgotten;
  - the project's versions only after every other one (another chat wrote it, a project chat changed it later): the entry goes back to its last text from elsewhere, and the project's versions are erased from its history;
  - mixed or unknown origins: you decide, **Forget** (the entire entry and history), **Keep as is** (content and history untouched) or **Edit** (your text replaces it; project-authored and unknown-origin versions are erased from its history, while known outside versions remain). Legacy records are not assigned to the author's current project. Unknown records may therefore need review even when no current member wrote them.
- Memory proposals recorded in this project, including decided proposals. Proposals with unknown origins require an explicit Keep or Forget choice. Keep preserves the proposal without approving it.

Not deleted, and listed as such:

- Schedules its chats created in other workspaces.
- What delegated tasks did in other workspaces: their sessions, files and commits, and the workspace memory they wrote.
- Copies in other chats: what they already read (frozen snapshots, messages) and what they wrote in their own words. These are not traced.
- Files uploaded before pirc recorded an upload's project (0.5.x and earlier), which stay in the node's upload store.
- Backups, logs, and what model providers keep.

Forgotten text is **not** blocked afterwards: the tombstones a project deletion leaves are scoped to the deleted project, so another chat or a new project may write the same text again. To keep a fact from coming back, forget it in Settings → Memory, whose tombstones refuse it everywhere. Projects have no project-only memory: their chats read and write the global USER/MEMORY like any other chat.

Deletion requires the chat node online and a compatible Gateway/Node pair. The project and its current chats are fenced in the same transaction as memory cleanup and a content-free completion receipt. No new chat starts in it, and its chats accept no more work. If the connection fails part way, the project stays listed with **Finish deleting…**: reconnect and retry. Once memory cleanup committed, retry resumes Node/Gateway removal without reconsidering Keep/Edit choices or overwriting later changes. A simultaneous standalone deletion of a member chat uses the recorded project cleanup scope, not the standalone creator purge.

Review decisions require the entry's current revision and each proposal's current status. A competing change returns `409` and reloads the confirmation without applying any partial plan. Known all-project or project-suffix histories are recomputed atomically at confirmation. Only current member chats are deleted; memory uses its frozen origins, including moved/deleted authors. Supported cross-project moves still await the mount-revocation implementation.

A deleted project keeps a content-free record (its id) on the gateway and the chat node, so the node, a restored node backup or a late message cannot bring it back. A new project with the same name is a different project with nothing of the old one.

Uploads are usable only in the workspace they were uploaded in: an upload made in a project cannot be attached in another project, the top-level chats or a coding workspace (`403` "Upload belongs to another workspace"). Uploads from before this rule record no workspace and stay usable anywhere.

API: `GET /api/workspaces/:id/deletion` returns `chats`, `schedules`, `keptSchedules`, `delegations`, `links`, `memory`, `memoryProposals`, `nodeOnline`, `deleting` and `memoryCleanupComplete`. Memory actions are `forget`, `rollback` (with `restored` text), or `review`; unknown history also has `unknownOrigin: true`. Proposal items contain `proposal` and `action` (`forget` or `review`). Completed memory cleanup returns empty memory lists.

`POST /api/workspaces/:id/deletion` accepts `{"memoryReviewVersion":1,"decisions":[{"entryId","revision","action":"forget"|"keep"|"edit","content"?}],"proposalDecisions":[{"proposalId","status","action":"keep"|"forget"}]}`. Review items need explicit choices at the displayed revision/status. Duplicate choices are rejected. Older clients may still delete projects with fully known origins, but cannot confirm unknown-origin cleanup (`409 memory_review_required`); update Web/Android first. Retrying an already committed memory phase ignores stale choices and resumes removal. The response is `204` once Node and Gateway cleanup finish, including repeated completed deletions. Only chat projects may be deleted, not top-level Chats or directory workspaces.
