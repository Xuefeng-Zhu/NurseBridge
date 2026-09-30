import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallCommand, CallSnapshot, IntakeTemplate, TranscriptTurn } from '@nursebridge/contracts';
import { AudioStreamKind } from '@nursebridge/audio-client/protocol';
import type { Env } from '../src/env';
import type { CallState } from '../src/state';
import type { VoiceAgent, VoiceToolCall } from '../src/providers/voice-agent';
import schema from '../../../packages/database/migrations/0001_initial.sql?raw';

const bindings = env as unknown as Env;
type Stub = ReturnType<Env['CALL_SESSIONS']['getByName']>;
type ReplyState = { epoch: number; generation: number; responseId: number; startedAt: number; playbackMeasured: boolean; audioReadyMeasured?: boolean };
type Internal = {
  env: Env;
  state: CallState;
  voice?: VoiceAgent;
  voiceReplies: Map<string, ReplyState>;
  voiceQueue: { pcm: Uint8Array; replyId: string }[];
  voiceQueueBytes: number;
  voiceDrain: boolean;
  currentSpeech?: ReplyState;
  checkpoint(): void;
  startIntake(): Promise<void>;
  providerFailure(code: string): void;
  handleVoiceTool(call: VoiceToolCall): Promise<unknown>;
  cleanupProviderSessions(): Promise<void>;
  eraseContent(): Promise<void>;
  finishVoiceReply(replyId: string, status: 'completed' | 'interrupted'): Promise<void>;
  enqueueVoiceAudio(pcm: Uint8Array, replyId: string): void;
  drainVoiceAudio(): Promise<void>;
};

beforeEach(async () => { await bindings.DB.exec(schema); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function create(template?: IntakeTemplate) {
  const callId = crypto.randomUUID();
  const stub = bindings.CALL_SESSIONS.getByName(callId);
  expect(await stub.initialize({ callId, workspaceId: 'voice-workspace', callerParticipantId: 'voice-caller', mode: 'mock', template })).toMatchObject({ ok: true });
  return { callId, stub };
}
const command = (type: string, payload?: Record<string, unknown>): CallCommand => ({
  workspaceId: 'voice-workspace', participantId: 'voice-caller', role: 'caller', commandId: crypto.randomUUID(), type, payload,
});
async function snapshot(stub: Stub): Promise<CallSnapshot> {
  const result = await stub.snapshot('voice-workspace');
  if (!result.ok || !result.snapshot) throw new Error('Expected an authorized snapshot');
  return result.snapshot as CallSnapshot;
}
async function settled(stub: Stub, predicate: (value: CallSnapshot) => boolean): Promise<CallSnapshot> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await snapshot(stub);
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Voice session did not reach the expected state');
}
async function fixture(stub: Stub, text: string) {
  expect(await stub.command(command('mock-turn', { text }))).toMatchObject({ ok: true });
}
function nextMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${type} message`)), 3000);
    const listener = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      const body = JSON.parse(event.data) as Record<string, unknown>;
      if (body.type !== type) return;
      clearTimeout(timer); socket.removeEventListener('message', listener); resolve(body);
    };
    socket.addEventListener('message', listener);
  });
}
async function connectCaller(stub: Stub, callId: string) {
  const ticket = await stub.issueTicket({ workspaceId: 'voice-workspace', participantId: 'voice-caller', role: 'caller' });
  if (!ticket.ok) throw new Error('Expected a caller ticket');
  const response = await exports.default.fetch(`http://localhost/connect/${callId}`, { headers: { Upgrade: 'websocket', Origin: 'http://localhost:8787' } });
  const socket = response.webSocket!;
  socket.accept();
  const authenticated = nextMessage(socket, 'authenticated');
  socket.send(JSON.stringify({ type: 'auth', ticket: ticket.ticket }));
  await authenticated;
  return socket;
}
function tool(name: string, args: Record<string, unknown> = {}, callId = crypto.randomUUID()): VoiceToolCall {
  return { sessionId: 'provider-session', replyId: `fc-${callId}`, callId, name, arguments: args };
}
const callerTurn = (id = 'provider-session:item-one'): TranscriptTurn => ({ id, sessionId: 'provider-session', providerItemId: 'item-one', order: 0, text: 'It started yesterday.', final: true, at: Date.now(), timingAvailability: 'unavailable' });

