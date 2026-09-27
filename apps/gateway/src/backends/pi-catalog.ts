/**
 * Pi's generated model catalog, without Pi's main entry point.
 *
 * `@mariozechner/pi-ai` (the package root) registers every built-in provider,
 * which makes `bun build --compile` bundle SDKs pirc never calls (Mistral,
 * Google, Bedrock) and their optional peers. The catalog module has no such
 * imports, but the package does not export it, so it is mapped by path in
 * tsconfig.json (`#pi-models`). The dependency is pinned to an exact version,
 * so this internal path is stable for the version pirc was verified against.
 */
export { getModels } from '#pi-models';
