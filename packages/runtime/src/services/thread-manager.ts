/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: module
 * @domain layer: domain
 *
 * Thread manager — barrel re-export.
 * The original monolithic thread-manager has been split into focused modules.
 */

// Thread CRUD
export {
  listThreads,
  listArchivedThreads,
  getThread,
  getThreadByExternalRequestId,
  createThread,
  updateThread,
  deleteThread,
  markStaleThreadsInterrupted,
  markStaleExternalThreadsStopped,
} from './thread-repository.js';

// Message CRUD + enriched queries
export {
  getThreadWithMessages,
  getThreadMessages,
  insertMessage,
  updateMessage,
} from './message-repository.js';

// ToolCall CRUD
export {
  insertToolCall,
  updateToolCallOutput,
  findToolCall,
  getToolCall,
  findLastUnansweredInteractiveToolCall,
} from './tool-call-repository.js';

// Comment CRUD
export {
  listComments,
  insertComment,
  deleteComment,
  getCommentCounts,
} from './comment-repository.js';

// Search
export { searchThreadIdsByContent } from './search-service.js';
