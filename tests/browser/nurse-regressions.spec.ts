import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { CallSnapshot } from '../../packages/contracts/src/index';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const origin = new URL(baseURL).origin;
const label = (id: string) => `Caller ${id.slice(-4).toUpperCase()}`;

async function post(page: Page, path: string, data: Record<string, unknown> = {}) {
  return page.request.post(`${baseURL}${path}`, { headers: { Origin: origin }, data: { commandId: crypto.randomUUID(), ...data } });
}

async function snapshot(page: Page, id: string): Promise<CallSnapshot> {
  const response = await page.request.get(`${baseURL}/api/calls/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).snapshot as CallSnapshot;
}

async function workspace(page: Page) {
  await page.goto(`${baseURL}/demo`);
  await page.getByRole('button', { name: 'Create your private demo workspace' }).click();
  await expect(page.getByText('Your isolated workspace is ready')).toBeVisible();
  const session = await (await page.request.get(`${baseURL}/api/demo/session`)).json() as { mode: string; diagnostics: boolean };
  expect(session.mode, 'These regressions use fictional mock data only').toBe('mock');
  return session;
}

function queueItem(page: Page, id: string) {
  return page.getByRole('region', { name: 'Caller queue' }).getByRole('button').filter({ has: page.getByRole('heading', { name: label(id), exact: true }) });
}

async function audioBrowser(frequency: 440 | 660): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(`tests/fixtures/microphone-${frequency}hz.wav`)}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ baseURL, permissions: ['microphone'], viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  return { browser, context, page: await context.newPage() };
}

async function frequency(page: Page) {
  return page.evaluate(() => {
    const value = (window as unknown as { __nursebridgeDiagnostics?: Record<string, unknown> }).__nursebridgeDiagnostics ?? {};
    const audio = value.audio && typeof value.audio === 'object' ? value.audio as Record<string, unknown> : value;
    return Number(audio.dominantFrequency ?? 0);
  });
}

test('switching fact editors preserves the target field and context tabs support keyboard navigation', async ({ page }, testInfo) => {
  await workspace(page);
  await page.getByRole('checkbox').check();
  const created = page.waitForResponse(response => response.url().endsWith('/api/calls') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Launch fictional replay case' }).click();
  const { call } = await (await created).json() as { call: CallSnapshot };
  await expect(page.getByRole('button', { name: 'Replay case created' })).toBeVisible();
  await expect.poll(async () => (await snapshot(page, call.id)).facts.length).toBeGreaterThan(3);
  await page.goto(`${baseURL}/nurse`);
  const before = await snapshot(page, call.id);
  const onset = before.facts.find(fact => fact.field === 'onset')!;
  const reason = before.facts.find(fact => fact.field === 'reason')!;
  expect(onset.value).not.toBe(reason.value);
  const row = (name: string) => page.locator('.fact-row').filter({ has: page.getByText(name, { exact: true }) });
  await row('Reason for calling').getByRole('button', { name: 'Edit with evidence' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Reason for calling', exact: true })).toBeVisible();
  await page.getByLabel('Current draft wording').fill('unsaved fictional reason edit');
  await row('Onset & duration').getByRole('button', { name: 'Edit with evidence' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Onset & duration', exact: true })).toBeVisible();
  await expect(page.getByLabel('Current draft wording')).toHaveValue(onset.value);
  await expect(page.getByLabel('Exact supporting quote')).toHaveValue(onset.evidence[0]!.quote);
  await page.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByLabel('Current draft wording')).toBeHidden();
  const after = await snapshot(page, call.id);
  expect(after.facts.find(fact => fact.field === 'onset')?.value).toBe(onset.value);
  expect(after.facts.find(fact => fact.field === 'reason')?.value).toBe(reason.value);

  const transcript = page.getByRole('tab', { name: 'Transcript', exact: true });
  const revisions = page.getByRole('tab', { name: 'Revisions', exact: true });
  const timeline = page.getByRole('tab', { name: 'Timeline', exact: true });
  await transcript.focus();
  await page.keyboard.press('ArrowRight');
  await expect(revisions).toBeFocused();
  await expect(revisions).toHaveAttribute('aria-selected', 'true');
  await expect(revisions).toHaveAttribute('tabindex', '0');
  await expect(transcript).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('End');
  await expect(timeline).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(transcript).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(timeline).toBeFocused();
  await page.keyboard.press('Home');
  await expect(transcript).toBeFocused();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-transcript');
  await page.screenshot({ path: testInfo.outputPath('nurse-edit-and-keyboard.png'), fullPage: true });
  expect((await post(page, `/api/calls/${call.id}/end`)).ok()).toBe(true);
});

test('reviewing another case during claim and conversation preserves active audio and call-scoped controls', async ({}, testInfo) => {
  const nurse = await audioBrowser(660);
  const caller = await audioBrowser(440);
  const pageErrors: string[] = [];
  let releaseClaim: (() => void) | undefined;
  for (const participant of [nurse, caller]) participant.page.on('pageerror', error => pageErrors.push(error.message));
  try {
    const session = await workspace(nurse.page);
    expect(session.diagnostics).toBe(true);
    await nurse.page.getByRole('button', { name: 'Create caller invitation' }).click();
    const invitation = nurse.page.locator('.invitation-result a');
    await expect(invitation).toBeVisible();
    await caller.page.goto((await invitation.getAttribute('href'))!);
    await expect(caller.page.getByRole('button', { name: 'Join demonstration queue' })).toBeEnabled();
    const callCreated = caller.page.waitForResponse(response => response.url().endsWith('/api/calls') && response.request().method() === 'POST');
    await caller.page.getByRole('button', { name: 'Join demonstration queue' }).click();
    const { call } = await (await callCreated).json() as { call: CallSnapshot };
    await caller.page.getByRole('button', { name: 'Skip automated intake · request a person' }).click();
    await caller.page.getByRole('button', { name: 'Enable microphone & output for handoff' }).click();
    await expect.poll(async () => (await snapshot(caller.page, call.id)).mediaReady.caller).toBe(true);
    const anotherResponse = await post(nurse.page, '/api/calls');
    expect(anotherResponse.status()).toBe(201);
    const { call: another } = await anotherResponse.json() as { call: CallSnapshot };
    await nurse.page.goto(`${baseURL}/nurse`);
    await queueItem(nurse.page, call.id).click();
    await expect(nurse.page.getByRole('button', { name: 'Take over call', exact: true })).toBeEnabled();

    let claimReceived: (() => void) | undefined;
    const pendingClaim = new Promise<void>(resolve => { claimReceived = resolve; });
    const heldClaim = new Promise<void>(resolve => { releaseClaim = resolve; });
    await nurse.page.route(`**/api/calls/${call.id}/claim`, async route => {
      const response = await route.fetch();
      claimReceived?.();
      await heldClaim;
      await route.fulfill({ response });
    });
    await nurse.page.getByRole('button', { name: 'Take over call', exact: true }).click();
    await pendingClaim;
    await queueItem(nurse.page, another.id).click();
    const draft = nurse.page.getByRole('region', { name: 'Selected intake draft' });
    await expect(draft.getByRole('heading', { name: label(another.id), exact: true })).toBeVisible();
    const controls = nurse.page.getByRole('region', { name: 'Active call controls' });
    await expect(controls).toContainText(label(call.id));
    releaseClaim();
    await expect.poll(async () => (await snapshot(nurse.page, call.id)).queueState, { timeout: 20_000 }).toBe('CONNECTED');
    await expect(controls).toContainText('Human audio connected');
    await expect(draft.getByRole('button', { name: 'Active call in progress', exact: true })).toBeDisabled();
    await expect.poll(async () => Math.abs(await frequency(caller.page) - 660), { timeout: 15_000 }).toBeLessThan(12);
    await expect.poll(async () => Math.abs(await frequency(nurse.page) - 440), { timeout: 15_000 }).toBeLessThan(12);
    // More than one polling cycle: active snapshots must not replace the selected case.
    await nurse.page.waitForTimeout(3000);
    await expect(draft.getByRole('heading', { name: label(another.id), exact: true })).toBeVisible();
    expect((await snapshot(nurse.page, call.id)).conversationOwner).toBe('NURSE');

    await controls.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await expect(controls.getByRole('button', { name: 'Unmute microphone', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await controls.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    await expect.poll(async () => Math.abs(await frequency(caller.page) - 660)).toBeLessThan(12);
    await controls.getByRole('button', { name: 'Return to active call', exact: true }).click();
    await expect(draft.getByRole('heading', { name: label(call.id), exact: true })).toBeVisible();
    await queueItem(nurse.page, another.id).click();
    await expect(draft.getByRole('heading', { name: label(another.id), exact: true })).toBeVisible();
    await nurse.page.screenshot({ path: testInfo.outputPath('active-call-while-reviewing-another-case.png'), fullPage: true });
    await nurse.page.setViewportSize({ width: 390, height: 844 });
    await expect(draft).toBeVisible();
    await expect(nurse.page.getByRole('region', { name: 'Caller queue' })).toBeHidden();
    await controls.scrollIntoViewIfNeeded();
    await expect(controls).toBeInViewport();
    expect(await nurse.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await nurse.page.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect(nurse.page.getByRole('region', { name: 'Caller queue' })).toBeVisible();
    await expect(draft).toBeHidden();
    await controls.scrollIntoViewIfNeeded();
    await expect(controls).toBeInViewport();
    await expect(controls.getByRole('button', { name: 'End call', exact: true })).toBeVisible();
    await nurse.page.getByRole('button', { name: 'Intake draft', exact: true }).click();
    await expect(draft.getByRole('heading', { name: label(another.id), exact: true })).toBeVisible();
    await controls.scrollIntoViewIfNeeded();
    await expect(controls).toBeInViewport();
    await expect.poll(async () => Math.abs(await frequency(caller.page) - 660)).toBeLessThan(12);
    await expect.poll(async () => Math.abs(await frequency(nurse.page) - 440)).toBeLessThan(12);
    expect((await snapshot(nurse.page, call.id)).conversationOwner).toBe('NURSE');
    expect(await nurse.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await nurse.page.screenshot({ path: testInfo.outputPath('active-call-while-reviewing-another-case-mobile.png'), fullPage: false });
    await controls.getByRole('button', { name: 'End call', exact: true }).click();
    await expect.poll(async () => (await snapshot(nurse.page, call.id)).queueState).toBe('CLOSED');
    await expect(controls).toBeHidden();
    await expect(draft.getByRole('heading', { name: label(another.id), exact: true })).toBeVisible();
    expect((await snapshot(nurse.page, another.id)).queueState).toBe('WAITING');
    await expect(draft.getByRole('button', { name: 'Take over call', exact: true })).toBeEnabled();
    expect(pageErrors).toEqual([]);
    expect((await post(nurse.page, `/api/calls/${another.id}/end`)).ok()).toBe(true);
  } finally {
    releaseClaim?.();
    for (const participant of [caller, nurse]) {
      await participant.context.close();
      await participant.browser.close();
    }
  }
});
