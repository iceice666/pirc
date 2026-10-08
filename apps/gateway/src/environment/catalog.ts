import type { Tool } from '../agent/tools/types.js';
import { descriptorSchema, type Descriptor } from './protocol.js';

type Metadata = Pick<
  Descriptor['capabilityCatalog'][number],
  'placement' | 'effects' | 'concurrency' | 'approval'
>;
const nodeRead = ['read', 'ls', 'find', 'grep'];
const nodeWrite = ['write', 'edit', 'bash', 'background_task'];
const browser = [
  'web_fetch',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press',
  'browser_wait_for',
  'browser_screenshot',
  'browser_tabs',
  'browser_handoff',
  'browser_record',
];
const gatewayRead = [
  'web_search',
  'memory_search',
  'delegation_status',
  'get_goal',
  'recall',
  'agent_list',
  'agent_inbox',
  'agent_wait',
  'board_read',
  'task_list',
  'task_get',
];
const gatewayWrite = [
  'memory_note',
  'memory_propose_user',
  'delegate',
  'schedule',
  'ask_user_question',
  'todo',
  'create_goal',
  'update_goal',
  'agent_send',
  'agent_ask',
  'agent_reply',
  'agent_spawn',
  'agent_stop',
  'subagent',
  'board_post',
  'task_create',
  'task_update',
];

/** Explicit ownership inventory. New registrations must be classified before publication. */
export function capabilityMetadata(name: string): Metadata {
  if (nodeRead.includes(name))
    return { placement: 'node', effects: 'read', concurrency: 'read', approval: 'policy' };
  if (nodeWrite.includes(name))
    return { placement: 'node', effects: 'write', concurrency: 'write', approval: 'policy' };
  if (browser.includes(name))
    return { placement: 'node', effects: 'external', concurrency: 'exclusive', approval: 'policy' };
  if (['sandbox_allow_domains', 'unsandboxed_bash'].includes(name))
    return { placement: 'node', effects: 'external', concurrency: 'exclusive', approval: 'always' };
  if (gatewayRead.includes(name))
    return { placement: 'gateway', effects: 'read', concurrency: 'read', approval: 'policy' };
  if (gatewayWrite.includes(name))
    return {
      placement: 'gateway',
      effects: 'external',
      concurrency: 'exclusive',
      approval: 'policy',
    };
  throw new Error(`Missing capability ownership: ${name}`);
}

export function catalogEntry(
  tool: Tool,
  hookRevision: string,
): Descriptor['capabilityCatalog'][number] {
  if (!tool.resultSchema) throw new Error(`Missing result schema: ${tool.name}`);
  return descriptorSchema.innerType().shape.capabilityCatalog.element.parse({
    name: tool.name,
    argumentSchema: tool.parameters,
    resultSchema: tool.resultSchema,
    ...capabilityMetadata(tool.name),
    hookRevision,
  });
}
