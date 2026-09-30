import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallSnapshot, TranscriptTurn } from '@nursebridge/contracts';
import type { Env } from '../src/env';
import type { CallState } from '../src/state';
import worker from '../src/index';
import { liveActivationIssues } from '../src/providers/readiness';
import { ASSEMBLYAI_CHAT_URL, DEFAULT_ASSEMBLYAI_EXTRACTION_MODEL } from '../src/providers/assemblyai-llm';
import { DEFAULT_EXTRACTION_MODEL } from '../src/providers/nebius';
import schema from '../../../packages/database/migrations/0001_initial.sql?raw';

const bindings = env as unknown as Env;
const assemblyKey = 'fictional-assemblyai-selection-key';
const nebiusKey = 'fictional-nebius-unused-selection-key';
const workspaceId = 'llm-selection-workspace';
const callerId = 'llm-selection-caller';
const providerSessionId = 'llm-selection-session';
type Stub = ReturnType<Env['CALL_SESSIONS']['getByName']>;
type Internal = { env: Env; state: CallState; acceptTurn(turn: TranscriptTurn): Promise<void> };
const source: TranscriptTurn = { id: 'llm-selection:turn-0', sessionId: providerSessionId, order: 0, text: 'I am calling about a fictional sore elbow.', final: true, at: Date.now() };
const extracted = { facts: [{ field: 'reason', value: 'fictional sore elbow', rawWording: 'fictional sore elbow', status: 'reported', evidence: [{ turnId: source.id, quote: source.text }] }], nextQuestionId: 'onset' };
const completion = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(extracted) } }] });

