import { describe, expect, it } from 'vitest';
import { AUDIO_FRAME_BYTES, floatToPcm16, pcm16ToFloat } from '../../packages/audio-client/src/protocol';
import { decodeMulawSample, encodeMulawSample, MAX_PHONE_PACKET_BYTES, MAX_PHONE_PCM_BYTES, pcm24ToMulaw, PhoneAudioDecoder, PhoneAudioEncoder } from '../../apps/realtime/src/telephony/audio';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}
function bytes(payload: string): Uint8Array { return Uint8Array.from(atob(payload), character => character.charCodeAt(0)); }
function join(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function tone(rate: number, hz: number, duration = 1, amplitude = 0.6): Float32Array {
  return Float32Array.from({ length: rate * duration }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / rate));
}
function rms(samples: Float32Array): number { return Math.sqrt(samples.reduce((total, value) => total + value * value, 0) / samples.length); }
function crossingsHz(samples: Float32Array, rate: number): number {
  const crossings: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1]!, current = samples[i]!;
    if (previous < 0 && current >= 0) crossings.push(i - 1 - previous / (current - previous));
  }
  return (crossings.length - 1) * rate / (crossings.at(-1)! - crossings[0]!);
}
function encodeStream(pcm: Uint8Array, chunkBytes: number): Uint8Array {
  const encoder = new PhoneAudioEncoder();
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) parts.push(bytes(encoder.push(pcm.subarray(offset, offset + chunkBytes))));
  parts.push(bytes(encoder.finish()));
  return join(parts);
}
function decodeStream(input: Uint8Array, chunkBytes: number): Uint8Array {
  const decoder = new PhoneAudioDecoder();
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < input.length; offset += chunkBytes) frames.push(...decoder.push(base64(input.subarray(offset, offset + chunkBytes))));
  expect(frames.every(frame => frame.length === AUDIO_FRAME_BYTES)).toBe(true);
  return join(frames);
}

