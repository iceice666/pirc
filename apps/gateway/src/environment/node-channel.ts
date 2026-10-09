import type { CentralLink } from './central-link.js';
import type { Environment, EnvironmentMessage } from './protocol.js';
import type { ArtifactTransfer } from './artifact-transfer.js';
import type { FreshWorkspaceMemory } from '../node/fresh-workspace-memory.js';
import { dispatchEnvironment } from './service.js';

/** Node half of the authenticated Environment subchannel. Central RPC completion
 * is independent of ordinary start/status/cancel traffic and has no new public port.
 */
export function nodeEnvironmentReceiver(options: {
  environment: Environment;
  central: CentralLink;
  artifacts?: ArtifactTransfer;
  workspace?: FreshWorkspaceMemory;
  send(message: EnvironmentMessage): Promise<void>;
}) {
  return async (message: EnvironmentMessage): Promise<void> => {
    if (message.type === 'workspace.snapshot' || message.type === 'workspace.append') {
      if (!options.workspace) throw new Error('Workspace memory service unavailable');
      if (message.type === 'workspace.snapshot') {
        const value = options.workspace.snapshot(message.binding);
        await options.send({
          version: 1,
          requestId: message.requestId,
          type: 'workspace.snapshot.result',
          binding: message.binding,
          repositoryKey: value.repositoryKey,
          items: JSON.parse(JSON.stringify(value.items)),
        });
      } else {
        const input = message.input as unknown as Parameters<FreshWorkspaceMemory['append']>[1];
        const item = await options.workspace.append(message.binding, input);
        await options.send({
          version: 1,
          requestId: message.requestId,
          type: 'workspace.append.result',
          binding: message.binding,
          item: JSON.parse(JSON.stringify(item)),
        });
      }
      return;
    }
    if (await options.central.receive(message)) return;
    await options.send(await dispatchEnvironment(options.environment, message, options.artifacts));
  };
}
