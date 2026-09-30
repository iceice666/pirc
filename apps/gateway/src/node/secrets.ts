/**
 * Environment secrets the node (or a gateway sharing its environment file)
 * holds that agents, user shells and helper processes have no business
 * seeing: pirc's own tokens, keys and secrets, and the gateway's web search
 * key. Credentials the user put there for their own tools (GITHUB_TOKEN, …)
 * are kept; the agent's config `env` is the place for anything else.
 */
export const SECRET_ENV = /^(PIRC_[A-Z0-9_]*(TOKENS?|SECRET|KEY|PASSWORD)[A-Z0-9_]*|EXA_API_KEY)$/;

/** `env` without the node's secrets, for the processes a node starts. */
export const withoutSecrets = (env: NodeJS.ProcessEnv): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_ENV.test(name)));
