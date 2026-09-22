import { describe, expect, it, vi } from 'vitest';
import { extract, DEFAULT_EXTRACTION_MODEL, NEBIUS_CHAT_URL, type ProviderFetch } from '../src/providers/nebius';
import { providerHealth } from '../src/index';
import type { Env } from '../src/env';
import { DEFAULT_TEMPLATE, validateExtraction } from '@nursebridge/intake-policy';

const key = 'fictional-test-key';
const turn = { id: 'turn-1', sessionId: 'fixture', order: 0, text: 'It started yesterday.', final: true, at: 1 };
const extracted = { facts: [{ field: 'onset', value: 'yesterday', rawWording: 'yesterday', status: 'reported', evidence: [{ turnId: turn.id, quote: turn.text }] }], nextQuestionId: 'location' };
const completion = (content: unknown = extracted, finish_reason = 'stop', refusal: string | null = null, tool_calls?: unknown[] | null) => Response.json({ choices: [{ finish_reason, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content), refusal, ...(tool_calls !== undefined ? { tool_calls } : {}) } }] });

describe('Nebius structured extraction', () => {
  it('uses the verified model and OpenAI-compatible HTTP contract, preserving evidence validation', async () => {
    const request = vi.fn<ProviderFetch>(async () => completion());
    const input = { turns: [turn], currentFacts: [] };
    const result = await extract({ apiKey: key }, input, request);
    expect(validateExtraction(result, [turn], DEFAULT_TEMPLATE)).toEqual(extracted);
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(NEBIUS_CHAT_URL);
    expect(url).not.toContain(key);
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${key}`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: DEFAULT_EXTRACTION_MODEL, max_tokens: 1800, n: 1, stream: false, store: false, chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_schema', json_schema: { name: 'nursebridge_intake', strict: true, schema: { type: 'object', additionalProperties: false } } } });
    expect(body.response_format.json_schema.schema.properties.facts.items.properties.status.enum).not.toContain('not_asked');
    expect(body.messages[0].content).toContain('Omit fields the caller has not answered from facts');
    expect(body.messages[1].content).toBe(JSON.stringify(input));
    expect(body.tools).toBeUndefined();
    expect(body).not.toHaveProperty('audio');
  });
  it('allows one validation retry and never accepts prose as facts', async () => {
    const request = vi.fn<ProviderFetch>().mockResolvedValueOnce(completion('Here is your summary.')).mockResolvedValueOnce(completion());
    expect(await extract({ apiKey: key }, { turns: [turn] }, request)).toEqual(extracted);
    expect(request).toHaveBeenCalledTimes(2);
    const invalid = vi.fn<ProviderFetch>(async () => completion('Unstructured prose.'));
    await expect(extract({ apiKey: key }, {}, invalid)).rejects.toThrow('structured validation');
    expect(invalid).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String(invalid.mock.calls[1]![1].body));
    expect(retryBody.messages[0].content).toContain('previous response failed local schema validation');
  });
  it('repairs a provider response that proposes an unasked field as a fact', async () => {
    const unasked = { ...extracted, facts: [{ ...extracted.facts[0], status: 'not_asked' }] };
    const request = vi.fn<ProviderFetch>().mockResolvedValueOnce(completion(unasked)).mockResolvedValueOnce(completion());
    await expect(extract({ apiKey: key }, { turns: [turn] }, request)).resolves.toEqual(extracted);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('accepts the provider response contract when tool_calls is explicitly null', async () => {
    await expect(extract({ apiKey: key }, {}, async () => completion(extracted, 'stop', null, null))).resolves.toEqual(extracted);
  });
  it.each([
    ['truncated', () => completion(extracted, 'length')],
    ['refused', () => completion(extracted, 'stop', 'Cannot comply.')],
    ['empty', () => completion('')],
    ['tool', () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{}] } }] })],
  ])('rejects %s completions without replaying them', async (_name, response) => {
    const request = vi.fn<ProviderFetch>(async () => response());
    await expect(extract({ apiKey: key }, {}, request)).rejects.toThrow('completion');
    expect(request).toHaveBeenCalledOnce();
  });
  it('does not treat provider JSON as permission to invent unsupported evidence', async () => {
    const invented = { ...extracted, facts: [{ ...extracted.facts[0], value: 'today' }] };
    const result = await extract({ apiKey: key }, {}, async () => completion(invented));
    expect(() => validateExtraction(result, [turn], DEFAULT_TEMPLATE)).toThrow();
  });
  it('repairs unsupported wording once through the exact evidence policy', async () => {
    const invented = { ...extracted, facts: [{ ...extracted.facts[0], rawWording: 'started on yesterday' }] };
    const request = vi.fn<ProviderFetch>().mockResolvedValueOnce(completion(invented)).mockResolvedValueOnce(completion(extracted));
    const result = await extract({ apiKey: key, validate: candidate => validateExtraction(candidate, [turn], DEFAULT_TEMPLATE) }, { turns: [turn] }, request);
    expect(result).toEqual(extracted);
    expect(request).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(String(request.mock.calls[1]![1].body));
    expect(retry.messages[0].content).toContain('failed local evidence-policy validation');
    expect(retry.messages[0].content).toContain('rawWording and value must be exact substrings');
    expect(retry.messages[0].content).not.toContain('Raw wording is unsupported');
    expect(retry.messages[0].content).not.toContain(key);
  });
  it('rejects unsupported evidence after exactly one repair without leaking policy exceptions', async () => {
    const invented = { ...extracted, facts: [{ ...extracted.facts[0], value: 'today' }] };
    const request = vi.fn<ProviderFetch>(async () => completion(invented));
    await expect(extract({ apiKey: key, validate: candidate => validateExtraction(candidate, [turn], DEFAULT_TEMPLATE) }, { turns: [turn] }, request)).rejects.toThrow('Nebius extraction failed evidence validation.');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('shares one repair budget between structural and evidence failures', async () => {
    const invented = { ...extracted, facts: [{ ...extracted.facts[0], value: 'today' }] };
    const request = vi.fn<ProviderFetch>().mockResolvedValueOnce(completion('not JSON')).mockResolvedValueOnce(completion(invented));
    await expect(extract({ apiKey: key, validate: candidate => validateExtraction(candidate, [turn], DEFAULT_TEMPLATE) }, { turns: [turn] }, request)).rejects.toThrow('Nebius extraction failed evidence validation.');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([302, 400, 401, 429, 503])('sanitizes HTTP %s without retrying or downgrading structured output', async status => {
    const request = vi.fn<ProviderFetch>(async () => new Response(`secret ${key} ${turn.text}`, { status }));
    await expect(extract({ apiKey: key }, {}, request)).rejects.toThrow(`Nebius extraction unavailable (HTTP ${status}).`);
    expect(request).toHaveBeenCalledOnce();
  });
  it('sanitizes provider stream errors while discarding an HTTP error body', async () => {
    const response = new Response(new ReadableStream({ cancel() { throw new Error(`cancel ${key} ${turn.text}`); } }), { status: 503 });
    await expect(extract({ apiKey: key }, {}, async () => response)).rejects.toThrow('Nebius extraction unavailable (HTTP 503).');
  });
  it('bounds response bytes and rejects malformed envelopes', async () => {
    await expect(extract({ apiKey: key }, {}, async () => new Response('x'.repeat(128001)))).rejects.toThrow('exceeded limit');
    await expect(extract({ apiKey: key }, {}, async () => new Response('not json'))).rejects.toThrow('invalid JSON');
  });
  it('sanitizes a failed response stream', async () => {
    const request: ProviderFetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(`upstream ${key} ${turn.text}`)); } }));
    await expect(extract({ apiKey: key }, {}, request)).rejects.toThrow('Nebius extraction response failed or timed out.');
  });
  it('rejects missing credentials and canceled requests before transport', async () => {
    const request = vi.fn<ProviderFetch>(async () => completion());
    await expect(extract({ apiKey: ' ' }, {}, request)).rejects.toThrow('not configured');
    const controller = new AbortController(); controller.abort(new Error(`cancel ${key} ${turn.text}`));
    await expect(extract({ apiKey: key, signal: controller.signal }, {}, request)).rejects.toThrow('Nebius extraction canceled.');
    expect(request).not.toHaveBeenCalled();
  });
  it('propagates cancellation into an in-flight request with sanitized errors', async () => {
    const controller = new AbortController();
    const request: ProviderFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error(`provider transport ${key}`)), { once: true });
      controller.abort();
    });
    await expect(extract({ apiKey: key, signal: controller.signal }, {}, request)).rejects.toThrow('Nebius extraction canceled.');
  });
});

describe('Voice Agent activation is separate from configured credentials', () => {
  const configuredLive = {
    PROVIDER_MODE: 'live',
    ASSEMBLYAI_API_KEY: 'test',
    NEBIUS_API_KEY: key,
    VOICE_AGENT_ID: 'agent-test',
    VOICE_AGENT_VERSION: 'v1',
    ALLOWED_ORIGINS: 'http://localhost:8787,http://127.0.0.1:3000',
  } as const;
  it('keeps live activation blocked until the versioned agent and recording controls are verified', () => {
    const health = providerHealth({ PROVIDER_MODE: 'live', ASSEMBLYAI_API_KEY: 'stt-test', NEBIUS_API_KEY: key } as Env);
    expect(health).toMatchObject({ configured: false, intakeConfigured: false, providers: { extraction: { provider: 'nebius', configured: true, verified: false }, voiceAgent: { provider: 'assemblyai-voice-agent', configured: false, verified: false } } });
    expect(health.liveActivation.issues).toContain('provider_recording_controls_unverified');
    expect(JSON.stringify(health)).not.toContain(key);
  });
  it('does not confuse configured credentials with runtime verification or recording retention', () => {
    const health = providerHealth({ PROVIDER_MODE: 'live', ASSEMBLYAI_API_KEY: 'test', NEBIUS_API_KEY: key, VOICE_AGENT_ID: 'agent-test', VOICE_AGENT_VERSION:'v1', VOICE_AGENT_COMPATIBILITY_VERIFIED:'true' } as Env);
    expect(health).toMatchObject({ configured: true, intakeConfigured: false, liveActivation:{ready:false,issues:['provider_recording_controls_unverified']} });
  });
  it('allows only a named fictional loopback test while reporting recording and deletion as unverified', () => {
    const health = providerHealth({ ...configuredLive, FICTIONAL_LIVE_TEST: 'true' } as Env);
    expect(health).toMatchObject({
      configured: true,
      intakeConfigured: true,
      liveActivation: { ready: true, issues: [] },
      recording: { enabled: true, retentionVerified: false, deletionVerified: false },
      providers: { voiceAgent: { verified: false }, extraction: { verified: false } },
    });
  });
  it.each([
    ['missing flag', undefined, configuredLive.ALLOWED_ORIGINS],
    ['non-loopback host', 'true', 'https://nursebridge.example'],
    ['mixed origins', 'true', 'http://localhost:8787,https://nursebridge.example'],
    ['empty origin', 'true', 'http://localhost:8787,'],
    ['origin with path', 'true', 'http://localhost:8787/case'],
    ['localhost over HTTPS', 'true', 'https://localhost:8787'],
    ['loopback alias', 'true', 'http://127.1:8787'],
  ])('does not bypass activation for %s', (_label, flag, origins) => {
    const health = providerHealth({ ...configuredLive, FICTIONAL_LIVE_TEST: flag, ALLOWED_ORIGINS: origins } as Env);
    expect(health.liveActivation).toMatchObject({ ready: false, issues: ['nemotron_voice_compatibility_unverified', 'provider_recording_controls_unverified'] });
    expect(health.recording).toMatchObject({ retentionVerified: false, deletionVerified: false });
  });
  it('keeps credentials and a versioned agent mandatory for fictional local testing', () => {
    const health = providerHealth({ ...configuredLive, ASSEMBLYAI_API_KEY: '', VOICE_AGENT_ID: '', FICTIONAL_LIVE_TEST: 'true' } as Env);
    expect(health.liveActivation).toMatchObject({ ready: false, issues: ['assemblyai_key_missing', 'versioned_agent_missing'] });
  });
  it('does not treat the opt-in as active while the Worker is in mock mode', () => {
    const health = providerHealth({ ...configuredLive, PROVIDER_MODE: 'mock', FICTIONAL_LIVE_TEST: 'true' } as Env);
    expect(health.liveActivation).toMatchObject({ ready: false, issues: ['nemotron_voice_compatibility_unverified', 'provider_recording_controls_unverified'] });
  });
});
