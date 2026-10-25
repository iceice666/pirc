# pirc-llm (unpublished extraction checkpoint)

Wire-compatible HTTP/SSE mechanics extracted from pirc at baseline
`eb45f71d8fdefb35a796704ebd9ba7accdf098ff`. Existing pi-ai 0.73.1, OpenAI SDK
6.26.0 and Anthropic SDK 0.91.1 compatibility comments/attribution remain in
the moved source; this is not a transport rewrite or a publication.

## Explicit host boundary

- `Transport::new(reqwest::Client, long_cache_retention)` takes an already
  configured client. The library does not construct a client, select trust or
  proxy policy, read runtime environment variables, install global TLS crypto,
  read host files, spawn processes or store credentials.
- `Transport::run(Route, &StreamRequest, cancellation_receiver, callback)` uses
  an explicit native/Pi route, a host-owned watch cancellation generation and
  synchronous ordered Send callbacks with partial assistant snapshots. Dropping
  the future cancels HTTP. Cancelled runs preserve partial content/usage.
- `StreamRequest` accepts pure DTOs from `pirc-llm-types`, messages/tools,
  credentials, an opaque cache/session identity, a host URL-variable lookup
  and an explicit Codex user-agent. It has no Node/session/socket routing envelope.
- pirc-providers retains backend storage/catalogs/config/environment policy,
  native/Pi routing, `[node, session, provider]` cache identity derivation,
  production client/TLS construction, host fingerprinting and safe error masking.
  Raw native provider errors must never be assumed presentation-safe.

The normal dependency graph has no TLS implementation; consumers enable their
own reqwest TLS features and inject the client. reqwest default client
construction can consult system/environment proxy and trust settings: that is
a caller-owned decision, not something Transport performs. Explicit test clients
use `no_proxy()` and a supplied ring ClientConfig, without global installation.

## Rust runtime API

New Rust consumers can execute without constructing a provider catalog:

- `ResolvedEndpoint` holds one selected route's URL, headers, canonical provider
  and compatibility extensions; it contains no model list or credential field.
- `ResolvedModel` holds one model's generation metadata.
- `RunRequest` borrows endpoint/model plus `Auth::Key`, `Context` (system prompt,
  messages, tools) and `RequestOptions`. Default context/options are empty/off;
  cache identity, URL lookups and Codex fingerprint remain explicit host inputs.
- `Transport::run_request(Route, &RunRequest, receiver, callback) -> RunOutcome`
  returns the partial/final message and `Termination::{Finished, Cancelled, Failed}`.
  `LlmError` exposes a category and actual HTTP status; Display/Debug omit raw
  diagnostics. `diagnostics()` is an explicit, potentially secret-bearing accessor.
  This metadata does not prescribe retries, fallback or presentation policy.

See the executable example on `RunRequest` in the API docs. The production
pirc-providers adapter uses the same resolved execution path.

### Compatibility and safety

`StreamRequest` and `Transport::run` remain available. `run_outcome` accepts the
legacy request but returns structured metadata. `RunOutcome::into_legacy_message`
explicitly restores the original native/Pi error text; native errors can contain
upstream bodies and require host redaction. Only the final typed error summary
is sanitized: model content, identifiers and callback snapshots are not a
redaction boundary. Cancellation is separate from failure and keeps the existing
per-route partial-content and usage rules. Callbacks remain synchronous and
ordered, with no spawned producer or channel buffering.

`ResolvedEndpoint::from_legacy` preserves native/Pi URL and header override
differences. Resolution does not perform HTTP, parse URLs, validate headers or
invoke variable lookup: these remain lazy after the cancellation fence. Native
routes retain separate actual-POST and OpenCode-detection URLs. Keep endpoint
resolution paired with its selected route; no route inference or fallback occurs.
Headers/compat/URLs are not secret-free even though authentication is separate.

Known compatibility flags are resolved into private Rust bools/enums at codec
boundaries; legacy truthiness and missing/null behavior remain supported, as do
opaque provider extensions and signatures. Stream state uses typed active/block
variants instead of unrelated optional scratch fields where possible. SSE cursor
scanning and owned argument-map conversion reduce copying while retaining each
dialect's EOF/CRLF quirks and per-delta argument/partial updates. Usage totals use
saturating arithmetic and retain route-specific cache accounting.

OAuth and the serializable pirc-llm-types DTOs are unchanged.

## Features

Default features are empty, with only the pure types/serde graph. Enable wire
APIs independently: `openai-chat`, `anthropic-messages` (native and Pi paths),
`openai-completions`, `openai-responses`, `openai-codex-responses`. Disabled
routes return a fixed error and never fall back to another wire. Private
`_transport` is an implementation feature; select the named wire APIs instead.

`oauth` is separate and off by default. It provides Anthropic/Codex PKCE login,
Copilot device flow, refresh mechanics, opaque credential DTOs and presentation
hooks. All HTTP clients/endpoints/hooks are explicit. Copilot post-login model
policy IDs are supplied by the host; an empty list performs no policy requests.
The pirc adapter supplies its existing catalog IDs and still owns persistence,
account choice, refresh deduplication, secret validation and error redaction.
Subscription-token inference does not require enabling login flows.

**Remaining OAuth API limitation:** the built-in callback transport is not yet
a pluggable factory. Explicitly polling a code-login future starts its configured
local listener; constructing endpoints/enabling a feature never does. Presentation
uses LoginHooks (no automatic browser opening). Dropping the future stops
HTTP/polling and its callback listener/connections. Hosts needing a custom
callback transport need a subsequent API checkpoint; no new public listener or
App sign-in behavior is implied by this extraction.

## Verification

Run `bash crates/pirc-llm/tests/feature-matrix.sh` from any directory. It copies
only the two library crates into a temporary isolated workspace, runs offline
check/test/clippy (`-D warnings`) for default, each wire API, OAuth-only and all
features, checks normal dependency trees, and removes disposable builds. This
avoids hiding missing dependencies via workspace feature unification.

The runtime checkpoint passes `cargo test --locked --offline -p pirc-llm
-p pirc-providers --all-features`: 85 library unit tests, 2 original direct-boundary
regressions, 13 runtime/outcome tests, a complete callback-snapshot test (including
cancellation at all 12 callbacks), an API doctest, 47 adapter unit tests, 5
cancellation/drop tests, all 260 recorded TS parity scenarios
(requests/headers/deltas/messages), and 3 offline TLS distrust regressions.
Runtime tests distinguish HTTP status from body text, provider errors, malformed
streams, network failures, caller timeouts and cancellation; Codex transient
retries cannot contaminate a later success or terminal failure. Decoder tests
exercise byte splits through UTF-8 and CRLF without erasing dialect quirks.
Synthetic OAuth tests remain unchanged and cover PKCE, browser/pasted callbacks,
device flow, refresh, explicit discovery opt-out, cancellation and callback cleanup.
No real provider login, deployment, benchmark claim or publication was performed.
