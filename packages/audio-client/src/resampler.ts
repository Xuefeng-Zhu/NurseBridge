/** Stateful, windowed-sinc low-pass resampler. No per-render-block phase reset. */
export class BandlimitedResampler {
  private samples: number[] = [];
  private base = 0;
  private next = 0;
  private received = 0;
  private ended = false;
  private readonly ratio: number;
  private readonly cutoff: number;
  private readonly radius = 32;

  constructor(readonly inputRate: number, readonly outputRate: number) {
    if (![inputRate, outputRate].every(rate => Number.isFinite(rate) && rate >= 8000 && rate <= 192000)) {
      throw new Error('Unsupported resampling rate');
    }
    this.ratio = inputRate / outputRate;
    this.cutoff = Math.min(1, outputRate / inputRate) * 0.94;
  }

  push(input: Float32Array): Float32Array {
    if (this.ended) throw new Error('Resampler already ended');
    for (const sample of input) this.samples.push(Number.isFinite(sample) ? sample : 0);
    this.received += input.length;
    return this.render(false);
  }

  /** Emit the finite tail using zero extension. Used only at a complete audio-unit boundary. */
  finish(): Float32Array {
    if (this.ended) return new Float32Array();
    this.ended = true;
    return this.render(true);
  }

  private render(flush: boolean): Float32Array {
    const output: number[] = [];
    while (flush ? this.next < this.received - 1e-7 : this.next + this.radius < this.received) {
      let value = 0;
      let weights = 0;
      const left = Math.ceil(this.next - this.radius);
      const right = Math.floor(this.next + this.radius);
      for (let index = left; index <= right; index++) {
        const distance = this.next - index;
        const phase = Math.PI * distance * this.cutoff;
        const sinc = Math.abs(phase) < 1e-9 ? 1 : Math.sin(phase) / phase;
        const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / this.radius);
        const weight = this.cutoff * sinc * window;
        value += (this.samples[index - this.base] ?? 0) * weight;
        weights += weight;
      }
      output.push(weights ? value / weights : 0);
      this.next += this.ratio;
    }
    const discard = Math.max(0, Math.floor(this.next) - this.radius - this.base);
    if (discard) {
      this.samples.splice(0, discard);
      this.base += discard;
    }
    return new Float32Array(output);
  }
}

export class SampleFramer {
  private buffer: Float32Array;
  private offset = 0;
  constructor(readonly size = 1200) {
    if (!Number.isInteger(size) || size <= 0) throw new Error('Invalid frame size');
    this.buffer = new Float32Array(size);
  }
  push(samples: Float32Array): Float32Array[] {
    const frames: Float32Array[] = [];
    for (const sample of samples) {
      this.buffer[this.offset++] = sample;
      if (this.offset === this.size) {
        frames.push(this.buffer);
        this.buffer = new Float32Array(this.size);
        this.offset = 0;
      }
    }
    return frames;
  }
}
