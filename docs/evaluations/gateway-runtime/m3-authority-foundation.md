# Gateway runtime M3: fresh-session authority foundation

Status: **harness-only first slice; M3 remains incomplete**. The maintainer selected
an authority foundation before the constrained loop and production integrations,
with Linux-first validation and macOS handoff. This authorizes implementation and
synthetic tests, not production routing, deployment/cutover, existing writer
termination, data import or deletion.

## Implemented boundary

`apps/gateway/src/gateway-runtime/authority.ts` introduces a dedicated SQLite
transcript authority with FULL synchronous WAL transactions. It creates distinct
fresh session, writer/executor generation, branch, context and store identities.
Context/store identities are reserved foundation state, not implemented product
snapshot or PTC-store persistence. No legacy JSONL/snapshot reader is invoked.
Explicitly inventoried legacy references are unavailable, unknown references fail
closed, and read access requires the provisioned owner. Existing gateway records
and node files are not modified.

The trusted gateway supervisor prepares a transfer and durably denies legacy
references before requesting node fencing. `node-writer-fence.ts` persists the
node's deny fence before invoking the trusted stop/cleanup verifier and emits a
receipt only after verification succeeds. Failures (including quarantine) leave
the deny fence but no provisioning grant. Receipts match the entire prepared
transfer. Pending transfers survive restarts. Revocation is permanent on each end;
retrying an old transfer does not restore a revoked generation.

These are **trusted lifecycle APIs, not wire handlers**. A receipt or execution ID
is not authorization. No model, generic Environment frame, UI request or peer
message may call provision/activate/stop verification. Stop verification must
independently drain/fence old runners, approvals and jobs; it must reject M2
quarantine rather than treating IPC closure as aggregate cleanup. The callback
must be idempotent cleanup verification, never replay effects or hooks. A single
supervisor owns each database; two simultaneous node supervisors are unsupported.

Generation/branch leases gate appends. Transactional operation-ID dedup rejects
changed payloads. New branches use explicit new-authority ancestry only. Existing
history/operation/compaction projection helpers preserve provider replay metadata
without opening a legacy store. Strict bounded entry schemas reject supplied entry
identities, unsupported values and invalid compaction boundaries.

Execution intent is persisted with its original branch before dispatch. A complete
terminal record is checked against the original binding, argument and result
digests; transcript append and receipt/dedup update commit in one transaction.
Only afterward may the supervisor call `acknowledge`, which can use M2's
`RemoteEnvironment`. Transport receipt alone cannot authorize ACK. Lost ACKs retry
the original digest after restart, without another tool result or side effect.
Late results stay on the original branch, even after a branch switch/revocation.
Verified refinement of an unknown result appends an `execution.reconciled` custom
evidence record instead of a second model tool result. Product display and resumed
model handling of that evidence remain a later integration requirement.

Entry payloads are limited to 8 MiB. An Environment result whose projection exceeds
that limit is explicitly rejected without a transcript receipt/ACK; its node
journal remains authoritative for recovery. The foundation does not silently
truncate, delete or replay it. Product artifact/truncation policy is still pending.

## Validation

The synthetic component fixture covers both-end durable deny fences, failed cleanup,
restart, permanent revocation, exact receipt binding, owner checks, legacy files
untouched, fresh identity separation, schema/byte bounds, replay metadata,
compaction, append/result dedup, branch switch and old-generation reconciliation,
unknown-result refinement, and lost ACK retry through Local/RemoteEnvironment.
Fake/component executors are not OS containment evidence.

Focused command:

```sh
bun test apps/gateway/test/gateway-session-authority.test.ts
```

Repository acceptance command remains `bun run check` (version, formatting,
typechecks, tests, all role/web builds and compiled-role tests). Linux validation
uses the already-authorized temporary `/bin/bash` compatibility namespace described
in [M0](m0-baseline.md#validation-environment). This slice launches no gateway agent
worker and supplies no new Linux/macOS worker-isolation evidence.

### Verified result and review

The final Linux run passed `NODE_OPTIONS=--no-experimental-webstorage bun run check`
inside that compatibility namespace: version/format/typechecks, **1041 gateway
tests passed / 126 skipped / 0 failed**, **284 web tests passed**, all builds, and
**121 compiled-role tests passed**. The focused authority suite passed **7 tests /
51 assertions**. Skipped browser/sandbox/cgroup/disk/platform tests are not counted
as verified. No provider credentials, paid calls or private histories were used.

An initial full run failed five existing timing-sensitive tests (agent output,
PTC deadline/human-wait accounting and Environment reconnect); a focused rerun
still failed agent output and one PTC deadline assertion. The host was under heavy
unrelated compiler load. No unrelated source was changed or timing gate relaxed;
the subsequent entire acceptance stack passed. This does not establish the root
cause of those transient failures or real-platform containment.

Two independent read-only reviewers completed two rounds. They found one P2:
legacy inventory incorrectly required bare UUIDs while existing gateway IDs are
`session_<UUID>` and node transcript IDs are 16-hex strings. The bounded legacy
schema now accepts those formats without weakening fresh binding UUID validation;
regressions cover persistent denial on both ends and fresh-session reclassification
refusal. Both round-two reviews found no remaining actionable issues within scope.

## Still required for M3

- Actual constrained worker/credential-free provider IPC, direct gateway streaming,
  steering, fallback, title/memory/compaction model calls and fake-provider E2E.
- Authenticated writer-transfer wire protocol, version negotiation and production
  legacy-launch enforcement of deny fences. Existing production runners and
  schedule/delegation dispatch remain unchanged, not protected by this harness API.
- Node supervisor startup/quarantine restoration, sandbox executor lifecycle and
  independently verified aggregate cleanup. Offline admission and multi-session
  resource budgets remain supervisor/runtime work, not claims of this storage slice.
- Descriptor refresh, hook phases, attachments, history/recaps/context/file-reference
  routes, durable UI event publication and legacy product-reference blocking.
- Real Linux worker containment tests; equivalent macOS isolation or unsupported
  runtime refusal, with separate macOS operator handoff. No OS gate is marked passed.

No M3 milestone checkbox is complete. The first slice must not be used as a reason
to activate an unconstrained gateway loop or bypass M2 write quarantine.
