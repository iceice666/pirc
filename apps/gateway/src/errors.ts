export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_origin'
  | 'invalid_host'
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'lost_control'
  | 'workspace_busy'
  | 'runner_unavailable'
  | 'node_offline'
  | 'node_timeout'
  | 'node_error'
  | 'stale_interaction'
  | 'version_incompatible'
  | 'payload_too_large'
  | 'too_many_requests'
  /** Assistant memory (daemon/memory.ts): the USER or MEMORY budget has no room. */
  | 'memory_full'
  /** Assistant memory: the user asked to forget this content. */
  | 'forgotten'
  /** Assistant memory: the user already rejected this exact proposal. */
  | 'rejected_before';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const errorBody = (error: ApiError) => ({
  error: {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  },
});
