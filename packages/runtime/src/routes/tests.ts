import { Hono } from 'hono';

import { getServices } from '../services/service-registry.js';
import { discoverTestFiles, runTest, stopTest } from '../services/test-runner.js';
import type { HonoEnv } from '../types/hono-env.js';

export const testRoutes = new Hono<HonoEnv>();

// GET /api/tests/:projectId/files — discover test files
testRoutes.get('/:projectId/files', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');

  const project = await getServices().projects.getProject(projectId);
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  // Ownership check
  if (userId !== '__local__' && project.userId !== userId) {
    return c.json({ error: 'Access denied' }, 403);
  }

  const files = await discoverTestFiles(project.path);
  return c.json(files.map((path) => ({ path })));
});

// POST /api/tests/:projectId/run — run a test file
testRoutes.post('/:projectId/run', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');

  const project = await getServices().projects.getProject(projectId);
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  if (userId !== '__local__' && project.userId !== userId) {
    return c.json({ error: 'Access denied' }, 403);
  }

  const body = await c.req.json<{ file: string }>();
  if (!body.file) {
    return c.json({ error: 'Missing file parameter' }, 400);
  }

  const result = await runTest(projectId, project.path, body.file, userId);

  if ('error' in result) {
    return c.json({ error: result.error }, result.status as any);
  }

  return c.json({ runId: result.runId });
});

// POST /api/tests/:projectId/stop — stop a running test
testRoutes.post('/:projectId/stop', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');

  const project = await getServices().projects.getProject(projectId);
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  if (userId !== '__local__' && project.userId !== userId) {
    return c.json({ error: 'Access denied' }, 403);
  }

  await stopTest(projectId, userId);
  return c.json({ ok: true });
});