beforeEach(async () => { await bindings.DB.exec(schema); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

function liveConfig(overrides: Partial<Env> = {}): Env {
  return {
    ...bindings,
    PROVIDER_MODE: 'live', FICTIONAL_LIVE_TEST: 'true', ALLOWED_ORIGINS: 'http://localhost:8787',
    LLM_PROVIDER: 'assemblyai', ASSEMBLYAI_API_KEY: assemblyKey, NEBIUS_API_KEY: undefined,
    VOICE_AGENT_ID: 'fictional-managed-agent', VOICE_AGENT_VERSION: 'fixture-v1',
    ...overrides,
  };
}
function rejectNebiusLookup(config: Env): Env {
  Object.defineProperty(config, 'NEBIUS_API_KEY', { get() { throw new Error('AssemblyAI selection must not consult the Nebius key'); }, configurable: true });
  return config;
}
async function health(config: Env) {
  const response = await worker.fetch(new Request('http://localhost/health'), config);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return response.json();
}
async function create(config: Env): Promise<Stub> {
  const callId = crypto.randomUUID();
  const stub = bindings.CALL_SESSIONS.getByName(callId);
  expect(await stub.initialize({ callId, workspaceId, callerParticipantId: callerId, mode: 'mock' })).toMatchObject({ ok: true });
  expect(await stub.command({ workspaceId, participantId: callerId, role: 'caller', commandId: crypto.randomUUID(), type: 'consent', payload: { accepted: true } })).toMatchObject({ ok: true });
  await runInDurableObject(stub, instance => {
    const internal = instance as unknown as Internal;
    internal.env = config;
    internal.state.mode = 'live';
    internal.state.providerSession = { status: 'active', id: providerSessionId };
  });
  return stub;
}
async function accept(stub: Stub): Promise<CallSnapshot> {
  await runInDurableObject(stub, async instance => { await (instance as unknown as Internal).acceptTurn(source); });
  const result = await stub.snapshot(workspaceId);
  if (!result.ok || !result.snapshot) throw new Error('Expected an authorized call snapshot');
  return result.snapshot as CallSnapshot;
}

// These fixtures exercise the real Worker/Durable Object dispatch with a bounded
// fake provider response; they never connect to a live audio or model service.
describe('runtime LLM provider selection', () => {
  it('makes managed voice and Gateway extraction locally ready with only the AssemblyAI key', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    const config = rejectNebiusLookup(liveConfig());
    expect(liveActivationIssues(config)).toEqual([]);
    const result = await health(config);
    expect(result).toMatchObject({
      configured: true, intakeConfigured: true, liveActivation: { ready: true, issues: [] },
      providers: {
        voiceAgent: { provider: 'assemblyai-voice-agent', llmProvider: 'assemblyai-managed', configured: true, verified: false },
        extraction: { provider: 'assemblyai-llm-gateway', model: DEFAULT_ASSEMBLYAI_EXTRACTION_MODEL, configured: true, verified: false },
      },
      recording: { retentionVerified: false, deletionVerified: false },
    });
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(assemblyKey);
  });
  it('does not substitute a Nebius key for a missing selected AssemblyAI key', async () => {
    const config = liveConfig({ ASSEMBLYAI_API_KEY: '', NEBIUS_API_KEY: nebiusKey });
    expect(liveActivationIssues(config)).toEqual(['assemblyai_key_missing']);
    expect(await health(config)).toMatchObject({ configured: false, intakeConfigured: false, providers: { extraction: { provider: 'assemblyai-llm-gateway', configured: false } } });
  });
  it('preserves the existing Nebius default and credential requirement when the selector is absent', async () => {
    const config = liveConfig({ LLM_PROVIDER: undefined });
    expect(liveActivationIssues(config)).toEqual(['nebius_key_missing']);
    expect(await health(config)).toMatchObject({ configured: false, intakeConfigured: false, providers: { extraction: { provider: 'nebius', model: DEFAULT_EXTRACTION_MODEL, configured: false } } });
  });
  it('rejects an unknown runtime selector even when both provider keys are present', async () => {
    const config = { ...liveConfig({ NEBIUS_API_KEY: nebiusKey }), LLM_PROVIDER: 'unknown-llm' } as unknown as Env;
    expect(liveActivationIssues(config)).toEqual(['llm_provider_invalid']);
    expect(await health(config)).toMatchObject({ configured: false, intakeConfigured: false, liveActivation: { ready: false, issues: ['llm_provider_invalid'] }, providers: { voiceAgent: { configured: false }, extraction: { configured: false } } });
  });
  it('dispatches actual draft extraction to the Gateway without reading the Nebius key', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completion());
    const stub = await create(rejectNebiusLookup(liveConfig()));
    const result = await accept(stub);
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(ASSEMBLYAI_CHAT_URL);
    expect(new Headers(init?.headers).get('Authorization')).toBe(assemblyKey);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(DEFAULT_ASSEMBLYAI_EXTRACTION_MODEL);
    expect(body.fallback_config).toEqual({ retry: false });
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('chat_template_kwargs');
    const input = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content);
    expect(input.turns).toEqual([source]);
    expect(result).toMatchObject({ conversationOwner: 'AI', provider: { warning: null }, providerSession: { status: 'active', lastFinalizedTurnId: source.id } });
    expect(result.facts).toEqual([expect.objectContaining(extracted.facts[0])]);
    expect(JSON.stringify(result)).not.toContain(assemblyKey);
  });
  it('fails before dispatch when the selected AssemblyAI credential is missing, without falling back', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completion());
    const stub = await create(liveConfig({ ASSEMBLYAI_API_KEY: '', NEBIUS_API_KEY: nebiusKey }));
    const result = await accept(stub);
    expect(request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ facts: [], conversationOwner: 'NONE', waitingReason: 'technical_failure', provider: { warning: 'extraction_configuration' } });
    expect(result.providerSession.lastFinalizedTurnId).toBeUndefined();
  });
  it('rejects unknown selection at the Durable Object boundary without using either provider', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completion());
    const config = { ...liveConfig({ NEBIUS_API_KEY: nebiusKey }), LLM_PROVIDER: 'unknown-llm' } as unknown as Env;
    const result = await accept(await create(config));
    expect(request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ facts: [], turns: [source], conversationOwner: 'NONE', waitingReason: 'technical_failure', provider: { warning: 'extraction_configuration' } });
    expect(result.providerSession.lastFinalizedTurnId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(assemblyKey);
    expect(JSON.stringify(result)).not.toContain(nebiusKey);
  });
  it('reports a Gateway failure without trying Nebius even when its key is available', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(`private ${assemblyKey}`, { status: 503 }));
    const result = await accept(await create(liveConfig({ NEBIUS_API_KEY: nebiusKey })));
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toBe(ASSEMBLYAI_CHAT_URL);
    expect(result).toMatchObject({ facts: [], conversationOwner: 'NONE', waitingReason: 'technical_failure', provider: { warning: 'extraction_http' } });
    expect(result.providerSession.lastFinalizedTurnId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(assemblyKey);
  });
});
