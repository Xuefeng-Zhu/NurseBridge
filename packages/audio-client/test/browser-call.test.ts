import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserCall, type BrowserCallOptions } from '../src/browser-call';

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

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function connected(options: Partial<BrowserCallOptions> = {}) {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  const client = new BrowserCall({ role: 'caller', ...options });
  const promise = client.connect('initial-ticket', 'wss://demo.test/socket');
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.event({ type: 'authenticated', role: 'caller', credits: 20, snapshot: { controlEpoch: 1, responseGeneration: 1 } });
  await promise;
  return { client, socket };
}

function mediaHarness() {
  class Track {
    readyState = 'live';
    onended: (() => void) | null = null;
    stop = vi.fn(() => { this.readyState = 'ended'; });
  }
  class Node {
    connect = vi.fn(() => this);
    disconnect = vi.fn();
    gain = { value: 1 };
    port: { onmessage: ((event: { data: Record<string, unknown> }) => void) | null; postMessage: ReturnType<typeof vi.fn> } = { onmessage: null, postMessage: vi.fn() };
    event(data: Record<string, unknown>) { this.port.onmessage?.({ data }); }
  }
  const contexts: Context[] = [], nodes: Worklet[] = [];
  const addModule = vi.fn(async (_url: string) => undefined);
  class Context {
    state = 'suspended';
    onstatechange: (() => void) | null = null;
    destination = {};
    audioWorklet = { addModule };
    decodeAudioData = vi.fn();
    resume = vi.fn(async () => { this.state = 'running'; this.onstatechange?.(); });
    close = vi.fn(async () => { this.state = 'closed'; this.onstatechange?.(); });
    createMediaStreamSource = vi.fn(() => new Node());
    createGain = vi.fn(() => new Node());
    constructor() { contexts.push(this); }
  }
  class Worklet extends Node { constructor(_context: Context, readonly name: string) { super(); nodes.push(this); } }
  const track = new Track();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('AudioWorkletNode', Worklet);
  return { track, stream, getUserMedia, contexts, nodes, addModule };
}

async function readyMedia(client: BrowserCall, media: ReturnType<typeof mediaHarness>) {
  await client.enableMedia();
  media.nodes.find(node => node.name === 'nursebridge-capture')!.event({ type: 'frame', pcm: new ArrayBuffer(2400) });
  media.nodes.find(node => node.name === 'nursebridge-playback')!.event({ type: 'playback-ready' });
  expect(client.getState()).toMatchObject({ microphone: 'ready', playback: 'ready' });
}

describe('terminal call and asynchronous media cleanup', () => {
  it.each([
    { type: 'snapshot', snapshot: { queueState: 'CLOSED', controlEpoch: 2, responseGeneration: 2 } },
    { type: 'snapshot', snapshot: { deleted: true } },
    { type: 'deleted' },
  ])('releases media and forwards terminal $type events without reconnecting', async event => {
    vi.useFakeTimers();
    const media = mediaHarness(), renew = vi.fn(), onEvent = vi.fn();
    const { client, socket } = await connected({ getReconnectTicket: renew, onEvent });
    await readyMedia(client, media);
    socket.event(event);
    expect(client.getState()).toMatchObject({ connection: 'closed', microphone: 'idle', playback: 'idle', error: undefined });
    expect(media.track.readyState).toBe('ended');
    expect(media.contexts[0]!.state).toBe('closed');
    expect(media.nodes.every(node => node.disconnect.mock.calls.length === 1 && node.port.onmessage === null)).toBe(true);
    expect(onEvent).toHaveBeenLastCalledWith(event);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(renew).not.toHaveBeenCalled();
    await expect(client.enableMedia()).rejects.toThrow('Connect to a call');
  });

  it('does not start heartbeat or media when authentication already reports a closed call', async () => {
    vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeWebSocket);
    const onEvent = vi.fn(), client = new BrowserCall({ role: 'caller', onEvent });
    const connecting = client.connect('ticket', 'wss://demo.test/socket');
    const event = { type: 'authenticated', role: 'caller', credits: 20, snapshot: { queueState: 'CLOSED' } };
    FakeWebSocket.instances[0]!.event(event);
    await connecting;
    expect(client.getState().connection).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
    expect(onEvent).toHaveBeenLastCalledWith(event);
  });

  it('stops a permission result arriving after close and explicit reuse without touching the new connection', async () => {
    const media = mediaHarness(), permission = deferred<typeof media.stream>();
    media.getUserMedia.mockReturnValueOnce(permission.promise);
    const { client } = await connected();
    const enabling = client.enableMedia();
    client.close();
    const newConnection = client.connect('new-call-ticket', 'wss://demo.test/new-call');
    FakeWebSocket.instances.at(-1)!.event({ type: 'authenticated', role: 'caller', credits: 20, snapshot: { controlEpoch: 1, responseGeneration: 1 } });
    await newConnection;
    permission.resolve(media.stream); await enabling;
    expect(media.track.readyState).toBe('ended');
    expect(media.nodes).toHaveLength(0);
    expect(media.contexts[0]!.state).toBe('closed');
    expect(client.getState()).toMatchObject({ connection: 'connected', microphone: 'idle', playback: 'idle' });
    client.close();
  });

  it('ignores worklet completion and rejection after terminal cleanup', async () => {
    const media = mediaHarness(), module = deferred<undefined>();
    media.addModule.mockReturnValueOnce(module.promise);
    const { client, socket } = await connected();
    const enabling = client.enableMedia();
    await Promise.resolve();
    socket.event({ type: 'deleted' });
    module.reject(new Error('Late module download failed'));
    await enabling;
    expect(media.track.readyState).toBe('ended');
    expect(media.nodes).toHaveLength(0);
    expect(client.getState()).toMatchObject({ connection: 'closed', microphone: 'idle', error: undefined });
  });

  it('stops late permission capture after an earlier worklet startup failure', async () => {
    const media = mediaHarness(), permission = deferred<typeof media.stream>();
    media.getUserMedia.mockReturnValueOnce(permission.promise);
    media.addModule.mockRejectedValueOnce(new Error('Worklet unavailable'));
    const { client } = await connected();
    await expect(client.enableMedia()).rejects.toThrow('Worklet unavailable');
    permission.resolve(media.stream); await Promise.resolve();
    expect(media.track.readyState).toBe('ended');
    expect(media.contexts[0]!.state).toBe('closed');
    expect(client.getState().microphone).toBe('error');
    client.close();
  });

  it.each(['close', 'reuse'] as const)('ignores encoded audio decoding failures arriving after %s', async action => {
    const media = mediaHarness(), decoding = deferred<never>();
    const { client, socket } = await connected();
    await readyMedia(client, media);
    media.contexts[0]!.decodeAudioData.mockReturnValueOnce(decoding.promise);
    socket.event({ type: 'encoded-audio', controlEpoch: 1, generation: 1, responseId: 7, sequence: 7, mimeType: 'audio/wav', data: 'AAA=' });
    expect(media.contexts[0]!.decodeAudioData).toHaveBeenCalledOnce();
    client.close();
    if (action === 'reuse') {
      const connecting = client.connect('another-call-ticket', 'wss://demo.test/another-call');
      FakeWebSocket.instances.at(-1)!.event({ type: 'authenticated', role: 'caller', credits: 20, snapshot: { controlEpoch: 1, responseGeneration: 1 } });
      await connecting;
    }
    const currentSocket = FakeWebSocket.instances.at(-1)!;
    const before = client.getState(), sent = currentSocket.sent.length;
    decoding.reject(new Error('Late decode failure'));
    await Promise.resolve();
    expect(client.getState()).toEqual(before);
    expect(currentSocket.sent).toHaveLength(sent);
    expect(client.getState().error).toBeUndefined();
    client.close();
  });
});

