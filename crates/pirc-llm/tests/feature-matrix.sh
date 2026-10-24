#!/usr/bin/env bash
# True isolation: only the two library crates, no pirc-providers feature union.
# Offline/cached dependencies only. Disposable manifests/build artifacts removed
# on success or failure. Run from any cwd: bash .../tests/feature-matrix.sh.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
repo=$(cd "$(dirname "$0")/../../.." && pwd)
stage=$(mktemp -d "${TMPDIR:-/tmp}/pirc-llm-matrix.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/crates"
cp -R "$repo/crates/pirc-llm" "$repo/crates/pirc-llm-types" "$stage/crates/"
# Keep the reviewed dependency versions without unifying features with the host.
cp "$repo/Cargo.lock" "$stage/Cargo.lock"
python3 - "$repo" "$stage" <<'PY'
import sys
from pathlib import Path
root, stage = map(Path, sys.argv[1:])
source = (root / "Cargo.toml").read_text()
(stage / "Cargo.toml").write_text(source[:source.index("# Shipped bytes")])
PY
cd "$stage"
export CARGO_TARGET_DIR="$stage/target"
for feature in '' openai-chat anthropic-messages openai-completions openai-responses openai-codex-responses oauth; do
  echo "=== isolated feature: ${feature:-default-minimal} ==="
  args=(--offline -p pirc-llm --no-default-features)
  if [[ -n "$feature" ]]; then args+=(--features "$feature"); fi
  cargo check "${args[@]}"
  cargo test "${args[@]}"
  cargo clippy "${args[@]}" --all-targets -- -D warnings
done
cargo test --offline -p pirc-llm --all-features
cargo clippy --offline -p pirc-llm --all-targets --all-features -- -D warnings
# Default normal graph must not contain HTTP/runtime/login machinery. Dev-only
# synthetic TLS clients don't count as library runtime dependencies.
cargo tree --offline -p pirc-llm --no-default-features -e normal > default-tree.txt
if grep -E 'reqwest|tokio|rustls|sha2|getrandom|pirc-protocol|pirc-config' default-tree.txt; then
  echo 'unexpected default-minimal runtime dependency' >&2
  exit 1
fi
for features in openai-chat oauth; do
  cargo tree --offline -p pirc-llm --no-default-features --features "$features" -e normal > transport-tree.txt
  if grep -E 'rustls|pirc-protocol|pirc-config' transport-tree.txt; then
    echo 'TLS or pirc policy was pulled into the library normal graph' >&2
    exit 1
  fi
done
cat default-tree.txt
