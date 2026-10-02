# PTC-only agent interface: `ptc` and `ptc_docs`

Status: proposed; not implemented. Baseline: `main@ff2bfde`.

## Direction and scope

The maintainer requested a plan to expose only **`ptc` and `ptc_docs`** to the model, moving existing operations behind the programmatic interface. This is an interface redesign, not permission to delete capabilities, weaken sandboxing, rewrite the service in Go/Rust, or deploy changes.

- [ ] Milestone 1: capability contracts and baseline evaluation.
- [ ] Milestone 2: secure PTC execution, discovery and lifecycle.
- [ ] Milestone 3: full capability coverage and client observability.
- [ ] Milestone 4: comparative evaluation and migration.

The two-tool target is the requested direction. Contracts, rollout details and evaluation thresholds below are proposals to verify during implementation; success has not been demonstrated.

## Evidence and limitations

Local statistics supplied by the maintainer (`ptc-stats.txt`, untracked; do not include raw session data in this plan):

| Measure                                          |                           Observed |
| ------------------------------------------------ | ---------------------------------: |
| Coding main sessions indexed / readable          |                          165 / 151 |
| Main sessions with tool calls using PTC          |                   74 / 140 (52.9%) |
| Nested sessions with tool calls using PTC        |                   63 / 111 (56.8%) |
| PTC calls / direct model tool calls              |              1,214 / 18,741 (6.5%) |
| Recorded operations inside PTC                   |                              5,858 |
| PTC results with two or more internal operations | 1,074 / 1,213 with details (88.5%) |
| Average internal operations per detailed result  |                               4.83 |
| Outer PTC error results                          |                  64 / 1,214 (5.3%) |
| Internal edit / read operations                  |                      3,038 / 1,391 |

PTC carries approximately 25.1% of recorded underlying operations after excluding the outer `code` calls. This is **not** a token-saving percentage. The sample covers one node's indexed coding sessions, retained branches and nested agents; 14 main records were missing/unlocatable. Tool availability and model mix were not controlled. Error results are not necessarily script bugs. These counts do not establish that all operations benefit from PTC or that batch calls require arbitrary TypeScript.

Before claiming savings, distinguish fixed batches, repetitive edits, result-dependent execution and output reduction. Use synthetic tasks by default; any additional historical-content analysis needs an authorized scope. Never replay historical scripts against live workspaces to benchmark them.

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

### Chat and worker roles

Changing the transport must not enable Team, Goal, background tasks or other capabilities currently absent from chat by default. The proposed chat target exposes PTC for its existing permitted operations, superseding only the old absence of the `code` wrapper; confirm this migration behavior before changing defaults. Child agents inherit their intended role restrictions and must not obtain a broader registry through PTC. Feature-restricted internal workers need explicit coverage rather than assuming all agent types use the same public tool surface.

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
6. Arbitrary `Bun`, `process`, imports, filesystem/network access, subprocesses and computed code can bypass a tools-only broker if left available. Milestone 1 must choose and document an enforceable execution boundary. Static script classification, hidden globals and Function-constructor removal alone do not establish a secure JS compartment. Prefer a worker restricted to computation plus broker calls, in addition to mandatory OS sandboxing; if this cannot be enforced, do not claim all operations are mediated and block PTC-only rollout until the policy gap is resolved.
7. Deny prototype/property tricks and malformed IPC; validate sender identity, call correlation and capability names. Prevent access to credential stores and other sessions' state through direct or broker paths.

## 5. Lifecycle, partial failure and human interaction

Define explicit execution states: running, waiting approval, waiting user, waiting child/job, cancelling and finished. Publish transitions rather than inferring them from absent output.

- Separate active execution budget from human wait time; retain a bounded wait/expiry policy. A confirmation must not fail merely because the ordinary script timeout expires while the user reads it.
- User cancellation stops queued work, cancels pending interactions and terminates eligible in-flight subprocess groups. Late answers/results cannot resume a cancelled execution. Durable jobs use their documented independent lifecycle.
- Long builds/servers return handles. Waiting uses event-driven bounded waits, never agent polling loops.
- Sequential code stops on a thrown error unless explicitly handled. Parallel work has explicit concurrency limits and documented failure/cancellation behavior. Writes are not implicitly parallelized.
- Return an authoritative bounded completion summary even when the script crashes: completed, failed, cancelled, and unknown-outcome operations. Already completed effects are not rolled back automatically.
- Never retry a whole script automatically after side effects. Use operation-specific idempotency/deduplication where supported; otherwise surface uncertain outcomes for inspection. Test disconnects after execution but before acknowledgement.

## 6. Observability without duplicating private content

