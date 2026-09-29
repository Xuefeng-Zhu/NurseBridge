const AUDIO_NUMBERS = ['receivedFrames', 'playedSamples', 'rms', 'underruns', 'droppedFrames', 'queuedSamples', 'dominantFrequency', 'zeroCrossings', 'controlEpoch', 'agentSamplesInEpoch', 'humanSamplesInEpoch'] as const;
const CONNECTIONS = ['idle', 'connecting', 'connected', 'reconnecting', 'disconnected', 'closed', 'error'];
const MICROPHONES = ['idle', 'requesting', 'ready', 'denied', 'error'];
const PLAYBACK = ['idle', 'ready', 'blocked', 'error'];
const TAKEOVER_CODES = ['revision_conflict', 'already_claimed', 'claim_required', 'closed', 'call_expired', 'forbidden'];
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Explicit allowlist: never serialize raw errors, URLs, case content, or client objects. */
export function safeAudioDiagnostics(input: unknown) {
  const source = record(input);
  const metrics = record(source.metrics);
  const state = record(source.state);
  const safeMetrics: Record<string, number> = {};
  for (const key of AUDIO_NUMBERS) {
    const value = metrics[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) safeMetrics[key] = value;
  }
  const safeState: Record<string, string | boolean> = {};
  for (const [key, values] of [['connection', CONNECTIONS], ['microphone', MICROPHONES], ['playback', PLAYBACK]] as const) {
    if (typeof state[key] === 'string' && values.includes(state[key])) safeState[key] = state[key];
  }
  if (typeof state.muted === 'boolean') safeState.muted = state.muted;
  return { available: source.available === true, metrics: safeMetrics, state: safeState };
}

export function safeTakeoverOutcomes(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 20).flatMap(item => {
    const value = record(item);
    if ((value.action !== 'claim' && value.action !== 'takeover') || typeof value.status !== 'number' || !Number.isInteger(value.status) || value.status < 100 || value.status > 599) return [];
    return [{ action: value.action as 'claim' | 'takeover', status: value.status, ...(typeof value.code === 'string' && TAKEOVER_CODES.includes(value.code) ? { code: value.code } : {}) }];
  });
}
