/**
 * MCP OAuth token persistence backed by the server's database.
 */

import { randomBytes } from 'crypto';

import { eq, and } from 'drizzle-orm';

import { db, dbRun } from '../db/index.js';
import { mcpOauthTokens } from '../db/schema.js';
import { encrypt } from '../lib/crypto.js';

/**
 * Upsert an OAuth token: delete existing for the same server+project, then insert.
 * Encrypts sensitive fields (accessToken, refreshToken, clientSecret) before storage.
 */
export async function upsertToken(data: {
  serverName: string;
  projectPath: string;
  serverUrl: string;
  accessToken: string;
  refreshToken?: string | null;
  tokenType: string;
  expiresAt?: string | null;
  scope?: string | null;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const id = randomBytes(8).toString('hex');

  // Delete existing token for this server+project
  await dbRun(
    db
      .delete(mcpOauthTokens)
      .where(
        and(
          eq(mcpOauthTokens.serverName, data.serverName),
          eq(mcpOauthTokens.projectPath, data.projectPath),
        ),
      ),
  );

  // Insert new token with encrypted sensitive fields
  await dbRun(
    db.insert(mcpOauthTokens).values({
      id,
      serverName: data.serverName,
      projectPath: data.projectPath,
      serverUrl: data.serverUrl,
      accessToken: encrypt(data.accessToken),
      refreshToken: data.refreshToken ? encrypt(data.refreshToken) : null,
      tokenType: data.tokenType || 'Bearer',
      expiresAt: data.expiresAt || null,
      scope: data.scope || null,
      tokenEndpoint: data.tokenEndpoint,
      clientId: data.clientId,
      clientSecret: data.clientSecret ? encrypt(data.clientSecret) : null,
      createdAt: now,
      updatedAt: now,
    }),
  );
}
