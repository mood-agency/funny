/**
 * Default multi-provider process factory.
 *
 * Routes to SDKClaudeProcess or CodexProcess based on `opts.provider`.
 * Reusable by both the server (AgentRunner) and the pipeline service.
 */

import type { IAgentProcessFactory, IAgentProcess, AgentProcessOptions } from './interfaces.js';
import { SDKClaudeProcess } from './sdk-claude.js';
import { CodexProcess } from './codex.js';

export const defaultProcessFactory: IAgentProcessFactory = {
  create(opts: AgentProcessOptions): IAgentProcess {
    if (opts.provider === 'codex') {
      return new CodexProcess(opts);
    }
    return new SDKClaudeProcess(opts);
  },
};
