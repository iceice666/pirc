/**
 * Records the golden Seatbelt profiles in this directory from srt 0.0.78
 * (`sandbox/macos/profile.rs` is checked against them by
 * `tests/sandbox_macos_profiles.rs`, on every platform, and the backend's
 * environment against the `.env` files by `sandbox/macos.rs`'s tests).
 *
 * For each case in `cases.json` it builds the case's tree in a fresh temp
 * directory, points `HOME`, the working directory and `CLAUDE_CODE_TMPDIR`
 * at it, and asks srt's macOS wrapper for the command line of `true` with the
 * case's settings, as `srt --settings` would on a Mac: `filesystem` and
 * `network` reach `wrapCommandWithSandboxMacOS` through the same steps as
 * `SandboxManager.wrapWithSandbox` (the default write paths, `/**` stripped).
 * Cases with a proxy are also run through `SandboxManager` itself, and the
 * two profiles must agree (but for the JVM proxy agent, which pirc does not
 * ship: its jar's read allowance and `-javaagent` flag are left out). The profile and the environment srt sets are
 * written to `<name>.sb` and `<name>.env`, with the temp directory as
 * `{ROOT}`, the run of its ancestors' `(literal …)` lines as
 * `{ROOT_ANCESTORS}`, the proxy port as `{PORT}`, the proxy token as `{TOKEN}` and the
 * log tag as `{TAG}`.
 *
 * Runs on any platform (srt is told it is on macOS). From the repository
 * root, with the main checkout's dependencies installed:
 *
 *     PIRC_SRT_PACKAGE=<main checkout>/apps/gateway/node_modules/@anthropic-ai/sandbox-runtime \
 *       bun crates/pirc-node/tests/fixtures/sbpl/record.ts
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const srtPackage =
  process.env.PIRC_SRT_PACKAGE ??
  path.resolve(here, '../../../../../apps/gateway/node_modules/@anthropic-ai/sandbox-runtime');
const version = JSON.parse(readFileSync(path.join(srtPackage, 'package.json'), 'utf8')).version;
if (version !== '0.0.78') throw new Error(`expected srt 0.0.78, found ${version}`);

// srt reads the platform on every call: from here on it builds macOS profiles.
Object.defineProperty(process, 'platform', { value: 'darwin' });

const dist = path.join(srtPackage, 'dist');
const { SandboxManager } = await import(path.join(dist, 'index.js'));
const { loadConfigFromString } = await import(path.join(dist, 'utils/config-loader.js'));
const { wrapCommandWithSandboxMacOS } = await import(
  path.join(dist, 'sandbox/macos-sandbox-utils.js')
);
const { getDefaultWritePaths, removeTrailingGlobSuffix } = await import(
  path.join(dist, 'sandbox/sandbox-utils.js')
);

interface Case {
  name: string;
  tree: { dirs: string[]; files: string[]; symlinks: Record<string, string> };
  home: string;
  cwd: string;
  tmpdir: string;
  proxy: boolean;
  generate?: { denyWrite: { prefix: string; count: number; leaves: string[] } };
  settings: any;
}

/** The words of a command line `quote()` (utils/shell-quote.js) produced. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === ' ') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word += line.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === '"') {
      const end = line.indexOf('"', i + 1);
      word += line.slice(i + 1, end);
      i = end;
      inWord = true;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** The profile and the `NAME=value` words before `/usr/bin/sandbox-exec`. */
function split(line: string) {
  const words = shellWords(line);
  if (words[0] !== 'env') throw new Error(`unexpected command line: ${line}`);
  const exec = words.indexOf('/usr/bin/sandbox-exec');
  if (words[exec + 1] !== '-p') throw new Error(`no profile in: ${line}`);
  return { env: words.slice(1, exec), profile: words[exec + 2]! };
}

function expand(value: any, root: string): any {
  if (typeof value === 'string') return value.replaceAll('{ROOT}', root);
  if (Array.isArray(value)) return value.map((item) => expand(item, root));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, root)]));
  return value;
}

const cases: Case[] = JSON.parse(readFileSync(path.join(here, 'cases.json'), 'utf8'));

