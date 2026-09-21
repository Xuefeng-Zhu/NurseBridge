export type AiRunner = { run(model: string, inputs: unknown, options?: unknown): Promise<unknown> };

export type Speech = { kind: 'pcm'; bytes: Uint8Array; sampleRate: number } | { kind: 'encoded'; bytes: Uint8Array; mimeType: string };

/** Parse actual RIFF metadata rather than labeling a container as raw PCM. */
export function parseSpeech(bytes: Uint8Array, contentType: string, requestedRate: number): Speech {
  const text = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let sampleRate = 0; let valid = false; let pcm: Uint8Array | undefined;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset + 4, true);
      if (offset + 8 + length > bytes.length) throw new Error('Truncated WAV output.');
      if (text(offset, 4) === 'fmt ' && length >= 16) {
        valid = view.getUint16(offset + 8, true) === 1 && view.getUint16(offset + 10, true) === 1 && view.getUint16(offset + 22, true) === 16;
        sampleRate = view.getUint32(offset + 12, true);
      }
      if (text(offset, 4) === 'data') pcm = bytes.slice(offset + 8, offset + 8 + length);
      offset += 8 + length + (length % 2);
    }
    if (!valid || !pcm || !sampleRate || pcm.length % 2) throw new Error('Unsupported WAV format.');
    return { kind: 'pcm', bytes: pcm, sampleRate };
  }
  // ADTS uses the same sync prefix as MPEG audio, but layer bits are zero.
  const isAac = bytes[0] === 255 && ((bytes[1] ?? 0) & 246) === 240;
  if (isAac) return { kind: 'encoded', bytes, mimeType: 'audio/aac' };
  const isMp3 = text(0, 3) === 'ID3' || (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224 && ((bytes[1] ?? 0) & 6) !== 0);
  if (isMp3) return { kind: 'encoded', bytes, mimeType: 'audio/mpeg' };
  if (text(0,4)==='OggS') return {kind:'encoded',bytes,mimeType:'audio/ogg'};
  if (text(0,4)==='fLaC') return {kind:'encoded',bytes,mimeType:'audio/flac'};
  // Headerless bytes cannot prove their own rate. Require provider format metadata
  // and the requested linear16 contract; never infer PCM merely from even length.
  const rate=Number(/(?:rate|sample-rate|samplerate)=(\d+)/i.exec(contentType)?.[1]);
  if (/audio\/(pcm|raw)/i.test(contentType) && [8000,16000,22050,24000,44100,48000].includes(rate) && bytes.length > 0 && bytes.length % 2 === 0) return { kind: 'pcm', bytes, sampleRate: rate };
  void requestedRate;
  throw new Error('Provider did not return a verified supported audio format.');
}

export async function synthesize(ai: AiRunner, model: string, speaker: string, text: string): Promise<Speech> {
  const output = await ai.run(model, { text, speaker, encoding: 'linear16', container: 'none', sample_rate: 24000 }, { returnRawResponse: true });
  if (!(output instanceof Response) || !output.ok) throw new Error('Speech provider unavailable.');
  const reader = output.body?.getReader();
  if (!reader) throw new Error('Speech provider returned no audio.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 2_000_000) { await reader.cancel(); throw new Error('Speech output exceeded limit.'); }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  // Joining complete output preserves odd stream chunk boundaries and makes the
  // compressed fallback one valid decode unit. Text is static and length bounded.
  return parseSpeech(bytes, output.headers.get('content-type') ?? '', 24000);
}
