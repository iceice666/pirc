# PTC-only agent interface: `ptc` and `ptc_docs`

Status: proposed; not implemented. Baseline: `main@2530bd2` (code references and statistics, refreshed 2026-10-03). Decided 2026-10-03: the script runtime is QuickJS compiled to WASM (option B, §4) and the TempestMiku `tm` security model is adopted where it fits (see "Prior art"). Decided 2026-10-03: no runtime mode switch; the change is all-or-nothing, developed on a branch and either cut over or abandoned on the Milestone 4 evaluation (§7).

## Direction and scope

The maintainer requested a plan to expose only **`ptc` and `ptc_docs`** to the model, moving existing operations behind the programmatic interface. This is an interface redesign, not permission to delete capabilities, weaken sandboxing, rewrite the service in Go/Rust, or deploy changes.

- [ ] Milestone 1: capability contracts and baseline evaluation.
- [ ] Milestone 2: secure PTC execution, discovery and lifecycle.
- [ ] Milestone 3: full capability coverage and client observability.
- [ ] Milestone 4: comparative evaluation and migration.

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
    return { content: result.content };
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

   **Chosen boundary:** run scripts in QuickJS compiled to WASM (for example quickjs-emscripten, asyncify build) inside the agent process, which already runs under mandatory srt. TypeScript is type-stripped on the host (`Bun.Transpiler`) before evaluation. The realm receives only injected `tools`, bounded `console` and attachment helpers; there is no `Bun`, `process`, module loader, filesystem, network or subprocess access. Memory limits and the interrupt handler enforce memory and CPU budgets. This replaces the Bun subprocess worker for PTC-only mode.

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

- [ ] Inventory every model tool and restricted worker, including currently non-PTC tools; map permissions, results, interaction/lifecycle and migration needs.
- [ ] Specify registry (including approval class, suspension support and UI labels), input/result/error contracts, docs pagination, numeric budgets and capability visibility.
- [ ] QuickJS-WASM isolation spike against the §4 acceptance criteria; inventory environment values reaching the current worker.
- [ ] Confirm the internal-worker list exempt from PTC-only (§1) and the role-list warnings.
- [ ] Build reproducible disposable fixtures: single `bash` command (highest weight: 8,165 of 19,227 direct calls), single read, multi-file edits, dependent read/edit, output filtering, browser image, user question, approval denial, background build, team wait, schedule and permission rejection.
- [ ] On `main`, record baseline task success, retries, model rounds, input/output/cache usage, docs/schema/context size, wall time and runtime resource use. Predeclare acceptable regression bounds before comparing modes; no fabricated token savings.

### Milestone 2 — Execution and discovery

- [ ] On the PTC-only branch, implement registry-backed `ptc_docs` and the two-schema surface.
- [ ] Implement structured SDK (typed errors, `tools.par`), literal-name capability manifest and pre-evaluation check, mediated execution, quotas, partial-result reporting and cancellation.
- [ ] Test invalid inputs, stale docs, forbidden capabilities, computed capability names, direct-runtime escape attempts, IPC abuse, pending-call quota races, worker crashes and unacknowledged side effects.
- [ ] Verify mandatory sandbox failure blocks startup and execution, including chat.

### Milestone 3 — Capability and client parity

- [ ] Adapt all permitted operations, including multimodal results, user/handoff waits, approvals, team/job lifecycles and scheduling; unsupported paths fail explicitly.
- [ ] Add nested-operation UI/event support to web and Android and update context inspection.
- [ ] Test existing per-operation hooks/authorization under PTC, cross-workspace confirmation, disabled chat capabilities, restricted child roles and cancellation during approval.
- [ ] Verify owner-scoped handles, bounded payloads, cleanup, no additional private-content mirroring, and old-history resume/replay.

### Milestone 4 — Evaluation and migration

Evaluation bounds (decided 2026-10-03; applied separately to coding and chat):

- Authorization and cancellation fixtures: results identical to `main` in every trial.
- Success rate: not lower than `main` in any fixture category.
- Single-call tasks (one `bash`, one `read`, chat `web_search`): at most +15% tokens and +20% wall time versus `main`.
- Batch tasks: fewer model rounds and fewer tokens than `main`. Failing this removes the reason for PTC-only.
- Total tokens across all fixtures: not more than `main`.

Only Claude Opus 5.5 is evaluated. Cutover is all-or-nothing, so users of other providers also get the PTC-only surface on the strength of this single-model result; the maintainer accepts this risk.

- [ ] Compare the `main` and branch binaries on the same task fixtures, model, permissions and completion checks: Claude Opus 5.5, 10 trials per fixture per binary, cold and warm cache. Include docs overhead, script generation, failures and retries.
- [ ] Use disposable workspaces and fake external services; never benchmark by publishing, purchasing, sending messages or changing real schedules.
- [ ] Report per-task results as well as totals so gains on large batches do not hide regressions on simple calls or human-interactive tasks. Report chat separately from coding, against its own bounds.
- [ ] Require full critical authorization/cancellation parity; accept efficiency/reliability only against the bounds below. If bounds fail, do not merge; record why in this plan.
- [ ] Fresh independent security/design review, fixes, narrow regression tests and repo-required checks (`bun run check`; Android validation when changed). Document real-runtime checks not executable in CI.
- [ ] Obtain the cutover decision, update docs/release notes (including the chat change and removed `features.code`), then merge. Mark milestones complete only after verified acceptance.

## Open decisions before implementation

- ~~Worker isolation mechanism~~: decided, QuickJS-WASM (§4), pending spike acceptance. The service runtime stays Bun.
- Final SDK result/attachment API.
- ~~Numeric quotas~~: decided as starting values: 64 KB source; 200 internal calls, lowered from the current `MAX_TOOL_CALLS` of 500 (observed p99 17, maximum 57; the limit stops runaway loops, and larger batches split across `ptc` calls). PTC-only routes all work through scripts, so fan-out may grow; record the distribution during Milestone 4 and adjust if needed; model-facing output capped at `toolOutputBytes` (51,200 bytes); execution budget default 120 s and maximum 1 h (`ptcTimeoutMs` and the current cap), excluding human wait, which follows the existing approval/question expiry; at most 8 concurrent operations with 1 write at a time; 128 MB QuickJS memory, verified in the spike with a large-file fixture. The in-process realm has no IPC, so the IPC message limit no longer applies.
- ~~Role tool lists and chat defaults~~: decided (§1, §7). Deferred until evaluation results exist: what happens if coding passes its bounds but chat fails its own. All-or-nothing implies abandoning both; the alternative is a fixed, non-configurable split where chat keeps direct tool calls.
- ~~Persisted operation data~~: decided, same exposure as direct calls (§6).
- ~~Evaluation bounds and model~~: decided (Milestone 4).
