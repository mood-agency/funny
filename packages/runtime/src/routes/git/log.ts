/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import {
  getLog,
  getUnpushedHashes,
  getCommitBody,
  getCommitFiles,
  getCommitFileDiff,
} from '@funny/core/git';
import { badRequest } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { requestSpan } from '../../middleware/tracing.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThread, requireThreadCwd } from '../../utils/route-helpers.js';
import { requireProjectCwd } from './helpers.js';

export const logRoutes = new Hono<HonoEnv>();

// GET /api/git/project/:projectId/log
logRoutes.get('/project/:projectId/log', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 20, 200) : 50;
  const skipRaw = c.req.query('skip');
  const skip = skipRaw ? Math.max(parseInt(skipRaw, 10) || 0, 0) : 0;
  const cwd = cwdResult.value;
  const projectId = c.req.param('projectId');
  const [result, unpushedResult] = await Promise.all([
    (async () => {
      const span = requestSpan(c, 'git.log', { projectId });
      const r = await getLog(cwd, limit + 1, undefined, skip);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
    (async () => {
      const span = requestSpan(c, 'git.unpushed_hashes', { projectId });
      const r = await getUnpushedHashes(cwd);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
  ]);
  if (result.isErr()) return resultToResponse(c, result);
  const entries = result.value;
  const hasMore = entries.length > limit;
  const unpushedSet = unpushedResult.isOk() ? unpushedResult.value : new Set<string>();
  const trimmed = hasMore ? entries.slice(0, limit) : entries;
  const unpushedHashes = trimmed.filter((e) => unpushedSet.has(e.hash)).map((e) => e.hash);
  return c.json({ entries: trimmed, hasMore, unpushedHashes });
});

// GET /api/git/project/:projectId/commit/:hash/files
logRoutes.get('/project/:projectId/commit/:hash/files', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const span = requestSpan(c, 'git.commit_files', {
    projectId: c.req.param('projectId'),
    hash: c.req.param('hash'),
  });
  const result = await getCommitFiles(cwdResult.value, c.req.param('hash'));
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ files: result.value });
});

// GET /api/git/project/:projectId/commit/:hash/diff
logRoutes.get('/project/:projectId/commit/:hash/diff', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const span = requestSpan(c, 'git.commit_diff', {
    projectId: c.req.param('projectId'),
    hash: c.req.param('hash'),
    path: filePath,
  });
  const result = await getCommitFileDiff(cwdResult.value, c.req.param('hash'), filePath);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// GET /api/git/project/:projectId/commit/:hash/body
logRoutes.get('/project/:projectId/commit/:hash/body', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const span = requestSpan(c, 'git.commit_body', {
    projectId: c.req.param('projectId'),
    hash: c.req.param('hash'),
  });
  const result = await getCommitBody(cwdResult.value, c.req.param('hash'));
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ body: result.value });
});

// GET /api/git/:threadId/log
logRoutes.get('/:threadId/log', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadId = c.req.param('threadId');
  const threadResult = await requireThread(threadId, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 20, 200) : 50;
  const skipRaw = c.req.query('skip');
  const skip = skipRaw ? Math.max(parseInt(skipRaw, 10) || 0, 0) : 0;

  const all = c.req.query('all') === 'true';
  const baseBranch = all ? undefined : thread.baseBranch;
  const cwd = cwdResult.value;
  const [result, unpushedResult] = await Promise.all([
    (async () => {
      const span = requestSpan(c, 'git.log', { threadId });
      const r = await getLog(cwd, limit + 1, baseBranch, skip);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
    (async () => {
      const span = requestSpan(c, 'git.unpushed_hashes', { threadId });
      const r = await getUnpushedHashes(cwd);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
  ]);
  if (result.isErr()) return resultToResponse(c, result);
  const entries = result.value;
  const hasMore = entries.length > limit;
  const unpushedSet = unpushedResult.isOk() ? unpushedResult.value : new Set<string>();
  const trimmed = hasMore ? entries.slice(0, limit) : entries;
  const unpushedHashes = trimmed.filter((e) => unpushedSet.has(e.hash)).map((e) => e.hash);
  return c.json({ entries: trimmed, hasMore, unpushedHashes });
});

// GET /api/git/:threadId/commit/:hash/files
logRoutes.get('/:threadId/commit/:hash/files', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const span = requestSpan(c, 'git.commit_files', {
    threadId: c.req.param('threadId'),
    hash: c.req.param('hash'),
  });
  const result = await getCommitFiles(cwdResult.value, c.req.param('hash'));
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ files: result.value });
});

// GET /api/git/:threadId/commit/:hash/diff
logRoutes.get('/:threadId/commit/:hash/diff', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const span = requestSpan(c, 'git.commit_diff', {
    threadId: c.req.param('threadId'),
    hash: c.req.param('hash'),
    path: filePath,
  });
  const result = await getCommitFileDiff(cwdResult.value, c.req.param('hash'), filePath);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// GET /api/git/:threadId/commit/:hash/body
logRoutes.get('/:threadId/commit/:hash/body', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const span = requestSpan(c, 'git.commit_body', {
    threadId: c.req.param('threadId'),
    hash: c.req.param('hash'),
  });
  const result = await getCommitBody(cwdResult.value, c.req.param('hash'));
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ body: result.value });
});
