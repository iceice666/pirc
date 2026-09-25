import type { Feature } from '../feature.js';

/** `/compact [instructions]` — summarize older context now. */
export function compactFeature(): Feature {
  return {
    name: 'compact',
    commands: {
      compact: {
        description: 'Summarize older context now (/compact [focus instructions])',
        async run(agent, args) {
          const result = await agent.compact(args || undefined);
          agent.ui.notify(
            `Compacted ${result.tokensBefore?.toLocaleString() ?? '?'} tokens of context.`,
            'info',
          );
        },
      },
    },
  };
}
