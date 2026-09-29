import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { safeAudioDiagnostics, safeTakeoverOutcomes } from './safe-diagnostics-data';

const output = resolve('output/playwright/ci/browser-diagnostics.json');
const browserTests = resolve('tests/browser');
type SafeAudio = ReturnType<typeof safeAudioDiagnostics> & { role: 'caller' | 'nurse' };

/** This is the only CI-uploaded artifact. Raw reports, traces and screenshots stay local. */
export default class SafeDiagnosticsReporter implements Reporter {
  private tests: { file: string; line: number; column: number; status: TestResult['status']; durationMs: number; retry: number; audio: SafeAudio[]; takeover: ReturnType<typeof safeTakeoverOutcomes> }[] = [];
  private infrastructureErrors = 0;

  onError() { this.infrastructureErrors++; }

  onTestEnd(test: TestCase, result: TestResult) {
    const path = relative(browserTests, test.location.file).split(sep).join('/');
    // Test titles, stdout, error messages, attachment paths and test IDs can contain secrets.
    const file = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.spec\.ts$/.test(path) ? path : 'unknown';
    const audio: SafeAudio[] = [];
    const takeover: ReturnType<typeof safeTakeoverOutcomes> = [];
    for (const attachment of result.attachments) {
      if (attachment.name === 'safe-takeover-outcomes' && attachment.body && attachment.body.byteLength <= 8192) {
        try { takeover.push(...safeTakeoverOutcomes(JSON.parse(attachment.body.toString('utf8')))); } catch { /* Ignore malformed diagnostic attachments. */ }
        continue;
      }
      const role = attachment.name === 'safe-audio-caller' ? 'caller' : attachment.name === 'safe-audio-nurse' ? 'nurse' : null;
      // Do not read arbitrary attachment files or include non-allowlisted payload fields.
      if (!role || !attachment.body || attachment.body.byteLength > 8192) continue;
      try { audio.push({ role, ...safeAudioDiagnostics(JSON.parse(attachment.body.toString('utf8'))) }); }
      catch { /* Malformed diagnostics must not prevent reporting other test outcomes. */ }
    }
    this.tests.push({ file, line: test.location.line, column: test.location.column, status: result.status, durationMs: result.duration, retry: result.retry, audio, takeover });
  }

  async onEnd(result: FullResult) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ version: 1, status: result.status, infrastructureErrors: this.infrastructureErrors, tests: this.tests }, null, 2), { mode: 0o600 });
  }
}
