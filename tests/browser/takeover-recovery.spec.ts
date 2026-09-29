import { chromium, expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { CallSnapshot } from '../../packages/contracts/src/index';
import { attachAudioDiagnostics } from './helpers/audio-diagnostics';
import { watchTakeoverOutcomes } from './helpers/takeover-diagnostics';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const origin = new URL(baseURL).origin;

async function post(page: Page, path: string, data: Record<string, unknown> = {}) {
  return page.request.post(`${baseURL}${path}`, { headers: { Origin: origin }, data: { commandId: crypto.randomUUID(), ...data } });
}
async function snapshot(page: Page, id: string): Promise<CallSnapshot> {
  const response = await page.request.get(`${baseURL}/api/calls/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).snapshot as CallSnapshot;
}
async function audioBrowser(frequency: 440 | 660, clientAddress: string) {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}), args: ['--disable-crashpad-for-testing', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(`tests/fixtures/microphone-${frequency}hz.wav`)}`, '--autoplay-policy=no-user-gesture-required'] });
  // Independent clients must not exhaust the shared local harness's enrollment
  // quota. Context headers also apply to page.request; never spoof a hosted IP.
  const extraHTTPHeaders = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)
    ? { 'CF-Connecting-IP': clientAddress } : undefined;
  const context = await browser.newContext({ baseURL, permissions: ['microphone'], viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', extraHTTPHeaders });
  return { browser, context, page: await context.newPage() };
}

for (const interrupted of ['claim', 'takeover'] as const) test(`a caller request racing ${interrupted} preserves takeover intent and completes human audio`, async ({}, testInfo) => {
  const clientOffset = interrupted === 'claim' ? 0 : 2;
  const nurse = await audioBrowser(660, `192.0.2.${clientOffset + 1}`);
  const caller = await audioBrowser(440, `192.0.2.${clientOffset + 2}`);
  const takeoverTraffic = watchTakeoverOutcomes(nurse.page);
  let callId: string | undefined;
  try {
    expect((await post(nurse.page, '/api/demo/session')).status()).toBe(201);
    const session = await (await nurse.page.request.get(`${baseURL}/api/demo/session`)).json();
    expect(session.mode).toBe('mock');
    const invitation = await post(nurse.page, '/api/demo/invitations', { role: 'caller' });
    expect(invitation.status()).toBe(201);
    await caller.page.goto((await invitation.json()).url as string);
    const created = caller.page.waitForResponse(response => new URL(response.url()).pathname === '/api/calls' && response.request().method() === 'POST');
    await caller.page.getByRole('button', { name: 'Join call queue' }).click();
    const { call } = await (await created).json() as { call: CallSnapshot };
    callId = call.id;
    await caller.page.getByRole('button', { name: 'Skip automated intake · request a person' }).click();
    await caller.page.getByRole('button', { name: 'Enable microphone & output for handoff' }).click();
    await expect.poll(async () => (await snapshot(caller.page, call.id)).mediaReady.caller).toBe(true);
    await nurse.page.goto(`${baseURL}/nurse`);
    await expect(nurse.page.getByRole('button', { name: 'Take over call', exact: true })).toBeEnabled();
    const results: number[] = [];
    const commands: Record<string, unknown>[] = [];
    await nurse.page.route(`${baseURL}/api/calls/${call.id}/${interrupted}`, async route => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      if (commands.length === 1) {
        // A real caller action advances controlRevision after the nurse prepared its request.
        expect((await post(caller.page, `/api/calls/${call.id}/request-human`)).ok()).toBe(true);
      }
      const response = await route.fetch();
      results.push(response.status());
      await route.fulfill({ response });
    });
    await nurse.page.getByRole('button', { name: 'Take over call', exact: true }).click();
    await expect.poll(async () => (await snapshot(nurse.page, call.id)).queueState, { timeout: 12_000 }).toBe('CONNECTED');
    expect(results).toEqual([409, 200]);
    expect(Number(commands[1]?.expectedRevision)).toBeGreaterThan(Number(commands[0]?.expectedRevision));
    expect(commands[1]?.commandId).not.toBe(commands[0]?.commandId);
    for (const [page, expected] of [[caller.page, 660], [nurse.page, 440]] as const) {
      await expect.poll(() => page.evaluate(() => Number((window as unknown as { __nursebridgeDiagnostics?: { dominantFrequency?: number } }).__nursebridgeDiagnostics?.dominantFrequency ?? 0)).then(value => Math.abs(value - expected))).toBeLessThan(12);
    }
  } finally {
    await takeoverTraffic.attach(testInfo);
    await attachAudioDiagnostics(caller.page, testInfo, 'caller');
    await attachAudioDiagnostics(nurse.page, testInfo, 'nurse');
    await nurse.page.unrouteAll({ behavior: 'ignoreErrors' });
    if (callId) await post(nurse.page, `/api/calls/${callId}/end`);
    for (const participant of [caller, nurse]) { await participant.context.close(); await participant.browser.close(); }
  }
});
