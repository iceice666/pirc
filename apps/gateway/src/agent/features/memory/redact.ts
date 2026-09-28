/**
 * Best-effort removal of credentials from memory text before it is stored.
 * Memory outlives its session and is replayed into later prompts (and, for
 * workspace memory, into other sessions), so a secret that reaches it spreads.
 * Covers well-known token formats plus the literal values of this process's
 * secret-looking environment variables. Arbitrary secrets in other formats are
 * not detected.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]',
  ],
  [/\b(pirc_dev_)[A-Za-z0-9_-]{16,}/g, '$1[REDACTED]'],
  [/\b(sk-)[A-Za-z0-9_-]{20,}/g, '$1[REDACTED]'],
  [/\b(github_pat_)[A-Za-z0-9_]{20,}/g, '$1[REDACTED]'],
  [/\b(gh[pousr]_)[A-Za-z0-9]{30,}/g, '$1[REDACTED]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[REDACTED]'],
];

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL/i;
const MIN_SECRET_LENGTH = 16;

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  const values = Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        entry[1].length >= MIN_SECRET_LENGTH &&
        SECRET_NAME.test(entry[0]),
    )
    // Longest first, so a secret containing another is replaced whole.
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of values)
    if (out.includes(value)) out = out.split(value).join(`[REDACTED ${name}]`);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
