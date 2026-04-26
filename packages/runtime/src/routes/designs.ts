/**
 * Design routes for the runtime (runner).
 *
 * Handles filesystem operations: creating/deleting design directories.
 * DB CRUD is handled by the server package.
 */

import { Hono } from 'hono';

import {
  createDesignDirectory,
  deleteDesignDirectory,
  validateDesignId,
} from '../services/design-service.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireProject } from '../utils/route-helpers.js';

// ── Project-scoped routes (mounted at /api/projects) ────────────

export const designProjectRoutes = new Hono<HonoEnv>();

// POST /api/projects/:id/designs/directory — create design directory on disk
designProjectRoutes.post('/:id/designs/directory', async (c) => {
  const projectResult = await requireProject(
    c.req.param('id'),
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const { designId } = await c.req.json<{ designId: string }>();
  const idResult = validateDesignId(designId);
  if (idResult.isErr()) return c.json({ error: idResult.error }, 400);

  const dirResult = await createDesignDirectory(project.path, designId);
  if (dirResult.isErr()) return c.json({ error: dirResult.error }, 500);

  return c.json({ ok: true, path: dirResult.value });
});

// DELETE /api/projects/:id/designs/:designId/directory — remove design directory
designProjectRoutes.delete('/:id/designs/:designId/directory', async (c) => {
  const projectResult = await requireProject(
    c.req.param('id'),
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const designId = c.req.param('designId');
  const idResult = validateDesignId(designId);
  if (idResult.isErr()) return c.json({ error: idResult.error }, 400);

  const result = await deleteDesignDirectory(project.path, designId);
  if (result.isErr()) return c.json({ error: result.error }, 500);

  return c.json({ ok: true });
});
