import { common } from './common';
import { engine } from './engine';
import { face } from './face';
import { panel } from './panel';
import { rooms } from './rooms';
import { settings } from './settings';
import { thread } from './thread';

/** Every message file, for the test that checks the two languages agree. */
export const PARTS = { common, rooms, thread, face, engine, panel, settings } as const;

/**
 * The English catalogue, one flat key per string. Spreading the parts keeps
 * each key's literal type, so `t()` only accepts keys that exist and the
 * Traditional Chinese catalogue is checked against the same set.
 */
export const en = {
  ...common.en,
  ...rooms.en,
  ...thread.en,
  ...face.en,
  ...engine.en,
  ...panel.en,
  ...settings.en,
};

export type MessageKey = keyof typeof en;

/** Traditional Chinese (Taiwan), complete against the English catalogue. */
export const zhTW: Record<MessageKey, string> = {
  ...common.zh,
  ...rooms.zh,
  ...thread.zh,
  ...face.zh,
  ...engine.zh,
  ...panel.zh,
  ...settings.zh,
};

export const MESSAGES = { en, 'zh-TW': zhTW } as const;
