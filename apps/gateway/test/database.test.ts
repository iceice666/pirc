import { describe, expect, it } from 'vitest';
import { GatewayDatabase } from '../src/database.js';
import { payloadHash } from '../src/util.js';
import { testConfig } from './helpers.js';

describe('GatewayDatabase', () => {
  it('deduplicates commands, generations leases, and answers interactions once', () => {
    const config = testConfig();
    const db = new GatewayDatabase(config.databasePath);
    db.syncWorkspaces(config);
    const session = db.createSession('test', 'one', `${config.sessionsDir}/one`);
    const payload = { type: 'prompt', message: 'hi' };
    const hash = payloadHash(payload);
    expect(db.receiveCommand('c1', session.id, hash, payload).duplicate).toBe(false);
    expect(db.receiveCommand('c1', session.id, hash, payload).duplicate).toBe(true);
    expect(() =>
      db.receiveCommand('c1', session.id, payloadHash({ ...payload, message: 'other' }), {
        ...payload,
        message: 'other',
      }),
    ).toThrow(/different payload/);
    const first = db.acquireLease(session.id, 'a', false, 1000) as any;
    expect(() => db.acquireLease(session.id, 'b', false, 1000)).toThrow(/Another client/);
    const second = db.acquireLease(session.id, 'b', true, 1000) as any;
    expect(second.generation).toBe(first.generation + 1);
    expect(() => db.validateLease(session.id, 'a', first.generation)).toThrow(/superseded/);
    const epoch = db.incrementEpoch(session.id);
    const interaction = db.createInteraction(
      session.id,
      epoch,
      'rpc1',
      'confirm',
      {},
      Date.now() + 1000,
    );
    db.claimInteraction(interaction.id, session.id, epoch, { confirmed: true });
    expect(() =>
      db.claimInteraction(interaction.id, session.id, epoch, { confirmed: false }),
    ).toThrow(/no longer answerable/);
    db.close();
  });
  it('recovers unfinished work without replaying it', () => {
    const config = testConfig();
    const db = new GatewayDatabase(config.databasePath);
    db.syncWorkspaces(config);
    const session = db.createSession('test', 'one', `${config.sessionsDir}/one`);
    const run = db.createRun(session.id);
    db.updateRun(run, 'running');
    db.receiveCommand('c', session.id, 'h', {});
    db.updateCommand('c', 'dispatched');
    const epoch = db.incrementEpoch(session.id);
    db.createInteraction(session.id, epoch, 'rpc', 'input', {}, Date.now() + 1000);
    const recovered = db.recoverStartup();
    expect(recovered).toEqual({ interruptedRuns: 1, staleInteractions: 1, unknownCommands: 1 });
    expect(db.latestRun(session.id)?.status).toBe('interrupted');
    expect(db.getCommand('c').status).toBe('outcome_unknown');
    db.close();
  });
});
