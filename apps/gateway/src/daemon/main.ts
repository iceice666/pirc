import { loadDaemonConfig } from '../config.js';
import { buildDaemonApp } from './app.js';

export async function runGateway(): Promise<void> {
  const config = loadDaemonConfig();
  const { app } = await buildDaemonApp(config);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}
