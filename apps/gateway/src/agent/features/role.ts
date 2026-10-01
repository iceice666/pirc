/**
 * The role an agent runs in (roles.ts): its instructions go into the system
 * prompt. Teammates and subagents get the role from their parent; delegated
 * sessions from the gateway (`Agent.setRole`).
 */
import type { Feature } from '../feature.js';
import { renderRole } from '../roles.js';

export function roleFeature(): Feature {
  return {
    name: 'role',
    async beforeAgentStart(agent) {
      const section = agent.role ? renderRole(agent.role) : '';
      return section ? { systemPrompt: section } : undefined;
    },
  };
}
