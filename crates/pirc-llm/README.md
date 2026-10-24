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

The checkpoint also passes `cargo test -p pirc-llm -p pirc-providers
--all-features`: 50 library unit tests, 2 direct-boundary regressions, 47 adapter
unit tests, 5 cancellation/drop tests, all 260 recorded TS parity scenarios
(requests/headers/deltas/messages), and 3 offline TLS distrust regressions.
Synthetic OAuth tests cover PKCE, browser/pasted callbacks, device flow, refresh,
explicit discovery opt-out, cancellation and callback cleanup. No real provider
login, deployment or publication was performed.
