# Upgrades

## Unreleased local checkpoint: retiring an unreserved first-message retry

Gateway schema **1020** adds identity-only retry retirement tombstones. Node
**2009**, protocol **15**, client recovery contract **2**, Web IndexedDB/native
private envelope **3**, dependency versions and Nix hashes are unchanged. Older
Gateways refuse schema 1020; before deployment stop the old processes and back up
complete consistent Gateway/Node state. Rollback requires matching binaries and
full state, never editing SQLite versions or discarding retirement records.

A client may commit a retry nonce locally and crash before its POST reaches the
Gateway. A GET 404 alone still cannot prove that a delayed request will not arrive.
The new owner-scoped `POST .../retries/{retryId}/retire`, advertised by
`canRetireFirstMessageRetry`, atomically retires an unreserved nonce only with a
confirmed current rejected predecessor and the user’s held control. It neither
creates a command nor contacts Node or a model. Retired nonce GETs return explicit
`status: not_reserved, retired: true` with the nonce/predecessor identity; any late
Retry POST using that nonce is permanently refused. This does not consume an
attempt number or replace the original conversation/input/files.

If reservation won the race, retirement only returns/reconciles that existing
command; it cannot undo an execution, clear Stop or turn unknown admission into
known rejection. Repeating a completed retirement is read-only, including after
lease expiry, restart or authorized conversation deletion. The identity-only
tombstone survives content deletion just like the existing dispatch fences.
New retirement checks device authorization inside the transaction.

**Web/native Android adoption of this recovery action is still pending.** Older
clients remain query-only for an unresolved nonce. Production **`canSubmit: false`**
is unchanged; this backend addition is not activation. Seven-day expiry remains
limited to unaccepted Gateway staging. No deployment, APK or release is included.

## Unreleased local checkpoint: Web/native first-message Retry adoption

Gateway **1019**, Node **2009**, protocol 15 and client contract 2 are unchanged.
The existing Web/Android recovery controls now adopt the explicit Retry API; the
production rollout still has **`canSubmit: false`**, so this does not enable a new
send path for deployed users. No APK or release assets are built here.

Web IndexedDB (same database name) is now **3**; Android private metadata envelope
is **3**. Rows, logical revisions, account bindings and attachment bytes migrate
without replacement; native imports validated envelopes 1/2 under its existing
lock. Old Web/native writers refuse the newer format. An older binary must not
write newer state. Preserve a consistent full private-state/browser-profile backup
if an installation rollback is required; never edit version fields or discard
unresolved drafts as a downgrade shortcut. Future formats remain read/write refused.

Retry keeps the original conversation/input/files, journals its nonce/predecessor
before POST and requires current capability/grants/control. Pending retries only
query their own nonce/result after a lost reply or restart; an absent nonce is not
permission to resend. Only the explicit Gateway `initial_retry_unsupported` refusal
proves reservation did not occur and permits a later user Retry after Node repair.
Global Stop and deletion are independent of any attempt's admission outcome.
Seven-day expiry continues to cover only unaccepted Gateway staging.

Focused Web/native-JVM/Flutter and isolated browser-storage proofs pass. Full live
client-to-backend, Android OS/process-death/device, pre-POST crash repair and rollout/
rollback acceptance remain required before activation. Shared SDKs/caches and APKs
are preserved; only run-owned test output is removed. No deployment is performed.

## Unreleased local checkpoint: Gateway first-message retries

Gateway schema **1019** adds durable retry nonce/predecessor/command history and
monotonic attempt numbers. Node remains **2009**, protocol **15**, client contract
**2**, package/dependency versions and Nix hashes stay unchanged. Older Gateways
refuse 1019. Before a future upgrade, stop old processes and take consistent full
Gateway/Node state backups; rollback needs matching state/binaries, never an edited
SQLite version or an old Gateway DB paired with newer attempted work.

The new explicit Retry API uses the same accepted input, conversation and files.
It requires a confirmed rejected predecessor, unchanged grants/mapping/model and
held control, and checks Node retry support before reservation. Every new attempt
commits before relay. Duplicate requests and owner-scoped nonce GETs only read/
reconcile; unknown outcomes never trigger a new POST or a fresh identity.
`messageAdmission` exposes `commandId`, `retryId`, `attemptNumber` and
`retryEligible` for clients to order updates reliably.

A retry that never reached Node can still reconcile the original operation's
confirmed global Stop without claiming its earlier admission is known. Staging
files remain retained until known admission or authorized deletion; the seven-day
rule still applies only to unaccepted staging. Existing memory deletion consent,
checkpoint isolation and ordinary session APIs are unchanged.

**At this backend checkpoint Web/native Android had not adopted Retry; the newer
client checkpoint above adds it. Production `canSubmit: false` remains unchanged.** Backend synthetic tests and paired direct-HTTP process proof
are separate from actual native-client/device acceptance. No deployment, APK or
release asset is included.

## Unreleased local checkpoint: Node rejected-admission retries

Node schema **2009** adds immutable first-message attempt/predecessor identities
and backfills existing initial command/hash metadata. Gateway remains **1018**;
protocol **15**, package/dependency versions and Nix hashes are unchanged.
Stop the old Node and take a complete consistent state backup before a future
upgrade. Older Nodes refuse 2009; restore matching full state and binaries for
rollback, never change SQLite `user_version` to force it.

