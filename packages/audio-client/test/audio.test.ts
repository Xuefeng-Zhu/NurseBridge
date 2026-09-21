import { describe, expect, it } from 'vitest';
import { BandlimitedResampler, SampleFramer } from '../src/resampler';
import { AUDIO_FRAME_BYTES, AUDIO_FRAME_SAMPLES, AUDIO_SAMPLE_RATE, AudioStreamKind, decodeAudioFrame, encodeAudioFrame, floatToPcm16, pcm16ToFloat, PcmChunkAssembler } from '../src/protocol';
import { PlaybackQueue, type PlaybackIdentity } from '../src/playback';

function concatenate(parts: Float32Array[]): Float32Array {
  const result = new Float32Array(parts.reduce((length, part) => length + part.length, 0));
  let cursor = 0;
  for (const part of parts) { result.set(part, cursor); cursor += part.length; }
  return result;
}

function resample(samples: Float32Array, inputRate: number, chunkSize = 128): Float32Array {
  const resampler = new BandlimitedResampler(inputRate, AUDIO_SAMPLE_RATE);
  const parts: Float32Array[] = [];
  for (let offset = 0; offset < samples.length; offset += chunkSize) parts.push(resampler.push(samples.subarray(offset, offset + chunkSize)));
  parts.push(resampler.finish());
  return concatenate(parts);
}

function tone(rate: number, frequency: number): Float32Array {
  return Float32Array.from({ length: rate }, (_, index) => Math.sin(2 * Math.PI * frequency * index / rate) * 0.8);
}

function rms(samples: Float32Array): number {
  return Math.sqrt(samples.reduce((energy, value) => energy + value * value, 0) / samples.length);
}

describe('bandlimited microphone resampling', () => {
  it.each([44100, 48000])('produces exactly one second at 24k from %iHz and preserves a speech-band tone', rate => {
    const result = resample(tone(rate, 1000), rate);
    expect(result.length).toBe(AUDIO_SAMPLE_RATE);
    expect(rms(result.subarray(100, AUDIO_SAMPLE_RATE - 100))).toBeCloseTo(0.8 / Math.sqrt(2), 2);
    // 1000 cycles measured as upward zero crossings; catches relabelled source bytes.
    let crossings = 0;
    for (let i = 1; i < result.length; i++) if (result[i - 1]! < 0 && result[i]! >= 0) crossings++;
    expect(crossings).toBeGreaterThanOrEqual(998);
    expect(crossings).toBeLessThanOrEqual(1001);
  });

  it('suppresses above-Nyquist energy instead of aliasing it into speech', () => {
    const filtered = resample(tone(48000, 18000), 48000).subarray(100, AUDIO_SAMPLE_RATE - 100);
    expect(rms(filtered)).toBeLessThan(0.002);
  });

  it('retains phase and filter history across irregular render blocks', () => {
    const input = tone(44100, 1700);
    const regular = resample(input, 44100, 128);
    const irregular = resample(input, 44100, 317);
    expect(irregular.length).toBe(regular.length);
    expect(Math.max(...regular.map((value, index) => Math.abs(value - irregular[index]!)))).toBeLessThan(1e-6);
  });

  it('frames a continuous resampled stream into exact 50ms payloads', () => {
    const resampler = new BandlimitedResampler(48000, AUDIO_SAMPLE_RATE);
    const framer = new SampleFramer();
    const input = tone(48000, 400);
    const frames: Float32Array[] = [];
    for (let i = 0; i < input.length; i += 128) frames.push(...framer.push(resampler.push(input.subarray(i, i + 128))));
    frames.push(...framer.push(resampler.finish()));
    expect(frames).toHaveLength(20);
    for (const frame of frames) {
      expect(frame).toHaveLength(AUDIO_FRAME_SAMPLES);
      expect(floatToPcm16(frame)).toHaveLength(AUDIO_FRAME_BYTES);
    }
  });
});

