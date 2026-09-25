import { z } from 'zod';
import type { Agent } from '../agent.js';
import { resolveApiKey } from '../config.js';
import type { Feature } from '../feature.js';
import type { AssistantMessage } from '../messages.js';

/**
 * Automatic session titles, after oh-my-pi's title generator: the first user
 * message that describes work is sent to a model in a side request (no tools,
 * no thinking) that answers with `<title>…</title>`. Greetings are skipped
 * without a model call, and a failed or declined attempt is retried on the next
 * message while the session stays unnamed.
 */

const settingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Model for titles; defaults to the session's current model. */
    model: z.object({ provider: z.string(), id: z.string() }).optional(),
    /** Replaces the default system prompt; the `<title>` instruction is always appended. */
    prompt: z.string().optional(),
    maxAttempts: z.number().int().positive().max(10).default(3),
  })
  .default({});

const MAX_INPUT_CHARS = 2_000;
const MAX_TITLE_CHARS = 80;
const MAX_TOKENS = 512;
const TIMEOUT_MS = 30_000;

const MARKER_INSTRUCTION =
  'Wrap the title in <title></title> tags and output nothing else. If the message does not describe a task or topic, output <title>none</title>.';

export const TITLE_SYSTEM_PROMPT = `You name coding-agent sessions from the user's first message.
Write a concise title of 3 to 7 words that captures the task (for example "Fix login button on mobile").
Use the same language as the user's message. Use sentence case, no quotes, no emoji, and no trailing punctuation.
${MARKER_INSTRUCTION}`;

const LOW_SIGNAL = new Set([
  'hi',
  'hello',
  'hey',
  'yo',
  'sup',
  'thanks',
  'thank you',
  'thx',
  'ty',
  'ok',
  'okay',
  'k',
  'yes',
  'yeah',
  'yep',
  'no',
  'nope',
  'sure',
  'cool',
  'nice',
  'great',
  'good',
  'continue',
  'go on',
  'go ahead',
  'test',
  'ping',
  '你好',
  '您好',
  '嗨',
  '哈囉',
  '哈喽',
  '謝謝',
  '谢谢',
  '好',
  '好的',
  '嗯',
  '對',
  '对',
  '是',
  '不是',
  '在嗎',
  '在吗',
  '繼續',
  '继续',
  '測試',
  '测试',
]);

/** Greetings, acknowledgements, bare numbers and emoji carry no task to name. */
export function isLowSignalTitleInput(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+$/u, '')
    .replace(/^[\s\p{P}\p{S}]+/u, '')
    .replace(/\s+/g, ' ');
  if (!normalized) return true;
  if (LOW_SIGNAL.has(normalized)) return true;
  if (/^\d+$/.test(normalized)) return true;
  // Emoji, symbols and punctuation only.
  if (!/[\p{L}\p{N}]/u.test(normalized)) return true;
  return false;
}

/** Extract a clean title from a model reply; `null` when it declined or produced nothing usable. */
export function parseTitle(raw: string): string | null {
  let text = raw
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .replace(/```(?:reasoning|thinking)[\s\S]*?```/gi, '');
  const tagged = [...text.matchAll(/<title>([\s\S]*?)(?:<\/title>|$)/gi)];
  if (tagged.length) text = tagged.at(-1)![1]!;
  else if (/<title\s*\/>/i.test(text)) return null;
  text = text.replace(/^```\w*\s*|\s*```$/g, '').trim();
  const json = /^\{\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"?/.exec(text);
  if (json) {
    try {
      text = JSON.parse(`"${json[1]}"`);
    } catch {
      text = json[1]!;
    }
  }
  const line = text
    .split('\n')
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return null;
  let title = line
    .replace(/^(?:title|標題|标题)\s*[:：]\s*/i, '')
    .replace(/^["'`“”‘’「」『』]+|["'`“”‘’「」『』]+$/g, '')
    .replace(/[\s.。!！,，;；:：]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || /^(none|null|n\/a)$/i.test(title)) return null;
  if (title.length > MAX_TITLE_CHARS) {
    const cut = title.slice(0, MAX_TITLE_CHARS);
    const space = cut.lastIndexOf(' ');
    title = `${(space > MAX_TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return title;
}

function replyText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('');
}

export function titleSettings(agent: Agent) {
  const parsed = settingsSchema.safeParse(agent.config.features.sessionTitle ?? {});
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

/** One title request; resolves `null` on any failure. */
export async function generateTitle(
  agent: Agent,
  message: string,
  signal: AbortSignal,
): Promise<string | null> {
  const settings = titleSettings(agent);
  const { providerName, provider, model } = agent.resolveModel(settings.model ?? agent.modelRef);
  const custom = settings.prompt?.trim();
  const reply = await agent.streamFunction(provider)(
    {
      providerName,
      provider,
      model,
      apiKey: resolveApiKey(providerName, provider),
      systemPrompt: custom ? `${custom}\n\n${MARKER_INSTRUCTION}` : TITLE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `<user-message>\n${message.trim().slice(0, MAX_INPUT_CHARS)}\n</user-message>`,
          timestamp: Date.now(),
        },
      ],
      tools: [],
      thinking: 'off',
      sessionId: `${agent.store.sessionId}-title`,
      signal,
      maxTokens: Math.min(model.maxTokens, MAX_TOKENS),
    },
    () => {},
  );
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') return null;
  return parseTitle(replyText(reply));
}

export function titleFeature(): Feature {
  let attempts = 0;
  let inflight: AbortController | null = null;

  const attempt = async (agent: Agent, text: string) => {
    const controller = new AbortController();
    inflight = controller;
    try {
      const title = await generateTitle(
        agent,
        text,
        AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      );
      // A user rename while the request was in flight wins.
      if (title && !controller.signal.aborted && !agent.sessionName) agent.setName(title, 'auto');
    } catch {
      /* best effort: the next message retries while attempts remain */
    } finally {
      if (inflight === controller) inflight = null;
    }
  };

  return {
    name: 'session-title',
    userInput(agent, text) {
      // Team sub-agents run headless and are never shown in the session list.
      if (!agent.hasUI || agent.sessionName || inflight) return;
      const settings = titleSettings(agent);
      if (!settings.enabled || attempts >= settings.maxAttempts) return;
      if (isLowSignalTitleInput(text)) return;
      attempts++;
      void attempt(agent, text);
    },
    shutdown() {
      inflight?.abort();
    },
  };
}
