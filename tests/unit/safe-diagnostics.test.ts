import { resolve } from 'node:path';
import type { FullResult, TestCase, TestResult } from '@playwright/test/reporter';
import { describe, expect, it, vi } from 'vitest';
import { safeAudioDiagnostics } from '../reporters/safe-diagnostics-data';
import SafeDiagnosticsReporter from '../reporters/safe-diagnostics';
import { mkdir, writeFile } from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined), writeFile: vi.fn().mockResolvedValue(undefined) }));

describe('safe CI diagnostics', () => {
  it('keeps numeric audio measurements and known state values, excluding credentials and free text', () => {
    const result = safeAudioDiagnostics({
      available: true, token: 'SECRET',
      metrics: { dominantFrequency: 660, receivedFrames: 200, rms: 0.2, queuedSamples: 0, controlEpoch: NaN, droppedFrames: Infinity, playedSamples: 'SECRET', url: 'https://example.com/#SECRET' },
      state: { connection: 'connected', microphone: 'ready', playback: 'SECRET', muted: false, error: 'SECRET', cookie: 'SECRET' },
    });
    expect(result).toEqual({ available: true, metrics: { receivedFrames: 200, rms: 0.2, queuedSamples: 0, dominantFrequency: 660 }, state: { connection: 'connected', microphone: 'ready', muted: false } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('handles missing and malformed diagnostics without copying arbitrary values', () => {
    for (const input of [undefined, null, [], 'SECRET', { available: 'SECRET', metrics: ['SECRET'], state: null }]) {
      expect(safeAudioDiagnostics(input)).toEqual({ available: false, metrics: {}, state: {} });
    }
  });

  it('reports failures while excluding titles, errors, stdout, trace paths and untrusted attachment fields', async () => {
    vi.mocked(writeFile).mockClear();
    const reporter = new SafeDiagnosticsReporter();
    reporter.onError();
    reporter.onTestEnd({ location: { file: resolve('tests/browser/nurse-regressions.spec.ts'), line: 99, column: 1 }, title: 'SECRET', id: 'SECRET', annotations: [{ type: 'SECRET' }] } as unknown as TestCase, {
      status: 'failed', duration: 15000, retry: 0, errors: [{ message: 'SECRET' }], stdout: ['SECRET'],
      attachments: [
        { name: 'trace', path: '/private/SECRET.zip' },
        { name: 'screenshot', body: Buffer.from('SECRET') },
        { name: 'safe-audio-nurse', path: '/private/SECRET.json' },
        { name: 'safe-audio-caller', body: Buffer.from(JSON.stringify({ available: true, metrics: { dominantFrequency: 0, token: 'SECRET' }, state: { connection: 'connected', error: 'SECRET' }, extra: 'SECRET' })) },
        { name: 'safe-audio-nurse', body: Buffer.from('SECRET malformed JSON') },
      ],
    } as unknown as TestResult);
    await reporter.onEnd({ status: 'failed' } as FullResult);
    expect(mkdir).toHaveBeenCalled();
    const [path, body, options] = vi.mocked(writeFile).mock.calls[0]!;
    expect(path).toBe(resolve('output/playwright/ci/browser-diagnostics.json'));
    expect(options).toEqual({ mode: 0o600 });
    expect(String(body)).not.toContain('SECRET');
    expect(JSON.parse(String(body))).toEqual({ version: 1, status: 'failed', infrastructureErrors: 1, tests: [{ file: 'nurse-regressions.spec.ts', line: 99, column: 1, status: 'failed', durationMs: 15000, retry: 0, audio: [{ role: 'caller', available: true, metrics: { dominantFrequency: 0 }, state: { connection: 'connected' } }] }] });
  });
});
