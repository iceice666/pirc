# Model Backends and Subscription Logins — Architecture Reference

This documents how pirc's gateway manages model backends and subscription logins: single-user, trusted-network threat model; gateway-centralized inference; the three subscription logins built into the pinned `@mariozechner/pi-ai@0.73.1`. Implementation: `apps/gateway/src/backends/` (settings, OAuth bridge, pi-ai adapter, inference), `inference-wire.ts`, `node/inference.ts`, `agent/providers/remote.ts`, `apps/web/src/lib/components/BackendSettings.svelte`.

Deliberate deviations from the upstream/library defaults:

- Codex requests never send `max_output_tokens`: pi-ai 0.73.1 itself doesn't, the Codex subscription backend isn't the public Responses API, and sending it risks per-request rejection; `maxTokens` is not a hard cap for Codex.
- Errors from the pi-ai path keep only a classification (HTTP status, context overflow, usage limit) and never forward upstream response bodies; Codex errors surface as `status NNN`, to avoid the agent's own retries stacking on top of pi-ai's built-in three retries.
- A custom endpoint with no configured key uses a fixed placeholder bearer, so pi-ai never falls back to reading a key from the gateway's own environment variables; a subscription account missing credentials fails immediately instead of silently reusing another backend's key.
- Changing settings (login, logout, edit, reload) cancels in-flight inference; a token refresh does not.

## 1. Requirements and threat model

The goal is to let the **pirc web UI configure model backends and hold real conversations using every subscription login built into the pinned pi-ai version** — not just Codex, and not by requiring a CLI login on a node first.

pirc reuses `@mariozechner/pi-ai`'s OAuth registry, login/refresh functions, and model transport layer; it keeps its own agent loop, tools, sessions, compaction, memory, and team features. The web UI bridges the interactive login flow; the gateway holds account state.

### Threat model (confirmed)

- **Trust boundary:** the operator, the gateway, and paired nodes (with their OS accounts) are one trust/administration domain. One user may still have multiple nodes, devices, or concurrent browser tabs.
- **Account scope:** backends, API keys, subscription logins, and the default model are deployment-wide settings for this single-user deployment. The operator manages them directly; there is no multi-tenant credential partitioning, per-user RBAC, or admin/user role split. Supporting multiple real users would need a fresh threat-model review; `PIRC_ALLOWED_USERS` listing several names is not a multi-user security guarantee.
- **Centralized inference:** the gateway holds provider credentials, refreshes tokens, and makes every model request. Nodes keep the agent loop, tools, workspaces, and session runtime; they receive model metadata and streamed results, never provider tokens. This covers both OAuth and existing API-key/custom-endpoint backends, not just Codex.
- **Protection goals:** avoid unintended endpoint exposure, unauthorized browser/node access, cross-site requests, credentials leaking into logs/UI/session files, OAuth state confusion, concurrent refresh/cancel races, and runaway retries or resource use.
- **Not guaranteed:** protection against an already-compromised trusted node/gateway, a malicious process under the same OS account, or arbitrary shell access; agent tools and the OAuth login worker are not sandboxes, and centralizing storage on the gateway is not hard isolation on the same host. Separate OS users, per-user quotas, and encrypted-at-rest credential storage are not required at this stage.
- **Still untrusted:** model output, repository/web content, provider errors, browser input, and login-flow return values. A trusted network does not turn any of that into authorization, and does not remove the need for XSS/CSRF and OAuth state checks.
- **Unchanged:** existing trusted-proxy/forward-auth, Host/Origin, and node-token checks, and existing transport-security requirements. The VPN/LAN assumption is not approval to remove authentication or make the service public. Simplifying deployment auth is a separate decision.
- **Logout semantics:** removes pirc's local credentials, blocks new model requests/refreshes, and cancels or bounds in-flight requests/connections. It cannot guarantee revocation of content already sent upstream, and local logout is not the same as revoking the account itself.

This is not a legal/ToS review of any provider's third-party-client policy. Upstream support for a login flow is not a service guarantee, and not every subscription tier has the same model entitlements.

## 2. Upstream scope

Pinned: `@mariozechner/pi-ai@0.73.1` (tag `v0.73.1`, commit `781152fc24841dc54b22284514604048ebe5e2c9`).

