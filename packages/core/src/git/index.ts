export {
  execute, executeSync, executeWithLogging, executeResult,
  ProcessExecutionError,
  type ProcessResult, type ProcessOptions,
} from './process.js';

export {
  validatePath, validatePathSync, pathExists, sanitizePath,
} from './path-validation.js';

export {
  git, gitSync, gitSafeSync, isGitRepo, isGitRepoSync,
  getCurrentBranch, listBranches, getDefaultBranch, getRemoteUrl,
  extractRepoName, initRepo, stageFiles, unstageFiles, revertFiles,
  addToGitignore,
  commit, push, createPR, mergeBranch, getDiff, getDiffSummary, getSingleFileDiff,
  getStatusSummary, deriveGitSyncState,
  type GitIdentityOptions, type GitStatusSummary,
} from './git.js';

export {
  createWorktree, listWorktrees, removeWorktree, removeBranch,
  type WorktreeInfo,
} from './worktree.js';
