const AUDIO_NUMBERS = ['receivedFrames', 'playedSamples', 'rms', 'underruns', 'droppedFrames', 'queuedSamples', 'dominantFrequency', 'zeroCrossings', 'controlEpoch', 'agentSamplesInEpoch', 'humanSamplesInEpoch'] as const;
const CONNECTIONS = ['idle', 'connecting', 'connected', 'reconnecting', 'disconnected', 'closed', 'error'];
const MICROPHONES = ['idle', 'requesting', 'ready', 'denied', 'error'];
const PLAYBACK = ['idle', 'ready', 'blocked', 'error'];
const TAKEOVER_CODES = ['revision_conflict', 'already_claimed', 'claim_required', 'closed', 'call_expired', 'forbidden'];
const QUEUE_STATES = ['WAITING', 'CLAIMED', 'CONNECTED', 'CLOSED'];
const CONVERSATION_OWNERS = ['NONE', 'AI', 'HANDOFF_PENDING', 'NURSE'];
const CONTROL_EVENTS = ['claim', 'takeover', 'release', 'request-human', 'consent', 'end', 'delete', 'caller-connected', 'nurse-connected', 'caller-disconnected', 'nurse-disconnected', 'media-ready', 'handoff-flush', 'handoff-flushed', 'media-proof', 'connected', 'human-audio-interrupted', 'recovery', 'terminal-recovery', 'handoff-timeout', 'claim-expired', 'duration-limit', 'retention-expired', 'audio-gap'];
const AUDIO_GAP_CAUSES = new Map([
  ['Audio sender exceeded the realtime delivery limit.', 'rate_limit'],
  ['Audio interrupted by bounded transport backpressure.', 'capture_backpressure'],
  ['Human audio interrupted by network congestion.', 'playback_backpressure'],
]);
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

/** Call content is private; retain only operational states and known event kinds. */
export function safeControlDiagnostics(input: unknown) {
  const source = record(input);
  const state = record(source.state);
  const safeState: Record<string, string | number | Record<string, boolean>> = {};
  for (const [key, values] of [['queueState', QUEUE_STATES], ['conversationOwner', CONVERSATION_OWNERS]] as const) {
    if (typeof state[key] === 'string' && values.includes(state[key])) safeState[key] = state[key];
  }
  if (typeof state.controlEpoch === 'number' && Number.isSafeInteger(state.controlEpoch) && state.controlEpoch >= 0) safeState.controlEpoch = state.controlEpoch;
  for (const key of ['mediaReady', 'participants']) {
    const flags = record(state[key]);
    const safeFlags: Record<string, boolean> = {};
    for (const role of ['caller', 'nurse']) if (typeof flags[role] === 'boolean') safeFlags[role] = flags[role];
    safeState[key] = safeFlags;
  }
  const timeline = (Array.isArray(source.timeline) ? source.timeline : []).flatMap(item => {
    const event = record(item);
    if (typeof event.type !== 'string' || !CONTROL_EVENTS.includes(event.type)) return [];
    const cause = event.type === 'audio-gap'
      ? typeof event.message === 'string' ? AUDIO_GAP_CAUSES.get(event.message)
        : typeof event.cause === 'string' && [...AUDIO_GAP_CAUSES.values()].includes(event.cause) ? event.cause : undefined
      : undefined;
    return [{ type: event.type, ...(cause ? { cause } : {}) }];
  }).slice(-20);
  return { available: source.available === true, state: safeState, timeline };
}
