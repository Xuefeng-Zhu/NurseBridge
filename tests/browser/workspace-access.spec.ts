import { expect, test } from '@playwright/test';

test('workspace guide supports local enrollment and responsive staff navigation', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    // An absent session is an expected 401 before sandbox enrollment.
    if (message.type() === 'error' && !message.text().includes('401')) errors.push(message.text());
  });
  await page.goto('/demo');
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page).toHaveTitle('NurseBridge · The intake workspace');
  await expect(page.getByRole('heading', { name: /The caller’s story/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create local workspace' })).toBeEnabled();
  for (const viewport of [{ width: 1440, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`workspace-${viewport.width}.png`), fullPage: false });
  }
  await page.getByRole('button', { name: 'Create local workspace' }).click();
  await expect(page.getByText('Your isolated workspace is ready')).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Workspace administrator', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Intake template', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
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
  await expect(page.getByText(/Workspace access is managed by your administrator/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Create.*workspace/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Nurse workspace', exact: true }).click();
  await expect(page.getByText(/Access is managed by your workspace administrator/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Create.*workspace/ })).toHaveCount(0);
  expect(attemptedBootstrap).toBe(false);
});
