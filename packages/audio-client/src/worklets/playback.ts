import { PlaybackQueue, type PlaybackIdentity } from '../playback';
import { BandlimitedResampler } from '../resampler';
import { pcm16ToFloat } from '../protocol';

interface AudioMessage extends PlaybackIdentity {
  type: 'pcm' | 'float';
  sampleRate: number;
  samples?: Float32Array;
  pcm?: ArrayBuffer;
  complete?: boolean;
  responseId: number;
}

class NurseBridgePlayback extends AudioWorkletProcessor {
  private readonly queue: PlaybackQueue;
  private resamplers = new Map<string, BandlimitedResampler>();
  private readonly diagnostic: boolean;
  private playedSamples = 0;
  private energy = 0;
  private ticks = 0;
  private ready = false;
  private windowPlayed = 0;
  private windowCrossings = 0;
  private previousSample = 0;
  private controlEpoch = 0;
  private agentSamplesInEpoch = 0;
  private humanSamplesInEpoch = 0;

  constructor(options?: { processorOptions?: Record<string, unknown> }) {
    super(options);
    this.diagnostic = options?.processorOptions?.testMode === true;
    this.queue = new PlaybackQueue(sampleRate, identity => {
      this.port.postMessage({ type: 'consumed', sequence: identity.sequence, streamKind: identity.streamKind, local: identity.local, dropped: identity.dropped === true });
    }, 0.08, 2, (identity, samples) => {
      if (!this.diagnostic) return;
      if (identity.streamKind === 3) this.agentSamplesInEpoch += samples;
      else this.humanSamplesInEpoch += samples;
    });
    this.port.onmessage = ({ data }: MessageEvent<AudioMessage | { type: 'flush'; controlEpoch: number; generation: number; acknowledge?: boolean }>) => {
      if (data.type === 'flush') {
        if (data.controlEpoch > this.controlEpoch) {
          this.controlEpoch = data.controlEpoch;
          this.agentSamplesInEpoch = 0;
          this.humanSamplesInEpoch = 0;
          this.windowPlayed = 0;
          this.windowCrossings = 0;
          this.previousSample = 0;
        }
        this.queue.flush(data.controlEpoch, data.generation);
        this.resamplers.clear();
        this.port.postMessage({ type: 'flushed', controlEpoch: data.controlEpoch, generation: data.generation, acknowledge: data.acknowledge });
        return;
      }
      if (!this.queue.accepts(data)) {
        this.port.postMessage({ type: 'consumed', sequence: data.sequence, streamKind: data.streamKind, local: data.local, dropped: true });
        return;
      }
      let samples = data.type === 'pcm' ? pcm16ToFloat(new Uint8Array(data.pcm!)) : data.samples!;
      if (data.sampleRate !== sampleRate) {
        const key = `${data.streamKind}:${data.responseId}:${data.sampleRate}`;
        let resampler = this.resamplers.get(key);
        if (!resampler) {
          // At most patient, nurse, and current agent response are retained.
          if (this.resamplers.size >= 3) this.resamplers.clear();
          resampler = new BandlimitedResampler(data.sampleRate, sampleRate);
          this.resamplers.set(key, resampler);
        }
        const head = resampler.push(samples);
        const tail = data.complete ? resampler.finish() : new Float32Array();
        samples = new Float32Array(head.length + tail.length);
        samples.set(head);
        samples.set(tail, head.length);
        if (data.complete) this.resamplers.delete(key);
      }
      const result = this.queue.enqueue(samples, data);
      if (result === 'overflow') this.port.postMessage({ type: 'overflow' });
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!this.ready) {
      this.ready = true;
      this.port.postMessage({ type: 'playback-ready' });
    }
    const played = this.queue.render(output);
    for (const channel of outputs[0] ?? []) if (channel !== output) channel.set(output);
    if (this.diagnostic) {
      this.playedSamples += played;
      this.windowPlayed += played;
      for (let i = 0; i < played; i++) {
        const value = output[i]!;
        this.energy += value * value;
        if (this.previousSample < 0 && value >= 0) this.windowCrossings++;
        this.previousSample = value;
      }
      this.ticks += output.length;
      if (this.ticks >= sampleRate / 4) {
        this.port.postMessage({ type: 'diagnostic', playedSamples: this.playedSamples, rms: this.playedSamples ? Math.sqrt(this.energy / this.playedSamples) : 0, underruns: this.queue.underruns, queuedSamples: this.queue.queuedSamples, dominantFrequency: this.windowPlayed ? this.windowCrossings * sampleRate / this.windowPlayed : 0, zeroCrossings: this.windowCrossings, controlEpoch: this.controlEpoch, agentSamplesInEpoch: this.agentSamplesInEpoch, humanSamplesInEpoch: this.humanSamplesInEpoch });
        this.ticks = 0;
        this.windowPlayed = 0;
        this.windowCrossings = 0;
      }
    }
    return true;
  }
}

registerProcessor('nursebridge-playback', NurseBridgePlayback);
