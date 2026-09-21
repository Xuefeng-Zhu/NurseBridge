import { AUDIO_FRAME_BYTES, AUDIO_SAMPLE_RATE, AudioStreamKind, decodeAudioFrame, encodeAudioFrame, type AudioFrame } from './protocol';

export interface BrowserCallState {
  connection: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'closed' | 'error';
  microphone: 'idle' | 'requesting' | 'ready' | 'denied' | 'error';
  playback: 'idle' | 'ready' | 'blocked' | 'error';
  muted: boolean;
  error?: string;
}

export interface AudioDiagnostics {
  receivedFrames: number;
  playedSamples: number;
  rms: number;
  underruns: number;
  droppedFrames: number;
  queuedSamples: number;
  /** Test-only zero-crossing estimate over the last250ms; suitable for synthetic sine fixtures. */
  dominantFrequency: number;
  zeroCrossings: number;
  controlEpoch: number;
  agentSamplesInEpoch: number;
  humanSamplesInEpoch: number;
}

export interface BrowserCallOptions {
  role: 'caller' | 'nurse' | 'observer';
  onEvent?: (event: Record<string, unknown>) => void;
  onState?: (state: BrowserCallState) => void;
  onDiagnostics?: (diagnostics: AudioDiagnostics) => void;
  getReconnectTicket?: () => Promise<{ ticket: string; url?: string }>;
  workletBaseUrl?: string;
  testMode?: boolean;
}

interface EncodedPlayback {
  samples: Float32Array;
  sampleRate: number;
  cursor: number;
  remaining: number;
  controlEpoch: number;
  generation: number;
  responseId: number;
  sequence: number;
}

/** Browser-only, microphone-driven transport. Never stores case content or credentials. */
export class BrowserCall {
  private state: BrowserCallState = { connection: 'idle', microphone: 'idle', playback: 'idle', muted: false };
  private socket: WebSocket | undefined;
  private context: AudioContext | undefined;
  private microphone: MediaStream | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private capture: AudioWorkletNode | undefined;
  private playback: AudioWorkletNode | undefined;
  private silentSink: GainNode | undefined;
  private mediaPromise: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private lastServerMessage = 0;
  private connectionVersion = 0;
  private intentionalClose = false;
  private url = '';
  private credits = 0;
  private sequence = 0;
  private epoch = 0;
  private generation = 0;
  private agentActive = false;
  private pendingAgentFrames = new Set<number>();
  private dropped = 0;
  private gapReported = false;
  private receivedFrames = 0;
  private playedSamples = 0;
  private role: BrowserCallOptions['role'];
  private encoded: EncodedPlayback | undefined;
  private encodedSequence = 0;
  private localPending = new Map<number, EncodedPlayback>();

  constructor(private readonly options: BrowserCallOptions) { this.role = options.role; }

  getState(): BrowserCallState { return { ...this.state }; }

