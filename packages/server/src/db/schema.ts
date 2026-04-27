/**
 * Re-exports SQLite schema from shared package.
 * All table definitions live in @funny/shared/db/schema-sqlite.
 *
 * Existing imports like `from '../db/schema.js'` continue to work unchanged.
 */
export {
  // Runtime tables
  projects,
  arcs,
  designs,
  threads,
  messages,
  startupCommands,
  toolCalls,
  automations,
  automationRuns,
  userProfiles,
  stageHistory,
  threadComments,
  messageQueue,
  mcpOauthTokens,
  pipelines,
  pipelineRuns,
  teamProjects,
  threadEvents,
  instanceSettings,
  permissionRules,
  // Server-only tables
  runners,
  runnerProjectAssignments,
  runnerTasks,
  projectMembers,
  inviteLinks,
  agentTemplates,
} from '@funny/shared/db/schema-sqlite';
