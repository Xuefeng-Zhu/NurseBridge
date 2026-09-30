import { expect, test, type Page, type WebSocketRoute } from './helpers/fixtures';
import type { CallSnapshot } from '../../packages/contracts/src';
import { applyFacts, newState } from '../../apps/realtime/src/state';

const baseURL = process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787';
const realtimeUrl = new URL(baseURL).origin.replace(/^http/, 'ws');
const participantId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const fixedNow = Date.parse('2026-09-29T16:30:00Z');
const label = (call: CallSnapshot) => `Caller ${call.id.slice(-4).toUpperCase()}`;
const queue = (page: Page) => page.getByRole('region', { name: 'Caller queue' });
const status = (page: Page) => queue(page).getByRole('combobox', { name: 'Status', exact: true });
const draft = (page: Page) => page.getByRole('region', { name: 'Selected intake draft' });
const queueItem = (page: Page, call: CallSnapshot) => queue(page).getByRole('button').filter({ has: page.getByRole('heading', { name: label(call), exact: true }) });

function call(index: number, state: CallSnapshot['queueState'] = 'WAITING', ageMinutes = 4) {
  return Object.assign(newState({
    callId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    workspaceId, callerParticipantId: `caller-${index}`, mode: 'mock', createdAt: fixedNow - ageMinutes * 60_000,
  }), { queueState: state, revision: 1 });
}

async function fixture(page: Page, calls: CallSnapshot[]) {
  const state = {
    calls, queueOverride: null as CallSnapshot[] | null, queueFailure: false,
    beforeQueue: null as Promise<void> | null, queueReads: 0, unexpected: [] as string[], errors: [] as string[],
  };
  const sockets = new Map<WebSocketRoute, string>();
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') state.errors.push(message.text()); });
  await page.clock.setFixedTime(new Date(fixedNow));
  // Only UI state is simulated here. Real microphone and bidirectional audio
  // continuity are covered by nurse-regressions and audio-lifecycle.
  await page.routeWebSocket('**/connect/**', socket => {
    const id = new URL(socket.url()).pathname.split('/').at(-1)!;
    sockets.set(socket, id);
    socket.onMessage(message => {
      if (typeof message !== 'string') { socket.send(JSON.stringify({ type: 'audio-ack', credits: 1 })); return; }
      const input = JSON.parse(message) as { type?: string };
      if (input.type === 'auth') socket.send(JSON.stringify({ type: 'authenticated', credits: 20, role: 'nurse', snapshot: state.calls.find(value => value.id === id) }));
      if (input.type === 'heartbeat') socket.send(JSON.stringify({ type: 'heartbeat' }));
    });
    socket.onClose(() => sockets.delete(socket));
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === '/api/demo/config') return route.fulfill({ json: { turnstileSiteKey: null, enrollmentMode: 'sandbox' } });
    if (path === '/api/demo/session' && method === 'GET') return route.fulfill({ json: {
      session: { workspaceId, participantId, role: 'admin', expiresAt: fixedNow + 3600000 }, mode: 'mock', realtimeUrl, diagnostics: true,
    } });
    if (path === '/api/calls' && method === 'GET') {
      if (state.beforeQueue) await state.beforeQueue;
      state.queueReads++;
      return route.fulfill({ status: state.queueFailure ? 503 : 200, json: state.queueFailure ? { error: 'Synthetic queue interruption' } : { calls: state.queueOverride ?? state.calls } });
    }
    const match = /^\/api\/calls\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    const current = match && state.calls.find(value => value.id === match[1]);
    if (current) {
      if (!match[2] && method === 'GET') return route.fulfill({ json: { snapshot: current } });
      if (match[2] === 'connection-ticket' && method === 'POST') return route.fulfill({ json: { ticket: 'intercepted-test-ticket', websocketPath: `/connect/${current.id}`, realtimeUrl } });
      if (!match[2] && method === 'DELETE') {
        state.calls = state.calls.filter(value => value.id !== current.id);
        return route.fulfill({ json: { ok: true } });
      }
    }
    state.unexpected.push(`${method} ${path}`);
    return route.abort('blockedbyclient');
  });
  return Object.assign(state, {
    publish(snapshot: CallSnapshot) {
      for (const [socket, id] of sockets) if (id === snapshot.id) socket.send(JSON.stringify({ type: 'snapshot', snapshot }));
    },
  });
}

