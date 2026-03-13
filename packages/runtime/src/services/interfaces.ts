/**
 * @domain subdomain: Shared Kernel
 * @domain type: module
 * @domain layer: domain
 *
 * Re-exports for backward compatibility during migration.
 */
export type { IThreadManager, IWSBroker } from './server-interfaces.js';
export type {
  IAgentProcess,
  IClaudeProcess,
  AgentProcessOptions,
  IAgentProcessFactory,
  IClaudeProcessFactory,
} from '@funny/core/agents';
