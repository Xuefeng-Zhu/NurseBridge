import type { ConsoleMessage, Page, Response, TestInfo } from '@playwright/test';
import { clearTimeout, setTimeout } from 'node:timers';
import { safeTakeoverOutcomes } from '../../reporters/safe-diagnostics-data';

type Outcome = { url: string; action: 'claim' | 'takeover'; status: number; code?: string };

/** Only a confirmed revision rejection followed by success excuses its own browser HTTP noise. */
export function unexpectedTakeoverConsoleErrors(messages: { url: string; text: string }[], outcomes: Outcome[]) {
  const recovered = new Map<string, number>();
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 409 && outcome.code === 'revision_conflict' && outcomes.slice(index + 1).some(next => next.url === outcome.url && next.status >= 200 && next.status < 300)) recovered.set(outcome.url, (recovered.get(outcome.url) ?? 0) + 1);
  });
  return messages.flatMap(message => {
    const count = recovered.get(message.url) ?? 0;
    if (count > 0 && /^Failed to load resource: the server responded with a status of 409\b/.test(message.text)) { recovered.set(message.url, count - 1); return []; }
    return [message.text];
  });
}

export function watchTakeoverOutcomes(page: Page) {
  const outcomes: Outcome[] = [];
  const pending = new Set<Promise<void>>();
  const receive = (response: Response) => {
    const match = /^\/api\/calls\/[^/]+\/(claim|takeover)$/.exec(new URL(response.url()).pathname);
    if (!match || response.request().method() !== 'POST') return;
    const outcome: Outcome = { url: response.url(), action: match[1] as Outcome['action'], status: response.status() };
    outcomes.push(outcome);
    if (response.status() < 400) return;
    let timeout: ReturnType<typeof setTimeout>;
    const operation = Promise.race([response.json().catch(() => undefined), new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), 2000); })]).then(body => {
      const safe = safeTakeoverOutcomes([{ ...outcome, code: body?.code }])[0];
      if (safe?.code) outcome.code = safe.code;
    }).finally(() => { clearTimeout(timeout); pending.delete(operation); });
    pending.add(operation);
  };
  page.on('response', receive);
  return {
    async unexpectedConsoleErrors(messages: ConsoleMessage[]) {
      await Promise.all(pending);
      return unexpectedTakeoverConsoleErrors(messages.map(message => ({ url: message.location().url, text: message.text() })), outcomes);
    },
    async attach(testInfo: TestInfo) {
      page.off('response', receive);
      await Promise.all(pending);
      await testInfo.attach('safe-takeover-outcomes', { body: JSON.stringify(safeTakeoverOutcomes(outcomes)), contentType: 'application/json' });
    },
  };
}
