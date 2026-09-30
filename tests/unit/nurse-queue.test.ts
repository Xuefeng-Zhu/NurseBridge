import { describe, expect, it } from 'vitest';
import type { CallSnapshot } from '../../packages/contracts/src/index';
import { arrivalAge, firstQueueCall, matchesQueueFilter, queueCounts, queueGroup, queueStateLabel, sessionRemaining } from '../../apps/web/src/components/nurse-queue';

const call = (id: string, queueState: CallSnapshot['queueState'], changes: Partial<CallSnapshot> = {}) => ({
  id, queueState, conversationOwner: 'NONE', ...changes,
}) as CallSnapshot;

describe('nurse queue grouping', () => {
  it('uses server state despite an expired or retained claim', () => {
    const expiredClaim = { participantId: 'nurse-a', expiresAt: 0 };
    expect(queueGroup(call('waiting', 'WAITING'))).toBe('waiting');
    expect(queueGroup(call('claimed', 'CLAIMED', { claim: expiredClaim }))).toBe('in-progress');
    expect(queueGroup(call('connected', 'CONNECTED', { claim: expiredClaim }))).toBe('in-progress');
    expect(queueGroup(call('closed', 'CLOSED', { claim: expiredClaim }))).toBe('closed');
  });

  it('counts each call once and includes both assigned and connected calls in progress', () => {
    const calls = [call('a', 'CLOSED'), call('b', 'WAITING'), call('c', 'CLAIMED'), call('d', 'CONNECTED'), call('e', 'WAITING')];
    expect(queueCounts(calls)).toEqual({ all: 5, waiting: 2, 'in-progress': 2, closed: 1 });
    expect(calls.filter(item => matchesQueueFilter(item, 'all'))).toEqual(calls);
    expect(calls.filter(item => matchesQueueFilter(item, 'in-progress')).map(item => item.id)).toEqual(['c', 'd']);
    expect(calls.filter(item => matchesQueueFilter(item, 'waiting')).map(item => item.id)).toEqual(['b', 'e']);
    expect(calls.filter(item => matchesQueueFilter(item, 'closed')).map(item => item.id)).toEqual(['a']);
    expect(queueCounts([])).toEqual({ all: 0, waiting: 0, 'in-progress': 0, closed: 0 });
  });

  it('selects the first matching open case in arrival order before closed history', () => {
    const calls = [call('old-closed', 'CLOSED'), call('assigned', 'CLAIMED'), call('waiting', 'WAITING'), call('connected', 'CONNECTED'), call('new-closed', 'CLOSED')];
    expect(firstQueueCall(calls, 'all')).toBe(calls[1]);
    expect(firstQueueCall(calls, 'waiting')).toBe(calls[2]);
    expect(firstQueueCall(calls, 'in-progress')).toBe(calls[1]);
    expect(firstQueueCall(calls, 'closed')).toBe(calls[0]);
    expect(calls.map(item => item.id)).toEqual(['old-closed', 'assigned', 'waiting', 'connected', 'new-closed']);
  });

  it('falls back to retained history only when the filter allows it', () => {
    const calls = [call('first', 'CLOSED'), call('second', 'CLOSED')];
    expect(firstQueueCall(calls, 'all')).toBe(calls[0]);
    expect(firstQueueCall(calls, 'waiting')).toBeNull();
    expect(firstQueueCall(calls, 'in-progress')).toBeNull();
    expect(firstQueueCall([], 'all')).toBeNull();
  });

  it('distinguishes assignment and handoff checks from confirmed human audio', () => {
    expect(queueStateLabel(call('waiting', 'WAITING'))).toBe('Waiting');
    expect(queueStateLabel(call('assigned', 'CLAIMED', { conversationOwner: 'AI' }))).toBe('Assigned');
    expect(queueStateLabel(call('interrupted', 'CLAIMED', { conversationOwner: 'NONE' }))).toBe('Assigned');
    expect(queueStateLabel(call('handoff', 'CLAIMED', { conversationOwner: 'HANDOFF_PENDING' }))).toBe('Connecting');
    expect(queueStateLabel(call('connected', 'CONNECTED', { conversationOwner: 'NURSE' }))).toBe('Human connected');
    expect(queueStateLabel(call('closed', 'CLOSED', { conversationOwner: 'HANDOFF_PENDING' }))).toBe('Closed');
  });
});

describe('nurse queue time labels', () => {
  it.each([
    [-1, '<1m'], [0, '<1m'], [59_999, '<1m'], [60_000, '1m'], [299_999, '4m'],
    [3_599_999, '59m'], [3_600_000, '1h 0m'], [3_720_000, '1h 2m'],
    [86_399_999, '23h 59m'], [86_400_000, '1d 0h'], [93_600_000, '1d 2h'],
  ])('formats elapsed arrival age at %i milliseconds as %s', (elapsed, expected) => {
    expect(arrivalAge(1_000_000, 1_000_000 + elapsed)).toBe(expected);
  });

  it.each([
    [-1, '0:00'], [0, '0:00'], [1, '0:01'], [1000, '0:01'], [1001, '0:02'],
    [59_000, '0:59'], [59_001, '1:00'], [60_000, '1:00'], [600_000, '10:00'],
  ])('formats remaining session time at %i milliseconds as %s', (remaining, expected) => {
    expect(sessionRemaining(1_000_000 + remaining, 1_000_000)).toBe(expected);
  });
});
