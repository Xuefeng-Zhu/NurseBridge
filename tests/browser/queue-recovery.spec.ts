import { expect, test, type Page } from '@playwright/test';
import type { CallSnapshot } from '../../packages/contracts/src/index';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const origin = new URL(baseURL).origin;
const label = (call: CallSnapshot) => `Caller ${call.id.slice(-4).toUpperCase()}`;

async function post(page: Page, path: string) {
  return page.request.post(`${baseURL}${path}`, { headers: { Origin: origin }, data: { commandId: crypto.randomUUID() } });
}

async function workspace(page: Page) {
  expect((await post(page, '/api/demo/session')).status()).toBe(201);
  const response = await page.request.get(`${baseURL}/api/demo/session`);
  expect((await response.json()).mode, 'Queue regressions use fictional mock cases only').toBe('mock');
}

async function createCall(page: Page, closed = false): Promise<CallSnapshot> {
  const created = await post(page, '/api/calls');
  expect(created.status()).toBe(201);
  const { call } = await created.json() as { call: CallSnapshot };
  if (!closed) return call;
  expect((await post(page, `/api/calls/${call.id}/end`)).ok()).toBe(true);
  const response = await page.request.get(`${baseURL}/api/calls/${call.id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).snapshot as CallSnapshot;
}

function queueItem(page: Page, call: CallSnapshot) {
  return page.getByRole('region', { name: 'Caller queue' }).getByRole('button').filter({ has: page.getByRole('heading', { name: label(call), exact: true }) });
}

test('an initial queue failure is distinct from an empty queue and retry restores the empty state', async ({ page }) => {
  await workspace(page);
  let failing = true;
  await page.route(`${baseURL}/api/calls`, route => route.fulfill({ status: failing ? 500 : 200, json: failing ? { error: 'Synthetic queue outage' } : { calls: [] } }));
  await page.goto(`${baseURL}/nurse`);
  const queue = page.getByRole('region', { name: 'Caller queue' });
  await expect(queue.getByRole('heading', { name: 'Queue unavailable.' })).toBeVisible();
  await expect(page.locator('.workspace-status')).toContainText('Queue count unavailable');
  await expect(queue.getByText('Room for a conversation.', { exact: true })).toHaveCount(0);
  await expect(queue.getByRole('link', { name: 'Start the walkthrough' })).toHaveCount(0);
  failing = false;
  await queue.getByRole('button', { name: 'Retry queue', exact: true }).click();
  await expect(queue.getByRole('heading', { name: 'Room for a conversation.' })).toBeVisible();
  await expect(queue.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.workspace-status')).toContainText('0 callers in queue');
});

test('queue outage preserves cases and reports queue freshness despite new case snapshots', async ({ page }) => {
  await workspace(page);
  const call = await createCall(page);
  try {
    await page.goto(`${baseURL}/nurse`);
    await expect(queueItem(page, call)).toBeVisible();
    await expect(page.locator('.audio-state')).toContainText('Connection: connected');
    await page.route(`${baseURL}/api/calls`, route => route.fulfill({ status: 500, json: { error: 'Synthetic queue refresh outage' } }));
    const queue = page.getByRole('region', { name: 'Caller queue' });
    await expect(queue.getByText('Queue refresh interrupted.', { exact: true })).toBeVisible();
    expect((await post(page, `/api/calls/${call.id}/request-human`)).ok()).toBe(true);
    await expect(page.getByText('A person has been requested', { exact: true })).toBeVisible();
    await expect(page.locator('.workspace-status')).toContainText(/Queue checked (?:[3-9]|\d{2,})s ago/);
    await expect(page.locator('.workspace-status')).toContainText('1 caller in queue · last known');
    await expect(queueItem(page, call)).toBeVisible();
    await expect(queue.getByText('Room for a conversation.', { exact: true })).toHaveCount(0);
    await page.unroute(`${baseURL}/api/calls`);
    await queue.getByRole('button', { name: 'Retry queue', exact: true }).click();
    await expect(queue.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.workspace-status')).not.toContainText('Queue refresh delayed');
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    expect((await post(page, `/api/calls/${call.id}/end`)).ok()).toBe(true);
  }
});

test('case detail retry clears its error and a late previous-selection response cannot remove a case', async ({ page }) => {
  await workspace(page);
  const first = await createCall(page, true);
  const second = await createCall(page, true);
  let mode: 'fail' | 'recover' | 'hold' = 'fail';
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { received = resolve; });
  await page.route(`${baseURL}/api/calls`, route => route.fulfill({ json: { calls: [first, second] } }));
  await page.route(`${baseURL}/api/calls/${second.id}`, route => route.fulfill({ json: { snapshot: second } }));
  await page.route(`${baseURL}/api/calls/${first.id}`, async route => {
    if (mode === 'hold') {
      received();
      await held;
      await route.fulfill({ status: 410, json: { error: 'Old request must not delete the previous selection' } }).catch(() => undefined);
    } else if (mode === 'fail') await route.fulfill({ status: 500, json: { error: 'Synthetic case read outage' } });
    else await route.fulfill({ json: { snapshot: first } });
  });
  try {
    await page.goto(`${baseURL}/nurse`);
    await expect(page.getByText('Case details could not refresh.', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Intake details unavailable.' })).toBeVisible();
    mode = 'recover';
    await page.getByRole('button', { name: 'Retry case details', exact: true }).click();
    const draft = page.getByRole('region', { name: 'Selected intake draft' });
    await expect(draft.getByRole('heading', { name: label(first), exact: true })).toBeVisible();
    await expect(page.getByText('Case details could not refresh.', { exact: true })).toHaveCount(0);
    mode = 'hold';
    await requested;
    await queueItem(page, second).click();
    await expect(draft.getByRole('heading', { name: label(second), exact: true })).toBeVisible();
    release();
    await expect(queueItem(page, first)).toBeVisible();
    await expect(draft.getByRole('heading', { name: label(second), exact: true })).toBeVisible();
    await expect(page.getByText('Case details could not refresh.', { exact: true })).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});
