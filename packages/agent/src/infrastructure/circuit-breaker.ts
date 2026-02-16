/**
 * Circuit breaker policies using cockatiel.
 *
 * Protects external calls from cascading failures:
 *   - claude: wraps agent process starts (pipeline runner + integrator)
 *   - github: wraps push + createPR calls (integrator)
 */

import {
  type CircuitBreakerPolicy,
  ConsecutiveBreaker,
  handleAll,
  circuitBreaker,
} from 'cockatiel';
import { logger } from './logger.js';

export interface CircuitBreakerConfig {
  claude: { failure_threshold: number; reset_timeout_ms: number };
  github: { failure_threshold: number; reset_timeout_ms: number };
}

export interface CircuitBreakers {
  claude: CircuitBreakerPolicy;
  github: CircuitBreakerPolicy;
}

export function createCircuitBreakers(config: CircuitBreakerConfig): CircuitBreakers {
  const claude = circuitBreaker(handleAll, {
    halfOpenAfter: config.claude.reset_timeout_ms,
    breaker: new ConsecutiveBreaker(config.claude.failure_threshold),
  });

  claude.onBreak(() => {
    logger.error({ service: 'claude', threshold: config.claude.failure_threshold }, 'Circuit OPEN — Claude agent calls blocked');
  });
  claude.onReset(() => {
    logger.info({ service: 'claude' }, 'Circuit CLOSED — Claude agent calls restored');
  });
  claude.onHalfOpen(() => {
    logger.info({ service: 'claude' }, 'Circuit HALF-OPEN — testing Claude agent');
  });

  const github = circuitBreaker(handleAll, {
    halfOpenAfter: config.github.reset_timeout_ms,
    breaker: new ConsecutiveBreaker(config.github.failure_threshold),
  });

  github.onBreak(() => {
    logger.error({ service: 'github', threshold: config.github.failure_threshold }, 'Circuit OPEN — GitHub API calls blocked');
  });
  github.onReset(() => {
    logger.info({ service: 'github' }, 'Circuit CLOSED — GitHub API calls restored');
  });
  github.onHalfOpen(() => {
    logger.info({ service: 'github' }, 'Circuit HALF-OPEN — testing GitHub API');
  });

  return { claude, github };
}
