import { readFile } from 'node:fs/promises';
import type { CallSnapshot } from '../../packages/contracts/src';
import { expect, test, type Page } from './helpers/fixtures';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const origin = new URL(baseURL).origin;
const staffHeaders = { Origin: origin, 'X-NurseBridge-View': 'staff' };

async function openCase(page: Page): Promise<CallSnapshot> {
  expect((await page.request.post(`${origin}/api/demo/session`, { headers: staffHeaders, data: {} })).status()).toBe(201);
  const created = await page.request.post(`${origin}/api/calls`, { headers: staffHeaders, data: { commandId: crypto.randomUUID() } });
  expect(created.status()).toBe(201);
  const { call } = await created.json();
  await page.goto(`${origin}/nurse`);
  await expect(page.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  return call;
}

async function removeCase(page: Page, id: string) {
  await page.goto('about:blank');
  const response = await page.request.delete(`${origin}/api/calls/${id}`, { headers: staffHeaders, data: { commandId: crypto.randomUUID() } });
  expect([200, 410]).toContain(response.status());
}

test('Export downloads directly with the staff session even after the browser redeems a caller invitation', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const call = await openCase(page);
  try {
    // A caller invitation replaces the legacy cookie. The direct download must
    // still select the held staff session rather than that caller identity.
    const invitation = await page.request.post(`${origin}/api/demo/invitations`, { headers: staffHeaders, data: { role: 'caller' } });
    expect(invitation.status()).toBe(201);
    const token = new URLSearchParams(new URL((await invitation.json()).url).hash.slice(1)).get('invite');
    expect(token).not.toBeNull();
    const redeemed = await page.request.post(`${origin}/api/demo/session`, { headers: { Origin: origin, 'X-NurseBridge-View': 'caller' }, data: { invitation: token } });
    expect(redeemed.status()).toBe(201);
    expect((await redeemed.json()).session).toMatchObject({ workspaceId: call.workspaceId, role: 'caller' });

    const requests: { method: string; path: string; view?: string }[] = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.includes('/export')) requests.push({ method: request.method(), path, view: request.headers()['x-nursebridge-view'] });
    });
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(`nursebridge-${call.id}.json`);
    expect(await download.failure()).toBeNull();
    expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toMatchObject({ id: call.id, workspaceId: call.workspaceId, mode: call.mode });
    await expect(page.getByText('Case download started. No export copy is stored on the server. Downloaded files must be managed on your device.', { exact: true })).toBeVisible();
    expect(requests).toEqual([{ method: 'POST', path: `/api/calls/${call.id}/export`, view: 'staff' }]);
    await expect(page).toHaveURL(`${origin}/nurse`);
    await expect(page).toHaveTitle(/NurseBridge/);
    await page.screenshot({ path: testInfo.outputPath('direct-case-download.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await removeCase(page, call.id);
  }
});

test('failed exports show an error without downloading and can be retried', async ({ page }) => {
  const call = await openCase(page);
  const exportRoute = `**/api/calls/${call.id}/export`;
  try {
    let downloads = 0, attempts = 0;
    page.on('download', () => downloads++);
    await page.route(exportRoute, async route => {
      attempts++;
      await route.fulfill({ status: 503, json: { error: 'Temporary export outage' } });
    });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Temporary export outage');
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
    expect(attempts).toBe(1);
    expect(downloads).toBe(0);
    await page.unroute(exportRoute);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    expect((await downloadEvent).suggestedFilename()).toBe(`nursebridge-${call.id}.json`);
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  } finally {
    await page.unroute(exportRoute);
    await removeCase(page, call.id);
  }
});
