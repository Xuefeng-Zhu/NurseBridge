import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallSnapshot, Extraction, FieldId, TranscriptTurn } from '@nursebridge/contracts';
import { DEFAULT_TEMPLATE } from '@nursebridge/intake-policy';
import type { Env } from '../src/env';
import type { CallState } from '../src/state';
import type { VoiceToolCall } from '../src/providers/voice-agent';
import schema from '../../../packages/database/migrations/0001_initial.sql?raw';

const bindings = env as unknown as Env;
type Stub = ReturnType<Env['CALL_SESSIONS']['getByName']>;
type Internal = {
  env: Env;
  state: CallState;
  acceptTurn(turn: TranscriptTurn): Promise<void>;
  handleVoiceTool(call: VoiceToolCall): Promise<unknown>;
  store: { commit(state: CallState, type: string, message: string): void };
};
type ExtractionInput = { currentQuestion: { id: string; field: FieldId; text: string } | null; turns: TranscriptTurn[] };
const workspaceId = 'extraction-workspace';
const participantId = 'extraction-caller';
const providerSessionId = 'extraction-provider';
const secretMarker = 'synthetic-provider-secret-must-not-escape';

beforeEach(async () => { await bindings.DB.exec(schema); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

function turn(order: number, text: string): TranscriptTurn {
  return { id: `${providerSessionId}:turn-${order}`, sessionId: providerSessionId, providerItemId: `turn-${order}`, order, text, final: true, at: Date.now(), timingAvailability: 'unavailable' };
}
function extraction(source: TranscriptTurn, field: FieldId, status: 'reported' | 'uncertain' = 'reported'): Extraction {
  return { facts: [{ field, value: source.text, rawWording: source.text, status, evidence: [{ turnId: source.id, quote: source.text }] }], nextQuestionId: null };
}
function completion(value: unknown, finishReason = 'stop'): Response {
  return Response.json({ choices: [{ finish_reason: finishReason, message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] });
}
function inputFrom(init?: RequestInit): ExtractionInput {
  const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
  return JSON.parse(body.messages.find(message => message.role === 'user')!.content) as ExtractionInput;
}
function tool(name: string, args: Record<string, unknown> = {}): VoiceToolCall {
  const callId = crypto.randomUUID();
  return { sessionId: providerSessionId, replyId: `reply-${callId}`, callId, name, arguments: args };
}
async function create(): Promise<Stub> {
  const stub = bindings.CALL_SESSIONS.getByName(crypto.randomUUID());
  expect(await stub.initialize({ callId: crypto.randomUUID(), workspaceId, callerParticipantId: participantId, mode: 'mock' })).toMatchObject({ ok: true });
  expect(await stub.command({ workspaceId, participantId, role: 'caller', commandId: crypto.randomUUID(), type: 'consent', payload: { accepted: true } })).toMatchObject({ ok: true });
  await runInDurableObject(stub, instance => {
    const internal = instance as unknown as Internal;
    internal.env = { ...internal.env, NEBIUS_API_KEY: secretMarker };
    internal.state.mode = 'live';
    internal.state.providerSession = { status: 'active', id: providerSessionId };
  });
  return stub;
}
async function accept(stub: Stub, source: TranscriptTurn): Promise<void> {
  await runInDurableObject(stub, async instance => { await (instance as unknown as Internal).acceptTurn(source); });
}
async function register(stub: Stub, field: FieldId): Promise<void> {
  await runInDurableObject(stub, async instance => {
    expect(await (instance as unknown as Internal).handleVoiceTool(tool('register_question', { field }))).toMatchObject({ ok: true, field });
  });
}
async function snapshot(stub: Stub): Promise<CallSnapshot> {
  const result = await stub.snapshot(workspaceId);
  if (!result.ok || !result.snapshot) throw new Error('Expected an authorized call snapshot');
  return result.snapshot as CallSnapshot;
}
const reason = turn(0, 'I am calling about a fictional headache.');
const onset = turn(1, 'It started yesterday.');
const location = turn(2, 'Uh, yeah, I noticed maybe behind my head.');
async function seedPriorFacts(stub: Stub): Promise<void> {
  await register(stub, 'reason');
  await accept(stub, reason);
  await register(stub, 'onset');
  await accept(stub, onset);
  await register(stub, 'location');
}
function priorExtraction(source: TranscriptTurn): Extraction {
  return extraction(source, source.id === reason.id ? 'reason' : 'onset');
}

describe('live extraction in the Durable Object', () => {
  it('preserves reason and onset while repairing uncertain location and permits only one clarification', async () => {
    let locationAttempts = 0;
    const inputs: ExtractionInput[] = [];
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const input = inputFrom(init); inputs.push(input);
      const latest = input.turns.at(-1)!;
      if (latest.order < 2) return completion(priorExtraction(latest));
      const status = latest.id === location.id && locationAttempts++ === 0 ? 'reported' : 'uncertain';
      return completion(extraction(latest, 'location', status));
    });
    const stub = await create();
    await seedPriorFacts(stub);
    const prior = await snapshot(stub);
    await accept(stub, location);
    const clarified = await snapshot(stub);
    expect(clarified.facts.filter(fact => fact.field !== 'location')).toEqual(prior.facts);
    expect(clarified.facts.find(fact => fact.field === 'location')).toMatchObject({ value: location.text, status: 'uncertain' });
    expect(clarified).toMatchObject({ conversationOwner: 'AI', providerSession: { lastFinalizedTurnId: location.id }, collection: { location: { status: 'awaiting_clarification' } } });
    expect(clarified.escalations).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(4);
    const question = DEFAULT_TEMPLATE.questions.find(question => question.field === 'location')!;
    expect(inputs.at(-1)?.currentQuestion).toEqual({ id: question.id, field: question.field, text: question.text });
    await register(stub, 'location');
    const stillUncertain = turn(3, 'I am still not sure.');
    await accept(stub, stillUncertain);
    const waiting = await snapshot(stub);
    expect(waiting.facts.filter(fact => fact.field !== 'location')).toEqual(prior.facts);
    expect(waiting).toMatchObject({ waitingReason: 'unresolved_answer', conversationOwner: 'NONE', humanRequested: true, providerSession: { lastFinalizedTurnId: stillUncertain.id }, collection: { location: { status: 'unresolved', clarificationCount: 1 } } });
    expect(waiting.askedQuestions.filter(id => id === question.id)).toHaveLength(2);
    expect(waiting.turns).toHaveLength(4);
    expect(waiting.escalations).toEqual([expect.objectContaining({ reason: 'unresolved_answer' })]);
  });

  it('keeps prior validated facts and the new transcript when evidence repair is exhausted', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const latest = inputFrom(init).turns.at(-1)!;
      if (latest.order < 2) return completion(priorExtraction(latest));
      const invalid = extraction(latest, 'location', 'uncertain');
      invalid.facts[0]!.value = 'invented location absent from caller evidence';
      return completion(invalid);
    });
    const stub = await create();
    await seedPriorFacts(stub);
    const prior = await snapshot(stub);
    await accept(stub, location);
    const failed = await snapshot(stub);
    expect(failed.facts).toEqual(prior.facts);
    expect(failed.factRevisions).toEqual(prior.factRevisions);
    expect(failed.turns.at(-1)).toEqual(location);
    expect(failed).toMatchObject({ waitingReason: 'technical_failure', conversationOwner: 'NONE', humanRequested: true, provider: { warning: 'extraction_evidence' }, providerSession: { status: 'failed', lastFinalizedTurnId: onset.id } });
    expect(request).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(failed)).not.toContain('invented location');
    expect(JSON.stringify(failed)).not.toContain(secretMarker);
    expect(await stub.issueTicket({ workspaceId, participantId, role: 'caller' })).toMatchObject({ ok: true });
    await runInDurableObject(stub, async instance => {
      expect(await (instance as unknown as Internal).handleVoiceTool(tool('get_intake_progress'))).toEqual({ error: 'inactive_session' });
    });
  });

  it('discards a canceled stale extraction without failing or overwriting the newer finalized turn', async () => {
    let announceStarted!: () => void;
    const started = new Promise<void>(resolve => { announceStarted = resolve; });
    const corrected = turn(3, 'I notice it behind my head.');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const latest = inputFrom(init).turns.at(-1)!;
      if (latest.order < 2) return completion(priorExtraction(latest));
      if (latest.id === location.id) return await new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error(secretMarker)), { once: true });
        announceStarted();
      });
      return completion(extraction(latest, 'location'));
    });
    const stub = await create();
    await seedPriorFacts(stub);
    const prior = await snapshot(stub);
    await runInDurableObject(stub, async instance => {
      const internal = instance as unknown as Internal;
      const pending = internal.acceptTurn(location);
      await started;
      await internal.acceptTurn(corrected);
      await pending;
    });
    const updated = await snapshot(stub);
    expect(updated).toMatchObject({ conversationOwner: 'AI', providerSession: { status: 'active', lastFinalizedTurnId: corrected.id } });
    expect(updated.facts.filter(fact => fact.field !== 'location')).toEqual(prior.facts);
    expect(updated.facts.find(fact => fact.field === 'location')).toMatchObject({ value: corrected.text, status: 'reported', revision: 1 });
    expect(updated.turns).toEqual([reason, onset, location, corrected]);
    expect(updated.escalations).toHaveLength(0);
    expect(updated.provider.warning).toBeNull();
    expect(JSON.stringify(updated)).not.toContain(secretMarker);
  });

  it.each([
    ['http', () => new Response(secretMarker, { status: 429 })],
    ['response_invalid', () => new Response(secretMarker)],
    ['incomplete', () => completion({ facts: [], nextQuestionId: null }, 'length')],
    ['schema', () => completion({ facts: secretMarker, nextQuestionId: null })],
  ] as const)('records a safe extraction_%s diagnosis without admitting invalid data', async (code, response) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
    const stub = await create();
    await register(stub, 'reason');
    await accept(stub, reason);
    const failed = await snapshot(stub);
    expect(failed).toMatchObject({ provider: { warning: `extraction_${code}` }, providerSession: { status: 'failed' }, waitingReason: 'technical_failure', conversationOwner: 'NONE', facts: [] });
    expect(failed.providerSession.lastFinalizedTurnId).toBeUndefined();
    expect(failed.turns).toEqual([reason]);
    expect(JSON.stringify(failed)).not.toContain(secretMarker);
  });

  it('reports an atomic draft storage failure separately and preserves the prior evidence watermark', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const latest = inputFrom(init).turns.at(-1)!;
      return completion(latest.order < 2 ? priorExtraction(latest) : extraction(latest, 'location', 'uncertain'));
    });
    const stub = await create();
    await seedPriorFacts(stub);
    const prior = await snapshot(stub);
    await runInDurableObject(stub, async instance => {
      const internal = instance as unknown as Internal;
      const commit = internal.store.commit.bind(internal.store);
      let failed = false;
      const intercepted = vi.spyOn(internal.store, 'commit').mockImplementation((state, type, message) => {
        if (type === 'draft-revised' && !failed) { failed = true; throw new Error(secretMarker); }
        return commit(state, type, message);
      });
      try { await internal.acceptTurn(location); } finally { intercepted.mockRestore(); }
    });
    const failed = await snapshot(stub);
    expect(failed.facts).toEqual(prior.facts);
    expect(failed.factRevisions).toEqual(prior.factRevisions);
    expect(failed).toMatchObject({ provider: { warning: 'intake_storage_failed' }, providerSession: { status: 'failed', lastFinalizedTurnId: onset.id }, waitingReason: 'technical_failure', conversationOwner: 'NONE' });
    expect(failed.turns.at(-1)).toEqual(location);
    expect(JSON.stringify(failed)).not.toContain(secretMarker);
  });
});
