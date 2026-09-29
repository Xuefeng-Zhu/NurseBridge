import type { AudioFrame } from '@nursebridge/audio-client/protocol';
import { PhoneAudioDecoder, PhoneAudioEncoder } from './audio';

export type PhonePlayback =
  | { type: 'audio'; sequence: number; streamKind: number; responseId: number; epoch: number; generation: number }
  | { type: 'tail'; responseId: number; epoch: number; generation: number }
  | { type: 'flush'; epoch: number; generation: number };

/** Per-stream DSP and playback receipts. Never survives a socket replacement. */
export class PhoneTransport {
  private decoder = new PhoneAudioDecoder();
  private encoder = new PhoneAudioEncoder();
  private marks = new Map<string, PhonePlayback>();
  private sequence = 0;
  private unmarked: Extract<PhonePlayback, { type: 'audio' }>[] = [];
  private lastAudio?: Extract<PhonePlayback, { type: 'audio' }>;

  constructor(readonly streamSid: string, private readonly socket: WebSocket) {}

  decode(payload: string): Uint8Array[] { return this.decoder.push(payload); }

  sendAudio(frame: AudioFrame): void {
    const payload = this.encoder.push(frame.payload);
    this.lastAudio = { type: 'audio', sequence: frame.sequence, streamKind: frame.streamKind, responseId: frame.responseId, epoch: frame.controlEpoch, generation: frame.generation };
    this.unmarked.push(this.lastAudio);
    if (payload) {
      this.send({ event: 'media', media: { payload } });
      for (const receipt of this.unmarked.splice(0)) this.mark(receipt);
    }
  }

  finishAudio(responseId: number): void {
    if (!this.lastAudio || this.lastAudio.responseId !== responseId) return;
    const payload = this.encoder.finish();
    if (payload) {
      this.send({ event: 'media', media: { payload } });
      for (const receipt of this.unmarked.splice(0)) this.mark(receipt);
      // The FIR tail follows the last regular frame's mark. Its own receipt
      // keeps a reply speaking until all of its samples reach carrier playback.
      this.mark({ type: 'tail', responseId, epoch: this.lastAudio.epoch, generation: this.lastAudio.generation });
    }
    this.encoder.reset(); this.lastAudio = undefined;
  }

  hasPending(responseId: number): boolean {
    return this.unmarked.some(receipt => receipt.responseId === responseId)
      || [...this.marks.values()].some(receipt => receipt.type !== 'flush' && receipt.responseId === responseId);
  }

  flush(epoch: number, generation: number): void {
    // clear also acknowledges discarded marks. Forget them BEFORE sending it:
    // only a new marker behind silence can prove the new playback boundary.
    this.marks.clear(); this.unmarked = []; this.lastAudio = undefined; this.decoder.reset(); this.encoder.reset();
    this.send({ event: 'clear' });
    this.send({ event: 'media', media: { payload: btoa(String.fromCharCode(...new Uint8Array(160).fill(255))) } });
    this.mark({ type: 'flush', epoch, generation });
  }

  acknowledge(name: string): PhonePlayback | undefined {
    const receipt = this.marks.get(name);
    this.marks.delete(name);
    return receipt;
  }

  close(): void { this.marks.clear(); this.unmarked = []; this.lastAudio = undefined; this.decoder.reset(); this.encoder.reset(); }

  private mark(receipt: PhonePlayback): void {
    if (this.marks.size >= 24) throw new Error('Phone playback backlog exceeded');
    const name = `nb-${++this.sequence}-${crypto.randomUUID()}`;
    this.marks.set(name, receipt);
    this.send({ event: 'mark', mark: { name } });
  }

  private send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ ...message, streamSid: this.streamSid }));
  }
}
