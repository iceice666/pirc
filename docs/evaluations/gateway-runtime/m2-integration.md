# Gateway runtime M2: integration continuation

Status: **incremental continuation reviewed and verified; M2 remains incomplete**. The maintainer authorized continuing
remaining M2 work and explicitly accepted harness-only activation: production
sessions retain the existing agent loop, session storage and runner selection.
No M3 writer transfer, deployment, legacy import or data deletion is authorized.

## Implemented continuation

- `environment/service.ts` and `remote.ts` implement the Environment interface over
  separately provisioned node/gateway bindings and journals. Admission snapshots
  requests; duplicate IDs never dispatch twice. Executor loss remains `unknown`.
  Gateway receipts do not automatically ACK. Cancellation waits for an outstanding
  start's durable receipt, because control frames can overtake data assembly.
- `environment/flow.ts` and `chunks.ts` provide bounded, durable chunk assembly,
  a 4 MiB receive-credit window, 64 KiB frames, reserved control capacity and
  round-robin logical data messages. Incoming control processing is independent of
  slow chunk persistence. Closed/replaced flows cannot dispatch after asynchronous
  assembly. Progress is a bounded/coalesced projection, not unlimited journal data.
- The existing authenticated node WebSocket has opt-in harness hooks on both ends.
  No production service constructs an Environment binding or dispatcher. Node-link
  protocol **10** includes a checked registration reply version and node identity;
  incompatible peers fail rather than falling back. Upgrading binaries therefore
  requires matching gateway/node versions even though new session routing is off.
- `environment-executor` is a shipped node/chat subprocess role, launched by
  `NodeSandbox.prepare({environmentExecutor:true})`. It contains no Agent,
  SessionStore, provider interface or model loop. Core file/bash tools reuse the
  local chain, PathGuard, hooks and AutoMode. A narrow classifier callback preserves
  existing Agent-based behavior while allowing an executor broker. The new process
  supervisor is used only by explicit harnesses, not RunnerManager.
- Auto-mode approval brokers receive full hook-rewritten arguments/action and a
  digest, not truncated display text. The node approval authority persists
  single-use records and invalidates waits on disconnect. Generic environment
  messages cannot answer approvals; actual authenticated human UI routing is still
  deferred below.
- Hook processes now run in separate process groups, honor cancellation and drain
  output with bounded retention. Existing local direct/PTC ordering is retained.
- Artifact storage has opaque ownership/hash/range validation, session size limits
  and transcript pinning. Hook receipt primitives bind the complete operation
  identity and record one-time consume/post-hook claims. Neither is a substitute
  for the remaining end-to-end integration.

## Still required before marking M2 complete

The list below records gaps at this continuation's commit. The subsequent
[M2 implementation and Linux validation](m2-completion.md) implements additional
pieces and records the current remaining acceptance gates; it does not mark M2 done.

1. Extract background/browser/sandbox-exception tool factories into the executor;
   current executable supports core tools only. Preserve their cancellation, job
   ownership, human handoff and approved host/network exception semantics.
2. Wire the existing authenticated human/control-lease UI ingress to ApprovalAuthority,
   validate broker schemas/actual final arguments in the supervisor, implement
   policy/revision refresh and approval invalidation, and enforce active/absolute
   budgets with human waits. The current supervisor callback is trusted harness
   injection, not a complete production authorization service.
3. Generate descriptors from actual trusted config, role/capability registries,
   AGENTS/skills and ownership. Current fixtures explicitly construct descriptors;
   absence of a real catalog entry is not blanket gateway execution permission.
4. Route gateway-native preflight/post-hooks through the sandbox executor and
   durable operation journal, with central policy validation and result recovery.
   Receipt storage alone does not execute those phases or establish atomic central
   effect semantics. Integrate artifact transfer with model/UI attachment consumers.
5. Add shared-socket scheduling across legacy HTTP/model/browser traffic. Current
   Environment credit scheduling does not prevent a legacy large frame from
   delaying control, and congestion at the socket writer explicitly fails rather
   than pretending to provide whole-link backpressure.
6. Complete fair queued admission, global quotas, journal disk/soft-cap admission,
   retired-generation compaction and broader supervisor recovery after process crashes.
   Current service uses bounded fail-fast active admission, not the full M1 queue.
7. Add real subprocess crash/restart, lost ACK/approval, both-end reconnect and
   full sandbox security tests. Disk journal tests and fake-srt process tests do
   not establish real Linux/macOS isolation. M3 will atomically couple transcript
   persistence to terminal ACK; receipts alone do not make that promise.

The narrow executor, transport and state-machine integration is useful progress,
but these omissions are acceptance gaps, not optional polish. The M2 checkboxes
remain open. No production environment operation can be started merely by sending
new messages to an ordinary, unprovisioned service.

## Validation

Two read-only review rounds found and corrected full-argument approval binding,
closed-link dispatch fencing, mutable admission snapshots, unknown-outcome
classification, progress bounds, escaped event framing, stalled-data/control
ordering, staging cleanup, sticky persistence faults and truncation metadata.
Regression coverage includes 5 MiB transfers across exhausted receive credit,
paused durable assembly, unknown reconciliation, cross-owner artifacts, receipt
identity, large shell output and untruncated approval action payloads.

The full `bun run check` passed: version/format checks, gateway/web typechecks,
**1007 gateway tests passed / 123 skipped**, **284 web tests passed**, all role/web
builds, and **121 compiled-role tests passed**. The Environment suites passed
**41 tests**. Skipped opt-in tests are not counted as verified.

The approved NixOS temporary namespace supplies `/bin/bash` and `/bin/sh` as
documented in the M0 baseline; it is filesystem compatibility, not OS isolation
evidence. The executor test uses fake-srt and explicitly does not establish real
Linux/macOS containment. The authenticated WebSocket test uses a fake executor;
the shipped process test separately exercises the real core-tool subprocess.
