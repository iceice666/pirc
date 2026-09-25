import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BrowserAuthConfig } from '../config.js';
import { ApiError } from '../errors.js';

const singleHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? undefined : value;

export function validateRequest(
  request: FastifyRequest,
  config: BrowserAuthConfig,
  requireOrigin = false,
): void {
  const remoteAddress = request.socket.remoteAddress;
  if (!remoteAddress || !config.trustedProxies.has(remoteAddress))
    throw new ApiError(401, 'unauthenticated', 'Request did not arrive from a trusted proxy');
  const host = singleHeader(request.headers.host);
  if (!host || !config.allowedHosts.has(host))
    throw new ApiError(403, 'invalid_host', 'Host is not allowed');
  const origin = singleHeader(request.headers.origin);
  if ((requireOrigin || origin !== undefined) && (!origin || !config.allowedOrigins.has(origin)))
    throw new ApiError(403, 'invalid_origin', 'Origin is not allowed');
  const identity = singleHeader(request.headers[config.identityHeader]);
  if (!identity) throw new ApiError(401, 'unauthenticated', 'Trusted identity header is missing');
  if (!config.allowedUsers.has(identity))
    throw new ApiError(403, 'forbidden', 'Identity is not allowed');
  request.identity = { user: identity };
}

export function authHook(config: BrowserAuthConfig) {
  return async (request: FastifyRequest, _reply: FastifyReply) =>
    validateRequest(request, config, !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
}
