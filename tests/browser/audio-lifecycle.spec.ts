import { chromium, expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { CallSnapshot } from '../../packages/contracts/src/index';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const origin = new URL(baseURL).origin;

// The client is exposed only by explicit local test diagnostics. Retain real
// browser resources so cleanup assertions cannot pass by merely hiding the UI.
interface AudioProbe {
  __nursebridge: {
    context?: AudioContext;
    microphone?: MediaStream;
    socket?: WebSocket;
    getState(): { connection: string; microphone: string; playback: string; error?: string };
    close(): void;
  };
  __retainedAudio?: { context: AudioContext; tracks: MediaStreamTrack[]; socket: WebSocket };
}

async function command(page: Page, id: string, type: string, data = {}) {
  const response = await page.request.post(`${baseURL}/api/calls/${id}/${type}`, { headers: { Origin: origin }, data: { commandId: crypto.randomUUID(), ...data } });
  expect(response.status()).toBe(200);
}

async function join(page: Page): Promise<CallSnapshot> {
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/calls' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Join demonstration queue' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  return (await response.json()).call;
}

async function state(page: Page) {
  return page.evaluate(() => (window as unknown as AudioProbe).__nursebridge.getState());
}

test('real browser audio resumes, reconnects with one fresh ticket, and releases capture on remote end or deletion', async ({}, testInfo) => {
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve('tests/fixtures/microphone-440hz.wav')}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ baseURL, permissions: ['microphone'], reducedMotion: 'reduce' });
  const page = await context.newPage();
  const owned = new Set<string>();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let tickets = 0;
  page.on('request', request => { if (request.url().endsWith('/connection-ticket')) tickets++; });
  try {
    expect((await page.request.post(`${baseURL}/api/demo/session`, { headers: { Origin: origin }, data: {} })).status()).toBe(201);
    const session = await (await page.request.get(`${baseURL}/api/demo/session`)).json();
    expect(session).toMatchObject({ mode: 'mock', diagnostics: true });
    await page.goto(`${baseURL}/caller`);

    // A failed first ticket leaves an idle client. Manual retry must create a
    // fresh connection instead of returning early because its call ID matches.
    await page.route('**/connection-ticket', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic ticket interruption' }) }));
    const call = await join(page); owned.add(call.id);
    await expect(page.getByText(/Synthetic ticket interruption/)).toBeVisible();
    await page.unroute('**/connection-ticket');
    await page.getByRole('button', { name: 'Reconnect audio' }).click();
    await expect.poll(async () => (await state(page)).connection).toBe('connected');
    await expect(page.getByText(/Synthetic ticket interruption/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Skip automated intake · request a person' }).click();
    await page.getByRole('button', { name: 'Enable microphone & output for handoff' }).click();
    await expect.poll(() => state(page)).toMatchObject({ microphone: 'ready', playback: 'ready' });

    await page.evaluate(async () => { await (window as unknown as AudioProbe).__nursebridge.context!.suspend(); });
    await expect(page.getByRole('button', { name: 'Resume audio' })).toBeVisible();
    await expect.poll(async () => (await state(page)).playback).toBe('blocked');
    await page.getByRole('button', { name: 'Resume audio' }).click();
    await expect.poll(() => state(page)).toMatchObject({ microphone: 'ready', playback: 'ready' });
    await expect(page.getByText(/Audio playback paused/)).toHaveCount(0);
    // Browser-driven resume, without another app click, must also update state.
    await page.evaluate(async () => { await (window as unknown as AudioProbe).__nursebridge.context!.suspend(); });
    await expect.poll(async () => (await state(page)).playback).toBe('blocked');
    await page.evaluate(async () => { await (window as unknown as AudioProbe).__nursebridge.context!.resume(); });
    await expect.poll(async () => (await state(page)).playback).toBe('ready');
    await expect(page.getByText(/Audio playback paused/)).toHaveCount(0);

    const ticketsBeforeGap = tickets;
    await page.evaluate(() => {
      const probe = window as unknown as AudioProbe;
      const client = probe.__nursebridge;
      probe.__retainedAudio = { context: client.context!, tracks: client.microphone!.getTracks(), socket: client.socket! };
      client.socket!.close(1000, 'Synthetic network interruption');
    });
    // This catches an incomplete server close handshake, which used to leave
    // Chrome in CLOSING while the app continued to report connected.
    await expect.poll(() => page.evaluate(() => (window as unknown as AudioProbe).__retainedAudio!.socket.readyState), { timeout: 5000 }).toBe(3);
    await expect.poll(() => tickets).toBe(ticketsBeforeGap + 1);
    await expect.poll(() => state(page)).toMatchObject({ connection: 'connected', microphone: 'ready', playback: 'ready' });
    await page.waitForTimeout(1200);
    expect(tickets).toBe(ticketsBeforeGap + 1);

    await command(page, call.id, 'end'); owned.delete(call.id);
    await expect(page.getByRole('heading', { name: 'Your demonstration call has ended.' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const retained = (window as unknown as AudioProbe).__retainedAudio!;
      return { context: retained.context.state, tracks: retained.tracks.map(track => track.readyState) };
    })).toEqual({ context: 'closed', tracks: ['ended'] });
    const ticketsAfterEnd = tickets;
    await page.waitForTimeout(1300);
    expect(tickets).toBe(ticketsAfterEnd);
    await page.screenshot({ path: testInfo.outputPath('remote-ended.png'), fullPage: true });

    await page.getByRole('button', { name: 'Start another fictional call' }).click();
    const deleted = await join(page); owned.add(deleted.id);
    await expect.poll(async () => (await state(page)).connection).toBe('connected');
    await page.getByRole('button', { name: 'Skip automated intake · request a person' }).click();
    await page.getByRole('button', { name: 'Enable microphone & output for handoff' }).click();
    await expect.poll(() => state(page)).toMatchObject({ microphone: 'ready', playback: 'ready' });
    await page.evaluate(() => {
      const probe = window as unknown as AudioProbe;
      const client = probe.__nursebridge;
      probe.__retainedAudio = { context: client.context!, tracks: client.microphone!.getTracks(), socket: client.socket! };
    });
    const deletion = await page.request.delete(`${baseURL}/api/calls/${deleted.id}`, { headers: { Origin: origin }, data: { commandId: crypto.randomUUID() } });
    expect(deletion.status()).toBe(200); owned.delete(deleted.id);
    await expect(page.getByRole('heading', { name: 'Your demonstration call was deleted.' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const retained = (window as unknown as AudioProbe).__retainedAudio!;
      return { context: retained.context.state, tracks: retained.tracks.map(track => track.readyState), socket: retained.socket.readyState };
    })).toEqual({ context: 'closed', tracks: ['ended'], socket: 3 });
    const ticketsAfterDelete = tickets;
    await page.waitForTimeout(1300);
    expect(tickets).toBe(ticketsAfterDelete);
    await expect(page.getByRole('button', { name: 'Reconnect audio' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const id of owned) await command(page, id, 'end');
    await page.evaluate(() => (window as unknown as AudioProbe).__nursebridge?.close()).catch(() => undefined);
    await context.close();
    await browser.close();
  }
});
