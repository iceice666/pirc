import type { Feature } from '../feature.js';
import type { Tool, UiApi } from '../tools/types.js';

export interface Question {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}
export interface QuestionAnswer {
  question: string;
  selected: string[];
  customText?: string;
}
export interface QuestionResult {
  status: 'answered' | 'cancelled' | 'unavailable';
  answers: QuestionAnswer[];
}

const OTHER = 'Other (type your own answer)';
const unsafe = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

export function validateQuestions(params: { questions?: unknown }): Question[] {
  const questions = params?.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4)
    throw new Error('Provide 1–4 questions');
  if (JSON.stringify(params).length > 24_000)
    throw new Error('Questionnaire exceeds 24000 characters');
  for (const q of questions as Question[]) {
    if (typeof q?.question !== 'string' || !q.question.trim() || q.question.length > 12_000)
      throw new Error('Question must be nonempty text (max 12000 characters)');
    if (q.header !== undefined && (typeof q.header !== 'string' || q.header.length > 120))
      throw new Error('Invalid question header');
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean')
      throw new Error('multiSelect must be boolean');
    if (
      q.options !== undefined &&
      (!Array.isArray(q.options) ||
        q.options.length > 12 ||
        q.options.some(
          (o) =>
            typeof o?.label !== 'string' ||
            !o.label.trim() ||
            o.label.length > 1000 ||
            o.label === OTHER ||
            (o.description !== undefined &&
              (typeof o.description !== 'string' || o.description.length > 4000)),
        ))
    )
      throw new Error('Provide at most 12 options with nonempty labels');
    if (
      [q.question, q.header, ...(q.options ?? []).flatMap((o) => [o.label, o.description])].some(
        (text) => text && unsafe.test(text),
      )
    )
      throw new Error('Question text must not contain control characters');
    if (new Set(q.options?.map((o) => o.label)).size !== (q.options?.length ?? 0))
      throw new Error('Option labels must be unique');
  }
  return questions as Question[];
}

async function askOne(ui: UiApi, q: Question, signal: AbortSignal): Promise<QuestionAnswer | null> {
  const title = q.header ? `${q.header}: ${q.question}` : q.question;
  const options = q.options ?? [];
  const typed = async (): Promise<string | null> => {
    while (!signal.aborted) {
      const text = await ui.input(title, 'Enter your answer', { signal });
      if (text === undefined) return null;
      if (text.trim() && text.length <= 4000) return text.trim();
    }
    return null;
  };
  if (!options.length) {
    const text = await typed();
    return text === null ? null : { question: q.question, selected: [], customText: text };
  }
  const picked = await ui.choose(title, [...options, { label: OTHER }], !!q.multiSelect, {
    signal,
  });
  if (!picked?.length || signal.aborted) return null;
  const selected = options.map((o) => o.label).filter((label) => picked.includes(label));
  if (!picked.includes(OTHER)) return { question: q.question, selected };
  const text = await typed();
  if (text === null) return null;
  return { question: q.question, selected, customText: text };
}

export async function askQuestions(
  ui: UiApi,
  hasUI: boolean,
  questions: Question[],
  signal: AbortSignal,
): Promise<QuestionResult> {
  if (signal.aborted) return { status: 'cancelled', answers: [] };
  if (!hasUI) return { status: 'unavailable', answers: [] };
  const answers: QuestionAnswer[] = [];
  for (const q of questions) {
    const answer = await askOne(ui, q, signal);
    if (!answer || signal.aborted) return { status: 'cancelled', answers: [] };
    answers.push(answer);
  }
  return { status: 'answered', answers };
}

export const askQuestionSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Question for the human user' },
          header: { type: 'string', description: 'Short label (max 120 chars)' },
          options: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, description: { type: 'string' } },
              required: ['label'],
              additionalProperties: false,
            },
          },
          multiSelect: { type: 'boolean' },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

export function askQuestionFeature(): Feature {
  let lifetime = new AbortController();
  const tool: Tool = {
    name: 'ask_user_question',
    description:
      'Ask the human 1–4 questions instead of guessing. Supports single/multiple choice and custom text. Write questions, headers and option labels in Traditional Chinese by default unless the user requests another language. Cancellation is not approval; do not infer an answer when unavailable or cancelled.',
    parameters: askQuestionSchema,
    async execute(args, ctx) {
      const questions = validateQuestions(args);
      if (!ctx.hasUI)
        return {
          content: [
            {
              type: 'text',
              text: 'Human UI unavailable in this agent. If you are a team worker, use agent_ask with to: "user".',
            },
          ],
          details: { status: 'unavailable', answers: [] },
        };
      const result = await askQuestions(
        ctx.ui,
        true,
        questions,
        AbortSignal.any([ctx.signal, lifetime.signal]),
      );
      const text = JSON.stringify(result);
      return {
        content: [
          {
            type: 'text',
            text:
              text.length > 48_000
                ? `${text.slice(0, 10_000)}\n[truncated; full answers in details]`
                : text,
          },
        ],
        details: result,
      };
    },
  };
  return {
    name: 'ask-question',
    tools: () => [tool],
    shutdown() {
      lifetime.abort();
      lifetime = new AbortController();
    },
  };
}
