#!/usr/bin/env bash
# Verify the leaf without workspace feature unification or provider dependencies.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/pirc-llm-types-check.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch/crates"
cp "$root/Cargo.toml" "$root/Cargo.lock" "$scratch/"
cp -R "$root/crates/pirc-llm-types" "$root/crates/pirc-protocol" "$scratch/crates/"
cd "$scratch"
# A separate target directory also prevents accidental reuse of unified artifacts.
export CARGO_TARGET_DIR="$scratch/target"
cargo tree --offline -p pirc-llm-types --no-default-features
cargo tree --offline -p pirc-protocol --no-default-features
cargo check --offline --workspace --no-default-features
cargo test --offline --workspace --no-default-features
cargo clippy --offline --workspace --all-targets --no-default-features -- -D warnings
