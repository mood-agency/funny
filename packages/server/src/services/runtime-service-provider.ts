/**
 * Factory that creates a RuntimeServiceProvider backed by the server's DB.
 *
 * When the server mounts the runtime in-process, it passes this provider
 * to `createRuntimeApp({ services })`. All data access from the runtime
 * flows through here — direct function calls, zero overhead.
 *
 * Each service implementation uses the server's database directly.
 * The runtime never touches the DB — it calls these functions instead.
 */

import {
  createMessageRepository,
  createToolCallRepository,
  createThreadRepository,
  createCommentRepository,
  createStageHistoryRepository,
} from '@funny/shared/repositories';
import type {
  IThreadRepository,
  IProfileService,
  IAnalyticsService,
  IWSBroker,
} from '@ironmussa/funny-runtime/services/server-interfaces';
import type { RuntimeServiceProvider } from '@ironmussa/funny-runtime/services/service-provider';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
// Server-owned services (pre-existing)
import * as analyticsService from './analytics-service.js';
// Server-side CRUD implementations (new)
import * as automationRepo from './automation-repository.js';
import * as mcpOauthRepo from './mcp-oauth-repository.js';
import * as messageQueueRepo from './message-queue-repository.js';
import * as pipelineRepo from './pipeline-repository.js';
import * as profileService from './profile-service.js';
import * as projectRepo from './project-repository.js';
import * as searchRepo from './search-repository.js';
import * as startupCommandsRepo from './startup-commands-repository.js';
import * as threadEventRepo from './thread-event-repository.js';

/**
 * Create a RuntimeServiceProvider backed by the server's database.
 * This is used when the runtime is mounted in-process (local runner mode).
 */
