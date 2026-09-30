#!/usr/bin/env bun
import { setExecutableRole } from '../self.js';
import { commandFor } from './common.js';

setExecutableRole('gateway');
const command = commandFor('pirc-gateway', ['oauth-worker']);
if (command === 'oauth-worker')
  await (await import('../backends/oauth-worker.js')).runOAuthWorker();
else await (await import('../daemon/main.js')).runGateway();