Three built-in OAuth providers:

| ID               | Display name                                                 | Auth flow                                                     | Model API family used                                          |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------- |
| `anthropic`      | Anthropic (Claude Pro/Max)                                   | Authorization Code + PKCE; localhost callback or manual paste | `anthropic-messages`                                           |
| `github-copilot` | GitHub Copilot                                               | Device code; optional Enterprise domain                       | `anthropic-messages`, `openai-completions`, `openai-responses` |
| `openai-codex`   | ChatGPT Plus/Pro (Codex Subscription)                        | Authorization Code + PKCE; localhost callback or manual paste | `openai-codex-responses`                                       |
| —                | (removed upstream in 0.71.0) Google Gemini CLI / Antigravity | —                                                             | —                                                              |

The published model catalog per provider is a static list, not a live query of what the logged-in account can actually use; the UI distinguishes "pi-ai knows this model" from "the account has verified access to it".

## 3. Reused interfaces

`@mariozechner/pi-ai/oauth` provides `getOAuthProviders()`/`getOAuthProvider(id)` (registry for the login UI), `provider.login(callbacks)` (returns credentials the host persists), `provider.refreshToken(credentials)`, `provider.getApiKey(credentials)`, `provider.modifyModels?(models, credentials)` (e.g. Copilot rewrites endpoints based on token/Enterprise domain), and `getOAuthApiKey(providerId, credentialsMap)` (refreshes if expired, returns `{newCredentials, apiKey}`).

Credentials keep `refresh`, `access`, `expires`, plus provider-specific fields (Codex: `accountId`; Copilot: `enterpriseUrl`) — the full provider credential object is stored, not just two token strings.

`getOAuthApiKey()` does not persist or lock by itself; the gateway's settings store does that (atomic write, 0600).

The web login bridge implements the full callback vocabulary, not just the authorization URL:

| Callback                                     | Web equivalent                                                   |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `onAuth({url,instructions})`                 | external login link, instructions/device code                    |
| `onPrompt({message,placeholder,allowEmpty})` | a text field that waits for a reply                              |
| `onProgress(message)`                        | transient progress                                               |
| `onManualCodeInput()`                        | a paste field shown alongside the callback                       |
| `onSelect({message,options})`                | a choice UI; cancel returns undefined, never treated as consent  |
| `signal`                                     | cancellation, though not every provider implementation honors it |

None of the three built-in 0.73.1 providers call `onSelect`, but the bridge covers it anyway. OAuth code runs on the gateway/server only, never shipped to the browser.

## 4. Per-provider constraints

### Anthropic

Fixed redirect `http://localhost:53692/callback`; a callback server is started even when the user ends up pasting the code manually, and a port-bind failure fails the login.

- "localhost" in the redirect is the user's own machine, not the gateway.
- `onManualCodeInput` accepts the final redirect URL; the UI offers a paste field next to the authorization link immediately, not only after the callback would fire.
- The login wrapper does not honor `callbacks.signal`; cancellation can reject a pending manual-input promise, but token exchange still needs a host-side deadline/worker termination and must refuse to persist a late result.
- Logins on the same fixed port must be serialized/mutexed, including multiple tabs or repeated logins by the same user; the login worker subprocess does not itself isolate the TCP port.
- Model calls are not a plain `x-api-key`: OAuth Bearer, specific headers, a system prefix, and tool-name translation apply. This provider-specific behavior is exactly why pirc reuses pi-ai's transport rather than reimplementing it.

### OpenAI Codex

Fixed redirect `http://localhost:1455/auth/callback`; manual input is supported, and a port-bind failure falls back to the manual path. Also does not honor `callbacks.signal`.

- The realistic baseline for a remote web UI is "open the authorization page → finish login → paste back the final redirect URL", not a guaranteed automatic bounce back into pirc.
- The redirect URI must not be rewritten to a pirc-owned domain; the public interface has no generic hosted-callback configuration.
- The login result must capture the account ID; model calls use Codex's dedicated API and account header, not `/chat/completions`.
- The manually pasted URL is submitted via an authenticated POST body, never placed in a pirc query string, general event log, or localStorage. The bridge validates the expected host/path/state of the full URL rather than treating any string as a fetchable resource.

