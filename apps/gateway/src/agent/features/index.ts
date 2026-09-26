import type { Feature } from '../feature.js';
import { askQuestionFeature } from './ask-question.js';
import { backgroundFeature } from './background/index.js';
import { teamFeature } from './team/index.js';
import { codeFeature } from './code.js';
import { compactFeature } from './compact.js';
import { goalFeature } from './goal/index.js';
import { memoryFeature } from './memory/index.js';
import { titleFeature } from './title.js';
import { todoFeature } from './todo/index.js';

export function builtinFeatures(): Feature[] {
  return [
    titleFeature(),
    askQuestionFeature(),
    todoFeature(),
    codeFeature(),
    compactFeature(),
    memoryFeature(),
    backgroundFeature(),
    teamFeature(),
    // Last: its settle hook starts the next round after the others had their turn.
    goalFeature(),
  ];
}
