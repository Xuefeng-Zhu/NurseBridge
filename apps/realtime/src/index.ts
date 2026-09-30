import type { Env } from './env';
import { DEFAULT_EXTRACTION_MODEL } from './providers/nebius';
import { DEFAULT_ASSEMBLYAI_EXTRACTION_MODEL } from './providers/assemblyai-llm';
import { RECORDING_DISCLOSURE_VERSION } from '@nursebridge/contracts';
import { liveActivationIssues, RECORDING_CONTROLS_VERIFIED } from './providers/readiness';
import { handlePhoneRequest } from './telephony/ingress';
export { CallSession } from './CallSession';

export function providerHealth(env: Env) {
  const voiceAgent = Boolean(env.ASSEMBLYAI_API_KEY?.trim() && env.VOICE_AGENT_ID?.trim() && env.VOICE_AGENT_VERSION?.trim());
  const llmProvider = env.LLM_PROVIDER ?? 'nebius';
  const validProvider = llmProvider === 'nebius' || llmProvider === 'assemblyai';
  const extraction = validProvider && Boolean((llmProvider === 'assemblyai' ? env.ASSEMBLYAI_API_KEY : env.NEBIUS_API_KEY)?.trim());
  const activationIssues = liveActivationIssues(env);
  return {
    service: 'NurseBridge realtime', mode: env.PROVIDER_MODE,
    configured: env.PROVIDER_MODE === 'mock' || voiceAgent && extraction,
    intakeConfigured: env.PROVIDER_MODE === 'mock' || activationIssues.length === 0,
    liveActivation: { ready: activationIssues.length === 0, issues: activationIssues },
    phoneInbound: { provider: 'twilio', enabled: env.PHONE_INBOUND_ENABLED === 'true', configured: Boolean(env.TWILIO_ACCOUNT_SID?.trim() && env.TWILIO_AUTH_TOKEN?.trim() && env.TWILIO_PUBLIC_ORIGIN?.trim() && env.TWILIO_INBOUND_ROUTES?.trim() && env.TWILIO_INBOUND_ROUTES !== '{}') },
    recording: { provider: 'assemblyai', enabled: env.PROVIDER_MODE === 'live', disclosureVersion: RECORDING_DISCLOSURE_VERSION, retentionVerified: RECORDING_CONTROLS_VERIFIED, deletionVerified: RECORDING_CONTROLS_VERIFIED },
    providers: {
      voiceAgent: { provider: 'assemblyai-voice-agent', llmProvider: llmProvider === 'assemblyai' ? 'assemblyai-managed' : llmProvider, configured: voiceAgent && validProvider, verified: false },
      extraction: { provider: llmProvider === 'assemblyai' ? 'assemblyai-llm-gateway' : llmProvider, model: env.EXTRACTION_MODEL ?? (llmProvider === 'assemblyai' ? DEFAULT_ASSEMBLYAI_EXTRACTION_MODEL : DEFAULT_EXTRACTION_MODEL), configured: extraction, verified: false },
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      let phoneNumbers: string[] = [];
      // Workspace inventory is available only through the private service binding.
      if (url.hostname === 'internal' && url.searchParams.has('workspaceId')) {
        try { phoneNumbers = Object.entries(JSON.parse(env.TWILIO_INBOUND_ROUTES ?? '{}')).filter(([, id]) => id === url.searchParams.get('workspaceId')).map(([number]) => number); } catch { /* Unconfigured. */ }
      }
      return Response.json({ ...providerHealth(env), phoneNumbers }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname.startsWith('/phone/')) {
      const response = await handlePhoneRequest(request, env);
      if (response) return response;
    }
    const match = /^\/connect\/([a-zA-Z0-9_-]{8,100})$/.exec(url.pathname);
    if (!match || request.method !== 'GET') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    if (!env.ALLOWED_ORIGINS.split(',').map(value => value.trim()).includes(request.headers.get('Origin') ?? '')) return new Response('Origin not allowed', { status: 403 });
    // Call identifiers route requests only; they confer no authority. No case data is
    // returned until the target object atomically consumes a one-time ticket.
    return env.CALL_SESSIONS.get(env.CALL_SESSIONS.idFromName(match[1]!)).fetch(request);
  }
} satisfies ExportedHandler<Env>;
