import { chromium, expect, test } from './helpers/fixtures';
import { resolve } from 'node:path';
import type { CallSnapshot } from '../../packages/contracts/src/index';

const origin = 'https://nursebridge-web-staging.pullthread-commerce-worker.workers.dev';
test.skip(process.env.NURSEBRIDGE_HOSTED_LIVE_E2E !== origin, 'Requires explicit opt-in to the approved staging origin and real provider use.');

test('hosted browser speech produces a transcript, supported intake facts and spoken replies', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const browser = await chromium.launch({ headless: process.env.NURSEBRIDGE_HEADED !== '1', ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}), args: [
    '--disable-crashpad-for-testing', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${resolve('tests/fixtures/fictional-caller-speech.wav')}`,
    '--autoplay-policy=no-user-gesture-required',
  ] });
  const staff = await browser.newContext({ baseURL: origin });
  const caller = await browser.newContext({ baseURL: origin, permissions: ['microphone'] });
  const nurse = await staff.newPage();
  const page = await caller.newPage();
  let callId: string | undefined;
  try {
    await nurse.goto('/nurse');
    await expect(nurse.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
    await nurse.getByRole('button', { name: 'Invite a caller', exact: true }).click();
    await nurse.getByRole('button', { name: 'Create caller invitation' }).click();
    const invitation = nurse.locator('.invitation-result a');
    await expect(invitation).toBeVisible();
    await page.goto((await invitation.getAttribute('href'))!);
    const creation = page.waitForResponse(response => response.url().endsWith('/api/calls') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Join call queue' }).click();
    const initial = (await (await creation).json()).call as CallSnapshot;
    callId = initial.id;
    expect(initial.mode).toBe('live');
    await page.getByRole('checkbox').check();
    const consent = page.waitForResponse(response => response.url().endsWith(`/api/calls/${callId}/consent`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Enable microphone & start intake' }).click();
    expect((await consent).ok()).toBe(true);
    const deadline = Date.now() + 100_000;
    let verified: CallSnapshot | undefined;
    while (Date.now() < deadline) {
      const response = await page.request.get(`/api/calls/${callId}`);
      expect(response.ok()).toBe(true);
      const state = (await response.json()).snapshot as CallSnapshot;
      if (state.providerSession.status === 'failed' || state.waitingReason === 'provider_failure') {
        throw new Error(`Live provider failed: ${state.provider.warning ?? state.waitingReason}`);
      }
      const turn = state.turns.find(turn => turn.final && /headache/i.test(turn.text));
      if (turn && state.facts.some(fact => fact.evidence.some(source => /headache/i.test(source.quote)))
        && state.assistantTurns.some(reply => reply.final && reply.text.trim() && reply.at >= turn.at)
        && typeof state.timings.firstAudioPlaybackMs === 'number') { verified = state; break; }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    expect(verified, 'Final speech, evidence-linked extraction, response, and browser audio playback must all be observed').toBeDefined();
    await testInfo.attach('hosted-live-proof.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      origin, finalizedTurns: verified!.turns.filter(turn => turn.final).length, facts: verified!.facts.length,
      assistantTurns: verified!.assistantTurns.length, timings: verified!.timings, recordingRetentionVerified: false,
    })) });
    await nurse.goto('/nurse');
    await expect(nurse.getByText(`Caller ${callId.slice(-4).toUpperCase()}`, { exact: true }).first()).toBeVisible();
    await testInfo.attach('hosted-live-nurse.png', { body: await nurse.screenshot(), contentType: 'image/png' });
  } finally {
    try {
      if (callId) {
        await page.request.post(`/api/calls/${callId}/end`, { headers: { Origin: origin }, data: { commandId: crypto.randomUUID() } }).catch(() => undefined);
        const removed = await nurse.request.delete(`/api/calls/${callId}`, { headers: { Origin: origin }, data: { commandId: crypto.randomUUID() } });
        expect(removed.ok(), 'Remove only the fictional call created by this test').toBe(true);
      }
    } finally { await browser.close(); }
  }
});