export function createRuntimeServiceProvider(wsBroker: IWSBroker): RuntimeServiceProvider {
  // ── Build shared repositories ────────────────────────────

  const commentRepo = createCommentRepository({ db, schema: schema as any, dbAll, dbRun });
  const stageHistoryRepo = createStageHistoryRepository({ db, schema: schema as any, dbRun });
  const threadRepo = createThreadRepository({
    db,
    schema: schema as any,
    dbAll,
    dbGet,
    dbRun,
    commentRepo,
    stageHistoryRepo,
  });
  const messageRepo = createMessageRepository({ db, schema: schema as any, dbAll, dbGet, dbRun });
  const toolCallRepo = createToolCallRepository({ db, schema: schema as any, dbGet, dbRun });

  // ── Thread repository ─────────────────────────────────────

  const threads: IThreadRepository = {
    getThread: threadRepo.getThread,
    updateThread: threadRepo.updateThread,
    getThreadWithMessages: messageRepo.getThreadWithMessages,
    listThreads: threadRepo.listThreads,
    listArchivedThreads: threadRepo.listArchivedThreads,
    getThreadByExternalRequestId: threadRepo.getThreadByExternalRequestId,
    createThread: threadRepo.createThread,
    deleteThread: threadRepo.deleteThread,
    markStaleThreadsInterrupted: threadRepo.markStaleThreadsInterrupted,
    markStaleExternalThreadsStopped: threadRepo.markStaleExternalThreadsStopped,
    getThreadMessages: messageRepo.getThreadMessages,
    insertMessage: messageRepo.insertMessage,
    updateMessage: messageRepo.updateMessage,
    insertToolCall: toolCallRepo.insertToolCall,
    updateToolCallOutput: toolCallRepo.updateToolCallOutput,
    findToolCall: toolCallRepo.findToolCall,
    getToolCall: toolCallRepo.getToolCall,
    findLastUnansweredInteractiveToolCall: toolCallRepo.findLastUnansweredInteractiveToolCall,
    insertComment: commentRepo.insertComment,
    listComments: commentRepo.listComments,
    deleteComment: commentRepo.deleteComment,
    getCommentCounts: commentRepo.getCommentCounts,
    searchThreadIdsByContent: searchRepo.searchThreadIdsByContent,
  };

  // ── Projects ──────────────────────────────────────────────

  const projects = {
    listProjects: projectRepo.listProjects,
    listProjectsByOrg: projectRepo.listProjectsByOrg,
    isProjectInOrg: projectRepo.isProjectInOrg,
    getProject: projectRepo.getProject,
    projectNameExists: projectRepo.projectNameExists,
    createProject: projectRepo.createProject,
    updateProject: projectRepo.updateProject,
    deleteProject: projectRepo.deleteProject,
    addProjectToOrg: projectRepo.addProjectToOrg,
    getMemberLocalPath: projectRepo.getMemberLocalPath,
    resolveProjectPath: projectRepo.resolveProjectPath,
    reorderProjects: projectRepo.reorderProjects,
  };

  // ── Automations ───────────────────────────────────────────
  // Note: createAutomation in the runtime adds scheduler hooks on top.
  // The provider exposes the raw CRUD; the runtime's automation-manager
  // wraps createAutomation/updateAutomation/deleteAutomation with
  // scheduler notifications. For now, we expose the raw DB operations
  // and the runtime keeps its scheduler hook logic.

  // Automations: raw DB operations are server-side. The createAutomation,
  // updateAutomation, deleteAutomation with scheduler hooks are placeholders
  // that get overwritten by the runtime during init (it wraps the raw ops
  // with scheduler notifications).
  const automations: any = {
    listAutomations: automationRepo.listAutomations,
    getAutomation: automationRepo.getAutomation,
    insertAutomation: automationRepo.insertAutomation,
    // These will be overwritten by the runtime's automation-manager after init:
    createAutomation: async (_data: any) => {
      throw new Error('createAutomation not yet wired — runtime init pending');
    },
    updateAutomationRow: automationRepo.updateAutomationRow,
    updateAutomation: async (_id: string, _updates: any) => {
      throw new Error('updateAutomation not yet wired — runtime init pending');
    },
    deleteAutomationRow: automationRepo.deleteAutomationRow,
    deleteAutomation: async (_id: string) => {
      throw new Error('deleteAutomation not yet wired — runtime init pending');
    },
    createRun: automationRepo.createRun,
    updateRun: automationRepo.updateRun,
    listRuns: automationRepo.listRuns,
    listRunningRuns: automationRepo.listRunningRuns,
    getRunByThreadId: automationRepo.getRunByThreadId,
    listPendingReviewRuns: automationRepo.listPendingReviewRuns,
    listInboxRuns: automationRepo.listInboxRuns,
  };

  // ── Pipelines ─────────────────────────────────────────────

  const pipelines = {
    getPipelineForProject: pipelineRepo.getPipelineForProject,
    createPipeline: pipelineRepo.createPipeline,
    getPipelineById: pipelineRepo.getPipelineById,
    getPipelinesByProject: pipelineRepo.getPipelinesByProject,
    updatePipeline: pipelineRepo.updatePipeline,
    deletePipeline: pipelineRepo.deletePipeline,
    createRun: pipelineRepo.createRun,
    updateRun: pipelineRepo.updateRun,
    getRunById: pipelineRepo.getRunById,
    getRunsForThread: pipelineRepo.getRunsForThread,
  };

  // ── Profile ───────────────────────────────────────────────

  const profile: IProfileService = {
    getProfile: async (userId) => {
      const p = await profileService.getProfile(userId);
      if (!p) return null;
      return {
        id: '',
        userId: p.userId,
        gitName: p.gitName,
        gitEmail: p.gitEmail,
        hasGithubToken: p.hasGithubToken,
        hasAssemblyaiKey: p.hasAssemblyaiKey,
        setupCompleted: p.setupCompleted,
        defaultEditor: p.defaultEditor,
        useInternalEditor: p.useInternalEditor,
        terminalShell: p.terminalShell,
        toolPermissions: p.toolPermissions,
        theme: p.theme,
        createdAt: '',
        updatedAt: '',
      };
    },
    getGithubToken: profileService.getGithubToken,
    getAssemblyaiApiKey: profileService.getAssemblyaiApiKey,
    getGitIdentity: async (userId) => {
      const p = await profileService.getProfile(userId);
      if (!p?.gitName || !p?.gitEmail) return null;
      return { name: p.gitName, email: p.gitEmail };
    },
    isSetupCompleted: profileService.isSetupCompleted,
    updateProfile: async (userId, data) => {
      const result = await profileService.upsertProfile(userId, data);
      return {
        id: '',
        userId: result.userId,
        gitName: result.gitName,
        gitEmail: result.gitEmail,
        hasGithubToken: result.hasGithubToken,
        hasAssemblyaiKey: result.hasAssemblyaiKey,
        setupCompleted: result.setupCompleted,
        defaultEditor: result.defaultEditor,
        useInternalEditor: result.useInternalEditor,
        terminalShell: result.terminalShell,
        toolPermissions: result.toolPermissions,
        theme: result.theme,
        createdAt: '',
        updatedAt: '',
      };
    },
  };

  // ── Analytics ─────────────────────────────────────────────

  const analytics: IAnalyticsService = {
    getOverview: analyticsService.getOverview,
    getTimeline: analyticsService.getTimeline,
  };

  // ── Search ────────────────────────────────────────────────

  const search = {
    searchThreadIdsByContent: searchRepo.searchThreadIdsByContent,
  };

  // ── Startup commands ──────────────────────────────────────

  const startupCommands = {
    listCommands: startupCommandsRepo.listCommands,
    createCommand: startupCommandsRepo.createCommand,
    updateCommand: startupCommandsRepo.updateCommand,
    deleteCommand: startupCommandsRepo.deleteCommand,
    getCommand: startupCommandsRepo.getCommand,
  };

  // ── Thread events ─────────────────────────────────────────

  const threadEvents = {
    createThreadEvent: threadEventRepo.createThreadEvent,
    saveThreadEvent: threadEventRepo.saveThreadEvent,
    getThreadEvents: threadEventRepo.getThreadEvents,
    deleteThreadEvents: threadEventRepo.deleteThreadEvents,
  };

  // ── Message queue ─────────────────────────────────────────

  const messageQueue = {
    enqueue: messageQueueRepo.enqueue,
    peek: messageQueueRepo.peek,
    dequeue: messageQueueRepo.dequeue,
    cancel: messageQueueRepo.cancel,
    update: messageQueueRepo.update,
    listQueue: messageQueueRepo.listQueue,
    queueCount: messageQueueRepo.queueCount,
    clearQueue: messageQueueRepo.clearQueue,
  };

  // ── MCP OAuth — flow logic stays in runtime (process-local state),
  // but token persistence is server-side ────────────────────────

  const mcpOauth = {
    startOAuthFlow: async (
      serverName: string,
      serverUrl: string,
      projectPath: string,
      callbackBaseUrl: string,
    ) => {
      const oauth = await import('@ironmussa/funny-runtime/services/mcp-oauth');
      return oauth.startOAuthFlow(serverName, serverUrl, projectPath, callbackBaseUrl);
    },
    handleOAuthCallback: async (code: string, state: string) => {
      const oauth = await import('@ironmussa/funny-runtime/services/mcp-oauth');
      return oauth.handleOAuthCallback(code, state);
    },
    upsertToken: mcpOauthRepo.upsertToken,
  };

  // ── Stage history ─────────────────────────────────────────

  const stageHistory = {
    recordStageChange: stageHistoryRepo.recordStageChange,
  };

  return {
    projects,
    threads,
    automations,
    pipelines,
    profile,
    analytics,
    search,
    startupCommands,
    threadEvents,
    messageQueue,
    mcpOauth,
    stageHistory,
    wsBroker,
  };
}
