/**
 * The environment of every process a node (or the gateway) starts: agents,
 * approved host commands, panel terminals and git, Chromium, ffmpeg, the
 * OAuth worker. An explicit allowlist, not a denylist: the node's service
 * environment may hold its own tokens, provider keys from an environment file
 * it shares with the gateway, cloud credentials, an ssh-agent socket, … and
 * none of that may reach code the model drives.
 *
 * What is kept is what a development shell needs to find its tools, locale,
 * terminal, certificates and per-user directories. Users whose agent tools
 * need a credential (GITHUB_TOKEN, NPM_TOKEN, …) either put it in the agent
 * config `env` (`$PIRC_CONFIG_DIR/config.json`), which the agent adds for its
 * own tools, or name it in `PIRC_AGENT_ENV_ALLOW` (comma-separated) so it is
 * passed on from the node's environment (e.g. a systemd EnvironmentFile kept
 * out of the Nix store). The caller adds its own variables after this filter.
 *
 * Proxy variables (`*_PROXY`) are dropped too: under srt the sandbox sets its
 * own proxy variables inside the sandbox, and outside it a proxy URL may carry
 * credentials.
 */

/** pirc's own secrets (tokens, keys, passwords) and the gateway's web search key. */
export const SECRET_ENV = /^(PIRC_[A-Z0-9_]*(TOKENS?|SECRET|KEY|PASSWORD)[A-Z0-9_]*|EXA_API_KEY)$/;

/** A name that looks like a credential, whatever its prefix. Never kept. */
const CREDENTIAL_NAME =
  /(TOKENS?|SECRETS?|PASSW(OR)?D|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|AUTH)(_|$)/i;

/** Exact names a development shell legitimately needs. */
const ALLOWED_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'TERMINFO',
  'TERMINFO_DIRS',
  'NO_COLOR',
  'FORCE_COLOR',
  'TZ',
  'TMPDIR',
  'PWD',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'MANPATH',
  'INFOPATH',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'LOCALE_ARCHIVE',
  '__CF_USER_TEXT_ENCODING',
  // Nix and certificate bundles: without them TLS and nix tools break.
  'NIX_PATH',
  'NIX_PROFILES',
  'NIX_SSL_CERT_FILE',
  'NIX_USER_PROFILE_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  // Chromium on Nix finds its fonts through these.
  'FONTCONFIG_FILE',
  'FONTCONFIG_PATH',
  // Toolchain locations (directories, never credentials).
  'CARGO_HOME',
  'RUSTUP_HOME',
  'GOPATH',
  'GOROOT',
  'GOMODCACHE',
  'JAVA_HOME',
  'BUN_INSTALL',
  // srt's temporary directory, when the node itself runs inside srt.
  'CLAUDE_CODE_TMPDIR',
]);

/** Prefixes of variable families that only hold locale, terminal or directory settings. */
const ALLOWED_PREFIXES = ['LC_', 'XDG_', 'TERM_PROGRAM'];

/** Whether `name` may be passed to a process the node starts (see the module comment). */
export function allowedEnvName(name: string): boolean {
  if (name.startsWith('PIRC_')) return !SECRET_ENV.test(name) && !CREDENTIAL_NAME.test(name);
  if (CREDENTIAL_NAME.test(name)) return false;
  return ALLOWED_NAMES.has(name) || ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * `env` reduced to the allowlist plus the names in `extra`, which a caller
 * deliberately needs (e.g. the OAuth worker's proxy settings). pirc's own
 * secrets are never kept.
 */
export const allowlistedEnv = (
  env: NodeJS.ProcessEnv,
  extra: readonly string[] = [],
): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) =>
        value !== undefined &&
        !SECRET_ENV.test(name) &&
        (allowedEnvName(name) || extra.includes(name)),
    ),
  );

/** Variables the node operator passes on to agents on purpose (`PIRC_AGENT_ENV_ALLOW`). */
export const operatorAllowedEnv = (env: NodeJS.ProcessEnv): string[] =>
  (env.PIRC_AGENT_ENV_ALLOW ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));

/**
 * The environment of the processes a node starts: the allowlist, plus what
 * the operator named in `PIRC_AGENT_ENV_ALLOW`, plus `extra`.
 */
export const withoutSecrets = (
  env: NodeJS.ProcessEnv,
  extra: readonly string[] = [],
): Record<string, string | undefined> =>
  allowlistedEnv(env, [...extra, ...operatorAllowedEnv(env)]);
