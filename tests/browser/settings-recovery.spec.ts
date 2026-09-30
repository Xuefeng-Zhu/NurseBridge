import { expect, test, type Page } from './helpers/fixtures';
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
  await page.getByRole('button', { name: 'Edit template' }).click();
  await expect(page.getByRole('button', { name: 'Save template' })).toBeDisabled();
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
    await expect(page.getByRole('button', { name: 'Save template' })).toBeDisabled();
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
  await page.getByRole('button', { name: 'Edit template' }).click();
  await page.getByLabel('Template name', { exact: true }).fill('Fictional template draft to preserve');
  await page.getByLabel('Staff destination').fill('Fictional destination draft to preserve');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirm discarding changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Fictional template draft to preserve');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();

  await page.getByRole('button', { name: 'Discard destination edit', exact: true }).click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('Staff destination')).toHaveValue('Fictional destination draft to preserve');
  await expect(page.getByLabel('Staff destination')).toBeFocused();
  await page.getByRole('button', { name: 'Discard destination edit', exact: true }).click();
  await page.getByRole('button', { name: 'Discard destination changes', exact: true }).click();
  await expect(page.getByLabel('Staff destination')).toHaveValue(initial.escalationDestination);
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Fictional template draft to preserve');

  await page.getByLabel('Staff destination').fill('Another fictional destination draft');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard template changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit template' })).toBeFocused();
  await expect(page.getByLabel('Staff destination')).toHaveValue('Another fictional destination draft');
  await page.getByRole('button', { name: 'Edit template' }).click();
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue(initial.template.name);
  await page.getByRole('button', { name: 'Discard destination edit', exact: true }).click();
  await page.getByRole('button', { name: 'Discard destination changes', exact: true }).click();
  await expect(page.getByText('You have unsaved changes. Save or publish them before leaving settings.')).toHaveCount(0);
  const persisted = await (await page.request.get(settingsURL)).json() as DemoSettings;
  expect(persisted).toEqual({ ...initial, capabilities: { ...initial.capabilities, checkedAt: persisted.capabilities.checkedAt } });
});

