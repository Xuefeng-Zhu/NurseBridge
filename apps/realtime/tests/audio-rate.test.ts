import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../packages/database/migrations/0001_initial.sql?raw';
import { AudioStreamKind, encodeAudioFrame } from '@nursebridge/audio-client/protocol';
import type { Env } from '../src/env';
import type { CallState } from '../src/state';

const bindings = env as unknown as Env;
type Attachment = {
  authenticated: boolean; role: 'caller'; participantId: string; expiresAt: number;
  lastHeartbeat: number; mediaReady: boolean; lastSequence: number; pending: [];
  transport?: 'phone';
};
type Internal = { state: CallState; receiveAudio(socket: WebSocket, attachment: Attachment, bytes: ArrayBuffer): Promise<void> };
beforeEach(async () => { await bindings.DB.exec(schema); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function exercise(run: (internal: Internal, now: number) => Promise<void>) {
  const callId = crypto.randomUUID(), stub = bindings.CALL_SESSIONS.getByName(callId);
  expect(await stub.initialize({ callId, workspaceId: 'workspace-a', callerParticipantId: 'caller-a', mode: 'mock' })).toMatchObject({ ok: true });
  await runInDurableObject(stub, instance => run(instance as unknown as Internal, Date.now()));
}
function sender(internal: Internal, now: number, transport?: 'phone') {
  let attachment: Attachment = { authenticated: true, role: 'caller', participantId: 'caller-a', expiresAt: now + 600000, lastHeartbeat: now, mediaReady: true, lastSequence: -1, pending: [], ...(transport ? { transport } : {}) };
  const socket = {
    send: vi.fn(), close: vi.fn(),
    serializeAttachment: (value: Attachment) => { attachment = structuredClone(value); },
    deserializeAttachment: () => structuredClone(attachment),
  };
  const frame = (sequence: number, epoch = internal.state.controlEpoch, bytes = 2400) => encodeAudioFrame({ streamKind: AudioStreamKind.Patient, sequence, sampleRate: 24000, controlEpoch: epoch, generation: internal.state.responseGeneration, responseId: 0, payload: new Uint8Array(bytes) });
  return {
    socket,
    send: (sequence: number, epoch?: number, bytes?: number) => internal.receiveAudio(socket as unknown as WebSocket, socket.deserializeAttachment(), frame(sequence, epoch, bytes)),
  };
}

describe('bounded microphone arrival jitter', () => {
  it.each((['browser', 'phone'] as const).flatMap(transport => [0, 1, 49].map(arrivalDelay => ({ transport, arrivalDelay }))))('accepts 20fps capture after a delayed backlog plus $arrivalDelay ms arrival phase on $transport transport', async ({ transport, arrivalDelay }) => {
    await exercise(async (internal, start) => {
      const clock = vi.spyOn(Date, 'now'), peer = sender(internal, start, transport === 'phone' ? transport : undefined);
      try {
        // Capture is always one 50ms frame at a time. Delivery pauses for one
        // second, releases its bounded backlog, then resumes normal cadence.
        for (let sequence = 1; sequence <= 20; sequence++) {
          clock.mockReturnValue(start + sequence * 50); await peer.send(sequence);
        }
        // The last delayed frame was captured at2000ms. Its delivery can land
        // just before the next ordinary capture at2050ms, not exactly in phase.
        clock.mockReturnValue(start + 2000 + arrivalDelay);
        for (let sequence = 21; sequence <= 40; sequence++) await peer.send(sequence);
        for (let sequence = 41; sequence <= 60; sequence++) {
          clock.mockReturnValue(start + 2000 + (sequence - 40) * 50); await peer.send(sequence);
        }
        expect(peer.socket.close).not.toHaveBeenCalled();
        expect(peer.socket.deserializeAttachment().lastSequence).toBe(60);
      } finally { clock.mockRestore(); }
    });
  });

  it.each(['browser', 'phone'] as const)('rejects an excessive immediate burst and sustained faster capture on %s transport', async transport => {
    await exercise(async (internal, start) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
      try {
        const burst = sender(internal, start, transport === 'phone' ? transport : undefined);
        for (let sequence = 1; sequence <= 21; sequence++) await burst.send(sequence);
        expect(burst.socket.close).not.toHaveBeenCalled();
        await burst.send(22);
        expect(burst.socket.close).toHaveBeenCalledExactlyOnceWith(1008, 'Audio rate exceeded');
        const fast = sender(internal, start, transport === 'phone' ? transport : undefined);
        for (let sequence = 1; sequence <= 42; sequence++) {
          clock.mockReturnValue(start + (sequence - 1) * 25); await fast.send(sequence);
        }
        expect(fast.socket.close).toHaveBeenCalledExactlyOnceWith(1008, 'Audio rate exceeded');
      } finally { clock.mockRestore(); }
    });
  });

  it('does not accumulate more than the 20-frame backlog plus one phase frame while idle', async () => {
    await exercise(async (internal, start) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start), peer = sender(internal, start);
      try {
        await peer.send(1);
        clock.mockReturnValue(start + 10000);
        for (let sequence = 2; sequence <= 22; sequence++) await peer.send(sequence);
        expect(peer.socket.close).not.toHaveBeenCalled();
        await peer.send(23);
        expect(peer.socket.close).toHaveBeenCalledExactlyOnceWith(1008, 'Audio rate exceeded');
      } finally { clock.mockRestore(); }
    });
  });

  it('does not mint credit when the wall clock moves backward and catches up', async () => {
    await exercise(async (internal, start) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start), peer = sender(internal, start);
      try {
        for (let sequence = 1; sequence <= 10; sequence++) await peer.send(sequence);
        clock.mockReturnValue(start - 500); await peer.send(11);
        clock.mockReturnValue(start);
        for (let sequence = 12; sequence <= 21; sequence++) await peer.send(sequence);
        expect(peer.socket.close).not.toHaveBeenCalled();
        await peer.send(22);
        expect(peer.socket.close).toHaveBeenCalledExactlyOnceWith(1008, 'Audio rate exceeded');
      } finally { clock.mockRestore(); }
    });
  });

  it('keeps the budget across epoch changes and ignores replayed or stale-epoch frames', async () => {
    await exercise(async (internal, start) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start), peer = sender(internal, start);
      try {
        for (let sequence = 1; sequence <= 10; sequence++) await peer.send(sequence);
        for (let repeat = 0; repeat < 40; repeat++) { await peer.send(10); await peer.send(11, internal.state.controlEpoch + 1); }
        internal.state.controlEpoch++;
        for (let sequence = 11; sequence <= 21; sequence++) await peer.send(sequence);
        expect(peer.socket.close).not.toHaveBeenCalled();
        await peer.send(22);
        expect(peer.socket.close).toHaveBeenCalledExactlyOnceWith(1008, 'Audio rate exceeded');
      } finally { clock.mockRestore(); }
    });
  });

  it('gives replacement sockets an independent but still bounded capture allowance', async () => {
    await exercise(async (internal, start) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
      try {
        const original = sender(internal, start), replacement = sender(internal, start);
        for (let sequence = 1; sequence <= 21; sequence++) { await original.send(sequence); await replacement.send(sequence); }
        expect(original.socket.close).not.toHaveBeenCalled();
        expect(replacement.socket.close).not.toHaveBeenCalled();
        await replacement.send(22);
        expect(replacement.socket.close).toHaveBeenCalledExactlyOnceWith(1008, 'Audio rate exceeded');
        await original.send(22);
        expect(original.socket.close).toHaveBeenCalledExactlyOnceWith(1008, 'Audio rate exceeded');
      } finally { clock.mockRestore(); }
    });
  });

  it('still rejects malformed frame lengths before allowing any audio', async () => {
    await exercise(async (internal, start) => {
      const peer = sender(internal, start);
      await peer.send(1, internal.state.controlEpoch, 2398);
      expect(peer.socket.close).toHaveBeenCalledExactlyOnceWith(1008, 'Expected 50 ms mono PCM16 at 24 kHz');
      expect(peer.socket.deserializeAttachment().lastSequence).toBe(-1);
    });
  });
});
