/**
 * @domain subdomain: Team Collaboration
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Remote thread manager — delegates persistence to the central server
 * via WebSocket when running in team mode, otherwise falls back to
 * the injected service provider.
 *
 * Implements IThreadManager so it can be passed to AgentMessageHandler
 * without any changes to the handler logic.
 */

import type { IThreadManager } from './server-interfaces.js';
import { getServices } from './service-registry.js';

/**
 * Creates a thread manager that delegates to the remote server in team mode,
 * or falls back to the injected service provider.
 */
export function createRemoteThreadManager(): IThreadManager {
  return {
    async getThread(id: string) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteGetThread } = await import('./team-client.js');
        return remoteGetThread(id);
      }
      return getServices().threads.getThread(id);
    },

    async updateThread(id: string, updates: Record<string, any>) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteUpdateThread } = await import('./team-client.js');
        return remoteUpdateThread(id, updates);
      }
      return getServices().threads.updateThread(id, updates);
    },

    async getThreadWithMessages(id: string) {
      return getServices().threads.getThreadWithMessages(id);
    },

    async insertMessage(data) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteInsertMessage } = await import('./team-client.js');
        return remoteInsertMessage(data);
      }
      return getServices().threads.insertMessage(data);
    },

    async updateMessage(id: string, content: string) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteUpdateMessage } = await import('./team-client.js');
        return remoteUpdateMessage(id, content);
      }
      return getServices().threads.updateMessage(id, content);
    },

    async insertToolCall(data) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteInsertToolCall } = await import('./team-client.js');
        return remoteInsertToolCall(data);
      }
      return getServices().threads.insertToolCall(data);
    },

    async updateToolCallOutput(id: string, output: string) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteUpdateToolCallOutput } = await import('./team-client.js');
        return remoteUpdateToolCallOutput(id, output);
      }
      return getServices().threads.updateToolCallOutput(id, output);
    },

    async findToolCall(messageId: string, name: string, input: string) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteFindToolCall } = await import('./team-client.js');
        return remoteFindToolCall(messageId, name, input);
      }
      return getServices().threads.findToolCall(messageId, name, input);
    },

    async getToolCall(id: string) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteGetToolCall } = await import('./team-client.js');
        return remoteGetToolCall(id);
      }
      return getServices().threads.getToolCall(id);
    },
  };
}