describe('Twilio headerless G.711 mu-law codec', () => {
  it('matches signed PCM and mu-law reference code words, including both zero codes', () => {
    const decodeVectors = [[0xff, 0], [0x7f, 0], [0xfe, 8], [0x7e, -8], [0xef, 132], [0x6f, -132], [0xce, 988], [0x4e, -988], [0x80, 32124], [0x00, -32124]];
    for (const [encoded, pcm] of decodeVectors) expect(decodeMulawSample(encoded!)).toBe(pcm);
    const encodeVectors = [[0, 0xff], [8, 0xfe], [-8, 0x7e], [132, 0xef], [-132, 0x6f], [1000, 0xce], [-1000, 0x4e], [32767, 0x80], [-32768, 0x00]];
    for (const [pcm, encoded] of encodeVectors) expect(encodeMulawSample(pcm!)).toBe(encoded);
    for (let code = 0; code < 256; code++) expect(encodeMulawSample(decodeMulawSample(code))).toBe(code === 0x7f ? 0xff : code);
    expect(encodeMulawSample(999999)).toBe(0x80);
    expect(encodeMulawSample(-999999)).toBe(0x00);
  });

  it('preserves every decoded frame across one-byte and irregular Twilio packet boundaries', () => {
    const encoded = Uint8Array.from(tone(8000, 660), sample => encodeMulawSample(Math.round(sample * 32768)));
    const regular = decodeStream(encoded, 160);
    expect(regular.length).toBe(19 * AUDIO_FRAME_BYTES); // The live filter retains its finite tail.
    expect(decodeStream(encoded, 1)).toEqual(regular);
    expect(decodeStream(encoded, 317)).toEqual(regular);
    expect(decodeStream(encoded, MAX_PHONE_PACKET_BYTES)).toEqual(regular);
  });

  it('preserves downsampling phase across sub-filter chunks and sustained 50ms frames', () => {
    const input = floatToPcm16(tone(24000, 440, 2));
    const frames = encodeStream(input, AUDIO_FRAME_BYTES);
    expect(frames.length).toBe(16000);
    for (const chunkSize of [2, 34, 126, 634, MAX_PHONE_PCM_BYTES]) expect(encodeStream(input, chunkSize)).toEqual(frames);
    expect(bytes(pcm24ToMulaw(input.subarray(0, MAX_PHONE_PCM_BYTES)))).toEqual(encodeStream(input.subarray(0, MAX_PHONE_PCM_BYTES), 34));
  });

  it.each([440, 660])('round trips actual %iHz audio with its frequency and amplitude intact', hz => {
    const input = floatToPcm16(tone(24000, hz));
    const encoded = encodeStream(input, AUDIO_FRAME_BYTES);
    const recovered = pcm16ToFloat(decodeStream(encoded, 137)).subarray(2400, 21600);
    expect(crossingsHz(recovered, 24000)).toBeCloseTo(hz, 0);
    expect(rms(recovered)).toBeGreaterThan(0.40);
    expect(rms(recovered)).toBeLessThan(0.45);
    expect(recovered.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1)).toBe(true);
  });

  it('suppresses above-phone-Nyquist energy before decimation', () => {
    const encoded = encodeStream(floatToPcm16(tone(24000, 6000)), 98);
    const phoneSamples = Float32Array.from(encoded, value => decodeMulawSample(value) / 32768).subarray(100, 7900);
    expect(rms(phoneSamples)).toBeLessThan(0.002);
    const recovered = pcm16ToFloat(decodeStream(encoded, 160)).subarray(2400, 21600);
    expect(rms(recovered)).toBeLessThan(0.002);
  });

  it('handles little-endian PCM slices without reading outside byteOffset or byteLength', () => {
    const samples = Float32Array.from({ length: 1200 }, (_, index) => index % 2 ? -0.7 : 0.25);
    const pcm = floatToPcm16(samples);
    const surrounding = new Uint8Array(pcm.length + 41).fill(0xa5);
    surrounding.set(pcm, 17);
    expect(pcm24ToMulaw(surrounding.subarray(17, 17 + pcm.length))).toBe(pcm24ToMulaw(pcm));
    expect(bytes(pcm24ToMulaw(new Uint8Array([0, 0])))).toHaveLength(1);
    expect(bytes(pcm24ToMulaw(new Uint8Array([0, 0, 0, 0])))).toHaveLength(1);
    expect(bytes(pcm24ToMulaw(new Uint8Array(8)))).toHaveLength(2);
  });

  it('resets filter history and partial inbound frames instead of carrying old audio into the next stream', () => {
    const decoder = new PhoneAudioDecoder();
    expect(decoder.push(base64(new Uint8Array(300).fill(0x80)))).toHaveLength(0);
    decoder.reset();
    const silence = base64(new Uint8Array(432).fill(0xff));
    const afterReset = decoder.push(silence);
    expect(afterReset).toEqual(new PhoneAudioDecoder().push(silence));
    expect(afterReset).toHaveLength(1);
    expect(afterReset[0]!.every(value => value === 0)).toBe(true);
    const encoder = new PhoneAudioEncoder();
    encoder.push(floatToPcm16(new Float32Array(31).fill(0.8)));
    encoder.reset();
    const encoded = encoder.push(new Uint8Array(AUDIO_FRAME_BYTES));
    expect(encoded).toBe(new PhoneAudioEncoder().push(new Uint8Array(AUDIO_FRAME_BYTES)));
    expect(bytes(encoded).every(value => value === 0xff)).toBe(true);
    expect(encoder.finish()).not.toBe('');
    expect(encoder.finish()).toBe('');
    expect(() => encoder.push(new Uint8Array(2))).toThrow('ended');
    encoder.reset();
    expect(() => encoder.push(new Uint8Array(2))).not.toThrow();
  });

  it('rejects malformed, noncanonical, and oversized payloads without mutating decoder state', () => {
    const decoder = new PhoneAudioDecoder();
    const prefix = base64(new Uint8Array(300).fill(0x80));
    decoder.push(prefix);
    const controls = new PhoneAudioDecoder(); controls.push(prefix);
    for (const invalid of ['', '=', '====', 'AA', 'A===', 'AA=A', 'AAAA\n', 'AA-_', 'data:audio/basic;base64,AAAA', 'Zh==', 'Zm9=', 'A'.repeat(Math.ceil(MAX_PHONE_PACKET_BYTES / 3) * 4 + 4), base64(new Uint8Array(MAX_PHONE_PACKET_BYTES + 1))]) {
      expect(() => decoder.push(invalid), invalid.slice(0, 30)).toThrow('base64');
    }
    expect(() => decoder.push(null as unknown as string)).toThrow('base64');
    const tail = base64(new Uint8Array(800).fill(0xff));
    expect(decoder.push(tail)).toEqual(controls.push(tail));
  });

  it('bounds outgoing PCM and rejects invalid samples without corrupting encoder state', () => {
    const encoder = new PhoneAudioEncoder();
    const controls = new PhoneAudioEncoder();
    const prefix = floatToPcm16(new Float32Array(17).fill(0.2));
    encoder.push(prefix); controls.push(prefix);
    for (const invalid of [new Uint8Array(), new Uint8Array(3), new Uint8Array(MAX_PHONE_PCM_BYTES + 2)]) {
      expect(() => encoder.push(invalid)).toThrow('PCM16');
      expect(() => pcm24ToMulaw(invalid)).toThrow('PCM16');
    }
    expect(() => pcm24ToMulaw(null as unknown as Uint8Array)).toThrow('PCM16');
    expect(encoder.push(new Uint8Array(AUDIO_FRAME_BYTES))).toBe(controls.push(new Uint8Array(AUDIO_FRAME_BYTES)));
    for (const invalid of [NaN, Infinity, -Infinity, 1.5]) expect(() => encodeMulawSample(invalid)).toThrow('PCM16');
    for (const invalid of [NaN, Infinity, -1, 256, 1.5]) expect(() => decodeMulawSample(invalid)).toThrow('mu-law');
  });
});
