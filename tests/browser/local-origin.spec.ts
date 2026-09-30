import { expect, test, type Page } from './helpers/fixtures';
import type { CallSnapshot, DemoSettings, Session } from '../../packages/contracts/src';

const configuredURL = new URL(process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787');
const loopback = configuredURL.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(configuredURL.hostname);
const canonicalURL = new URL(configuredURL.origin);
canonicalURL.hostname = 'localhost';
const origin = canonicalURL.origin;
const aliasURL = new URL(origin);
aliasURL.hostname = '127.0.0.1';
const aliasOrigin = aliasURL.origin;
const headers = { Origin: origin };

test.skip(!loopback, 'Origin alias regressions run only against an HTTP loopback runtime.');

function observeBrowser(page: Page) {
  const errors: string[] = [];
  const aliasMutations: string[] = [];
  let anonymous = true;
  let enrollmentPosts = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const source = message.location().url;
    if (anonymous && [origin, aliasOrigin].some(value => source === `${value}/api/demo/session`) && /^Failed to load resource: .*\b401\b/.test(message.text())) return;
    errors.push(message.text());
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === aliasOrigin && !['GET', 'HEAD'].includes(request.method())) aliasMutations.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/api/demo/session' && request.method() === 'POST') enrollmentPosts++;
  });
  return {
    ready() { anonymous = false; },
    get enrollmentPosts() { return enrollmentPosts; },
    verify() {
      expect(aliasMutations, 'Session and app mutations must run only after returning to the configured origin').toEqual([]);
      expect(errors, 'Unexpected errors while using a loopback alias').toEqual([]);
    },
  };
}

async function readSession(page: Page): Promise<Session> {
  const response = await page.request.get(`${origin}/api/demo/session`);
  expect(response.status()).toBe(200);
  return (await response.json()).session as Session;
}

async function readSettings(page: Page): Promise<DemoSettings> {
  const response = await page.request.get(`${origin}/api/settings`);
  expect(response.status()).toBe(200);
  return await response.json() as DemoSettings;
}

