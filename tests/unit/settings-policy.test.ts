import { describe, expect, it } from 'vitest';
import { automatedIntakeAllowed, workspacePreferences } from '../../packages/contracts/src';
import { newState, transition } from '../../apps/realtime/src/state';

describe('workspace intake policy', () => {
  it('preserves legacy defaults and enforces the recording preference for live intake', () => {
    const preferences = workspacePreferences({ recordingAllowed: false });
    expect(preferences.retentionDays).toBe(7);
    expect(automatedIntakeAllowed(preferences, 'mock')).toBe(true);
    expect(automatedIntakeAllowed(preferences, 'live')).toBe(false);
    const state = newState({ callId: 'call-test', workspaceId: 'workspace', callerParticipantId: 'caller', mode: 'live', workspacePreferences: preferences });
    expect(() => transition(state, { workspaceId: 'workspace', participantId: 'caller', role: 'caller', commandId: crypto.randomUUID(), type: 'consent', payload: { accepted: true } }, Date.now())).toThrow('Automated intake is disabled');
    expect(state.consent).toBe(false);
  });
});