The new trusted Node API permits an explicit fresh command only after its exact
current predecessor is durably rejected, with identical input/model/files and
valid current mode/control. It reuses the same session and attachments. Attempts
in progress, accepted, unknown or stopped cannot be replaced. Duplicate retries
and historical lookups read receipts only; restart never replays unacknowledged
work. Stop/deletion still fence the whole original first-message operation.

**Gateway/Web/Android have not adopted this retry API yet.** Existing App behavior
and production `canSubmit: false` stay unchanged. The real Node/Agent test proves
a known pre-message startup failure, repair/restart and one persisted user message;
it is not blanket permission to reopen an uncertain/corrupt journal. Complete
client-to-Gateway/Node and device acceptance remain open. No deployment, APK or
release asset is included.

## Unreleased local checkpoint: unsent edit recovery

Web/Android preserve a stale editor's text/settings/selected file bytes as an
explicit separate local draft when a peer changes or freezes its source operation.
The **Unsent edits** entry must be opened and reviewed, then explicitly sent;
recovery and navigation perform no preparation, admission or dispatch. Repeated
recovery respects the copy's revision too; another writer's copy is never replaced.
Unchanged input adopts the newer facts without creating a duplicate draft.

Web's common navigation paths wait for persistence and keep the current input
when saving fails. The native `recover` draft action uses the existing bound
origin/account and private file lock; it verifies bytes and commits independently.
Missing/corrupt bytes refuse the copy rather than claiming success. This does not
add a grant or require a Web connection. Explicit copy discard is independent of
source conversation/memory deletion; private drafts keep their existing lifetime.

Gateway 1018 / Node 2008, protocol 15, recovery contract 2 and private storage
versions stay unchanged. The optional local `recoveredFrom` identity is not part
of server/model input. **Production `canSubmit: false` remains unchanged.** Real
client-to-Agent, Android process-death and cleanup-race acceptance remain open.
No migration deployment, APK or release asset is included.

## Unreleased local checkpoint: first-send client compatibility

Gateway schema **1018** adds a semantic downgrade fence; no tables change.
Node schema **2008**, protocol **15**, package versions and dependencies stay
unchanged. Back up the complete Gateway state before any future upgrade.
Older Gateways refuse 1018; rollback requires matching binaries and the full
matching backup, never an edited SQLite `user_version`.

The first-send API remains wire version 1, with a separate client recovery
contract: `x-pirc-first-send-contract: 2`. Capabilities return `clientContract`
and `requiredClientContract: 2`. Missing, old, future or duplicate header values
cannot activate new sends; Prepare/Accept/Materialize/Dispatch reject them with
`409 first_send_client_upgrade_required`. This header grants no authority.
Queries, Stop and deletion retain their account, control and consent checks;
ordinary legacy session APIs keep their existing compatibility.

Modern clients recheck support before executable Send work. A bound modern
operation cannot fall back to legacy creation after successful old capabilities,
missing endpoints or incompatible versions. Original input/files stay retained;
query-only uncertain/terminal outcomes do not require sending again. Explicitly
unsupported cold legacy connections keep the previous flow without exposing
private recovery. Web ignores stale failed capability probes after newer binding.

The same Web IndexedDB name upgrades from version 1 to **2**, retaining rows,
Blobs and Stop identity. Close old pirc tabs if they block the upgrade; version-1
code then refuses to open the newer store. Android private envelope **2** imports
version-1 records after scope/path validation under the existing lock; logical
revision and attachment bytes stay unchanged. Older native code refuses version 2;
unknown future formats are refused without rewriting them. Use a compatible
client for recovery. Do not clear App storage, IndexedDB or uncertain drafts to
force a downgrade; that destroys the private recovery copy.

**Production `canSubmit: false` remains in effect.** Local process, browser-storage,
Web and focused native/Flutter checks are distinct from complete client-to-Agent
and Android device/process-death acceptance, which remain open. No deployment,
APK, release asset or new authentication/connection scheme is included. The
seven-day cleanup rule still applies only to unaccepted Gateway staging, not
accepted attachments or private drafts.

## Unreleased local checkpoint: client pending Stop adoption

Web/native Android/Flutter now support the Gateway's pre-allocation Stop scope
and explicit blank continuation. Gateway 1017 / Node 2008, protocol 15, dependency
and package versions are unchanged. **`canSubmit: false` remains in effect.**

The local Stop identity prevents a late original send from continuing. Native
private metadata/IndexedDB retain the pending control identity and original
input/files. Checking results never acquires control or replays a mutation;
explicit retry uses its saved identity, and takeover stays explicit. `nodeMapped`
separates mapping from stopped/stopping status. Open after confirmed unmapped
Stop prepares blank storage under current grants before navigation, retaining
frozen input. Deleted operations cannot be reopened through stale Stop flags.

Known admission, Stop and mapping facts merge independently across late replies.
Stop does not undo completed effects or resolve unknown earlier admission. The
recovery labels make that distinction visible in English/Traditional Chinese.
This preserves the existing separate accepted-delete and memory warning flow.

Mixed/older-client activation and rollback remain required gates before enabling
new sends; the global version-1 flag must not activate clients that cannot honor
local Stop/recovery metadata. Local tests are separate from a real native
client-to-Gateway/Node/device acceptance pass. No emulator, APK, deployment,
release asset or new login/connection scheme is included.

## Unreleased local checkpoint: Gateway queued pre-allocation Stop

Gateway schema **1017** adds pending-input Stop control and durable Stop jobs;
Node schema **2008**, protocol 15, package versions and dependencies are unchanged.
Back up Gateway state before any future upgrade; older Gateway binaries refuse 1017. Rollback needs the full matching backup rather than an edited `user_version`.

