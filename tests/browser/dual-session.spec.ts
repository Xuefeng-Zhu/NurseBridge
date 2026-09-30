import { expect, test, type Page } from './helpers/fixtures';
import type { CallSnapshot, DemoSettings, Session } from '../../packages/contracts/src';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const origin = new URL(baseURL).origin;
const local = new URL(baseURL).protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname);
const staffHeaders = { Origin: origin, 'X-NurseBridge-View': 'staff' };
const queue = (page: Page) => page.getByRole('region', { name: 'Caller queue' });
const label = (call: Pick<CallSnapshot, 'id'>) => `Caller ${call.id.slice(-4).toUpperCase()}`;

test.skip(!local, 'Dual-session enrollment and caller-only recovery require the isolated HTTP loopback sandbox.');

function observeBrowser(page: Page) {
  const errors: string[] = [];
  let anonymous = true;
  let invitationRedemptions = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (anonymous && message.location().url === `${origin}/api/demo/session` && /^Failed to load resource: .*\b401\b/.test(message.text())) return;
    errors.push(message.text());
  });
  page.on('request', request => {
    if (request.url() === `${origin}/api/demo/session` && request.method() === 'POST' && request.postDataJSON()?.invitation) invitationRedemptions++;
  });
  return {
    ready() { anonymous = false; },
    get invitationRedemptions() { return invitationRedemptions; },
    verify() { expect(errors, 'Unexpected browser errors while switching staff and caller views').toEqual([]); },
  };
}

async function readSession(page: Page, view: 'staff' | 'caller'): Promise<Session> {
  const response = await page.request.get(`${origin}/api/demo/session`, { headers: { 'X-NurseBridge-View': view } });
  expect(response.status()).toBe(200);
  return (await response.json()).session as Session;
}

async function readSettings(page: Page): Promise<DemoSettings> {
  const response = await page.request.get(`${origin}/api/settings`, { headers: staffHeaders });
  expect(response.status()).toBe(200);
  return await response.json() as DemoSettings;
}

