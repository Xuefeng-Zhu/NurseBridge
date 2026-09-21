export const AUDIO_HEADER_BYTES = 28;
export const AUDIO_PROTOCOL_VERSION = 1;
export const AUDIO_MAGIC = 0x3142424e;
export const MAX_AUDIO_PAYLOAD_BYTES = 96_000;
export const AUDIO_SAMPLE_RATE = 24_000;
export const AUDIO_FRAME_MS = 50;
export const AUDIO_FRAME_SAMPLES = AUDIO_SAMPLE_RATE * AUDIO_FRAME_MS / 1000;
export const AUDIO_FRAME_BYTES = AUDIO_FRAME_SAMPLES * 2;

export enum AudioStreamKind { Patient = 1, Nurse = 2, Agent = 3 }

export interface AudioFrame {
  streamKind: AudioStreamKind;
  sequence: number;
  sampleRate: number;
  controlEpoch: number;
  generation: number;
  responseId: number;
  payload: Uint8Array;
}

function uint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function validate(frame: AudioFrame): void {
  if (![1, 2, 3].includes(frame.streamKind)) throw new Error('Unknown audio stream');
  if (!Number.isInteger(frame.sampleRate) || frame.sampleRate < 8000 || frame.sampleRate > 96000) {
    throw new Error('Invalid audio sample rate');
  }
  if (![frame.sequence, frame.controlEpoch, frame.generation, frame.responseId].every(uint32)) {
    throw new Error('Invalid audio frame identity');
  }
  if (frame.payload.byteLength === 0 || frame.payload.byteLength % 2 || frame.payload.byteLength > MAX_AUDIO_PAYLOAD_BYTES) {
    throw new Error('Invalid PCM frame length');
  }
}

export function encodeAudioFrame(frame: AudioFrame): ArrayBuffer {
  validate(frame);
  const buffer = new ArrayBuffer(AUDIO_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, AUDIO_MAGIC, true);
  view.setUint8(4, AUDIO_PROTOCOL_VERSION);
  view.setUint8(5, frame.streamKind);
  view.setUint8(6, 1);
  view.setUint32(8, frame.sequence, true);
  view.setUint32(12, frame.sampleRate, true);
  view.setUint32(16, frame.controlEpoch, true);
  view.setUint32(20, frame.generation, true);
  view.setUint32(24, frame.responseId, true);
  new Uint8Array(buffer, AUDIO_HEADER_BYTES).set(frame.payload);
  return buffer;
}

export function decodeAudioFrame(buffer: ArrayBuffer): AudioFrame {
  if (buffer.byteLength < AUDIO_HEADER_BYTES) throw new Error('Truncated audio header');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== AUDIO_MAGIC || view.getUint8(4) !== AUDIO_PROTOCOL_VERSION) {
    throw new Error('Unsupported audio protocol');
  }
  if (view.getUint8(6) !== 1 || view.getUint8(7) !== 0) throw new Error('Unsupported audio codec');
  const frame: AudioFrame = {
    streamKind: view.getUint8(5), sequence: view.getUint32(8, true),
    sampleRate: view.getUint32(12, true), controlEpoch: view.getUint32(16, true),
    generation: view.getUint32(20, true), responseId: view.getUint32(24, true),
    payload: new Uint8Array(buffer, AUDIO_HEADER_BYTES),
  };
  validate(frame);
  return frame;
}

export function floatToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
  }
  return bytes;
}

export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 2) throw new Error('Incomplete PCM sample');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < result.length; i++) result[i] = view.getInt16(i * 2, true) / 32768;
  return result;
}

/** Raw provider stream chunks can split samples; retain one byte until the next chunk. */
export class PcmChunkAssembler {
  private pending: number | undefined;
  push(chunk: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(chunk.length + (this.pending === undefined ? 0 : 1));
    if (this.pending !== undefined) bytes[0] = this.pending;
    bytes.set(chunk, this.pending === undefined ? 0 : 1);
    this.pending = bytes.length % 2 ? bytes[bytes.length - 1] : undefined;
    return bytes.subarray(0, bytes.length - (bytes.length % 2));
  }
  finish(): void {
    if (this.pending !== undefined) throw new Error('TTS stream ended with an incomplete PCM sample');
  }
}