The new operation control scope is `pending_first_send_stop`, valid for 30 seconds
and usable only before a Node mapping exists. It cannot authorize Node commands.
Mapping races require the existing Node control/Stop flow. Once authorized, the
job survives offline periods, Gateway restart and initiating-device revocation;
only a validated Node acknowledgement confirms Stop. New first-send acceptance
requires the Node's `canStopBeforeAllocation` capability; older Nodes are refused
before intent/session publication. Existing accepted operations may still show
pending/unsupported until their Node supports the fence.

Explicit materialization after confirmed Stop may prepare the same blank
conversation under current grants. It never replays the original input or
promotes the stopped input's files; text/staged bytes remain retained and Delete
keeps its existing separate authorization and memory cleanup. `nodeMapped` tells
clients whether mapping is known independently of the Stop phase.

Web/Android adoption and full U1 client/device acceptance are not complete.
**`canSubmit: false` remains in effect**. No deployment, release asset, UI redesign
or new device connection scheme is included.

## Unreleased local checkpoint: Node pre-allocation Stop foundation

Node schema **2008** adds a durable first-message Stop that may precede Node
session allocation. Gateway schema 1016, protocol 15, dependency locks and
package versions are unchanged. Back up Node state before a future upgrade;
older Node binaries refuse schema 2008. Rollback requires the matching full
backup rather than changing SQLite `user_version`.

This Node-only API grants no new client control. Gateway durable Stop queuing,
fresh control authorization and Web/Android integration are still required;
**`canSubmit: false` remains in effect**. Existing client behavior is unchanged.
Stop records no message text, creates no session/files and deletes no history,
attachment or memory. A late allocation can prepare blank storage while the
original first message stays fenced. Stop after initial command intake must
use the existing leased session Stop; the pre-admission endpoint cannot claim
that it terminated execution. Duplicate pre-admission Stops never abort later
user work. Delete keeps its separate authorization and cleanup semantics.

Local Node/loopback process checks cover this foundation; this is not complete
App or production acceptance. No deployment or published asset is changed.

## Unreleased local checkpoint: Flutter durable first-send wiring

Flutter includes controller and recovery UI wiring for the native first-send
engine. **Gateway still returns `canSubmit: false`** until the remaining
integration/permission/restart gates pass. This is not production activation or
a release. Database, node-link, dependency and version identifiers are unchanged.

With support negotiated, private drafts/files survive navigation and reopen
under the same origin/owner. Storage refusal blocks sending/leaving instead of
falling back to legacy creation. Check result queries only; Continue, Take
control and Stop require their own user actions. The original message remains
frozen until known admission or confirmed Stop. Sidebar recovery and original
input are collapsed by default; ordinary messages keep their existing renderer.

Discard and accepted conversation deletion stay distinct. Native cancel requires
explicit accepted-delete consent, including if acceptance raced a stale Discard
button; that deletion uses the ordinary Gateway owner/mode checks and existing
memory warning. There is no new deletion permission. Before admission, approval
mode uses the workspace default; this slice adds no per-message permission mode.

Unknown cold capability support blocks new creation until it can be checked.
Explicitly unsupported/gated legacy servers keep their documented behavior;
reserved durable operations never use that fallback. Authenticated pending
recovery is still queryable when new sends are disabled. A bound offline draft
remains editable; cold recovery waits for authenticated capabilities and does
not erase private bytes. Unaccepted Gateway staging alone expires after seven
days; private drafts and accepted files are not covered by that deadline.

Focused Flutter/native JVM checks pass locally; a real Android process-death and
client-to-Gateway/Node/Agent pass remain required. No emulator, device or Nix
verification was performed, and no APK or release asset was replaced.

## Unreleased local checkpoint: native first-send engine

Android includes a native durable submission engine behind new methods on its
existing Gateway bridge. Flutter has **not** adopted those methods yet; Gateway
still returns **`canSubmit: false`**. Existing App behavior is unchanged. There
is no database, node-link, dependency, version or Nix-hash change in this slice.

The engine stores private drafts and attachment bytes in `noBackupFilesDir`,
scoped by the Gateway origin and authenticated owner. It requires an authenticated
capability response before cold recovery and validates the current pairing stamp
for every operation. Local edits need no network round trip after that binding.
Changing pairings hides access without repurposing another owner's draft; signing
back into the same owner/origin can recover it. Clearing App storage or uninstalling
removes this local recovery copy, so do not use either to resolve uncertain sends.

The native path freezes/persists the original operation before preparation,
queries unknown outcomes without replay, and keeps explicit Stop, Take control,
draft discard and conversation deletion separate. Paired tokens connect directly
to Gateway with the expected-account fence; no Web page or management grant is
needed. Requests do not follow redirects or automatically replay mutation bodies.
The seven-day expiry still covers only unaccepted Gateway staging, not accepted
attachments or private native drafts.

Only focused native JVM/filesystem/local-HTTP and Web regression checks ran here.
Flutter adoption, Android process-death/device checks and the full multi-client
integration matrix remain required before activation. This local checkpoint is
not a deployment instruction or a completed Android-flow guarantee.

## Unreleased local checkpoint: negotiated Web first-send recovery

Web includes private durable drafts and pending-send recovery, but Gateway still
returns **`canSubmit: false`** until Android adoption and the complete recovery
matrix pass. This checkpoint does not enable the new production client flow.
Gateway schema 1016, Node schema 2007 and protocol 15 are unchanged, as are
lockfiles and Nix cargo hashes. Unsupported/gated servers retain the existing
client flow; an operation already reserved for durable sending never silently
falls back after a local storage failure.

