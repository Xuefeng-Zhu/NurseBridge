import type { Env } from '../env';

// The published session-history contract documents soft deletion but no verified account retention
// control. This is deliberately not an environment-variable override. Account
// retention controls and operational cleanup must be verified before live use.
export const RECORDING_CONTROLS_VERIFIED = false;
export function liveActivationIssues(env: Env): string[] {
  const issues: string[] = [];
  if (!env.ASSEMBLYAI_API_KEY?.trim()) issues.push('assemblyai_key_missing');
  if (!env.NEBIUS_API_KEY?.trim()) issues.push('nebius_key_missing');
  if (!env.VOICE_AGENT_ID?.trim() || !env.VOICE_AGENT_VERSION?.trim()) issues.push('versioned_agent_missing');
  if (env.VOICE_AGENT_COMPATIBILITY_VERIFIED !== 'true') issues.push('nemotron_voice_compatibility_unverified');
  if (!RECORDING_CONTROLS_VERIFIED) issues.push('provider_recording_controls_unverified');
  return issues;
}
