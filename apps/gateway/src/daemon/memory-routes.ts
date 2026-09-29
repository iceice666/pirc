/**
 * The assistant's memory in the web app (Settings → Memory): the user reviews
 * USER entries and MEMORY notes, approves or rejects the assistant's USER
 * proposals, restores earlier versions and forgets entries. Device tokens may
 * use these routes too. Every change answers with the whole view.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { GatewayDatabase } from '../database.js';
import { parse } from '../util.js';
import type { MemoryStore } from './memory.js';

const idParams = z.object({ id: z.string().min(1).max(40) });
const approveBody = z.object({ targetRevision: z.number().int().positive().optional() }).strict();
const restoreBody = z.object({ revision: z.number().int().positive().optional() }).strict();

export function registerMemoryRoutes(
  app: FastifyInstance,
  deps: { db: GatewayDatabase; memory: MemoryStore; memoryChanged(user: string): void },
): void {
  const { db, memory, memoryChanged } = deps;

  /** Everything the page shows, with the names of the chats it refers to. */
  const view = (user: string) => {
    const entries = memory.entries(user);
    const proposals = memory.proposals(user, 'pending').map((proposal) => {
      const target = proposal.targetId
        ? entries.find((entry) => entry.id === proposal.targetId)
        : undefined;
      return {
        ...proposal,
        target: target
          ? { id: target.id, content: target.content, revision: target.revision }
          : null,
      };
    });
    const sessions: Record<string, string> = {};
    for (const sessionId of new Set(
      [
        ...entries.map((entry) => entry.sources.sessionId),
        ...proposals.map((p) => p.sessionId),
      ].filter((value): value is string => !!value),
    ))
      try {
        const session = db.getSession(sessionId);
        if (session.ownerUser === user) sessions[sessionId] = session.name;
      } catch {
        /* the chat is gone; its id is still shown */
      }
    return {
      usage: memory.usage(user),
      user: entries.filter((entry) => entry.kind === 'user' && entry.status === 'active'),
      notes: entries.filter((entry) => entry.kind === 'note' && entry.status === 'active'),
      removed: entries.filter((entry) => entry.status === 'removed'),
      proposals,
      sessions,
    };
  };

  app.register(async (scope) => {
    scope.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });
    const owner = (request: FastifyRequest) => request.identity!.user;
    /** Run a change, tell the user's open clients, and answer with the new view. */
    const change = (request: FastifyRequest, apply: (user: string) => unknown) => {
      const user = owner(request);
      apply(user);
      memoryChanged(user);
      return view(user);
    };

    scope.get('/api/memory', async (request) => view(owner(request)));
    scope.get('/api/memory/entries/:id/history', async (request) => ({
      versions: memory.history(owner(request), parse(idParams, request.params).id),
    }));
    scope.post('/api/memory/proposals/:id/approve', async (request) => {
      const { id } = parse(idParams, request.params);
      const { targetRevision } = parse(approveBody, request.body ?? {});
      return change(request, (user) => memory.approve(user, id, targetRevision));
    });
    scope.post('/api/memory/proposals/:id/reject', async (request) => {
      const { id } = parse(idParams, request.params);
      return change(request, (user) => memory.reject(user, id));
    });
    scope.post('/api/memory/entries/:id/forget', async (request) => {
      const { id } = parse(idParams, request.params);
      return change(request, (user) => memory.forget(user, id));
    });
    scope.post('/api/memory/entries/:id/restore', async (request) => {
      const { id } = parse(idParams, request.params);
      const { revision } = parse(restoreBody, request.body ?? {});
      return change(request, (user) => memory.restore(user, id, revision));
    });
  });
}