Authenticated capabilities add `ownerUser`, `canFenceAccount` and
`canFindPendingSession`. New durable requests send optional `x-pirc-account`
containing encodeURIComponent(owner); mismatch with the current authenticated
identity returns `409 account_changed` before mutation. Preparation also accepts
optional `expectedOwner` with the same check. Legacy clients need neither field.
An older strict server rejects the new preparation body rather than retargeting
an old-account draft. Read-only pending lookup by public session ID is owner
scoped and does not allocate, take control or replay input.

The new Web path requires working IndexedDB and successful local transaction
commits before sending. Cold recovery requires authenticated capability discovery
for that same Gateway origin/account. Do not clear site storage to resolve an
unknown outcome: it may hold the only unaccepted draft/attachment bytes. Check
result only queries; Continue and taking control require explicit user actions.
The seven-day policy applies to unaccepted Gateway staging, not accepted files
or private browser drafts. Browser/profile deletion remains outside that policy.

This is local implementation/verification work, not a deployment instruction or
a completed end-to-end Web/Android guarantee. No Nix or Android-device validation
was performed for this slice.

## Unreleased local checkpoint: cancellation before Node mapping

Gateway schema **1016** and Node schema **2007** add durable remote cleanup jobs
and Node creation-cancellation tombstones. Back up both state directories before
upgrading; old executables refuse these schemas. Do not downgrade by changing
`user_version`. Protocol 15 is unchanged, but new intent acceptance requires
Node's `canCancelCreation: true` capability as well as the earlier admission/file
capabilities. Upgrade compatible Nodes first. Dependencies/lockfile/Nix cargo
hashes are unchanged.

For accepted-first-send conversations, authorized Delete can commit while the
Node is offline or its allocation response/mapping is missing. **202** means the
conversation is deletion-fenced and cleanup is pending; **204** means remote
cleanup has been confirmed. Gateway retries that identity-scoped job after
restart/reconnect without a Web page or a fresh device/management grant. Outcome
reads report `cleanupPending` and optional `cleanupError`; they do not replay a
message or initiate allocation/cleanup. Existing owner/mode permission checks for
fresh Delete still apply. Stop and unaccepted-draft discard keep separate meanings.

Node cancellation can precede creation and permanently blocks delayed allocation,
transfer and initial admission. Ready-session cleanup uses the existing shutdown,
checkpoint retention and session/upload deletion flow. Unexpected reserved files
or an unavailable mode/storage/checkpoint stay pending; do not erase an unexpected
path to force success. User workspace roots are retained. Gateway verifies the
original operation/workspace/hash and any known Node session mapping before
finishing source-aware memory deletion and retiring the job. Migrations also
queue previously cancelled accepted operations with their original identities.

This checkpoint stays local. **`canSubmit: false` remains** until Web/Android
persistent draft/reconnect/deleting-state handling and multi-client gates pass.
It is not a completed client-flow guarantee or a deployment instruction.

## Unreleased local checkpoint: first-message admission and Stop

Gateway schema **1015** and Node schema **2006** add durable first-command
bindings, outcome reconciliation and a Stop fence. Back up both state directories
before upgrading; older executables refuse these schemas. Do not downgrade by
changing `user_version`. Protocol 15 is unchanged, but the new first-send flow
requires Node's `canAdmitFirstMessage` and `canReadFirstMessageReceipt` capabilities
as well as the earlier attachment capabilities. Upgrade compatible Nodes first.
No dependencies, lockfile or Nix cargo hash changed in this checkpoint.

The internal dispatch route commits one command identity before sending fixed
model/thinking/text/files. Duplicate requests reconcile its receipt; outcome
queries do not start runners, acquire/renew control or replay a prompt. Lost
acknowledgements/restarts before confirmation remain uncertain. Stop records a
fence against delayed original sends, including before runner startup; it does
not undo completed effects. Only known admission or confirmed Stop releases the
pending-input gate for an explicitly new command. Ordinary command receipts also
have an owner-scoped read endpoint; deletion hides their contents.

After known admission, Gateway cleans staging sources while Node retains
session-bound attachments. The seven-day deadline still applies only to
**unaccepted** staging. Accepted pending input is not silently expired. Existing
session IDs, allocation/upload identities, memory provenance and checkpoint
recovery isolation are preserved. New initial `received` commands become unknown
at Node startup; legacy `received` behavior is unchanged.

This is a local implementation checkpoint. **`canSubmit: false` remains** until
uncertain-allocation cancellation and Web/Android recovery are wired and verified.
It is not a deployment instruction or completed end-to-end client guarantee.

## Unreleased local checkpoint: accepted first-message intents

Gateway schema **1014** adds durable acceptance and Node materialization records.
Back up Gateway state before upgrading; old executables refuse this schema. Node
schema 2005 and protocol 15 are unchanged. Gateway requires Node's
`attachmentMimeInQuery: true` capability and refuses older Nodes before
acceptance. Upgrade compatible Nodes before enabling the future client flow.
Raw octet transport and immutable MIME metadata keep JSON files out of the
Node's legacy JSON body parser. Existing session IDs, Node mappings,
control, memory provenance and checkpoint recovery data are preserved. Do not
change `user_version` to downgrade.

