/** Node-local, user-managed chat configuration. Never mirrored to the gateway. */
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { ApiError } from './errors.js';

export const PROMPT_MAX_CHARS = 8000;
export const PROMPT_FILES = { soul: 'SOUL.md', chat: 'CHAT.md' } as const;
export type PromptName = keyof typeof PROMPT_FILES;
export interface AssistantPrompt {
  text: string;
  writable: boolean;
  reason?: 'nix-store' | 'symlink' | 'permission';
  path: string;
  maxChars: number;
}

/** Follow managed symlinks for reading, but never read a device or FIFO. */
export function readAssistantPrompt(file: string): string {
  try {
    if (!statSync(file).isFile()) return '';
    return readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim().slice(0, PROMPT_MAX_CHARS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export function inspectAssistantPrompt(configDir: string, name: PromptName): AssistantPrompt {
  const file = path.join(configDir, PROMPT_FILES[name]);
  let reason: AssistantPrompt['reason'];
  try {
    let resolved: string;
    try {
      resolved = realpathSync(file);
    } catch {
      resolved = path.join(realpathSync(configDir), PROMPT_FILES[name]);
    }
    if (resolved === '/nix/store' || resolved.startsWith('/nix/store/')) reason = 'nix-store';
    let entry;
    try {
      entry = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!reason && entry?.isSymbolicLink()) reason = 'symlink';
    if (!reason) {
      accessSync(configDir, constants.W_OK);
      if (entry) {
        if (!entry.isFile()) throw new Error('Not a regular file');
        accessSync(file, constants.W_OK);
      }
    }
  } catch {
    reason ??= 'permission';
  }
  let text = '';
  try {
    text = readAssistantPrompt(file);
  } catch {
    reason ??= 'permission';
  }
  return {
    text,
    writable: !reason,
    ...(reason ? { reason } : {}),
    path: file,
    maxChars: PROMPT_MAX_CHARS,
  };
}

export function writeAssistantPrompt(
  configDir: string,
  name: PromptName,
  text: string,
): AssistantPrompt {
  const value = text.replace(/\r\n/g, '\n').trim();
  if (value.length > PROMPT_MAX_CHARS)
    throw new ApiError(
      413,
      'payload_too_large',
      `Prompts are limited to ${PROMPT_MAX_CHARS} characters`,
    );
  const current = inspectAssistantPrompt(configDir, name);
  if (!current.writable)
    throw new ApiError(409, 'read_only', `Prompt is read-only (${current.reason})`);
  const temp = `${current.path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    if (!value) rmSync(current.path, { force: true });
    else {
      writeFileSync(temp, `${value}\n`, { mode: 0o600, flag: 'wx' });
      // Recheck immediately before replacing: never knowingly replace a managed symlink.
      if (!inspectAssistantPrompt(configDir, name).writable)
        throw new ApiError(409, 'read_only', 'Prompt became read-only');
      renameSync(temp, current.path);
    }
  } finally {
    rmSync(temp, { force: true });
  }
  return inspectAssistantPrompt(configDir, name);
}