  async connect(ticket: string, url: string): Promise<void> {
    this.intentionalClose = false;
    this.url = url;
    const version = ++this.connectionVersion;
    this.socket?.close(1000, 'Connection renewed');
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    this.credits = 0;
    this.update({ connection: this.reconnectAttempt ? 'reconnecting' : 'connecting', error: undefined });
    await new Promise<void>((resolve, reject) => {
      let authenticated = false;
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.binaryType = 'arraybuffer';
      const timeout = setTimeout(() => {
        if (!authenticated) { socket.close(1000, 'Authentication timed out'); reject(new Error('Connection authentication timed out')); }
      }, 8000);
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', ticket }));
      socket.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => {
        if (version !== this.connectionVersion) return;
        this.lastServerMessage = Date.now();
        if (data instanceof ArrayBuffer) {
          if (authenticated) this.receiveAudio(data);
          return;
        }
        let event: Record<string, unknown>;
        try { event = JSON.parse(data) as Record<string, unknown>; } catch { return; }
        if (event.type === 'authenticated') {
          authenticated = true;
          clearTimeout(timeout);
          this.credits = Math.min(20, Math.max(0, Number(event.credits) || 0));
          if (event.role === 'caller' || event.role === 'nurse' || event.role === 'observer') this.role = event.role;
          this.reconnectAttempt = 0;
          this.update({ connection: 'connected', error: undefined });
          this.readSnapshot(event.snapshot);
          this.announceReadiness();
          this.scheduleHeartbeat(version);
          resolve();
        } else if (!authenticated) {
          if (event.type === 'error') {
            clearTimeout(timeout);
            reject(new Error(typeof event.message === 'string' ? event.message : 'Connection authentication rejected'));
            socket.close(1000, 'Authentication rejected');
          }
          return;
        }
        this.handleEvent(event);
      };
      socket.onerror = () => {
        if (version !== this.connectionVersion) return;
        this.update({ error: 'Audio connection failed. Request a person or reconnect.' });
      };
      socket.onclose = () => {
        clearTimeout(timeout);
        if (!authenticated) reject(new Error('Audio connection closed before authentication'));
        if (version !== this.connectionVersion) return;
        clearTimeout(this.heartbeatTimer);
        this.credits = 0;
        this.agentActive = false;
        this.flush(this.epoch, this.generation, false);
        if (!this.intentionalClose) {
          this.update({ connection: 'disconnected', error: 'Audio disconnected. Speech during this gap was not transmitted.' });
          this.options.onEvent?.({ type: 'connection-gap' });
          this.scheduleReconnect();
        }
      };
    });
  }