The internal accept route commits a validated first-message intent and one public
pending session together. Materialization reconciles the same Node allocation
and attachment-transfer IDs. Neither route admits an Agent message, acquires
control or executes a model/tool. Clients remain on the old flow behind
**`canSubmit: false`** until the remaining admission/client gates are implemented.

Accepted staging no longer has the seven-day unaccepted deadline. Its bytes and
pending input remain recoverable until delivery cleanup or authorized deletion.
Conversation/project deletion scrubs content/settings and queues file cleanup;
non-destructive Work removal preserves accepted pending history behind the
removal fence. Explicit restore can resume the original operation. Unaccepted
staging/draft cleanup keeps its previous policy. This checkpoint stays local and
is not a deployment instruction or a completed first-send guarantee.

## Unreleased local checkpoint: Node attachment transfer

Node schema **2005** adds owner/creation-scoped attachment transfer records. Back
up Node state before upgrading; old executables refuse the migrated database.
Existing sessions, legacy uploads, allocation identities, memory provenance and
checkpoint recovery data are preserved. Gateway schema 1013 and protocol 15 stay
unchanged. Do not downgrade by changing `user_version`.

The new Node-only capability and `PUT`/`GET` attachment routes under
`/api/session-creations/` reserve one upload ID before file work and reconcile
lost responses, partial writes and restarts. New uploads are session-bound;
legacy upload scope is unchanged. Session deletion cleans reserved/ready files
and scrubs metadata while retaining a non-reusable identity. Missing/corrupt
acknowledged files produce an error instead of silently replaying the upload.

Gateway/client adoption is still gated with **`canSubmit: false`**. This is local
foundation work, not a deployment instruction or a completed first-send flow.
Future integration must detect unsupported Nodes and fail closed. The seven-day
unaccepted Gateway staging policy does not expire accepted Node attachments.

## Unreleased local checkpoint: attachment staging

Gateway schema **1013** adds owner-scoped attachment receipts, expiry and durable
cleanup jobs to the 1012 preparation ledger. Back up Gateway state before
upgrading; old Gateways refuse the migrated database. Node schema 2004 and
protocol 15 are unchanged. No existing accepted attachment is migrated or expired.

New unaccepted files are stored under `PIRC_STATE_DIR/submission-staging/`, with
private directories/files. They expire seven days after the latest manifest-valid
upload attempt, as selected by the user. The deadline is stored before file work
so a crash without a receipt cannot leave an untracked file indefinitely. Status
reads do not extend the deadline. Expiry retains pending text/manifest/operation
identity for recovery; uploading the same content can restage the same operation.

Cancellation/deletion queues file cleanup transactionally. Startup and periodic
workers remove only known staging files; status remains `cleanupPending` until
cleanup is complete. Unknown files or links block that operation's cleanup,
without deleting their contents. Do not place user files in the staging directory.
The new backend supports staging but still reports **`canSubmit: false`**: Node
promotion/admission and client adoption remain incomplete. Existing clients keep
their current upload path. This local checkpoint does not authorize deployment.

## Unreleased local checkpoint: Gateway first-send preparation

Gateway schema **1012** adds durable owner-scoped first-send preparation and
cancellation fences. Back up Gateway state before upgrading. Older Gateways
refuse the migrated database; do not downgrade by changing `user_version`.
Existing sessions, Node mappings, history, leases, memory and checkpoint recovery
ownership are preserved. Node schema **2004** and protocol **15** are unchanged
by this Gateway checkpoint.

This local intermediate stage reserves identities and stores pending input, but
creates no ordinary session or command and starts no Agent. The new capability
route reports `canPrepare: true, canSubmit: false`; existing Web/Android continue
their current flow. Preparation is not acceptance, Node admission or execution.
Attachment contents, acceptance, delivery and client recovery still need their
remaining U1 gates before activation. Cancellation and workspace/session deletion
remove the payload while retaining its non-reusable operation identity; existing
[backup and WAL limits](backup-and-recovery.md) still apply.

## Unreleased: Node session creation ledger

Node schema **2004** adds durable, owner-scoped creation identities. Back up Node
state before upgrading; older executables refuse the migrated schema. Existing
sessions and workspace identities, memory, uploads, checkpoint data and pots
records are unchanged. Do not downgrade by changing `user_version`.

This is a local first-send foundation, not a deployment instruction or a complete
client workflow. The new Node-only `POST /api/session-creations` and
`GET /api/session-creations/:id` routes allocate/reconcile a session but do not
send a message or start an agent. Gateway and clients do not use them yet. The
allocation ledger stores only identifiers, a submission hash and creation state;
it survives deletion so old retries cannot recreate a deleted conversation.
`deleting` is distinct from `deleted`; neither allows reallocation.

