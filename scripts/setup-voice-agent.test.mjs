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
