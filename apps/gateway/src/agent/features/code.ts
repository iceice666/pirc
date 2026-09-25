import type { Feature } from '../feature.js';
import { codeTool } from '../ptc/code-tool.js';

export function codeFeature(): Feature {
  return { name: 'code', tools: (agent) => [codeTool(agent)] };
}
