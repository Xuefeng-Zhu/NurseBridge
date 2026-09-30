import type { Page, TestInfo } from '@playwright/test';
import { safeAudioDiagnostics } from '../../reporters/safe-diagnostics-data';

/** Capture before cleanup, including failures; attachment content is safe by construction. */
export async function attachAudioDiagnostics(page: Page, testInfo: TestInfo, role: 'caller' | 'nurse') {
  const input = await page.evaluate(() => {
    const current = window as unknown as { __nursebridgeDiagnostics?: Record<string, unknown>; __nursebridge?: { getState(): unknown } };
    const value = current.__nursebridgeDiagnostics;
    return { available: Boolean(value), metrics: value?.audio ?? value?.diagnostics ?? value, state: current.__nursebridge?.getState() };
  }).catch(() => ({ available: false }));
  await testInfo.attach(`safe-audio-${role}`, { body: JSON.stringify(safeAudioDiagnostics(input)), contentType: 'application/json' });
}