describe('audio framing and byte format', () => {
  const identity = { streamKind: AudioStreamKind.Patient, sequence: 9, sampleRate: AUDIO_SAMPLE_RATE, controlEpoch: 4, generation: 5, responseId: 6 };
  it('round trips metadata without including application header in provider PCM', () => {
    const payload = floatToPcm16(new Float32Array([-1, 0, 1]));
    const decoded = decodeAudioFrame(encodeAudioFrame({ ...identity, payload }));
    expect(decoded).toEqual({ ...identity, payload });
    expect(Array.from(decoded.payload)).toEqual([0, 128, 0, 0, 255, 127]);
    expect(pcm16ToFloat(decoded.payload)[0]).toBe(-1);
  });

  it('rejects truncated, unknown, misaligned, and oversized wire frames', () => {
    expect(() => decodeAudioFrame(new ArrayBuffer(27))).toThrow('Truncated');
    const buffer = encodeAudioFrame({ ...identity, payload: new Uint8Array(AUDIO_FRAME_BYTES) });
    new Uint8Array(buffer)[4] = 2;
    expect(() => decodeAudioFrame(buffer)).toThrow('Unsupported');
    expect(() => encodeAudioFrame({ ...identity, payload: new Uint8Array(3) })).toThrow('PCM');
    expect(() => encodeAudioFrame({ ...identity, payload: new Uint8Array(96002) })).toThrow('PCM');
  });

  it('reassembles odd provider chunk boundaries and detects an incomplete final sample', () => {
    const assembler = new PcmChunkAssembler();
    expect(Array.from(assembler.push(new Uint8Array([1, 2, 3])))).toEqual([1, 2]);
    expect(Array.from(assembler.push(new Uint8Array([4, 5])))).toEqual([3, 4]);
    expect(() => assembler.finish()).toThrow('incomplete');
    expect(Array.from(assembler.push(new Uint8Array([6])))).toEqual([5, 6]);
    expect(() => assembler.finish()).not.toThrow();
  });
});

describe('actual playback queue cancellation and flow control', () => {
  const agent = { streamKind: 3, sequence: 1, controlEpoch: 0, generation: 0 };
  it('acknowledges only samples consumed and preserves short-utterance jitter buffering', () => {
    const acknowledgments: PlaybackIdentity[] = [];
    const queue = new PlaybackQueue(AUDIO_SAMPLE_RATE, item => acknowledgments.push(item));
    queue.enqueue(new Float32Array(AUDIO_FRAME_SAMPLES).fill(0.5), agent);
    expect(acknowledgments).toHaveLength(0);
    const output = new Float32Array(128);
    for (let i = 0; i < 14; i++) expect(queue.render(output)).toBe(0);
    expect(queue.render(output)).toBe(128);
    expect(output[0]).toBe(0.5);
    for (let i = 0; i < 9; i++) queue.render(output);
    expect(acknowledgments).toHaveLength(1);
    expect(queue.queuedSamples).toBe(0);
  });

  it('flushes already-queued agent samples and rejects late frames after takeover', () => {
    const queue = new PlaybackQueue(AUDIO_SAMPLE_RATE, () => undefined, 0);
    queue.enqueue(new Float32Array(AUDIO_FRAME_SAMPLES).fill(0.9), agent);
    const output = new Float32Array(128);
    queue.render(output);
    expect(output[0]).toBeCloseTo(0.9);
    queue.flush(1, 1);
    expect(queue.enqueue(new Float32Array(AUDIO_FRAME_SAMPLES).fill(0.9), agent)).toBe('stale');
    expect(queue.render(output)).toBe(0);
    expect(output.every(value => value === 0)).toBe(true);
    expect(queue.enqueue(new Float32Array(AUDIO_FRAME_SAMPLES).fill(0.25), { ...agent, streamKind: 2, controlEpoch: 1, generation: 0 })).toBe('accepted');
    queue.render(output);
    expect(output[0]).toBe(0.25);
  });

  it('rejects stale AI generations on barge-in without blocking human media', () => {
    const queue = new PlaybackQueue(AUDIO_SAMPLE_RATE, () => undefined, 0);
    queue.flush(0, 2);
    expect(queue.enqueue(new Float32Array(AUDIO_FRAME_SAMPLES), { ...agent, generation: 1 })).toBe('stale');
    expect(queue.enqueue(new Float32Array(AUDIO_FRAME_SAMPLES), { ...agent, streamKind: 1, generation: 0 })).toBe('accepted');
    expect(queue.flush(0, 1)).toBe(false);
  });

  it('bounds the queue and outputs silence on underrun instead of repeating old audio', () => {
    const queue = new PlaybackQueue(AUDIO_SAMPLE_RATE, () => undefined, 0, 0.1);
    expect(queue.enqueue(new Float32Array(2400).fill(0.2), agent)).toBe('accepted');
    expect(queue.enqueue(new Float32Array(2), { ...agent, sequence: 2 })).toBe('overflow');
    const output = new Float32Array(3000);
    expect(queue.render(output)).toBe(2400);
    expect(output.subarray(2400).every(value => value === 0)).toBe(true);
    expect(queue.underruns).toBe(1);
  });
});
