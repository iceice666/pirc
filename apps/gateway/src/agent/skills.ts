import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Agent Skills (https://agentskills.io): a directory holding `SKILL.md`, a
 * YAML front matter with `name` and `description` followed by instructions,
 * plus any scripts or references the instructions point to by relative path.
 * Only the name and description are put in the system prompt; the model reads
 * the rest when a task calls for it.
 */
export interface Skill {
  name: string;
  description: string;
  /** Real path of the skill's directory (symlinks resolved). */
  dir: string;
  /** Real path of its `SKILL.md`. */
  file: string;
}

/**
 * Where skills are looked up, lowest precedence first: the user's cross-tool
 * `~/.agents/skills` (a convention shared with other agent harnesses such as
 * OpenClaw and Hermes), then node-wide, then the project's.
 */
export function skillRoots(configDir: string, workspace: string): string[] {
  return [
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(configDir, 'skills'),
    path.join(workspace, '.pirc', 'skills'),
  ];
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_DESCRIPTION = 1024;

function parseYaml(text: string): unknown {
  const yaml = (globalThis as { Bun?: { YAML?: { parse(text: string): unknown } } }).Bun?.YAML;
  if (yaml) return yaml.parse(text);
  // Plain `key: value` lines, enough for the two fields read here.
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (match) out[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Split `SKILL.md` into its front matter and body. */
export function parseSkillFile(text: string): { meta: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const meta = parseYaml(match[1]!);
  return {
    meta: meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {},
    body: text.slice(match[0].length).trim(),
  };
}

/**
 * Skills found under `roots`; a later root replaces an earlier skill with the
 * same name. Invalid skills are skipped and reported in `problems`.
 */
export function discoverSkills(roots: string[]): { skills: Skill[]; problems: string[] } {
  const byName = new Map<string, Skill>();
  const problems: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const file = path.join(root, entry, 'SKILL.md');
      let dir: string;
      let text: string;
      try {
        if (!statSync(path.join(root, entry)).isDirectory() || !existsSync(file)) continue;
        dir = realpathSync(path.join(root, entry));
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      let meta: Record<string, unknown>;
      try {
        meta = parseSkillFile(text).meta;
      } catch (error) {
        problems.push(`${file}: invalid front matter (${(error as Error).message})`);
        continue;
      }
      const name = typeof meta.name === 'string' ? meta.name.trim() : entry;
      const description =
        typeof meta.description === 'string' ? meta.description.replace(/\s+/g, ' ').trim() : '';
      if (!NAME.test(name) || name.length > 64) {
        problems.push(`${file}: name must be lowercase letters, digits and hyphens (max 64)`);
        continue;
      }
      if (!description) {
        problems.push(`${file}: description is required`);
        continue;
      }
      byName.set(name, {
        name,
        description:
          description.length > MAX_DESCRIPTION
            ? `${description.slice(0, MAX_DESCRIPTION - 1)}…`
            : description,
        dir,
        file: path.join(dir, 'SKILL.md'),
      });
    }
  }
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

const LINK_SCAN_DEPTH = 8;
const LINK_SCAN_ENTRIES = 2000;

/**
 * Real targets of the symlinks inside a skill directory. Home Manager, for
 * one, builds a real directory whose files each link to a separate store path
 * (`SKILL.md -> /nix/store/…-hm_SKILL.md`), so allowing the directory alone
 * is not enough once the path guard resolves the link.
 */
function linkedTargets(dir: string, out: Set<string>): void {
  const seen = new Set<string>();
  let budget = LINK_SCAN_ENTRIES;
  const walk = (current: string, depth: number) => {
    if (depth > LINK_SCAN_DEPTH || seen.has(current)) return;
    seen.add(current);
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (--budget < 0) return;
      const full = path.join(current, entry);
      try {
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) {
          const real = realpathSync(full);
          out.add(real);
          if (statSync(real).isDirectory()) walk(real, depth + 1);
        } else if (stat.isDirectory()) walk(full, depth + 1);
      } catch {
        // Dangling or unreadable link: nothing to allow.
      }
    }
  };
  walk(dir, 0);
}

/**
 * Real paths the file tools must be able to read (but never write) for skills
 * to work: each root, each skill directory a root links to elsewhere, and
 * whatever the files inside a skill directory link to.
 */
export function skillReadPaths(roots: string[]): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    out.add(root);
    for (const skill of discoverSkills([root]).skills) {
      out.add(skill.dir);
      linkedTargets(skill.dir, out);
    }
  }
  return [...out];
}
