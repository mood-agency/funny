/**
 * Centralized model registry for all agent providers.
 * Maps friendly model names to full model IDs and provides helpers.
 */

import type { AgentProvider, AgentModel, ClaudeModel, CodexModel, PermissionMode } from './types.js';

// ── Model ID mappings ─────────────────────────────────────────

const CLAUDE_MODEL_IDS: Record<ClaudeModel, string> = {
  sonnet: 'claude-sonnet-4-5-20250929',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

const CODEX_MODEL_IDS: Record<CodexModel, string> = {
  'o3': 'o3',
  'o4-mini': 'o4-mini',
  'codex-mini': 'codex-mini',
};

// ── Permission mode mapping (Claude SDK specific) ─────────────

const CLAUDE_PERMISSION_MAP: Record<PermissionMode, string> = {
  plan: 'plan',
  autoEdit: 'bypassPermissions',
  confirmEdit: 'default',
};

// ── Default tools per provider ────────────────────────────────

const CLAUDE_DEFAULT_TOOLS = [
  'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'NotebookEdit',
];

const CODEX_DEFAULT_TOOLS: string[] = [];

// ── Public API ────────────────────────────────────────────────

/** Resolve a friendly model name to the full model ID for the given provider. */
export function resolveModelId(provider: AgentProvider, model: AgentModel): string {
  if (provider === 'claude') {
    const id = CLAUDE_MODEL_IDS[model as ClaudeModel];
    if (!id) throw new Error(`Unknown Claude model: ${model}`);
    return id;
  }
  if (provider === 'codex') {
    const id = CODEX_MODEL_IDS[model as CodexModel];
    if (!id) throw new Error(`Unknown Codex model: ${model}`);
    return id;
  }
  throw new Error(`Unknown provider: ${provider}`);
}

/** Get the default model for a provider. */
export function getDefaultModel(provider: AgentProvider): AgentModel {
  if (provider === 'claude') return 'sonnet';
  if (provider === 'codex') return 'o4-mini';
  throw new Error(`Unknown provider: ${provider}`);
}

/** Get all available models for a provider. */
export function getProviderModels(provider: AgentProvider): AgentModel[] {
  if (provider === 'claude') return Object.keys(CLAUDE_MODEL_IDS) as ClaudeModel[];
  if (provider === 'codex') return Object.keys(CODEX_MODEL_IDS) as CodexModel[];
  throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Resolve permission mode to the provider-specific SDK value.
 * Returns undefined for providers that don't support permission modes (e.g. Codex).
 */
export function resolvePermissionMode(provider: AgentProvider, mode: PermissionMode): string | undefined {
  if (provider === 'claude') return CLAUDE_PERMISSION_MAP[mode];
  // Codex doesn't have permission modes — it always runs fully autonomous
  return undefined;
}

/** Get default allowed tools for a provider. */
export function getDefaultAllowedTools(provider: AgentProvider): string[] {
  if (provider === 'claude') return [...CLAUDE_DEFAULT_TOOLS];
  if (provider === 'codex') return [...CODEX_DEFAULT_TOOLS];
  return [];
}

/** Check if a model belongs to the given provider. */
export function isModelForProvider(provider: AgentProvider, model: AgentModel): boolean {
  if (provider === 'claude') return model in CLAUDE_MODEL_IDS;
  if (provider === 'codex') return model in CODEX_MODEL_IDS;
  return false;
}
