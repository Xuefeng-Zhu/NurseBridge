import type { CallSnapshot } from '@nursebridge/contracts';
import { ApiError } from './workspace-api';

type TakeoverOptions = {
  callId: string;
  participantId: string;
  isCurrent: () => boolean;
  read: () => Promise<CallSnapshot>;
  command: (type: 'claim' | 'takeover', revision: number) => Promise<CallSnapshot>;
  onSnapshot: (snapshot: CallSnapshot) => void;
};

/** A confirmed revision rejection is safe to retry once; an uncertain write is not. */
export async function recoverTakeover({ callId, participantId, isCurrent, read, command, onSnapshot }: TakeoverOptions) {
  const assertCurrent = () => { if (!isCurrent()) throw new DOMException('Call takeover was canceled.', 'AbortError'); };
  const validate = (snapshot: CallSnapshot) => {
    assertCurrent();
    if (snapshot.id !== callId) throw new ApiError(409, 'The selected call changed. Select it again to connect.');
    if (snapshot.queueState === 'CLOSED') throw new ApiError(409, 'This call has ended.', 'closed');
    if (snapshot.claim && snapshot.claim.participantId !== participantId && (snapshot.claim.expiresAt > Date.now() || snapshot.queueState === 'CONNECTED')) throw new ApiError(409, 'Another nurse has claimed this call.', 'already_claimed');
  };
  for (let attempt = 0; ; attempt++) {
    try {
      assertCurrent();
      const fresh = await read();
      validate(fresh);
      onSnapshot(fresh);
      const sameParticipant = fresh.claim?.participantId === participantId;
      // An established conversation keeps ownership even after its claim lease expires.
      if (sameParticipant && fresh.queueState === 'CONNECTED') return fresh;
      const owned = sameParticipant && fresh.claim!.expiresAt > Date.now();
      if (owned && fresh.conversationOwner === 'HANDOFF_PENDING') return fresh;
      const claimed = owned ? fresh : await command('claim', fresh.controlRevision);
      validate(claimed);
      return await command('takeover', claimed.controlRevision);
    } catch (reason) {
      if (attempt !== 0 || !isCurrent() || !(reason instanceof ApiError) || reason.status !== 409 || reason.code !== 'revision_conflict') throw reason;
    }
  }
}
