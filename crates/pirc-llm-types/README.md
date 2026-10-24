# pirc-llm-types

Unpublished pure-data leaf extracted from `pirc-protocol` at baseline
`eb45f71d8fdefb35a796704ebd9ba7accdf098ff`. No HTTP, OAuth, socket, runtime,
environment loading, global TLS state or credential persistence dependencies.

## Placement and compatibility

- Shared: messages/content, tool schemas/choice, assistant deltas/usage/stop/error
  codes, thinking levels, API identifiers, model references and model/provider DTOs.
- Remain in `pirc-protocol`: `InferenceRequest` (session/provider routing), wire
  limits and link envelopes, `Models` (catalog envelope), `InferenceConfig` and
  socket implementation. Protocol re-exports the shared types unchanged.
- **Provider/Model are not secret-free.** Endpoint overrides, headers and API keys
  remain in these data-only compatibility DTOs to preserve identity and existing
  callers. Metadata/credential splitting is not complete. Runtime configuration,
  credential loading/persistence and safe projection remain host responsibilities.
- Existing Debug implementations hide API keys and header values; they are not
  general-purpose sanitizers for arbitrary URLs or opaque compatibility objects.
- No field, enum spelling, default, serde attribute or order is intentionally
  changed. The private opaque-details deserializer is duplicated from protocol so
  absent details remain distinct from explicit JSON null without a reverse
  dependency. `serde_json/preserve_order` is a direct dependency feature.

`tests/wire_compat.rs` fixtures passed against the original protocol definitions
**before** extraction: fixed full serialized strings cover roles, content and
all delta/enum tags, ordered nested maps/tool schemas, omission/null, model defaults
and endpoint DTO fields. Protocol integration tests additionally prove bidirectional
type identity and fixed bytes for routing/catalog/socket envelopes.

## Verification

```sh
PATH="$HOME/.cargo/bin:$PATH" cargo fmt -p pirc-llm-types -p pirc-protocol --check
PATH="$HOME/.cargo/bin:$PATH" cargo test -p pirc-llm-types -p pirc-protocol
PATH="$HOME/.cargo/bin:$PATH" cargo clippy -p pirc-llm-types -p pirc-protocol --all-targets -- -D warnings
PATH="$HOME/.cargo/bin:$PATH" bash crates/pirc-llm-types/scripts/check-isolated.sh
```

The isolated gate copies only the two lightweight crates, root workspace settings
and lockfile into a disposable workspace/target directory; it runs offline dependency
trees, check, tests and clippy without workspace feature unification. It needs the
locked serialization dependencies already cached and removes its outputs on exit.
The types tree is limited to serde/serde_json/indexmap and their implementation
dependencies; protocol adds only its existing Linux libc socket dependency.