describe('Voice Agent collection and waiting in the Durable Object', () => {
  it('uses edited opening, acknowledgment, and question order and completes only the selected fields', async () => {
    const template: IntakeTemplate = {
      id: 'custom-intake', version: 4, name: 'Custom intake', opening: 'Welcome to the configured sample intake.',
      acknowledgments: ['I captured your answer.', 'Thank you for that detail.', 'The selected questions are captured.'],
      questions: [
        { id: 'symptoms', field: 'symptoms', text: 'What other concerns should we note?' },
        { id: 'callback', field: 'callback', text: 'Which sample callback number should we note?' },
        { id: 'onset', field: 'onset', text: 'What day did this begin?' },
      ],
    };
    const { stub } = await create(template);
    await stub.command(command('consent', { accepted: true }));
    await runInDurableObject(stub, async instance => {
      const internal = instance as unknown as Internal;
      internal.state.mediaReady.caller = true;
      await internal.startIntake();
    });
    const opened = await snapshot(stub);
    expect(opened.currentQuestion).toBe('symptoms');
    expect(opened.assistantTurns.at(-1)?.text).toBe('Welcome to the configured sample intake. What other concerns should we note?');
    await fixture(stub, 'No other concerns.');
    const callback = await settled(stub, value => value.currentQuestion === 'callback');
    expect(callback.assistantTurns.at(-1)?.text).toBe('I captured your answer. Which sample callback number should we note?');
    await fixture(stub, 'My sample callback is 555-0100. I took a tablet.');
    const onset = await settled(stub, value => value.currentQuestion === 'onset');
    expect(onset.assistantTurns.at(-1)?.text).toBe('Thank you for that detail. What day did this begin?');
    expect(onset.facts.some(fact => fact.field === 'medications')).toBe(false);
    await fixture(stub, 'Last Friday.');
    const finished = await settled(stub, value => value.waitingReason === 'intake_complete');
    expect(finished.askedQuestions).toEqual(['symptoms', 'callback', 'onset']);
    expect(finished.facts.map(fact => fact.field)).toEqual(['symptoms', 'callback', 'onset']);
    expect(finished.collection.reason.status).toBe('unasked');
    expect(finished.assistantTurns.at(-1)?.text).toBe('The selected questions are captured. Intake complete — waiting for a nurse.');
    expect(finished).toMatchObject({ template, intakeState: 'CAPTURED', conversationOwner: 'NONE' });
  });

  it('keeps existing call templates pinned through initialization retries and eviction', async () => {
    const original: IntakeTemplate = { id: 'custom-intake', version: 2, name: 'Original template', opening: 'Original opening.', acknowledgments: ['Original thanks.'], questions: [{ id: 'callback', field: 'callback', text: 'Original callback question?' }] };
    const { stub, callId } = await create(original);
    const updated: IntakeTemplate = { ...original, version: 3, opening: 'Updated opening.', questions: [{ id: 'onset', field: 'onset', text: 'Updated onset question?' }] };
    expect(await stub.initialize({ callId, workspaceId: 'voice-workspace', callerParticipantId: 'voice-caller', mode: 'mock', template: updated })).toMatchObject({ ok: true, snapshot: { template: original } });
    await evictDurableObject(stub);
    expect((await snapshot(stub)).template).toEqual(original);
    const next = await create(updated);
    expect((await snapshot(next.stub)).template).toEqual(updated);
  });

  it('clarifies an unknown answer once, then hands off without losing arrival or evidence', async () => {
    const { stub } = await create();
    const arrived = await snapshot(stub);
    await stub.command(command('consent', { accepted: true }));
    await fixture(stub, 'I do not know.');
    const clarified = await settled(stub, value => value.collection.reason.clarificationCount === 1);
    expect(clarified.collection.reason.status).toBe('awaiting_clarification');
    expect(clarified.escalations).toHaveLength(0);
    await fixture(stub, 'I still do not know.');
    const waiting = await settled(stub, value => value.waitingReason === 'unresolved_answer');
    expect(waiting).toMatchObject({ createdAt: arrived.createdAt, queueState: 'WAITING', conversationOwner: 'NONE', humanRequested: true, intakeState: 'INTERRUPTED' });
    expect(waiting.collection.reason).toMatchObject({ status: 'unresolved', clarificationCount: 1 });
    expect(waiting.turns).toHaveLength(2);
    expect(waiting.facts[0]).toMatchObject({ status: 'unknown', revision: 2 });
    expect(waiting.escalations).toEqual([expect.objectContaining({ reason: 'unresolved_answer' })]);
    expect(await stub.command(command('consent', { accepted: true }))).toMatchObject({ ok: false, code: 'intake_stopped' });
  });

  it.each([
    ['This is an emergency.', 'caller_reported_emergency'],
    ['Can I speak to a nurse?', 'human_request'],
  ])('routes the explicit caller statement %s without continuing intake', async (text, reason) => {
    const {stub} = await create();
    await stub.command(command('consent', {accepted:true}));
    await fixture(stub, text);
    const value=await settled(stub, call=>call.waitingReason===reason);
    expect(value.conversationOwner).toBe('NONE');
    expect(value.turns[0]?.text).toBe(text);
    expect(value.escalations[0]?.reason).toBe(reason);
    expect(value.facts).toHaveLength(0);
    if(reason==='caller_reported_emergency')expect(value.warnings.join(' ')).toContain('contact emergency services');
  });

  it('accepts a corrected answer after clarification and continues with the next missing field', async () => {
    const { stub } = await create();
    await stub.command(command('consent', { accepted: true }));
    await fixture(stub, 'I am unsure.');
    await settled(stub, value => value.collection.reason.clarificationCount === 1);
    await fixture(stub, 'I am calling about a headache.');
    const continued = await settled(stub, value => value.collection.reason.status === 'answered' && value.currentQuestion === 'onset');
    expect(continued.waitingReason).toBeUndefined();
    expect(continued.conversationOwner).toBe('AI');
    expect(continued.facts.find(fact => fact.field === 'reason')).toMatchObject({ value: 'a headache', status: 'reported', revision: 2 });
    expect(continued.factRevisions.at(-1)?.previous?.status).toBe('uncertain');
    expect(continued.escalations).toHaveLength(0);
  });

  it('completes all eight fields, stops the provider, and keeps the caller socket available for a nurse', async () => {
    const { stub, callId } = await create();
    const socket = await connectCaller(stub, callId);
    let providerCloses = 0;
    try {
      await stub.command(command('consent', { accepted: true }));
      const responses = [
        ['reason', 'I am calling about a headache.'],
        ['onset', 'It started yesterday.'],
        ['location', 'It is mostly behind my eyes.'],
        ['severity', 'I would describe it as a dull ache.'],
        ['symptoms', 'No other symptoms.'],
        ['medications', 'I do not take medication.'],
        ['uncertainties', 'I have not measured my temperature.'],
      ] as const;
      for (const [field, text] of responses) {
        await fixture(stub, text);
        await settled(stub, value => value.collection[field].status === 'answered');
      }
      await runInDurableObject(stub, instance => {
        const internal = instance as unknown as Internal;
        internal.state.providerSession = { status: 'active', id: 'fixture-provider' };
        internal.state.provider.connected = true;
        internal.voice = { sessionId: 'fixture-provider', ready: true, send: () => true, interrupt: () => undefined, update: () => true, requestReply: () => true, close: () => { providerCloses++; } };
      });
      await fixture(stub, 'My fictional callback is 555-0100.');
      const waiting = await settled(stub, value => value.waitingReason === 'intake_complete');
      expect(waiting).toMatchObject({ intakeState: 'CAPTURED', conversationOwner: 'NONE', queueState: 'WAITING', humanRequested: false, providerSession: { status: 'ended' } });
      expect(Object.values(waiting.collection).every(field => field.status === 'answered')).toBe(true);
      expect(waiting.escalations).toHaveLength(0);
      expect(waiting.turns).toHaveLength(8);
      expect(providerCloses).toBe(1);
      const heartbeat = nextMessage(socket, 'heartbeat');
      socket.send(JSON.stringify({ type: 'heartbeat' }));
      expect(await heartbeat).toMatchObject({ type: 'heartbeat' });
      expect(await stub.issueTicket({ workspaceId: 'voice-workspace', participantId: 'nurse-a', role: 'nurse' })).toMatchObject({ ok: true });
      expect(await stub.command(command('consent', { accepted: true }))).toMatchObject({ ok: false, code: 'intake_stopped' });
    } finally { socket.close(); }
  });

  it('keeps live intake gated when recording controls and recording consent are missing', async () => {
    const { stub } = await create();
    const upstream = vi.spyOn(globalThis, 'fetch');
    await runInDurableObject(stub, instance => {
      const internal = instance as unknown as Internal;
      internal.state.mode = 'live';
      internal.env = { ...internal.env, PROVIDER_MODE: 'live', ASSEMBLYAI_API_KEY: 'fictional-key', NEBIUS_API_KEY: 'fictional-key', VOICE_AGENT_ID: 'agent-id', VOICE_AGENT_VERSION: 'v1', VOICE_AGENT_COMPATIBILITY_VERIFIED: 'true' };
      internal.checkpoint();
    });
    expect(await stub.command(command('consent', { accepted: true }))).toMatchObject({ ok: false, code: 'live_activation_blocked' });
    expect(upstream).not.toHaveBeenCalled();
    expect(await stub.command(command('consent', { accepted: false }))).toMatchObject({ ok: true, snapshot: { waitingReason: 'consent_refused', queueState: 'WAITING' } });
  });
});

