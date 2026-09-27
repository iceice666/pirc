import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BrowserAuthConfig } from '../config.js';
import { ApiError } from '../errors.js';

const singleHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? undefined : value;

/** Checks a device token; see `DeviceTokens.authenticate`. */
export interface DeviceAuthenticator {
  authenticate(token: string): { id: string; user: string };
}

/** Anything that looks like a device token takes the device path, never forward auth. */
const DEVICE_BEARER = /^bearer\s+pirc_dev_/i;
/** Routes a device token may not reach: device management and model backends/credentials. */
const DEVICE_DENIED = /^\/api\/(?:devices|providers|provider-auth)(?:\/|$)/;

/**
 * Identify the caller of a browser-API request. Every request must come
 * through a trusted proxy with an allowed Host. The identity is either the
 * proxy's forward-auth header or, for native clients, a device bearer token;
 * a request carrying both is refused so a misrouted proxy fails closed.
 */
export function validateRequest(
  request: FastifyRequest,
  config: BrowserAuthConfig,
  devices: DeviceAuthenticator,
  requireOrigin = false,
): void {
  const remoteAddress = request.socket.remoteAddress;
  if (!remoteAddress || !config.trustedProxies.has(remoteAddress))
    throw new ApiError(401, 'unauthenticated', 'Request did not arrive from a trusted proxy');
  const host = singleHeader(request.headers.host);
  if (!host || !config.allowedHosts.has(host))
    throw new ApiError(403, 'invalid_host', 'Host is not allowed');
  const origin = singleHeader(request.headers.origin);
  const authorization = singleHeader(request.headers.authorization);
  if (authorization !== undefined && DEVICE_BEARER.test(authorization)) {
    if (request.headers[config.identityHeader] !== undefined)
      throw new ApiError(
        401,
        'unauthenticated',
        'A request cannot carry both a device token and a forward-auth identity',
      );
    // A bearer token is never sent ambiently, so there is no cross-site
    // request to guard against; an Origin that is sent must still be allowed.
    if (origin !== undefined && !config.allowedOrigins.has(origin))
      throw new ApiError(403, 'invalid_origin', 'Origin is not allowed');
    const token = /^bearer\s+(\S+)$/i.exec(authorization)?.[1] ?? '';
    const device = devices.authenticate(token);
    if (!config.allowedUsers.has(device.user))
      throw new ApiError(403, 'forbidden', 'Identity is not allowed');
    const pathname = request.url.split('?', 1)[0]!;
    if (DEVICE_DENIED.test(request.routeOptions.url ?? '') || DEVICE_DENIED.test(pathname))
      throw new ApiError(403, 'forbidden', 'Device tokens cannot reach this route');
    request.identity = { user: device.user, deviceId: device.id };
    return;
  }
  if ((requireOrigin || origin !== undefined) && (!origin || !config.allowedOrigins.has(origin)))
    throw new ApiError(403, 'invalid_origin', 'Origin is not allowed');
  const identity = singleHeader(request.headers[config.identityHeader]);
  if (!identity) throw new ApiError(401, 'unauthenticated', 'Trusted identity header is missing');
  if (!config.allowedUsers.has(identity))
    throw new ApiError(403, 'forbidden', 'Identity is not allowed');
  request.identity = { user: identity };
}

export function authHook(config: BrowserAuthConfig, devices: DeviceAuthenticator) {
  return async (request: FastifyRequest, _reply: FastifyReply) =>
    validateRequest(request, config, devices, !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
}
