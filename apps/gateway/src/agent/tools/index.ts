import { bashTool } from './bash.js';
import { editTool, findTool, grepTool, lsTool, readTool, writeTool } from './files.js';
import type { Tool } from './types.js';

export function builtinTools(): Tool[] {
  return [readTool, writeTool, editTool, bashTool, lsTool, findTool, grepTool];
}
