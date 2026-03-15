/**
 * Pipeline CRUD routes for the central server.
 *
 * All pipeline data operations are handled natively using the server's DB.
 * Pipeline execution (review/fix runs) remains on the runner.
 */

import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import * as pipelineRepo from '../services/pipeline-repository.js';

export const pipelineRoutes = new Hono<ServerEnv>();

// GET /api/pipelines/project/:projectId
pipelineRoutes.get('/project/:projectId', async (c) => {
  const { projectId } = c.req.param();
  const rows = await pipelineRepo.getPipelinesByProject(projectId);
  return c.json(rows);
});

// GET /api/pipelines/:id
pipelineRoutes.get('/:id', async (c) => {
  const { id } = c.req.param();
  const pipeline = await pipelineRepo.getPipelineById(id);
  if (!pipeline) return c.json({ error: 'Pipeline not found' }, 404);
  return c.json(pipeline);
});

// POST /api/pipelines
pipelineRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json();

  if (!body.projectId || !body.name) {
    return c.json({ error: 'projectId and name are required' }, 400);
  }

  const id = await pipelineRepo.createPipeline({
    projectId: body.projectId,
    userId,
    name: body.name,
    reviewModel: body.reviewModel,
    fixModel: body.fixModel,
    maxIterations: body.maxIterations,
    precommitFixEnabled: body.precommitFixEnabled,
    precommitFixModel: body.precommitFixModel,
    precommitFixMaxIterations: body.precommitFixMaxIterations,
    reviewerPrompt: body.reviewerPrompt,
    correctorPrompt: body.correctorPrompt,
    precommitFixerPrompt: body.precommitFixerPrompt,
    commitMessagePrompt: body.commitMessagePrompt,
    testEnabled: body.testEnabled,
    testCommand: body.testCommand,
    testFixEnabled: body.testFixEnabled,
    testFixModel: body.testFixModel,
    testFixMaxIterations: body.testFixMaxIterations,
    testFixerPrompt: body.testFixerPrompt,
  });

  const pipeline = await pipelineRepo.getPipelineById(id);
  return c.json(pipeline, 201);
});

// PATCH /api/pipelines/:id
pipelineRoutes.patch('/:id', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  const existing = await pipelineRepo.getPipelineById(id);
  if (!existing) return c.json({ error: 'Pipeline not found' }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;
  if (body.reviewModel !== undefined) updates.reviewModel = body.reviewModel;
  if (body.fixModel !== undefined) updates.fixModel = body.fixModel;
  if (body.maxIterations !== undefined) updates.maxIterations = body.maxIterations;
  if (body.precommitFixEnabled !== undefined)
    updates.precommitFixEnabled = body.precommitFixEnabled ? 1 : 0;
  if (body.precommitFixModel !== undefined) updates.precommitFixModel = body.precommitFixModel;
  if (body.precommitFixMaxIterations !== undefined)
    updates.precommitFixMaxIterations = body.precommitFixMaxIterations;
  if (body.reviewerPrompt !== undefined) updates.reviewerPrompt = body.reviewerPrompt || null;
  if (body.correctorPrompt !== undefined) updates.correctorPrompt = body.correctorPrompt || null;
  if (body.precommitFixerPrompt !== undefined)
    updates.precommitFixerPrompt = body.precommitFixerPrompt || null;
  if (body.commitMessagePrompt !== undefined)
    updates.commitMessagePrompt = body.commitMessagePrompt || null;
  if (body.testEnabled !== undefined) updates.testEnabled = body.testEnabled ? 1 : 0;
  if (body.testCommand !== undefined) updates.testCommand = body.testCommand || null;
  if (body.testFixEnabled !== undefined) updates.testFixEnabled = body.testFixEnabled ? 1 : 0;
  if (body.testFixModel !== undefined) updates.testFixModel = body.testFixModel;
  if (body.testFixMaxIterations !== undefined)
    updates.testFixMaxIterations = body.testFixMaxIterations;
  if (body.testFixerPrompt !== undefined) updates.testFixerPrompt = body.testFixerPrompt || null;

  await pipelineRepo.updatePipeline(id, updates);
  return c.json(await pipelineRepo.getPipelineById(id));
});

// DELETE /api/pipelines/:id
pipelineRoutes.delete('/:id', async (c) => {
  const { id } = c.req.param();
  const existing = await pipelineRepo.getPipelineById(id);
  if (!existing) return c.json({ error: 'Pipeline not found' }, 404);

  await pipelineRepo.deletePipeline(id);
  return c.json({ ok: true });
});

// GET /api/pipelines/runs/thread/:threadId
pipelineRoutes.get('/runs/thread/:threadId', async (c) => {
  const { threadId } = c.req.param();
  const runs = await pipelineRepo.getRunsForThread(threadId);
  return c.json(runs);
});
