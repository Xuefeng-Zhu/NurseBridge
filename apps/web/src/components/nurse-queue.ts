import type { CallSnapshot } from '@nursebridge/contracts';

export type QueueFilter = 'all' | 'waiting' | 'in-progress' | 'closed';

export const QUEUE_FILTERS = [
  { value: 'all', label: 'All calls' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'closed', label: 'Closed' },
] as const satisfies readonly { value: QueueFilter; label: string }[];

type QueueCall = Pick<CallSnapshot, 'queueState'>;

/** Only the authoritative queue state determines a call's group. */
export function queueGroup(call: QueueCall): Exclude<QueueFilter, 'all'> {
  switch (call.queueState) {
    case 'WAITING': return 'waiting';
    case 'CLAIMED':
    case 'CONNECTED': return 'in-progress';
    case 'CLOSED': return 'closed';
  }
}

export function matchesQueueFilter(call: QueueCall, filter: QueueFilter): boolean {
  return filter === 'all' || queueGroup(call) === filter;
}

export function queueCounts(calls: readonly QueueCall[]): Record<QueueFilter, number> {
  const counts: Record<QueueFilter, number> = { all: calls.length, waiting: 0, 'in-progress': 0, closed: 0 };
  for (const call of calls) counts[queueGroup(call)]++;
  return counts;
}

/** Input is in arrival order; prefer an open matching call before retained history. */
export function firstQueueCall(calls: readonly CallSnapshot[], filter: QueueFilter): CallSnapshot | null {
  let firstClosed: CallSnapshot | null = null;
  for (const call of calls) {
    if (!matchesQueueFilter(call, filter)) continue;
    if (call.queueState !== 'CLOSED') return call;
    firstClosed ??= call;
  }
  return firstClosed;
}

export function queueStateLabel(call: Pick<CallSnapshot, 'queueState' | 'conversationOwner'>): string {
  switch (call.queueState) {
    case 'WAITING': return 'Waiting';
    case 'CLAIMED': return call.conversationOwner === 'HANDOFF_PENDING' ? 'Connecting' : 'Assigned';
    case 'CONNECTED': return 'Human connected';
    case 'CLOSED': return 'Closed';
  }
}

export function arrivalAge(createdAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function sessionRemaining(deadline: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