describe('bounded reconnect ownership', () => {
  it('schedules one retry per failed authentication and cancels all retries on close', async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockResolvedValue({ ticket: 'fresh-ticket' });
    const { client, socket } = await connected({ getReconnectTicket: renew });
    socket.close();
    await vi.advanceTimersByTimeAsync(500);
    FakeWebSocket.instances[1]!.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(2);
    client.close();
    await vi.advanceTimersByTimeAsync(30000);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'new connection'] as const)('ignores an in-flight ticket after %s', async action => {
    vi.useFakeTimers();
    const ticket = deferred<{ ticket: string }>(), renew = vi.fn(() => ticket.promise);
    const { client, socket } = await connected({ getReconnectTicket: renew });
    socket.close(); await vi.advanceTimersByTimeAsync(500);
    if (action === 'close') client.close();
    else {
      const connecting = client.connect('manual-ticket', 'wss://demo.test/manual');
      FakeWebSocket.instances.at(-1)!.event({ type: 'authenticated', role: 'caller', credits: 20, snapshot: { controlEpoch: 1 } });
      await connecting;
    }
    const connections = FakeWebSocket.instances.length;
    ticket.resolve({ ticket: 'late-ticket' }); await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(connections);
    expect(client.getState().connection).toBe(action === 'close' ? 'closed' : 'connected');
    client.close();
  });

  it('keeps the four-attempt retry budget when ticket acquisition fails', async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockRejectedValue(new Error('Offline'));
    const { client, socket } = await connected({ getReconnectTicket: renew });
    socket.close(); await vi.advanceTimersByTimeAsync(30000);
    expect(renew).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(client.getState().connection).toBe('disconnected');
    client.close();
  });
});

describe('audio context readiness recovery', () => {
  it('announces resumed playback and clears the pause error without another worklet-ready event', async () => {
    const media = mediaHarness();
    const { client, socket } = await connected();
    await readyMedia(client, media);
    const context = media.contexts[0]!;
    context.state = 'suspended'; context.onstatechange?.();
    expect(client.getState()).toMatchObject({ playback: 'blocked', error: 'Audio playback paused. Enable audio again to continue.' });
    await client.enableMedia();
    expect(client.getState()).toMatchObject({ playback: 'ready', error: undefined });
    expect(media.getUserMedia).toHaveBeenCalledOnce();
    const controls = socket.sent.filter(value => typeof value === 'string').map(value => JSON.parse(value));
    expect(controls.at(-1)).toMatchObject({ type: 'media-ready', microphone: true, playback: true });
    context.state = 'suspended'; context.onstatechange?.();
    context.state = 'running'; context.onstatechange?.();
    expect(client.getState()).toMatchObject({ playback: 'ready', error: undefined });
    client.close();
  });

  it('does not erase an unrelated error or send microphone frames on a closing socket', async () => {
    const media = mediaHarness();
    const { client, socket } = await connected();
    await readyMedia(client, media);
    socket.event({ type: 'error', message: 'Unrelated call warning' });
    media.contexts[0]!.onstatechange?.();
    expect(client.getState().error).toBe('Unrelated call warning');
    socket.readyState = 2;
    const sent = socket.sent.length;
    media.nodes.find(node => node.name === 'nursebridge-capture')!.event({ type: 'frame', pcm: new ArrayBuffer(2400) });
    expect(socket.sent).toHaveLength(sent);
    client.close();
  });
});
