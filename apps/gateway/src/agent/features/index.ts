import type { Feature } from '../feature.js';
import { askQuestionFeature } from './ask-question.js';
import { assistantFeature } from './assistant/index.js';
import { backgroundFeature } from './background/index.js';
import { browserFeature } from './browser.js';
import { teamFeature } from './team/index.js';
import { compactFeature } from './compact.js';
import { goalFeature } from './goal/index.js';
import { memoryFeature } from './memory/index.js';
import { projectInstructionsFeature } from './project-instructions.js';
import { roleFeature } from './role.js';
import { skillsFeature } from './skills.js';
import { titleFeature } from './title.js';
import { schedulesFeature } from './schedules.js';
import { todoFeature } from './todo/index.js';
import { webSearchFeature } from './web-search.js';
import { sandboxFeature } from './sandbox.js';

export function builtinFeatures(): Feature[] {
  return [
    titleFeature(),
    askQuestionFeature(),
    todoFeature(),
    compactFeature(),
    // Chat sessions only: the project's instructions, before USER/MEMORY.
    projectInstructionsFeature(),
    // Agents started in a role: the role's instructions.
    roleFeature(),
    memoryFeature(),
    // Chat sessions only: the user's memory, held by the gateway.
    assistantFeature(),
    skillsFeature(),
    // Node agents with a browser only (PIRC_BROWSER=1).
    browserFeature(),
    // Node agents with a gateway only; the gateway holds the search key.
    webSearchFeature(),
    // Node agents with a gateway only; the gateway runs the schedules.
    schedulesFeature(),
    // Node agents inside the node's OS sandbox only (PIRC_SANDBOX=srt).
    sandboxFeature(),
    backgroundFeature(),
    teamFeature(),
    // Last: its settle hook starts the next round after the others had their turn.
    goalFeature(),
  ];
}
