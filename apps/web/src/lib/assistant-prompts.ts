import { request } from './http';

export interface AssistantPrompt {
  text: string;
  writable: boolean;
  reason?: 'nix-store' | 'symlink' | 'permission';
  path: string;
  maxChars: number;
}
export type PromptName = 'soul' | 'chat';
export interface AssistantBinding {
  nodeId: string | null;
  online: boolean;
}
export type AssistantPrompts = Record<PromptName, AssistantPrompt> & { nodeId: string };
export const assistantPromptsApi = {
  get: () => request<AssistantPrompts>('/api/assistant/prompts'),
  update: (name: PromptName, text: string, nodeId: string) =>
    request<{ prompt: AssistantPrompt }>(`/api/assistant/prompts/${name}`, {
      method: 'PUT',
      body: JSON.stringify({ text, nodeId }),
    }),
  binding: () => request<AssistantBinding>('/api/assistant/node'),
  release: (nodeId: string) =>
    request<AssistantBinding>('/api/assistant/node/release', {
      method: 'POST',
      body: JSON.stringify({ nodeId }),
    }),
};
