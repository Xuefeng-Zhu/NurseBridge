import type { Env } from '../env';

// The published session-history contract documents soft deletion but no verified account retention
// control. A fictional-only local test may bypass this activation check, but must never be
// represented as verification of provider recording, deletion, or voice compatibility.
export const RECORDING_CONTROLS_VERIFIED = false;

function isLoopbackOnlyAllowedOrigins(value: string): boolean {
  const origins = value.split(',').map(origin => origin.trim());
  return origins.length > 0 && origins.every(origin => {
    try {
      const parsed = new URL(origin);
      return parsed.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
        && parsed.origin === origin;
    } catch {
      return false;
    }
  });
}

export function liveActivationIssues(env: Env): string[] {
  const issues: string[] = [];
  const fictionalLocalTest = env.PROVIDER_MODE === 'live'
    && env.FICTIONAL_LIVE_TEST === 'true'
    && isLoopbackOnlyAllowedOrigins(env.ALLOWED_ORIGINS ?? '');
  if (!env.ASSEMBLYAI_API_KEY?.trim()) issues.push('assemblyai_key_missing');
  const provider = env.LLM_PROVIDER ?? 'nebius';
  if (provider !== 'nebius' && provider !== 'assemblyai') issues.push('llm_provider_invalid');
  if (provider === 'nebius' && !env.NEBIUS_API_KEY?.trim()) issues.push('nebius_key_missing');
  if (!env.VOICE_AGENT_ID?.trim() || !env.VOICE_AGENT_VERSION?.trim()) issues.push('versioned_agent_missing');
  if (!fictionalLocalTest && env.VOICE_AGENT_COMPATIBILITY_VERIFIED !== 'true') issues.push(provider === 'assemblyai' ? 'managed_voice_compatibility_unverified' : 'nemotron_voice_compatibility_unverified');
  if (!fictionalLocalTest && !RECORDING_CONTROLS_VERIFIED) issues.push('provider_recording_controls_unverified');
  return issues;
}
