# Gateway runtime M3: descriptor and attachment turn lifecycle

Current continuation: [M2/M3 Linux runtime and macOS handoff](m3-linux-runtime.md)
connects this lifecycle to the opt-in model loop, tool-result artifact pins,
durable event references and authenticated readers. The status/deferred list below
records this earlier slice; full product parity and macOS continuation remain open.

Status: **harness-only slice; M2 and M3 remain incomplete**. The maintainer selected
this slice instead of the constrained model worker and explicitly accepted
fail-closed descriptor/generation changes: generation handoff remains separate.
No production routing, live writer termination, deployment/cutover, legacy import
or deletion is authorized or implemented.

## Implemented boundary

`gateway-runtime/turn-lifecycle.ts` connects the existing Environment descriptor
and artifact consumers to fresh-session authority. It is a **trusted supervisor
API**, not an HTTP handler, model capability, UI request handler or model loop.
Only an already authorized writer lease may enter it. The supervisor supplies the
authenticated node connection and connectivity state; use one lifecycle instance
per authority. No filesystem path from a descriptor is resolved on the gateway.

- Each turn retrieves and verifies a complete bounded descriptor: schema, digest,
  exact binding and active environment sandbox. The node's instructions and cwd
  remain untrusted context/display data, not gateway permissions. A second
  descriptor check after attachment hydration catches configuration changes
  during asynchronous preparation. Previously committed descriptor revisions are
  immutable for the session, across branches and gateway restarts. A changed
  revision or generation explicitly refuses admission; this code does **not**
  call `replaceEnvironment`, release quarantine or reuse old approval receipts.
- A single SQLite transaction appends the user message and persists the turn's
  descriptor snapshot, branch, run/turn IDs and original artifact references.
  Model image bytes are copied into that message after owner/hash verification.
  Turn-ID retries return the durable entry without fetching or appending again;
  changed payloads conflict. Retries still require an online node, a fresh valid
  descriptor and an active writer/branch. Execution intents for lifecycle-managed
  sessions must match a committed turn's run, revisions, capabilities and budget.
  Durable lifecycle enrollment occurs before the first asynchronous request, so
  failed preparations and restarts cannot enable the foundation compatibility
  path. Existing foundation-only harnesses retain their prior API, but sessions
  with foundation executions cannot enroll retroactively.
- New closed `artifact.pin` / `artifact.pinned` Environment messages use the
  authenticated, binding-authorized channel and idempotent durable node storage.
  Pin happens **before** referencing an artifact in the transcript. Lost pin
  replies can retry; failed/cancelled preparations may conservatively leave pins
  behind. There is no automatic unpin, reference garbage collection or deletion.
  Old peers that do not support pin fail admission, never silently omit it. This
  harness-only additive protocol surface is not production feature negotiation.
- User image attachments retain opaque node/workspace/session ownership, checksum,
  MIME and size. Admission limits are 16 images, 4 MiB total decoded image data,
  1 MiB UTF-8 text, one concurrent preparation/session and four/global per lifecycle
  instance, within the existing 8 MiB entry bound. A 60-second preparation deadline
  and abort-aware request waits release admission slots promptly. In-flight wire
  requests may finish under their transport timeout; late replies cannot append. PNG/JPEG/GIF/WebP use existing
  model-image handling; unavailable, foreign, corrupt or oversized attachments
  explicitly fail the whole turn. There is no partial message or missing-image
  fallback. These are preparation limits, not full runtime resource enforcement.
- Owner-checked `turn.prepared` projections are rebuilt from durable turn rows and
  selected branch ancestry, with stable entry/turn IDs for later event-sink dedup.
  Ancestry-selected pages contain at most 16 turns (an explicit offset retrieves
  subsequent pages), without materializing image entries or invisible branches.
  They expose references rather than base64 payloads, explicitly label provenance
  as node-owned/private-session-content and model copies as gateway-transcript.
  Offline references show unavailable and become retryable on reconnect. An
  online reference is not a new proof that the underlying file still exists;
  actual fetches verify it. Sandbox status is named `sandboxAtAdmission`, never a
  live badge claiming the gateway loop is sandboxed. Projections are pull-based,
  not a durable UI publication/outbox implementation.

## Verification scope

The fixture uses encoded Environment messages, RemoteEnvironment, node artifact
storage and restarted SQLite authorities. It covers retained pins, lost pin reply,
turn dedup/conflicts, cached model data, offline/reconnect projections, branch and
owner separation, descriptor changes before/during preparation, image bounds and
checksum failures, cancellation/revocation/branch races, stalled-request abort,
first-preparation enrollment, paginated branch projections and execution-turn binding.
It uses synthetic fence receipts and no executable node tools; this is **not** real
OS containment or authenticated WebSocket integration evidence.

```sh
bun test apps/gateway/test/gateway-turn-lifecycle.test.ts \
  apps/gateway/test/gateway-session-authority.test.ts
bun run check
```

Linux full checks use the previously authorized `/bin/bash` compatibility namespace
from [M0](m0-baseline.md#validation-environment), with
`NODE_OPTIONS=--no-experimental-webstorage` for jsdom. This is test filesystem
compatibility, not an isolation mechanism. macOS operators can run the commands
above in a disposable checkout; this slice supplies no new macOS validation or
worker-isolation evidence. No paid provider or private history is required.

## Verified result and review

The final Linux acceptance run passed
`NODE_OPTIONS=--no-experimental-webstorage bun run check` in the compatibility
namespace: version/format/typechecks, **1050 gateway tests passed / 126 skipped /
0 failed**, **284 web tests passed**, all role/web builds, and **121 compiled-role
tests passed**. The focused authority/lifecycle suites passed **16 tests / 119
assertions**. Skipped tests are not verified; no new real-sandbox, macOS, browser
or Android validation is claimed. The 60-second preparation deadline was inspected,
not tested by waiting for elapsed expiry; explicit abort paths were exercised.

Two independent read-only reviewers completed two bounded rounds. Three P2s were
fixed: missing durable enrollment during the first preparation, stalled RPCs
retaining admission slots after cancellation, and reference projection materializing
image-bearing history from invisible branches. Both second-round reviews approved
the documented harness scope with no remaining actionable findings. An initial
typecheck found fixture typing mistakes, corrected before the full acceptance
runs; the final full stack passed on the reviewed source.

## Deferred work

The constrained model loop, steering, authenticated generation handoff, M2
quarantine startup integration, production history/UI routes, durable event
publication, tool-result artifact lifecycle, uploads/UI authorization ingress,
PTC attachments and automatic pin reclamation remain later integrations. This
slice handles user image attachments on fresh turns, not legacy attachment
adoption or every product attachment type. Neither the M2 descriptor/product gap
nor any full M3 checkbox is closed by these harness adapters.
