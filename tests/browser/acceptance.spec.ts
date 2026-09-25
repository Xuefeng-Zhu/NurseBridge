import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { CallSnapshot } from '../../packages/contracts/src/index';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const origin = new URL(baseURL).origin;

async function mutate(page: Page, path: string, data: Record<string, unknown> = {}) {
  return page.request.post(`${baseURL}${path}`, { headers: { Origin: origin }, data: { commandId: crypto.randomUUID(), ...data } });
}

async function snapshot(page: Page, callId: string): Promise<CallSnapshot> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await page.request.get(`${baseURL}/api/calls/${callId}`);
    if (response.ok()) return (await response.json()).snapshot as CallSnapshot;
    if (response.status() !== 503 || attempt === 3) {
      expect(response.ok(), `Authoritative call fetch returned ${response.status()}`).toBeTruthy();
    }
    await page.waitForTimeout(25 * 2 ** attempt);
  }
  throw new Error('Authoritative call fetch exhausted transient retries');
}

async function audioBrowser(frequency: 440 | 660): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    args: [
      '--disable-crashpad-for-testing',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${resolve(`tests/fixtures/microphone-${frequency}hz.wav`)}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ baseURL, permissions: ['microphone'], viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  return { browser, context, page };
}

async function workspace(page: Page): Promise<void> {
  await page.goto(`${baseURL}/demo`);
  const created = page.waitForResponse(response => response.url().endsWith('/api/demo/session') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create your private demo workspace' }).click();
  expect((await created).status()).toBe(201);
  await expect(page.getByText('Your isolated workspace is ready')).toBeVisible();
  await page.goto(`${baseURL}/nurse`);
  await expect(page.getByRole('heading', { name: 'Context before conversation.' })).toBeVisible();
}

async function invite(admin: Page, caller: Page): Promise<string> {
  await admin.goto(`${baseURL}/demo`);
  await admin.getByRole('button', { name: 'Create caller invitation' }).click();
  const link = admin.locator('.invitation-result a');
  await expect(link).toBeVisible();
  const url = (await link.getAttribute('href'))!;
  await caller.goto(url);
  await expect(caller.getByRole('button', { name: 'Join demonstration queue' })).toBeEnabled();
  await admin.goto(`${baseURL}/nurse`);
  return url;
}

async function join(caller: Page): Promise<CallSnapshot> {
  const created = caller.waitForResponse(response => response.url().endsWith('/api/calls') && response.request().method() === 'POST');
  await caller.getByRole('button', { name: 'Join demonstration queue' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  return (await response.json()).call as CallSnapshot;
}

async function diagnostics(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => (window as unknown as { __nursebridgeDiagnostics?: Record<string, unknown> }).__nursebridgeDiagnostics ?? {});
}

function frequency(value: Record<string, unknown>): number {
  // The UI exposes a test-only root diagnostics snapshot, or wraps it as audio.
  const audio = value.audio && typeof value.audio === 'object' ? value.audio as Record<string, unknown> : value.diagnostics && typeof value.diagnostics === 'object' ? value.diagnostics as Record<string, unknown> : value;
  return Number(audio.dominantFrequency ?? 0);
}

test('visible intake preserves evidence and corrections, then relays both distinct human microphones', async ({}, testInfo) => {
  const caller = await audioBrowser(440);
  const nurse = await audioBrowser(660);
  const errors: string[] = [];
  let nurseWorkspaceReady = false;
  caller.page.on('pageerror', error => errors.push(`caller:${error.message}`));
  nurse.page.on('pageerror', error => errors.push(`nurse:${error.message}`));
  caller.page.on('console', message => { if (message.type() === 'error') errors.push(`caller:${message.text()}`); });
  nurse.page.on('console', message => {
    if (!nurseWorkspaceReady && message.location().url === `${origin}/api/demo/session` && message.text().includes('401')) return;
    if (message.type() === 'error') errors.push(`nurse:${message.text()}`);
  });
  try {
    await workspace(nurse.page);
    nurseWorkspaceReady = true;
    const configuredSession = await (await nurse.page.request.get(`${baseURL}/api/demo/session`)).json() as { mode: string; diagnostics: boolean };
    expect(configuredSession.mode, 'Synthetic browser acceptance must run in explicit mock provider mode').toBe('mock');
    expect(configuredSession.diagnostics, 'Enable test diagnostics only in the isolated local test environment').toBe(true);
    await invite(nurse.page, caller.page);
    const call = await join(caller.page);
    expect(call.intakeState).toBe('NOT_STARTED');
    expect(call.queueState).toBe('WAITING');
    await expect(caller.page.getByText('Simulation only — use fictional patient information. Not for medical care.')).toBeVisible();
    await expect(nurse.page.getByText(`Caller ${call.id.slice(-4).toUpperCase()}`, { exact: true }).first()).toBeVisible();
    await caller.page.getByRole('checkbox').check();
    await expect(caller.page.getByRole('button', { name: 'Enable microphone & start intake' })).toBeEnabled();
    await caller.page.getByRole('button', { name: 'Enable microphone & start intake' }).click();
    await expect.poll(async () => (await snapshot(caller.page, call.id)).mediaReady.caller).toBe(true);

    const lines = [
      'I am calling about a headache that started yesterday afternoon. It is mostly behind my eyes. I would describe it as a six out of ten.',
      'No other symptoms. I have not checked my temperature.',
      'I need to correct that: the headache started this morning, not yesterday.',
    ];
    for (let index = 0; index < lines.length; index++) {
      await caller.page.getByLabel('Fictional caller turn').fill(lines[index]!);
      await caller.page.getByRole('button', { name: 'Replay fictional turn' }).click();
      await expect.poll(async () => (await snapshot(caller.page, call.id)).turns.length).toBe(index + 1);
      await expect.poll(async () => (await snapshot(caller.page, call.id)).facts.length).toBeGreaterThan(0);
    }
    const intake = await snapshot(nurse.page, call.id);
    expect(intake.facts.some(fact => fact.status === 'not_measured' && fact.rawWording.toLowerCase().includes('temperature'))).toBe(true);
    expect(intake.facts.find(fact => fact.field === 'onset')?.value).toContain('this morning');
    expect(intake.factRevisions.some(revision => revision.field === 'onset' && revision.previous)).toBe(true);
    for (const fact of intake.facts) for (const evidence of fact.evidence) {
      expect(intake.turns.find(turn => turn.id === evidence.turnId)?.text).toContain(evidence.quote);
    }
    await expect(nurse.page.getByText('Not measured does not mean the symptom was denied.')).toBeVisible();
    await nurse.page.getByRole('tab', { name: 'Revisions' }).click();
    await expect(nurse.page.getByText(/this morning/).first()).toBeVisible();
    await nurse.page.screenshot({ path: testInfo.outputPath('nurse-evidence.png'), fullPage: true });
    await caller.page.screenshot({ path: testInfo.outputPath('caller-intake.png'), fullPage: true });

    // Trigger an approved question with an audible220Hz mock cue, then interrupt it.
    await caller.page.getByLabel('Fictional caller turn').fill('I do not take medication.');
    await caller.page.getByRole('button', { name: 'Replay fictional turn' }).click();
    await expect.poll(async () => Math.abs(frequency(await diagnostics(caller.page)) - 220)).toBeLessThan(12);
    expect(Number((await diagnostics(caller.page)).queuedSamples)).toBeGreaterThan(0);
    await expect(nurse.page.getByRole('button', { name: 'Take over call' })).toBeEnabled();
    await nurse.page.getByRole('button', { name: 'Take over call' }).click();
    await expect.poll(async () => (await snapshot(nurse.page, call.id)).queueState, { timeout: 20_000 }).toBe('CONNECTED');
    await expect(caller.page.getByText('Two-way browser audio is active. Automated providers are stopped.')).toBeVisible();
    await expect(nurse.page.getByText('Human audio connected', { exact: true })).toBeVisible();
    const connected = await snapshot(nurse.page, call.id);
    expect(connected.conversationOwner).toBe('NURSE');
    expect(connected.providerSession.status).toBe('ended');
    expect(connected.facts.find(fact => fact.field === 'medications')?.status).toBe('denied');

    // Separate Chromium processes give each sender a different actual fake microphone.
    // Verify processed receiver samples, not just WS receipt or a connected label.
    await expect.poll(async () => Math.abs(frequency(await diagnostics(caller.page)) - 660), { timeout: 15_000 }).toBeLessThan(12);
    await expect.poll(async () => Math.abs(frequency(await diagnostics(nurse.page)) - 440), { timeout: 15_000 }).toBeLessThan(12);
    await caller.page.waitForTimeout(700);
    expect(Math.abs(frequency(await diagnostics(caller.page)) - 660)).toBeLessThan(12);
    expect(Math.abs(frequency(await diagnostics(nurse.page)) - 440)).toBeLessThan(12);
    for (const page of [caller.page, nurse.page]) {
      const proof = await diagnostics(page);
      expect(proof.controlEpoch).toBe(connected.controlEpoch);
      expect(proof.agentSamplesInEpoch).toBe(0);
      expect(Number(proof.humanSamplesInEpoch)).toBeGreaterThan(1000);
    }
    const proofPath = testInfo.outputPath('audio-proof.json');
    await writeFile(proofPath, JSON.stringify({ caller: await diagnostics(caller.page), nurse: await diagnostics(nurse.page), timings: connected.timings }, null, 2));
    await testInfo.attach('audio-proof.json', { path: proofPath, contentType: 'application/json' });
    await nurse.page.screenshot({ path: testInfo.outputPath('human-handoff.png'), fullPage: true });
    await caller.page.setViewportSize({ width: 390, height: 844 });
    await nurse.page.setViewportSize({ width: 390, height: 844 });
    await nurse.page.getByRole('button', { name: 'Intake draft', exact: true }).click();
    await expect(nurse.page.getByRole('region', { name: 'Selected intake draft' })).toBeVisible();
    await expect(nurse.page.getByRole('region', { name: 'Caller queue' })).toBeHidden();
    for (const page of [caller.page, nurse.page]) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await caller.page.screenshot({ path: testInfo.outputPath('caller-mobile.png'), fullPage: true });
    await nurse.page.screenshot({ path: testInfo.outputPath('nurse-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    // Shut down active fake capture/worklet graphs before Chromium's process cleanup.
    for (const participant of [caller, nurse]) {
      await participant.page.evaluate(() => (window as unknown as { __nursebridge?: { close(): void } }).__nursebridge?.close()).catch(() => undefined);
      await participant.context.close();
    }
    await Promise.all([caller.browser.close(), nurse.browser.close()]);
  }
});

test('one unsuccessful clarification stops automation and shows unresolved nurse follow-up', async ({ page }) => {
  await workspace(page);
  await page.goto(`${baseURL}/caller`);
  const call = await join(page);
  expect(call.callDeadlineAt - call.createdAt).toBe(600_000);
  expect((await mutate(page, `/api/calls/${call.id}/consent`, { accepted: true })).status()).toBe(200);

  expect((await mutate(page, `/api/calls/${call.id}/mock-turn`, { text: 'I do not know.' })).status()).toBe(200);
  await expect.poll(async () => (await snapshot(page, call.id)).collection.reason).toMatchObject({ status: 'awaiting_clarification', clarificationCount: 1 });
  expect((await mutate(page, `/api/calls/${call.id}/mock-turn`, { text: 'I still do not know.' })).status()).toBe(200);
  await expect.poll(async () => (await snapshot(page, call.id)).waitingReason).toBe('unresolved_answer');

  const waiting = await snapshot(page, call.id);
  expect(waiting).toMatchObject({ queueState: 'WAITING', conversationOwner: 'NONE', humanRequested: true, intakeState: 'INTERRUPTED' });
  expect(waiting.collection.reason).toMatchObject({ status: 'unresolved', clarificationCount: 1 });
  expect(waiting.escalations).toHaveLength(1);
  expect((await mutate(page, `/api/calls/${call.id}/consent`, { accepted: true })).status()).toBe(409);
  await expect(page.getByRole('status').filter({ hasText: /^WAITING FOR A NURSE$/ })).toBeVisible();
  await expect(page.getByText(/Nurse follow-up remains for: reason for calling/)).toBeVisible();

  await page.goto(`${baseURL}/nurse`);
  await expect(page.getByText('Unresolved answer').first()).toBeVisible();
  await expect(page.getByText(/Follow up on: Reason for calling/)).toBeVisible();
});

test('completed collection ends automation and keeps the caller waiting within the original deadline', async ({ page }) => {
  await workspace(page);
  await page.goto(`${baseURL}/caller`);
  const call = await join(page);
  expect((await mutate(page, `/api/calls/${call.id}/consent`, { accepted: true })).status()).toBe(200);
  const responses = [
    ['reason', 'I am calling about a headache.'],
    ['onset', 'It started yesterday.'],
    ['location', 'It is mostly behind my eyes.'],
    ['severity', 'I would describe it as a dull ache.'],
    ['symptoms', 'No other symptoms.'],
    ['medications', 'I do not take medication.'],
    ['uncertainties', 'I have not measured my temperature.'],
    ['callback', 'My fictional callback is 555-0100.'],
  ] as const;
  for (const [field, text] of responses) {
    expect((await mutate(page, `/api/calls/${call.id}/mock-turn`, { text })).status()).toBe(200);
    await expect.poll(async () => (await snapshot(page, call.id)).collection[field].status).toBe('answered');
  }
  await expect.poll(async () => (await snapshot(page, call.id)).waitingReason).toBe('intake_complete');
  const waiting = await snapshot(page, call.id);
  expect(waiting).toMatchObject({ intakeState: 'CAPTURED', conversationOwner: 'NONE', queueState: 'WAITING', humanRequested: false, callDeadlineAt: call.callDeadlineAt });
  expect(Object.values(waiting.collection).every(field => field.status === 'answered')).toBe(true);
  expect(['idle', 'ended']).toContain(waiting.providerSession.status);
  await expect(page.getByRole('status').filter({ hasText: /^WAITING FOR A NURSE$/ })).toBeVisible();
  await expect(page.getByText(/automated intake is complete/i)).toBeVisible();
  await expect(page.getByText(/Overall demo time remaining/)).toBeVisible();

  let sessionReadInterrupted = false;
  await page.route('**/api/demo/session', async route => {
    if (route.request().method() === 'GET' && !sessionReadInterrupted) {
      sessionReadInterrupted = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic temporary session-read failure' }) });
      return;
    }
    await route.continue();
  });
  await page.goto(`${baseURL}/nurse`);
  await expect(page.getByText('Intake complete').first()).toBeVisible();
  await expect(page.getByText(/caller remains available for nurse takeover/i)).toBeVisible();
  expect(sessionReadInterrupted).toBe(true);
});

test('declining automated intake preserves queue arrival and isolates another workspace', async ({ browser }) => {
  const adminContext = await browser.newContext();
  const callerContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const caller = await callerContext.newPage();
  const outsider = await outsiderContext.newPage();
  try {
    await workspace(admin);
    const invitation = await invite(admin, caller);
    const call = await join(caller);
    await caller.getByRole('button', { name: 'Skip automated intake · request a person' }).click();
    await expect.poll(async () => (await snapshot(caller, call.id)).intakeState).toBe('DECLINED');
    const declined = await snapshot(caller, call.id);
    expect(declined.createdAt).toBe(call.createdAt);
    expect(declined.consent).toBe(false);
    expect(declined.queueState).toBe('WAITING');
    expect(declined.humanRequested).toBe(true);
    expect(declined.waitingReason).toBe('consent_refused');
    expect(declined.escalations).toHaveLength(1);
    expect(declined.turns).toHaveLength(0);

    await workspace(outsider);
    const other = await outsider.request.get(`${baseURL}/api/calls`);
    expect((await other.json()).calls).toHaveLength(0);
    expect((await outsider.request.get(`${baseURL}/api/calls/${call.id}`)).status()).toBe(404);
    expect((await mutate(outsider, `/api/calls/${call.id}/claim`, { expectedRevision: declined.controlRevision })).status()).toBe(404);
    expect((await caller.request.get(`${baseURL}/api/settings`)).status()).toBe(403);
    expect((await mutate(caller, `/api/calls/${call.id}/connection-ticket`, { role: 'nurse' })).status()).toBe(403);
    expect((await admin.request.post(`${baseURL}/api/calls/${call.id}/end`, { headers: { Origin: 'https://wrong-origin.invalid' }, data: { commandId: crypto.randomUUID() } })).status()).toBe(403);
    const replay = await mutate(outsider, '/api/demo/session', { invitation: new URLSearchParams(new URL(invitation).hash.slice(1)).get('invite') });
    expect(replay.status()).toBe(410);
    const privateResponse = await admin.request.get(`${baseURL}/api/calls/${call.id}`);
    expect(privateResponse.headers()['cache-control']).toBe('private, no-store');
    await caller.goto(`${baseURL}/nurse`);
    await expect(caller.getByRole('heading', { name: 'This invitation is for a caller.' })).toBeVisible();
  } finally { await adminContext.close(); await callerContext.close(); await outsiderContext.close(); }
});
