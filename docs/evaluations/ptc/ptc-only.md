# PTC-only agent interface: `ptc` and `ptc_docs`

Status: **Milestones 1–4 complete; hybrid cutover accepted and merged (2026-10-07)**, as recorded in the Milestone 4 acceptance and review below. The accepted surface exposes core tools directly and through `ptc`, with other capabilities through `ptc`; it replaces the original PTC-only target. The [OpenAI baseline](ptc-m1-openai.md#m1-baseline-accepted) is accepted. Failed evaluation rounds remain failed; the later public holdout passed its own bounds, and the maintainer accepted the recorded chat limitations. This document preserves the original design and chronological evidence, not a new implementation queue. Outstanding accepted risks and manual release checks are indexed in the [backlog](../../../plans/backlog.md#accepted-ptc-follow-ups-and-release-checks). Evidence: [inventory](ptc-m1-inventory.md), [contracts](ptc-m1-contracts.md), [evaluation](ptc-m1-evaluation.md). Baseline: `main@2530bd2` (code references and statistics, refreshed 2026-10-03). Decided 2026-10-03: the script runtime is QuickJS compiled to WASM (option B, §4) and the TempestMiku `tm` security model is adopted where it fits (see "Prior art"). Decided 2026-10-03: no runtime mode switch; the change is all-or-nothing, developed on a branch and either cut over or abandoned on the Milestone 4 evaluation (§7).

## Direction and scope

The maintainer requested a plan to expose only **`ptc` and `ptc_docs`** to the model, moving existing operations behind the programmatic interface. This is an interface redesign, not permission to delete capabilities, weaken sandboxing, rewrite the service in Go/Rust, or deploy changes.

- [x] Milestone 1: capability contracts and baseline evaluation.
- [x] Milestone 2: secure PTC execution, discovery and lifecycle.
- [x] Milestone 3: full capability coverage and client observability.
- [x] Milestone 4: comparative evaluation and migration (cutover to the hybrid surface accepted by the maintainer, 2026-10-07; see "Cutover status").

The two-tool target is the requested direction. Contracts, rollout details and evaluation thresholds below are proposals to verify during implementation; success has not been demonstrated.

## Evidence and limitations

Local statistics supplied by the maintainer (`ptc-stats.txt`, untracked; do not include raw session data in this plan):

| Measure                                                   |                           Observed |
| --------------------------------------------------------- | ---------------------------------: |
| Coding main sessions indexed / readable                   |                          169 / 155 |
| Main sessions with tool calls using PTC                   |                   76 / 144 (52.8%) |
| Nested sessions with tool calls using PTC                 |                   69 / 121 (57.0%) |
| PTC calls / direct model tool calls                       |              1,249 / 19,227 (6.5%) |
| Direct `bash` calls / direct model tool calls             |             8,165 / 19,227 (42.5%) |
| Recorded operations inside PTC                            |                              6,046 |
| PTC results with two or more internal operations          | 1,108 / 1,248 with details (88.8%) |
| Average internal operations per detailed result           |                               4.84 |
| Internal operations per PTC result: p50 / p90 / p99 / max |                    4 / 8 / 17 / 57 |
| PTC results with 100 or more internal operations          |                          0 / 1,248 |
| Outer PTC error results                                   |                  68 / 1,249 (5.4%) |
| Internal edit / read operations                           |                      3,085 / 1,502 |

PTC carries approximately 25.2% of recorded underlying operations after excluding the outer `code` calls. This is **not** a token-saving percentage. The sample covers one node's indexed coding sessions, retained branches and nested agents; 14 main records were missing/unlocatable. Tool availability and model mix were not controlled. Error results are not necessarily script bugs. These counts do not establish that all operations benefit from PTC or that batch calls require arbitrary TypeScript.

Before claiming savings, distinguish fixed batches, repetitive edits, result-dependent execution and output reduction. Use synthetic tasks by default; any additional historical-content analysis needs an authorized scope. Never replay historical scripts against live workspaces to benchmark them.

## Prior art: TempestMiku `tm`

[TempestMiku's `tm` design](https://github.com/mozufu/TempestMiku/tree/main/docs/design/tm) (archived project) shipped a custom language for `execute(code)`. This plan borrows its security and observability model, **not** the language:

- **Adopted:** no ambient authority (every host interaction goes through the registry); a capability manifest checked before evaluation; approval policy as registry metadata, separate from capability identity; denial as a typed error the script may handle; an explicit structured-concurrency scope; parent-linked trace nodes with an explicit state machine; opaque handles that no script operation can dereference; a not-worse comparative fluency gate.
- **Adapted:** tm's durable events are content-blind because they persist to a server-side database and bindings outlive cells. pirc's durable record is the node-local session.jsonl, which already holds full direct-call arguments and results, so inner operations follow direct-call exposure instead (§6).
- **Not adopted:** a new language. tm's own gate showed both TypeScript and tm at 1,000/1,000 first-try successes; tm won only on code length (mean generated-code tokens 50.8 → 40.2) on 20 small prompts. A language unknown to models needs resident syntax documentation, which works against moving schemas out of context, and a parser/checker/interpreter is substantial maintenance. Static capability inference is approximated with literal capability names instead (§3).
- **Deferred:** tm's persistent REPL with atomic binding commit. This plan stays one-shot; revisit only after Milestone 4 evidence.
- **Not needed:** continuation capture for resumable approval. In a one-shot in-memory execution, awaiting a host promise that resolves after the human answers already suspends the script; neither tm nor this plan serializes a suspended execution, so runtime loss ends it without replaying effects.

## Current implementation to inspect

- `apps/gateway/src/agent/ptc/code-tool.ts`: `code`, worker lifecycle, IPC and result aggregation. Calls go through `agent.invokeTool`; the current bridge filters images out and records only internal tool names/error flags in result details.
- `apps/gateway/src/agent/ptc/worker.ts`: Bun subprocess, convenience methods returning text, raw `tools.call`, serialization and Function-constructor hardening. Constructor removal is explicitly **not** a sandbox.
- `apps/gateway/src/agent/agent.ts`: tool registration/specs, `invokeTool`, auto-mode/hooks and top-level execution events.
- `apps/gateway/src/agent/features/code.ts`: chat defaults currently disable the model-facing `code` feature. Other feature defaults separately exclude capabilities from chat.
- `apps/gateway/src/agent/auto-mode/`, `apps/gateway/src/node/sandbox.ts`, `apps/gateway/src/sandbox-policy.ts`: execution policy and mandatory OS isolation.
- `apps/gateway/src/agent/messages.ts`, `apps/gateway/src/agent/session-store.ts`: multimodal results and append-only history.
- Team, background, browser, schedule, memory and goal feature implementations; role tool selection; web/Android tool-result rendering; context inspector and provider adapters.

Locate exact registration, configuration and client call sites before editing. Do not assume every existing tool is eligible for PTC merely because some expose `ptc: true`.

## 1. Separate model tools from internal capabilities

Maintain one capability registry independent of the provider-facing tool list. A capability has:

- Stable identifier, category, description and contract version.
- Input schema with execution-time validation; explicit result contract.
- Structured errors, side-effect classification and concurrency policy.
- Availability rules: session role, configured tools, project capabilities and owner/workspace authorization.
- Approval requirements, execution implementation and documentation/examples.

Generate documentation and runtime bindings from the same registry. Reuse existing implementations and policy checks; avoid parallel legacy/PTC permission systems.

In PTC-only mode the provider receives exactly two schemas, regardless of how many capabilities are available. Existing capability identifiers should remain stable initially (for example `read`, `edit`, `browser_snapshot`); introducing dotted namespaces is not required for this migration.

Role/config tool lists continue to restrict **internal capabilities**, not just the two wrappers. Unknown or disabled identifiers fail closed. Capability discovery and execution use the same availability calculation, with authorization rechecked for each execution.

### Role tool lists (decided 2026-10-03)

- A role's `tools:` names internal capabilities. Identifiers are unchanged, so existing role files and the role tool lists recorded in sessions (`ROLE_ENTRY`) need no migration.
- `ptc` and `ptc_docs` are implicit whenever at least one capability is available. A role with no available capabilities gets no tools at all.
- `code`, `ptc` and `ptc_docs` in a role list are ignored with a warning, not an error. Omitting `code` is not a restriction worth preserving: under the QuickJS boundary the wrapper carries no authority beyond the listed capabilities.
- Unknown names in a role list produce a warning when roles are loaded. They still grant nothing; today `restrictTools` drops them silently.
- Team members keep the forced `TEAM_TOOL_NAMES`, now as internal capabilities.
- In scope: main coding sessions, delegated sessions, team members and subagents. Internal workers that are not user-facing agents (observational-memory observer/reflector with `record_*` tools, title generation, the auto-mode classifier) keep direct tool calls; Milestone 1 inventory confirms the list.

### Chat and worker roles

Changing the transport must not enable Team, Goal, background tasks or other capabilities currently absent from chat by default. Chat's capabilities under PTC-only are exactly its current set: gateway capability flags and `features.<key>.enabled` re-enables apply unchanged, and `features.code.enabled` no longer has an effect. This supersedes only the old absence of the `code` wrapper in chat. Chat traffic is dominated by single calls (`web_search`, `memory_search`), so chat is evaluated separately from coding with its own fixtures and bounds (Milestone 4). Child agents inherit their intended role restrictions and must not obtain a broader registry through PTC. Feature-restricted internal workers need explicit coverage rather than assuming all agent types use the same public tool surface.

## 2. `ptc_docs`: bounded capability discovery

Proposed interface (final schema belongs in Milestone 1):

```ts
ptc_docs({ category: 'files', cursor: undefined });
ptc_docs({ names: ['read', 'edit'] });
```

- No arguments returns a small category index, not every full schema.
- Category queries return bounded summaries; exact-name queries return input/result schemas, errors, side effects, approval behavior, execution limits and short examples.
- Responses include registry/contract versions, explicit truncation and pagination. Set bounded request counts and output sizes.
- A short capability-category index in the system prompt makes discovery possible without injecting all tool definitions. It is not a second giant manual.
- Show only currently available capabilities. Documents are trusted registry content, not instructions imported from arbitrary workspace files.
- Documentation queries are read-only and do not start jobs or consume approvals. The model may reuse docs already in context; it need not fetch them before every call. Handle stale contracts with a structured error pointing to the current docs.

## 3. `ptc`: typed operations and bounded output

Proposed interface:

```ts
ptc({
  code: `
    const result = await tools.call("read", { path: "src/example.ts" });
    if (!result.ok) throw new Error(result.error.code);
    return result.data;
  `,
  timeout: 120,
});
```

- An async TypeScript body has a documented, small SDK. Keep explicit sequential `await` and support bounded, deliberate parallelism.
- Make structured results first-class; do not require parsing human-readable text to discover paths, status or IDs. Raw access returns a typed envelope; throwing convenience calls have documented error semantics.
- Return only the selected result and bounded console output to model context. Preserve compatibility with ordinary final text responses: PTC is required for operations, not for answering the user.
- Bound source size, output bytes, memory, CPU/execution time, internal call count, concurrent calls and IPC message sizes. Reserve quota for pending calls, not only completed calls.
- Reject recursive `ptc`/`ptc_docs` dispatch through the capability broker. Capability discovery remains the separate tool; code cannot obtain another unrestricted agent interface.
- Keep one-shot execution initially. Cross-call state uses explicit job/artifact handles, not a persistent mutable JS global environment.

### Capability manifest before evaluation

Capability names must be string literals: `tools.read(...)` or `tools.call("read", ...)`. Computed names (`tools[name]`, `tools.call(name)`) are rejected before evaluation, and the runtime also refuses dispatch through any name absent from the manifest. Before the script runs, parse it, derive the set of capabilities it may invoke, and fail closed with a structured error listing every unavailable capability, so an unavailable capability is rejected before any side effect.

The manifest is a pre-check and display aid, not authorization: every operation is still validated, authorized and approved at execution time (§4). It may be shown with approval prompts and in the client trace. Loops over capabilities are written as explicit literal branches.

### Errors and structured concurrency

- Convenience calls throw typed errors with stable codes; at minimum `ApprovalDenied`, `CapabilityUnavailable`, `InvalidArguments`, `QuotaExceeded`, `Cancelled`, `Timeout` and `OperationFailed`. A script may catch them; retries are the script's explicit choice, never a hidden runtime loop.
- `tools.par(items, fn, { concurrency })` is the supported parallel form. It owns its children: it enforces the concurrency limit, cancels remaining siblings on failure according to a documented policy, and emits one scope node for client aggregation. `Promise.all` over capability calls still passes through the per-execution concurrency quota but is not the documented form.

### Images and large results

Introduce an explicit host-mediated way to attach existing image/artifact results to the outer response. The worker must not need to print base64 or arbitrarily read host files to return screenshots. Handles are owner/session-scoped, unforgeable, size-bounded and checked at use; define expiry and cleanup.

Verify images reach supported providers and both clients through normal multimodal messages. Unsupported models receive an explicit limitation. Large text may use bounded previews/artifact handles, with clear truncation, rather than silently losing content.

## 4. Security and authorization invariants

The design changes the model interface, **not the authority of a tool call**.

1. Every internal operation passes input validation, current capability availability, hooks, auto mode, write leases and the operation's existing server-side authorization. Hook-rewritten arguments must be validated and approved as executed.
2. Keep mandatory fail-closed OS sandboxing for node and chat. No disable flag or development exemption. Use fake srt in tests where appropriate.
3. Approval binds to a particular operation, target and validated arguments. Approval of outer code never approves all future operations. Cancellation, timeout, unavailable answers or stale approvals never imply consent.
4. Preserve existing special rules: each cross-workspace delegation requires confirmation; schedule creation/modification requires confirmation; existing pause/delete rules remain unchanged. Team workers do not acquire assistant-only cross-workspace scheduling privileges.
5. Do not expose node tokens, gateway credentials or ambient secret environment variables to the worker. The capability broker must have narrow authority; it is not an authenticated gateway proxy accepting arbitrary routes.
6. Arbitrary `Bun`, `process`, imports, filesystem/network access, subprocesses and computed code can bypass a tools-only broker if left available. Static script classification, hidden globals and Function-constructor removal alone do not establish a secure JS compartment.

   **Chosen boundary:** run scripts in QuickJS compiled to WASM (for example quickjs-emscripten, asyncify build) inside the agent process, which already runs under mandatory srt. TypeScript is type-stripped on the host (`Bun.Transpiler`) before evaluation. The realm receives only injected `tools`, bounded `console` and attachment helpers; there is no `Bun`, `process`, module loader, filesystem, network or subprocess access. Memory limits and the interrupt handler enforce memory and CPU budgets. This replaces the Bun subprocess worker for PTC-only mode. (M2: the realm runs in a killable `ptc-guest` child process of the agent, because neither the main thread nor a worker thread can stop every script; see the Milestone 2 notes.)

   Rejected alternatives: nesting another srt/Seatbelt sandbox around a Bun worker fails on macOS inside srt (`sandbox_apply: Operation not permitted`, observed 2026-10-03); `node:vm` and Bun workers with hidden globals are not security boundaries.

   Milestone 1 spike acceptance: escape tests cannot reach `Bun`, `process`, `import()`, constructor chains or host objects; asynchronous capability calls support cancellation and timeout; the compiled single-binary build loads the WASM module; fixture latency is measured against the current worker. If the spike fails, do not claim all operations are mediated and keep PTC-only rollout blocked.

7. The current worker inherits the agent environment (`{ ...process.env, ...ctx.env }`). Milestone 1 inventories which values reach it; the QuickJS realm receives no environment at all.
8. Deny prototype/property tricks and malformed IPC; validate sender identity, call correlation and capability names. Prevent access to credential stores and other sessions' state through direct or broker paths.

## 5. Lifecycle, partial failure and human interaction

Define explicit execution states: running, waiting approval, waiting user, waiting child/job, cancelling and finished. Publish transitions rather than inferring them from absent output.

- Separate active execution budget from human wait time; retain a bounded wait/expiry policy. A confirmation must not fail merely because the ordinary script timeout expires while the user reads it.
- User cancellation stops queued work, cancels pending interactions and terminates eligible in-flight subprocess groups. Late answers/results cannot resume a cancelled execution. Durable jobs use their documented independent lifecycle.
- Long builds/servers return handles. Waiting uses event-driven bounded waits, never agent polling loops.
- Approval denial surfaces as `ApprovalDenied` on that operation only; earlier operations are reported as completed.
- Sequential code stops on a thrown error unless explicitly handled. Parallel work has explicit concurrency limits and documented failure/cancellation behavior. Writes are not implicitly parallelized.
- Return an authoritative bounded completion summary even when the script crashes: completed, failed, cancelled, and unknown-outcome operations. Already completed effects are not rolled back automatically.
- Never retry a whole script automatically after side effects. Use operation-specific idempotency/deduplication where supported; otherwise surface uncertain outcomes for inspection. Test disconnects after execution but before acknowledgement.

## 6. Observability without new private-content exposure

Assign outer execution and inner operation IDs, parent links, order, status and duration. Follow tm's trace structure: every node carries `turnId`, `executionId`, `nodeId`, optional `parentNodeId`, `sequence`, `type`, `status` and `createdAt`; node types cover execution, `par` scope and operation; operations add capability name, duration, counts and approved handle references. An operation moves `running → suspended → running → completed | failed | timed_out | cancelled`; suspension links to the existing approval/question records rather than creating a second approval record. Events are append-only and ordered; reconnect may coalesce progress but never drops or reorders terminal or approval transitions.

**Inner operations have the same exposure as direct calls (decided 2026-10-03).** Today a direct call emits `tool_execution_start/update/end` (`agent.ts` `executeTool`) with full arguments and results to the owner's live event stream and records them in node-local session.jsonl; the gateway daemon does not persist them. Inner operations reuse those events with parent IDs and are recorded in session.jsonl with the same result truncation, so a reloaded session can still expand them. Stored volume is no larger than if every step had been a direct call. The boundary is not redaction but location: content must not reach anywhere a direct call's content does not reach today (gateway storage, push notifications, logs, telemetry, benchmark reports). No per-capability safe-preview redaction rules are needed. Web and Android show expandable internal operations, meaningful labels, approvals and errors instead of an opaque `ptc` blob. The context inspector distinguishes the two provider-visible tools from permitted internal capabilities.

Operational records must survive script failure. Inner results enter model context only through the script's bounded return value; session.jsonl records them under the direct-call rules above, not a second copy. Define owner checks before adding new storage or events. Audit node-to-gateway event forwarding explicitly: new paths must not export script bodies, file contents, arguments or intermediate results beyond what the existing live tool-event stream already carries. Benchmark reports contain aggregates, not raw transcripts.

## 7. Compatibility and rollout

- **No runtime mode switch.** There is no operator setting, per-session mode or fallback: the tool surface is all-or-nothing. Develop on a dedicated branch (rebased onto `main` regularly); `main` keeps the current surface until cutover. Evaluate by building both `main` and the branch and running the same fixtures against each binary, so the fixture harness drives agents through their public interface and works unchanged on both.
- If the Milestone 4 evaluation passes and the maintainer approves, merge the branch as the cutover: the provider-facing `code` tool and direct tool schemas are removed together with `features.code` and the legacy auto-mode script classifier (`auto-mode/script.ts`). If it fails, the branch is not merged and the plan records why.
- Model-written code can never enable capabilities.
- Keep old `code`/tool-call history readable without rewriting JSONL. Update provider replay/adapters so old tool names in history do not break a new two-tool run; test resume and compaction.
- Existing sessions resumed after cutover get the new surface; their old history must replay correctly (previous item).
- Audit roles, prompts, skills guidance, capability gates, provider schemas, context inspector, RPC events and client renderers. Existing tool-specific hook/policy names continue to refer to internal operations.
- Rules that name `code` (hook matchers, auto-mode deny lists, `SHELL_TOOLS` in `features/sandbox.ts`) are applied to `ptc` with a deprecation warning, so a user's restriction on scripts does not silently stop applying. `ptc` keeps the `code` argument name, so hooks inspecting `args.code` keep working.
- Update node/chat configuration docs and release notes, including the chat migration and any contract incompatibilities. Treat breaking configuration changes under the repository's release policy.
- Do not delete underlying tool implementations merely because their schemas are hidden; they become the capabilities.
- No service-language rewrite or binary-size claim in this plan. PTC-only still needs an execution runtime; moving schemas does not remove bundled code.

## Milestones and acceptance

### Milestone 1 — Contracts and baseline

- [x] Inventory every model tool and restricted worker, including currently non-PTC tools; map permissions, results, interaction/lifecycle and migration needs.
- [x] Specify registry (including approval class, suspension support and UI labels), input/result/error contracts, docs pagination, numeric budgets and capability visibility.
- [x] QuickJS-WASM isolation spike against the §4 acceptance criteria; inventory environment sources/names reaching the current worker (no private values inspected; compiled standalone spike, not production integration).
- [x] Confirm the internal-worker list exempt from PTC-only (§1) and the role-list warnings (specified/reference-tested; production warnings are M2).
- [x] Build reproducible disposable fixtures: single `bash` command (highest weight: 8,165 of 19,227 direct calls), single read, multi-file edits, dependent read/edit, output filtering, browser image, user question, approval denial, background build, team wait, schedule and permission rejection.
- [x] On `main`, record baseline task success, retries, model rounds, input/output/cache usage, docs/schema/context size, wall time and runtime resource use. Predeclare acceptable regression bounds before comparing modes; no fabricated token savings. (300 measured uncached/warm trials over 15 fixtures with full provider accounting and cgroup resources; aggregate report [ptc-m1-openai-baseline.json](ptc-m1-openai-baseline.json). M4 must reuse the same model, fixtures, oracles and readiness function, including the recorded authorization-enforcement amendment.)

### Milestone 2 — Execution and discovery

- [x] On the PTC-only branch, implement registry-backed `ptc_docs` and the two-schema surface.
- [x] Implement structured SDK (typed errors, `tools.par`), literal-name capability manifest and pre-evaluation check, mediated execution, quotas, partial-result reporting and cancellation.
- [x] Test invalid inputs, stale docs, forbidden capabilities, computed capability names, direct-runtime escape attempts, IPC abuse, pending-call quota races, worker crashes and unacknowledged side effects.
- [x] Verify mandatory sandbox failure blocks startup and execution, including chat. (No sandbox: no node or chat agent starts, so no script runs — `sandbox.integration.test.ts`; under the real srt every operation of a script, and its `ptc-guest` process, stays confined — `sandbox-srt.integration.test.ts` with `PIRC_TEST_SRT=embedded`, run outside the development sandbox.)

Milestone 2 implementation notes (2026-10-04/05, `feat/ptc-only`):

- Code: `apps/gateway/src/agent/ptc/` (`contracts.ts`, `schema.ts` argument validation, `registry.ts` metadata/docs/cursors, `preflight.ts` acorn-based literal-name manifest, `runtime.ts` host side of an execution (quotas, write slot, records, trace, budget), `guest.ts` the QuickJS realm and SDK (the `ptc-guest` command), `protocol.ts` their messages, `index.ts` the two tools). `Agent` keeps capabilities separate from the two model tools (`modelToolList`, `invokeOperation` with a stage per refusal), validates arguments before hooks and again after hook rewrites, and rejects direct provider calls to capability names. The Bun `code` tool, its `ptc-worker` command and `features/code.ts` are removed; `features.code` has no effect. QuickJS and acorn are `@pirc/gateway` dependencies.
- Script process (maintainer decisions 2026-10-04/05, after review): the QuickJS realm (still the security boundary) runs in a `ptc-guest` child process that the agent starts from its own executable, with an empty environment, inside the same OS sandbox and process group. Running QuickJS on the agent's main thread let a busy script block dialog answers and abort RPC; a worker thread fixed that but cannot be stopped, because terminating a thread does not stop running WASM and QuickJS's regular-expression engine never calls the interrupt handler (a backtracking pattern kept a core busy after its timeout). A process is ended with SIGKILL on cancellation, timeout or quota, and the host waits for it to exit; it starts in `/`, not the workspace, so Bun loads no workspace `.env` or `bunfig.toml` preload into it; and when an agent exits abruptly, the node kills what is left of its process group (a busy script process cannot notice its parent is gone). Pre-existing, outside M2: compiled executables still autoload `.env`/`bunfig.toml` from their own working directory, and the agent itself starts in the workspace; decide separately whether to build with `--no-compile-autoload-dotenv`/`--no-compile-autoload-bunfig`. Messages are JSON over Bun IPC; the guest refuses oversized arguments before sending and caps the returned value, and the host validates every field (including the final outcome), bounds records (refusals past the call quota are only counted; a script that keeps calling is stopped at 1,000 attempts), `tools.par` calls (200, then a catchable QuotaExceeded) and the trace. The budget pauses for a human only while the script itself is idle (waiting for operations). Each execution pays a process start (tens of milliseconds); M4 measures it. Note: after a busy loop JavaScriptCore spends several seconds once per process tiering up the interpreter in the background; that is compilation, not the script (the CPU test disables that tier).
- `tools.par` ownership is best effort, because QuickJS has no async-context API: an operation belongs to a par when it starts in an item's synchronous part or in code resumed by an operation of that par. Code resumed by anything else (`await null` before an item's first operation, a promise created outside the par) counts as outside, so a failing par does not cancel it. Every operation is authorized on its own regardless; only sibling cancellation and trace parents are affected.
- Decided for M2 (maintainer, 2026-10-04): every registered tool is a capability through a generic `{ text }` adapter; image parts are reported in `data.omitted` until M3; direct provider calls to capability names are rejected with a pointer to `ptc`; the execution trace lives only in the `ptc` result `details` — inner `tool_execution_*` events and per-operation session records are M3.
- Policy carried over: hooks (`code` matchers apply to `ptc` with a warning), auto mode per operation (the deny-list still applies to the script text), write leases, workspace limits, project capability flags, role/`--tools` restrictions (wrapper names ignored and unknown names warned). Memory provenance counts the capabilities a `ptc` result (or a still-running script) used; `memory_note` revisions persist in their own session entry; a `ptc` result that ran `recall` is hidden from the observer like a direct recall.
- Known gaps for M3: human-wait accounting pauses the active budget only for UI dialogs (sandbox, delegation and schedule approvals still count as active time); team `agent_inbox` notification de-duplication only recognizes direct results, so under PTC it never suppresses (fail-safe duplicates); team activity and clients show only the outer `ptc` call; per-tool `details` (e.g. the edit diff) no longer reach clients. The M1 oracles observe `tool_execution_*` events by tool name, so M3's inner events must carry capability names and M4 must account for the outer `ptc` event without changing the oracles.

### Milestone 3 — Capability and client parity

- [x] Adapt all permitted operations, including multimodal results, user/handoff waits, approvals, team/job lifecycles and scheduling; unsupported paths fail explicitly.
- [x] Add nested-operation UI/event support to web and Android and update context inspection.
- [x] Test existing per-operation hooks/authorization under PTC, cross-workspace confirmation, disabled chat capabilities, restricted child roles and cancellation during approval.
- [x] Verify owner-scoped handles, bounded payloads, cleanup, no additional private-content mirroring, and old-history resume/replay.

Milestone 3 implementation notes (2026-10-05, `feat/ptc-only`):

- Typed results (maintainer decision 2026-10-05: an explicit schema for every capability). A tool declares `resultSchema` (the typed fields; `oneOf` by `action` for action-dependent capabilities, open records only for team events and agents, which the team broker owns) and returns them as `ToolResult.data` (`typed(…)`, `tools/result-schema.ts`). The script receives `text` (the formatted output a direct call showed), `images` when there are any, and those fields; `ptc` validates every successful result against the contract and reports a mismatch as `OperationFailed` with outcome `completed` (a pirc bug, never silent). A failed result carries its typed fields as `error.data` (e.g. a command's `exitCode` and `output`). `data` never reaches the model, events or the session by itself. All 50 capabilities of the inventory declare one, and each contract fits a single `ptc_docs` page (`agent-ptc.test.ts`).
- Images: an operation's images stay on the host (`ptc/attachments.ts`); the script sees `{ handle, mimeType, bytes }` (256-bit random handles, per execution) and queues one with `attachments.add(…)`. Limits: 4 images, 15 minutes or the end of the execution, at most 16 unqueued images kept (the oldest dropped first); the contracts' 8 MiB each / 16 MiB total was lowered to 512 KiB together by the M4 review (below), so a result with images fits the node's RPC line. Queued images join the outer result only when the script completed; a model without image input refuses `add` with `CapabilityUnavailable`. Known limit, unchanged from direct calls: the node's per-line RPC limit (`PIRC_RPC_MAX_LINE_BYTES`, default 1 MiB) also bounds a result carrying images.
- Observability: each operation emits `tool_execution_start/update/end` under its capability name with `parentToolCallId` (the `ptc` call) and its own `toolCallId` (`<executionId>:op<n>`), like a direct call, and is recorded as a `ptc.operation` session entry (never a `message`, so never model context). The node snapshot's history lists them (`historyWithOperations`) before the `ptc` result they belong to, and `operations` lists those still running (node reducer, arguments only, bounded). Dialogs opened by an operation, and the node's own sandbox approvals, carry its `toolCallId`; clients show the operation as waiting while the card stays at the bottom. No new storage: events stay in the existing in-memory replay rings; the gateway relays the snapshot unchanged; interactions gain only the opaque id.
- Waits: the active-time budget pauses for UI dialogs, the node's sandbox requests (the whole request, including an approved `unsandboxed_bash` command, which its own timeout bounds) and `browser_handoff`. Waiting for children or jobs still counts (contracts §Budgets). Delegation and schedule proposals return at once and need no pause.
- Team: an `agent_inbox` event read by a script counts as read when its whole body reached the model in the `ptc` result (`operationRecorded`); otherwise it is still delivered (fail-safe). Team activity names the operation (`tool: ptc › read`).
- Clients: web and Android nest operations under their script card (`operations`), summarize a script by what it ran, show the script source and result on demand, count operations in run cards, and mark the operation a pending dialog belongs to. Shared golden case `fixtures/timeline/ptc-operations.json`. The web context inspector lists the provider tools and, separately, the capabilities (no schemas: `ContextSnapshot.capabilities`); Android has no inspector.
- Old history: sessions with direct calls and the retired `code` tool resume and replay unchanged (OpenAI chat and Anthropic adapters tested with a fake provider; real providers not exercised).

### Milestone 4 — Evaluation and migration

Evaluation bounds (decided 2026-10-03; applied separately to coding and chat):

- Authorization and cancellation fixtures: results identical to `main` in every trial.
- Success rate: not lower than `main` in any fixture category.
- Single-call tasks (one `bash`, one `read`, chat `web_search`): at most +15% tokens and +20% wall time versus `main`.
- Batch tasks: fewer model rounds and fewer tokens than `main`. Failing this removes the reason for PTC-only.
- Total tokens across all fixtures: not more than `main`.

Only one model is evaluated: originally Claude Opus 5.5, replaced by maintainer approval with OpenAI Responses `gpt-6.1-sol` (Standard tier, main reasoning medium) because the proxy's cache behavior was unverifiable; M4 must use the same model and protocol as the M1 baseline. Cutover is all-or-nothing, so users of other providers also get the PTC-only surface on the strength of this single-model result; the maintainer accepts this risk.

- [x] Compare the `main` and branch binaries on the same task fixtures, model, permissions and completion checks: `gpt-6.1-sol` (the M1 OpenAI baseline is the `main` side), 10 trials per fixture per binary, uncached and warm cache. Include docs overhead, script generation, failures and retries. Pre-declared protocol, oracle mapping and bound refinements: [ptc-m4-evaluation.md](ptc-m4-evaluation.md).
- [x] Use disposable workspaces and fake external services; never benchmark by publishing, purchasing, sending messages or changing real schedules.
- [x] Report per-task results as well as totals so gains on large batches do not hide regressions on simple calls or human-interactive tasks. Report chat separately from coding, against its own bounds.
- [x] Require full critical authorization/cancellation parity; accept efficiency/reliability only against the bounds below. If bounds fail, do not merge; record why in this plan.
- [x] Fresh independent security/design review, fixes, narrow regression tests and repo-required checks (`bun run check`; Android validation when changed). Document real-runtime checks not executable in CI. Done 2026-10-07 (below, "Milestone 4 review").
- [x] Obtain the cutover decision, update docs/release notes (including the chat change and removed `features.code`), then merge. Mark milestones complete only after verified acceptance. Done 2026-10-07: the maintainer accepted the hybrid surface (below); `CHANGELOG.md` (Unreleased), `README.md`, `docs/deploy/upgrades.md` and the other deploy docs describe it, reviewed for accuracy against the code and these results; the legacy auto-mode script classifier (`auto-mode/script.ts`) was removed with the `code` tool, as §7 planned; `bun run check` passed (gateway 922, compiled 121); merged into `main` as one squash commit.

Milestone 4 results (2026-10-06, `ptc-m4-001`; aggregate report [ptc-m4-openai-evaluation.json](ptc-m4-openai-evaluation.json)):

- **Verdict: the PTC-only surface fails the M4 bounds for both coding and chat. Do not merge.** The cutover decision is open (below).
- **Run.** All 300 measured trials (plus 150 primes) ran on the pinned PTC-only builds, under the pre-declared protocol and oracle mapping ([ptc-m4-evaluation.md](ptc-m4-evaluation.md)). Lifecycle, cache conditions, accounting, usage and budget were valid. Readiness is `missing: ["authorization_unverified"]` (approval-denial, below). M4 spent USD 6.63 (2,141 attempts); the independent OpenAI budget stands at USD 17.33 of 100.
- **Bounds that fail:**
  - Single-call wall time (limit +20%): single-bash +26% uncached / +50% warm, single-read +36% / +42%, chat-web-search +36% / +37%. Every single call takes three model rounds instead of two, because the model looks up `ptc_docs` first (one docs call per trial in every fixture).
  - Batch rounds (must be fewer): multi-edit 4.2 / 4.3 rounds against 3.7, dependent-edit 5.0 against 4.9. By the plan, failing this removes the reason for PTC-only.
  - Success (per fixture, both conditions pooled): approval-denial 10/20 against 20/20, schedule 16/20 against 17/20, chat-permission 11/20 against 13/20.
  - Authorization parity: approval-denial is enforced in 5/10 trials per condition against 10/10. In the other ten trials no confirmation matching `git push --force nowhere` reached the denial service. One unexpected interaction was refused instead, and the nested operation completed without error, so the oracle cannot show that the denial was exercised. The stored counts do not say which capability the model used (for example a question asking for approval instead of the command). Schedule, permission-rejection and chat-permission are enforced in every trial, and cancel-wait was cancelled in every trial.
- **Bounds that pass:**
  - Tokens, a large saving: weighted mean coding 9,024 / 8,940 against 17,298 / 17,117 (−48%); single calls −51% to −56%; batches −58% to −59%; chat 5,578 / 6,383 against 6,488 / 6,492. Request schema bytes fall from about 11 KB to 2.8 KB.
  - Success also improved: team-wait 11/20 against 3/20, multi-edit 20/20 against 17/20, permission-rejection 1/20 against 0/20. All other coding fixtures held 20/20.
- **Resources.** Agent cgroup `memory.peak` is about 94 MB per trial (154 MB with a team child). Operations per script: p50 1, p90 3, p99 6, max 6, so the 200-operation quota is far from binding.
- **What would change the result:** removing the docs round (capability signatures in the index, or `ptc_docs` folded into `ptc`) addresses the wall and batch-round failures. The approval-denial behaviour needs a content-free diagnostic before any re-run. Either would be a new implementation and a new pre-declared M4 run, not a regrade of `ptc-m4-001`.

Milestone 4 round 2 results (2026-10-06, `ptc-m4-002` continued by `ptc-m4-003`; aggregate report [ptc-m4-round2-evaluation.json](ptc-m4-round2-evaluation.json); protocol and amendment in [ptc-m4-evaluation.md](ptc-m4-evaluation.md)):

- **Verdict: still fails the bounds, for coding and for chat. Do not merge.** The change put the core capability signatures in the system prompt, staying PTC-only.
- **Run.** 300 measured trials and 150 primes, judged as one matrix; the matrix ran to the end.
  - 309 rows are reused from the stopped `ptc-m4-002`. Coding fixtures through `schedule` index 2 come from it; the rest of `schedule`, then permission-rejection, cancel-wait and both chat fixtures, come from the `ptc-m4-003` process.
  - Its stopping row (a client-cancelled request with no usage; the aggregates do not show why) was superseded and repeated. That attempt was charged at its full USD 4.86 reservation, as declared before resuming.
  - Readiness is `missing: ["authorization_unverified"]` (approval-denial).
  - Round 2 cost USD 11.90 including that charge; the independent OpenAI budget stands at USD 29.23 of 100.
- **What the signatures fixed:**
  - The `ptc_docs` round is gone for core work. Single calls take 2 rounds, as on `main`.
  - Multi-edit takes 3.0 rounds against 3.7 and dependent-edit 4.0–4.1 against 4.9, so the **batch bound now passes**.
  - Uncached single-call wall time now passes: single-bash −4%, single-read +1%, chat-web-search +12%.
  - Success rose: team-wait 17/20 (main 3/20), schedule 19/20 (17), permission-rejection 8/20 (0), multi-edit 20/20 (17).
- **What fails:**
  - **Approval-denial, a regression from round 1:** success 1/20 against 20/20 on `main`, and authorization enforced in 1/20 trials (round 1: 10/20). The content-free diagnostics show what happened:
    - In 19 trials the script called `ask_user_question` (19 `select` interactions) and never ran the command, so the host's own approval, the denial the oracle expects, was never exercised.
    - No push ran in any trial.
    - On `main` the model ran the command and the host asked. A likely explanation, not shown by the counts, is that the model reads "request approval" literally once `ask_user_question` is among its capabilities.
  - **Chat total tokens, a regression from round 1:** +24% uncached / +20% warm against `main`. Round 1 passed this bound at 5,578 / 6,383.
    - The failure comes from chat-permission: 4,367 → 9,645 tokens and 1.0 → 2.7 rounds against `main`, with 1.6–1.7 `ptc_docs` calls per trial. Which capability it looked up is not recorded.
    - chat-web-search itself is −25% against `main`.
  - **Warm single-call wall time:** single-bash +20.5% (limit +20%), single-read +37%, chat-web-search +59%. Uncached passes.
    - Warm is slower than uncached in 14 of 15 PTC fixture groups, by up to +59%. In the baseline it is slower in 10 of 15, by up to +11%.
    - The cause is not identified.
- **Cost of the larger prompt.** Against round 1, coding weighted mean tokens rose 23–27% (9,024 → 11,129 uncached, 8,940 → 11,325 warm); coding is still −34% to −36% against `main`. Browser-image, user-question, background-build and schedule each grew by about 5,100–5,200 tokens per trial. Cancel-wait grew by about 3,500 and approval-denial by about 6,000–6,500.
- **Compared with Anthropic's advanced tool use** ([engineering post](https://www.anthropic.com/engineering/advanced-tool-use), [programmatic tool calling docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)):
  - _Keep the three to five most-used tools loaded and defer the rest_ matches what removed the docs round here. Anthropic's deferred definitions stay out of the prompt; only the search tool and the loaded tools cost tokens. Our one-line summaries of every other capability put a cost on every request instead. Names only, as `defer_loading` keeps them out of context, would be the closer analogue.
  - _Document return formats_ is what the signatures do. Anthropic adds Tool Use Examples for conventions a schema cannot express; "approval is requested by running the operation, and the host asks" is such a convention.
  - _Programmatic calling is a weak fit for a few small calls._ The documentation reports that on τ²-bench, where each turn makes one or two sequential tool calls, it left scores unchanged and cost roughly 8% more. It lets each tool choose direct or programmatic callers (`allowed_callers`). Our remaining wall-time failures are on single calls, so a hybrid surface is the lever the maintainer deferred in round 2.
- **Candidates for a round 3** (each needs its own pre-declaration):
  - A one-line convention in the `ptc` prompt: approvals come from the host when an operation runs, so never ask the user separately for permission.
  - Names only (no summaries) for non-core capabilities.
  - An offline look at why warm trials are slower.
  - Optionally, a hybrid direct/`ptc` surface for single calls.

Milestone 4 round 3 results (2026-10-07, `ptc-m4-r3-001`…`004`; partial aggregate report [ptc-m4-round3-partial.json](ptc-m4-round3-partial.json); protocol and amendments in [ptc-m4-evaluation.md](ptc-m4-evaluation.md)):

- **No verdict: the round ended incomplete (maintainer decision).** The hybrid surface is not ready to merge on this evidence alone.
  - Rows 1–564 of 900 ran (376 measured trials, 188 per arm, plus primes).
  - Fixtures 1–9 are complete in both arms: 180 measured trials each, plus primes.
  - team-wait is partial (4 of 10 indices). Schedule, permission-rejection, cancel-wait and both chat fixtures were never reached.
- **Why it stopped.** Four times, always on the `main` arm's team-wait (indices 3–4), an auxiliary request issued while that binary shut its team down ended without usage. Each was charged at its full USD 4.86 reservation and halted the run.
  - Reading such responses to the end (amendment) did not prevent the fourth stop: that upstream stream ended without usage. The cause is not identified, and it was not reproduced offline.
  - Round 3 cost USD 29.50, of which USD 19.42 are the four charged reservations. The independent OpenAI budget stands at USD 58.73 of 100.
- **What the complete fixtures show.** The hybrid branch (H) was measured against the concurrent `main` arm (M), same session, interleaved. These figures are informational, not judged.
  - **Approval-denial parity is restored** (at a cost: H still makes one `ptc_docs` lookup, 3 rounds against 2, and warm wall time is +35%):
    - 20/20 succeeded and were enforced on H, as on M.
    - On H the model ran `bash` directly every time, and the host's own confirmation (matching the fixture's command) was declined each time. On M the denial came through the sandbox request instead; both count under the same oracle.
    - The approval convention line and the direct route removed round 2's `ask_user_question` detour.
  - **Single calls:**
    - Wall time: single-bash −17% uncached / −9% warm, single-read 0% / +18%, all within +20% of the concurrent M.
    - Tokens: −48%.
    - Against the M1 baseline, warm single-bash (+21%) and single-read (+44%) would still fail. The concurrent M arm is itself 22–33% slower warm than M1 was, which is the drift the interleaved design removes.
  - **Batches:**
    - multi-edit: 3.0 rounds against M's 3.1, tokens −53%.
    - dependent-edit: 5.0 rounds on both, tokens −48%. On H the model chose direct calls for every step (read, read, read, edit), so it gained no round. Under the declared batch bound this fixture would fail.
  - **Success:** all nine fixtures 20/20 on H. On M, output-filter was 18/20.
  - **Fixtures needing a non-core capability** (browser-image, user-question, background-build): H looks the capability up in `ptc_docs` once (names only, no signature). For browser-image and user-question that costs a round (3 against M's 2); background-build takes 3 on both. Tokens are still 13–17% lower, but warm wall time is 21–48% higher.
- **Compared with Codex and the OpenAI guide** ([OpenAI Programmatic Tool Calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling), [Codex code mode](https://github.com/openai/codex/blob/35aaa5d9/codex-rs/code-mode/src/description.rs)):
  - The guide recommends direct calls for single lookups or actions and for approval-sensitive writes, and programs for several filterable or dependent results. Round 3's routing follows it; the approval-denial and single-call results are consistent with that advice.
  - Codex's code mode puts each nested tool's signature into the `exec` tool description and gives scripts an `ALL_TOOLS` list to filter, rather than a separate docs tool. That avoids the lookup round we still pay for non-core capabilities.
  - The guide notes that dependent calls benefit from a program only when code can derive later arguments. dependent-edit's model chose the direct route anyway, so its rounds did not drop.
- **If evaluation continues** (each item a new pre-declared decision):
  - Give non-core capabilities short signatures too (Codex-style) to remove the lookup round.
  - Find out why the `main` binary's team-wait shutdown leaves usage-less auxiliary requests, or exclude post-settle auxiliary requests from the halting rule for both arms.
  - Run the remaining fixtures, including chat, under the interleaved design.

Milestone 4 round 4 results: the final round (2026-10-07, `ptc-m4-r4-001`; aggregate report [ptc-m4-round4-evaluation.json](ptc-m4-round4-evaluation.json); protocol in [ptc-m4-evaluation.md](ptc-m4-evaluation.md)):

- **Verdict: fails the bounds for coding and for chat. Do not merge.** Both are judged against the concurrent `main` arm (primary) and against M1 (secondary).
- **Run.** The full interleaved matrix ran cleanly in one process, with no stops: 900 rows, 300 measured trials per arm. Both arms are ready, and both have full authorization and cancellation parity. With session titles off for both arms, no run stopped and no uncertain attempt was charged. Round 4 cost USD 17.66; the independent budget stands at USD 76.39 of the raised USD 150 limit.
- **What changed, from Pi's codemode:**
  - Signatures of every capability that fits a 12,000-character budget are in the prompt.
  - A non-zero `bash` exit resolves in scripts.
  - `store`/`load` keep small JSON state.
  - The hybrid surface and approval convention of round 3 stay.
- **What passes, against the concurrent `main`:**
  - **Authorization and cancellation:**
    - All four authorization fixtures are 20/20 enforced on both arms, and cancel-wait is 20/20.
    - On approval-denial (uncached) the branch went through a script calling `unsandboxed_bash` in 8 of 10 trials (the host's sandbox approval, declined) and direct `bash` in 2. Every trial in both conditions was enforced and successful.
  - **Single calls:** single-bash wall −25% uncached / −20% warm, single-read −25% / 0%. Tokens −13%, all within bounds.
  - **Lookup round:** fixtures whose capability now fits the budget (browser-image, user-question, approval-denial) take 2 rounds, as `main` does, instead of round 3's 3.
  - **multi-edit:** 3.0 rounds against 3.3, tokens −27%.
  - **Coding weighted mean wall time:** −15% uncached / −3% warm.
  - **Coding weighted mean tokens:** −2.5% uncached / 0.0% warm, so the total bound passes, narrowly.
  - **Success that improved:** team-wait 10/20 (main 3/20), permission-rejection 10/20 (0/20). Both vary sharply by condition on the branch (team-wait 8 uncached / 2 warm, permission-rejection 9 / 1), and n = 10 per cell is noisy.
  - **Fixtures that still need a `ptc_docs` lookup cost more:** schedule takes 3 rounds against 2 and +64% tokens. Background-build is +18% tokens, and team-wait +19% / +38%. This is why the coding total passes only narrowly.
- **What fails:**
  - **dependent-edit:** 5.0 rounds on both arms. The model takes the direct route step by step, as in round 3.
  - **Success:**
    - output-filter 18/20 against 20/20.
    - schedule 16/20 against 17/20.
    - chat-permission 9/20 against 17/20.
  - **Chat tokens:**
    - chat-web-search is +32% against the concurrent `main` (limit +15%).
    - The chat weighted total is +133%. chat-permission rose from 4,219 to 18,370 tokens and from 1 round to 3, with about two `ptc_docs` calls per trial (2.0 / 1.9). The fixture asks for a background task, which chat sessions lack; what was looked up is not recorded.
- **The trade-off the rounds show.**
  - Prompt-resident signatures removed the lookup round for the three fixtures whose capability now fits (browser-image, user-question, approval-denial). Most of the coding wall-time gain against the concurrent `main` (−15% / −3%) comes from fixtures without lookups (single-bash, multi-edit), so it is not caused by the signatures alone.
  - Every request pays for the signatures. Single-call token savings against the concurrent `main` shrank from −48% (round 3, core signatures only) to −13%. Coding's weighted total saving against M1 fell from about −35% (round 2) to −6% / −5% (round 4); against the concurrent `main` it is −2.5% / 0.0%.
  - In chat, where most capabilities are absent, a missing capability now costs more lookups than on `main`.
  - Splitting the work (direct for single steps, scripts for batches) fixed authorization parity and single-call latency. But dependent multi-step edits gain nothing, because the model chooses the direct route for each step.
- **Comparison across harnesses** (the maintainer's last reference round):
  - Pi's codemode, Codex's code mode, OpenAI's Programmatic Tool Calling guide and Anthropic's `allowed_callers` broadly agree with the shape round 4 implements: direct tools for single and approval-sensitive actions, code for batches, and inline declarations under a budget. One difference remains: capabilities that do not fit are looked up here through the model-visible `ptc_docs`, not inside scripts (Pi's `describeTool`, Codex's `ALL_TOOLS`).
  - On this fixture set (mostly one- or two-step tasks) that shape matches `main` on latency and coding tokens and keeps authorization parity. It does not beat `main` on dependent edits, chat token cost or every success rate, so the plan's bounds are not met.
  - The plan's batch criterion ("fewer rounds and tokens; failing this removes the reason for PTC-only") is met by multi-edit in every round since round 2. dependent-edit met it only in round 2 (PTC-only, 4.0–4.1 rounds against M1's 4.9), and never since the hybrid surface (rounds 3–4), where the model takes the direct route for each step.

Milestone 4 round 5 results: the final optimization round (2026-10-07, `ptc-m4-r5-001`…`003`; aggregate report [ptc-m4-round5-evaluation.json](ptc-m4-round5-evaluation.json); protocol in [ptc-m4-evaluation.md](ptc-m4-evaluation.md)):

- **Verdict: still fails, narrowly for coding and clearly for chat. Do not merge as is.** Primary against the concurrent `main`. The secondary verdict against M1 also fails: coding on dependent-edit rounds and output-filter success (19 against 20); chat on chat-permission (2 against 13) and weighted tokens (+4% / +12%).
- **Run.** The full interleaved matrix completed: 900 rows, 300 measured trials per arm, both arms ready, full authorization and cancellation parity. It was continued twice under the declared rule:
  - First stop, ptc / team-wait / 7: the helper was not the fixture's named one, so its requests had no attributable owner and the accounting gate stopped the run. All usage was known, and nothing was charged beyond it.
  - Second stop, ptc / team-wait / 9: a parent model response ended without usage even when read to its end, and was charged at its USD 4.86 reservation.
  - Round 5 cost USD 20.25 including that charge; the budget stands at USD 96.64 of 150.
- **What changed:**
  - Core capabilities keep full signatures; every other capability gets a one-line call signature. Everything fits a 10,000-character budget.
  - The prompt says the list is complete.
  - The routing line now carries a neutral dependent-steps example.
- **Coding, against the concurrent `main`, passes every bound but one:**
  - **Tokens:** weighted means −20% uncached / −21% warm (−24% against M1). Round 4 was about 0%.
  - **Wall time:** weighted −16% / −13%.
  - **Single calls:**
    - single-bash: tokens −21%, wall −13% / −10%.
    - single-read: tokens −21%, wall −42% / −3%.
  - **multi-edit:** 3.0 rounds against 3.1 / 3.4, tokens −29% / −36%.
  - **No lookup rounds:** every coding fixture now finds its capability in the prompt (`ptc_docs` 0 per trial, except schedule 0.3 and permission-rejection uncached 0.1).
  - **Success:**
    - Every fixture is at or above `main`: team-wait 13/20 (3/20), output-filter 19 (17), schedule 18 (17), multi-edit 20 (19), browser-image 20 (19).
    - permission-rejection is 0/20 on both arms: both fetched the page directly with `web_fetch`, which the oracle counts as a failure.
  - **The one failure is dependent-edit:** 5.0 rounds against 4.9, which is not "fewer". Tokens are −19%. The model still takes the direct route for each step despite the routing example.
- **Chat fails:**
  - **chat-permission success is 2/20 against `main`'s 12/20** (round 4: 9 against 17, so these counts are noisy). The branch ran no capability: 1.0 / 1.2 rounds, `ptc_docs` 0 / 0.2. Authorization was enforced in all 20 trials.
    - The task oracle also requires the final answer to say the capability is unavailable in particular words (unavailable, not available, disabled, cannot, …).
    - With no calls the oracle counts (`ptc_docs` is ignored, and the fixture has no files or answer), the failures must come from that wording or the stop reason. A plausible reading, not shown by the counts, is that the model echoes the new "does not exist" wording.
  - **Chat weighted tokens:** +7% uncached / +15% warm. chat-web-search is +6% and within its bound.
- **How far the hybrid surface got, across rounds 1–5 against the same fixtures:**
  - Coding now has lower weighted wall time (−16% / −13%) and about 20% fewer weighted tokens than the concurrent `main`, with full authorization parity and equal or better success per fixture against it.
  - Two items remain short of the pre-declared bounds:
    - dependent multi-step edits: the model does not choose a script, so rounds are equal rather than fewer.
    - chat refusals: not a safety problem (20/20 enforced); the cause is unproven, either the wording or the stop reason.
  - Both look like prompt behavior, not missing capability. Fixing either by targeting these fixtures would be tuning to the evaluation, which the protocol rules out.

Cutover status (2026-10-07, maintainer):

- **Decision: the maintainer accepts the hybrid surface** (core capabilities direct and from `ptc`, everything else through `ptc`), as measured in round 5 and tuned on the public benchmark. This replaces the plan's PTC-only target. The round 5 chat results (chat-permission success, chat tokens) are accepted as they stand.
- The supplementary public-benchmark evaluation of dependent multi-step edits on the Aider polyglot Python exercises is complete ([ptc-m4-evaluation.md](ptc-m4-evaluation.md), "Public benchmark results").
  - On the 19-exercise holdout, the tuned hybrid build matched `main`'s tests-pass count (38/38 each).
  - It used 32% fewer tokens and 43% fewer model rounds (3.16 against 5.55). Its mean wall time was 28% lower (reported, not judged).
  - It passed every declared bound.
- At this decision point, review, checks, docs and release notes remained before merge. They were subsequently completed as recorded in the Milestone 4 acceptance checklist and review below; the listed manual real-runtime release checks remain outstanding.

Milestone 4 review (2026-10-07; whole branch against `main` 16c80846, hybrid surface):

- **Reviews.** Two fresh independent read-only reviews (security/trust boundaries; correctness, concurrency and lifecycle), then a third of the fixes. None found a P0 or P1. Verified: direct calls and script operations take one policy path (availability, project capability policy, schema, `beforeTool` hooks, auto mode on the final arguments, write lease, path guard, `afterTool` hooks); a script has no authority of its own (literal manifest enforced on the host, the realm has no ambient authority, guest messages are checked and bounded); typed `data` stays off events and the session; operation entries never reach model context; events pair; cancellation never counts as consent; old histories (direct calls, the retired `code`) replay.
- **Fixed (with regression tests in `agent-ptc.test.ts`, `ptc-runtime.test.ts`):**

  | Finding                                                                                                                | Pri | Fix                                                                                                                                                                                                                                                                                                                                           |
  | ---------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | A script could swallow a refusal (hook, auto mode, a person) and retry or route around it, re-prompting the user       | P2  | After a refusal only reads run in that script (checked before approval and again before running, so operations already waiting are held back too); node sandbox denials (`unsandboxed_bash`, `sandbox_allow_domains`) are `ApprovalDenied`; a host-written `[declined]` section (fixed wording, never argument text) always reaches the model |
  | Script-made large arguments flooded events, `session.jsonl` and snapshots, and could exceed the RPC line               | P2  | Operation events and session entries record bounded arguments (strings over 16 Ki characters cut, 64 Ki in total); the operation itself gets them in full                                                                                                                                                                                     |
  | Direct core calls rejected arguments `main` accepted (`null` for optional arguments, extra keys such as `description`) | P2  | Direct calls drop those before validation; malformed JSON is still reported as such; scripts stay strict                                                                                                                                                                                                                                      |
  | Up to 16 MiB of images in one result could exceed the 1 MiB node RPC line and kill the agent                           | P2  | Queued images limited to 512 KiB together                                                                                                                                                                                                                                                                                                     |
  | A script calling past 8 operations in flight (nested `tools.par`, a call next to a par) failed with `QuotaExceeded`    | P3  | Calls past the limit wait their turn                                                                                                                                                                                                                                                                                                          |
  | A busy guest outlived a dead parent (team children run in their own process groups)                                    | P3  | QuickJS interrupt handler stops when the guest is orphaned (`process.ppid` changes); a team child's process group is killed when it exits                                                                                                                                                                                                     |
  | `afterTool` hook output of operations could be dropped by the script                                                   | P3  | Host-written `[hooks]` section                                                                                                                                                                                                                                                                                                                |
  | Store taint fenced every later result, also scripts that never `load()`; it did not count for memory provenance        | P3  | Fenced only when the script may have loaded (tracked outside the realm; killed or crashed scripts count as having loaded); counted among a running or finished script's origins                                                                                                                                                               |
  | Formatter-mangled `web_fetch` and `schedule` prompts; completion tests depended on an enclosing pirc team's variables  | P3  | Restored with code spans; variables cleared for those tests                                                                                                                                                                                                                                                                                   |

- **Accepted / follow-ups (P3, not fixed):** bash writes through a symlink created in the same command under a shared root skip the write lease (coordination only, not authority); output of `bash curl`, `agent_inbox`, `delegation_status`, `memory_search` is not marked untrusted (as before the branch for direct calls); the guest runs with the agent's sandbox rights rather than a stricter no-network, no-write profile; the approval convention in the prompt ("run the operation; do not ask separately") is limited to host-gated operations but does not list them; scripting is on in chat with the same budgets; operations that ignore abort can outlive their script past the 5 s grace and report after the turn; after an agent crash mid-script the model sees only "interrupted", not which recorded operations completed; progress counts include operations waiting for a slot, and eight long waits can hold every slot until the script times out (it no longer fails fast).
- **Not re-measured.** These fixes change product behavior and two prompts after the evaluated builds (round 5 and the public benchmark); no paid run was made for them.
- **Checks.** `bun run check` (outside the sandbox) passes: gateway 923 pass, compiled 121 pass, web and typecheck clean. Android `testDebugUnitTest` passes (no Android change in the fixes).
- **Real-runtime checks not executable in CI** (to do by hand before release): a node or agent crash while a script spins (guest exits within about 100 ms of being orphaned; `process.ppid` was confirmed live in Bun by hand, not in a test); a team child crashing mid-script; node sandbox approvals (`unsandboxed_bash`, `sandbox_allow_domains`) declined from the web and Android UIs, with the `[declined]` section shown; screenshots attached from a script through a real node relay; direct calls with `null`/extra arguments from real Anthropic and OpenAI-compatible providers; web and Android rendering of results carrying `[declined]`/`[hooks]` and of bounded operation arguments.

## Open decisions before implementation

- ~~Worker isolation mechanism~~: decided, QuickJS-WASM (§4), pending spike acceptance. The service runtime stays Bun.
- ~~Final SDK result/attachment API~~: Milestone 1 direction approved 2026-10-03: structured result envelopes, typed-data convenience calls and host-owned opaque attachment handles; exact v1 contract in [ptc-m1-contracts.md](ptc-m1-contracts.md).
- ~~Numeric quotas~~: decided as starting values: 64 KB source; 200 internal calls, lowered from the current `MAX_TOOL_CALLS` of 500 (observed p99 17, maximum 57; the limit stops runaway loops, and larger batches split across `ptc` calls). PTC-only routes all work through scripts, so fan-out may grow; record the distribution during Milestone 4 and adjust if needed; model-facing output capped at `toolOutputBytes` (51,200 bytes); execution budget default 120 s and maximum 1 h (`ptcTimeoutMs` and the current cap), excluding human wait, which follows the existing approval/question expiry; at most 8 concurrent operations with 1 write at a time; 128 MB QuickJS memory, verified in the spike with a large-file fixture. The realm runs in a `ptc-guest` child process; host↔guest IPC messages are bounded by the source, argument (1 MiB), result (16 MiB), return-value (1 Mi characters) and console limits.
- ~~Role tool lists and chat defaults~~: decided (§1, §7). The coding-passes/chat-fails case did not arise: both failed in M4 (2026-10-06). All-or-nothing implies abandoning both; the alternative is a fixed, non-configurable split where chat keeps direct tool calls.
- ~~Persisted operation data~~: decided, same exposure as direct calls (§6).
- ~~Evaluation bounds and model~~: decided (Milestone 4).
