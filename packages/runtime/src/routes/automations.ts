/**
 * Automation routes for the runtime.
 *
 * Only exposes operations that require runtime-side resources (agent execution).
 * CRUD is handled by the server package.
 */

import { Hono } from 'hono';

import { log } from '../lib/logger.js';
import { getServices } from '../services/service-registry.js';
import type { HonoEnv } from '../types/hono-env.js';

export const automationRoutes = new Hono<HonoEnv>();

// POST /api/automations/:id/trigger — manually trigger an automation run
automationRoutes.post('/:id/trigger', async (c) => {
  const automationId = c.req.param('id');
  const automation = await getServices().automations.getAutomation(automationId);
  if (!automation) {
    return c.json({ error: 'Automation not found' }, 404);
  }

  const userId = c.get('userId');
  const organizationId = c.get('organizationId');
  if (automation.userId !== userId) {
    const isTeam = organizationId
      ? await getServices().projects.isProjectInOrg(automation.projectId, organizationId)
      : false;
    if (!isTeam) {
      log.warn('Blocked cross-user automation trigger', {
        namespace: 'automations',
        automationId,
        automationOwner: automation.userId,
        requester: userId,
      });
      return c.json({ error: 'Automation not found' }, 404);
    }
  }

  const { triggerAutomationRun } = await import('../services/automation-scheduler.js');
  void triggerAutomationRun(automation);

  return c.json({ ok: true });
});
