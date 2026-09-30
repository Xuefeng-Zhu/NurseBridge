import { expect, test, type Page } from './helpers/fixtures';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const origin = new URL(baseURL).origin;

async function callerOnly(page: Page) {
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Nurse workspace|Settings|guide/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'NurseBridge', exact: true })).toHaveAttribute('href', '/caller');
}

test('nurse enrollment and invitations open an isolated, responsive caller journey', async ({ page, browser }, testInfo) => {
  const errors: string[] = [];
  let staffReady = false;
  let callerReady = false;
  const watchErrors = (target: Page, ready: () => boolean) => {
    target.on('pageerror', error => errors.push(error.message));
    target.on('console', message => {
      if (message.type() !== 'error') return;
      // Only the anonymous session lookup may fail before enrollment.
      if (!ready() && message.location().url === `${origin}/api/demo/session` && /^Failed to load resource: .*\b401\b/.test(message.text())) return;
      errors.push(message.text());
    });
  };
  watchErrors(page, () => staffReady);
  for (const path of ['/', '/workspace', '/demo']) {
    await page.goto(path);
    await expect(page).toHaveURL(`${origin}/nurse`);
    await expect(page.getByRole('heading', { name: 'Your care team workspace.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create local workspace' })).toBeEnabled();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link')).toHaveText(['Nurse workspace', 'Settings']);
    await expect(page.getByRole('link', { name: /guide|walkthrough/i })).toHaveCount(0);
  }
  await expect(page).toHaveTitle('NurseBridge · The intake workspace');
  await page.getByRole('button', { name: 'Create local workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
  staffReady = true;
  const adminResponse = await page.request.get('/api/demo/session');
  expect(adminResponse.ok()).toBe(true);
  const admin = await adminResponse.json() as { session: { workspaceId: string; role: string }; mode: string };
  expect(admin.session.role).toBe('admin');
  expect(admin.mode, 'The product journey uses only the isolated mock runtime').toBe('mock');
  for (const viewport of [{ width: 1440, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`nurse-workspace-${viewport.width}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('button', { name: 'Invite a caller', exact: true }).click();
  await page.getByRole('button', { name: 'Create caller invitation', exact: true }).click();
  const invitation = page.locator('.invitation-result a');
  await expect(invitation).toBeVisible();
  const invitationURL = (await invitation.getAttribute('href'))!;
  await page.getByRole('button', { name: 'Invite a caller', exact: true }).click();

  // This extra participant gets its own documentation address only in the
  // isolated loopback harness; hosted requests keep their real client identity.
  const extraHTTPHeaders = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)
    ? { 'CF-Connecting-IP': '192.0.2.20' } : undefined;
  const callerContext = await browser.newContext({ baseURL, extraHTTPHeaders, reducedMotion: 'reduce' });
  const caller = await callerContext.newPage();
  watchErrors(caller, () => callerReady);
  let callId: string | undefined;
  let callerSessionPosts = 0;
  caller.on('request', request => {
    if (request.url() === `${origin}/api/demo/session` && request.method() === 'POST') callerSessionPosts++;
  });
  try {
    await caller.goto('/caller');
    await expect(caller).toHaveTitle('Your call · NurseBridge');
    await expect(caller.getByRole('heading', { name: 'Open your call invitation.' })).toBeVisible();
    await expect(caller.getByRole('button', { name: /Create.*workspace/ })).toHaveCount(0);
    await callerOnly(caller);
    expect(callerSessionPosts).toBe(0);

    await caller.goto(invitationURL);
    await expect(caller.getByRole('button', { name: 'Join call queue' })).toBeEnabled();
    callerReady = true;
    expect(callerSessionPosts).toBe(1);
    expect(new URL(caller.url()).hash).toBe('');
    const sessionResponse = await caller.request.get('/api/demo/session');
    expect(sessionResponse.ok()).toBe(true);
    const { session } = await sessionResponse.json() as { session: { workspaceId: string; role: string } };
    expect(session).toMatchObject({ workspaceId: admin.session.workspaceId, role: 'caller' });
    await callerOnly(caller);
    expect((await caller.request.get('/api/settings')).status()).toBe(403);
    await caller.goto('/settings');
    await expect(caller.getByRole('heading', { name: 'This invitation is for a caller.' })).toBeVisible();
    await callerOnly(caller);
    await caller.getByRole('link', { name: 'Open your call', exact: true }).click();
    await expect(caller).toHaveTitle('Your call · NurseBridge');
    await expect(caller.getByRole('heading', { name: 'Your call.', exact: true })).toBeVisible();
    const [created] = await Promise.all([
      caller.waitForResponse(response => response.url() === `${origin}/api/calls` && response.request().method() === 'POST'),
      caller.getByRole('button', { name: 'Join call queue' }).click(),
    ]);
    expect(created.status()).toBe(201);
    const { call } = await created.json() as { call: { id: string; queueState: string } };
    callId = call.id;
    expect(call.queueState).toBe('WAITING');
    await expect(caller.getByText('IN THE CALL QUEUE', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Caller queue' }).getByRole('heading', { name: `Caller ${call.id.slice(-4).toUpperCase()}`, exact: true })).toBeVisible();
    for (const viewport of [{ width: 1440, height: 1050 }, { width: 390, height: 844 }]) {
      await caller.setViewportSize(viewport);
      await callerOnly(caller);
      expect(await caller.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await caller.screenshot({ path: testInfo.outputPath(`caller-journey-${viewport.width}.png`), fullPage: false });
    }
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Workspace administrator', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Intake template', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /guide|walkthrough/i })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    if (callId) expect((await page.request.post(`/api/calls/${callId}/end`, { headers: { Origin: origin }, data: { commandId: crypto.randomUUID() } })).ok()).toBe(true);
    await callerContext.close();
  }
});

test('closed enrollment directs visitors to an administrator and offers no public bootstrap', async ({ page }) => {
  let attemptedBootstrap = false;
  page.on('request', request => {
    if (request.url().endsWith('/api/demo/session') && request.method() === 'POST') attemptedBootstrap = true;
  });
  await page.route('**/api/demo/config', route => route.fulfill({
    json: { turnstileSiteKey: null, enrollmentMode: 'closed' },
  }));
  await page.goto('/workspace');
  await expect(page).toHaveURL(/\/nurse$/);
  await expect(page.getByRole('heading', { name: 'Your care team workspace.' })).toBeVisible();
  await expect(page.getByText(/Access is managed by your workspace administrator/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Create.*workspace/ })).toHaveCount(0);
  await page.goto('/caller');
  await expect(page.getByRole('heading', { name: 'Open your call invitation.' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Create.*workspace/ })).toHaveCount(0);
  await callerOnly(page);
  expect(attemptedBootstrap).toBe(false);
});
