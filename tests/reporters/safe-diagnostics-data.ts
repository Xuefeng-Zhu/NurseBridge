const AUDIO_NUMBERS = ['receivedFrames', 'playedSamples', 'rms', 'underruns', 'droppedFrames', 'queuedSamples', 'dominantFrequency', 'zeroCrossings', 'controlEpoch', 'agentSamplesInEpoch', 'humanSamplesInEpoch'] as const;
const CONNECTIONS = ['idle', 'connecting', 'connected', 'reconnecting', 'disconnected', 'closed', 'error'];
const MICROPHONES = ['idle', 'requesting', 'ready', 'denied', 'error'];
const PLAYBACK = ['idle', 'ready', 'blocked', 'error'];
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
