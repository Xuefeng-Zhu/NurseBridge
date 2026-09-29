import { expect, test, type Page } from '@playwright/test';
import type { CallSnapshot, DemoSettings } from '../../packages/contracts/src/index';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const origin = new URL(baseURL).origin;

async function workspace(page: Page, route = '/caller') {
  const response = await page.request.post(`${baseURL}/api/demo/session`, { headers: { Origin: origin }, data: {} });
  expect(response.status()).toBe(201);
  await page.goto(`${baseURL}${route}`);
}

async function join(page: Page): Promise<CallSnapshot> {
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/calls' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Join call queue' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  return (await response.json()).call as CallSnapshot;
}

async function calls(page: Page): Promise<CallSnapshot[]> {
  const response = await page.request.get(`${baseURL}/api/calls`);
  expect(response.status()).toBe(200);
  return (await response.json()).calls as CallSnapshot[];
}

async function end(page: Page, id: string) {
  const response = await page.request.post(`${baseURL}/api/calls/${id}/end`, { headers: { Origin: origin }, data: { commandId: crypto.randomUUID() } });
  expect(response.status()).toBe(200);
}

async function remove(page: Page, id: string) {
  const response = await page.request.delete(`${baseURL}/api/calls/${id}`, { headers: { Origin: origin }, data: { commandId: crypto.randomUUID() } });
  expect(response.status()).toBe(200);
}

async function settings(page: Page): Promise<DemoSettings> {
  const response = await page.request.get(`${baseURL}/api/settings`);
  expect(response.status()).toBe(200);
  return await response.json() as DemoSettings;
}