describe('Durable Voice Agent tool authority', () => {
  it('returns approved wording and rejects removed or out-of-order questions from a custom template', async () => {
    const template: IntakeTemplate = { id: 'custom-intake', version: 2, name: 'Custom template', opening: 'Custom opening.', acknowledgments: ['Custom thanks.'], questions: [{ id: 'callback', field: 'callback', text: 'Custom callback question?' }, { id: 'onset', field: 'onset', text: 'Custom onset question?' }] };
    const { stub } = await create(template);
    await stub.command(command('consent', { accepted: true }));
    await runInDurableObject(stub, async instance => {
      const internal = instance as unknown as Internal;
      internal.state.providerSession = { status: 'active', id: 'provider-session' };
      expect(await internal.handleVoiceTool(tool('get_intake_progress'))).toMatchObject({ action: { type: 'question', field: 'callback', text: 'Custom callback question?' }, acknowledgment: '' });
      expect(await internal.handleVoiceTool(tool('register_question', { field: 'reason' }))).toMatchObject({ error: 'invalid_intake_action' });
      expect(await internal.handleVoiceTool(tool('register_question', { field: 'onset' }))).toMatchObject({ error: 'invalid_intake_action' });
      expect(await internal.handleVoiceTool(tool('register_question', { field: 'callback' }))).toEqual({ ok: true, field: 'callback', text: 'Custom callback question?' });
      internal.state.turns = [callerTurn('No other details.')];
      internal.state.providerSession.lastFinalizedTurnId = internal.state.turns[0]!.id;
      expect(await internal.handleVoiceTool(tool('get_intake_progress'))).toMatchObject({ acknowledgment: 'Custom thanks.' });
    });
  });

  it('registers a question once across retries and rejects changed reuse of its tool ID', async () => {
    const { stub } = await create();
    await stub.command(command('consent', { accepted: true }));
    await runInDurableObject(stub, async (instance, state) => {
      const internal = instance as unknown as Internal;
      internal.state.providerSession = { status: 'active', id: 'provider-session' };
      const call = tool('register_question', { field: 'reason' });
      const first = await internal.handleVoiceTool(call);
      const revision = internal.state.revision;
      expect(first).toMatchObject({ ok: true, field: 'reason' });
      expect(await internal.handleVoiceTool(call)).toEqual(first);
      expect(internal.state.revision).toBe(revision);
      expect(internal.state.askedQuestions).toEqual(['reason']);
      expect(await internal.handleVoiceTool({ ...call, arguments: { field: 'onset' } })).toEqual({ error: 'tool_id_reused' });
      expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM tool_receipts').one().count).toBe(1);
    });
  });

  it('rejects premature completion, unauthorized arguments, and tools from stale sessions', async () => {
    const { stub } = await create();
    await stub.command(command('consent', { accepted: true }));
    await runInDurableObject(stub, async instance => {
      const internal = instance as unknown as Internal;
      internal.state.providerSession = { status: 'active', id: 'provider-session' };
      expect(await internal.handleVoiceTool(tool('complete_intake'))).toMatchObject({ error: 'invalid_intake_action' });
      expect(await internal.handleVoiceTool(tool('register_question', { field: 'reason', role: 'admin', workspaceId: 'another-workspace' }))).toMatchObject({ error: 'invalid_intake_action' });
      expect(await internal.handleVoiceTool({ ...tool('get_intake_progress'), sessionId: 'stale-provider-session' })).toEqual({ error: 'inactive_session' });
      expect(await internal.handleVoiceTool(tool('claim', { participantId: 'attacker' }))).toMatchObject({ error: 'invalid_intake_action' });
      expect(internal.state).toMatchObject({ conversationOwner: 'AI', queueState: 'WAITING', workspaceId: 'voice-workspace' });
      expect(internal.state.claim).toBeUndefined();
    });
  });

  it('requires extraction through the latest finalized caller turn before returning progress', async () => {
    const { stub } = await create();
    await stub.command(command('consent', { accepted: true }));
    await runInDurableObject(stub, async instance => {
      const internal = instance as unknown as Internal;
      const turn = callerTurn();
      internal.state.providerSession = { status: 'active', id: 'provider-session' };
      internal.state.turns.push(turn);
      expect(await internal.handleVoiceTool(tool('get_intake_progress'))).toEqual({ error: 'unvalidated_turn' });
      internal.state.providerSession.lastFinalizedTurnId = turn.id;
      expect(await internal.handleVoiceTool(tool('get_intake_progress'))).toMatchObject({ action: { type: 'question', field: 'reason' } });
    });
  });

  it('rejects a handoff with unsupported caller evidence', async () => {
    const { stub } = await create();
    await stub.command(command('consent', { accepted: true }));
    await runInDurableObject(stub, async instance => {
      const internal = instance as unknown as Internal;
      const turn = callerTurn();
      internal.state.providerSession = { status: 'active', id: 'provider-session', lastFinalizedTurnId: turn.id };
      internal.state.turns.push(turn);
      expect(await internal.handleVoiceTool(tool('request_handoff', { reason: 'caller_reported_emergency', turnId: turn.id, quote: 'This is an emergency.' }))).toMatchObject({ error: 'invalid_intake_action' });
      expect(internal.state.escalations).toHaveLength(0);
    });
  });
});