### GitHub Copilot

Device flow suits a remote web UI well: enter an optional Enterprise domain (blank = github.com), show the verification URL and code, and the gateway waits for the result.

- The credential's `refresh` field is actually a GitHub access token used to mint a short-lived Copilot token; this is provider-specific, not a generic OAuth refresh grant. The UI defers to the provider rather than guessing field semantics.
- `modifyModels()` updates model base URLs from the token's endpoint/Enterprise domain; this must be reapplied after every refresh, not only right after login.
- The Enterprise domain becomes an HTTP destination the gateway calls. In this single-operator deployment, that's an explicit operator-configured internal endpoint, not a multi-tenant admin allowlist — but the URL/domain/protocol must still be validated, and no model output or arbitrary request payload can be allowed to rewrite the configured destination once set.
- **Login itself POSTs a policy-enable request for every Copilot model pi-ai knows about on the account.** This is a side effect, not just a status read; the UI must disclose and get explicit consent before starting, since the 0.73.1 public login interface has no way to skip it. Some models may still need manual enabling elsewhere.
- A successful login does not mean every cataloged model is actually usable.

## 5. Credential refresh and model requests: centralized gateway inference (chosen)

Two architectures were considered:

- **A — agent calls the provider directly, gateway issues short-lived credentials.** Closer to the pre-existing architecture, but does not fit "no credential broadcast": a full live credential-update channel between agent, node, and gateway would be required for every code path (root turn, team, subagents, memory, title, compaction), and logout could not guarantee revoking a bearer token already handed to a node.
- **B — gateway executes the model stream itself; the node keeps the agent loop.** The node sends a normalized model request, the gateway resolves credentials and calls pi-ai, then streams normalized events back. This is a model-transport proxy, not moving agents/tools into the gateway. **This is what's implemented.**

Consequences of B, as built:

- Refresh and access tokens never reach a node; account authorization stays centralized.
- The node↔gateway link (`apps/gateway/src/protocol.ts`) carries model-request/chunk/end/error/cancel messages, multiplexed with size limits, timeouts, and disconnect cleanup.
- Prompts, images, and tool schemas pass through the gateway, which is now a dependency for every model call's availability.
- This is not "one more OpenAI-compatible proxy": Copilot's multi-API model list, and Codex/Anthropic OAuth-specific behavior, are preserved end to end.
- The same model-request channel serves ordinary chat, team/subagent calls, memory, title generation, and compaction; the gateway resolves fresh credentials on every call, so agents never need a credential-update RPC or a restart when a token expires.
- If the gateway is temporarily unreachable, new model requests fail; existing tool/session runtime on the node is unaffected, but work needing another model turn cannot complete. A disconnect must never cause a silent fallback to handing credentials to the node.
- Refresh/login/logout are serialized per credential ID with a revision check, so a stale refresh cannot resurrect a logged-out account. Provider-reported expiry values are inconsistent (some subtract a safety margin, Codex does not); the host applies one consistent refresh policy. A 401 does not unconditionally replay a request that has already started streaming output.

## 6. Web authorization protocol