test('caller restoration retries failed list and detail reads without creating another call', async ({ page }) => {
  await workspace(page);
  const original = await join(page);
  try {
    await page.getByRole('button', { name: 'Skip automated intake · request a person' }).click();
    await expect(page.getByText('Automated intake was declined. Your place is preserved while you wait for a nurse.')).toBeVisible();
    await expect.poll(async () => (await calls(page)).some(call => call.id === original.id)).toBe(true);
    let newCalls = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/calls' && request.method() === 'POST') newCalls++; });
    for (const path of ['/api/calls', `/api/calls/${original.id}`]) {
      await page.route(`${baseURL}${path}`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary recovery-test interruption' }) }));
      await page.reload();
      await expect(page.getByRole('button', { name: 'Retry restoring call' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Join call queue' })).toBeDisabled();
      await expect(page.getByText('Your place in the queue is preserved.', { exact: true })).toHaveCount(0);
      await page.unroute(`${baseURL}${path}`);
      await page.getByRole('button', { name: 'Retry restoring call' }).click();
      await expect(page.getByText('Automated intake was declined. Your place is preserved while you wait for a nurse.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Join call queue' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Retry restoring call' })).toHaveCount(0);
      const restored = await calls(page);
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({ id: original.id, createdAt: original.createdAt, humanRequested: true });
      expect(newCalls).toBe(0);
    }
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await end(page, original.id);
  }
});

test('caller closes terminal calls from polling and deletion events and removes recovery controls', async ({ page }) => {
  await workspace(page);
  const owned = new Set<string>();
  try {
    const closed = await join(page); owned.add(closed.id);
    await expect(page.locator('.audio-state').getByText('connected', { exact: true })).toBeVisible();
    // Stop WebSocket delivery so this transition must come from the HTTP poll.
    await page.evaluate(() => (window as unknown as { __nursebridge: { close(): void } }).__nursebridge.close());
    await end(page, closed.id); owned.delete(closed.id);
    await expect(page.getByRole('heading', { name: 'Your call has ended.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconnect audio' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Leave queue & end call' })).toHaveCount(0);
    await expect(page.getByText('Your place in the queue is preserved.', { exact: true })).toHaveCount(0);

    for (const via of ['poll', 'socket'] as const) {
      await page.getByRole('button', { name: 'Start another call' }).click();
      const deleted = await join(page); owned.add(deleted.id);
      await expect(page.locator('.audio-state').getByText('connected', { exact: true })).toBeVisible();
      if (via === 'poll') {
        await page.evaluate(() => (window as unknown as { __nursebridge: { close(): void } }).__nursebridge.close());
      } else {
        // Keep HTTP reads unavailable to prove the realtime deletion event clears the UI.
        await page.route(`${baseURL}/api/calls/${deleted.id}`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Realtime-only deletion check' }) }));
      }
      await remove(page, deleted.id); owned.delete(deleted.id);
      await expect(page.getByRole('heading', { name: 'Your call was deleted.' })).toBeVisible();
      await expect(page.getByText('This case was deleted and is no longer in the queue.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Reconnect audio' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Leave queue & end call' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Join call queue' })).toHaveCount(0);
      await expect(page.getByText('Your place in the queue is preserved.', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Transcript replay' })).toHaveCount(0);
      await page.unroute(`${baseURL}/api/calls/${deleted.id}`);
      await expect.poll(async () => (await calls(page)).some(call => call.id === deleted.id)).toBe(false);
      if (via === 'poll') {
        await page.goto(`${baseURL}/caller?call=${deleted.id}`);
        await expect(page.getByRole('heading', { name: 'Your call was deleted.' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Join call queue' })).toHaveCount(0);
      }
    }
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const id of owned) await end(page, id);
  }
});

test('settings cancel discards template changes and each save preserves the other draft', async ({ page }) => {
  await workspace(page, '/settings');
  const initial = await settings(page);
  await page.getByRole('button', { name: 'Create next version' }).click();
  await page.getByLabel('Template name', { exact: true }).fill('Unpublished fictional template');
  await page.getByLabel('Approved opening question').fill('What fictional information would you like to share?');
  await page.getByLabel('Staff destination').fill('Synthetic recovery QA queue');
  await page.getByRole('button', { name: 'Save destination', exact: true }).click();
  await expect(page.getByText('Workspace settings saved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel editing' })).toBeVisible();
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Unpublished fictional template');
  await expect(page.getByLabel('Approved opening question')).toHaveValue('What fictional information would you like to share?');
  expect((await settings(page)).template).toEqual(initial.template);

  await page.getByRole('button', { name: 'Cancel editing' }).click();
  await page.getByRole('button', { name: 'Create next version' }).click();
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue(initial.template.name);
  await expect(page.getByLabel('Approved opening question')).toHaveValue(initial.template.opening);
  await page.getByLabel('Template name', { exact: true }).fill('Published fictional recovery template');
  await page.getByLabel('Staff destination').fill('Unsaved fictional destination');
  // An independent update after this screen loaded must survive template publication.
  const externalUpdate = await page.request.patch(`${baseURL}/api/settings`, { headers: { Origin: origin }, data: { escalationDestination: 'Externally updated fictional queue' } });
  expect(externalUpdate.status()).toBe(200);
  const publishRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/settings' && request.method() === 'PATCH');
  await page.getByRole('button', { name: 'Publish next template version' }).click();
  expect((await publishRequest).postDataJSON()).not.toHaveProperty('escalationDestination');
  await expect(page.getByText(`Template version ${initial.template.version + 1} published for new calls. Active calls retain their original template.`)).toBeVisible();
  const published = await settings(page);
  expect(published.template.name).toBe('Published fictional recovery template');
  expect(published.escalationDestination).toBe('Externally updated fictional queue');
  await expect(page.getByLabel('Staff destination')).toHaveValue('Unsaved fictional destination');
  await expect(page.getByRole('button', { name: 'Save destination', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save destination', exact: true }).click();
  await expect(page.getByText('Workspace settings saved.')).toBeVisible();
  const saved = await settings(page);
  expect(saved.escalationDestination).toBe('Unsaved fictional destination');
  expect(saved.template).toEqual(published.template);
});