/** The proper ancestors of `dir`, nearest first, without `/`. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let at = path.dirname(dir); at !== '/'; at = path.dirname(at)) out.push(at);
  return out;
}

if (process.argv[2] !== '--case') {
  // srt reads the home directory once per process: one child per case, with
  // `HOME` in the case's tree. Two levels below the temp directory, so the
  // root's ancestors form a run of lines the profiles replace by a marker.
  const base = path.join(realpathSync(tmpdir()), 'pirc-sbpl');
  mkdirSync(base, { recursive: true });
  for (const [index, item] of cases.entries()) {
    const root = mkdtempSync(path.join(base, 'r'));
    try {
      for (const dir of item.tree.dirs) mkdirSync(path.join(root, dir), { recursive: true });
      for (const file of item.tree.files) writeFileSync(path.join(root, file), '');
      for (const [link, target] of Object.entries(item.tree.symlinks))
        symlinkSync(target, path.join(root, link));
      const child = Bun.spawnSync(
        [process.execPath, new URL(import.meta.url).pathname, '--case', String(index), root],
        {
          env: { ...process.env, HOME: path.join(root, item.home) },
          stdout: 'inherit',
          stderr: 'inherit',
        },
      );
      if (child.exitCode !== 0) throw new Error(`${item.name}: exit ${child.exitCode}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  process.exit(0);
}

const item = cases[Number(process.argv[3])]!;
const root = process.argv[4]!;
{
  {
    const settings = expand(item.settings, root);
    if (item.generate) {
      const { prefix, count, leaves } = item.generate.denyWrite;
      for (let n = 0; n < count; n++)
        for (const leaf of leaves)
          settings.filesystem.denyWrite.push(`${expand(prefix, root)}${n}/${leaf}`);
    }
    const config = loadConfigFromString(JSON.stringify(settings));
    if (!config) throw new Error(`${item.name}: srt refuses the settings`);
    process.env.CLAUDE_CODE_TMPDIR = path.join(root, item.tmpdir);
    delete process.env.JAVA_TOOL_OPTIONS;
    process.chdir(path.join(root, item.cwd));

    // `wrapWithSandbox`'s macOS branch with srt's own helpers.
    const fs = config.filesystem;
    const writeConfig = {
      allowOnly: [
        ...getDefaultWritePaths({ denyRead: fs.denyRead, allowRead: fs.allowRead }),
        ...fs.allowWrite.map(removeTrailingGlobSuffix),
      ],
      denyWithinAllow: fs.denyWrite.map(removeTrailingGlobSuffix),
    };
    const readConfig = {
      denyOnly: fs.denyRead.map(removeTrailingGlobSuffix),
      allowWithinDeny: (fs.allowRead ?? []).map(removeTrailingGlobSuffix),
    };
    const port = 40000;
    const direct = split(
      wrapCommandWithSandboxMacOS({
        command: 'true',
        needsNetworkRestriction: true,
        httpProxyPort: item.proxy ? port : undefined,
        socksProxyPort: item.proxy ? port : undefined,
        readConfig,
        writeConfig,
        allowUnixSockets: config.network.allowUnixSockets,
        allowAllUnixSockets: config.network.allowAllUnixSockets,
        allowLocalBinding: config.network.allowLocalBinding,
        allowPty: config.allowPty,
        allowGitConfig: fs.allowGitConfig ?? false,
        binShell: 'sh',
      }),
    );
    const tag = direct.profile.match(/CMD64_[A-Za-z0-9+/=]*_END__[a-z0-9]+_SBX/)?.[0];
    if (!tag) throw new Error(`${item.name}: no log tag`);
    const run = ancestors(root)
      .map((dir) => `  (literal ${JSON.stringify(dir)})\n`)
      .join('');
    const normalize = (text: string) =>
      text
        .replaceAll(run, '  {ROOT_ANCESTORS}\n')
        .replaceAll(tag, '{TAG}')
        .replaceAll(root, '{ROOT}')
        .replaceAll(`localhost:${port}`, 'localhost:{PORT}')
        .replaceAll(`PORT=${port}`, 'PORT={PORT}');

    if (item.proxy) {
      // The real thing, with its own proxy: the same profile.
      await SandboxManager.initialize(config);
      try {
        const managed = split(await SandboxManager.wrapWithSandbox('true', 'sh'));
        const managedPort = managed.profile.match(/localhost:(\d+)"/)?.[1];
        const managedTag = managed.profile.match(/CMD64_[A-Za-z0-9+/=]*_END__[a-z0-9]+_SBX/)?.[0];
        // pirc ships no JVM proxy agent: its jar's allowRead and flag go.
        const jar = (text: string) =>
          text
            .split('\n')
            .filter((line) => !line.includes('srt-proxy-agent.jar'))
            .join('\n')
            // A rule left with no filter is not emitted (`renderRule`).
            .replace(/\(allow file-read\*\n  \(with message "[^"]*"\)\)\n/, '');
        const same = jar(managed.profile)
          .replaceAll(managedTag!, tag)
          .replaceAll(`localhost:${managedPort}`, `localhost:${port}`);
        if (same !== direct.profile)
          throw new Error(`${item.name}: SandboxManager's profile differs from the direct one`);
        // Only SandboxManager's proxy has a token.
        const token = managed.env
          .map((word) => word.match(/^HTTP_PROXY=http:\/\/[^:]+:([0-9a-f]+)@/)?.[1])
          .find(Boolean);
        const env = managed.env
          .map((word) => word.replace(/-javaagent:\S+ /, ''))
          .map((word) =>
            normalize(
              word
                .replaceAll(token!, '{TOKEN}')
                .replaceAll(managedTag!, tag)
                .replaceAll(`localhost:${managedPort}`, `localhost:${port}`)
                .replaceAll(`PORT=${managedPort}`, `PORT=${port}`),
            ),
          );
        writeFileSync(path.join(here, `${item.name}.env`), `${env.join('\n')}\n`);
      } finally {
        await SandboxManager.reset();
      }
    } else {
      writeFileSync(
        path.join(here, `${item.name}.env`),
        `${direct.env.map(normalize).join('\n')}\n`,
      );
    }
    writeFileSync(path.join(here, `${item.name}.sb`), `${normalize(direct.profile)}\n`);
    console.log(`${item.name}: ${direct.profile.length} bytes`);
  }
}
