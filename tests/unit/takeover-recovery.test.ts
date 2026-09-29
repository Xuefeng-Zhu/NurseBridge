import { describe, expect, it, vi } from 'vitest';
import type { CallSnapshot } from '../../packages/contracts/src/index';
import { recoverTakeover } from '../../apps/web/src/components/takeover-recovery';
import { ApiError } from '../../apps/web/src/components/workspace-api';

const fresh = (revision: number, changes: Partial<CallSnapshot> = {}) => ({ id: 'call-a', queueState: 'WAITING', conversationOwner: 'NONE', controlRevision: revision, ...changes }) as CallSnapshot;
const owned = { participantId: 'nurse-a', expiresAt: Date.now() + 60_000 };
const conflict = () => new ApiError(409, 'The call changed. Refresh and try again.', 'revision_conflict');
function options() {
  return { callId: 'call-a', participantId: 'nurse-a', isCurrent: vi.fn(() => true), read: vi.fn<() => Promise<CallSnapshot>>(), command: vi.fn<(type: 'claim' | 'takeover', revision: number) => Promise<CallSnapshot>>(), onSnapshot: vi.fn() };
}

describe('takeover revision recovery', () => {
  it('refreshes a rejected claim once and preserves expected revisions for both writes', async () => {
    const input = options();
    input.read.mockResolvedValueOnce(fresh(1)).mockResolvedValueOnce(fresh(2));
    input.command.mockRejectedValueOnce(conflict()).mockResolvedValueOnce(fresh(3, { claim: owned })).mockResolvedValueOnce(fresh(4, { claim: owned, conversationOwner: 'HANDOFF_PENDING' }));
    await expect(recoverTakeover(input)).resolves.toMatchObject({ controlRevision: 4 });
    expect(input.command.mock.calls).toEqual([['claim', 1], ['claim', 2], ['takeover', 3]]);
    expect(input.read).toHaveBeenCalledTimes(2);
  });

  it('refreshes a rejected takeover and keeps its existing claim instead of claiming again', async () => {
    const input = options();
    input.read.mockResolvedValueOnce(fresh(1)).mockResolvedValueOnce(fresh(3, { claim: owned }));
    input.command.mockResolvedValueOnce(fresh(2, { claim: owned })).mockRejectedValueOnce(conflict()).mockResolvedValueOnce(fresh(4, { claim: owned, conversationOwner: 'HANDOFF_PENDING' }));
    await recoverTakeover(input);
    expect(input.command.mock.calls).toEqual([['claim', 1], ['takeover', 2], ['takeover', 3]]);
  });

  it('preserves an already connected conversation owned by the same nurse after lease expiry', async () => {
    const input = options();
    const connected = fresh(5, { claim: { ...owned, expiresAt: Date.now() - 1000 }, queueState: 'CONNECTED', conversationOwner: 'NURSE' });
    input.read.mockResolvedValue(connected);
    await expect(recoverTakeover(input)).resolves.toBe(connected);
    expect(input.command).not.toHaveBeenCalled();
  });

  it.each([new ApiError(409, 'Other conflict', 'already_claimed'), new ApiError(409, 'Legacy conflict'), new ApiError(408, 'The write may have completed'), new ApiError(0, 'Connection lost'), new ApiError(503, 'Unavailable')])('does not retry an unconfirmed or unrelated write failure: $status/$code', async reason => {
    const input = options();
    input.read.mockResolvedValue(fresh(1)); input.command.mockRejectedValue(reason);
    await expect(recoverTakeover(input)).rejects.toBe(reason);
    expect(input.command).toHaveBeenCalledTimes(1);
    expect(input.read).toHaveBeenCalledTimes(1);
  });

  it('bounds recovery to one confirmed conflict', async () => {
    const input = options(); const reason = conflict();
    input.read.mockResolvedValue(fresh(1)); input.command.mockRejectedValue(reason);
    await expect(recoverTakeover(input)).rejects.toBe(reason);
    expect(input.command).toHaveBeenCalledTimes(2);
    expect(input.read).toHaveBeenCalledTimes(2);
  });

  it.each([{ queueState: 'CLOSED' }, { claim: { ...owned, participantId: 'another-nurse' } }, { id: 'another-call' }] as Partial<CallSnapshot>[])('does not recover into an unavailable or different case: %j', async changes => {
    const input = options();
    input.read.mockResolvedValueOnce(fresh(1)).mockResolvedValueOnce(fresh(2, changes)); input.command.mockRejectedValueOnce(conflict());
    await expect(recoverTakeover(input)).rejects.toBeInstanceOf(ApiError);
    expect(input.command).toHaveBeenCalledTimes(1);
  });

  it('does not issue a write if the audio assignment is released while reading', async () => {
    const input = options();
    input.read.mockImplementation(async () => { input.isCurrent.mockReturnValue(false); return fresh(1); });
    await expect(recoverTakeover(input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(input.command).not.toHaveBeenCalled();
  });

  it('does not retry when its attempt or participant is superseded during a rejected write', async () => {
    const input = options(); const reason = conflict();
    input.read.mockResolvedValue(fresh(1)); input.command.mockImplementation(async () => { input.isCurrent.mockReturnValue(false); throw reason; });
    await expect(recoverTakeover(input)).rejects.toBe(reason);
    expect(input.read).toHaveBeenCalledTimes(1);
    expect(input.command).toHaveBeenCalledTimes(1);
  });
});
