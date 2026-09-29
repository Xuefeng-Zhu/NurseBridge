import { resolve } from 'node:path';
import type { FullResult, TestCase, TestResult } from '@playwright/test/reporter';
import type { Page, TestInfo } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { safeAudioDiagnostics, safeControlDiagnostics, safeTakeoverOutcomes } from '../reporters/safe-diagnostics-data';
import { unexpectedTakeoverConsoleErrors } from '../browser/helpers/takeover-diagnostics';
import { attachControlDiagnostics } from '../browser/helpers/control-diagnostics';
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

  it('retains only known takeover outcomes, never request URLs or server messages', () => {
    const result = safeTakeoverOutcomes([{ action: 'claim', status: 409, code: 'revision_conflict', url: '/SECRET', error: 'SECRET' }, { action: 'takeover', status: 200, code: 'SECRET' }, { action: 'SECRET', status: 409 }, { action: ['claim'], status: 409 }, { action: 'claim', status: 'SECRET' }]);
    expect(result).toEqual([{ action: 'claim', status: 409, code: 'revision_conflict' }, { action: 'takeover', status: 200 }]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('retains authoritative control states and exact known gap causes without call content', () => {
    const result = safeControlDiagnostics({
      available: true, token: 'SECRET',
      state: { id: 'SECRET', workspaceId: 'SECRET', queueState: 'CLAIMED', conversationOwner: 'NONE', controlEpoch: 4, mediaReady: { caller: true, nurse: false, token: 'SECRET' }, participants: { caller: true, nurse: true }, claim: { participantId: 'SECRET' }, turns: [{ text: 'SECRET' }] },
      timeline: [
        { type: 'connected', id: 'SECRET', message: 'SECRET', at: 12345 },
        { type: 'audio-gap', message: 'Audio sender exceeded the realtime delivery limit.' },
        { type: 'audio-gap', message: 'Audio interrupted by bounded transport backpressure.' },
        { type: 'audio-gap', message: 'Human audio interrupted by network congestion.' },
        { type: 'audio-gap', message: 'Voice Agent warning: SECRET' },
        { type: 'audio-gap', message: 'Audio sender exceeded the realtime delivery limit. SECRET' },
        { type: 'SECRET', message: 'SECRET' },
        { type: 'human-audio-interrupted', cause: 'rate_limit', message: 'SECRET' },
      ],
    });
    expect(result).toEqual({ available: true, state: { queueState: 'CLAIMED', conversationOwner: 'NONE', controlEpoch: 4, mediaReady: { caller: true, nurse: false }, participants: { caller: true, nurse: true } }, timeline: [{ type: 'connected' }, { type: 'audio-gap', cause: 'rate_limit' }, { type: 'audio-gap', cause: 'capture_backpressure' }, { type: 'audio-gap', cause: 'playback_backpressure' }, { type: 'audio-gap' }, { type: 'audio-gap' }, { type: 'human-audio-interrupted' }] });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(safeControlDiagnostics(result)).toEqual(result);
  });

  it('bounds timeline history and discards invalid control states and cause codes', () => {
    const result = safeControlDiagnostics({ available: 'SECRET', state: { queueState: 'SECRET', conversationOwner: 'SECRET', controlEpoch: Infinity, mediaReady: { caller: 'SECRET' }, participants: null }, timeline: [{ type: 'connected' }, ...Array.from({ length: 25 }, () => ({ type: 'audio-gap', cause: 'SECRET' }))] });
    expect(result).toEqual({ available: false, state: { mediaReady: {}, participants: {} }, timeline: Array.from({ length: 20 }, () => ({ type: 'audio-gap' })) });
    for (const input of [undefined, null, [], 'SECRET']) expect(safeControlDiagnostics(input)).toEqual({ available: false, state: { mediaReady: {}, participants: {} }, timeline: [] });
  });

  it('bounds the authoritative read and sanitizes before attachment, including read failure', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({ ok: () => true, json: async () => ({ snapshot: { id: 'SECRET', queueState: 'CONNECTED', controlEpoch: 3, timeline: [{ type: 'connected', message: 'SECRET' }] } }), dispose });
    const attach = vi.fn().mockResolvedValue(undefined);
    const page = { request: { get } } as unknown as Page;
    const testInfo = { attach } as unknown as TestInfo;
    await attachControlDiagnostics(page, testInfo, 'http://localhost:8787', 'SECRET');
    expect(get).toHaveBeenCalledExactlyOnceWith('http://localhost:8787/api/calls/SECRET', { timeout: 2000, maxRetries: 0 });
    expect(dispose).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledWith('safe-control-state', { body: JSON.stringify({ available: true, state: { queueState: 'CONNECTED', controlEpoch: 3, mediaReady: {}, participants: {} }, timeline: [{ type: 'connected' }] }), contentType: 'application/json' });
    get.mockRejectedValueOnce(new Error('SECRET'));
    await attachControlDiagnostics(page, testInfo, 'http://localhost:8787', 'SECRET');
    expect(get).toHaveBeenCalledTimes(2);
    expect(JSON.parse(attach.mock.calls[1]![1].body)).toMatchObject({ available: false });
    expect(JSON.stringify(attach.mock.calls)).not.toContain('SECRET');
  });

  it('excuses only the confirmed recovered revision conflict console response', () => {
    const messages = [{ url: '/claim', text: 'Failed to load resource: the server responded with a status of 409 (Conflict)' }];
    const conflict = { url: '/claim', action: 'claim' as const, status: 409, code: 'revision_conflict' };
    expect(unexpectedTakeoverConsoleErrors(messages, [conflict, { ...conflict, status: 200, code: undefined }])).toEqual([]);
    expect(unexpectedTakeoverConsoleErrors(messages, [conflict])).toHaveLength(1);
    expect(unexpectedTakeoverConsoleErrors(messages, [{ ...conflict, code: 'already_claimed' }, { ...conflict, status: 200 }])).toHaveLength(1);
    expect(unexpectedTakeoverConsoleErrors([{ ...messages[0]!, url: '/another-call/claim' }], [conflict, { ...conflict, status: 200 }])).toHaveLength(1);
    expect(unexpectedTakeoverConsoleErrors([{ url: '/claim', text: 'Unexpected 409 application error' }], [conflict, { ...conflict, status: 200 }])).toHaveLength(1);
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
        { name: 'safe-control-state', body: Buffer.from(JSON.stringify({ available: true, state: { queueState: 'CLAIMED', id: 'SECRET' }, timeline: [{ type: 'audio-gap', cause: 'rate_limit', error: 'SECRET' }, { type: 'SECRET' }] })) },
      ],
    } as unknown as TestResult);
    await reporter.onEnd({ status: 'failed' } as FullResult);
    expect(mkdir).toHaveBeenCalled();
    const [path, body, options] = vi.mocked(writeFile).mock.calls[0]!;
    expect(path).toBe(resolve('output/playwright/ci/browser-diagnostics.json'));
    expect(options).toEqual({ mode: 0o600 });
    expect(String(body)).not.toContain('SECRET');
    expect(JSON.parse(String(body))).toEqual({ version: 1, status: 'failed', infrastructureErrors: 1, tests: [{ file: 'nurse-regressions.spec.ts', line: 99, column: 1, status: 'failed', durationMs: 15000, retry: 0, audio: [{ role: 'caller', available: true, metrics: { dominantFrequency: 0 }, state: { connection: 'connected' } }], takeover: [], control: [{ available: true, state: { queueState: 'CLAIMED', mediaReady: {}, participants: {} }, timeline: [{ type: 'audio-gap', cause: 'rate_limit' }] }] }] });
  });
});
