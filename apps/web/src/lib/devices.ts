/** Device tokens: pairing the native (Android) client with this gateway. */
import { encode } from 'uqr';
import { request } from './http';

export interface PairedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number;
  /** When the token dies unless used again (idle or absolute limit). */
  expiresAt: number;
}

/** Device management never uses browser caches: the pairing reply holds a live token. */
const noStore = <T>(path: string, init: RequestInit = {}) =>
  request<T>(path, { cache: 'no-store', ...init });

export const deviceApi = {
  list: async () => (await noStore<{ devices: PairedDevice[] }>('/api/devices')).devices,
  pair: (name: string) =>
    noStore<{ device: PairedDevice; token: string }>('/api/devices', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  revoke: (id: string) =>
    noStore<void>(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/** The link the app opens (scanned as a QR code, or tapped on the phone itself). */
export function pairingUri(origin: string, token: string): string {
  return `pirc://pair?${new URLSearchParams({ url: origin, token })}`;
}

/** One SVG path of the QR code's dark modules, in module units with a 4-module quiet zone. */
export function qrPath(text: string): { size: number; path: string } {
  const { data } = encode(text, { ecc: 'M', border: 4 });
  let path = '';
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return { size: data.length, path };
}
