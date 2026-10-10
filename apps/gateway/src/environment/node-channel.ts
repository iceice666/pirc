import type { CentralLink } from './central-link.js';
import type { Environment, EnvironmentMessage } from './protocol.js';
import type { ArtifactTransfer } from './artifact-transfer.js';
import type { FreshWorkspaceMemory } from '../node/fresh-workspace-memory.js';
import { EnvironmentCodeError, dispatchEnvironment, environmentErrorReply } from './service.js';

type WorkspaceRequest = Extract<
  EnvironmentMessage,
  { type: 'workspace.snapshot' | 'workspace.append' | 'workspace.retire' }
>;

/** Node half of the authenticated Environment subchannel. Central RPC completion
 * is independent of ordinary start/status/cancel traffic and has no new public port.
 * Request failures are answered with a correlated `environment.error`; only protocol
 * violations and send failures reject, which closes the link.
 */
export function nodeEnvironmentReceiver(options: {
  environment: Environment;
  central: CentralLink;
  artifacts?: ArtifactTransfer;
  workspace?: FreshWorkspaceMemory;
  send(message: EnvironmentMessage): Promise<void>;
}) {
  const workspaceRequest = async (message: WorkspaceRequest): Promise<EnvironmentMessage> => {
    if (!options.workspace)
      throw new EnvironmentCodeError('unavailable_sandbox', 'Workspace memory service unavailable');
    if (message.type === 'workspace.snapshot') {
      const value = options.workspace.snapshot(message.binding);
      return {
        version: 1,
        requestId: message.requestId,
        type: 'workspace.snapshot.result',
        binding: message.binding,
        repositoryKey: value.repositoryKey,
        items: JSON.parse(JSON.stringify(value.items)),
        forgotten: JSON.parse(JSON.stringify(value.forgotten)),
      };
    }
    if (message.type === 'workspace.retire') {
      const result = await options.workspace.retire(
        message.binding,
        message.input as unknown as Parameters<FreshWorkspaceMemory['retire']>[1],
      );
      return {
        version: 1,
        requestId: message.requestId,
        type: 'workspace.retire.result',
        binding: message.binding,
        ...result,
      };
    }
    const input = message.input as unknown as Parameters<FreshWorkspaceMemory['append']>[1];
    const item = await options.workspace.append(message.binding, input);
    return {
      version: 1,
      requestId: message.requestId,
      type: 'workspace.append.result',
      binding: message.binding,
      item: JSON.parse(JSON.stringify(item)),
    };
  };
  return async (message: EnvironmentMessage): Promise<void> => {
    if (
      message.type === 'workspace.snapshot' ||
      message.type === 'workspace.append' ||
      message.type === 'workspace.retire'
    ) {
      let reply: EnvironmentMessage;
      try {
        reply = await workspaceRequest(message);
      } catch (error) {
        reply = environmentErrorReply(message.requestId, error);
      }
      await options.send(reply);
      return;
    }
    if (await options.central.receive(message)) return;
    // dispatchEnvironment answers ordinary refusals; it throws only protocol violations.
    await options.send(await dispatchEnvironment(options.environment, message, options.artifacts));
  };
}
