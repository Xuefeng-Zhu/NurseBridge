import { pathToFileURL } from 'node:url';

export const MODEL = 'nvidia/Nemotron-3_5-Lightning';
const ENDPOINT = 'https://agents.assemblyai.com/v1/agents';
export function agentPayload(nebiusKey) {
  return {
    name: 'NurseBridge fictional intake',
    system_prompt: 'You are a fictional intake demonstration. Wait for the application to configure this session. Do not diagnose, recommend treatment, or provide clinical advice.',
    voice: { voice_id: 'alba' },
    input: { format: { encoding: 'audio/pcm', sample_rate: 24000 }, turn_detection: { interrupt_response: true } },
    output: { format: { encoding: 'audio/pcm', sample_rate: 24000 } },
    tools: [],
    llm: [{ base_url: 'https://api.tokenfactory.nebius.com/v1', model: MODEL, api_key: nebiusKey }],
  };
}

/** No env files are read, no credentials are printed, and no request is made by
 * default. --apply explicitly creates a stored agent and stores its LLM key. */
export async function setupVoiceAgent({ args = [], env = {}, request = fetch, output = console.log } = {}) {
  if (args.some(arg => !['--apply', '--dry-run', '--help'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) throw new Error('Use --dry-run (default) or --apply.');
  if (args.includes('--help')) { output('node scripts/setup-voice-agent.mjs [--dry-run|--apply]\n--apply creates an AssemblyAI stored agent using ASSEMBLYAI_API_KEY and NEBIUS_API_KEY from the environment. It does not enable NurseBridge live mode.'); return; }
  if (!args.includes('--apply')) {
    output(JSON.stringify({ mode: 'dry-run', method: 'POST', url: ENDPOINT, headers: { Authorization: '[ASSEMBLYAI_API_KEY]', 'Content-Type': 'application/json' }, body: agentPayload('[NEBIUS_API_KEY]'), liveActivation: 'blocked_pending_retention_and_model_verification' }, null, 2));
    return;
  }
  const key = env.ASSEMBLYAI_API_KEY; const nebius = env.NEBIUS_API_KEY;
  if (typeof key !== 'string' || !key.trim() || typeof nebius !== 'string' || !nebius.trim()) throw new Error('Set ASSEMBLYAI_API_KEY and NEBIUS_API_KEY before --apply.');
  let response;
  try { response = await request(ENDPOINT, { method: 'POST', redirect: 'error', headers: { Authorization: key, 'Content-Type': 'application/json' }, body: JSON.stringify(agentPayload(nebius)), signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error('Stored agent creation request failed. Check the provider dashboard before retrying to avoid duplicates.'); }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Suppress provider error bodies. */ }
    throw new Error(`Stored agent creation rejected (HTTP ${response.status}).`);
  }
  let result;
  try {
    const reader = response.body?.getReader(); if (!reader) throw new Error();
    const parts = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength; if (size > 64000) throw new Error(); parts.push(next.value);
      }
      const all = new Uint8Array(size); let offset = 0; for (const part of parts) { all.set(part, offset); offset += part.byteLength; }
      result = JSON.parse(new TextDecoder().decode(all));
    } finally { try { await reader.cancel(); } catch { /* Suppress response errors. */ } reader.releaseLock(); }
    if (!result || typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(result.id)) throw new Error();
  } catch { throw new Error('Stored agent creation response could not be verified. Check the provider dashboard before retrying.'); }
  // Never print the provider response, which can contain prompt/configuration.
  output(JSON.stringify({ createdAgentId: result.id, requestedModel: MODEL, liveActivation: 'still_blocked', next: 'Record the agent id and a reviewed configuration revision. Verify the resolved model, streaming tool behavior, and provider recording/retention controls before enabling live mode.' }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setupVoiceAgent({ args: process.argv.slice(2), env: process.env }).catch(error => { console.error(error instanceof Error ? error.message : 'Stored agent setup failed.'); process.exitCode = 1; });
}