test('an alias redirects before enrollment and settings writes, preserving the canonical staff session', async ({ page }) => {
  const observed = observeBrowser(page);
  await page.goto(`${aliasOrigin}/settings?source=origin-regression`);
  await expect(page).toHaveURL(`${origin}/settings?source=origin-regression`);
  await expect(page.getByRole('heading', { name: 'Your care team workspace.', exact: true })).toBeVisible();
  const sessionCreated = page.waitForResponse(response => response.url() === `${origin}/api/demo/session` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create local workspace', exact: true }).click();
  expect((await sessionCreated).status()).toBe(201);
  await expect(page.getByRole('heading', { name: 'Intake template', exact: true })).toBeVisible();
  observed.ready();
  const session = await readSession(page);
  expect(session.role).toBe('admin');
  const original = await readSettings(page);
  const destination = `Fictional local origin check ${crypto.randomUUID().slice(0, 8)}`;
  let settingsChanged = false;
  try {
    await page.getByLabel('Staff destination', { exact: true }).fill(destination);
    const settingsSaved = page.waitForResponse(response => response.url() === `${origin}/api/settings` && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Save destination', exact: true }).click();
    expect((await settingsSaved).status()).toBe(200);
    settingsChanged = true;
    await expect(page.getByText('Workspace settings saved.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Staff destination', { exact: true })).toHaveValue(destination);
    expect((await readSettings(page)).escalationDestination).toBe(destination);

    await page.goto(`${aliasOrigin}/nurse`);
    await expect(page).toHaveURL(`${origin}/nurse`);
    await expect(page.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create local workspace', exact: true })).toHaveCount(0);
    expect(await readSession(page)).toEqual(session);
    await page.goto(`${aliasOrigin}/settings`);
    await expect(page).toHaveURL(`${origin}/settings`);
    await expect(page.getByLabel('Staff destination', { exact: true })).toHaveValue(destination);
    expect(await readSession(page)).toEqual(session);
    expect(observed.enrollmentPosts, 'Alias navigation must reuse the canonical session').toBe(1);
    observed.verify();
  } finally {
    if (settingsChanged) {
      const current = await readSettings(page);
      const restored = await page.request.patch(`${origin}/api/settings`, { headers, data: { expectedRevision: current.revision, escalationDestination: original.escalationDestination } });
      expect(restored.status()).toBe(200);
    }
  }
});

test('an invitation on an alias keeps its fragment through canonicalization and redeems once', async ({ page, browser, extraHTTPHeaders }) => {
  const staffObserved = observeBrowser(page);
  const adminCreated = await page.request.post(`${origin}/api/demo/session`, { headers, data: {} });
  expect(adminCreated.status()).toBe(201);
  await page.goto(`${origin}/nurse`);
  await expect(page.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
  staffObserved.ready();
  const admin = await readSession(page);
  const invited = await page.request.post(`${origin}/api/demo/invitations`, { headers, data: { role: 'caller' } });
  expect(invited.status()).toBe(201);
  const invitationURL = new URL((await invited.json()).url);
  const invitation = new URLSearchParams(invitationURL.hash.slice(1)).get('invite');
  expect(invitation).not.toBeNull();
  invitationURL.hostname = '127.0.0.1';
  invitationURL.search = '?source=origin-regression';
  const callerContext = await browser.newContext({ baseURL: origin, extraHTTPHeaders });
  const caller = await callerContext.newPage();
  const callerObserved = observeBrowser(caller);
  let callId: string | undefined;
  try {
    await caller.goto(invitationURL.href);
    await expect(caller).toHaveURL(`${origin}/caller?source=origin-regression`);
    await expect(caller.getByRole('button', { name: 'Join call queue', exact: true })).toBeEnabled();
    callerObserved.ready();
    expect(callerObserved.enrollmentPosts).toBe(1);
    const session = await readSession(caller);
    expect(session).toMatchObject({ workspaceId: admin.workspaceId, role: 'caller' });
    expect(session.participantId).not.toBe(admin.participantId);
    const repeated = await caller.request.post(`${origin}/api/demo/session`, { headers, data: { invitation } });
    expect(repeated.status()).toBe(410);
    expect(await readSession(caller)).toEqual(session);

    const joined = caller.waitForResponse(response => response.url() === `${origin}/api/calls` && response.request().method() === 'POST');
    await caller.getByRole('button', { name: 'Join call queue', exact: true }).click();
    const created = await joined;
    expect(created.status()).toBe(201);
    const call = (await created.json()).call as CallSnapshot;
    callId = call.id;
    expect(call).toMatchObject({ workspaceId: admin.workspaceId, callerParticipantId: session.participantId, queueState: 'WAITING' });
    await expect(page.getByRole('region', { name: 'Caller queue' }).getByRole('heading', { name: `Caller ${call.id.slice(-4).toUpperCase()}`, exact: true })).toBeVisible();
    await expect(caller.getByText('IN THE CALL QUEUE', { exact: true })).toBeVisible();
    await caller.goto(`${aliasOrigin}/caller?call=${call.id}`);
    await expect(caller).toHaveURL(`${origin}/caller?call=${call.id}`);
    await expect(caller.getByText('IN THE CALL QUEUE', { exact: true })).toBeVisible();
    expect(await readSession(caller)).toEqual(session);
    expect(callerObserved.enrollmentPosts).toBe(1);
    callerObserved.verify();
    staffObserved.verify();
  } finally {
    await callerContext.close();
    if (callId) {
      // Leave the nurse subscription before removing this test-owned call.
      await page.goto(`${origin}/settings`);
      const removed = await page.request.delete(`${origin}/api/calls/${callId}`, { headers, data: { commandId: crypto.randomUUID() } });
      expect([200, 410]).toContain(removed.status());
    }
  }
});
