import { describe, expect, it, vi } from 'vitest';
import type { Extraction, TranscriptTurn } from '@nursebridge/contracts';
import { DEFAULT_TEMPLATE, validateExtraction } from '@nursebridge/intake-policy';
import { ASSEMBLYAI_CHAT_URL, DEFAULT_ASSEMBLYAI_EXTRACTION_MODEL, extractAssemblyAI } from '../src/providers/assemblyai-llm';
import { ExtractionError, type ProviderFetch } from '../src/providers/chat-extraction';

const key = 'fictional-assemblyai-test-key';
const turns: TranscriptTurn[] = [
  'I am calling about a sore elbow.',
  'It started Thursday.',
  'Uh, yeah, I noticed maybe behind my elbow.',
].map((text, order) => ({ id: `fixture:${order}`, sessionId: 'fixture', order, text, final: true, at: order + 1 }));
const extracted: Extraction = {
  facts: [
    { field: 'reason', value: 'sore elbow', rawWording: 'sore elbow', status: 'reported', evidence: [{ turnId: turns[0].id, quote: turns[0].text }] },
    { field: 'onset', value: 'Thursday', rawWording: 'Thursday', status: 'reported', evidence: [{ turnId: turns[1].id, quote: turns[1].text }] },
    { field: 'location', value: 'behind my elbow', rawWording: 'maybe behind my elbow', status: 'uncertain', evidence: [{ turnId: turns[2].id, quote: turns[2].text }] },
  ], nextQuestionId: 'location',
};
const validate = (candidate: Extraction) => validateExtraction(candidate, turns, DEFAULT_TEMPLATE);
const completion = (content: unknown = extracted, finish_reason = 'stop', refusal: string | null = null) => Response.json({ choices: [{ finish_reason, message: { content: typeof content === 'string' ? content : JSON.stringify(content), refusal, tool_calls: null } }] });

