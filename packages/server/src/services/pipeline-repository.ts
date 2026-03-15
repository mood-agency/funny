/**
 * Pipeline CRUD + run tracking backed by the server's database.
 * Pure data operations only — pipeline execution lives in the runtime.
 */

import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import { pipelines, pipelineRuns } from '../db/schema.js';

// ── Pipeline CRUD ────────────────────────────────────────────

export async function getPipelineForProject(projectId: string) {
  const rows = await dbAll(db.select().from(pipelines).where(eq(pipelines.projectId, projectId)));
  return rows.find((r: any) => r.enabled) ?? null;
}

export async function createPipeline(data: {
  projectId: string;
  userId: string;
  name: string;
  reviewModel?: string;
  fixModel?: string;
  maxIterations?: number;
  precommitFixEnabled?: boolean;
  precommitFixModel?: string;
  precommitFixMaxIterations?: number;
  reviewerPrompt?: string;
  correctorPrompt?: string;
  precommitFixerPrompt?: string;
  commitMessagePrompt?: string;
  testEnabled?: boolean;
  testCommand?: string;
  testFixEnabled?: boolean;
  testFixModel?: string;
  testFixMaxIterations?: number;
  testFixerPrompt?: string;
}): Promise<string> {
  const id = nanoid();
  const now = new Date().toISOString();
  await dbRun(
    db.insert(pipelines).values({
      id,
      projectId: data.projectId,
      userId: data.userId,
      name: data.name,
      enabled: 1,
      reviewModel: data.reviewModel || 'sonnet',
      fixModel: data.fixModel || 'sonnet',
      maxIterations: data.maxIterations || 10,
      precommitFixEnabled: data.precommitFixEnabled ? 1 : 0,
      precommitFixModel: data.precommitFixModel || 'sonnet',
      precommitFixMaxIterations: data.precommitFixMaxIterations || 3,
      reviewerPrompt: data.reviewerPrompt || null,
      correctorPrompt: data.correctorPrompt || null,
      precommitFixerPrompt: data.precommitFixerPrompt || null,
      commitMessagePrompt: data.commitMessagePrompt || null,
      testEnabled: data.testEnabled ? 1 : 0,
      testCommand: data.testCommand || null,
      testFixEnabled: data.testFixEnabled ? 1 : 0,
      testFixModel: data.testFixModel || 'sonnet',
      testFixMaxIterations: data.testFixMaxIterations || 3,
      testFixerPrompt: data.testFixerPrompt || null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return id;
}

export async function getPipelineById(id: string) {
  return dbGet(db.select().from(pipelines).where(eq(pipelines.id, id)));
}

export async function getPipelinesByProject(projectId: string) {
  return dbAll(db.select().from(pipelines).where(eq(pipelines.projectId, projectId)));
}

export async function updatePipeline(id: string, updates: Record<string, unknown>) {
  const data = { ...updates, updatedAt: new Date().toISOString() };
  await dbRun(db.update(pipelines).set(data).where(eq(pipelines.id, id)));
}

export async function deletePipeline(id: string) {
  await dbRun(db.delete(pipelines).where(eq(pipelines.id, id)));
}

// ── Pipeline Run CRUD ────────────────────────────────────────

export async function createRun(data: {
  pipelineId: string;
  threadId: string;
  maxIterations: number;
  commitSha?: string;
}): Promise<string> {
  const id = nanoid();
  await dbRun(
    db.insert(pipelineRuns).values({
      id,
      pipelineId: data.pipelineId,
      threadId: data.threadId,
      status: 'reviewing',
      currentStage: 'reviewer',
      iteration: 1,
      maxIterations: data.maxIterations,
      commitSha: data.commitSha,
      createdAt: new Date().toISOString(),
    }),
  );
  return id;
}

export async function updateRun(id: string, updates: Record<string, unknown>) {
  await dbRun(db.update(pipelineRuns).set(updates).where(eq(pipelineRuns.id, id)));
}

export async function getRunById(id: string) {
  return dbGet(db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)));
}

export async function getRunsForThread(threadId: string) {
  return dbAll(db.select().from(pipelineRuns).where(eq(pipelineRuns.threadId, threadId)));
}
