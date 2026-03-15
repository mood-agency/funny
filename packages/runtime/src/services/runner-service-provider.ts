/**
 * Minimal service provider for stateless runner mode.
 *
 * When the runtime runs as a remote runner (TEAM_SERVER_URL is set),
 * it has no local database. This provider:
 *  - Proxies thread/message/toolcall/project ops via the WebSocket tunnel
 *    (using remote* functions from team-client.ts)
 *  - Provides no-op stubs for server-only concerns (analytics, search, etc.)
 *    since those routes are handled by the server directly
 *  - Uses the wsBroker for local WebSocket event delivery
 */

import { ok, err } from 'neverthrow';

import { log } from '../lib/logger.js';
import type { RuntimeServiceProvider } from './service-provider.js';
import { wsBroker } from './ws-broker.js';

function notAvailable(method: string): never {
  throw new Error(`${method} is not available in runner mode — this is a server concern`);
}

export function createRunnerServiceProvider(): RuntimeServiceProvider {
  return {
    // ── Threads — proxy to server via team-client ────────────
    threads: {
      async getThread(id) {
        const { isTeamModeActive, remoteGetThread } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteGetThread(id);
        return undefined;
      },
      async updateThread(id, updates) {
        const { isTeamModeActive, remoteUpdateThread } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteUpdateThread(id, updates);
      },
      async getThreadWithMessages(_id) {
        // Read-heavy — forwarded via HTTP tunnel, not here
        return null;
      },
      async listThreads() {
        return [];
      },
      async listArchivedThreads() {
        return [];
      },
      async getThreadByExternalRequestId() {
        return undefined;
      },
      async createThread(data) {
        const { isTeamModeActive, remoteCreateThread } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteCreateThread(data);
        notAvailable('createThread');
      },
      async deleteThread(id) {
        const { isTeamModeActive, remoteDeleteThread } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteDeleteThread(id);
        notAvailable('deleteThread');
      },
      async markStaleThreadsInterrupted() {},
      async markStaleExternalThreadsStopped() {},
      async getThreadMessages() {
        return [];
      },
      async insertMessage(data) {
        const { isTeamModeActive, remoteInsertMessage } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteInsertMessage(data);
        return '';
      },
      async updateMessage(id, content) {
        const { isTeamModeActive, remoteUpdateMessage } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteUpdateMessage(id, content);
      },
      async insertToolCall(data) {
        const { isTeamModeActive, remoteInsertToolCall } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteInsertToolCall(data);
        return '';
      },
      async updateToolCallOutput(id, output) {
        const { isTeamModeActive, remoteUpdateToolCallOutput } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteUpdateToolCallOutput(id, output);
      },
      async findToolCall(messageId, name, input) {
        const { isTeamModeActive, remoteFindToolCall } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteFindToolCall(messageId, name, input);
        return undefined;
      },
      async getToolCall(id) {
        const { isTeamModeActive, remoteGetToolCall } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteGetToolCall(id);
        return undefined;
      },
      async findLastUnansweredInteractiveToolCall() {
        return undefined;
      },
      async insertComment() {
        return {};
      },
      async listComments() {
        return [];
      },
      async deleteComment() {},
      async getCommentCounts() {
        return {};
      },
      async searchThreadIdsByContent() {
        return new Map();
      },
    },

    // ── Projects — proxy reads to server, writes handled by server routes ──
    projects: {
      async listProjects(userId) {
        const { isTeamModeActive, remoteListProjects } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteListProjects(userId);
        return [];
      },
      async listProjectsByOrg() {
        return [];
      },
      async isProjectInOrg() {
        return false;
      },
      async getProject(id) {
        const { isTeamModeActive, remoteGetProject } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteGetProject(id);
        return undefined;
      },
      async projectNameExists() {
        return false;
      },
      async createProject() {
        notAvailable('createProject');
      },
      async updateProject() {
        notAvailable('updateProject');
      },
      async deleteProject() {},
      async addProjectToOrg() {},
      async getMemberLocalPath() {
        return null;
      },
      async resolveProjectPath(projectId, userId) {
        const { isTeamModeActive, remoteResolveProjectPath } = await import('./team-client.js');
        if (isTeamModeActive()) {
          const result = await remoteResolveProjectPath(projectId, userId);
          if (result.ok && result.path) return ok(result.path);
          return err({
            type: 'BAD_REQUEST' as const,
            message: result.error || 'Failed to resolve project path',
          });
        }
        notAvailable('resolveProjectPath');
      },
      async reorderProjects() {
        notAvailable('reorderProjects');
      },
    },

    // ── Server-only concerns — handled by server routes directly ──
    automations: {
      async listAutomations() {
        return [];
      },
      async getAutomation() {
        return undefined;
      },
      async insertAutomation() {},
      async createAutomation() {
        notAvailable('createAutomation');
      },
      async updateAutomationRow() {},
      async updateAutomation() {},
      async deleteAutomationRow() {},
      async deleteAutomation() {},
      async createRun() {},
      async updateRun() {},
      async listRuns() {
        return [];
      },
      async listRunningRuns() {
        return [];
      },
      async getRunByThreadId() {
        return undefined;
      },
      async listPendingReviewRuns() {
        return [];
      },
      async listInboxRuns() {
        return [];
      },
    },

    pipelines: {
      async getPipelineForProject() {
        return null;
      },
      async createPipeline() {
        return '';
      },
      async getPipelineById() {
        return undefined;
      },
      async getPipelinesByProject() {
        return [];
      },
      async updatePipeline() {},
      async deletePipeline() {},
      async createRun() {
        return '';
      },
      async updateRun() {},
      async getRunById() {
        return undefined;
      },
      async getRunsForThread() {
        return [];
      },
    },

    profile: {
      async getProfile() {
        return null;
      },
      async getGithubToken() {
        return null;
      },
      async getAssemblyaiApiKey() {
        return null;
      },
      async getGitIdentity() {
        return null;
      },
      async isSetupCompleted() {
        return false;
      },
      async updateProfile() {
        notAvailable('updateProfile');
      },
    },

    analytics: {
      async getOverview() {
        return {};
      },
      async getTimeline() {
        return {};
      },
    },

    search: {
      async searchThreadIdsByContent() {
        return new Map();
      },
    },

    startupCommands: {
      async listCommands() {
        return [];
      },
      async createCommand() {
        return {};
      },
      async updateCommand() {},
      async deleteCommand() {},
      async getCommand() {
        return undefined;
      },
    },

    threadEvents: {
      async createThreadEvent() {},
      async saveThreadEvent() {},
      async getThreadEvents() {
        return [];
      },
      async deleteThreadEvents() {},
    },

    messageQueue: {
      async enqueue(threadId, data) {
        const { isTeamModeActive, remoteEnqueueMessage } = await import('./team-client.js');
        if (isTeamModeActive()) return remoteEnqueueMessage(threadId, data);
        notAvailable('enqueue');
      },
      async peek() {
        return null;
      },
      async dequeue() {
        return null;
      },
      async cancel() {
        return false;
      },
      async update() {
        return null;
      },
      async listQueue() {
        return [];
      },
      async queueCount() {
        return 0;
      },
      async clearQueue() {},
    },

    mcpOauth: {
      async startOAuthFlow() {
        notAvailable('startOAuthFlow');
      },
      async handleOAuthCallback() {
        return { serverName: '', success: false, error: 'Not available in runner mode' };
      },
      async upsertToken() {},
    },

    stageHistory: {
      async recordStageChange() {},
    },

    wsBroker,
  };
}