  /** Invoke directly from a user click, before awaiting network work. */
  enableMedia(): Promise<void> {
    if (this.mediaPromise) return this.mediaPromise;
    if (this.state.microphone === 'ready' && this.context) {
      return this.context.resume().then(() => {
        this.update({ playback: this.context?.state === 'running' ? 'ready' : 'blocked' });
        this.announceReadiness();
      });
    }
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return Promise.reject(new Error('Microphone audio requires HTTPS or localhost and a supported browser.'));
    }
    // These happen in the initiating gesture, not after a ticket network request.
    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    const context = this.context;
    const resume = context.resume();
    this.update({ microphone: 'requesting', error: undefined });
    const microphone = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      video: false,
    });
    const base = this.options.workletBaseUrl ?? '/worklets';
    this.mediaPromise = (async () => {
      const stream = await microphone;
      if (this.intentionalClose) { stream.getTracks().forEach(track => track.stop()); return; }
      this.microphone = stream;
      await Promise.all([resume, context.audioWorklet.addModule(`${base}/capture.js`), context.audioWorklet.addModule(`${base}/playback.js`)]);
      if (this.intentionalClose) { stream.getTracks().forEach(track => track.stop()); return; }
      this.source = context.createMediaStreamSource(stream);
      this.capture = new AudioWorkletNode(context, 'nursebridge-capture', { channelCount: 1, outputChannelCount: [1] });
      this.playback = new AudioWorkletNode(context, 'nursebridge-playback', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { testMode: this.options.testMode === true },
      });
      this.silentSink = context.createGain();
      this.silentSink.gain.value = 0;
      this.source.connect(this.capture);
      this.capture.connect(this.silentSink).connect(context.destination);
      this.playback.connect(context.destination);
      this.capture.port.onmessage = ({ data }: MessageEvent<{ type: string; pcm?: ArrayBuffer }>) => {
        if (data.type === 'frame' && data.pcm) {
          if (this.state.microphone === 'requesting') {
            this.update({ microphone: 'ready' });
            this.announceReadiness();
          }
          this.sendMicrophone(data.pcm);
        }
        if (data.type === 'speech-start' && (this.agentActive || this.pendingAgentFrames.size > 0 || this.encoded) && this.role === 'caller') {
          this.agentActive = false;
          this.generation++;
          this.flush(this.epoch, this.generation, false);
          this.sendControl({ type: 'barge-in', controlEpoch: this.epoch });
          this.options.onEvent?.({ type: 'local-barge-in' });
        }
      };
      this.playback.port.onmessage = ({ data }: MessageEvent<Record<string, unknown>>) => this.handlePlayback(data);
      this.capture.port.postMessage({ type: 'mute', muted: this.state.muted });
      this.playback.port.postMessage({ type: 'flush', controlEpoch: this.epoch, generation: this.generation, acknowledge: false });
      for (const track of stream.getAudioTracks()) track.onended = () => {
        this.update({ microphone: 'error', error: 'Microphone disconnected. Human access remains available.' });
        this.sendControl({ type: 'media-ready', microphone: false, playback: this.state.playback === 'ready' });
      };
      context.onstatechange = () => {
        if (context.state !== 'running' && !this.intentionalClose) {
          this.update({ playback: 'blocked', error: 'Audio playback paused. Enable audio again to continue.' });
          this.announceReadiness();
        }
      };
      // Readiness follows the first captured PCM frame and playback worklet render tick.
      if (context.state !== 'running') this.update({ playback: 'blocked' });
    })().catch((error: unknown) => {
      this.microphone?.getTracks().forEach(track => track.stop());
      this.microphone = undefined;
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      this.update({ microphone: denied ? 'denied' : 'error', playback: 'error', error: denied ? 'Microphone permission was declined. You can still request a person.' : 'Audio could not start. Check microphone permissions and retry.' });
      this.sendControl({ type: 'media-ready', microphone: false, playback: false });
      throw error;
    }).finally(() => { this.mediaPromise = undefined; });
    return this.mediaPromise;
  }

  mute(muted = true): void {
    this.update({ muted });
    this.capture?.port.postMessage({ type: 'mute', muted });
    // Worklet keeps continuous zero PCM delivery while muted.
  }

  sendControl(message: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN || this.state.connection !== 'connected') return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  close(): void {
    this.intentionalClose = true;
    this.connectionVersion++;
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'Participant closed connection');
    this.socket = undefined;
    this.microphone?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.source?.disconnect();
    this.capture?.disconnect();
    this.playback?.disconnect();
    this.silentSink?.disconnect();
    if (this.context) { this.context.onstatechange = null; void this.context.close().catch(() => undefined); }
    this.context = undefined;
    this.capture = undefined;
    this.playback = undefined;
    this.microphone = undefined;
    this.encoded = undefined;
    this.localPending.clear();
    this.pendingAgentFrames.clear();
    this.update({ connection: 'closed', microphone: 'idle', playback: 'idle' });
  }

  private update(patch: Partial<BrowserCallState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState?.(this.getState());
  }

  private announceReadiness(): void {
    if (this.state.microphone !== 'idle') this.sendControl({ type: 'media-ready', microphone: this.state.microphone === 'ready', playback: this.state.playback === 'ready' });
  }

  private sendMicrophone(pcm: ArrayBuffer): void {
    if (this.role === 'observer' || this.state.connection !== 'connected') return;
    if (pcm.byteLength !== AUDIO_FRAME_BYTES) {
      this.update({ error: 'Microphone produced an unsupported audio frame.' });
      return;
    }
    if (!this.credits || !this.socket || this.socket.bufferedAmount > 64_000) {
      this.dropped++;
      if (!this.gapReported) {
        this.gapReported = true;
        this.update({ error: 'Audio congestion: some microphone audio was not transmitted.' });
        this.options.onEvent?.({ type: 'audio-gap', reason: 'capture-backpressure' });
      }
      return;
    }
    if (this.gapReported) {
      this.sendControl({ type: 'audio-gap', reason: 'capture-backpressure', droppedFrames: this.dropped });
      this.gapReported = false;
    }
    this.credits--;
    this.socket.send(encodeAudioFrame({
      streamKind: this.role === 'caller' ? AudioStreamKind.Patient : AudioStreamKind.Nurse,
      sequence: this.sequence++ >>> 0, sampleRate: AUDIO_SAMPLE_RATE, controlEpoch: this.epoch,
      generation: this.generation, responseId: 0, payload: new Uint8Array(pcm),
    }));
  }

  private readSnapshot(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const snapshot = value as Record<string, unknown>;
    if (snapshot.conversationOwner === 'NURSE' || snapshot.conversationOwner === 'NONE') this.agentActive = false;
    const epoch = Number(snapshot.controlEpoch);
    const generation = Number(snapshot.generation ?? snapshot.responseGeneration ?? 0);
    if (Number.isInteger(epoch) && epoch >= this.epoch) {
      const changed = epoch !== this.epoch || generation > this.generation;
      if (changed) this.flush(epoch, generation, false);
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    if (event.type === 'snapshot') this.readSnapshot(event.snapshot);
    if (event.type === 'audio-ack') this.credits = Math.min(20, this.credits + Math.max(0, Number(event.credits) || 0));
    if (event.type === 'flush') this.flush(Number(event.controlEpoch), Number(event.generation), true);
    if (event.type === 'agent-status') this.agentActive = event.status === 'speaking' || event.status === 'thinking';
    if (event.type === 'encoded-audio') void this.receiveEncoded(event);
    if (event.type === 'error') this.update({ error: typeof event.message === 'string' ? event.message : 'Call component unavailable.' });
    this.options.onEvent?.(event);
  }

  private flush(controlEpoch: number, generation: number, acknowledge: boolean): void {
    if (!Number.isInteger(controlEpoch) || !Number.isInteger(generation) || controlEpoch < this.epoch || (controlEpoch === this.epoch && generation < this.generation)) return;
    this.epoch = controlEpoch;
    this.generation = generation;
    this.encoded = undefined;
    this.localPending.clear();
    this.pendingAgentFrames.clear();
    if (this.playback) {
      this.playback.port.postMessage({ type: 'flush', controlEpoch, generation, acknowledge });
    } else if (acknowledge) this.sendControl({ type: 'playback-flushed', controlEpoch, generation });
  }

  private receiveAudio(buffer: ArrayBuffer): void {
    let frame: AudioFrame;
    try { frame = decodeAudioFrame(buffer); } catch {
      this.update({ error: 'Unsupported audio frame rejected.' });
      return;
    }
    this.receivedFrames++;
    if (!this.playback || this.state.playback !== 'ready' || frame.controlEpoch !== this.epoch || (frame.streamKind === AudioStreamKind.Agent && frame.generation < this.generation)) {
      this.sendControl({ type: 'audio-ack', sequence: frame.sequence, streamKind: frame.streamKind, dropped: true });
      return;
    }
    const pcm = frame.payload.slice().buffer;
    if (frame.streamKind === AudioStreamKind.Agent) this.pendingAgentFrames.add(frame.sequence);
    this.playback.port.postMessage({ ...frame, payload: undefined, type: 'pcm', pcm }, [pcm]);
  }

  private handlePlayback(event: Record<string, unknown>): void {
    if (event.type === 'playback-ready') {
      this.update({ playback: this.context?.state === 'running' ? 'ready' : 'blocked' });
      this.announceReadiness();
    }
    if (event.type === 'consumed') {
      if (event.local === true) {
        const sequence = Number(event.sequence);
        const job = this.localPending.get(sequence);
        this.localPending.delete(sequence);
        if (job && job === this.encoded) {
          job.remaining--;
          this.fillEncoded(job);
          if (!job.remaining && job.cursor >= job.samples.length) {
            this.sendControl({ type: 'audio-ack', sequence: job.sequence, streamKind: AudioStreamKind.Agent });
            this.encoded = undefined;
          }
        }
      } else {
        if (event.streamKind === AudioStreamKind.Agent) this.pendingAgentFrames.delete(Number(event.sequence));
        this.sendControl({ type: 'audio-ack', sequence: event.sequence, streamKind: event.streamKind, dropped: event.dropped === true });
      }
    }
    if (event.type === 'flushed' && event.acknowledge === true) {
      this.sendControl({ type: 'playback-flushed', controlEpoch: event.controlEpoch, generation: event.generation });
    }
    if (event.type === 'overflow') {
      this.dropped++;
      this.update({ error: 'Audio playback congestion. A playback gap occurred.' });
      this.sendControl({ type: 'audio-gap', reason: 'playback-overflow', droppedFrames: 1 });
    }
    if (event.type === 'diagnostic' && this.options.testMode) {
      this.playedSamples = Number(event.playedSamples);
      this.options.onDiagnostics?.({ receivedFrames: this.receivedFrames, playedSamples: this.playedSamples, rms: Number(event.rms), underruns: Number(event.underruns), droppedFrames: this.dropped, queuedSamples: Number(event.queuedSamples), dominantFrequency: Number(event.dominantFrequency), zeroCrossings: Number(event.zeroCrossings), controlEpoch: Number(event.controlEpoch), agentSamplesInEpoch: Number(event.agentSamplesInEpoch), humanSamplesInEpoch: Number(event.humanSamplesInEpoch) });
    }
  }

  private async receiveEncoded(event: Record<string, unknown>): Promise<void> {
    const epoch = Number(event.controlEpoch);
    const generation = Number(event.generation);
    const reject = () => this.sendControl({ type: 'audio-ack', sequence: event.sequence ?? event.responseId, streamKind: AudioStreamKind.Agent, dropped: true });
    if (epoch !== this.epoch || generation < this.generation || !this.context || !this.playback) { reject(); return; }
    try {
      if (typeof event.data !== 'string' || event.data.length > 2_000_000 || !['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac'].includes(String(event.mimeType))) throw new Error('Unsupported encoded audio');
      const bytes = Uint8Array.from(atob(event.data), character => character.charCodeAt(0));
      // decodeAudioData receives one complete encoded unit, never arbitrary stream fragments.
      const decoded = await this.context.decodeAudioData(bytes.buffer);
      if (epoch !== this.epoch || generation < this.generation || this.intentionalClose) { reject(); return; }
      if (decoded.duration > 30 || decoded.duration <= 0) throw new Error('Encoded utterance duration exceeded');
      const samples = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const input = decoded.getChannelData(channel);
        for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] ?? 0) + input[i]! / decoded.numberOfChannels;
      }
      const job: EncodedPlayback = {
        samples, sampleRate: decoded.sampleRate, cursor: 0, remaining: 0,
        controlEpoch: epoch, generation, responseId: Number(event.responseId) || 0,
        sequence: Number(event.sequence ?? event.responseId) || 0,
      };
      this.encoded = job;
      this.fillEncoded(job);
    } catch {
      reject();
      this.update({ error: 'Speech playback failed. Read the captions or request a person.' });
      this.sendControl({ type: 'audio-gap', reason: 'encoded-audio-decode-failed', droppedFrames: 1 });
    }
  }

  private fillEncoded(job: EncodedPlayback): void {
    while (job.remaining < 6 && job.cursor < job.samples.length && this.playback && this.encoded === job) {
      const size = Math.min(Math.round(job.sampleRate * 0.05), job.samples.length - job.cursor);
      const samples = job.samples.slice(job.cursor, job.cursor + size);
      job.cursor += size;
      job.remaining++;
      const sequence = this.encodedSequence++;
      this.localPending.set(sequence, job);
      this.playback.port.postMessage({
        type: 'float', samples, sampleRate: job.sampleRate, controlEpoch: job.controlEpoch,
        generation: job.generation, responseId: job.responseId, sequence,
        streamKind: AudioStreamKind.Agent, local: true, complete: job.cursor === job.samples.length,
      }, [samples.buffer]);
    }
  }

  private scheduleHeartbeat(version: number): void {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (version !== this.connectionVersion || this.intentionalClose) return;
      if (Date.now() - this.lastServerMessage > 16_000) {
        this.socket?.close(1000, 'Missing server heartbeat');
        return;
      }
      this.sendControl({ type: 'heartbeat' });
      this.scheduleHeartbeat(version);
    }, 5000);
  }

  private scheduleReconnect(): void {
    if (!this.options.getReconnectTicket || this.reconnectAttempt >= 4 || this.intentionalClose) return;
    const attempt = ++this.reconnectAttempt;
    this.update({ connection: 'reconnecting' });
    this.reconnectTimer = setTimeout(() => {
      void this.options.getReconnectTicket!().then(({ ticket, url }) => {
        if (!this.intentionalClose) return this.connect(ticket, url ?? this.url);
      }).catch(() => {
        if (!this.intentionalClose) {
          this.update({ connection: 'disconnected', error: 'Reconnection requires a new call-scoped ticket.' });
          this.scheduleReconnect();
        }
      });
    }, Math.min(8000, 500 * 2 ** (attempt - 1)));
  }
}
