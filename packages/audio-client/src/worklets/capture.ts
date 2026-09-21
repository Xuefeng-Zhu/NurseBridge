import { BandlimitedResampler, SampleFramer } from '../resampler';
import { AUDIO_FRAME_SAMPLES, AUDIO_SAMPLE_RATE, floatToPcm16 } from '../protocol';

class NurseBridgeCapture extends AudioWorkletProcessor {
  private readonly resampler = new BandlimitedResampler(sampleRate, AUDIO_SAMPLE_RATE);
  private readonly framer = new SampleFramer(AUDIO_FRAME_SAMPLES);
  private muted = false;
  private speaking = false;
  private activeSamples = 0;
  private silentSamples = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<{ type: string; muted: boolean }>) => {
      if (data.type === 'mute') this.muted = data.muted;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    const size = channels?.[0]?.length ?? 128;
    const mono = new Float32Array(size);
    if (channels?.length && !this.muted) {
      for (const channel of channels) for (let i = 0; i < size; i++) mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / channels.length;
    }
    const rms = Math.sqrt(mono.reduce((sum, value) => sum + value * value, 0) / size);
    if (rms > 0.018 && !this.muted) {
      this.activeSamples += size;
      this.silentSamples = 0;
      if (!this.speaking && this.activeSamples >= sampleRate * 0.05) {
        this.speaking = true;
        this.port.postMessage({ type: 'speech-start' });
      }
    } else {
      this.silentSamples += size;
      this.activeSamples = 0;
      if (this.silentSamples > sampleRate * 0.3) this.speaking = false;
    }
    for (const frame of this.framer.push(this.resampler.push(mono))) {
      const bytes = floatToPcm16(frame);
      this.port.postMessage({ type: 'frame', pcm: bytes.buffer }, [bytes.buffer]);
    }
    return true;
  }
}

registerProcessor('nursebridge-capture', NurseBridgeCapture);
