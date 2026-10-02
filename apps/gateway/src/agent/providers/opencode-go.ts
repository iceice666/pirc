import { version } from '../../../../../package.json';
import type { StreamRequest } from './types.js';

/** Dynamic routing headers shared by native and Pi transports. Never persist a session ID. */
export function opencodeGoHeaders(request: StreamRequest): Record<string, string> {
  const url = new URL(request.model.baseUrl ?? request.provider.baseUrl);
  const enabled =
    request.provider.opencodeGo ||
    (url.hostname === 'opencode.ai' &&
      (url.pathname === '/zen/go' || url.pathname.startsWith('/zen/go/')));
  return enabled
    ? { 'x-opencode-session': request.sessionId, 'user-agent': `pirc/${version}` }
    : {};
}
