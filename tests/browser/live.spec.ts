import { chromium, expect, test, type Browser, type BrowserContext, type Page } from './helpers/fixtures';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { CallSnapshot } from '../../packages/contracts/src/index';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const origin = new URL(baseURL).origin;

test.skip(process.env.NURSEBRIDGE_LIVE_E2E !== '1', 'Requires explicit fictional live-provider opt-in and local Workers in live mode.');

async function participant(fixture: string, extraHTTPHeaders?: Record<string, string>): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    args: [
      '--disable-crashpad-for-testing',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${resolve(`tests/fixtures/${fixture}`)}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  try {
    const context = await browser.newContext({ baseURL, extraHTTPHeaders, permissions: ['microphone'] });
    return { browser, context, page: await context.newPage() };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function snapshot(page: Page, callId: string): Promise<CallSnapshot> {
  const response = await page.request.get(`${baseURL}/api/calls/${callId}`, { timeout: 10_000 });
  expect(response.ok(), `Call snapshot returned ${response.status()}`).toBeTruthy();
  return (await response.json()).snapshot as CallSnapshot;
}

async function diagnostics(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => (window as unknown as { __nursebridgeDiagnostics?: Record<string, unknown> }).__nursebridgeDiagnostics ?? {});
}

async function audibleHumanAudio(page: Page): Promise<Record<string, unknown>> {
  let proof: Record<string, unknown> = {};
  // The speech fixture includes pauses and loops. Sample while speech is
  // actually playing so silent PCM cannot satisfy the handoff assertion.
  await expect.poll(async () => {
    proof = await diagnostics(page);
    return Number(proof.humanSamplesInEpoch ?? 0) > 1000 && Number(proof.rms ?? 0) > 0.02;
  }, { timeout: 40_000, message: 'Human audio must contain a non-silent playback window' }).toBe(true);
  return proof;
}

async function transportDiagnostics(page: Page): Promise<{ sentFrames: number; epoch: number; credits: number; microphone: string }> {
  return page.evaluate(() => {
    const client = (window as unknown as { __nursebridge?: { sequence?: number; epoch?: number; credits?: number; getState?: () => { microphone: string } } }).__nursebridge;
    return { sentFrames: client?.sequence ?? 0, epoch: client?.epoch ?? -1, credits: client?.credits ?? -1, microphone: client?.getState?.().microphone ?? 'unavailable' };
  });
}

async function mediaStartupDiagnostics(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const client = (window as unknown as { __nursebridge?: {
      getState?: () => { connection: string; microphone: string; playback: string; error?: string };
      context?: AudioContext;
      capture?: AudioWorkletNode;
      playback?: AudioWorkletNode;
      microphone?: MediaStream;
      mediaPromise?: Promise<void>;
      sequence?: number;
    } }).__nursebridge;
    const alert = document.querySelector<HTMLElement>('.caller-main [role="alert"]')?.innerText ?? '';
    const alertCategory = /permission/i.test(alert) ? 'permission' : /audio|microphone/i.test(alert) ? 'audio' : alert ? 'other' : 'none';
    return {
      state: client?.getState?.(),
      audioContext: client?.context?.state ?? 'absent',
      captureNode: Boolean(client?.capture),
      playbackNode: Boolean(client?.playback),
      microphoneStream: Boolean(client?.microphone),
      trackStates: client?.microphone?.getAudioTracks().map(track => track.readyState) ?? [],
      mediaPromisePending: Boolean(client?.mediaPromise),
      sentFrames: client?.sequence ?? 0,
      alertCategory,
    };
  });
}

async function observeCapturedAudio(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserWindow = window as unknown as {
      __nursebridge?: { capture?: { port: MessagePort } };
      __nursebridgeInput?: { frames: number; nonSilentFrames: number; peakRms: number };
    };
    const port = browserWindow.__nursebridge?.capture?.port;
    if (!port) throw new Error('Caller capture worklet is unavailable');
    const stats = { frames: 0, nonSilentFrames: 0, peakRms: 0 };
    browserWindow.__nursebridgeInput = stats;
    port.addEventListener('message', event => {
      if (event.data?.type !== 'frame' || !(event.data.pcm instanceof ArrayBuffer)) return;
      const samples = new Int16Array(event.data.pcm);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const rms = Math.sqrt(energy / samples.length) / 32768;
      stats.frames++;
      if (rms > 0.02) stats.nonSilentFrames++;
      stats.peakRms = Math.max(stats.peakRms, rms);
    });
  });
}

