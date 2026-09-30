import { expect, test, type Page } from './helpers/fixtures';
import type { DemoSettings, IntakeTemplate } from '../../packages/contracts/src';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const origin = new URL(baseURL).origin;
const settingsURL = `${origin}/api/settings`;
const headers = { Origin: origin };
async function openEditor(page: Page): Promise<DemoSettings> {
  const session = await page.request.post(`${origin}/api/demo/session`, { headers, data: {} });
  expect(session.status()).toBe(201);
  const settings = await (await page.request.get(settingsURL)).json() as DemoSettings;
  await page.goto(`${origin}/settings`);
  await expect(page).toHaveTitle('NurseBridge · The intake workspace');
  await page.getByRole('button', { name: 'Edit template', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Edit intake template' })).toBeVisible();
  return settings;
}
const templateSaved = (version: number) => `Template version ${version} published for new calls. Active calls retain their original template.`;

test('template wording and question structure save, reload and apply only to new calls', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const initial = await openEditor(page);
  const oldResponse = await page.request.post(`${origin}/api/calls`, { headers, data: { commandId: crypto.randomUUID() } });
  expect(oldResponse.status()).toBe(201);
  const oldCall = (await oldResponse.json()).call;
  await expect(page.getByRole('button', { name: 'Save template', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add question', exact: true })).toBeDisabled();
  await page.getByLabel('Template name', { exact: true }).fill('Focused nurse intake');
  await page.getByLabel('Approved opening question', { exact: true }).fill('I am the automated intake assistant. Welcome to our sample call.');
  await page.getByRole('button', { name: 'Remove Callback number question', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Onset question', exact: true }).click();
  await page.getByLabel('Question to add', { exact: true }).selectOption('onset');
  await page.getByRole('button', { name: 'Add question', exact: true }).click();
  await page.getByLabel('Onset', { exact: true }).fill('When did you first notice this?');
  for (let step = 0; step < 5; step++) await page.getByRole('button', { name: 'Move Onset up', exact: true }).click();
  const moveUp = page.getByRole('button', { name: 'Move Onset up', exact: true });
  await moveUp.focus(); await page.keyboard.press('Enter');
  await expect(moveUp).toBeDisabled();
  await page.getByLabel('Acknowledgment 1', { exact: true }).fill('Your answer has been captured.');
  await page.getByRole('button', { name: 'Remove acknowledgment 3', exact: true }).click();
  await page.getByRole('button', { name: 'Remove acknowledgment 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove acknowledgment 1', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Add acknowledgment', exact: true }).click();
  await page.getByLabel('Acknowledgment 2', { exact: true }).fill('Your sample intake is ready for nurse review.');
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(page.getByText(templateSaved(initial.template.version + 1), { exact: true })).toBeVisible();
  const saved = await (await page.request.get(settingsURL)).json() as DemoSettings;
  expect(saved.template.questions.map(question => question.field)).toEqual(['onset', 'reason', 'location', 'severity', 'symptoms', 'medications', 'uncertainties']);
  expect(saved.template.acknowledgments).toEqual(['Your answer has been captured.', 'Your sample intake is ready for nurse review.']);
  expect(saved.template.questions[0]?.text).toBe('When did you first notice this?');
  await page.reload();
  await page.getByRole('button', { name: 'Edit template', exact: true }).click();
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Focused nurse intake');
  await expect(page.getByLabel('Onset', { exact: true })).toHaveValue('When did you first notice this?');
  await expect(page.getByRole('group', { name: 'Callback number question', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Acknowledgment 2', { exact: true })).toHaveValue('Your sample intake is ready for nurse review.');
  const created = await page.request.post(`${origin}/api/calls`, { headers, data: { commandId: crypto.randomUUID() } });
  expect(created.status()).toBe(201);
  expect((await created.json()).call.template).toEqual(saved.template);
  const oldSnapshot = (await (await page.request.get(`${origin}/api/calls/${oldCall.id}`)).json()).snapshot;
  expect(oldSnapshot.template).toEqual(initial.template);
  for (const viewport of [{ width: 1440, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('form', { name: 'Edit intake template' }).evaluate(element => element.scrollIntoView({ block: 'start' }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`template-editor-${viewport.width}.png`), fullPage: false });
  }
  expect(errors).toEqual([]);
});

test('template structural drafts survive failed saves and conflicts, and cancel restores the saved version', async ({ page }) => {
  const initial = await openEditor(page);
  await page.getByRole('button', { name: 'Remove Callback number question', exact: true }).click();
  await page.getByRole('button', { name: 'Move Onset up', exact: true }).click();
  await page.getByLabel('Acknowledgment 1', { exact: true }).fill('Unsaved acknowledgment');
  let finishSave!: () => void;
  const pending = new Promise<void>(resolve => { finishSave = resolve; });
  await page.route(settingsURL, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await pending;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary template save interruption' }) });
  });
  try {
    await page.getByRole('button', { name: 'Save template', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saving template…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Move Onset down', exact: true })).toBeDisabled();
    finishSave();
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('Temporary template save interruption');
    await expect(page.getByLabel('Acknowledgment 1', { exact: true })).toHaveValue('Unsaved acknowledgment');
  } finally { finishSave(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }
  expect((await page.request.patch(settingsURL, { headers, data: { expectedRevision: initial.revision, template: { ...initial.template, name: 'Another administrator version' } } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Settings changed in another session');
  await page.getByRole('button', { name: 'Refresh settings & status', exact: true }).click();
  await expect(page.getByText('Settings refreshed. Unsaved drafts were preserved; review them before saving.', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Callback number question', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('Acknowledgment 1', { exact: true })).toHaveValue('Unsaved acknowledgment');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard template changes', exact: true }).click();
  await page.getByRole('button', { name: 'Edit template', exact: true }).click();
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Another administrator version');
  await expect(page.getByLabel('Acknowledgment 1', { exact: true })).toHaveValue(initial.template.acknowledgments[0]!);
  await expect(page.getByRole('group', { name: 'Callback number question', exact: true })).toBeVisible();
});

test('template validation enforces supported unique questions and nonempty wording without writing a version', async ({ page }) => {
  const initial = await openEditor(page);
  const template = initial.template;
  const invalid: unknown[] = [
    { ...template, name: '   ' }, { ...template, opening: '   ' },
    { ...template, questions: [] }, { ...template, questions: Array.from({ length: 9 }, () => template.questions[0]) },
    { ...template, questions: [template.questions[0], template.questions[0]] },
    { ...template, questions: [{ ...template.questions[0], text: '   ' }] },
    { ...template, questions: [{ ...template.questions[0], id: 'onset', field: 'reason' }] },
    { ...template, questions: [{ id: 'custom', field: 'custom', text: 'Unsupported question' }] },
    { ...template, acknowledgments: [] }, { ...template, acknowledgments: ['   '] },
    { ...template, acknowledgments: Array.from({ length: 9 }, () => 'Thank you.') },
  ];
  for (const value of invalid) expect((await page.request.patch(settingsURL, { headers, data: { expectedRevision: initial.revision, template: value } })).status()).toBe(400);
  expect((await (await page.request.get(settingsURL)).json()).template).toEqual(template);
  const valid: IntakeTemplate = { ...template, name: '  Compact intake  ', questions: [template.questions[1]!], acknowledgments: ['  Thank you.  '] };
  const saved = await page.request.patch(settingsURL, { headers, data: { expectedRevision: initial.revision, template: valid } });
  expect(saved.status()).toBe(200);
  expect((await saved.json()).template).toMatchObject({ name: 'Compact intake', version: template.version + 1, acknowledgments: ['Thank you.'] });
  for (const label of ['Onset', 'Location', 'Severity', 'Other symptoms', 'Medication details', 'Uncertain or unmeasured details', 'Callback number']) await page.getByRole('button', { name: `Remove ${label} question`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Reason for calling question', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move Reason for calling up', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move Reason for calling down', exact: true })).toBeDisabled();
  await page.getByLabel('Template name', { exact: true }).fill('   ');
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(page.getByText('Enter a template name.', { exact: true })).toBeVisible();
});

test('custom completion acknowledgment is visible to the caller after the selected questions finish', async ({ page }) => {
  const initial = await openEditor(page);
  const template = { ...initial.template, questions: [initial.template.questions.find(question => question.field === 'callback')!], acknowledgments: ['Thanks for sharing your sample callback.'] };
  expect((await page.request.patch(settingsURL, { headers, data: { expectedRevision: initial.revision, template } })).status()).toBe(200);
  const created = await page.request.post(`${origin}/api/calls`, { headers, data: { commandId: crypto.randomUUID() } });
  expect(created.status()).toBe(201);
  const call = (await created.json()).call;
  expect(call.mode).toBe('mock');
  expect((await page.request.post(`${origin}/api/calls/${call.id}/consent`, { headers, data: { commandId: crypto.randomUUID(), accepted: true } })).status()).toBe(200);
  expect((await page.request.post(`${origin}/api/calls/${call.id}/mock-turn`, { headers, data: { commandId: crypto.randomUUID(), text: 'My sample callback number is 555-0111.' } })).status()).toBe(200);
  await expect.poll(async () => (await (await page.request.get(`${origin}/api/calls/${call.id}`)).json()).snapshot.waitingReason).toBe('intake_complete');
  await page.goto(`${origin}/caller`);
  await expect(page.getByText('Thanks for sharing your sample callback. Intake complete — waiting for a nurse.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Thanks for sharing your sample callback. Intake complete — waiting for a nurse.', { exact: true })).toBeVisible();
});