Assign outer execution and inner operation IDs, parent links, order, status and duration. Web and Android show expandable internal operations, meaningful labels, approvals and errors instead of an opaque `ptc` blob. The context inspector distinguishes the two provider-visible tools from permitted internal capabilities.

Operational metadata must survive worker failure. Do not duplicate all intermediate outputs into model context or append-only session logs to achieve this. Reuse/redact existing operation display data; define retention, payload budgets and owner checks before adding new storage or events. Audit node-to-gateway event forwarding explicitly: new telemetry must not silently export script bodies, file contents, arguments or intermediate results. Benchmark reports contain aggregates, not raw transcripts.

## 7. Compatibility and rollout

- First add an operator-selected experimental tool-surface mode; do not let model-written code enable capabilities or change modes. A fallback is an operator rollout control, not a model-accessible policy bypass.
- Keep old `code`/tool-call history readable without rewriting JSONL. Update provider replay/adapters so old tool names in history do not break a new two-tool run; test resume and compaction.
- Audit roles, prompts, skills guidance, capability gates, provider schemas, context inspector, RPC events and client renderers. Existing tool-specific hook/policy names continue to refer to internal operations.
- Update node/chat configuration docs and release notes, including the chat migration and any contract incompatibilities. Treat breaking configuration changes under the repository's release policy.
- Only retire legacy provider-facing entry points after parity, evaluation and an explicit rollout decision. Do not delete underlying tool implementations merely because their schemas are hidden.
- No service-language rewrite or binary-size claim in this plan. PTC-only still needs an execution runtime; moving schemas does not remove bundled code.

## Milestones and acceptance

### Milestone 1 — Contracts and baseline

- [ ] Inventory every model tool and restricted worker, including currently non-PTC tools; map permissions, results, interaction/lifecycle and migration needs.
- [ ] Specify registry, input/result/error contracts, docs pagination, numeric budgets, capability visibility and worker isolation approach.
- [ ] Confirm chat defaults and role/config compatibility described above.
- [ ] Build reproducible disposable fixtures: single read, multi-file edits, dependent read/edit, output filtering, browser image, user question, approval denial, background build, team wait, schedule and permission rejection.
- [ ] Record baseline task success, retries, model rounds, input/output/cache usage, docs/schema/context size, wall time and runtime resource use. Predeclare acceptable regression bounds before comparing modes; no fabricated token savings.

### Milestone 2 — Execution and discovery

- [ ] Implement registry-backed `ptc_docs` and a two-schema surface behind the rollout control.
- [ ] Implement structured SDK, mediated execution, quotas, partial-result reporting and cancellation.
- [ ] Test invalid inputs, stale docs, forbidden capabilities, direct-runtime escape attempts, IPC abuse, pending-call quota races, worker crashes and unacknowledged side effects.
- [ ] Verify mandatory sandbox failure blocks startup and execution, including chat.

### Milestone 3 — Capability and client parity

- [ ] Adapt all permitted operations, including multimodal results, user/handoff waits, approvals, team/job lifecycles and scheduling; unsupported paths fail explicitly.
- [ ] Add nested-operation UI/event support to web and Android and update context inspection.
- [ ] Test existing per-operation hooks/authorization under PTC, cross-workspace confirmation, disabled chat capabilities, restricted child roles and cancellation during approval.
- [ ] Verify owner-scoped handles, bounded payloads, cleanup, no additional private-content mirroring, and old-history resume/replay.

### Milestone 4 — Evaluation and migration

- [ ] Compare both modes on the same task fixtures, models, permissions and completion checks, with repeated trials and cold/warm cache cases. Include docs overhead, script generation, failures and retries.
- [ ] Use disposable workspaces and fake external services; never benchmark by publishing, purchasing, sending messages or changing real schedules.
- [ ] Report per-task results as well as totals so gains on large batches do not hide regressions on simple calls or human-interactive tasks.
- [ ] Require full critical authorization/cancellation parity; accept efficiency/reliability only against the bounds agreed in Milestone 1. If bounds fail, retain experimental status and document why.
- [ ] Fresh independent security/design review, fixes, narrow regression tests and repo-required checks (`bun run check`; Android validation when changed). Document real-runtime checks not executable in CI.
- [ ] Obtain rollout decision, update defaults/docs/release notes, and only then retire legacy model entry points. Mark milestones complete only after verified acceptance.

## Open decisions before implementation

- Exact worker isolation mechanism and whether a smaller embedded JS engine can meet the required contract safely; not a commitment to replacing Bun.
- Final SDK result/attachment API and enforced numeric quotas.
- Compatibility mapping for role tool lists and the chat wrapper default.
- Minimal persisted operation metadata and client detail retention without increasing private-content transport.
- Evaluation regression bounds, tested model set, and criteria/timing for removing the experimental fallback.
