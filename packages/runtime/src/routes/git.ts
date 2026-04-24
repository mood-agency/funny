/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: GitService
 */

import { Hono } from 'hono';

import type { HonoEnv } from '../types/hono-env.js';
import { commitRoutes } from './git/commit.js';
import { diffRoutes } from './git/diff.js';
import { invalidateGitStatusCacheByProject } from './git/helpers.js';
import { logRoutes } from './git/log.js';
import { remoteRoutes } from './git/remote.js';
import { stageRoutes } from './git/stage.js';
import { stashRoutes } from './git/stash.js';
import { statusRoutes } from './git/status.js';
import { workflowRoutes } from './git/workflow.js';

export { invalidateGitStatusCacheByProject };

export const gitRoutes = new Hono<HonoEnv>();

gitRoutes.route('/', statusRoutes);
gitRoutes.route('/', diffRoutes);
gitRoutes.route('/', logRoutes);
gitRoutes.route('/', stashRoutes);
gitRoutes.route('/', stageRoutes);
gitRoutes.route('/', commitRoutes);
gitRoutes.route('/', remoteRoutes);
gitRoutes.route('/', workflowRoutes);
