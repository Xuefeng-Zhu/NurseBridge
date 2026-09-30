import { expect, test } from './helpers/fixtures';

const origin = new URL(process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787').origin;

test('configuration retry preserves an invitation removed from the address bar', async ({ page }) => {
  const created = await page.request.post('/api/demo/session', { headers: { Origin: origin }, data: { commandId: crypto.randomUUID() } });
  expect(created.status()).toBe(201);
  const invitation = await page.request.post('/api/demo/invitations', { headers: { Origin: origin }, data: { commandId: crypto.randomUUID(), role: 'caller' } });
  expect(invitation.ok()).toBe(true);
  const { url } = await invitation.json();
  await page.goto('/caller');
  await expect(page.getByRole('button', { name: 'Join call queue' })).toBeEnabled();
  // A new invitation must replace the loaded session's UI even when its
  // configuration request fails during same-document navigation.
  let failConfiguration = true;
  let failRedeemedSessionLookup = true;
  let redemptionPosts = 0;
  page.on('request', request => {
    if (request.url() === `${origin}/api/demo/session` && request.method() === 'POST') redemptionPosts++;
  });
  await page.route('**/api/demo/config', route => failConfiguration
    ? route.fulfill({ status: 503, json: { error: 'Configuration temporarily unavailable.' } })
    : route.continue());
  await page.route('**/api/demo/session', route => failRedeemedSessionLookup && route.request().method() === 'GET'
    ? route.fulfill({ status: 503, json: { error: 'Session refresh temporarily unavailable.' } })
    : route.continue());
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Your call couldn’t open.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join call queue' })).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('');
  expect(redemptionPosts).toBe(0);
  failConfiguration = false;
  await page.getByRole('button', { name: 'Retry opening call' }).click();
  // The session cookie has changed, but its new identity is not readable yet.
  // Keep the previous admin session out of the UI and never consume the link twice.
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Session refresh temporarily unavailable.');
  await expect(page.getByRole('heading', { name: 'Your call couldn’t open.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join call queue' })).toHaveCount(0);
  expect(redemptionPosts).toBe(1);
  failRedeemedSessionLookup = false;
  await page.getByRole('button', { name: 'Retry opening call' }).click();
  await expect(page.getByRole('button', { name: 'Join call queue' })).toBeEnabled();
  const session = await page.request.get('/api/demo/session');
  expect((await session.json()).session.role).toBe('caller');
  expect(redemptionPosts).toBe(1);
  const missing = await page.goto('/missing-caller-page');
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open nurse workspace' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Return to your call' }).click();
  await expect(page).toHaveURL(/\/caller$/);
  await expect(page).toHaveTitle('Your call · NurseBridge');
  await expect(page.getByRole('button', { name: 'Join call queue' })).toBeEnabled();
});

test('nurse workspace can recover a failed session lookup', async ({ page }) => {
  let unavailable = true;
  await page.route('**/api/demo/session', route => unavailable && route.request().method() === 'GET'
    ? route.fulfill({ status: 503, json: { error: 'Workspace service temporarily unavailable.' } })
    : route.continue());
  await page.goto('/workspace');
  await expect(page).toHaveURL(/\/nurse$/);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Workspace service temporarily unavailable.');
  unavailable = false;
  await page.getByRole('button', { name: 'Retry opening workspace' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create local workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
});

test('a missing caller link offers a fresh call instead of a permanent retry loop', async ({ page }) => {
  await page.goto('/workspace');
  await page.getByRole('button', { name: 'Create local workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
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
  await page.getByRole('link', { name: 'Open nurse workspace' }).click();
  await expect(page).toHaveURL(/\/nurse$/);
  await expect(page.getByRole('heading', { name: 'Your care team workspace.' })).toBeVisible();
  await page.getByRole('link', { name: 'Skip to main content' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  expect(errors).toEqual([]);
});