test('mixed states have accurate counts, distinct badges, arrival order and session timing', async ({ page }, testInfo) => {
  const closed = call(1, 'CLOSED', 5);
  closed.claim = { participantId, expiresAt: fixedNow - 1000 };
  const waiting = call(2);
  waiting.humanRequested = true;
  waiting.waitingReason = 'human_request';
  const assigned = call(3, 'CLAIMED', 3);
  assigned.claim = { participantId: 'another-nurse', expiresAt: fixedNow - 1000 };
  const connecting = call(4, 'CLAIMED', 2);
  connecting.conversationOwner = 'HANDOFF_PENDING';
  const connected = call(5, 'CONNECTED', 1);
  connected.conversationOwner = 'NURSE';
  const data = await fixture(page, [closed, waiting, assigned, connecting, connected]);
  await page.goto(`${baseURL}/nurse`);
  await expect(page.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
  await expect(queue(page).getByRole('heading', { name: 'Calls', exact: true })).toBeVisible();
  await expect(status(page)).toHaveValue('all');
  await expect(status(page).locator('option')).toHaveText(['All calls (5)', 'Waiting (1)', 'In progress (3)', 'Closed (1)']);
  await expect(queue(page).getByRole('heading', { level: 3 })).toHaveText([closed, waiting, assigned, connecting, connected].map(label));
  await expect(page.locator('.workspace-status')).toContainText('1 waiting · 3 in progress · 1 closed');
  await expect(draft(page).getByRole('heading', { name: label(waiting), exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Active call controls' })).toHaveCount(0);
  for (const [entry, badge] of [[closed, 'Closed'], [waiting, 'Waiting'], [assigned, 'Assigned'], [connecting, 'Connecting'], [connected, 'Human connected']] as const) {
    await expect(queueItem(page, entry).getByText(badge, { exact: true })).toBeVisible();
  }
  await expect(queueItem(page, waiting)).toContainText('Person requested');
  await expect(queueItem(page, waiting)).toContainText('Arrived 4m ago');
  await expect(queueItem(page, waiting)).toContainText('Session ends in 6:00');
  await expect(draft(page)).toContainText('Session ends in 6:00');
  await expect(queueItem(page, closed)).toContainText(/Arrived .+2026/);
  await expect(queueItem(page, closed)).not.toContainText('Session ends in');
  await expect(queueItem(page, closed)).not.toContainText('ago');
  await status(page).selectOption('in-progress');
  await expect(queue(page).getByRole('heading', { level: 3 })).toHaveText([assigned, connecting, connected].map(label));
  await status(page).selectOption('waiting');
  await expect(queue(page).getByRole('heading', { level: 3 })).toHaveText([label(waiting)]);
  await status(page).selectOption('closed');
  await queueItem(page, closed).click();
  await expect(draft(page).getByRole('heading', { name: label(closed), exact: true })).toBeVisible();
  await expect(draft(page)).not.toContainText('Session ends in');
  await page.screenshot({ path: testInfo.outputPath('closed-call-filter-desktop.png'), fullPage: true });
  expect(data.unexpected).toEqual([]);
  expect(data.errors).toEqual([]);
});

test('filtering preserves the selected editor and supports keyboard and mobile recovery', async ({ page }, testInfo) => {
  const waiting = call(1);
  const closed = call(2, 'CLOSED', 3);
  const words = 'Fictional caller reports a headache.';
  waiting.turns.push({ id: 'turn-1', sessionId: waiting.id, order: 0, text: words, final: true, at: waiting.createdAt });
  applyFacts(waiting, [{ field: 'reason', value: words, rawWording: words, status: 'reported', evidence: [{ turnId: 'turn-1', quote: words }] }], waiting.createdAt);
  const data = await fixture(page, [waiting, closed]);
  await page.goto(`${baseURL}/nurse`);
  await draft(page).getByRole('button', { name: 'Edit with evidence' }).click();
  await page.getByLabel('Current draft wording').fill('Unsaved fictional correction');
  await status(page).selectOption('closed');
  await expect(draft(page).getByRole('heading', { name: label(waiting), exact: true })).toBeVisible();
  await expect(page.getByLabel('Current draft wording')).toHaveValue('Unsaved fictional correction');
  await expect(page.getByText('This case is outside the current filter', { exact: true })).toBeVisible();
  await expect(queueItem(page, waiting)).toHaveCount(0);
  await page.getByRole('button', { name: 'Show in list', exact: true }).click();
  await expect(status(page)).toHaveValue('all');
  await expect(queueItem(page, waiting)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Current draft wording')).toHaveValue('Unsaved fictional correction');
  await status(page).focus();
  // Native select typeahead works with macOS headless Chromium, whose popup
  // does not consume synthetic arrow events like its headed platform menu.
  await page.keyboard.press('w');
  await expect(status(page)).toHaveValue('waiting');
  await expect(status(page)).toBeFocused();
  await expect(queue(page).getByRole('heading', { level: 3 })).toHaveText([label(waiting)]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(status(page)).toBeVisible();
  await status(page).selectOption('closed');
  await expect(queueItem(page, closed)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('call-filter-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Intake draft', exact: true }).click();
  await expect(page.getByLabel('Current draft wording')).toHaveValue('Unsaved fictional correction');
  await page.getByRole('button', { name: 'Show in list', exact: true }).click();
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(status(page)).toHaveValue('all');
  await page.reload();
  await expect(status(page)).toHaveValue('all');
  expect(data.unexpected).toEqual([]);
  expect(data.errors).toEqual([]);
});

test('live transitions use merged revisions and an expired claim alone does not change grouping', async ({ page }) => {
  const waiting = call(1);
  const assigned = call(2, 'CLAIMED', 3);
  assigned.claim = { participantId: 'another-nurse', expiresAt: fixedNow + 1000 };
  const data = await fixture(page, [waiting, assigned]);
  await page.goto(`${baseURL}/nurse`);
  await expect(page.locator('.audio-state')).toContainText('Connection: connected');
  await status(page).selectOption('in-progress');
  await page.clock.setFixedTime(new Date(fixedNow + 5000));
  await expect(queueItem(page, assigned).getByText('Assigned', { exact: true })).toBeVisible();
  await expect(status(page).locator('option')).toHaveText(['All calls (2)', 'Waiting (1)', 'In progress (1)', 'Closed (0)']);
  const stale = structuredClone(data.calls);
  waiting.queueState = 'CLAIMED';
  waiting.conversationOwner = 'HANDOFF_PENDING';
  waiting.revision++;
  data.publish(waiting);
  await expect(queue(page).getByRole('heading', { level: 3 })).toHaveText([label(waiting), label(assigned)]);
  await expect(queueItem(page, waiting).getByText('Connecting', { exact: true })).toBeVisible();
  await expect(status(page)).toHaveValue('in-progress');
  await expect(draft(page).getByRole('heading', { name: label(waiting), exact: true })).toBeVisible();
  await expect(status(page).locator('option')).toHaveText(['All calls (2)', 'Waiting (0)', 'In progress (2)', 'Closed (0)']);
  data.queueOverride = stale;
  const previousReads = data.queueReads;
  await expect.poll(() => data.queueReads).toBeGreaterThan(previousReads);
  await expect(queueItem(page, waiting).getByText('Connecting', { exact: true })).toBeVisible();
  await expect(status(page).locator('option')).toHaveText(['All calls (2)', 'Waiting (0)', 'In progress (2)', 'Closed (0)']);
  waiting.queueState = 'CONNECTED'; waiting.conversationOwner = 'NURSE'; waiting.revision++;
  data.publish(waiting);
  await expect(queueItem(page, waiting).getByText('Human connected', { exact: true })).toBeVisible();
  waiting.queueState = 'CLOSED'; waiting.conversationOwner = 'NONE'; waiting.revision++;
  data.publish(waiting);
  await expect(queueItem(page, waiting)).toHaveCount(0);
  await expect(status(page).locator('option')).toHaveText(['All calls (2)', 'Waiting (0)', 'In progress (1)', 'Closed (1)']);
  await expect(draft(page).getByRole('heading', { name: label(waiting), exact: true })).toBeVisible();
  await expect(page.getByText('This case is outside the current filter', { exact: true })).toBeVisible();
  await expect(draft(page)).not.toContainText('Session ends in');
  assigned.queueState = 'WAITING'; assigned.revision++;
  delete assigned.claim;
  data.queueOverride = null;
  await expect(queueItem(page, assigned)).toHaveCount(0);
  await expect(status(page).locator('option')).toHaveText(['All calls (2)', 'Waiting (1)', 'In progress (0)', 'Closed (1)']);
  await expect(status(page)).toHaveValue('in-progress');
  await expect(queue(page).getByRole('heading', { name: 'No calls in progress.', exact: true })).toBeVisible();
  await expect(draft(page).getByRole('heading', { name: label(waiting), exact: true })).toBeVisible();
  expect(data.unexpected).toEqual([]);
  expect(data.errors).toEqual([]);
});

test('deletion and retention select the next matching case without resurrecting deleted rows', async ({ page }) => {
  const waiting = call(1, 'WAITING', 5);
  const firstClosed = call(2, 'CLOSED', 4);
  const nextClosed = call(3, 'CLOSED', 3);
  const data = await fixture(page, [waiting, firstClosed, nextClosed]);
  await page.goto(`${baseURL}/nurse`);
  await status(page).selectOption('closed');
  await queueItem(page, firstClosed).click();
  await expect(draft(page).getByRole('heading', { name: label(firstClosed), exact: true })).toBeVisible();
  data.queueOverride = structuredClone(data.calls);
  await draft(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await draft(page).getByRole('button', { name: 'Delete case', exact: true }).click();
  await expect(draft(page).getByRole('heading', { name: label(nextClosed), exact: true })).toBeVisible();
  await expect(status(page)).toHaveValue('closed');
  await expect(queueItem(page, firstClosed)).toHaveCount(0);
  await expect(status(page).locator('option')).toHaveText(['All calls (2)', 'Waiting (1)', 'In progress (0)', 'Closed (1)']);
  data.queueOverride = [waiting];
  const previousReads = data.queueReads;
  await expect.poll(() => data.queueReads).toBeGreaterThan(previousReads);
  await expect(queue(page).getByRole('heading', { name: 'No closed calls.', exact: true })).toBeVisible();
  await expect(draft(page).getByRole('heading', { name: 'The story starts with the caller.', exact: true })).toBeVisible();
  await status(page).selectOption('waiting');
  await expect(draft(page).getByRole('heading', { name: label(waiting), exact: true })).toBeVisible();
  expect(data.unexpected).toEqual([]);
  expect(data.errors).toEqual([]);
});

test('loading and refresh failure keep counts unavailable or last known without fake empty invitations', async ({ page }) => {
  const waiting = call(1);
  const data = await fixture(page, [waiting]);
  let release!: () => void;
  data.beforeQueue = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.goto(`${baseURL}/nurse`);
    await expect(page.locator('.workspace-status')).toContainText('Queue counts unavailable');
    await expect(status(page).locator('option')).toHaveText(['All calls (—)', 'Waiting (—)', 'In progress (—)', 'Closed (—)']);
    release();
    await expect(status(page).locator('option')).toHaveText(['All calls (1)', 'Waiting (1)', 'In progress (0)', 'Closed (0)']);
    await status(page).selectOption('in-progress');
    await expect(queue(page).getByRole('heading', { name: 'No calls in progress.', exact: true })).toBeVisible();
    await expect(queue(page).getByRole('button', { name: 'Create a caller invitation', exact: true })).toHaveCount(0);
    await status(page).selectOption('closed');
    await expect(queue(page).getByRole('heading', { name: 'No closed calls.', exact: true })).toBeVisible();
    data.queueFailure = true;
    await expect(queue(page).getByText('Queue refresh interrupted.', { exact: true })).toBeVisible();
    await expect(page.locator('.workspace-status')).toContainText('1 waiting · 0 in progress · 0 closed · last known');
    await expect(status(page).locator('option')).toHaveText(['All calls (1)', 'Waiting (1)', 'In progress (0)', 'Closed (0)']);
    await status(page).selectOption('waiting');
    await expect(queueItem(page, waiting)).toBeVisible();
    data.queueFailure = false;
    waiting.queueState = 'CLOSED'; waiting.revision++;
    await queue(page).getByRole('button', { name: 'Retry queue', exact: true }).click();
    await expect(queue(page).getByRole('alert')).toHaveCount(0);
    await expect(queue(page).getByRole('heading', { name: 'No callers waiting.', exact: true })).toBeVisible();
    await expect(status(page).locator('option')).toHaveText(['All calls (1)', 'Waiting (0)', 'In progress (0)', 'Closed (1)']);
    await expect(page.locator('.workspace-status')).not.toContainText('last known');
    expect(data.unexpected).toEqual([]);
    expect(data.errors.filter(error => !error.includes('503 (Service Unavailable)'))).toEqual([]);
  } finally { release(); }
});

test('a truly empty workspace offers invitations and selects only new cases matching its filter', async ({ page }) => {
  const data = await fixture(page, []);
  await page.goto(`${baseURL}/nurse`);
  await expect(status(page).locator('option')).toHaveText(['All calls (0)', 'Waiting (0)', 'In progress (0)', 'Closed (0)']);
  await status(page).selectOption('closed');
  await expect(queue(page).getByRole('heading', { name: 'No callers yet.', exact: true })).toBeVisible();
  await expect(queue(page).getByRole('button', { name: 'Create a caller invitation', exact: true })).toBeVisible();
  const waiting = call(1);
  data.calls.push(waiting);
  await expect(queue(page).getByRole('heading', { name: 'No closed calls.', exact: true })).toBeVisible();
  await expect(draft(page).getByRole('heading', { name: 'The story starts with the caller.', exact: true })).toBeVisible();
  await expect(queue(page).getByRole('button', { name: 'Create a caller invitation', exact: true })).toHaveCount(0);
  const closed = call(2, 'CLOSED', 3);
  data.calls.push(closed);
  await expect(draft(page).getByRole('heading', { name: label(closed), exact: true })).toBeVisible();
  await expect(status(page)).toHaveValue('closed');
  expect(data.unexpected).toEqual([]);
  expect(data.errors).toEqual([]);
});

test('returning to an active case uses its latest queue state when the active snapshot is older', async ({ page }, testInfo) => {
  const assigned = call(1, 'CLAIMED');
  assigned.claim = { participantId, expiresAt: fixedNow + 60_000 };
  const data = await fixture(page, [assigned]);
  await page.goto(`${baseURL}/nurse`);
  await expect(page).toHaveURL(`${baseURL}/nurse`);
  await expect(page).toHaveTitle('NurseBridge · The intake workspace');
  await expect(page.getByRole('heading', { name: 'Call queue', exact: true })).toBeVisible();
  const controls = page.getByRole('region', { name: 'Active call controls' });
  await expect(controls).toBeVisible();
  await expect(page.locator('.audio-state')).toContainText('Connection: connected');
  await status(page).selectOption('in-progress');
  await expect(queueItem(page, assigned)).toBeVisible();

  // The queue has a newer terminal revision before either the detail read or
  // socket catches up. Return-to-call must reveal the merged row, not trust the
  // older active snapshot's CLAIMED grouping.
  data.queueOverride = [{ ...structuredClone(assigned), queueState: 'CLOSED', revision: assigned.revision + 1 }];
  await expect(status(page).locator('option')).toHaveText(['All calls (1)', 'Waiting (0)', 'In progress (0)', 'Closed (1)']);
  await expect(queueItem(page, assigned)).toHaveCount(0);
  await expect(controls).toBeVisible();
  await controls.getByRole('button', { name: 'Return to active call', exact: true }).click();
  await expect(status(page)).toHaveValue('all');
  await expect(queueItem(page, assigned)).toHaveAttribute('aria-pressed', 'true');
  await expect(queueItem(page, assigned).getByText('Closed', { exact: true })).toBeVisible();
  await expect(draft(page).getByRole('heading', { name: label(assigned), exact: true })).toBeVisible();
  await expect(page.locator('nextjs-portal [data-nextjs-error-dialog], vite-error-overlay')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('return-to-active-case-newer-queue-state.png'), fullPage: false });
  expect(data.unexpected).toEqual([]);
  expect(data.errors).toEqual([]);
});
