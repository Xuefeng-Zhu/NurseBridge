import { expect, test, type Page } from '@playwright/test';
import type { DemoSettings } from '../../packages/contracts/src/index';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const settingsURL = `${baseURL}/api/settings`;

async function openSettings(page: Page): Promise<DemoSettings> {
  const session = await page.request.post(`${baseURL}/api/demo/session`, { headers: { Origin: new URL(baseURL).origin }, data: {} });
  expect(session.status()).toBe(201);
  const response = await page.request.get(settingsURL);
  expect(response.status()).toBe(200);
  await page.goto(`${baseURL}/settings`);
  return await response.json() as DemoSettings;
}

test('settings load failures offer a retry and show a pending state until recovery', async ({ page }) => {
  let failing = true;
  let retryReads = 0;
  let finishRetry!: () => void;
  const pendingRetry = new Promise<void>(resolve => { finishRetry = resolve; });
  await page.route(settingsURL, async route => {
    if (failing) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary settings outage' }) });
      return;
    }
    retryReads++;
    await pendingRetry;
    await route.continue();
  });
  try {
    const initial = await openSettings(page);
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('Temporary settings outage');
    await expect(page.getByRole('button', { name: 'Retry loading settings' })).toBeVisible();
    failing = false;
    await page.getByRole('button', { name: 'Retry loading settings' }).click();
    await expect(page.getByText('Loading workspace settings…', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry loading settings' })).toHaveCount(0);
    await expect(page.getByLabel('Staff destination')).toHaveCount(0);
    finishRetry();
    await expect(page.getByLabel('Staff destination')).toHaveValue(initial.escalationDestination);
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    expect(retryReads).toBe(1);
  } finally {
    finishRetry();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('settings saves expose pending state, preserve independent drafts and recover from failure', async ({ page }) => {
  const initial = await openSettings(page);
  await page.getByRole('button', { name: 'Create next version' }).click();
  await expect(page.getByRole('button', { name: 'Publish next template version' })).toBeDisabled();
  await page.getByLabel('Template name', { exact: true }).fill('Unpublished settings recovery template');
  await page.getByLabel('Staff destination').fill('Fictional recovery destination');

  let finishSave!: () => void;
  const pendingSave = new Promise<void>(resolve => { finishSave = resolve; });
  await page.route(settingsURL, async route => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    expect(route.request().postDataJSON()).not.toHaveProperty('template');
    await pendingSave;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary save interruption' }) });
  });
  try {
    await page.getByRole('button', { name: 'Save destination', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saving destination…', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Template name', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('Staff destination')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Publish next template version' })).toBeDisabled();
    finishSave();
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('Temporary save interruption');
    await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Unpublished settings recovery template');
    await expect(page.getByLabel('Staff destination')).toHaveValue('Fictional recovery destination');
    await expect(page.getByRole('button', { name: 'Save destination', exact: true })).toBeEnabled();
    await page.unroute(settingsURL);
    await page.getByRole('button', { name: 'Save destination', exact: true }).click();
    await expect(page.getByText('Workspace settings saved.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Unpublished settings recovery template');
    const updated = await (await page.request.get(settingsURL)).json() as DemoSettings;
    expect(updated.template).toEqual(initial.template);
    expect(updated.escalationDestination).toBe('Fictional recovery destination');
  } finally {
    finishSave();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('discard confirmations preserve each settings draft until explicitly confirmed', async ({ page }) => {
  const initial = await openSettings(page);
  await page.getByRole('button', { name: 'Create next version' }).click();
  await page.getByLabel('Template name', { exact: true }).fill('Fictional template draft to preserve');
  await page.getByLabel('Staff destination').fill('Fictional destination draft to preserve');
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirm discarding changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Fictional template draft to preserve');
  await expect(page.getByRole('button', { name: 'Cancel editing', exact: true })).toBeFocused();

  await page.getByRole('button', { name: 'Discard destination edit', exact: true }).click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('Staff destination')).toHaveValue('Fictional destination draft to preserve');
  await expect(page.getByLabel('Staff destination')).toBeFocused();
  await page.getByRole('button', { name: 'Discard destination edit', exact: true }).click();
  await page.getByRole('button', { name: 'Discard destination changes', exact: true }).click();
  await expect(page.getByLabel('Staff destination')).toHaveValue(initial.escalationDestination);
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Fictional template draft to preserve');

  await page.getByLabel('Staff destination').fill('Another fictional destination draft');
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await page.getByRole('button', { name: 'Discard template changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create next version' })).toBeFocused();
  await expect(page.getByLabel('Staff destination')).toHaveValue('Another fictional destination draft');
  await page.getByRole('button', { name: 'Create next version' }).click();
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue(initial.template.name);
  await page.getByRole('button', { name: 'Discard destination edit', exact: true }).click();
  await page.getByRole('button', { name: 'Discard destination changes', exact: true }).click();
  await expect(page.getByText('You have unsaved changes. Save or publish them before leaving settings.')).toHaveCount(0);
  const persisted = await (await page.request.get(settingsURL)).json() as DemoSettings;
  expect(persisted).toEqual(initial);
});

test('dirty settings warn on in-app navigation and browser reload without losing drafts', async ({ page }) => {
  await openSettings(page);
  await page.getByLabel('Staff destination').fill('Fictional navigation draft');
  const navigationDialog = page.waitForEvent('dialog');
  const navigation = page.getByRole('link', { name: 'Workspace guide', exact: true }).click();
  const confirm = await navigationDialog;
  expect(confirm.type()).toBe('confirm');
  expect(confirm.message()).toBe('Leave settings and discard your unsaved changes?');
  await confirm.dismiss();
  await navigation;
  await expect(page).toHaveURL(`${baseURL}/settings`);
  await expect(page.getByLabel('Staff destination')).toHaveValue('Fictional navigation draft');

  const unloadDialog = page.waitForEvent('dialog');
  // Trigger a native reload without Playwright waiting for a navigation we intentionally cancel.
  await page.evaluate(() => { window.setTimeout(() => window.location.reload(), 0); });
  const unload = await unloadDialog;
  expect(unload.type()).toBe('beforeunload');
  await unload.dismiss();
  await expect(page.getByLabel('Staff destination')).toHaveValue('Fictional navigation draft');

  await page.getByRole('button', { name: 'Discard destination edit', exact: true }).click();
  await page.getByRole('button', { name: 'Discard destination changes', exact: true }).click();
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.accept(); });
  await page.getByRole('link', { name: 'Workspace guide', exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/workspace`);
  expect(dialogs).toEqual([]);
});
