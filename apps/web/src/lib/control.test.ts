import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { syncControl, type ControlApi } from './control';
import type { ControlLease } from './types';

const mine: ControlLease = { heldByCurrentClient: true, holderClientId: 'me', generation: 3 };
const theirs: ControlLease = { heldByCurrentClient: false, holderClientId: 'other', generation: 4 };
const lost = () => new ApiError('Control lease is missing', 409, 'lost_control');

function fakeApi(overrides: Partial<ControlApi> = {}): ControlApi {
  return {
    control: vi.fn(async () => ({ heldByCurrentClient: false })),
    acquireControl: vi.fn(async () => ({ ...mine, generation: 9 })),
    heartbeatControl: vi.fn(async () => mine),
    ...overrides,
  };
}

describe('syncControl', () => {
  it('renews a lease this client holds', async () => {
    const api = fakeApi();
    expect(await syncControl(api, 's', mine, { mayAcquire: true })).toEqual(mine);
    expect(api.heartbeatControl).toHaveBeenCalledWith('s', 3);
    expect(api.acquireControl).not.toHaveBeenCalled();
  });

  it('keeps the current state on a transient heartbeat failure', async () => {
    const api = fakeApi({ heartbeatControl: vi.fn(async () => Promise.reject(new TypeError())) });
    expect(await syncControl(api, 's', mine, { mayAcquire: true })).toBeUndefined();
    expect(api.acquireControl).not.toHaveBeenCalled();
  });

  it('re-acquires after the lease lapsed', async () => {
    const api = fakeApi({
      heartbeatControl: vi.fn(async () => Promise.reject(lost())),
      control: vi.fn(async () => ({
        heldByCurrentClient: false,
        holderClientId: 'me',
        expired: true,
      })),
    });
    expect(await syncControl(api, 's', mine, { mayAcquire: true })).toMatchObject({
      heldByCurrentClient: true,
      generation: 9,
    });
  });

  it('adopts a lease another tab of this browser took', async () => {
    const shared = { ...mine, generation: 5 };
    const api = fakeApi({
      heartbeatControl: vi.fn(async () => Promise.reject(lost())),
      control: vi.fn(async () => shared),
    });
    expect(await syncControl(api, 's', mine, { mayAcquire: true })).toEqual(shared);
    expect(api.acquireControl).not.toHaveBeenCalled();
  });

  it('picks up control nobody holds', async () => {
    const api = fakeApi();
    const result = await syncControl(
      api,
      's',
      { heldByCurrentClient: false },
      { mayAcquire: true },
    );
    expect(result?.heldByCurrentClient).toBe(true);
  });

  it('never takes a live lease from another device', async () => {
    const api = fakeApi({ control: vi.fn(async () => theirs) });
    expect(await syncControl(api, 's', theirs, { mayAcquire: true })).toEqual(theirs);
    expect(api.acquireControl).not.toHaveBeenCalled();
  });

  it('does not acquire from a hidden tab', async () => {
    const api = fakeApi();
    await syncControl(api, 's', { heldByCurrentClient: false }, { mayAcquire: false });
    expect(api.acquireControl).not.toHaveBeenCalled();
  });

  it('reports the winner when it loses an acquire race', async () => {
    const control = vi
      .fn<ControlApi['control']>()
      .mockResolvedValueOnce({ heldByCurrentClient: false })
      .mockResolvedValueOnce(theirs);
    const api = fakeApi({ control, acquireControl: vi.fn(async () => Promise.reject(lost())) });
    expect(
      await syncControl(api, 's', { heldByCurrentClient: false }, { mayAcquire: true }),
    ).toEqual(theirs);
  });
});
