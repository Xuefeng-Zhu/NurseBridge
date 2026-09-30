import { chromium, expect, test, type Page } from './helpers/fixtures';
import { createHmac, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import type { CallSnapshot } from '../../packages/contracts/src/index';
import { decodeMulawSample, encodeMulawSample } from '../../apps/realtime/src/telephony/audio';

test.skip(process.env.NURSEBRIDGE_PHONE_E2E !== '1', 'Opt-in signed Twilio-protocol emulator; no real PSTN delivery claim.');
const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const phoneOrigin = process.env.NURSEBRIDGE_PHONE_ORIGIN ?? 'http://localhost:8788';
const accountSid = process.env.NURSEBRIDGE_PHONE_ACCOUNT_SID ?? `AC${'1'.repeat(32)}`;
const authToken = process.env.NURSEBRIDGE_PHONE_AUTH_TOKEN ?? 'phone-e2e-test-token-only';
const phoneNumber = process.env.NURSEBRIDGE_PHONE_NUMBER ?? '+15550101001';

function loopback(value: string): URL {
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Phone protocol E2E permits loopback URLs only.');
  }
  return url;
}
function signature(path: string, form: Record<string, string> = {}): string {
  const canonical = phoneOrigin + path + Object.keys(form).sort().map(key => key + form[key]).join('');
  return createHmac('sha1', authToken).update(canonical).digest('base64');
}
function xmlAttribute(tag: string, name: string): string {
  const value = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`))?.[2];
  if (value === undefined) throw new Error(`TwiML is missing ${name}.`);
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]!);
}
type PhoneSnapshot = CallSnapshot & { mediaReady: { caller: boolean; nurse: boolean }; provider: { connected: boolean } };
async function snapshot(page: Page, id: string): Promise<PhoneSnapshot> {
  const response = await page.request.get(`${baseURL}/api/calls/${id}`);
  expect(response.ok(), `Authoritative phone call returned HTTP ${response.status()}`).toBe(true);
  return (await response.json()).snapshot as PhoneSnapshot;
}
async function nurseDiagnostics(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const value = (window as unknown as { __nursebridgeDiagnostics?: Record<string, unknown> }).__nursebridgeDiagnostics ?? {};
    return value.audio && typeof value.audio === 'object' ? value.audio as Record<string, unknown> : value;
  });
}

/** Twilio protocol emulator, not a carrier or physical telephone. It consumes
 * received mu-law at 8kHz before acknowledging marks, and clear discards queued
 * audio while echoing canceled marks just as the signed media protocol permits.
 */
class PhoneEmulator {
  readonly streamSid = `MZ${randomBytes(16).toString('hex')}`;
  readonly errors: string[] = [];
  clearCount = 0;
  mediaPackets = 0;
  playedSamples = 0;
  acknowledgedMarks = 0;
  holdBarriers = false;
  holdAudioMarks = false;
  private sequence = 0;
  private chunk = 0;
  private sampleIndex = 0;
  private playbackAt = 0;
  private nextMarkIsBarrier = false;
  private stopped = false;
  private socket?: WebSocket;
  private sender?: ReturnType<typeof setInterval>;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private marks = new Map<string, ReturnType<typeof setTimeout>>();
  private barriersHeld: string[] = [];
  private audioMarksHeld: string[] = [];
  private played: number[] = [];

  constructor(private readonly callSid: string) {}
  get heldBarrierCount() { return this.barriersHeld.length; }
  get heldAudioMarkCount() { return this.audioMarksHeld.length; }

  async start(url: URL, token: string): Promise<void> {
    const path = url.pathname + url.search;
    const wire = new URL(url);
    // A real Twilio Stream requires wss. Only this loopback fixture downgrades
    // its declared wss URL when the local canonical origin is HTTP.
    if (new URL(phoneOrigin).protocol === 'http:') wire.protocol = 'ws:';
    const socket = new WebSocket(wire, { headers: { 'X-Twilio-Signature': signature(path) }, maxPayload: 16_384, handshakeTimeout: 10_000, followRedirects: false });
    this.socket = socket;
    socket.on('error', error => this.errors.push(error.message));
    socket.on('close', code => { if (!this.stopped) this.errors.push(`Phone stream closed unexpectedly (${code}).`); });
    socket.on('message', (data, binary) => {
      try {
        if (binary) throw new Error('Expected JSON Twilio media, received binary.');
        this.receive(JSON.parse(data.toString()) as { event?: string; streamSid?: string; media?: { payload?: string }; mark?: { name?: string } });
      } catch (error) { this.errors.push(error instanceof Error ? error.message : 'Invalid outbound phone event.'); }
    });
    await new Promise<void>((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject); });
    socket.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
    this.send({ event: 'start', start: { accountSid, callSid: this.callSid, streamSid: this.streamSid, tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, customParameters: { token } } });
    const sendTone = () => {
      if (this.stopped || socket.readyState !== WebSocket.OPEN) return;
      if (this.chunk >= 3000 || socket.bufferedAmount > 64_000) {
        this.errors.push('Phone source exceeded its bounded test duration or send queue.');
        clearInterval(this.sender); return;
      }
      const packet = Buffer.alloc(160);
      for (let index = 0; index < packet.length; index++) packet[index] = encodeMulawSample(Math.round(0.4 * 32768 * Math.sin(2 * Math.PI * 440 * this.sampleIndex++ / 8000)));
      this.send({ event: 'media', media: { track: 'inbound', chunk: String(++this.chunk), timestamp: String((this.chunk - 1) * 20), payload: packet.toString('base64') } });
    };
    sendTone(); this.sender = setInterval(sendTone, 20);
  }

  private send(event: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ ...event, streamSid: this.streamSid, sequenceNumber: String(++this.sequence) }));
  }
  private echo(name: string): void {
    if (this.stopped) return;
    this.send({ event: 'mark', mark: { name } }); this.acknowledgedMarks++;
  }
  private later(callback: () => void): ReturnType<typeof setTimeout> {
    const delay = Math.max(0, this.playbackAt - Date.now());
    if (delay > 1500 || this.timers.size >= 64) throw new Error('Phone playback queue exceeded its bound.');
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.stopped) callback(); }, delay);
    this.timers.add(timer); return timer;
  }
  private receive(event: { event?: string; streamSid?: string; media?: { payload?: string }; mark?: { name?: string } }): void {
    if (this.stopped) return;
    if (event.streamSid !== this.streamSid) throw new Error('Outbound media targeted another phone stream.');
    if (event.event === 'clear') {
      const canceled = [...this.marks.keys(), ...this.barriersHeld, ...this.audioMarksHeld];
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear(); this.marks.clear(); this.barriersHeld = []; this.audioMarksHeld = [];
      this.playbackAt = Date.now(); this.played = []; this.nextMarkIsBarrier = true; this.clearCount++;
      for (const name of canceled) this.echo(name);
      return;
    }
    if (event.event === 'media') {
      const payload = event.media?.payload;
      if (typeof payload !== 'string' || payload.length > 10_668) throw new Error('Invalid or oversized outbound mu-law audio.');
      const decoded = Buffer.from(payload, 'base64');
      if (!decoded.length || decoded.toString('base64') !== payload) throw new Error('Outbound phone audio is not canonical base64.');
      const samples = Array.from(decoded, value => decodeMulawSample(value) / 32768);
      this.mediaPackets++; this.playbackAt = Math.max(Date.now(), this.playbackAt) + samples.length / 8;
      this.later(() => { this.played.push(...samples); this.played = this.played.slice(-16_000); this.playedSamples += samples.length; });
      return;
    }
    if (event.event === 'mark') {
      const name = event.mark?.name;
      if (typeof name !== 'string' || !name || name.length > 200) throw new Error('Invalid outbound playback mark.');
      const barrier = this.nextMarkIsBarrier; this.nextMarkIsBarrier = false;
      const timer = this.later(() => {
        this.marks.delete(name);
        if (barrier && this.holdBarriers) this.barriersHeld.push(name);
        else if (!barrier && this.holdAudioMarks) this.audioMarksHeld.push(name);
        else this.echo(name);
      });
      this.marks.set(name, timer); return;
    }
    throw new Error(`Unexpected outbound phone event: ${event.event ?? 'missing'}.`);
  }
  releaseBarriers(): void { this.holdBarriers = false; for (const name of this.barriersHeld.splice(0)) this.echo(name); }
  releaseAudioMarks(): void { this.holdAudioMarks = false; for (const name of this.audioMarksHeld.splice(0)) this.echo(name); }
  audioProof() {
    const samples = this.played.slice(-4000);
    const crossings: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      const previous = samples[i - 1]!, current = samples[i]!;
      if (previous < 0 && current >= 0) crossings.push(i - 1 - previous / (current - previous));
    }
    return {
      samples: this.played.length,
      frequency: crossings.length > 1 ? (crossings.length - 1) * 8000 / (crossings.at(-1)! - crossings[0]!) : 0,
      rms: samples.length ? Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length) : 0,
      mediaPackets: this.mediaPackets, playedSamples: this.playedSamples, acknowledgedMarks: this.acknowledgedMarks, clearCount: this.clearCount,
    };
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.sender);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear(); this.marks.clear(); this.barriersHeld = []; this.audioMarksHeld = [];
    // An authenticated stop reports the carrier already ended. It deliberately
    // precedes socket/browser disposal and never requests a nurse-side hangup.
    this.send({ event: 'stop', stop: { accountSid, callSid: this.callSid } });
  }
  dispose(): void {
    clearInterval(this.sender);
    for (const timer of this.timers) clearTimeout(timer);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(1000, 'Completed loopback phone fixture');
    else if (this.socket?.readyState === WebSocket.CONNECTING) this.socket.terminate();
  }
}

test('signed phone-protocol emulator and a real nurse browser exchange distinct audio after playback barriers', async ({ extraHTTPHeaders }, testInfo) => {
  test.setTimeout(90_000);
  loopback(baseURL); loopback(phoneOrigin);
  expect(new URL(phoneOrigin).origin).toBe(phoneOrigin);
  const storageState = process.env.NURSEBRIDGE_PHONE_WORKSPACE_STATE;
  const workspaceId = process.env.NURSEBRIDGE_PHONE_WORKSPACE_ID;
  expect(storageState, 'Provide the prepared isolated nurse storageState path.').toBeTruthy();
  expect(workspaceId, 'Provide the prepared isolated phone workspace ID.').toBeTruthy();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    args: ['--disable-crashpad-for-testing', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve('tests/fixtures/microphone-660hz.wav')}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ baseURL, extraHTTPHeaders, storageState: storageState!, permissions: ['microphone'], viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors: string[] = [];
  const nonLocalRequests: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await context.route('**/*', async route => {
    try { loopback(route.request().url()); await route.continue(); }
    catch { nonLocalRequests.push(new URL(route.request().url()).origin); await route.abort(); }
  });
  const providerCallSid = `CA${randomBytes(16).toString('hex')}`;
  const phone = new PhoneEmulator(providerCallSid);
  let callId: string | undefined;
  let voiceAccepted = false;
  let terminalConfirmed = false;
  const form = { AccountSid: accountSid, CallSid: providerCallSid, To: phoneNumber, From: '+15550101002', Direction: 'inbound', CallStatus: 'in-progress' };
  const signedPost = (path: string, body: Record<string, string>) => page.request.post(phoneOrigin + path, { headers: { 'X-Twilio-Signature': signature(path, body), 'Content-Type': 'application/x-www-form-urlencoded' }, data: new URLSearchParams(body).toString(), maxRedirects: 0 });
  const finish = async () => {
    if (!voiceAccepted || terminalConfirmed) return;
    phone.stop();
    const completed = { ...form, CallStatus: 'completed', SequenceNumber: '1' };
    const response = await signedPost('/phone/twilio/status', completed);
    expect(response.ok(), `Signed terminal callback returned HTTP ${response.status()}`).toBe(true);
    if (callId) await expect.poll(async () => (await snapshot(page, callId!)).queueState).toBe('CLOSED');
    terminalConfirmed = true;
  };
  try {
    const sessionResponse = await page.request.get(`${baseURL}/api/demo/session`);
    expect(sessionResponse.ok()).toBe(true);
    const session = await sessionResponse.json();
    expect(session).toMatchObject({ mode: 'mock', diagnostics: true, session: { workspaceId } });
    expect(session.session.role, 'The prepared administrator can take calls and inspect the routing workspace ID.').toBe('admin');
    // No fixture media or microphone capture begins before the live-mode guard.
    const voice = await signedPost('/phone/twilio/voice', form);
    expect(voice.status(), 'Signed fictional incoming-call webhook').toBe(200);
    voiceAccepted = true;
    const twiml = await voice.text();
    const streams = twiml.match(/<Stream\b[^>]*>/gi) ?? [];
    expect(streams).toHaveLength(1);
    const stream = loopback(xmlAttribute(streams[0]!, 'url'));
    expect(stream.hostname).toBe(new URL(phoneOrigin).hostname);
    expect(stream.port).toBe(new URL(phoneOrigin).port);
    expect(stream.pathname).toMatch(/^\/phone\/connect\/[a-zA-Z0-9-]+$/);
    callId = stream.pathname.split('/').at(-1)!;
    const tokenParameter = (twiml.match(/<Parameter\b[^>]*\/?>/gi) ?? []).find(tag => xmlAttribute(tag, 'name') === 'token');
    expect(Boolean(tokenParameter), 'TwiML contains a scoped stream token.').toBe(true);
    await phone.start(stream, xmlAttribute(tokenParameter!, 'value'));
    await expect.poll(async () => (await snapshot(page, callId!)).mediaReady.caller).toBe(true);
    const waiting = await snapshot(page, callId);
    expect(waiting).toMatchObject({ channel: 'phone', workspaceId, mode: 'mock', queueState: 'WAITING', conversationOwner: 'NONE', consent: false, humanRequested: true });
    expect(waiting.recordingConsent).toBeUndefined();
    expect(waiting.turns).toHaveLength(0);
    expect(waiting.provider.connected).toBe(false);

    await page.goto(`${baseURL}/nurse`);
    await expect(page).toHaveTitle(/NurseBridge/);
    const callerLabel = `Phone caller ${callId.slice(-4).toUpperCase()}`;
    const queue = page.getByRole('region', { name: 'Caller queue' });
    await queue.getByRole('button').filter({ has: page.getByRole('heading', { name: callerLabel, exact: true }) }).click();
    const draft = page.getByRole('region', { name: 'Selected intake draft' });
    await expect(draft.getByRole('heading', { name: callerLabel, exact: true })).toBeVisible();
    await expect(draft.getByText('Inbound phone', { exact: true })).toBeVisible();
    await expect(draft.getByRole('button', { name: 'Take over call', exact: true })).toBeEnabled();
    const initialClears = phone.clearCount;
    phone.holdBarriers = true; phone.holdAudioMarks = true;
    await draft.getByRole('button', { name: 'Take over call', exact: true }).click();
    // The provisional AI cancellation clear precedes the handoff's fresh-epoch
    // clear. Neither may be confused with actual two-way playback proof.
    await expect.poll(() => phone.clearCount, { intervals: [20, 50, 100] }).toBeGreaterThanOrEqual(initialClears + 2);
    await expect.poll(() => phone.heldBarrierCount, { intervals: [20, 50, 100] }).toBe(1);
    const blockedOnBarrier = await snapshot(page, callId);
    expect(blockedOnBarrier).toMatchObject({ queueState: 'CLAIMED', conversationOwner: 'HANDOFF_PENDING', handoff: { callerFlushed: false, callerHeard: false, nurseHeard: false } });
    phone.releaseBarriers();
    await expect.poll(async () => (await snapshot(page, callId!)).handoff?.nurseHeard, { timeout: 1000, intervals: [20, 30, 50] }).toBe(true);
    const blockedOnPlayback = await snapshot(page, callId);
    expect(blockedOnPlayback).toMatchObject({ queueState: 'CLAIMED', conversationOwner: 'HANDOFF_PENDING', handoff: { callerFlushed: true, callerHeard: false, nurseHeard: true } });
    phone.releaseAudioMarks();
    await expect.poll(async () => (await snapshot(page, callId!)).queueState, { timeout: 15_000 }).toBe('CONNECTED');
    const connected = await snapshot(page, callId);
    expect(connected.conversationOwner).toBe('NURSE');
    await expect(page.getByRole('region', { name: 'Active call controls' })).toContainText('Human audio connected');
    await expect.poll(async () => Math.abs(Number((await nurseDiagnostics(page)).dominantFrequency) - 440), { timeout: 10_000 }).toBeLessThan(12);
    await expect.poll(() => phone.audioProof().samples).toBeGreaterThan(5000);
    await expect.poll(() => Math.abs(phone.audioProof().frequency - 660)).toBeLessThan(12);
    expect(phone.audioProof().rms).toBeGreaterThan(0.005);
    const received = await nurseDiagnostics(page);
    expect(received.controlEpoch).toBe(connected.controlEpoch);
    expect(Number(received.humanSamplesInEpoch)).toBeGreaterThan(1000);
    expect(received.agentSamplesInEpoch).toBe(0);
    expect(await page.locator('nextjs-portal [data-nextjs-error-dialog], vite-error-overlay').count()).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('phone-emulator-nurse-connected.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Intake draft', exact: true }).click();
    await expect(draft).toBeVisible();
    await expect(page.getByRole('region', { name: 'Active call controls' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('phone-emulator-nurse-mobile.png'), fullPage: true });
    const proof = { verification: 'Signed loopback Twilio protocol emulator, not real PSTN delivery.', callId, workspaceId, codec: 'audio/x-mulaw; rate=8000; channels=1', nurseBrowser: received, simulatedPhonePlayback: phone.audioProof(), barrierGate: blockedOnBarrier.handoff, twoWayPlaybackGate: blockedOnPlayback.handoff, controlEpoch: connected.controlEpoch };
    const proofPath = testInfo.outputPath('phone-emulator-audio-proof.json');
    await writeFile(proofPath, JSON.stringify(proof, null, 2));
    await testInfo.attach('phone-emulator-audio-proof', { path: proofPath, contentType: 'application/json' });
    await page.evaluate(() => {
      const probe = window as unknown as { __nursebridge: { context?: AudioContext; microphone?: MediaStream }; __phoneResources?: { context: AudioContext; tracks: MediaStreamTrack[] } };
      probe.__phoneResources = { context: probe.__nursebridge.context!, tracks: probe.__nursebridge.microphone!.getTracks() };
    });
    await finish();
    await expect.poll(() => page.evaluate(() => {
      const retained = (window as unknown as { __phoneResources: { context: AudioContext; tracks: MediaStreamTrack[] } }).__phoneResources;
      return { context: retained.context.state, tracks: retained.tracks.map(track => track.readyState) };
    })).toEqual({ context: 'closed', tracks: ['ended'] });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`${baseURL}/settings`);
    const phoneSettings = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Inbound phone calls', exact: true }) });
    await expect(phoneSettings.getByText('Configuration present', { exact: true })).toBeVisible();
    const routingWorkspace = phoneSettings.getByLabel('Workspace ID for phone routing');
    await expect(routingWorkspace).toHaveValue(workspaceId!);
    await expect(routingWorkspace).toHaveAttribute('readonly', '');
    await expect(phoneSettings).toContainText('Configuration does not confirm a working telephone call.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('phone-settings.png'), fullPage: true });
    expect(phone.errors).toEqual([]);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(nonLocalRequests).toEqual([]);
  } finally {
    // Local QA must also bind a local carrier-termination Fetcher so unexpected
    // app-side transport failures cannot contact Twilio during a failing test.
    try { await finish(); }
    finally { phone.dispose(); await context.close(); await browser.close(); }
  }
});
