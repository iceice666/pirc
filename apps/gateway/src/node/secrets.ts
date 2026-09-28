/** Environment secrets the node holds that its agents and user shells have no business seeing. */
export const SECRET_ENV = /^(PIRC_NODE_TOKENS?|PIRC_.*SECRET.*)$/;

/** `env` without the node's secrets, for the processes a node starts. */
export const withoutSecrets = (env: NodeJS.ProcessEnv): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_ENV.test(name)));
