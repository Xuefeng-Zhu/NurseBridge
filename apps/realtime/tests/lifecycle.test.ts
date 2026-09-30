import { env, exports } from 'cloudflare:workers';
import { reset, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import schema from '../../../packages/database/migrations/0001_initial.sql?raw';
import type { Env } from '../src/env';
import type { CallState } from '../src/state';
import { AudioStreamKind, decodeAudioFrame, encodeAudioFrame } from '@nursebridge/audio-client/protocol';

const bindings = env as unknown as Env;
type Stub = ReturnType<Env['CALL_SESSIONS']['getByName']>;
type Participant = 'caller' | 'nurse';
const participantId = (role: Participant) => `${role}-a`;
const command = (type: string) => ({ workspaceId: 'workspace-a', participantId: 'nurse-a', role: 'nurse' as const, commandId: crypto.randomUUID(), type });
beforeEach(async () => { await bindings.DB.exec(schema); });
afterEach(async () => { await reset(); });

async function snapshot(stub: Stub): Promise<CallState> {
  const result = await stub.snapshot('workspace-a');
  if (!result.ok || !result.snapshot) throw new Error('Missing call snapshot');
  return result.snapshot as CallState;
}
async function settled(stub: Stub, predicate: (state: CallState) => boolean): Promise<CallState> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await snapshot(stub);
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Call lifecycle did not settle');
}
function event(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error(`Missing ${type}`)); }, 3000);
    const receive = (message: MessageEvent) => {
      if (typeof message.data !== 'string') return;
      const value = JSON.parse(message.data) as Record<string, unknown>;
      if (value.type !== type) return;
      clearTimeout(timeout); socket.removeEventListener('message', receive); resolve(value);
    };
    socket.addEventListener('message', receive);
  });
}
async function barrier(socket: WebSocket) {
  const heartbeat = event(socket, 'heartbeat');
  socket.send(JSON.stringify({ type: 'heartbeat' }));
  await heartbeat;
}
async function create() {
  const callId = crypto.randomUUID();
  const stub = bindings.CALL_SESSIONS.getByName(callId);
  expect(await stub.initialize({ callId, workspaceId: 'workspace-a', callerParticipantId: 'caller-a', mode: 'mock' })).toMatchObject({ ok: true });
  return { stub, callId };
}
async function connect(stub: Stub, callId: string, role: Participant) {
  const ticket = await stub.issueTicket({ workspaceId: 'workspace-a', participantId: participantId(role), role });
  if (!ticket.ok) throw new Error('Missing connection ticket');
  const response = await exports.default.fetch(`http://localhost/connect/${callId}`, { headers: { Upgrade: 'websocket', Origin: 'http://localhost:8787' } });
  const socket = response.webSocket!;
  socket.accept(); socket.binaryType = 'arraybuffer';
  const authenticated = event(socket, 'authenticated');
  socket.send(JSON.stringify({ type: 'auth', ticket: ticket.ticket }));
  await authenticated;
  return socket;
}
async function ready(socket: WebSocket, microphone = true, playback = true) {
  socket.send(JSON.stringify({ type: 'media-ready', microphone, playback }));
  await barrier(socket);
}
async function close(socket: WebSocket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  const closed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket did not close')), 3000);
    socket.addEventListener('close', () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
  socket.close(1000, 'Lifecycle regression');
  await closed;
}
async function relay(sender: WebSocket, recipient: WebSocket, state: CallState, sequence: number, streamKind: AudioStreamKind) {
  const received = new Promise<ArrayBuffer>((resolve, reject) => {
    const timeout = setTimeout(() => { recipient.removeEventListener('message', receive); reject(new Error('No relayed audio')); }, 3000);
    const receive = (message: MessageEvent) => {
      if (typeof message.data === 'string') return;
      clearTimeout(timeout); recipient.removeEventListener('message', receive); resolve(message.data as ArrayBuffer);
    };
    recipient.addEventListener('message', receive);
  });
  sender.send(encodeAudioFrame({ streamKind, sequence, sampleRate: 24000, controlEpoch: state.controlEpoch, generation: state.responseGeneration, responseId: 0, payload: new Uint8Array(2400) }));
  const frame = decodeAudioFrame(await received);
  expect(frame.streamKind).toBe(streamKind);
  recipient.send(JSON.stringify({ type: 'audio-ack', sequence: frame.sequence, streamKind, dropped: false }));
  await barrier(recipient);
}
async function beginHandoff(stub: Stub, caller: WebSocket) {
  expect(await stub.command(command('takeover'))).toMatchObject({ ok: true });
  const pending = await settled(stub, state => state.conversationOwner === 'HANDOFF_PENDING' && state.flushIssuedFor === state.handoff?.id);
  caller.send(JSON.stringify({ type: 'playback-flushed', controlEpoch: pending.controlEpoch, generation: pending.responseGeneration }));
  return settled(stub, state => Boolean(state.handoff?.callerFlushed));
}
async function proveHandoff(stub: Stub, caller: WebSocket, nurse: WebSocket, pending: CallState, sequence: number) {
  await relay(caller, nurse, pending, sequence, AudioStreamKind.Patient);
  expect(await snapshot(stub)).toMatchObject({ queueState: 'CLAIMED', handoff: { nurseHeard: true, callerHeard: false } });
  await relay(nurse, caller, pending, sequence, AudioStreamKind.Nurse);
  return settled(stub, state => state.queueState === 'CONNECTED');
}
async function humanCall() {
  const { stub, callId } = await create();
  expect(await stub.command(command('claim'))).toMatchObject({ ok: true });
  const caller = await connect(stub, callId, 'caller');
  const nurse = await connect(stub, callId, 'nurse');
  await ready(caller); await ready(nurse);
  const connected = await proveHandoff(stub, caller, nurse, await beginHandoff(stub, caller), 1);
  return { stub, callId, caller, nurse, connected };
}

describe('terminal recovery and human media lifecycle', () => {
  it.each(['caller', 'nurse', 'provider'] as const)('keeps a closed call terminal after recovering stale %s presence', async stale => {
    const { stub } = await create();
    if (stale === 'nurse') expect(await stub.command(command('claim'))).toMatchObject({ ok: true });
    expect(await stub.command(command('end'))).toMatchObject({ ok: true });
    await runInDurableObject(stub, (_instance, durable) => {
      const state = JSON.parse(durable.storage.sql.exec<{ body: string }>('SELECT body FROM active_state').one().body) as CallState;
      if (stale === 'provider') { state.provider.connected = true; state.providerSession.status = 'active'; }
      else { state.participants[stale] = true; state.mediaReady[stale] = true; }
      durable.storage.sql.exec('UPDATE active_state SET body=?', JSON.stringify(state));
    });
    await evictDurableObject(stub);
    expect(await snapshot(stub)).toMatchObject({ queueState: 'CLOSED', conversationOwner: 'NONE', aiStatus: 'stopped', participants: { caller: false, nurse: false }, mediaReady: { caller: false, nurse: false }, provider: { connected: false }, escalations: [], warnings: [] });
    expect(await stub.issueTicket({ workspaceId: 'workspace-a', participantId: 'caller-a', role: 'caller' })).toMatchObject({ ok: false, code: 'closed' });
    expect(await stub.command(command('claim'))).toMatchObject({ ok: false, code: 'closed' });
  });

  it.each([
    { role: 'caller', microphone: false, playback: true },
    { role: 'caller', microphone: true, playback: false },
    { role: 'nurse', microphone: false, playback: true },
    { role: 'nurse', microphone: true, playback: false },
  ] as const)('requires a new two-way handoff after $role readiness becomes $microphone/$playback', async ({ role, microphone, playback }) => {
    const { stub, caller, nurse, connected } = await humanCall();
    try {
      await ready(role === 'caller' ? caller : nurse, microphone, playback);
      const interrupted = await snapshot(stub);
      expect(interrupted).toMatchObject({ queueState: 'CLAIMED', conversationOwner: 'NONE', humanRequested: true, claim: { participantId: 'nurse-a' }, mediaReady: { [role]: false } });
      expect(interrupted.handoff).toBeUndefined();
      expect(interrupted.controlEpoch).toBeGreaterThan(connected.controlEpoch);
      await ready(role === 'caller' ? caller : nurse);
      expect(await snapshot(stub)).toMatchObject({ queueState: 'CLAIMED', conversationOwner: 'NONE' });
      expect(await stub.command(command('takeover'))).toMatchObject({ ok: true });
      const pending = await settled(stub, state => state.conversationOwner === 'HANDOFF_PENDING' && state.flushIssuedFor === state.handoff?.id);
      caller.send(JSON.stringify({ type: 'playback-flushed', controlEpoch: connected.controlEpoch, generation: connected.responseGeneration }));
      caller.send(JSON.stringify({ type: 'audio-ack', sequence: 1, streamKind: AudioStreamKind.Nurse, dropped: false }));
      nurse.send(JSON.stringify({ type: 'audio-ack', sequence: 1, streamKind: AudioStreamKind.Patient, dropped: false }));
      await barrier(caller); await barrier(nurse);
      expect(await snapshot(stub)).toMatchObject({ queueState: 'CLAIMED', handoff: { callerFlushed: false, callerHeard: false, nurseHeard: false } });
      caller.send(JSON.stringify({ type: 'playback-flushed', controlEpoch: pending.controlEpoch, generation: pending.responseGeneration }));
      await settled(stub, state => Boolean(state.handoff?.callerFlushed));
      expect(await proveHandoff(stub, caller, nurse, pending, 2)).toMatchObject({ conversationOwner: 'NURSE' });
    } finally { await close(caller); await close(nurse); }
  });

  it('requires fresh audio proof when a disconnected caller reconnects', async () => {
    const { stub, callId, caller, nurse, connected } = await humanCall();
    let replacement: WebSocket | undefined;
    try {
      await close(caller);
      expect(await settled(stub, state => !state.participants.caller)).toMatchObject({ queueState: 'CLAIMED', conversationOwner: 'NONE', mediaReady: { caller: false } });
      replacement = await connect(stub, callId, 'caller'); await ready(replacement);
      expect(await snapshot(stub)).toMatchObject({ queueState: 'CLAIMED', conversationOwner: 'NONE' });
      const pending = await beginHandoff(stub, replacement);
      expect(pending.controlEpoch).toBeGreaterThan(connected.controlEpoch);
      expect(await proveHandoff(stub, replacement, nurse, pending, 2)).toMatchObject({ conversationOwner: 'NURSE' });
    } finally { await close(caller); if (replacement) await close(replacement); await close(nurse); }
  });

  it.each(['caller', 'nurse'] as const)('preserves the connection while a healthy replacement %s socket remains', async role => {
    const { stub, callId, caller, nurse, connected } = await humanCall();
    const original = role === 'caller' ? caller : nurse;
    const replacement = await connect(stub, callId, role);
    try {
      await ready(replacement);
      await ready(original, false, true);
      expect(await snapshot(stub)).toMatchObject({ queueState: 'CONNECTED', conversationOwner: 'NURSE', controlEpoch: connected.controlEpoch, mediaReady: { [role]: true } });
      await close(original);
      expect(await snapshot(stub)).toMatchObject({ queueState: 'CONNECTED', conversationOwner: 'NURSE', controlEpoch: connected.controlEpoch, participants: { [role]: true }, mediaReady: { [role]: true } });
      await close(replacement);
      expect(await settled(stub, state => !state.participants[role])).toMatchObject({ queueState: 'CLAIMED', conversationOwner: 'NONE' });
    } finally { await close(caller); await close(nurse); await close(replacement); }
  });

  it.each(['caller', 'nurse'] as const)('does not mistake an unready replacement %s socket for a working audio path', async role => {
    const { stub, callId, caller, nurse } = await humanCall();
    const replacement = await connect(stub, callId, role);
    try {
      await close(role === 'caller' ? caller : nurse);
      expect(await snapshot(stub)).toMatchObject({ queueState: 'CLAIMED', conversationOwner: 'NONE', participants: { [role]: true }, mediaReady: { [role]: false } });
    } finally { await close(caller); await close(nurse); await close(replacement); }
  });

  it('discards partial handoff proof when a required audio path disappears', async () => {
    const { stub, callId } = await create();
    await stub.command(command('claim'));
    const caller = await connect(stub, callId, 'caller'), nurse = await connect(stub, callId, 'nurse');
    try {
      await ready(caller); await ready(nurse);
      const pending = await beginHandoff(stub, caller);
      await relay(caller, nurse, pending, 1, AudioStreamKind.Patient);
      expect(await snapshot(stub)).toMatchObject({ handoff: { nurseHeard: true, callerHeard: false } });
      await ready(nurse, true, false);
      const interrupted = await snapshot(stub);
      expect(interrupted).toMatchObject({ queueState: 'CLAIMED', conversationOwner: 'NONE' });
      expect(interrupted.handoff).toBeUndefined();
      await ready(nurse);
      await proveHandoff(stub, caller, nurse, await beginHandoff(stub, caller), 2);
    } finally { await close(caller); await close(nurse); }
  });
});
