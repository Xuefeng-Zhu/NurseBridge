declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: Record<string, unknown> });
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