test('dirty settings warn on in-app navigation and browser reload without losing drafts', async ({ page }) => {
  await openSettings(page);
  await page.getByLabel('Staff destination').fill('Fictional navigation draft');
  const navigationDialog = page.waitForEvent('dialog');
  const navigation = page.getByRole('link', { name: 'Nurse workspace', exact: true }).click();
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
  await page.getByRole('link', { name: 'Nurse workspace', exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/nurse`);
  expect(dialogs).toEqual([]);
});

test('configuration persists, isolates drafts, and governs new calls and exports', async ({ page }) => {
  const initial = await openSettings(page);
  await expect(page).toHaveTitle(/NurseBridge/);
  const oldResponse = await page.request.post(`${baseURL}/api/calls`, { headers: { Origin: new URL(baseURL).origin }, data: { commandId: crypto.randomUUID() } });
  expect(oldResponse.status()).toBe(201);
  const old = (await oldResponse.json()).call;
  await page.getByRole('button', { name: 'Edit template' }).click();
  await page.getByLabel('Template name', { exact: true }).fill('Preserved template draft');
  await page.getByLabel('Staff destination').fill('West wing nurses');
  await page.getByLabel('Enable automated intake using server connections').uncheck();
  await page.getByLabel('Allow provider recording with caller consent').uncheck();
  await page.getByLabel('Accept inbound calls on assigned phone numbers').uncheck();
  await page.getByLabel('Case retention', { exact: true }).selectOption('30');
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(page.getByText('Configuration saved for new calls. Active calls keep their original settings.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Preserved template draft');
  await expect(page.getByLabel('Staff destination')).toHaveValue('West wing nurses');
  await page.getByRole('button', { name: 'Save destination', exact: true }).click();
  await expect(page.getByText('Workspace settings saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(page.getByText(`Template version ${initial.template.version + 1} published for new calls. Active calls retain their original template.`, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Case retention', { exact: true })).toHaveValue('30');
  await expect(page.getByLabel('Enable automated intake using server connections')).not.toBeChecked();
  await expect(page.getByLabel('Staff destination')).toHaveValue('West wing nurses');
  const headers = { Origin: new URL(baseURL).origin };
  const created = await page.request.post(`${baseURL}/api/calls`, { headers, data: { commandId: crypto.randomUUID() } });
  expect(created.status()).toBe(201);
  const call = (await created.json()).call;
  expect(call.workspacePreferences).toMatchObject({ automatedIntake: false, recordingAllowed: false, phoneEnabled: false, retentionDays: 30, escalationDestination: 'West wing nurses' });
  expect(call.expiresAt - call.createdAt).toBe(30 * 86400000);
  expect(call.humanRequested).toBe(true);
  expect(call.template.name).toBe('Preserved template draft');
  const previous = (await (await page.request.get(`${baseURL}/api/calls/${old.id}`)).json()).snapshot;
  expect(previous.template.version).toBe(initial.template.version);
  expect(previous.expiresAt).toBe(old.expiresAt);
  expect(previous.workspacePreferences.automatedIntake).toBe(true);
  const consent = await page.request.post(`${baseURL}/api/calls/${call.id}/consent`, { headers, data: { commandId: crypto.randomUUID(), accepted: true } });
  expect(consent.status()).toBe(409);
  const exported = await page.request.post(`${baseURL}/api/calls/${call.id}/export`, { headers, data: { format: 'json' } });
  expect(exported.status()).toBe(201);
  expect((await exported.json()).expiresAt).toBe(call.expiresAt);
  const saved = await (await page.request.get(settingsURL)).json();
  expect(saved.workspaceExpiresAt).toBeGreaterThanOrEqual(call.expiresAt);
});

test('stale configuration saves preserve drafts and recover after explicit refresh', async ({ page }) => {
  const initial = await openSettings(page);
  await page.getByLabel('Case retention', { exact: true }).selectOption('14');
  const update = await page.request.patch(settingsURL, { headers: { Origin: new URL(baseURL).origin }, data: { expectedRevision: initial.revision, escalationDestination: 'Concurrent destination' } });
  expect(update.status()).toBe(200);
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Settings changed in another session');
  await expect(page.getByLabel('Case retention', { exact: true })).toHaveValue('14');
  await page.getByRole('button', { name: 'Refresh settings & status' }).click();
  await expect(page.getByText('Settings refreshed. Unsaved drafts were preserved; review them before saving.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Staff destination')).toHaveValue('Concurrent destination');
  await expect(page.getByLabel('Case retention', { exact: true })).toHaveValue('14');
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(page.getByText('Configuration saved for new calls. Active calls keep their original settings.', { exact: true })).toBeVisible();
  const saved = await (await page.request.get(settingsURL)).json();
  expect(saved.preferences).toMatchObject({ retentionDays: 14, escalationDestination: 'Concurrent destination' });
  for (const retentionDays of [0, 31, 1.5]) expect((await page.request.patch(settingsURL, { headers: { Origin: new URL(baseURL).origin }, data: { retentionDays } })).status()).toBe(400);
});

test('settings mutations enforce membership and arbitrate concurrent template saves', async ({ page, browser, extraHTTPHeaders }) => {
  const initial = await openSettings(page);
  const headers = { Origin: new URL(baseURL).origin };
  const responses = await Promise.all(['First concurrent template', 'Second concurrent template'].map(name => page.request.patch(settingsURL, { headers, data: { expectedRevision: initial.revision, template: { ...initial.template, name } } })));
  expect(responses.map(response => response.status()).sort()).toEqual([200, 409]);
  const saved = await (await page.request.get(settingsURL)).json();
  expect(saved.template.version).toBe(initial.template.version + 1);
  expect(saved.revision).toBe(initial.revision + 1);
  const nurseContext = await browser.newContext({ extraHTTPHeaders });
  const callerContext = await browser.newContext({ extraHTTPHeaders });
  const strangerContext = await browser.newContext({ extraHTTPHeaders });
  try {
    for (const [role, context] of [['nurse', nurseContext], ['caller', callerContext]] as const) {
      const invite = await page.request.post(`${baseURL}/api/demo/invitations`, { headers, data: { role } });
      expect(invite.status()).toBe(201);
      const token = new URLSearchParams(new URL((await invite.json()).url).hash.slice(1)).get('invite');
      expect((await context.request.post(`${baseURL}/api/demo/session`, { headers, data: { invitation: token } })).status()).toBe(201);
      expect((await context.request.patch(settingsURL, { headers, data: { retentionDays: 30, template: { ...initial.template, name: 'Unauthorized template edit' } } })).status()).toBe(403);
    }
    const nursePage = await nurseContext.newPage();
    await nursePage.goto(`${baseURL}/settings`);
    await expect(nursePage.getByLabel('Case retention', { exact: true })).toBeDisabled();
    await expect(nursePage.getByRole('button', { name: 'Save configuration', exact: true })).toHaveCount(0);
    expect((await callerContext.request.get(settingsURL)).status()).toBe(403);
    expect((await strangerContext.request.post(`${baseURL}/api/demo/session`, { headers, data: {} })).status()).toBe(201);
    expect((await strangerContext.request.patch(settingsURL, { headers, data: { escalationDestination: 'Another workspace' } })).status()).toBe(200);
    expect((await (await page.request.get(settingsURL)).json()).escalationDestination).toBe(initial.escalationDestination);
  } finally {
    await nurseContext.close(); await callerContext.close(); await strangerContext.close();
  }
});