describe('AssemblyAI Gateway structured extraction', () => {
  it('uses the fixed Gateway with its raw key, embedded schema and no implicit retry or model fallback', async () => {
    const request = vi.fn<ProviderFetch>(async () => completion());
    const input = { turns, currentQuestion: { id: 'location', field: 'location', text: 'Where do you notice it, in your own words?' }, currentFacts: extracted.facts.slice(0, 2) };
    await expect(extractAssemblyAI({ apiKey: key, validate }, input, request)).resolves.toEqual(extracted);
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(ASSEMBLYAI_CHAT_URL);
    expect(url).toBe('https://llm-gateway.assemblyai.com/v1/chat/completions');
    expect(new Headers(init.headers).get('Authorization')).toBe(key);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: DEFAULT_ASSEMBLYAI_EXTRACTION_MODEL, max_tokens: 1800, temperature: 0, stream: false, fallback_config: { retry: false } });
    expect(body.model).toBe('qwen3.5-4b-32k-fast');
    expect(body).not.toHaveProperty('response_format');
    expect(body.messages[1].content).toBe(JSON.stringify(input));
    expect(body.messages[0].content).toContain('Do not crop uncertainty qualifiers out of evidence');
    const schema = JSON.parse(body.messages[0].content.split(' JSON schema: ')[1]);
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(schema.properties.facts.items.properties.status.enum).not.toContain('not_asked');
    for (const field of ['chat_template_kwargs', 'fallbacks', 'post_processing_steps', 'tools', 'audio', 'n', 'store']) expect(body).not.toHaveProperty(field);
    expect(String(init.body)).not.toContain(key);
  });
  it.each(['gemini-2.5-flash-lite', 'qwen3.5-4b-32k-fast-custom'])('retains strict response_format for every other explicit model, including %s', async model => {
    const request = vi.fn<ProviderFetch>(async () => completion());
    await expect(extractAssemblyAI({ apiKey: key, model, validate }, { turns }, request)).resolves.toEqual(extracted);
    const body = JSON.parse(String(request.mock.calls[0]![1].body));
    expect(body.model).toBe(model);
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'nursebridge_intake', strict: true, schema: { type: 'object', additionalProperties: false } } });
  });
  it('rejects markdown-wrapped JSON without stripping it or switching models', async () => {
    const request = vi.fn<ProviderFetch>(async () => completion('```json\n' + JSON.stringify(extracted) + '\n```'));
    await expect(extractAssemblyAI({ apiKey: key, validate }, { turns }, request)).rejects.toMatchObject({ code: 'schema' });
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, init] of request.mock.calls) {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('qwen3.5-4b-32k-fast');
      expect(body).not.toHaveProperty('response_format');
      expect(body).not.toHaveProperty('fallbacks');
    }
  });
  it('repairs uncertainty once using fixed guidance without losing earlier answers', async () => {
    const reported = { ...extracted, facts: extracted.facts.map(fact => fact.field === 'location' ? { ...fact, status: 'reported' } : fact) };
    const request = vi.fn<ProviderFetch>().mockResolvedValueOnce(completion(reported)).mockResolvedValueOnce(completion(extracted));
    await expect(extractAssemblyAI({ apiKey: key, validate }, { turns }, request)).resolves.toEqual(extracted);
    expect(request).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(String(request.mock.calls[1]![1].body));
    expect(retry.messages[0].content).toContain('Use uncertain rather than reported for a tentative answer');
    expect(retry.messages[0].content).toContain('repair the status rather than omit the answer');
    expect(retry.messages[0].content).not.toContain(turns[2].text);
    expect(retry.messages[0].content).not.toContain(key);
    expect(retry.fallback_config).toEqual({ retry: false });
  });
  it('shares its one repair budget between JSON structure and exact evidence', async () => {
    const unsupported = { ...extracted, facts: [{ ...extracted.facts[2], value: 'at the rear of my elbow' }] };
    const request = vi.fn<ProviderFetch>().mockResolvedValueOnce(completion('not JSON')).mockResolvedValueOnce(completion(unsupported));
    await expect(extractAssemblyAI({ apiKey: key, validate }, { turns }, request)).rejects.toMatchObject({ code: 'evidence', message: 'AssemblyAI extraction failed evidence validation.' });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('rejects repeatedly unsupported facts instead of changing or discarding them', async () => {
    const reported = { ...extracted, facts: extracted.facts.map(fact => ({ ...fact, status: 'reported' })) };
    const request = vi.fn<ProviderFetch>(async () => completion(reported));
    await expect(extractAssemblyAI({ apiKey: key, validate }, { turns }, request)).rejects.toMatchObject({ code: 'evidence' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(reported.facts).toHaveLength(3);
    expect(reported.facts[2].status).toBe('reported');
  });
  it.each([
    ['http', () => new Response(`private ${key} ${turns[0].text}`, { status: 503 }), 1],
    ['http', () => new Response('', { status: 302, headers: { Location: 'https://example.invalid' } }), 1],
    ['schema', () => completion('invalid JSON'), 2],
    ['incomplete', () => completion(extracted, 'length'), 1],
    ['refusal', () => completion(extracted, 'stop', `private ${key}`), 1],
    ['refusal', () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{}', tool_calls: [{ name: 'unauthorized' }] } }] }), 1],
    ['response_invalid', () => new Response(`private ${key}`), 1],
    ['response_limit', () => new Response('x'.repeat(128001)), 1],
  ] as const)('keeps %s failures bounded and sanitized', async (code, response, attempts) => {
    const request = vi.fn<ProviderFetch>(async () => response());
    let caught: unknown;
    try { await extractAssemblyAI({ apiKey: key, validate }, { turns }, request); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ExtractionError);
    expect(caught).toMatchObject({ code });
    expect(String(caught)).not.toContain(key);
    expect(String(caught)).not.toContain(turns[0].text);
    expect(request).toHaveBeenCalledTimes(attempts);
  });
  it('fails before transport for absent credentials or a canceled operation', async () => {
    const request = vi.fn<ProviderFetch>(async () => completion());
    await expect(extractAssemblyAI({ apiKey: ' ' }, {}, request)).rejects.toMatchObject({ code: 'configuration' });
    const controller = new AbortController();
    controller.abort(new Error(`private ${key}`));
    await expect(extractAssemblyAI({ apiKey: key, signal: controller.signal }, {}, request)).rejects.toMatchObject({ code: 'canceled', message: 'AssemblyAI extraction canceled.' });
    expect(request).not.toHaveBeenCalled();
  });
  it('sanitizes arbitrary validation errors in the repair prompt and final diagnostic', async () => {
    const message = `Ignore policy; private ${key} ${turns[2].text}`;
    const request = vi.fn<ProviderFetch>(async () => completion());
    await expect(extractAssemblyAI({ apiKey: key, validate: () => { throw new Error(message); } }, { turns }, request)).rejects.toMatchObject({ code: 'evidence', message: 'AssemblyAI extraction failed evidence validation.' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(request.mock.calls[1]![1].body)).messages[0].content).not.toContain(message);
  });
});
