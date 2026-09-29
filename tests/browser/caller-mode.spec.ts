import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { resolve } from 'node:path';
import { RECORDING_DISCLOSURE, RECORDING_DISCLOSURE_VERSION, type Mode } from '../../packages/contracts/src';
import { newState } from '../../apps/realtime/src/state';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const realtimeUrl = new URL(baseURL).origin.replace(/^http/, 'ws');
const participantId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const originalId = '33333333-3333-4333-8333-333333333333';
const replacementId = '44444444-4444-4444-8444-444444444444';

test.use({
  permissions: ['microphone'],
  launchOptions: { args: [
    '--disable-crashpad-for-testing', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${resolve('tests/fixtures/microphone-440hz.wav')}`,
    '--autoplay-policy=no-user-gesture-required',
  ] },
});

async function restoredCall(page: Page, savedMode: Mode, runtimeMode: Mode) {
  const calls = [newState({ callId: originalId, workspaceId, callerParticipantId: participantId, mode: savedMode })];
  const mutations: { path: string; body: Record<string, unknown> }[] = [];
  const unexpected: string[] = [];
  const sockets = new Set<WebSocketRoute>();
  // All application requests and realtime connections are intercepted. These
  // UI regressions never create a real workspace or contact an audio provider.
  await page.routeWebSocket('**/connect/**', socket => {
    sockets.add(socket);
    const id = new URL(socket.url()).pathname.split('/').at(-1);
    socket.onMessage(message => {
      if (typeof message !== 'string') { socket.send(JSON.stringify({ type: 'audio-ack', credits: 1 })); return; }
      const input = JSON.parse(message) as { type?: string };
      if (input.type === 'auth') socket.send(JSON.stringify({ type: 'authenticated', credits: 20, role: 'caller', snapshot: calls.find(call => call.id === id) }));
      if (input.type === 'heartbeat') socket.send(JSON.stringify({ type: 'heartbeat' }));
    });
    socket.onClose(() => sockets.delete(socket));
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === '/api/demo/config') return route.fulfill({ json: { turnstileSiteKey: null, enrollmentMode: 'sandbox' } });
    if (path === '/api/demo/session' && method === 'GET') return route.fulfill({ json: {
      session: { workspaceId, participantId, role: 'caller', expiresAt: Date.now() + 3600000 }, mode: runtimeMode, realtimeUrl, diagnostics: true,
    } });
    if (path === '/api/calls' && method === 'GET') return route.fulfill({ json: { calls, updatedAt: Date.now() } });
    if (path === '/api/calls' && method === 'POST') {
      mutations.push({ path, body: request.postDataJSON() });
      const call = newState({ callId: replacementId, workspaceId, callerParticipantId: participantId, mode: runtimeMode });
      calls.push(call);
      return route.fulfill({ status: 201, json: { call } });
    }
    const match = /^\/api\/calls\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    const call = match && calls.find(value => value.id === match[1]);
    if (call) {
      if (!match[2] && method === 'GET') return route.fulfill({ json: { ok: true, snapshot: call } });
      if (match[2] === 'connection-ticket' && method === 'POST') return route.fulfill({ json: { ticket: 'intercepted-test-ticket', websocketPath: `/connect/${call.id}`, realtimeUrl } });
      if (method === 'POST' && ['end', 'consent'].includes(match[2]!)) {
        const body = request.postDataJSON() as Record<string, unknown>;
        mutations.push({ path, body });
        call.revision++;
        if (match[2] === 'end') { call.queueState = 'CLOSED'; call.conversationOwner = 'NONE'; call.aiStatus = 'stopped'; }
        else { call.consent = body.accepted === true; call.intakeState = 'CONSENTED'; call.conversationOwner = 'AI'; }
        return route.fulfill({ json: { ok: true, snapshot: call } });
      }
    }
    unexpected.push(`${method} ${path}`);
    return route.abort('blockedbyclient');
  });
  return { calls, mutations, unexpected, sockets };
}

for (const savedMode of ['mock', 'live'] as const) {
  const runtimeMode = savedMode === 'mock' ? 'live' : 'mock';
  test(`restored ${savedMode} call keeps its disclosure when new calls use ${runtimeMode}`, async ({ page }, testInfo) => {
    const fixture = await restoredCall(page, savedMode, runtimeMode);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await page.goto(`${baseURL}/caller?call=${originalId}`);
      await expect(page).toHaveTitle('NurseBridge · The intake workspace');
      await expect(page.getByRole('heading', { name: 'Tell your story.' })).toBeVisible();
      await expect(page.getByText(/This call uses .* New calls use .* To change modes, end this call/)).toBeVisible();
      const consent = page.locator('.consent-label');
      await expect(consent).toContainText(savedMode === 'live' ? RECORDING_DISCLOSURE : 'AssemblyAI recording is not used.');
      await expect(consent.getByRole('checkbox')).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Enable microphone & start intake' })).toBeDisabled();
      if (savedMode === 'mock') {
        await expect(page.getByRole('heading', { name: 'Transcript replay', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Replay transcript', exact: true })).toBeDisabled();
      } else await expect(page.getByRole('heading', { name: 'Transcript replay', exact: true })).toHaveCount(0);
      expect(fixture.mutations).toEqual([]);
      expect(fixture.calls[0]).toMatchObject({ id: originalId, mode: savedMode, queueState: 'WAITING' });
      await page.screenshot({ path: testInfo.outputPath(`restored-${savedMode}-mode.png`), fullPage: true });

      await page.getByRole('button', { name: 'Leave queue & end call' }).click();
      await expect(page.getByRole('heading', { name: 'Your call has ended.' })).toBeVisible();
      await page.getByRole('button', { name: 'Start another call' }).click();
      await page.getByRole('button', { name: 'Join call queue' }).click();
      await expect(page.getByText(/This call uses .* New calls use/)).toHaveCount(0);
      await expect(consent).toContainText(runtimeMode === 'live' ? RECORDING_DISCLOSURE : 'AssemblyAI recording is not used.');
      await consent.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Enable microphone & start intake' }).click();
      await expect.poll(() => fixture.mutations.filter(item => item.path.endsWith('/consent')).length).toBe(1);
      const payload = fixture.mutations.find(item => item.path.endsWith('/consent'))!.body;
      expect(payload.accepted).toBe(true);
      if (runtimeMode === 'live') expect(payload).toMatchObject({ recordingAccepted: true, recordingDisclosureVersion: RECORDING_DISCLOSURE_VERSION });
      else { expect(payload).not.toHaveProperty('recordingAccepted'); expect(payload).not.toHaveProperty('recordingDisclosureVersion'); }
      expect(fixture.calls).toHaveLength(2);
      expect(fixture.calls[0]).toMatchObject({ id: originalId, mode: savedMode, queueState: 'CLOSED' });
      expect(fixture.calls[1]).toMatchObject({ id: replacementId, mode: runtimeMode, consent: true });
      expect(fixture.mutations.map(item => item.path)).toEqual([`/api/calls/${originalId}/end`, '/api/calls', `/api/calls/${replacementId}/consent`]);
      expect(fixture.unexpected).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await page.evaluate(() => (window as unknown as { __nursebridge?: { close(): void } }).__nursebridge?.close()).catch(() => undefined);
      for (const socket of fixture.sockets) socket.close();
    }
  });
}
