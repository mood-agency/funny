/**
 * Startup commands CRUD backed by the server's database.
 */

import { eq, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import { startupCommands } from '../db/schema.js';

export async function listCommands(projectId: string) {
  return dbAll(
    db
      .select()
      .from(startupCommands)
      .where(eq(startupCommands.projectId, projectId))
      .orderBy(asc(startupCommands.sortOrder)),
  );
}

export async function createCommand(data: { projectId: string; label: string; command: string }) {
  const existing = await dbAll(
    db.select().from(startupCommands).where(eq(startupCommands.projectId, data.projectId)),
  );

  const entry = {
    id: nanoid(),
    projectId: data.projectId,
    label: data.label,
    command: data.command,
    port: null,
    portEnvVar: null,
    sortOrder: existing.length,
    createdAt: new Date().toISOString(),
  };

  await dbRun(db.insert(startupCommands).values(entry));
  return entry;
}

export async function updateCommand(
  cmdId: string,
  data: { label: string; command: string; port?: number; portEnvVar?: string },
) {
  await dbRun(
    db
      .update(startupCommands)
      .set({
        label: data.label,
        command: data.command,
        port: data.port ?? null,
        portEnvVar: data.portEnvVar ?? null,
      })
      .where(eq(startupCommands.id, cmdId)),
  );
}

export async function deleteCommand(cmdId: string) {
  await dbRun(db.delete(startupCommands).where(eq(startupCommands.id, cmdId)));
}

export async function getCommand(cmdId: string) {
  return dbGet(db.select().from(startupCommands).where(eq(startupCommands.id, cmdId)));
}
