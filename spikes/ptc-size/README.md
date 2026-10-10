# Spike B: PTC in Rust (rquickjs + oxc)

M1 spike for [the Rust rewrite](../../plans/rust-rewrite.md): what running `ptc` scripts natively adds to an executable, and whether the pieces do what `agent/ptc/{guest,preflight}.ts` needs.

`cargo run --release --features quickjs,oxc` strips the types from a TypeScript script wrapped as `async function __ptc_main`, collects the `tools.<name>` uses, and runs it in QuickJS with an async host function standing in for the IPC call. A busy loop and an allocation loop show the guest's limits.

## Result (2026-10-10, Linux x86_64, Rust 1.98.1, rquickjs 0.14, oxc 0.153)

Release profile as in the workspace (`lto = "fat"`, `codegen-units = 1`, `strip = true`):

| Build                              | Bytes     | Added    |
| ---------------------------------- | --------- | -------- |
| baseline (tokio current-thread)    | 402,264   |          |
| `quickjs`                          | 1,799,032 | 1.33 MiB |
| `quickjs,oxc`                      | 4,072,360 | 2.17 MiB |
| `quickjs,oxc` with `opt-level="s"` | 3,011,496 |          |
| `quickjs,oxc` with `opt-level="z"` | 2,622,376 |          |

Behaviour:

- Type stripping and codegen work on a typical script (type aliases, annotations, `!`, `as const`).
- An `oxc` AST visitor finds the `tools.<name>` member uses, as acorn does in `preflight.ts`.
- An async Rust function returning a future becomes a JavaScript promise the script awaits (`rquickjs` `futures` feature).
- `set_interrupt_handler` with a deadline stops `for (;;) {}` with `Error: interrupted`.
- `set_memory_limit` stops an allocation loop with `Error: out of memory`.

## Conclusions

- PTC costs about 3.5 MiB at `opt-level=3` and 2.1 MiB at `"z"` (over the baseline): small against today's 101 MB node, so no fallback is needed.
- Keep the killable child process. `guest.ts` runs in its own process because QuickJS's interrupt handler is not called inside a backtracking regular expression; that was found with quickjs-emscripten and not re-verified on native rquickjs here, and the child process is cheap insurance either way.
- `rquickjs` compiles QuickJS from C, so building `pirc-node` needs a C compiler (the Nix build has one).
- `async_with!` is deprecated in rquickjs 0.14 in favour of `AsyncContext::async_with` with async closures; the port should use the latter.
