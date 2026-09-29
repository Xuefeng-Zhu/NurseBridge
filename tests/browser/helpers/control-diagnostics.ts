import type { Page, TestInfo } from '@playwright/test';
import { safeControlDiagnostics } from '../../reporters/safe-diagnostics-data';

/** Read the authoritative call before cleanup, with no retries or raw attachment. */
export async function attachControlDiagnostics(page: Page, testInfo: TestInfo, baseURL: string, callId: string | undefined) {
  let diagnostic = safeControlDiagnostics(undefined);
  if (callId) {
    try {
      const response = await page.request.get(`${baseURL}/api/calls/${callId}`, { timeout: 2000, maxRetries: 0 });
      try {
        if (response.ok()) {
          const body = await response.json() as { snapshot?: unknown };
          if (body.snapshot && typeof body.snapshot === 'object' && !Array.isArray(body.snapshot)) {
            const snapshot = body.snapshot as Record<string, unknown>;
            diagnostic = safeControlDiagnostics({ available: true, state: snapshot, timeline: snapshot.timeline });
          }
        }
      } finally { await response.dispose(); }
    } catch { /* Diagnostics must not replace the test's original failure. */ }
  }
  await testInfo.attach('safe-control-state', { body: JSON.stringify(diagnostic), contentType: 'application/json' });
}
