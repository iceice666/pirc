# Delegation without the approval card

[Plans](README.md) · [Chat projects guide](../docs/guides/chat-projects.md) · [Tools (auto mode)](../docs/guides/tools.md) · [Security decisions](../docs/architecture/security-decisions.md)

Goal: a chat's delegation runs without a separate approval card, auto mode in the delegated session knows what the user actually asked for, and the approvals that remain reach the user in the chat instead of only inside the delegated session. Human checkpoints move from "every delegation" to the places that can stop real harm: the sandbox (`sandbox_allow_domains`, `unsandboxed_bash`), dangerous shell actions and the user's deny list.

This file is the work queue for the change, not authorization: each phase needs the user's go-ahead. Phase 1 reverses a recorded security property (delegation is a human-only operation) and needs an explicit decision recorded in [Security decisions](../docs/architecture/security-decisions.md).

## Today

- **Card.** `delegation.create` (`crates/pirc-gateway/src/delegations.rs`) records a `pending_approval` row and shows a confirmation in the chat; nothing runs until the user presses **Delegate**. The card is also where the user picks the model and thinking level, and it offers "Treat this task as my request for auto mode" (`userRequestChoice`), **unchecked by default**.
- **In practice** the assistant already agrees the plan with the user in the conversation before calling `delegate`, so the card is a second confirmation that the user does not read. A card nobody reads protects little and trains reflex approval.
- **Auto mode in the delegated run** (`crates/pirc-agent/src/auto_mode/`): static rules sort an action into read / write / danger / unknown; only unknown goes to the classifier. The classifier's "recent user requests" are `Message::User` entries plus, only when the box was ticked, the delegated task (`classifier.rs` `recent_user_requests`, gateway `as_user_request`). With the box unticked, the classifier of a delegated run sees **no user intent at all** and leans to danger. Static danger never reaches the classifier, so no stated intent can unlock it. Danger verdicts are not cached and there is no "allow for this session", so identical prompts repeat.
- **Where approvals appear.** Only in the delegated session. Answering needs that session's control lease (`routes.rs` `answer`: `validate_lease`), so the user must open it; Needs you only offers Reply.
- **Not auto mode.** `sandbox_allow_domains` (per session) and `unsandboxed_bash` (always) are the node's own dialogs and ask in every approval mode. The ComfyUI case was mostly these; see [GPU access in the agent sandbox](sandbox-gpu.md).

## Threat model of removing the card

A chat reads untrusted content (web search and pages, browser, `memory_search`, delegation reports) and can call `delegate`. A prompt injection can therefore ask the assistant to send a task to a coding workspace. In that workspace, auto mode judges **destructiveness, not intent**: "add this code and commit", or "push an ordinary branch" where git credentials are configured for the sandbox, is a routine write and runs. Removing the card therefore removes the only check on this path. What remains:

- The sandbox: no network beyond default and approved domains, no credential stores, no writes outside the workspace and caches; escapes and new hosts still ask.
- Auto mode danger rules and the deny list; delegated sessions never inherit a chat's full access (they start in the node default).
- New in this plan: dispatch visibility with a Stop action, a cap on concurrent automatic delegations, the `untrusted` policy below, and an audit trail.

Residual risk accepted by choosing `never`: an injected task can change and commit code in a workspace and install packages from default registries without a prompt. For a single-user deployment on a private network this is the user's call; it must be recorded, not implied.

## Phase 0 — Measure (optional, recommended)

- [ ] A read-only script over node session transcripts that counts approval requests in delegated vs. ordinary sessions by kind: auto mode (rules vs. model verdict, reason), `sandbox_allow_domains` (host), `unsandboxed_bash` (command head), deny list. Locate where each dialog and its answer are recorded first. Gives a baseline for phases 2–3. No state is modified.

## Phase 1 — Dispatch policy and real user intent

- [ ] **Policy.** A delegation approval setting on each assistant workspace (projects and the top-level Chats), next to the existing `delegation` capability, enforced by the gateway:
  - `always`: today's card.
  - `untrusted`: dispatch at once unless the chat's current context contains untrusted content (`current_origins` in `crates/pirc-agent/src/features/assistant/mod.rs` reports `tool:*` origins since the last user message; the agent sends them with `delegation.create` as `memory_note` already does). Untrusted → card.
  - `never`: always dispatch at once.
  - Existing installs keep `always` until the user changes it (decision below).