- `GET /api/providers`: registry plus redacted config/login state/source/scope.
- `POST /api/provider-auth/sessions`: provider ID and required consent info; the owner comes from the trusted identity, never the request body.
- `GET /api/provider-auth/sessions/:id`: a bounded state snapshot — authorization link, pending prompt ID/kind, progress.
- `POST /api/provider-auth/sessions/:id/input`: a one-shot reply to the current prompt; checked against the current prompt and owner.
- `DELETE /api/provider-auth/sessions/:id`: cancels the login in progress ("cancel login" is not "remove a saved account" — that's a separate logout/remove API).

Each login session has a random ID, TTL, generation counter, and count limit; every query/input/cancel checks ownership. `onAuth` and a manual-paste prompt can coexist; the state model must not collapse them into a single screen and lose information.

Cancellation invalidates the session/generation first, then rejects pending callbacks/aborts/terminates the worker if needed; a login that completes checks the generation again before persisting. Unfinished sessions live only in memory; a gateway restart requires retrying.

The OAuth login worker provides lifecycle/failure isolation, **not a permission sandbox**. All login/settings responses use `Cache-Control: no-store`; external URLs are protocol-checked and opened with `noopener noreferrer`; instructions render as plain text. Upstream errors may contain response bodies or token fields and must never be written verbatim to pirc logs, UI, or ordinary session events — only a redacted error code/message is kept.

## 7. pi-ai transport adapter notes

The integration boundary is `apps/gateway/src/agent/providers/types.ts`'s `StreamFn`; the whole agent runtime is not replaced. Notable points:

1. Models keep their per-model API, canonical pi-ai provider, base URL, and capability/thinking mapping; the UI's backend alias is kept separate from pi-ai's provider identity, since pi-ai's replay logic compares provider/api/model identity.
2. Optional replay metadata (e.g. a Responses message ID/phase, `responseId`) is preserved; `signature` maps to pi-ai's `thinkingSignature`; opaque tool signatures are kept as-is rather than dropped after a restart.
3. pirc's `custom`/`compactionSummary` entries, images, and tool results are converted while keeping old sessions readable.
4. `toolcall_start` from pi-ai only carries an index/partial; the ID/tool name pirc needs is reconstructed from the partial. The agent still owns the outer message lifecycle to avoid duplicate events.
5. Non-overlapping usage token buckets are preserved (they feed compaction, not just UI stats); pi-ai's cost estimate is not treated as an actual subscription bill.
6. Provider-specific options such as tool-choice are checked per call, not assumed uniform; compaction sends tools with `toolChoice: none` and this must not be silently dropped.
7. The legacy `openai-chat` alias and pi-ai's `openai-completions` are mapped compatibly; existing custom endpoints, keyless backends, and header/compat options are not force-migrated in one step.
8. The pi-ai adapter runs on the gateway; the agent-side `StreamFn` is a remote-request adapter. It never reads a node's environment for keys, and the gateway's own environment keys are only used via explicit configuration, never silently swapped on logout.
9. Codex defaults to `auto` transport, which may reuse a cached WebSocket; pirc uses SSE explicitly to bound replay/connection lifetime risk. This does not reduce provider coverage.
10. pi-ai 0.73.1's Codex SSE path hardcodes three retries; passing `maxRetries: 0` does not disable that. pirc's own retry logic must not stack on top, and must not blindly replay a request that has already streamed output.

The existing OpenAI prompt-cache warming path keys off `api === 'openai-chat'`; it is not assumed to apply to every subscription backend — cache, reasoning, and tool-choice support are capability-checked per backend.

## 8. Acceptance bar

- The UI's login list matches the pinned version's `getOAuthProviders()`; a registry change in a future pi-ai bump surfaces as a compatibility-test failure, not a silent gap.
- All three providers can complete login and hold a real multi-turn conversation with tool calls from the web UI; no CLI or public callback port is required on a node.
- Error states, wrong-owner access, duplicate prompts, cancel/TTL/restart/port-conflict are all handled; a late login result never gets persisted.
- Concurrent refreshes collapse to one in-flight request; the rotated result persists; logout is never overwritten by a refresh that was already in flight.
- Root turns, team, subagents, memory, title generation, and compaction all keep working across a token expiry.
- After logout the model list can go empty and the UI does not keep a stale selection; a successful login is never presented as "every cataloged model now works".
- Tokens never reach the frontend response, ordinary events/logs/session files, or a node's model-config/inference protocol; Enterprise/custom endpoints are only ever set explicitly by the operator, and URL/cross-origin credential protections apply without a multi-user role system.
- Both API-key and OAuth-backed requests run on the gateway; nodes only receive secret-free metadata/results. Covered by tests for gateway disconnects, stream cancellation, multiplexing correctness, backpressure, and node-local-endpoint reachability errors — with no secret-broadcast fallback.
- Responses signature/phase/thinking survive persistence, restarts, and cross-model replay correctly.

Related tests: `models.integration.test.ts`, `nodes.integration.test.ts`, `remote.integration.test.ts`, `agent-core.test.ts`, `agent-compaction.test.ts`, memory/title/team/subagent tests, `events-reducer.test.ts`; the web side uses Vitest + jsdom. Real logins, paid model calls, and each provider's third-party-client terms are outside the automated suite.