The Node link envelope remains protocol **15**, with additive HTTP routes. The
existing pots requirement to upgrade compatible Gateway/Nodes together still
applies. Future first-send integration must detect an unsupported route and fail
closed; it must not silently use legacy non-idempotent creation. Existing session
commands and specialized schedule/delegation/checkpoint/pots flows are unchanged.
See the [implementation checkpoint](../../plans/unified-conversations.md#u1-implementation-checkpoint-node-allocation-2026-10-26).

## Unreleased: explicit pots execution

Back up both Gateway and Node state before upgrading. Gateway schema **1011**
fences the extended task lifecycle (the existing pots SQL tables are unchanged);
Node schema **2003** adds durable dispatch identities, immutable instructions and
send/control fences. Older executables refuse the migrated schemas. Node protocol
**15** requires updating Gateway and every Node together; do not mix protocol 14
and 15. Update Web/Android clients to expose explicit instruction-based Start.

This is a local implementation checkpoint, not a deployment instruction. Start
requires an enabled responsibility, resumed coordination, remaining dispatch and
concurrency budgets, current source evidence and a written user instruction. It
uses a new dedicated conversation in the same workspace, never answers the source
interaction, and does not enable autonomous dispatch. Unknown sends are not
automatically retried. See [pots](../guides/pots.md).

## 0.10.0: pots tracking and gateway schema 1010

This release adds an opt-in, progress-only **pirc pots** inbox. Back
up Gateway state before upgrading: schema **1010** adds durable responsibilities,
sourced suggestions and tracking tasks. Older Gateways refuse the newer schema;
installing an older executable does not reverse the migration. Existing sessions,
workspaces, removal markers, memory and schedules are retained. No existing user
is enrolled in observation and no execution grant is created by the migration.

Update the Gateway and client assets together when deploying this checkpoint.
Node schema and node protocol are unchanged. The extracted LLM libraries keep
the existing authenticated Node → Gateway inference route; project agents do not
receive provider credentials. Production agents now drive their existing run
through the generic loop, retaining host-owned policy, storage and notifications. See [pots](../guides/pots.md) for tracking-only controls and the explicit
execution-unavailable boundary. This change does not authorize a deployment.

## TLS trust update: October 2026

The Rust gateway's outbound HTTPS and the node's `wss://` connection use
Rustls with `rustls-platform-verifier`. On macOS, it delegates certificate
trust evaluation to Security.framework and Apple's current trust policy. On
Linux, it discovers the host CA bundle and WebPKI validates certificate paths
against those roots. Keep the operating system's trust data current as well as
the pirc dependencies.

The October 2026 eMudhra incident led to [RUSTSEC-2026-0382](https://rustsec.org/advisories/RUSTSEC-2026-0382.html),
which covers acceptance of paths through distrusted emSign intermediates, and
[RUSTSEC-2026-0383](https://rustsec.org/advisories/RUSTSEC-2026-0383.html),
which covers the bundled roots that allowed such paths. This update locks the
patched releases `rustls-webpki` 0.103.16 and `webpki-root-certs` 1.0.10. See
the [incident report](https://emudhra.we-have-a-problem.com/) for the CA event.
Build from the updated lockfile (`nix build .#pirc-gateway .#pirc-node` from
the pirc checkout, or use your deployment's equivalent builder), then replace
and restart the gateway and every chat and coding node, including remote nodes;
a reload does not replace the running TLS verifier.

On NixOS, the pirc repository's pinned flake inputs control its build and
development environment, while the running host's Linux CA bundle comes from
the host's NixOS generation. Updating the project flake alone does not refresh
that host bundle; update and verify the host's CA package and trust policy
separately. External tools such as `gh`, `git`, `curl` and Python have their
own TLS implementations and CA bundles; update them separately. Variables such
as `SSL_CERT_FILE` only affect clients that honor them; see the [sandbox `gh`
setup](sandbox-and-browser.md#https-with-a-token). The Android app uses its
separate OkHttp and Android trust path; this Rust dependency update does not
change it.

The offline regression test is
`cargo test --locked -p pirc-providers --test tls_distrust`. It explicitly trusts
the legacy fixture roots and requires the twelve public incident chains,
including AAA cross-signs, to fail with `CertDistrusted` at a fixed time within
their validity periods. A valid local test CA must still pass. On Linux this
also exercises the platform verifier; on macOS and Windows it exercises WebPKI
rather than the native OS trust service. This test does not validate the
deployed host's CA updates or any external command-line tool's trust store.

## Work workspace removal: gateway schema 1009

This update adds non-destructive **Remove workspace…** under a Work workspace’s Settings in the web app. Back up gateway state before upgrading: schema **1009** adds durable removal markers, and older gateways refuse the new schema. Deploy the updated gateway, web assets and coding nodes together. The node protocol and node schema are unchanged, but removal requires the new node idle-check endpoint; an older node fails closed without removing the workspace.

Removal retains files and history, pauses schedules and survives node reconnects. Restoring an eligible directory through **Add workspace** requires the updated node’s same-path restoration support. Per-session workspaces and configured paths outside the device home currently have no UI restore; read the confirmation and [workspace removal guide](../guides/session-ui.md#removing-a-work-workspace-web) before removing them.

## 0.9.3: memory, calendar and checkpoints

Upgrade the Gateway and every chat/coding Node together: **node protocol 14**
adds private checkpoint workspace registration. Mixed protocol versions are
refused. Back up both Gateway and Node state directories before upgrading;
these migrations are not reversible by installing an older binary.

The Gateway migrates to **schema 1008**: 1006 records memory digests, 1007 adds
calendar events, grants, proposals and reminders, and 1008 adds private recovery
workspace ownership. Earlier local preview databases that used 1006 for calendar
or 1007 for checkpoints are recognized and brought to the same schema without
removing schedules, events or recovery ownership. Nodes migrate to **schema 2002**
for checkpoint workspace/session adoption. Older binaries refuse the new schemas.

Repository memory now has a versioned journal separate from session handoffs.
Legacy records remain readable; existing ledgers stay read-only until explicit
cold activation with all older writers stopped. Deploying these binaries does
not activate memory automatically. Review [memory activation](../architecture/observational-memory.md)
and the panel's activation status before synchronizing. Isolated recovery
sessions do not inherit the source workspace's memory or enable its writers.

The calendar adds user-owned events, recurrence exceptions, independent Agent
grants, confirmation proposals and reminder delivery attempts. Existing schedules
and runs remain intact; legacy run origins remain unknown. See
[Calendar](../guides/calendar.md) for behavior and limits. Checkpoint recovery
creates a separate workspace and requires review before continuing; it does not
restore files into the original directory or undo external side effects.

The TLS rebuild/restart and host trust-store instructions above also apply to
0.9.3.

## 0.9.0 / 0.9.1: mode tabs by capability, delegation approval, node protocol 13, gateway schema 1005

Upgrade the gateway and every node together: the node protocol moves to 13
because the mode catalog the gateway sends no longer has `ui.group`. Protocol 12
nodes are refused by the new gateway and protocol 13 nodes by an older one.

On first start the gateway migrates its database from schema 1000–1004 to 1005:
`delegations` gains `dispatch`, `origins_json`, `quote` and `quote_entry_ids`,
and delegations that already started are marked `dispatch='approved'`. A 0.8.x
gateway refuses a database at schema 1005: back up its state directory if you may
need to roll back. Node schemas are unchanged; nodes gain the gateway-only
`relayed-answer` route that relayed delegation approvals need. Every chat
workspace keeps `delegation_approval: always` (the approval card) until you
change it.

**Breaking: remove `group:` from every mode file before upgrading.** Clients now
place a mode's workspaces by its `assistant` capability (`full`: Chat, `user`:
Work), so `ui.group` was removed. Mode files reject unknown fields: a file that
still contains `group:` is skipped with a warning naming it, and its workspaces
become unavailable (history readable, no new work) until you delete the line
and reload the gateway (SIGHUP). This includes the default `chat.md` and
`directory.md` the gateway created earlier and read-only directories provided
by Nix. Compare with `pirc-gateway modes --print-defaults`.

`GET /api/nodes` lists each node's accepted mode ids (`modes`). Web and Android
clients ask capabilities instead of the legacy `kind`, which stays in workspace
JSON for one more release.

## 0.8.0: gateway-owned workspace modes, node protocol 12

Upgrade the gateway and every node together. Protocol 11 nodes are refused by
the new gateway and protocol 12 nodes by an older gateway; the close reason
explicitly asks for a coordinated upgrade. Database schemas remain gateway
1004 / node 2001: the existing `workspaces.kind` text column now stores mode
ids without a data migration.

On first start the gateway creates `$PIRC_CONFIG_DIR/modes/chat.md` and
`directory.md` **only if the modes directory does not exist**. Existing
installs keep the same default behavior. If you provision a read-only config
directory (for example with Nix), provide the modes directory and both default
files yourself, or make its parent writable for initial creation. An existing
empty directory deliberately disables all modes; invalid files are skipped,
not replaced with defaults. Use `pirc-gateway modes --print-defaults` to inspect
the shipped files before upgrading.

Nodes default to accepting `chat` on `pirc-node chat`, `directory` otherwise.
Custom modes require `PIRC_MODES` on each intended node and a gateway mode file.
Nodes receive definitions only from the gateway; agents receive validated
`PIRC_MODE` JSON. Retired `PIRC_WORKSPACE_KIND` is refused by agents. SIGHUP
reloads modes as well as models; changed/removed modes stop affected agents,
close their terminals and cancel inference. Missing modes keep existing
session history readable but refuse new work. Changing workdir strategy does
not migrate data; incompatible existing layouts are refused.

Back up configuration as well as state before upgrading. Older executables
cannot understand custom mode ids safely: restore reviewed default mode ids
and matching configuration/state before downgrading. Do not run old binaries
against a store containing custom ids; old parsers silently treated unknown
ids as directory workspaces. No deployment or data rewrite is automatic.

See [Workspace modes](../guides/modes.md) for format, permissions and examples.

## 0.6.0: gateway schema 1004, node schema 2001, node protocol 11

Upgrade the gateway and every node together: the node protocol moves to 11, and
the gateway closes a node on protocol 10 (the node exits asking for the
upgrade). On first start the gateway migrates its database from schema
1000–1003 to 1004 (the `workspace_deletions` table, a `workspace_id` in
`session_deletions`, and a `scope_id` in `memory_tombstones`; existing
tombstones become `global`, so forgotten text stays refused), and each node its
store from 2000 to 2001 (an upload's
`workspace_id`/`session_id`, and `workspace_deletions`). Uploads made before the
upgrade record no workspace: they can still be attached anywhere and are not
deleted with a chat project. From 0.6.0 both migrate under one write lock
in a single transaction, so a failed step leaves the database at its old
schema.

A 0.5.x gateway refuses a database at schema 1004, and a 0.5.x node one at 2001. Back up both state directories before upgrading if you may need to roll
back.

## 0.5.0: gateway schema 1003 (node protocol 10)

An in-place upgrade. On its first start the gateway migrates its database from
schema 1000, 1001 or 1002 to 1003 by itself, one transaction per step: 1001 adds the
`repo` columns of workspaces and mirrored workspace memory, 1002 the
`project_links` table (chat projects linked to workspaces), 1003 the
`operation` of schedule proposals (agents' deletions wait for you), the
`as_user_request` of delegations and an index on `delegations(follows)`. Node state is
unchanged and the node protocol stays 10, so nodes and gateway still
interoperate across the upgrade, but deploy them together as usual: an older
node reports no repositories, an older gateway gives coding sessions no USER
entries, and an older node's agent refuses `delegate` without a workspace before
asking the gateway. Upgrade every node with the gateway: an older node does not
offer the approval-mode switch (the web hides it) and refuses the command.

Node configs using `features.autoMode.enabled` keep working with a warning;
replace it with `features.autoMode.mode` (`enabled: false` now means
`"full-access"`, `true` means `"auto"`). A repository's `.pirc/config.json`
that sets `defaultModel` is ignored until you trust it again in the workspace's
Settings.

On Linux nodes, sessions no longer reach Unix sockets on the host other than
the node's inference socket and the Nix daemon's: add any a session needs (an
`ssh-agent`, a database, a container engine) to
`sandbox.network.allowUnixSockets`. Leftover `<key>.lock` files beside
workspace-memory ledgers can be deleted.

A 0.4.x gateway refuses a database at schema 1001, 1002 or 1003 ("newer than this
gateway"). Back up the gateway's state directory before upgrading if you may
need to roll back; restoring that backup loses what changed since.

## 0.4.0: fresh-start Rust cutover (node protocol 10)

This is a **breaking release**, not an in-place database migration. The server
executables are now native Rust: `pirc-gateway` and `pirc-node`. The chat service
runs **`pirc-node chat`**; there is no `pirc-chat` binary or package. Web and Android
API behaviour remains compatible; shared timeline fixtures are unchanged.

The Rust gateway/node refuse TS-era SQLite schemas. Do **not** copy the old
`gateway.sqlite`, node databases, `sessions/*/session.jsonl`, `backends/settings.json`
or `vapid.json` into the new state directory, even though some filenames and
formats resemble the old ones. Do not point `PIRC_DATABASE_PATH` at an old DB.

### Maintenance-window checklist

1. Build and validate the new release (`bun run check`; Nix: `nix build .#pirc-gateway .#pirc-node`).
2. Stop the gateway and **all** chat/coding nodes. Take a consistent, protected
   backup of each old state directory and keep the old release alongside it.
3. Select new, empty `PIRC_STATE_DIR` directories for the gateway and each node.
   For the NixOS module, set a new `services.pirc.stateDirectory`, for example
   `/var/lib/pirc-rust`. The module does not delete or migrate old state.
4. Preserve only reviewed configuration: identity/Host/Origin allowlists,
   proxy settings, file-managed `models.json`, workspace paths and agent prompts/
   skills. Recreate node credentials or deliberately provision matching tokens
   on both ends. Keep gateway and node accounts separate and secrets out of Nix.
5. Change chat launch commands to `pirc-node chat`; coding remains `pirc-node`.
   Remove `PIRC_CHAT`, `PIRC_PLAYWRIGHT_CORE`, and production `PIRC_SANDBOX_SRT`
   overrides. Install `bwrap` on Linux (`pirc-node`'s Nix wrapper supplies it),
   `git`, and Chromium/Chrome plus optional ffmpeg. No Bun/Node/srt is needed.
6. Nix users: remove `pirc-chat` package references and `services.pirc.chatPackage`;
   use `nodePackage` for both roles. `services.pirc.chat = true` now adds the
   `chat` argument. The unit names remain `pirc` and `pirc-node`.
7. Start the new gateway and all nodes in the same window. Protocol **9 and 10
   cannot mix**: the gateway closes mismatches with **4426**. Deploy the web bundle
   and check every expected node is online in `GET /api/nodes`.
8. Re-pair devices, re-login subscription backends, recreate UI-managed providers,
   enable push again (fresh VAPID keys), and start **new sessions**. Recreate
   schedules, projects, memories and other state deliberately; there is no import.
9. Test a trivial prompt and sandbox/browser operation on each role. Deployment
   and real-provider smoke tests are operator actions, not performed by cutover.

The remaining paid PTC/task-time and provider-login gate was **waived by the user**,
not passed. See [the cutover decision and validation scope](../development/historical-records.md#rust-cutover-and-validation-scope).

### Rollback across the cutover

Stop every new process first. Restore the **entire old release and matching old
state backups together**, including old chat binaries, provider settings and web
assets. Never run the TS binaries against Rust state or restore an old DB into
an active Rust service. Keep the fresh Rust state separately if it is needed for
inspection; there is no downgrade/import of sessions created after cutover.

## Later upgrades within the Rust release line

Keep gateway and nodes on the same release. Changes to
`crates/pirc-protocol/src/lib.rs`'s `NODE_PROTOCOL_VERSION` require a coordinated
restart. Node/agent changes require upgrading each node; gateway/provider changes
require the gateway; web changes require only the static bundle. Read each
release's migration notes before assuming a forward schema migration is supported.

- `models.json`: SIGHUP / `systemctl reload pirc`; invalid content keeps the last
  valid settings. Modes reload independently: invalid mode files are omitted,
  a directory-level failure keeps the previous catalog. Environment changes
  require a process restart.
- Agent config/prompts/skills: next agent start.
- Web-managed providers: apply immediately; affected in-flight inference cancels.
- While a node restarts, agents get `PIRC_SHUTDOWN_GRACE_MS`, then are killed;
  interrupted runs need a new prompt.
- Back up state before upgrading. Restore matching state with older binaries;
  SQLite has no automatic down-migration.

Dependency updates: refresh `cargoHash` in `nix/package.nix` after `Cargo.lock`
changes and `nodeModulesHash` in `nix/web.nix` after `bun.lock` changes. Build both
packages to verify fixed-output hashes; never commit a placeholder hash.