- [ ] **Verified intent instead of a checkbox.** `delegate` gains an optional `quote`: the user's exact words that asked for the work, checked against the chat's user messages with the existing `find_quote` (as `memory_note`/`memory_propose_user` do). The delegated run's classifier receives the verified quote(s) as user requests, never the assistant-written task text. A quote is the human's own text, so injection cannot forge it; this holds under every policy. It can still be quoted out of context (an older "delete it" about something else): accept only quotes from the user's last few messages (proposal: 3, matching the classifier's window), and the classifier's rule that only an exact operation on an exact target authorizes still applies. The card path keeps the existing checkbox for the task text.
- [ ] **Model.** Without a card the user picks no model: use the role's model, else the workspace default. A later follow-up can still change it. Document in `docs/guides/tools.md` ("Only you set models").
- [ ] **Visibility.** An automatically dispatched delegation shows in the chat as a non-question card ("Delegated to work:repo — Stop") and in the session list with its existing origin marker. Stop stops the delegated run. Push follows the existing delegation notifications (finished/failed/waiting).
- [ ] **Limits.** At most N automatically dispatched delegations running per user (proposal: 4); beyond that, the card. Follow-ups (`follows`) follow the same policy.
- [ ] **Audit.** The delegation row records `dispatch` (`approved` / `auto`), the origins sent with the request and the verified quote ids. Schema bump with migration; deletion/preview code includes the new columns.
- [ ] Assistant tool text: "Asked the user to approve…" becomes policy-dependent; the system prompt tells the assistant to confirm the plan in conversation and pass the user's words as `quote`.
- [ ] Docs: chat-projects guide (delegation), tools guide (auto mode user requests), security decisions (delegation is no longer human-only under `untrusted`/`never`, residual risk above). Conformance: `tests/delegations.rs` gains auto-dispatch, untrusted fallback, cap, quote verification and refused forged quote scenarios.

## Phase 2 — Approvals reach the chat

- [ ] When a delegated session waits on an approval (auto mode danger, `sandbox_allow_domains`, `unsandboxed_bash`, deny list), the originating chat shows the same request as a relayed card naming the session and workspace, and push says "needs you" with the action. Answering from the chat or the notification answers the original interaction; the node still decides, and agent text never counts as an answer.
- [ ] Lease: answering requires the delegated session's control lease today. Options: the client takes the lease when free, answers and releases it (no server change, fails when another device holds it), or the gateway accepts an answer for that interaction id from the owning user without a lease. Decision below.
- [ ] Needs you gains the same direct actions for these relayed approvals.

## Phase 3 — Auto mode precision

- [ ] **Allow for this session.** Approval dialogs gain "Allow this again in this session" for the exact action text in the same working directory (auto mode danger and `unsandboxed_bash`). Never for deny-list matches; recorded in the session like the approval mode, cleared on restart of the run's branch (decide). Prefix/pattern grants are out of scope.
- [ ] **Soft and hard danger.** Rules (`auto_mode/rules.rs`) report a danger category. Hard (credentials, uploading data, download-and-execute, system/global configuration, privilege, deleting outside the workspace) always asks. Soft (force push, `reset --hard`/`clean -f`, publishing/deploying) goes to the classifier when the run has a verified user request, so "force-push my feature branch" can pass when the user said exactly that. A rules test corpus pins each category; classifier prompt text is reviewed with the change.
- [ ] Reassess with phase 0's script after phases 1–2 before building this phase; it widens auto mode and may prove unnecessary.

## Decisions needed

1. Default for existing installs and new projects: keep `always` (recommended; the user switches to `untrusted` or `never`), or migrate to `untrusted`.
2. Whether `never` is offered at all, or only `always`/`untrusted`.
3. Phase 2 lease handling: client-side take-and-release, or a gateway exception for relayed interaction answers.
4. Phase 3 session allows: exact text only (recommended), and whether `unsandboxed_bash` may be remembered.
