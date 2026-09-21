/** Direct Workers-native adapter; no Node websocket implementation or browser key. */
export type ProviderWord = { text: string; start: number; end: number; confidence?: number };
export type SttTurn = { id: string; sessionId: string; order: number; text: string; final: boolean; words: ProviderWord[]; createdAt: number };
export interface SttCallbacks {
  begin(sessionId: string, configuration: Record<string, unknown>): void;
  speechStarted(): void;
  turn(turn: SttTurn): void;
  warning(code: string): void;
  closed(code: string): void;
}
export interface Transcriber { send(pcm: Uint8Array): boolean; close(): void; }

export function medicalConfigurationConfirmed(configuration: Record<string, unknown>): boolean {
  return configuration.domain === 'medical-v1' && configuration.speech_model === 'universal-3-5-pro' && configuration.mode === 'balanced';
}

/** Final-event delay after the last spoken word, including endpoint silence.
 * The provider timestamps are milliseconds from the first PCM sample. Missing
 * or impossible word timestamps are unavailable measurements, never zeroes. */
export function finalEventDelay(finalAt: number, clock: { startedAt: number; samples: number } | undefined, words: ProviderWord[]): number | undefined {
  if (!clock || !words.length) return undefined;
  const end = words.at(-1)?.end;
  if (typeof end !== 'number' || !Number.isFinite(end) || end < 0 || end > clock.samples / 16 + 50) return undefined;
  const delay = finalAt - (clock.startedAt + end);
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

export function assemblyUrl(): URL {
  const url = new URL('https://streaming.assemblyai.com/v3/ws');
  for (const [key, value] of Object.entries({ speech_model: 'universal-3-5-pro', sample_rate: '16000', encoding: 'pcm_s16le', domain: 'medical-v1', mode: 'balanced', min_turn_silence: '800', max_turn_silence: '2000', session_heartbeat: 'true' })) url.searchParams.set(key, value);
  return url;
}

export class AssemblyEventParser {
  sessionId = '';
  private finalized = new Set<number>();
  constructor(private callbacks: SttCallbacks) {}
  consume(input: unknown) {
    if (!input || typeof input !== 'object') return;
    const event = input as Record<string, unknown>;
    if (event.type === 'Begin' && typeof event.id === 'string') {
      this.sessionId = event.id;
      this.finalized.clear();
      const configuration = (event.configuration ?? {}) as Record<string, unknown>;
      this.callbacks.begin(event.id, configuration);
      if (!medicalConfigurationConfirmed(configuration)) this.callbacks.warning('medical_mode_not_confirmed');
    } else if (event.type === 'SpeechStarted') this.callbacks.speechStarted();
    else if (event.type === 'Turn' && this.sessionId && Number.isInteger(event.turn_order) && typeof event.transcript === 'string') {
      const order = event.turn_order as number;
      if (this.finalized.has(order)) return;
      const final = event.end_of_turn === true;
      if (final) this.finalized.add(order);
      const words = Array.isArray(event.words) ? event.words.filter((word): word is ProviderWord => Boolean(word && typeof word === 'object' && typeof word.text === 'string' && typeof word.start === 'number' && typeof word.end === 'number')) : [];
      this.callbacks.turn({ id: `${this.sessionId}:${order}`, sessionId: this.sessionId, order, text: event.transcript.slice(0, 12000), final, words, createdAt: Date.now() });
    } else if (event.type === 'Termination') this.callbacks.closed('provider_terminated');
    else if (event.type === 'Error' || event.error) this.callbacks.closed('provider_error');
    if (event.warning || event.warnings || event.type === 'Warning') this.callbacks.warning('provider_configuration_warning');
  }
}

export async function connectAssembly(apiKey: string, callbacks: SttCallbacks): Promise<Transcriber> {
  const response = await fetch(assemblyUrl().toString(), { headers: { Upgrade: 'websocket', Authorization: apiKey }, signal: AbortSignal.timeout(10000) });
  if (response.status !== 101 || !response.webSocket) throw new Error(`AssemblyAI rejected connection (${response.status}).`);
  const socket = response.webSocket;
  socket.binaryType = 'arraybuffer';
  socket.accept();
  let intentional = false;
  const parser = new AssemblyEventParser(callbacks);
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string' || event.data.length > 200000) return;
    try { parser.consume(JSON.parse(event.data)); } catch { callbacks.warning('provider_invalid_event'); }
  });
  socket.addEventListener('close', () => { if (!intentional) callbacks.closed('provider_disconnected'); });
  socket.addEventListener('error', () => { if (!intentional) callbacks.closed('provider_error'); });
  return {
    send(pcm) {
      if (socket.readyState !== WebSocket.OPEN || !parser.sessionId) return false;
      socket.send(pcm);
      return true;
    },
    close() {
      intentional = true;
      try { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'Terminate' })); socket.close(1000, 'Intake stopped'); } catch { /* Already closed. */ }
    }
  };
}
