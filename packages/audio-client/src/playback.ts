export interface PlaybackIdentity {
  controlEpoch: number;
  generation: number;
  streamKind: number;
  sequence: number;
  local?: boolean;
  dropped?: boolean;
}

interface QueuedAudio extends PlaybackIdentity { samples: Float32Array; offset: number }

/** Pure audio queue shared by the worklet and deterministic cancellation tests. */
export class PlaybackQueue {
  private queue: QueuedAudio[] = [];
  private queued = 0;
  private started = false;
  private epoch = 0;
  private generation = 0;
  private idleTicks = 0;
  underruns = 0;

  constructor(
    readonly sampleRate: number,
    private readonly acknowledge: (identity: PlaybackIdentity) => void,
    readonly jitterSeconds = 0.08,
    readonly maxSeconds = 2,
    private readonly onPlay?: (identity: PlaybackIdentity, samples: number) => void,
  ) {}

  get queuedSamples(): number { return this.queued; }

  accepts(identity: Pick<PlaybackIdentity, 'controlEpoch' | 'generation' | 'streamKind'>): boolean {
    return identity.controlEpoch === this.epoch && (identity.streamKind !== 3 || identity.generation >= this.generation);
  }

  enqueue(samples: Float32Array, identity: PlaybackIdentity): 'accepted' | 'stale' | 'overflow' {
    if (!this.accepts(identity)) { this.acknowledge({ ...identity, dropped: true }); return 'stale'; }
    if (samples.length + this.queued > this.sampleRate * this.maxSeconds) {
      this.acknowledge({ ...identity, dropped: true });
      return 'overflow';
    }
    if (!samples.length) { this.acknowledge(identity); return 'accepted'; }
    this.queue.push({ ...identity, samples, offset: 0 });
    this.queued += samples.length;
    return 'accepted';
  }

  flush(controlEpoch: number, generation: number): boolean {
    if (controlEpoch < this.epoch || (controlEpoch === this.epoch && generation < this.generation)) return false;
    for (const frame of this.queue) this.acknowledge({ ...frame, dropped: true });
    this.queue = [];
    this.queued = 0;
    this.started = false;
    this.idleTicks = 0;
    this.epoch = controlEpoch;
    this.generation = generation;
    return true;
  }

  render(output: Float32Array): number {
    output.fill(0);
    if (!this.started) {
      if (!this.queued) { this.idleTicks = 0; return 0; }
      this.idleTicks += output.length;
      // Also start a short final utterance after the target jitter delay.
      if (this.queued < this.sampleRate * this.jitterSeconds && this.idleTicks < this.sampleRate * this.jitterSeconds) return 0;
      this.started = true;
    }
    let offset = 0;
    while (offset < output.length && this.queue.length) {
      const frame = this.queue[0]!;
      const size = Math.min(output.length - offset, frame.samples.length - frame.offset);
      output.set(frame.samples.subarray(frame.offset, frame.offset + size), offset);
      this.onPlay?.(frame, size);
      offset += size;
      frame.offset += size;
      this.queued -= size;
      if (frame.offset === frame.samples.length) {
        this.queue.shift();
        this.acknowledge(frame);
      }
    }
    if (offset < output.length) {
      this.underruns++;
      this.started = false;
      this.idleTicks = 0;
    }
    return offset;
  }
}
