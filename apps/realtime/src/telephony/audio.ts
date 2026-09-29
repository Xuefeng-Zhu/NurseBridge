import { AUDIO_FRAME_SAMPLES, AUDIO_SAMPLE_RATE, floatToPcm16, pcm16ToFloat } from '@nursebridge/audio-client/protocol';
import { BandlimitedResampler, SampleFramer } from '@nursebridge/audio-client/resampler';

export const PHONE_SAMPLE_RATE = 8000;
// One second per message bounds decoding, allocation and filtering work. Twilio
// normally sends much smaller packets; packet boundaries do not define transport frames.
export const MAX_PHONE_PACKET_BYTES = PHONE_SAMPLE_RATE;
export const MAX_PHONE_PCM_BYTES = AUDIO_SAMPLE_RATE * 2;
const MAX_BASE64_LENGTH = Math.ceil(MAX_PHONE_PACKET_BYTES / 3) * 4;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MULAW_BIAS = 0x84;

/** Decode one G.711 mu-law code word to a signed linear PCM16 sample. */
export function decodeMulawSample(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('Invalid mu-law byte');
  const code = (~value) & 0xff;
  const magnitude = (((code & 0x0f) << 3) + MULAW_BIAS) << ((code >> 4) & 7);
  return code & 0x80 ? MULAW_BIAS - magnitude : magnitude - MULAW_BIAS;
}

/** Encode a signed linear PCM16 sample; out-of-range integers saturate. */
export function encodeMulawSample(value: number): number {
  if (!Number.isInteger(value)) throw new Error('Invalid PCM16 sample');
  const sample = Math.max(-32768, Math.min(32767, value));
  const sign = sample < 0 ? 0x80 : 0;
  const magnitude = Math.min(32635, Math.abs(sample)) + MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); mask >>= 1) exponent--;
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

const MULAW_TO_FLOAT = Float32Array.from({ length: 256 }, (_, value) => decodeMulawSample(value) / 32768);

function decodePayload(payload: string): Float32Array {
  if (typeof payload !== 'string' || !payload.length || payload.length > MAX_BASE64_LENGTH || !BASE64.test(payload)) {
    throw new Error('Invalid or oversized phone audio base64');
  }
  const binary = atob(payload);
  // Canonical padding also rejects nonzero unused pad bits, which atob tolerates.
  if (binary.length > MAX_PHONE_PACKET_BYTES || btoa(binary) !== payload) throw new Error('Invalid or oversized phone audio base64');
  return Float32Array.from(binary, character => MULAW_TO_FLOAT[character.charCodeAt(0)]!);
}

function encodePayload(samples: Float32Array): string {
  let binary = '';
  for (const sample of samples) binary += String.fromCharCode(encodeMulawSample(Math.round(sample * 32768)));
  return btoa(binary);
}

function validatePcm(pcm: Uint8Array): void {
  if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > MAX_PHONE_PCM_BYTES) {
    throw new Error('Invalid or oversized phone PCM16 payload');
  }
}

/**
 * Stream-scoped headerless 8kHz mu-law -> 24kHz mono PCM16LE, exact 50ms frames.
 * The shared sinc filter retains 32 input samples of lookahead (~4ms), followed
 * by framing latency of at most 50ms. Only filter history and one partial frame
 * survive a push. Reset drops both, so a new stream cannot replay old speech.
 */
export class PhoneAudioDecoder {
  private resampler = new BandlimitedResampler(PHONE_SAMPLE_RATE, AUDIO_SAMPLE_RATE);
  private framer = new SampleFramer(AUDIO_FRAME_SAMPLES);

  push(payload: string): Uint8Array[] {
    const samples = decodePayload(payload); // Validate before touching stream state.
    return this.framer.push(this.resampler.push(samples)).map(floatToPcm16);
  }

  reset(): void {
    this.resampler = new BandlimitedResampler(PHONE_SAMPLE_RATE, AUDIO_SAMPLE_RATE);
    this.framer = new SampleFramer(AUDIO_FRAME_SAMPLES);
  }
}

/**
 * Keep one encoder per media stream. The anti-alias filter keeps phase/history
 * across arbitrary even PCM chunks and needs ~1.33ms lookahead. Push may return
 * an empty string during startup; send only nonempty results. Finish only at a
 * complete audio-unit boundary, never after every transport frame. Reset on
 * playback clear/stream replacement to discard speech from the previous epoch.
 */
export class PhoneAudioEncoder {
  private resampler = new BandlimitedResampler(AUDIO_SAMPLE_RATE, PHONE_SAMPLE_RATE);

  push(pcm: Uint8Array): string {
    validatePcm(pcm);
    return encodePayload(this.resampler.push(pcm16ToFloat(pcm)));
  }

  finish(): string {
    return encodePayload(this.resampler.finish());
  }

  reset(): void {
    this.resampler = new BandlimitedResampler(AUDIO_SAMPLE_RATE, PHONE_SAMPLE_RATE);
  }
}

/** Convert one finite PCM unit, including its zero-extended filter tail.
 * Continuous media must use PhoneAudioEncoder instead to retain filter history.
 * A final partial 3-sample group produces one 8kHz sample (rounded-up duration).
 */
export function pcm24ToMulaw(pcm: Uint8Array): string {
  validatePcm(pcm);
  const resampler = new BandlimitedResampler(AUDIO_SAMPLE_RATE, PHONE_SAMPLE_RATE);
  const body = resampler.push(pcm16ToFloat(pcm));
  const tail = resampler.finish();
  const samples = new Float32Array(body.length + tail.length);
  samples.set(body); samples.set(tail, body.length);
  return encodePayload(samples);
}
