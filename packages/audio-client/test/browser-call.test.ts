import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserCall } from '../src/browser-call';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  binaryType = '';
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  event(value: object): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('browser authenticated connection', () => {
  it('uses a first-frame ticket and keeps observer microphones untouched', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new BrowserCall({ role: 'observer' });
    const connecting = client.connect('single-use-ticket', 'wss://demo.test/socket');
    const socket = FakeWebSocket.instances[0]!;
    socket.onopen!();
    expect(socket.url).toBe('wss://demo.test/socket');
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'auth', ticket: 'single-use-ticket' });
    expect(client.sendControl({ type: 'heartbeat' })).toBe(false);
    socket.event({ type: 'authenticated', role: 'observer', credits: 20, snapshot: { controlEpoch: 0, responseGeneration: 0 } });
    await connecting;
    expect(client.getState().microphone).toBe('idle');
    expect(client.sendControl({ type: 'heartbeat' })).toBe(true);
    client.close();
  });

  it('requests a fresh ticket after disconnect instead of replaying the spent ticket', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const renew = vi.fn().mockResolvedValue({ ticket: 'renewed-ticket' });
    const client = new BrowserCall({ role: 'caller', getReconnectTicket: renew });
    const first = client.connect('spent-ticket', 'wss://demo.test/socket');
    const socket = FakeWebSocket.instances[0]!;
    socket.onopen!();
    socket.event({ type: 'authenticated', role: 'caller', credits: 20, snapshot: { controlEpoch: 0, responseGeneration: 0 } });
    await first;
    socket.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(renew).toHaveBeenCalledTimes(1);
    const second = FakeWebSocket.instances[1]!;
    second.onopen!();
    expect(JSON.parse(second.sent[0]!)).toEqual({ type: 'auth', ticket: 'renewed-ticket' });
    second.event({ type: 'authenticated', role: 'caller', credits: 20, snapshot: { controlEpoch: 1, responseGeneration: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    client.close();
  });
});