async function createStaff(page: Page) {
  await page.goto(`${origin}/nurse`);
  await page.getByRole('button', { name: 'Create local workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
  return readSession(page, 'staff');
}

async function callerInvitation(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Invite a caller', exact: true }).click();
  await page.getByRole('button', { name: 'Create caller invitation', exact: true }).click();
  const link = page.locator('.invitation-result a');
  await expect(link).toBeVisible();
  return (await link.getAttribute('href'))!;
}

async function expectNoRoleWall(page: Page) {
  await expect(page.getByRole('heading', { name: 'This invitation is for a caller.', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your care team workspace.', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Open your call invitation.', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create local workspace', exact: true })).toHaveCount(0);
}

test('staff and caller tabs retain distinct real sessions while settings and the queue stay usable', async ({ page, context }) => {
  const staffObserved = observeBrowser(page);
  const staff = await createStaff(page);
  staffObserved.ready();
  const originalSettings = await readSettings(page);
  const invitationURL = await callerInvitation(page);
  const caller = await context.newPage();
  const callerObserved = observeBrowser(caller);
  let callId: string | undefined;
  let settingsChanged = false;
  try {
    await caller.goto(invitationURL);
    await expect(caller.getByRole('button', { name: 'Join call queue', exact: true })).toBeEnabled();
    callerObserved.ready();
    await expectNoRoleWall(caller);
    const participant = await readSession(caller, 'caller');
    expect(participant).toMatchObject({ workspaceId: staff.workspaceId, role: 'caller' });
    expect(participant.participantId).not.toBe(staff.participantId);
    expect(await readSession(page, 'staff')).toEqual(staff);
    expect(callerObserved.invitationRedemptions).toBe(1);
    for (const name of ['nb_staff_session', 'nb_caller_session']) {
      expect((await context.cookies()).find(cookie => cookie.name === name)).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    }

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
    await expectNoRoleWall(page);
    expect(await readSession(page, 'staff')).toEqual(staff);
    const created = caller.waitForResponse(response => response.url() === `${origin}/api/calls` && response.request().method() === 'POST');
    await caller.getByRole('button', { name: 'Join call queue', exact: true }).click();
    const creation = await created;
    expect(creation.status()).toBe(201);
    const call = (await creation.json()).call as CallSnapshot;
    callId = call.id;
    expect(call).toMatchObject({ workspaceId: staff.workspaceId, callerParticipantId: participant.participantId });
    await expect(queue(page).getByRole('heading', { name: label(call), exact: true })).toBeVisible();
    await expect(caller.getByText('IN THE CALL QUEUE', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/settings`);
    await expect(page.getByRole('heading', { name: 'Intake template', exact: true })).toBeVisible();
    await expectNoRoleWall(page);
    const destination = `Fictional dual-view queue ${crypto.randomUUID().slice(0, 8)}`;
    await page.getByLabel('Staff destination', { exact: true }).fill(destination);
    const saved = page.waitForResponse(response => response.url() === `${origin}/api/settings` && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Save destination', exact: true }).click();
    expect((await saved).status()).toBe(200);
    settingsChanged = true;
    await page.reload();
    await expect(page.getByLabel('Staff destination', { exact: true })).toHaveValue(destination);
    await caller.reload();
    await expect(caller.getByText('IN THE CALL QUEUE', { exact: true })).toBeVisible();
    expect(await readSession(caller, 'caller')).toEqual(participant);
    expect(await readSession(page, 'staff')).toEqual(staff);
    await page.getByRole('link', { name: 'Nurse workspace', exact: true }).click();
    await expect(queue(page).getByRole('heading', { name: label(call), exact: true })).toBeVisible();
    callerObserved.verify();
    expect(callerObserved.invitationRedemptions).toBe(1);

    // Switch the original staff tab through both roles after proving the two
    // tabs work together. Closing the duplicate caller avoids two caller sockets.
    await caller.close();
    await page.goto(`${origin}/caller?call=${call.id}`);
    await expect(page.getByText('IN THE CALL QUEUE', { exact: true })).toBeVisible();
    await expectNoRoleWall(page);
    expect(await readSession(page, 'caller')).toEqual(participant);
    await page.goto(`${origin}/nurse`);
    await expect(queue(page).getByRole('heading', { name: label(call), exact: true })).toBeVisible();
    await expectNoRoleWall(page);
    expect(await readSession(page, 'staff')).toEqual(staff);
    staffObserved.verify();
  } finally {
    await caller.close();
    // Navigate away from active subscriptions before test-owned case cleanup.
    await page.goto(`${origin}/settings`);
    try {
      if (callId) {
        const removed = await page.request.delete(`${origin}/api/calls/${callId}`, { headers: staffHeaders, data: { commandId: crypto.randomUUID() } });
        expect([200, 410]).toContain(removed.status());
      }
    } finally {
      if (settingsChanged) {
        const current = await readSettings(page);
        const restored = await page.request.patch(`${origin}/api/settings`, { headers: staffHeaders, data: { expectedRevision: current.revision, escalationDestination: originalSettings.escalationDestination } });
        expect(restored.status()).toBe(200);
      }
    }
  }
});

test('a legacy caller-only local browser recovers staff access without losing its caller identity', async ({ page, browser, extraHTTPHeaders }) => {
  const staffObserved = observeBrowser(page);
  const sourceStaff = await createStaff(page);
  staffObserved.ready();
  const invitationURL = await callerInvitation(page);
  const invitation = new URLSearchParams(new URL(invitationURL).hash.slice(1)).get('invite');
  expect(invitation).not.toBeNull();
  const visitorContext = await browser.newContext({ baseURL, extraHTTPHeaders });
  const visitor = await visitorContext.newPage();
  const visitorObserved = observeBrowser(visitor);
  try {
    await visitor.goto(invitationURL);
    await expect(visitor.getByRole('button', { name: 'Join call queue', exact: true })).toBeEnabled();
    const caller = await readSession(visitor, 'caller');
    expect(caller).toMatchObject({ workspaceId: sourceStaff.workspaceId, role: 'caller' });
    expect(visitorObserved.invitationRedemptions).toBe(1);
    // Keep only the authentic server-issued legacy cookie to represent a
    // browser that opened a caller invitation before dual sessions existed.
    await visitorContext.clearCookies({ name: 'nb_staff_session' });
    await visitorContext.clearCookies({ name: 'nb_caller_session' });
    expect((await visitorContext.cookies()).some(cookie => cookie.name === 'nb_session')).toBe(true);
    expect((await visitorContext.cookies()).filter(cookie => ['nb_staff_session', 'nb_caller_session'].includes(cookie.name))).toHaveLength(0);

    await visitor.goto(`${origin}/nurse`);
    await expect(visitor.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
    visitorObserved.ready();
    await expectNoRoleWall(visitor);
    const recovered = await readSession(visitor, 'staff');
    expect(recovered).toMatchObject({ workspaceId: caller.workspaceId, role: 'admin' });
    expect(recovered.participantId).not.toBe(caller.participantId);
    expect(await readSession(visitor, 'caller')).toEqual(caller);
    await visitor.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(visitor.getByRole('heading', { name: 'Intake template', exact: true })).toBeVisible();
    await visitor.reload();
    await expect(visitor.getByRole('heading', { name: 'Intake template', exact: true })).toBeVisible();
    expect(await readSession(visitor, 'staff')).toEqual(recovered);
    await visitor.goto(`${origin}/caller`);
    await expect(visitor.getByRole('button', { name: 'Join call queue', exact: true })).toBeEnabled();
    await expectNoRoleWall(visitor);
    expect(await readSession(visitor, 'caller')).toEqual(caller);
    const duplicate = await visitor.request.post(`${origin}/api/demo/session`, { headers: { Origin: origin, 'X-NurseBridge-View': 'caller' }, data: { invitation } });
    expect(duplicate.status()).toBe(410);
    expect(await readSession(visitor, 'staff')).toEqual(recovered);
    expect(await readSession(visitor, 'caller')).toEqual(caller);
    expect(visitorObserved.invitationRedemptions).toBe(1);
    visitorObserved.verify();
    staffObserved.verify();
  } finally { await visitorContext.close(); }
});
