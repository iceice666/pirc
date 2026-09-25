import type { Feature } from '../feature.js';
import { askQuestionFeature } from './ask-question.js';
import { backgroundFeature } from './background/index.js';
import { teamFeature } from './team/index.js';
import { codeFeature } from './code.js';
import { compactFeature } from './compact.js';
import { memoryFeature } from './memory/index.js';
import { todoFeature } from './todo/index.js';

export function builtinFeatures(): Feature[] {
  return [
    askQuestionFeature(),
    todoFeature(),
    codeFeature(),
    compactFeature(),
    memoryFeature(),
    backgroundFeature(),
    teamFeature(),
  ];
}
