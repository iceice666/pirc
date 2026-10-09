# Gateway runtime M4: product parity and Linux acceptance

Continuation baseline: `9a997802ae98`. All runtime composition and routes remain
opt-in. This record supersedes the open implementation gates in
[m4-continuation.md](m4-continuation.md) and [m4-in-progress.md](m4-in-progress.md).
Production routing, writer adoption, legacy import/deletion and M5 cutover are
outside this change.

## Completed behavior

- Direct and PTC calls retain descriptor/catalog admission and the same policy
  entry points. Environment-only batches execute on the node; central-only
  scripts use the constrained native guest; mixed scripts use authenticated
  reverse central RPC. Existing tests cover ten dependent node operations,
  refusal latching, hooks, attachments, partial failure, store/result commit,
  lost replies and original-ID recovery without script replay.
- Gateway streaming now commits its compatibility projection and outbox cursor
  together on the authority connection. Repeated source/sequence events dedup;
  changed payloads and stale sequences fail. Partial messages, steering queues
  and inner-operation parentage survive reconnect. Branch/writer fences apply
  before updates, and stopped runs hide abandoned live operations. Completed
  history remains in the transcript rather than a duplicate mutable history.
  Large wire events request a snapshot refresh instead of oversized control data.
  Todo and goal panels render authoritative branch snapshots with the same pure
  Web/Android widget format; feature commits trigger reconnect refreshes. Goal
  arming reflects live process state and is disarmed after restart.
- Inner PTC start/end events use supervisor-created execution-qualified IDs and
  the authoritative provider tool-call parent. Node projection validates catalog
  membership and at most 200 operation lifecycles/400 events. Child display
  output cannot become a success receipt or approval grant. The trusted host
  exposes `environmentEvent` for the authenticated RemoteEnvironment event sink.
- General questions and node approvals have separate reserved namespaces. The
  fresh route authenticates owner and control lease before answering. Node
  approvals relay their stored binding/digest/revision receipt to the node;
  clients cannot supply that receipt. Node expiry, settlement and disconnect
  must call the bridge's `settled` method. Pending approvals are not restored or
  implicitly granted after gateway restart.
- Fresh workspace records use a separate owner/node/repository index. Search
  and cross-session recall refresh authorized node snapshots before use; offline
  sources fail rather than serving stale content. Refresh atomically removes
  forgotten/retired records. Search limits are applied in SQLite, and recall
  rechecks authoritative owner and repository provenance. Legacy ownerless
  mirrors and legacy JSONL are never fallback authorities.
- Chat memory and project instructions preserve the existing first-load frozen
  branch context. Changes affect new chats; proposal decisions stay current.
  The trusted node supplies bounded project-instruction text in its descriptor.
  Host-recorded note revisions prevent stale overwrites without requiring the
  model to invent revisions, and quoted USER evidence resolves against actual
  user messages on the authoritative branch. Invalid evidence and revision
  conflicts roll back database changes and commit deduplicated failed receipts.
  Local recall remains available when remote recall is disabled; chat fallback
  to other sources requires the explicit trusted remote-recall policy.
- Workspace promotion defaults to the gateway's admitted memory-model loop,
  including configured memory models/fallbacks/budgets. The model receives
  current workspace notes, owner-checked forgotten notes and new candidates;
  all add/retire IDs are checked. Host provenance overrides model provenance.
  Prepared additions and retirements retain original operation IDs across
  restart. Replacement additions commit before retirement, and the node's
  ledger lock and durable receipts protect forget/clear and duplicate requests.
- Team children are fresh gateway runtime sessions on the parent's node and
  workspace. The adapter checks parent/child writer and owner identities; node
  provisioning resolves cwd and intersects parent, role and requested tools.
  Parent/child ask/reply/stop/wait semantics remain in the existing Team service.
  Real constrained phase workers and native PTC guests run two children in the
  integration fixture. Reopening the authority database restores both stopped
  children and results without launching work.
- Schedule/delegation dispatch retains immutable service provenance and durable
  delivery IDs. Existing tests cover queue restart, configuration cancellation,
  claimed-delivery interruption and capacity reservations. Product integration
  now verifies nine deliveries share eight runtime slots, the ninth stays queued
  without configuration, released capacity admits it, owner checks hold and
  repeated deliveries do not reconfigure or call the provider again.
- Goal integration verifies fallback model selection persists through trusted
  continuation turns, rounds advance durably and the round limit pauses the
  goal. Service continuation never manufactures a new human-origin message.
  Restart still disarms automatic continuation until a trusted explicit resume.
