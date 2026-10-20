# OpenCode catalog snapshot

`opencode.json` is pinned separately because OpenCode's live catalog changes between pi-ai package releases. It records the refresh date, SHA-256 hashes of three public source documents, the converted models, and every omitted live model ID with its reason.

Sources:

- [models.dev metadata](https://models.dev/api.json): model names, limits, input capabilities and SDK/API selection from its OpenCode provider entries.
- [OpenCode Zen model IDs](https://opencode.ai/inference/v1/models).
- [OpenCode Go model IDs](https://opencode.ai/inference/go/v1/models).
- [Official API endpoints](https://opencode.ai/v2/docs/console/models/) and [Go endpoints](https://opencode.ai/v2/docs/console/go/).

Refresh explicitly from the repository root:

```sh
bun scripts/model-catalog.ts --refresh-opencode
bun scripts/model-catalog.ts --check
bun test scripts/test/model-catalog.test.ts
cargo test --locked -p pirc-providers
```

Normal generation and CI checks are offline. Review changed models, protocols and omissions, update the catalog-count test and the OpenCode entries of the backend conformance snapshot, and run the Linux conformance gate before release. The snapshot refresh does not change other providers or the pinned OAuth catalogs.

Only live IDs with OpenCode metadata enter the catalog. A Go ID missing from its models.dev entry can use Zen's same-ID metadata; its inference route remains on Go. The converter rejects unknown endpoint origins/paths and invalid limits. Unsupported native wire APIs and missing metadata are listed in `omitted`, without guessing limits or silently routing them through Chat Completions. Unsupported PDF, video and audio inputs are not advertised.

The gateway normalizes Anthropic base URLs because its adapter appends `/v1/messages`. pi-ai's existing request compatibility and thinking maps are retained only for same-ID, same-API models. Protocol changes drop old API-specific flags. New `reasoning_content` interleaving metadata is preserved. Real provider authentication, plan availability and paid inference remain manual acceptance checks.