async function waitForLiveProvider(page: Page, callId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await snapshot(page, callId);
    if (state.providerSession.status === 'active') return;
    if (state.providerSession.status === 'failed') {
      throw new Error(`Voice Agent handshake failed: ${state.provider.warning ?? 'unknown provider error'}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Voice Agent did not become active within 30 seconds.');
}

async function waitForLiveMilestone(page: Page, callId: string, name: string, predicate: (state: CallSnapshot) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await snapshot(page, callId);
    if (predicate(state)) return;
    if (state.providerSession.status === 'failed') throw new Error(`${name} interrupted: ${state.provider.warning ?? 'unknown provider error'}`);
    if (state.conversationOwner !== 'AI') throw new Error(`${name} interrupted: automation no longer owns the call (${state.waitingReason ?? 'unknown reason'})`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${name} did not arrive within ${timeoutMs} ms`);
}

test('fictional speech reaches AssemblyAI and Nebius before two-way nurse takeover', async ({ extraHTTPHeaders }, testInfo) => {
  test.setTimeout(180_000);
  expect(new URL(baseURL).protocol, 'Live audio acceptance must remain local').toBe('http:');
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(baseURL).hostname);
  const startedAt = Date.now();
  const caller = await participant('fictional-caller-speech.wav', extraHTTPHeaders);
  let nurse: Awaited<ReturnType<typeof participant>>;
  try {
    nurse = await participant('microphone-660hz.wav', extraHTTPHeaders);
  } catch (error) {
    await caller.browser.close();
    throw error;
  }
  let callId: string | undefined;
  let stage = 'workspace setup';
  const failures: string[] = [];
  for (const [role, page] of [['caller', caller.page], ['nurse', nurse.page]] as const) {
    page.on('pageerror', error => failures.push(`${role}: ${error.message}`));
  }
  try {
    await nurse.page.goto('/workspace');
    await expect(nurse.page).toHaveTitle('NurseBridge · The intake workspace');
    await nurse.page.getByRole('button', { name: 'Create local workspace' }).click();
    await expect(nurse.page.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
    const session = await (await nurse.page.request.get(`${baseURL}/api/demo/session`)).json() as { mode: string; diagnostics: boolean };
    expect(session.mode).toBe('live');
    expect(session.diagnostics).toBe(true);
    await nurse.page.getByRole('button', { name: 'Invite a caller', exact: true }).click();
    await nurse.page.getByRole('button', { name: 'Create caller invitation' }).click();
    const invitation = nurse.page.locator('.invitation-result a');
    await expect(invitation).toBeVisible();
    await caller.page.goto((await invitation.getAttribute('href'))!);
    await expect(caller.page.getByRole('button', { name: 'Join call queue' })).toBeEnabled();
    await nurse.page.goto('/nurse');
    const created = caller.page.waitForResponse(response => response.url().endsWith('/api/calls') && response.request().method() === 'POST');
    await caller.page.getByRole('button', { name: 'Join call queue' }).click();
    const call = (await (await created).json()).call as CallSnapshot;
    callId = call.id;
    expect(call.mode).toBe('live');
    await expect(nurse.page.getByText(`Caller ${call.id.slice(-4).toUpperCase()}`, { exact: true }).first()).toBeVisible();
    stage = 'media activation and consent';
    await caller.page.getByRole('checkbox').check();
    const consentResponse = caller.page.waitForResponse(response => response.url().endsWith(`/api/calls/${call.id}/consent`) && response.request().method() === 'POST', { timeout: 15_000 });
    await caller.page.getByRole('button', { name: 'Enable microphone & start intake' }).click();
    try {
      expect((await consentResponse).ok(), 'Live consent request should succeed').toBe(true);
      await expect.poll(async () => (await snapshot(caller.page, call.id)).consent, { timeout: 15_000 }).toBe(true);
      await expect.poll(async () => (await transportDiagnostics(caller.page)).microphone, { timeout: 15_000 }).toBe('ready');
    } catch (reason) {
      const state = await mediaStartupDiagnostics(caller.page).catch(() => ({ unavailable: true }));
      throw new Error(`Live media activation or consent failed: ${JSON.stringify(state)}`, { cause: reason });
    }
    await observeCapturedAudio(caller.page);

    stage = 'provider handshake';
    await waitForLiveProvider(caller.page, call.id);
    stage = 'agent audio playback';
    await expect.poll(async () => (await snapshot(caller.page, call.id)).timings.firstAudioPlaybackMs, { timeout: 45_000 }).toEqual(expect.any(Number));
    stage = 'caller audio transport';
    await caller.page.waitForTimeout(20_000);
    const transport = await transportDiagnostics(caller.page);
    const transportState = await snapshot(caller.page, call.id);
    const captured = await caller.page.evaluate(() => (window as unknown as { __nursebridgeInput?: Record<string, number> }).__nursebridgeInput);
    console.log(`Fictional caller transport at ${Date.now() - startedAt} ms: ${JSON.stringify({ ...transport, ...captured, serverEpoch: transportState.controlEpoch })}`);
    expect(transport.microphone).toBe('ready');
    expect(transport.sentFrames).toBeGreaterThan(200);
    expect(transport.epoch).toBe(transportState.controlEpoch);
    expect(captured?.nonSilentFrames).toBeGreaterThan(10);
    stage = 'final caller transcript';
    await waitForLiveMilestone(caller.page, call.id, 'Final caller transcript', state => state.turns.some(turn => turn.final && /headache/i.test(turn.text)), 55_000);
    stage = 'Nebius evidence extraction';
    await waitForLiveMilestone(caller.page, call.id, 'Nebius evidence extraction', state => state.facts.some(fact => fact.evidence.some(source => /headache/i.test(source.quote))), 35_000);
    stage = 'agent response to caller';
    await waitForLiveMilestone(caller.page, call.id, 'Agent response to caller', state => {
      const turn = state.turns.find(turn => turn.final && /headache/i.test(turn.text));
      return Boolean(turn && state.assistantTurns.some(reply => reply.final && reply.text.trim() && reply.at >= turn.at));
    }, 30_000);
    const intake = await snapshot(caller.page, call.id);
    expect(intake.providerSession.id).toBeTruthy();
    expect(intake.assistantTurns.length).toBeGreaterThan(0);
    for (const fact of intake.facts) for (const evidence of fact.evidence) {
      expect(intake.turns.find(turn => turn.id === evidence.turnId)?.text).toContain(evidence.quote);
    }
    await testInfo.attach('live-intake.png', { body: await nurse.page.screenshot(), contentType: 'image/png' });

    stage = 'nurse takeover';
    await expect(nurse.page.getByRole('button', { name: 'Take over call' })).toBeEnabled();
    await nurse.page.getByRole('button', { name: 'Take over call' }).click();
    await expect.poll(async () => (await snapshot(caller.page, call.id)).queueState, { timeout: 20_000 }).toBe('CONNECTED');
    const connected = await snapshot(caller.page, call.id);
    expect(connected.conversationOwner).toBe('NURSE');
    expect(connected.providerSession.status).toBe('ended');
    const [callerAudio, nurseAudio] = await Promise.all([audibleHumanAudio(caller.page), audibleHumanAudio(nurse.page)]);
    for (const proof of [callerAudio, nurseAudio]) {
      expect(proof.controlEpoch).toBe(connected.controlEpoch);
      expect(proof.agentSamplesInEpoch).toBe(0);
    }
    await testInfo.attach('live-nurse-takeover.png', { body: await nurse.page.screenshot(), contentType: 'image/png' });
    const evidence = {
      callId: call.id,
      providerSessionId: intake.providerSession.id,
      finalizedCallerTurns: intake.turns.filter(turn => turn.final).length,
      evidenceLinkedFacts: intake.facts.length,
      assistantTurns: intake.assistantTurns.length,
      agentRespondedAfterCaller: true,
      speechStartToFinalTranscriptMs: (() => {
        const speech = intake.timeline.find(event => event.type === 'caller-speaking');
        const final = intake.timeline.find(event => event.type === 'transcript-final' && (!speech || event.at >= speech.at));
        return speech && final ? final.at - speech.at : null;
      })(),
      timings: connected.timings,
      callerAudio,
      nurseAudio,
    };
    const path = testInfo.outputPath('fictional-live-proof.json');
    await writeFile(path, JSON.stringify(evidence, null, 2));
    await testInfo.attach('fictional-live-proof.json', { path, contentType: 'application/json' });
    expect(failures).toEqual([]);
  } finally {
    console.log(`Fictional live E2E reached ${stage} at ${Date.now() - startedAt} ms`);
    try {
      if (callId) {
        const finalState = await snapshot(caller.page, callId).catch(() => undefined);
        if (finalState) {
          await testInfo.attach('fictional-live-final-snapshot.json', {
            body: Buffer.from(JSON.stringify(finalState, null, 2)), contentType: 'application/json',
          });
        }
        // End alone retains provider history until expiry. Delete only this
        // test-created case so its durable provider cleanup runs immediately.
        await caller.page.request.post(`${baseURL}/api/calls/${callId}/end`, { headers: { Origin: origin }, data: { commandId: crypto.randomUUID() }, timeout: 5_000 }).catch(() => undefined);
        const removed = await nurse.page.request.delete(`${baseURL}/api/calls/${callId}`, {
          headers: { Origin: origin }, data: { commandId: crypto.randomUUID() }, timeout: 20_000,
        });
        const inaccessible = await nurse.page.request.get(`${baseURL}/api/calls/${callId}`, { timeout: 5_000 });
        await testInfo.attach('live-case-cleanup.json', {
          body: Buffer.from(JSON.stringify({ deletionStatus: removed.status(), subsequentReadStatus: inaccessible.status() })),
          contentType: 'application/json',
        });
        expect(removed.ok(), 'Test case deletion must succeed before shutdown').toBe(true);
        expect([404, 410]).toContain(inaccessible.status());
      }
    } finally {
      // Stop capture/worklets before closing the directly owned browsers.
      try {
        const closed = await Promise.allSettled([caller, nurse].map(async participant => {
          await participant.page.evaluate(() => (window as unknown as { __nursebridge?: { close(): void } }).__nursebridge?.close()).catch(() => undefined);
          await participant.context.close();
        }));
        const failed = closed.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } finally {
        await Promise.all([caller.browser.close(), nurse.browser.close()]);
      }
    }
  }
});
