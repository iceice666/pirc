# Gateway runtime M2: first foundation slice

Status: **first foundation slice reviewed and verified; M2 remains incomplete**. The maintainer asked
to begin M2 and, after the architecture inventory, explicitly selected only the
first slice: shared local direct/PTC execution, strict Environment logical protocol,
and durable journal foundations. This is not authorization to activate production
RPC, replace sandbox processes, move the agent loop/session authority, deploy, or
delete/import legacy data. [Plan](../../../plans/gateway-agent-runtime.md) and
[reviewed M1 contract](m1-contracts.md) retain authority.

## Implemented scope

- `apps/gateway/src/environment/local.ts`: extract the existing operation chain
  from `Agent.runTool`. Direct tools, wrappers and PTC still call the same chain
  inside the existing sandboxed agent. Validation, hook argument rewriting,
  revalidation, refusal latches, auto-mode policy/classifier, write leases,
  concurrency-slot callbacks, cancellation checks and post-hooks retain ordering.
  The host interface contains local authority and must never be serialized.
- `environment/json.ts` and `protocol.ts`: duplicate-key-aware bounded JSON parsing,
  deterministic digests, closed logical envelopes, node-qualified bindings,
  descriptors with explicit placement, operation/result/event/artifact types and
  an Environment interface. Digests include operation identity, binding, revisions
  and budget, not only arguments. Limits include the correlated delivery envelope.
  Version 1 is the new **logical Environment schema**, not a production node-link
  version bump. Production `NODE_PROTOCOL_VERSION` remains unchanged; both-end
  version negotiation and chunking are follow-up work.
- `environment/journal.ts`: dedicated private SQLite foundation with WAL and
  `synchronous=FULL`; explicit trusted binding provisioning, transactional
  acceptance, one-time execution claim, rejection/deduplication, event sequence,
  cancellation intent, terminal results, ACKs, tombstones and permanent binding
  retirement. Gateway intent/receipt persistence is separate from node acceptance.
  Recovery after supervisor fencing never replays accepted/running operations.
  A supervisor-only evidence path refines an unknown original outcome, resets
  its ACK digest and cannot reopen execution. Gateway receipts enforce artifact
  ownership and allow only that bounded refinement.

The journal is not constructed by production services and does not execute tools.
Its dedicated file must live in a private supervisor-owned directory, outside the
executor's allowed paths. Existing databases and JSONL files are not modified.
Provision/retire/recover/reconcile are trusted lifecycle methods, not exposed RPCs.
Callers must authenticate the binding independently; possession of IDs or a digest
never authorizes an operation or proves an external effect. One supervisor owns a
node journal. A successful `claim` is permission to proceed only after that future
supervisor has completed its sandbox/policy/lease checks; a returned expired record
is not permission to run. Recovery requires stopping/fencing the previous executor.

## Requirements deferred by this first slice

The subsequent [integration continuation](m2-integration.md) implements some of
these foundations and records remaining gaps. The list below describes the scope
at the first-slice commit, not the latest integration status.

- Authenticated node WebSocket integration and both-end version negotiation;
  local/remote Environment adapters and descriptor generation from real config.
- Separate shipped-code sandbox executor, launcher lifecycle, realpath/lease
  binding, and refusal when sandbox startup fails. No daemon fs/spawn shortcut.
- Narrow model-classifier broker: current auto mode still depends on Agent model
  and human context. Do not disable it while extracting the remote path.
- Durable node-owned approval relay, expiry/revocation and authenticated human
  responses, including sandbox network/host-execution exceptions.
- Cancellable hook process groups/output bounds and journaled hook receipts for
  gateway-native tools; all five hook phases remain local in this slice.
- Artifact transfer/storage/reclamation beyond typed owner-checked references.
- Admission quotas, journal soft-cap/disk exhaustion admission, data chunking,
  receive credits, fairness and reserved control capacity. Logical JSON size
  limits are not transport backpressure.
- Node-local monotonic active/absolute deadlines, human waits and background job
  lifetimes. The foundation's wall-clock queue expiry/retention timestamps do not
  restore an executor deadline or extend authorization after restart.
- Long-term retired-generation compaction: this slice retains binding fences and
  intent tombstones rather than deleting them. Unacknowledged and unknown-effect
  data are never automatically reclaimed.
- Authenticated reconnect/old-epoch reconciliation, real process-crash and lost
  transport-reply tests. Disk close/reopen tests are not power-loss/OS evidence.
- Atomic transcript/result integration belongs to M3. Gateway receipt durability
  alone must not trigger a production ACK that promises transcript persistence.

No M2 checkbox is marked complete by this slice. Linux/macOS OS isolation,
production RPC security, flow-control performance and full feature parity remain
unverified. Existing fake-srt integration tests do not prove OS isolation.

## Validation

Narrow suite: new Environment protocol/journal/local tests plus agent PTC, auto
mode, sandbox policy, fake-srt integration and PTC runtime tests: **149 passed,
0 failed** across eight files. The three new suites contain **27 tests / 151
assertions**.

The full `bun run check` passed after review fixes: version/format checks,
gateway/web typechecks, **993 gateway tests passed / 123 skipped**, **284 web tests
passed**, web/gateway/chat/node builds, and **121 compiled-role tests passed**.
Skipped opt-in tests are not counted as verified.

A fresh read-only review found three P2 issues: delivery-envelope overhead was
missing from journal bounds; gateway receipts lacked artifact ownership checks;
and unknown outcomes lacked evidence-only reconciliation. All three were fixed,
covered by regression tests, and approved in a second review.

An existing PTC timing test failed because its simulated 300 ms human wait started
before guest startup, leaving only about 241 ms counted against a 250 ms assertion.
Move the simulated wait/timer to the actual `ask` handler, preserving all durations
and assertions, including late-progress suppression. This test-only synchronization
fix was independently reviewed; no PTC runtime behavior or threshold changed.

This NixOS host lacks `/bin/bash`; existing shell tests fail without filesystem
compatibility. The maintainer separately authorized the temporary bubblewrap
namespace documented in [M0](m0-baseline.md#validation-environment). It supplies
`/bin/bash` and `/bin/sh` without changing host files or production shell code.
This environment retains invoking-user permissions; it is not isolation evidence.
