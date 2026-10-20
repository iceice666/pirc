import { tr } from './i18n.svelte';
import { request } from './http';

export type NativeManagementStatus =
  | 'pending'
  | 'approved'
  | 'claimed'
  | 'denied'
  | 'revoked'
  | 'expired';

export type NativeManagementCapability = 'providers' | 'devices';

export interface NativeManagementRequest {
  id: string;
  status: NativeManagementStatus;
  deviceName: string;
  capabilities: NativeManagementCapability[];
  expiresAt: string | number;
  serverNow: string | number;
}

const statuses = new Set<NativeManagementStatus>([
  'pending',
  'approved',
  'claimed',
  'denied',
  'revoked',
  'expired',
]);
const capabilities = new Set<NativeManagementCapability>(['providers', 'devices']);

/** Convert a server timestamp (ISO, Unix seconds, or Unix milliseconds) to milliseconds. */
export function timestampMillis(value: string | number): number {
  const parsed =
    typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Pick only the fields the consent screen needs from the response. */
function nativeManagementRequest(value: unknown): NativeManagementRequest {
  if (!value || typeof value !== 'object') throw new Error(tr('Invalid management request'));
  const raw = value as Record<string, unknown>;
  const expiresAt = raw.expiresAt;
  const serverNow = raw.serverNow;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.status !== 'string' ||
    !statuses.has(raw.status as NativeManagementStatus) ||
    (typeof raw.deviceName !== 'string' && raw.deviceName !== undefined) ||
    !Array.isArray(raw.capabilities) ||
    raw.capabilities.some(
      (capability) => !capabilities.has(capability as NativeManagementCapability),
    ) ||
    (typeof expiresAt !== 'string' && typeof expiresAt !== 'number') ||
    (typeof serverNow !== 'string' && typeof serverNow !== 'number') ||
    !Number.isFinite(timestampMillis(expiresAt)) ||
    !Number.isFinite(timestampMillis(serverNow))
  )
    throw new Error(tr('Invalid management request'));

  return {
    id: raw.id,
    status: raw.status as NativeManagementStatus,
    deviceName: (raw.deviceName as string | undefined)?.trim() || tr('A device'),
    capabilities: raw.capabilities as NativeManagementCapability[],
    expiresAt,
    serverNow,
  };
}

function endpoint(id: string): string {
  return `/api/native-management/requests/${encodeURIComponent(id)}`;
}

export const nativeManagementApi = {
  async get(id: string): Promise<NativeManagementRequest> {
    return nativeManagementRequest(await request<unknown>(endpoint(id)));
  },
  approve(id: string): Promise<void> {
    return request<void>(`${endpoint(id)}/approve`, { method: 'POST' });
  },
  deny(id: string): Promise<void> {
    return request<void>(`${endpoint(id)}/deny`, { method: 'POST' });
  },
  revoke(id: string): Promise<void> {
    return request<void>(endpoint(id), { method: 'DELETE' });
  },
};