- Web and Android keep the shared snapshot/event layout and bounded older-history
  cursors. The Web normalizer handles both reserved interaction namespaces.
  Snapshot sandbox status comes only from live node executor status, never from
  gateway worker placement or an old descriptor.

## Host wiring

Construct `createGatewayRuntimeHost` with the existing shared gateway database,
trusted owner/model/capability authorization and bound Environment adapter.
Install product service maps explicitly; constructing the host never publishes
production endpoints. Wire authenticated RemoteEnvironment events to
`host.environmentEvent`. Publish authenticated node approval records into
`host.environmentInteractions` with the original outer execution ID and a node
relay; wire node settlement/disconnect to `settled`.

For fresh client routes, pass `clientProjection: true`, `host.interactions`,
`host.environmentInteractions`, trusted writer lookup, control-lease verifier and
live node sandbox callback to `registerGatewayRuntimeRoutes`.

Workspace memory adapters supply snapshot/append and optionally retire. The
node channel exposes `workspace.snapshot`, `workspace.append` and
`workspace.retire`; RemoteEnvironment exposes the corresponding methods. A node
retiring another session's item must install `authorizeSource` to independently
check that source's owner. Cross-workspace assistant discovery is available only
through an explicit trusted `workspaceMemory.bindings` callback on a session
approved by `memory.chat`; coding sessions remain scoped to their own binding.
Install `memory.remoteRecall` from the chat's actual feature policy to permit
cross-session recall; its default is disabled. `memory.workspaces` supplies
trusted assistant workspace summaries, and `DescriptorOptions.projectInstructions`
supplies node-read project instructions for chat's frozen prompt snapshot.
All connected peers must ship the new opt-in message/event variants together.

## Validation scope

Linux validation uses Bun 1.4.2, the pinned wasm3 archive validated by the native
build script, the real `bubblewrap` launcher and embedded srt. This container
lacks the optional `/proc/PID/task/PID/children` kernel file; the parent-death
fixture falls back to kernel PPid records and still requires the actual native
worker and its descendants to disappear. An outer PID namespace supplies a
reaping init because the container's PID 1 does not reap orphan processes. This
does not substitute stdin EOF for supervisor death or disable worker fences.

The local srt prerequisite `socat` and its library were extracted from signed
Debian package metadata into ignored `work/tooling`; no privileged/global
installation was performed.

Final `bun run check` passed with **1,174 gateway tests / 145 skips / 0 failures**,
**285 Web tests** and **121 compiled-role tests / 0 failures**. Version, format,
gateway/Web typechecks and builds passed. The gateway suite included the real
Linux native PTC and phase workers, embedded-srt tests and compiled hostile
phase-worker fixtures via the opt-ins below. Skipped tests include Darwin-only
cases, delegated cgroups, full-disk injection and additional optional fixture
matrices; they are not acceptance evidence. New focused M4 regressions passed
**13 tests / 138 assertions / 0 failures** before the final repository run.

The full repository gate is:

```sh
CC=cc PIRC_WASM3_ARCHIVE=/path/to/pinned-wasm3.tar.gz bun run check
```

Real Linux additions enable `PIRC_TEST_SRT=embedded`,
`PIRC_TEST_NATIVE_PTC=$PWD/dist/pirc-ptc-worker` and
`PIRC_TEST_GATEWAY_WORKER=$PWD/dist/pirc-runtime-worker` from `apps/gateway`.
Hostile phase-worker fixtures additionally use the three existing
`PIRC_TEST_GATEWAY_PROBE`, `PIRC_TEST_GATEWAY_FORGED` and
`PIRC_TEST_GATEWAY_MEMORY_PROBE` variables with compiled fixture executables.

macOS real-worker/build tests were skipped in this Linux continuation, as
requested by the maintainer. They were subsequently run against this record's
commit `8bb2718399d8` on macOS arm64. Native PTC, team, worker containment,
real-srt and the full opt-in `bun run check` passed without source changes; see
[m4-macos-validation.md](m4-macos-validation.md). macOS release archives and
Darwin Nix builds remain unverified. Android compilation/APK/device
acceptance remains the maintainer's separate handoff from the earlier record:

```sh
export ANDROID_HOME=/path/to/android-sdk
cd apps/android
./gradlew --no-configuration-cache testDebugUnitTest assembleDebug
```

No manual browser/device interaction, delegated-cgroup containment, full-disk
fault injection, Nix package installation or portable release archive acceptance
is claimed here. These skips and packaging/platform handoffs do not authorize
production cutover; M5 evaluation, review and deployment decision remain open.