describe('Voice provider recovery and deletion', () => {
  it('records first voice audio once per reply even when the provider sends many chunks', async () => {
    const { stub } = await create();
    await stub.command(command('consent', { accepted: true }));
    await runInDurableObject(stub, async instance => {
      const internal = instance as unknown as Internal;
      const before = internal.state.revision;
      const reply: ReplyState = { epoch: internal.state.controlEpoch, generation: internal.state.responseGeneration, responseId: 81, startedAt: Date.now(), playbackMeasured: false, audioReadyMeasured: false };
      internal.voiceReplies.set('chunked-reply', reply);
      internal.voiceQueue.push({ pcm: new Uint8Array(2400), replyId: 'chunked-reply' }, { pcm: new Uint8Array(2400), replyId: 'chunked-reply' });
      internal.voiceQueueBytes = 4800;
      await internal.drainVoiceAudio();
      expect(internal.state.revision).toBe(before + 1);
      expect(reply.audioReadyMeasured).toBe(true);
      expect(internal.voiceQueue).toHaveLength(0);
    });
  });

  it('flushes playback on interrupted reply completion even without an earlier speech-started event', async () => {
    const { stub, callId } = await create();
    const socket = await connectCaller(stub, callId);
    let binaryFrames = 0;
    socket.addEventListener('message', event => { if (typeof event.data !== 'string') binaryFrames++; });
    try {
      await stub.command(command('consent', { accepted: true }));
      const before = await snapshot(stub);
      const flushed = nextMessage(socket, 'flush');
      await runInDurableObject(stub, async (instance, durableState) => {
        const internal = instance as unknown as Internal;
        const reply: ReplyState = { epoch: before.controlEpoch, generation: before.responseGeneration, responseId: 71, startedAt: Date.now(), playbackMeasured: true };
        internal.state.aiStatus = 'speaking';
        internal.currentSpeech = reply;
        internal.voiceReplies.set('interrupted-reply', reply);
        // Hold an unsent chunk and an already sent frame. Only reply.done is
        // delivered: there is no input.speech.started callback in this case.
        internal.voiceDrain = true;
        internal.enqueueVoiceAudio(new Uint8Array(2400), 'interrupted-reply');
        for (const server of durableState.getWebSockets()) {
          const attachment = server.deserializeAttachment() as { authenticated: boolean; pending: { sequence: number; streamKind: number; responseId: number }[] };
          if (!attachment.authenticated) continue;
          attachment.pending.push({ sequence: 15, streamKind: AudioStreamKind.Agent, responseId: reply.responseId });
          server.serializeAttachment(attachment);
        }
        await internal.finishVoiceReply('interrupted-reply', 'interrupted');
        expect(internal.state.responseGeneration).toBe(before.responseGeneration + 1);
        expect(internal.state.controlEpoch).toBe(before.controlEpoch);
        expect(internal.state.aiStatus).toBe('listening');
        expect(internal.currentSpeech).toBeUndefined();
        expect(internal.voiceReplies.size).toBe(0);
        expect(internal.voiceQueue).toHaveLength(0);
        expect(internal.voiceQueueBytes).toBe(0);
        for (const server of durableState.getWebSockets()) {
          expect((server.deserializeAttachment() as { pending: unknown[] }).pending).toHaveLength(0);
        }
        internal.voiceDrain = false;
        internal.enqueueVoiceAudio(new Uint8Array(2400), 'interrupted-reply');
        expect(internal.voiceQueue).toHaveLength(0);
      });
      expect(await flushed).toMatchObject({ type: 'flush', reason: 'provider-interrupted', controlEpoch: before.controlEpoch, generation: before.responseGeneration + 1 });
      // A following message establishes an ordering boundary for the socket;
      // stale audio must not have been delivered before this heartbeat.
      const heartbeat = nextMessage(socket, 'heartbeat');
      socket.send(JSON.stringify({ type: 'heartbeat' }));
      await heartbeat;
      expect(binaryFrames).toBe(0);
    } finally { socket.close(); }
  });

  it('preserves caller evidence after provider failure and never automatically resumes intake', async () => {
    const { stub } = await create();
    await stub.command(command('consent', { accepted: true }));
    await fixture(stub, 'I am calling about a headache.');
    await settled(stub, value => value.collection.reason.status === 'answered');
    await runInDurableObject(stub, async instance => {
      const internal = instance as unknown as Internal;
      internal.providerFailure('synthetic_provider_disconnect');
      await internal.startIntake();
      expect(internal.voice).toBeUndefined();
    });
    const failed = await snapshot(stub);
    expect(failed).toMatchObject({ waitingReason: 'technical_failure', conversationOwner: 'NONE', humanRequested: true, providerSession: { status: 'failed' } });
    expect(failed.turns).toHaveLength(1);
    expect(failed.facts[0]?.value).toBe('a headache');
    expect(await stub.command(command('consent', { accepted: true }))).toMatchObject({ ok: false, code: 'intake_stopped' });
  });

  it('recovers an interrupted provider session after eviction with a human fallback', async () => {
    const { stub } = await create();
    await stub.command(command('consent', { accepted: true }));
    await runInDurableObject(stub, instance => {
      const internal = instance as unknown as Internal;
      internal.state.provider.connected = true;
      internal.state.providerSession = { status: 'active', id: 'provider-session' };
      internal.state.turns.push(callerTurn());
      internal.checkpoint();
    });
    await evictDurableObject(stub);
    const recovered = await snapshot(stub);
    expect(recovered).toMatchObject({ conversationOwner: 'NONE', waitingReason: 'technical_failure', humanRequested: true, providerSession: { status: 'interrupted' } });
    expect(recovered.turns).toHaveLength(1);
    expect(recovered.escalations).toEqual([expect.objectContaining({ reason: 'technical_failure' })]);
    expect(await stub.command(command('consent', { accepted: true }))).toMatchObject({ ok: false, code: 'intake_stopped' });
  });

  it('retains a content-free cleanup receipt on deletion failure and retries successfully', async () => {
    const { stub } = await create();
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await runInDurableObject(stub, async (instance, state) => {
      const internal = instance as unknown as Internal;
      internal.env = { ...internal.env, ASSEMBLYAI_API_KEY: 'fictional-cleanup-key' };
      state.storage.sql.exec('INSERT INTO provider_cleanup(session_id,expires_at) VALUES(?,?)', 'cleanup-session', 0);
      await internal.cleanupProviderSessions();
      const pending = state.storage.sql.exec<{ session_id: string; status: string; attempts: number }>('SELECT session_id,status,attempts FROM provider_cleanup').one();
      expect(pending).toEqual({ session_id: 'cleanup-session', status: 'pending_deletion', attempts: 1 });
      await internal.cleanupProviderSessions();
      expect(state.storage.sql.exec('SELECT session_id FROM provider_cleanup').toArray()).toHaveLength(0);
    });
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('cannot resurrect deleted case content when an in-flight provider cleanup finishes late', async () => {
    const { stub } = await create();
    let release!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    let requests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ++requests === 1 ? held : new Response(null, { status: 204 }));
    await runInDurableObject(stub, async (instance, state) => {
      const internal = instance as unknown as Internal;
      internal.env = { ...internal.env, ASSEMBLYAI_API_KEY: 'fictional-cleanup-key' };
      internal.state.turns.push(callerTurn());
      internal.state.assistantTurns.push({ id: 'assistant-item', sessionId: 'cleanup-session', replyId: 'reply-one', text: 'When did this start?', final: true, interrupted: false, at: Date.now() });
      state.storage.sql.exec('INSERT INTO provider_cleanup(session_id,expires_at) VALUES(?,?)', 'cleanup-session', 0);
      const inflight = internal.cleanupProviderSessions();
      await Promise.resolve();
      internal.state.deleted = true;
      internal.state.queueState = 'CLOSED';
      await internal.eraseContent();
      release(new Response(null, { status: 204 }));
      await inflight;
      expect(internal.state.turns).toHaveLength(0);
      expect(internal.state.assistantTurns).toHaveLength(0);
      expect(internal.state.deleted).toBe(true);
      expect(state.storage.sql.exec('SELECT session_id FROM provider_cleanup').toArray()).toHaveLength(0);
    });
    expect(await stub.snapshot('voice-workspace')).toMatchObject({ ok: false, status: 410 });
  });
});
