/**
 * User profile service for the central server.
 * Manages git identity and encrypted GitHub tokens.
 */

import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { userProfiles } from '../db/schema.js';
import { encrypt, decrypt } from '../lib/crypto.js';

export interface UserProfile {
  userId: string;
  gitName: string | null;
  gitEmail: string | null;
  hasGithubToken: boolean;
  hasAssemblyaiKey: boolean;
  setupCompleted: boolean;
  defaultEditor: string | null;
  useInternalEditor: boolean | null;
  terminalShell: string | null;
  toolPermissions: Record<string, any> | null;
  theme: string | null;
  runnerInviteToken: string | null;
}

export async function getProfile(userId: string): Promise<UserProfile | null> {
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));

  if (!rows[0]) return null;
  const r = rows[0];

  return {
    userId: r.userId,
    gitName: r.gitName,
    gitEmail: r.gitEmail,
    hasGithubToken: !!r.githubToken,
    hasAssemblyaiKey: !!r.assemblyaiApiKey,
    setupCompleted: !!r.setupCompleted,
    defaultEditor: r.defaultEditor ?? null,
    useInternalEditor: r.useInternalEditor != null ? !!r.useInternalEditor : null,
    terminalShell: r.terminalShell ?? null,
    toolPermissions: r.toolPermissions ? JSON.parse(r.toolPermissions as string) : null,
    theme: r.theme ?? null,
    runnerInviteToken: r.runnerInviteToken ?? null,
  };
}

export async function upsertProfile(
  userId: string,
  updates: {
    gitName?: string;
    gitEmail?: string;
    githubToken?: string;
    assemblyaiApiKey?: string | null;
    setupCompleted?: boolean;
    defaultEditor?: string;
    useInternalEditor?: boolean;
    terminalShell?: string;
    toolPermissions?: Record<string, any>;
    theme?: string;
  },
): Promise<UserProfile> {
  const now = new Date().toISOString();
  const existing = await getProfile(userId);

  const githubTokenValue = updates.githubToken ? encrypt(updates.githubToken) : undefined;
  const assemblyaiApiKeyValue = updates.assemblyaiApiKey
    ? encrypt(updates.assemblyaiApiKey)
    : undefined;

  if (existing) {
    const set: Record<string, any> = { updatedAt: now };
    if (updates.gitName !== undefined) set.gitName = updates.gitName || null;
    if (updates.gitEmail !== undefined) set.gitEmail = updates.gitEmail || null;
    if (githubTokenValue !== undefined) set.githubToken = githubTokenValue;
    if (updates.assemblyaiApiKey !== undefined) set.assemblyaiApiKey = assemblyaiApiKeyValue;
    if (updates.setupCompleted !== undefined) set.setupCompleted = updates.setupCompleted ? 1 : 0;
    if (updates.defaultEditor !== undefined) set.defaultEditor = updates.defaultEditor;
    if (updates.useInternalEditor !== undefined)
      set.useInternalEditor = updates.useInternalEditor ? 1 : 0;
    if (updates.terminalShell !== undefined) set.terminalShell = updates.terminalShell;
    if (updates.toolPermissions !== undefined)
      set.toolPermissions = JSON.stringify(updates.toolPermissions);
    if (updates.theme !== undefined) set.theme = updates.theme;

    await db.update(userProfiles).set(set).where(eq(userProfiles.userId, userId));
  } else {
    await db.insert(userProfiles).values({
      id: nanoid(),
      userId,
      gitName: updates.gitName ?? null,
      gitEmail: updates.gitEmail ?? null,
      githubToken: githubTokenValue ?? null,
      assemblyaiApiKey: assemblyaiApiKeyValue ?? null,
      setupCompleted: updates.setupCompleted ? 1 : 0,
      defaultEditor: updates.defaultEditor ?? null,
      useInternalEditor:
        updates.useInternalEditor != null ? (updates.useInternalEditor ? 1 : 0) : null,
      terminalShell: updates.terminalShell ?? null,
      toolPermissions: updates.toolPermissions ? JSON.stringify(updates.toolPermissions) : null,
      theme: updates.theme ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return (await getProfile(userId))!;
}

export async function getGithubToken(userId: string): Promise<string | null> {
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));

  const encrypted = rows[0]?.githubToken;
  if (!encrypted) return null;
  return decrypt(encrypted);
}

export async function getAssemblyaiApiKey(userId: string): Promise<string | null> {
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));

  const encrypted = rows[0]?.assemblyaiApiKey;
  if (!encrypted) return null;
  return decrypt(encrypted);
}

export async function isSetupCompleted(userId: string): Promise<boolean> {
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
  return !!rows[0]?.setupCompleted;
}

// ── Runner Invite Token ─────────────────────────────────

/** Return the runner invite token for a user, generating one if it doesn't exist yet. */
export async function getOrCreateRunnerInviteToken(userId: string): Promise<string> {
  const rows = await db
    .select({ runnerInviteToken: userProfiles.runnerInviteToken })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId));

  if (rows[0]?.runnerInviteToken) return rows[0].runnerInviteToken;

  const token = `utkn_${nanoid(32)}`;
  const now = new Date().toISOString();

  if (rows.length > 0) {
    await db
      .update(userProfiles)
      .set({ runnerInviteToken: token, updatedAt: now })
      .where(eq(userProfiles.userId, userId));
  } else {
    await db.insert(userProfiles).values({
      id: nanoid(),
      userId,
      runnerInviteToken: token,
      setupCompleted: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  return token;
}

/** Regenerate the runner invite token, invalidating the previous one for new registrations. */
export async function rotateRunnerInviteToken(userId: string): Promise<string> {
  const token = `utkn_${nanoid(32)}`;
  const now = new Date().toISOString();

  const rows = await db
    .select({ id: userProfiles.id })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId));

  if (rows.length > 0) {
    await db
      .update(userProfiles)
      .set({ runnerInviteToken: token, updatedAt: now })
      .where(eq(userProfiles.userId, userId));
  } else {
    await db.insert(userProfiles).values({
      id: nanoid(),
      userId,
      runnerInviteToken: token,
      setupCompleted: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  return token;
}

/** Validate a runner invite token and return the userId it belongs to, or null if invalid. */
export async function validateRunnerInviteToken(token: string): Promise<string | null> {
  const rows = await db
    .select({ userId: userProfiles.userId })
    .from(userProfiles)
    .where(eq(userProfiles.runnerInviteToken, token));
  return rows[0]?.userId ?? null;
}
