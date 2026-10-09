/**
 * Messages between the agent (host) and the `ptc-guest` process running one
 * `ptc` script in QuickJS (guest.ts), over Bun IPC (JSON). The guest holds
 * no authority: it can only ask the host to run an operation; the host
 * validates every field, decides and keeps every record.
 */
import { BUDGETS, type ErrorCode } from './contracts.js';

/** Scope id of code outside any `tools.par`. */
export const ROOT_SCOPE = 'root';

/** What the guest sends at most, so oversized script values never cross the process boundary. */
export const GUEST_LIMITS = Object.freeze({
  /** Arguments of one call (characters; the host's byte limit is checked again). */
  argsChars: BUDGETS.argsBytes,
  nameChars: 65,
  /** A returned value; the model sees at most `toolOutputBytes` of it anyway. */
  valueChars: 1024 * 1024,
});

export type HostMessage =
  | {
      type: 'start';
      /** Preflighted JavaScript defining `async function __ptc_main()`. */
      code: string;
      manifest: string[];
      /** The session's script store (JSON object) as `load()` sees it. */
      store?: string;
    }
  /** An operation's envelope (JSON). */
  | { type: 'result'; id: number; json: string };

export type ScriptOutcome =
  /**
   * `store`: the whole store (JSON) when the script changed it. `loaded`: the script read a
   * stored value with `load()` (its output may carry what was stored).
   */
  | { ok: true; value?: string; string?: boolean; store?: string; loaded?: boolean }
  | {
      ok: false;
      error: { code: ErrorCode | 'ScriptError'; message: string };
      loaded?: boolean;
    };

export type GuestMessage =
  /**
   * `name`/`argsJson` are '' when the script passed something other than a
   * string; `oversize` marks arguments too large to send.
   */
  | { type: 'call'; id: number; name: string; argsJson: string; scope: string; oversize?: true }
  /** `attachments.add(handle)`: answered with a `result` of the same id. */
  | { type: 'attach'; id: number; handle: string }
  | { type: 'log'; level: string; text: string }
  | { type: 'scope_open'; scope: string; parent: string }
  | { type: 'scope_cancel'; scope: string }
  | { type: 'scope_close'; scope: string; status: 'completed' | 'failed' }
  /**
   * The script ran every job it could and now waits for operation results;
   * `received` counts the results it had been given by then.
   */
  | { type: 'idle'; received: number }
  | { type: 'done'; outcome: ScriptOutcome; received?: number };
