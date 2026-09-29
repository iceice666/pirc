/**
 * Schedules in the web and Android apps (plans/cron.md). The user's own
 * changes need no approval; only an agent's do (daemon/schedules.ts).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GatewayDatabase } from '../database.js';
import { parse } from '../util.js';
import { NOTIFY_LEVELS, PROMPT_MAX_CHARS, THINKING_LEVELS, type Schedules } from './schedules.js';

const idParams = z.object({ id: z.string().min(1).max(40) });
const runParams = idParams.extend({ runId: z.string().min(1).max(40) });
const model = z.object({ provider: z.string().min(1), id: z.string().min(1) }).strict();
const fields = {
  title: z.string().max(300).optional(),
  prompt: z
    .string()
    .max(PROMPT_MAX_CHARS * 2)
    .optional(),
  cron: z.string().max(200).optional(),
  at: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
  model: model.nullable().optional(),
  thinking: z.enum(THINKING_LEVELS).nullable().optional(),
  notify: z.enum(NOTIFY_LEVELS).optional(),
};
const createBody = z
  .object({
    workspaceId: z.string().min(1).max(300),
    ...fields,
    prompt: z.string().max(PROMPT_MAX_CHARS * 2),
  })
  .strict();
const updateBody = z
  .object({
    workspaceId: z.string().min(1).max(300).optional(),
    ...fields,
    status: z.enum(['active', 'paused']).optional(),
  })
  .strict();
const runBody = z.object({ runId: z.string().min(1).max(40).optional() }).strict();

export function registerScheduleRoutes(
  app: FastifyInstance,
  deps: { db: GatewayDatabase; schedules: Schedules; defaultTimezone: string },
): void {
  const { db, schedules } = deps;
  const workspace = (ref: string) => db.getWorkspace(ref);

  app.get('/api/schedules', async (request) => ({
    schedules: schedules.list(request.identity!.user).map((item) => schedules.view(item)),
    timezone: deps.defaultTimezone,
  }));

  app.post('/api/schedules', async (request, reply) => {
    const { workspaceId, ...input } = parse(createBody, request.body);
    const schedule = schedules.create(
      request.identity!.user,
      { ...input, workspace: workspaceId },
      workspace,
    );
    return reply.status(201).send({ schedule: schedules.view(schedule) });
  });

  app.get('/api/schedules/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const user = request.identity!.user;
    return {
      schedule: schedules.view(schedules.get(user, id)),
      runs: schedules.runs(user, id).map((run) => schedules.runView(run)),
    };
  });

  app.patch('/api/schedules/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const { workspaceId, status, ...input } = parse(updateBody, request.body);
    const user = request.identity!.user;
    let schedule = schedules.get(user, id);
    if (workspaceId !== undefined || Object.values(input).some((value) => value !== undefined))
      schedule = schedules.update(
        user,
        id,
        { ...input, ...(workspaceId ? { workspace: workspaceId } : {}) },
        workspace,
      );
    if (status === 'paused') schedule = schedules.pause(user, id);
    else if (status === 'active') schedule = schedules.resume(user, id);
    return { schedule: schedules.view(schedule) };
  });

  app.delete('/api/schedules/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    schedules.delete(request.identity!.user, id);
    return reply.status(204).send();
  });

  /** Run it now, or allow a missed run (`runId`). */
  app.post('/api/schedules/:id/run', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const { runId } = parse(runBody, request.body ?? {});
    const run = schedules.runNow(request.identity!.user, id, runId);
    return reply.status(202).send({ run: schedules.runView(run) });
  });

  app.post('/api/schedules/:id/runs/:runId/dismiss', async (request) => {
    const { id, runId } = parse(runParams, request.params);
    return { run: schedules.runView(schedules.dismiss(request.identity!.user, id, runId)) };
  });
}
