import { parentChannel } from './features/team/channel.js';
import { randomUUID } from 'node:crypto';
import type { Agent } from './agent.js';
import type { ImageContent } from './messages.js';
import type { DialogOptions, UiApi } from './tools/types.js';

type Json = Record<string, any>;

/**
 * Bridges UI requests to the RPC peer via `extension_ui_request` /
 * `extension_ui_response`. Dialogs are serialized so only one is open.
 */
export class RpcUi implements UiApi {
  private readonly pending = new Map<string, (response: Json) => void>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly write: (value: unknown) => void) {}

  private dialog(request: Json, opts: DialogOptions = {}): Promise<Json> {
    const { signal, timeoutMs } = opts;
    const run = () =>
      new Promise<Json>((resolve) => {
        if (signal?.aborted) return resolve({ cancelled: true });
        const id = randomUUID();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          this.pending.get(id)?.({ cancelled: true });
          // Tell the client the dialog is gone so it can close its card.
          this.write({
            type: 'extension_ui_request',
            id: randomUUID(),
            method: 'cancel',
            targetId: id,
          });
        };
        this.pending.set(id, (response) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          this.pending.delete(id);
          resolve(response);
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        if (timeoutMs)
          timer = setTimeout(
            () => this.pending.get(id)?.({ cancelled: true, timedOut: true }),
            timeoutMs,
          );
        this.write({
          type: 'extension_ui_request',
          id,
          ...request,
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        });
      });
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  respond(response: Json): void {
    if (typeof response.id === 'string') this.pending.get(response.id)?.(response);
  }

  cancelAll(): void {
    for (const resolve of [...this.pending.values()]) resolve({ cancelled: true });
  }

  async select(title: string, options: string[], opts?: DialogOptions) {
    const response = await this.dialog({ method: 'select', title, options }, opts);
    return response.cancelled
      ? undefined
      : typeof response.value === 'string'
        ? response.value
        : undefined;
  }
  async choose(
    title: string,
    options: Array<{ label: string; description?: string }>,
    multiple: boolean,
    opts?: DialogOptions,
  ) {
    const response = await this.dialog(
      {
        method: 'select',
        title,
        options: options.map((option) => option.label),
        optionDescriptions: options.map((option) => option.description ?? ''),
        ...(multiple ? { multiple: true } : {}),
      },
      opts,
    );
    if (response.cancelled) return undefined;
    if (Array.isArray(response.values))
      return response.values.filter((value: unknown): value is string => typeof value === 'string');
    return typeof response.value === 'string' ? [response.value] : undefined;
  }
  async confirm(title: string, message: string, opts?: DialogOptions) {
    const response = await this.dialog({ method: 'confirm', title, message }, opts);
    return response.cancelled ? undefined : Boolean(response.confirmed);
  }
  async input(title: string, placeholder?: string, opts?: DialogOptions) {
    const response = await this.dialog({ method: 'input', title, placeholder }, opts);
    return response.cancelled
      ? undefined
      : typeof response.value === 'string'
        ? response.value
        : undefined;
  }
  async editor(title: string, prefill?: string, opts?: DialogOptions) {
    const response = await this.dialog({ method: 'editor', title, prefill }, opts);
    return response.cancelled
      ? undefined
      : typeof response.value === 'string'
        ? response.value
        : undefined;
  }
  notify(message: string, level: 'info' | 'warning' | 'error' = 'info') {
    this.write({
      type: 'extension_ui_request',
      id: randomUUID(),
      method: 'notify',
      message,
      notifyType: level,
    });
  }
  setStatus(key: string, text?: string) {
    this.write({
      type: 'extension_ui_request',
      id: randomUUID(),
      method: 'setStatus',
      statusKey: key,
      statusText: text,
    });
  }
  setWidget(key: string, lines?: string[]) {
    this.write({
      type: 'extension_ui_request',
      id: randomUUID(),
      method: 'setWidget',
      widgetKey: key,
      widgetLines: lines,
      widgetPlacement: 'aboveEditor',
    });
  }
}

function images(command: Json): ImageContent[] | undefined {
  if (!Array.isArray(command.images)) return undefined;
  return command.images
    .filter((image: Json) => image?.type === 'image' && typeof image.data === 'string')
    .map((image: Json) => ({
      type: 'image',
      data: image.data,
      mimeType: image.mimeType ?? 'image/png',
    }));
}

/** Execute one RPC command. Returns response data or throws. */
export async function handleCommand(
  agent: Agent,
  command: Json,
  extra: Record<string, (agent: Agent, command: Json) => Promise<unknown>> = {},
): Promise<unknown> {
  const message = typeof command.message === 'string' ? command.message : '';
  switch (command.type) {
    case 'prompt':
      if (agent.isRunning) {
        if (command.streamingBehavior === 'followUp') agent.followUp(message, images(command));
        else if (command.streamingBehavior === 'steer') agent.steer(message, images(command));
        else throw new Error('Agent is already running; use steer or follow_up');
      } else agent.prompt(message, images(command));
      return undefined;
    case 'steer':
      agent.steer(message, images(command));
      return undefined;
    case 'follow_up':
      agent.followUp(message, images(command));
      return undefined;
    case 'abort':
      agent.abort();
      await agent.idle();
      return undefined;
    case 'clear_queue':
      return agent.clearQueue();
    case 'get_state':
      return agent.state();
    case 'get_messages':
      return { messages: agent.store.allMessages() };
    case 'compact':
      return agent.compact(
        typeof command.customInstructions === 'string' ? command.customInstructions : undefined,
      );
    case 'get_commands':
      return { commands: agent.commandList() };
    case 'get_available_models':
      return { models: agent.availableModels() };
    case 'set_model':
      agent.setModel(String(command.provider), String(command.modelId));
      return undefined;
    case 'set_thinking_level':
      agent.setThinking(String(command.level));
      return undefined;
    case 'set_session_name':
      agent.setName(String(command.name ?? ''));
      return undefined;
    default: {
      const handler = extra[command.type];
      if (handler) return handler(agent, command);
      throw new Error(`Unsupported command: ${command.type}`);
    }
  }
}

/** Serve JSONL RPC over stdin/stdout until stdin closes. */
export async function serveRpc(
  agent: Agent,
  ui: RpcUi,
  write: (value: unknown) => void,
  extra: Record<string, (agent: Agent, command: Json) => Promise<unknown>> = {},
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let command: Json;
    try {
      command = JSON.parse(line);
    } catch {
      write({ type: 'response', command: 'parse', success: false, error: 'Invalid JSON' });
      return;
    }
    if (command.type === 'extension_ui_response') return ui.respond(command);
    if (command.type === 'team_result') return parentChannel().receive(command);
    void handleCommand(agent, command, extra).then(
      (data) =>
        write({
          type: 'response',
          id: command.id,
          command: command.type,
          success: true,
          ...(data === undefined ? {} : { data }),
        }),
      (error) =>
        write({
          type: 'response',
          id: command.id,
          command: command.type,
          success: false,
          error: (error as Error).message,
        }),
    );
  };
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer) handleLine(buffer);
}
