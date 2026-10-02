/**
 * The node's view of the process-environment allowlist (src/env-allowlist.ts):
 * every process the node starts gets `withoutSecrets(process.env)`. The
 * implementation lives outside `src/node/` because the gateway's OAuth worker
 * uses it too, and the gateway bundle must not pull in node code.
 */
export {
  SECRET_ENV,
  allowedEnvName,
  allowlistedEnv,
  operatorAllowedEnv,
  withoutSecrets,
} from '../env-allowlist.js';
