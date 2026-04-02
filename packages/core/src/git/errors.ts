import { processError, internal, type DomainError } from '@funny/shared/errors';

import { ProcessExecutionError } from './process.js';

/**
 * Convert an unknown error into a DomainError.
 * Reused across all git modules to avoid duplicating the same pattern.
 */
export function toDomainError(error: unknown): DomainError {
  if ((error as DomainError).type) return error as DomainError;
  if (error instanceof ProcessExecutionError) {
    return processError(error.message, error.exitCode, error.stderr);
  }
  return internal(String(error));
}
