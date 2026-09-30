import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupVoiceAgent, MODEL } from './setup-voice-agent.mjs';

test('dry-run never reads credential values or makes a request', async () => {
  let text = ''; let requests = 0;
  await setupVoiceAgent({ env: { ASSEMBLYAI_API_KEY: 'FICTIONAL_SECRET', NEBIUS_API_KEY: 'FICTIONAL_SECRET' }, request: () => { requests++; }, output: value => { text = value; } });
  assert.equal(requests, 0); assert.equal(text.includes('FICTIONAL_SECRET'), false); assert.equal(JSON.parse(text).body.llm[0].model, MODEL);
});
test('explicit apply stores the exact Nebius endpoint and never prints credentials or arbitrary provider fields', async () => {
  let text = '';
  await setupVoiceAgent({ args: ['--apply'], env: { ASSEMBLYAI_API_KEY: 'AAI_TEST', NEBIUS_API_KEY: 'NEBIUS_TEST' }, request: async (url, init) => {
    assert.equal(url, 'https://agents.assemblyai.com/v1/agents'); assert.equal(init.headers.Authorization, 'AAI_TEST');
    assert.deepEqual(JSON.parse(init.body).llm, [{ base_url: 'https://api.tokenfactory.nebius.com/v1', model: MODEL, api_key: 'NEBIUS_TEST' }]);
    assert.equal(JSON.parse(init.body).greeting, undefined);
    return new Response(JSON.stringify({ id: 'agent-test', arbitrary: 'FICTIONAL_SECRET' }));
  }, output: value => { text = value; } });
  assert.equal(JSON.parse(text).createdAgentId, 'agent-test'); assert.equal(text.includes('FICTIONAL_SECRET'), false); assert.equal(text.includes('NEBIUS_TEST'), false);
});
test('apply requires credentials and errors never echo upstream response or exception', async () => {
  await assert.rejects(setupVoiceAgent({ args: ['--apply'] }), /Set ASSEMBLYAI_API_KEY/);
  await assert.rejects(setupVoiceAgent({ args: ['--apply'], env: { ASSEMBLYAI_API_KEY: 'test', NEBIUS_API_KEY: 'test' }, request: async () => { throw new Error('FICTIONAL_SECRET'); } }), error => !error.message.includes('FICTIONAL_SECRET') && error.message.includes('before retrying'));
});
test('apply validates the bounded provider response and status', async () => {
  const options = { args: ['--apply'], env: { ASSEMBLYAI_API_KEY: 'test', NEBIUS_API_KEY: 'test' } };
  await assert.rejects(setupVoiceAgent({ ...options, request: async () => new Response('FICTIONAL_SECRET', { status: 403 }) }), /HTTP 403/);
  await assert.rejects(setupVoiceAgent({ ...options, request: async () => new Response('x'.repeat(64001)) }), /could not be verified/);
});

test('managed dry-run uses an empty LLM list without reading credentials', async () => {
  let text = ''; let requests = 0;
  const env = { LLM_PROVIDER: 'assemblyai', get ASSEMBLYAI_API_KEY() { throw new Error('Do not read credentials'); }, get NEBIUS_API_KEY() { throw new Error('Do not read credentials'); } };
  await setupVoiceAgent({ env, request: () => { requests++; }, output: value => { text = value; } });
  assert.equal(requests, 0); assert.deepEqual(JSON.parse(text).body.llm, []);
  assert.equal(JSON.parse(text).body.greeting, undefined);
  assert.equal(text.includes('NEBIUS_API_KEY'), false);
});
test('managed apply requires only AssemblyAI and does not store or read a Nebius key', async () => {
  let text = '';
  const env = { LLM_PROVIDER: 'assemblyai', ASSEMBLYAI_API_KEY: 'AAI_TEST', get NEBIUS_API_KEY() { throw new Error('Do not read Nebius key'); } };
  await setupVoiceAgent({ args: ['--apply'], env, request: async (url, init) => {
    assert.equal(url, 'https://agents.assemblyai.com/v1/agents'); assert.equal(init.headers.Authorization, 'AAI_TEST');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.llm, []); assert.equal(body.greeting, undefined);
    assert.deepEqual(body.input.format, { encoding: 'audio/pcm', sample_rate: 24000 });
    assert.deepEqual(body.output.format, { encoding: 'audio/pcm', sample_rate: 24000 });
    assert.equal(init.body.includes('NEBIUS'), false);
    return Response.json({ id: 'managed-agent-test', arbitrary: 'FICTIONAL_SECRET' });
  }, output: value => { text = value; } });
  assert.deepEqual(JSON.parse(text), { createdAgentId: 'managed-agent-test', llmProvider: 'assemblyai', requestedModel: 'assemblyai-managed', liveActivation: 'still_blocked', next: 'Record the agent id and a reviewed configuration revision. Verify the resolved model, streaming tool behavior, and provider recording/retention controls before enabling live mode.' });
  assert.equal(text.includes('AAI_TEST'), false); assert.equal(text.includes('FICTIONAL_SECRET'), false);
  await assert.rejects(setupVoiceAgent({ args: ['--apply'], env: { LLM_PROVIDER: 'assemblyai' } }), /Set ASSEMBLYAI_API_KEY/);
});
test('unknown provider values fail closed before either dry-run or apply', async () => {
  for (const provider of ['', 'unknown', 'ASSEMBLYAI']) {
    for (const args of [[], ['--apply']]) {
      let requests = 0; let outputs = 0;
      await assert.rejects(setupVoiceAgent({ args, env: { LLM_PROVIDER: provider, ASSEMBLYAI_API_KEY: 'test', NEBIUS_API_KEY: 'test' }, request: () => { requests++; }, output: () => { outputs++; } }), /LLM_PROVIDER must be nebius or assemblyai/);
      assert.equal(requests, 0); assert.equal(outputs, 0);
    }
  }
});
