import { expect, test } from '@playwright/test';

const origin = new URL(process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787').origin;

test('configuration retry preserves an invitation removed from the address bar', async ({ page, request }) => {
  const created = await request.post('/api/demo/session', { headers: { Origin: origin }, data: { commandId: crypto.randomUUID() } });
  expect(created.status()).toBe(201);
  const invitation = await request.post('/api/demo/invitations', { headers: { Origin: origin }, data: { commandId: crypto.randomUUID(), role: 'caller' } });
  expect(invitation.ok()).toBe(true);
  const { url } = await invitation.json();
  let failConfiguration = true;
  await page.route('**/api/demo/config', route => failConfiguration
    ? route.fulfill({ status: 503, json: { error: 'Configuration temporarily unavailable.' } })
    : route.continue());
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Workspace temporarily unavailable.' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  failConfiguration = false;
  await page.getByRole('button', { name: 'Retry opening workspace' }).click();
  await expect(page.getByRole('button', { name: 'Join call queue' })).toBeEnabled();
  const session = await page.request.get('/api/demo/session');
  expect((await session.json()).session.role).toBe('caller');
});

test('workspace guide can recover a failed session lookup', async ({ page }) => {
  let unavailable = true;
  await page.route('**/api/demo/session', route => unavailable && route.request().method() === 'GET'
    ? route.fulfill({ status: 503, json: { error: 'Workspace service temporarily unavailable.' } })
    : route.continue());
  await page.goto('/workspace');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Workspace service temporarily unavailable.');
  unavailable = false;
  await page.getByRole('button', { name: 'Retry opening workspace' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create local workspace' }).click();
  await expect(page.getByText('Your isolated workspace is ready')).toBeVisible();
});

test('a missing caller link offers a fresh call instead of a permanent retry loop', async ({ page }) => {
  await page.goto('/workspace');
  await page.getByRole('button', { name: 'Create local workspace' }).click();
  await expect(page.getByText('Your isolated workspace is ready')).toBeVisible();
  await page.goto(`/caller?call=${crypto.randomUUID()}`);
  await expect(page.getByRole('heading', { name: 'This call is unavailable.' })).toBeVisible();
  await page.getByRole('button', { name: 'Start another call' }).click();
  expect(new URL(page.url()).searchParams.has('call')).toBe(false);
  await page.getByRole('button', { name: 'Join call queue' }).click();
  await expect(page.getByText('IN THE CALL QUEUE', { exact: true })).toBeVisible();
});

test('missing pages give a responsive route home and the skip link focuses content', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.goto('/missing-nursebridge-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Let’s get you back.' })).toBeVisible();
  for (const viewport of [{ width: 1440, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`not-found-${viewport.width}.png`) });
  }
  await page.getByRole('link', { name: 'Open workspace guide' }).click();
  await expect(page.getByRole('heading', { name: /The caller’s story/ })).toBeVisible();
  await page.getByRole('link', { name: 'Skip to main content' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  expect(errors).toEqual([]);
});
