/**
 * Per-project instructions (plans/assistant.md §5): the text the user wrote
 * for every chat of a project, kept by the node (node/chat.ts) and handed to
 * the agent on its configure line. Like USER/MEMORY it is frozen when the
 * chat starts: an edit reaches new chats only. It is shown after the chat
 * prompt and before USER/MEMORY, next to the other instructions (AGENTS.md)
 * rather than among the remembered facts, and its frozen text keeps the
 * prompt prefix stable for the provider's cache.
 *
 * The agent never writes it: the file is outside every session directory and
 * protected from the file tools and the sandbox (`PIRC_PROJECT_INSTRUCTIONS`).
 */
import type { Agent } from '../agent.js';
import type { Feature } from '../feature.js';

export const PROJECT_INSTRUCTIONS_SNAPSHOT = 'project.instructions';

/** The instructions this chat started with, frozen in the session on its first run. */
export function frozenInstructions(agent: Agent): string {
  const branch = agent.store.branch();
  const existing = branch.findLast(
    (entry) => entry.type === 'custom' && entry.customType === PROJECT_INSTRUCTIONS_SNAPSHOT,
  );
  if (existing?.type === 'custom')
    return String((existing.data as { text?: unknown } | undefined)?.text ?? '');
  // A chat that began before instructions existed keeps starting without them.
  const started = branch.some((entry) => entry.type === 'message');
  const text = started ? '' : (agent.projectInstructions ?? '').trim();
  agent.store.append({ type: 'custom', customType: PROJECT_INSTRUCTIONS_SNAPSHOT, data: { text } });
  return text;
}

export function renderInstructions(text: string): string {
  return text
    ? [
        '## Project instructions',
        '',
        'The user wrote these for every chat in this project. Follow them unless the user says otherwise in this chat.',
        '',
        text,
      ].join('\n')
    : '';
}

export function projectInstructionsFeature(): Feature {
  let section: string | undefined;
  return {
    name: 'project-instructions',
    async beforeAgentStart(agent) {
      if (agent.config.workspaceKind !== 'chat') return;
      section ??= renderInstructions(frozenInstructions(agent));
      return section
        ? {
            systemPrompt: [
              {
                id: 'project-instructions',
                title: 'Project instructions',
                source: 'node:project-instructions',
                frozen: true,
                text: section,
              },
            ],
          }
        : undefined;
    },
  };
}
