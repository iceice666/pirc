# Retired TypeScript server (0.3.0)

The 0.4.0 runtime is implemented in `crates/`. The TS server sources and Bun
server build scripts were removed at the user's request during M9. This directory
retains API/configuration documentation and historical tests/evaluation work only;
it is not a Bun workspace and is not part of the default build or test stack.

The preserved tests, `scripts/ptc-*`, `scripts/rust-m5*`,
`scripts/browser-reference.ts`, and `crates/pirc-providers/tests/parity/record.ts`
that import the old server **cannot run from this checkout**. To reproduce the TS
baseline, use a separate checkout of the pre-cutover revision and its original
`bun.lock`/gateway dependencies. Copy the desired evaluation tooling into that
checkout; do not restore the old implementation into production packaging.
No historical paid-run result is invalidated or promoted to a passing gate by
this removal. Paid evaluations still need explicit operator authorization.

Current offline conformance and provider parity tests replay committed fixtures
using native Rust executables and local fake providers. `fixtures/timeline` and
the web/Android client implementation are unchanged by the cutover.
