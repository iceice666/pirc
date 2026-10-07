# PTC Milestone 1 contracts

Status: specification and test-only reference types; production registration and dispatch are unchanged. See `apps/gateway/test/ptc-m1/contracts.ts`. This is not a second permission system.

## Registry and visibility

One host registry owns input/result JSON schemas, descriptions, examples, stable identifiers, category, version, errors, effects, concurrency, approval class, suspension kinds and UI label. The registry's `available` predicate intersects role/config allowlists, feature registration, workspace capabilities and channel/session scope. Discovery uses the same predicate. The broker rechecks it and authoritative owner/workspace authorization for **every** call. Metadata never grants permission.

Role entries remain capability names. `code`, `ptc`, `ptc_docs` are ignored with warnings. Unknown names warn and grant nothing; known-but-disabled names grant nothing. An empty intersection exposes no tools. Otherwise expose exactly `ptc` and `ptc_docs`. Forced team coordination capabilities retain existing restrictions. Chat's off-by-default features require explicit re-enabling; gateway flags retain absent-means-allowed semantics, and recall's flag gates only remote fallback. M1's pure role decision-table function is not installed in role loading yet.

Inputs validate before hooks, and rewritten arguments validate again before classification, approval, write lease and dispatch. A current approval binds the operation, target and exact executed arguments. Discovery, wrapper approval, a stale response and unavailable/cancelled UI grant no authority. Existing gateway checks remain authoritative.

## SDK v1

```ts
const result = await tools.call('read', { path: 'src/example.ts' });
if (!result.ok) throw new Error(result.error.code);
return result.data;
```

`tools.call` resolves to `Result<T>` (including failure envelopes). Convenience `tools.read(...)` returns the same typed `data` and throws an Error carrying `code`, `operationId` and `outcome`. It does not return human-formatted text. Implementations migrate details to explicit schemas (e.g. read: `{ text, path, offset, nextOffset }`, find: `{ paths, nextCursor }`, job start: `{ id, status }`); until adapted, a capability must explicitly describe its `{ text }` result rather than invent parsed structure. Existing schemas/implementation references are mapped in the inventory; per-capability result adapters are M3 work.

Failures use the stable codes in the executable specification. `StaleContract` includes a bounded docs pointer. Failed validation/availability/approval is `not_started`; cancellation after dispatch may have `unknown` outcome. No automatic retries, transactional claims or rollbacks. The host completion summary survives script failure and accounts for completed, failed, cancelled and unknown operations independently of the returned value.

`tools.par(items, fn, { concurrency })` accepts integer concurrency 1–8, preserves result order, stops dequeuing on first failure, aborts eligible in-flight siblings and joins them before throwing. Already completed effects remain completed. Durable jobs follow their separate lifecycle. One execution-wide write slot serializes all operations classified as writes, including those outside `par`; mixed/action-dependent effects classify by validated arguments or conservatively take the write slot. `Promise.all` cannot bypass the global quota. Reserve pending calls before starting them; denied calls count. 200 calls per execution, not the old 500.

All capability names must be literals. Computed members, aliases that could obscure dispatch, reflective access and computed `tools.call` names are rejected by M2's preflight; the host then checks dispatch against that manifest. M1 spike has only an explicit fake-capability map and **is not the manifest implementation**. No recursive wrappers.

## Attachments

`Result.attachments` contains descriptors; no base64 enters the guest. `attachments.add(handle)` queues an existing descriptor for the outer multimodal result, returning no bytes. Host maps cryptographically random 256-bit handles to owner + session + execution; a caller cannot mint a handle by constructing a descriptor. Validate identity, current permissions, expiry and cumulative size on every use. No filesystem paths, URLs or dereference method are exposed. Max 4 attachments, 8 MiB each, 16 MiB total; expire at execution cleanup or 15 minutes, whichever comes first. Outer response owns copied bytes until normal delivery; revocation/cancellation deletes untransferred handles. Cross-call retention requires a separate explicit artifact API, not implicit guest state.

Unsupported provider image input returns an explicit limitation. Oversize text returns bounded previews plus `truncated: true`; artifacts do not silently replace missing content. Only owner-authorized normal message paths deliver bytes. M3 verifies web/Android/provider delivery and cleanup.

## Bounded docs

`ptc_docs({})` gives category counts/index only. Category queries give at most 20 summaries. Exact-name queries accept 1–8 names. Output is at most 16,384 UTF-8 bytes, including envelope, versions and cursor. Incompatible argument combinations reject. Unknown/unavailable names fail without revealing forbidden schemas.

Registry version is a content hash of available versioned contracts. Cursors are opaque authenticated host tokens binding owner/session, visibility revision, registry version, category and offset; changes return `StaleContract`. No arbitrary offsets into serialized JSON. Pagination breaks only between complete items. An exact contract too large for one response returns a bounded explicit error, never a silently incomplete schema. `truncated` and `nextCursor` are mandatory. Docs have no effects, jobs or approvals; names already documented need not be fetched again.

## Budgets and lifecycle

64 KiB UTF-8 source; 51,200-byte outer model output (or configured `toolOutputBytes`); 200 internal calls; 8 pending operations, 1 write; 128 MiB QuickJS managed heap; 120 s default, 1 h maximum active execution. Realm memory is not total process RSS: the spike uses fixed 256 MiB WASM backing to avoid stale typed-array views during growth. This overhead is separately measured; the production allocation strategy remains to be reviewed.

Active time excludes waits on existing approval/question records; those retain current expiry, not an invented unlimited wait. State transitions distinguish running, waiting approval/user/child/job, cancelling and finished. M1 spike uses wall deadlines only and does not claim production suspension accounting. Cancellation never resumes on late callbacks. CPU interrupt and host deadline cover both guest loops and unresolved host promises. The in-process realm has no IPC; source/JSON/result bounds still apply.

Inner trace types are defined in the reference specification. Events retain direct-call owner visibility and node-local JSONL truncation rules with parent links, not new gateway/log/telemetry storage. Production event persistence and client support are M3 work.
