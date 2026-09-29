import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks';
import schema from '../../../packages/database/migrations/0001_initial.sql?raw';
import phoneSchema from '../../../packages/database/migrations/0002_phone_inbound.sql?raw';
import type { Env } from '../src/env';
import { handlePhoneRequest } from '../src/telephony/ingress';
import { authenticateTwilio, publicPhoneOrigin, releasePhoneReservation, terminatePhoneCall } from '../src/telephony/twilio';
import type { CallSnapshot } from '@nursebridge/contracts';
import * as readiness from '../src/providers/readiness';

const bindings = env as unknown as Env;
const account = 'AC' + 'a'.repeat(32);
const secret = 'fictional-phone-webhook-test-key';
const origin = 'https://phone.example.test';
const destination = '+12025550142';
const from = '+12025550199';
const workspace = 'e24370e0-9750-4a7b-a100-3b4fa17e2232';
const workspaceB = '347f2290-6464-4d4a-83da-b7e2e82f2f1e';
const sid = (number = 1) => 'CA' + number.toString(16).padStart(32, '0');
const config = (overrides: Partial<Env> = {}): Env => ({ ...bindings, PHONE_INBOUND_ENABLED: 'true', TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: secret, TWILIO_PUBLIC_ORIGIN: origin, TWILIO_INBOUND_ROUTES: JSON.stringify({ [destination]: workspace }), ...overrides });
function parameters(callSid = sid(), extra: Record<string, string> = {}): Record<string, string> { return { AccountSid: account, CallSid: callSid, To: destination, From: from, Direction: 'inbound', CallStatus: 'ringing', ...extra }; }
function signed(path: string, fields: Record<string, string>, signingOrigin = origin): Request {
  return new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': getExpectedTwilioSignature(secret, signingOrigin + path, fields) }, body: new URLSearchParams(fields).toString() });
}
async function send(path = '/phone/twilio/voice', fields = parameters(), options = config()) { const result = await handlePhoneRequest(signed(path, fields), options); expect(result).not.toBeNull(); return result!; }
async function rows(table: string) { return (await bindings.DB.prepare(`SELECT * FROM ${table}`).all()).results; }
async function active(callSid = sid()): Promise<{ call_id: string; workspace_id: string; caller_participant_id: string; created_at: number; template_json: string; terminal_at: number | null; consent_decision: string | null }> {
  const result = await bindings.DB.prepare('SELECT * FROM inbound_calls WHERE provider_call_sid=?').bind(callSid).first(); expect(result).not.toBeNull(); return result as Awaited<ReturnType<typeof active>>;
}
async function snapshot(callSid = sid()): Promise<CallSnapshot> { const row = await active(callSid); const result = await bindings.CALL_SESSIONS.getByName(row.call_id).snapshot(row.workspace_id); expect(result.ok).toBe(true); return (result as { ok: true; snapshot: CallSnapshot }).snapshot; }

beforeEach(async () => {
  await bindings.DB.exec(schema); await bindings.DB.exec(phoneSchema);
  await bindings.DB.prepare('INSERT INTO workspaces(id,created_at,expires_at) VALUES(?,?,?)').bind(workspace, Date.now(), Date.now() + 86_400_000).run();
  await bindings.DB.prepare('INSERT INTO workspaces(id,created_at,expires_at) VALUES(?,?,?)').bind(workspaceB, Date.now(), Date.now() + 86_400_000).run();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network is disabled in phone ingress tests.'));
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe('signed inbound telephone admission', () => {
  it('uses the official validator for all parameters and rejects spoofed origins/accounts without state writes', async () => {
    const fields = parameters(sid(), { FutureProviderParameter: '  preserve this whitespace  ' });
    expect((await send('/phone/twilio/voice', fields)).status).toBe(200);
    const tampered = signed('/phone/twilio/voice', fields);
    const altered = new Request(tampered, { body: new URLSearchParams({ ...fields, FutureProviderParameter: 'changed', CallSid: sid(2) }) });
    expect((await handlePhoneRequest(altered, config()))?.status).toBe(403);
    const evil = signed('/phone/twilio/voice', parameters(sid(3)), 'https://attacker.example');
    evil.headers.set('X-Forwarded-Host', 'attacker.example'); evil.headers.set('X-Forwarded-Proto', 'https');
    expect((await handlePhoneRequest(evil, config()))?.status).toBe(403);
    expect((await send('/phone/twilio/voice', parameters(sid(4), { AccountSid: 'AC' + 'b'.repeat(32) }))).status).toBe(403);
    expect(await rows('inbound_calls')).toHaveLength(1); expect(await rows('sessions')).toHaveLength(0);
    expect(JSON.stringify(await rows('inbound_calls'))).not.toContain(from);
  });

  it('admits one stable call and quota debit under concurrent webhook retries, and pins routing/template/arrival', async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => send()));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200]);
    const bodies = await Promise.all(responses.map(response => response.text()));
    expect(new Set(bodies).size).toBe(1);
    const first = await active();
    expect(await rows('inbound_calls')).toHaveLength(1); expect(await rows('participants')).toHaveLength(1); expect(await rows('call_initializations')).toHaveLength(1); expect(await rows('phone_reservations')).toHaveLength(1);
    expect(await rows('calls')).toHaveLength(1);
    expect((await snapshot()).createdAt).toBe(first.created_at);
    const changed = config({ TWILIO_INBOUND_ROUTES: JSON.stringify({ [destination]: workspaceB }) });
    expect((await send('/phone/twilio/voice', parameters(), changed)).status).toBe(200);
    const retried = await active(); expect(retried.call_id).toBe(first.call_id); expect(retried.workspace_id).toBe(workspace); expect(retried.template_json).toBe(first.template_json); expect(retried.created_at).toBe(first.created_at);
    expect((await send('/phone/twilio/voice', parameters(sid(), { To: '+12025550143' }))).status).toBe(409);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('waits for the same first queue projection under concurrent phone initialization', async () => {
    const callId = crypto.randomUUID();
    const stub = bindings.CALL_SESSIONS.getByName(callId);
    await runInDurableObject(stub, async instance => {
      let releaseProjection!: () => void, allInitializing!: () => void;
      const projectionGate = new Promise<void>(resolve => { releaseProjection = resolve; });
      const everyInitializationEntered = new Promise<void>(resolve => { allInitializing = resolve; });
      const internal = instance as unknown as { env: Env; flushProjection(): Promise<void> };
      const originalEnv = internal.env, originalProjection = internal.flushProjection;
      const database = originalEnv.DB;
      let entered = 0, settled = 0;
      // Hold the real D1 projection commit until every duplicate initialization
      // reaches its projection await. All promises stay within this DO context.
      internal.env = { ...originalEnv, DB: {
        ...database,
        prepare: (sql: string) => database.prepare(sql),
        batch: async <T>(statements: D1PreparedStatement[]) => { await projectionGate; return database.batch<T>(statements); },
      } as D1Database };
      internal.flushProjection = function () {
        entered++; if (entered === 5) allInitializing();
        return originalProjection.call(this);
      };
      const input = { callId, workspaceId: workspace, callerParticipantId: crypto.randomUUID(), mode: 'mock' as const, provider: 'twilio' as const, accountSid: account, providerCallSid: sid(), streamTokenHash: 'a'.repeat(64), streamTokenExpiresAt: Date.now() + 180_000 };
      const initializations = Array.from({ length: 5 }, () => instance.initializePhone(input).finally(() => { settled++; }));
      try {
        await everyInitializationEntered;
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(settled).toBe(0);
      } finally { releaseProjection(); }
      try {
        const results = await Promise.all(initializations);
        expect(results.every(result => result.ok)).toBe(true);
        expect(new Set(results.map(result => JSON.stringify(result))).size).toBe(1);
      } finally { internal.env = originalEnv; internal.flushProjection = originalProjection; }
    });
    expect(await rows('calls')).toHaveLength(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('keeps a projected caller visible without a browser session and never presents mock tones as automated phone intake', async () => {
    const response = await send(); const body = await response.text();
    expect(body).toContain('Use sample patient information only. Not for medical care.'); expect(body).toContain('Automated intake is unavailable'); expect(body).toContain('<Connect><Stream'); expect(body).toContain('<Parameter name="token"'); expect(body).toContain('</Connect><Hangup/>'); expect(body).not.toContain('<Gather');
    const call = await snapshot();
    expect(call).toMatchObject({ channel: 'phone', consent: false, humanRequested: true, queueState: 'WAITING', waitingReason: 'technical_failure' });
    expect(call.providerSession.status).not.toBe('active');
    const encoded = JSON.stringify(call); expect(encoded).not.toContain(account); expect(encoded).not.toContain(sid()); expect(encoded).not.toContain(secret); expect(encoded).not.toContain(from);
    expect(await rows('sessions')).toHaveLength(0);
    expect((await rows('phone_reservations'))[0]).toMatchObject({ released: 0 });
    const consent = await send('/phone/twilio/consent', parameters(sid(), { Digits: '1' }));
    expect(await consent.text()).toContain('Automated intake is unavailable'); expect((await snapshot()).consent).toBe(false);
    expect(await rows('audio_reservations')).toHaveLength(0);
  });

  it.each([
    { MAX_LIVE_CONCURRENCY: '4', DAILY_AUDIO_MINUTES: '10' },
    { MAX_LIVE_CONCURRENCY: '1', DAILY_AUDIO_MINUTES: '120' },
  ])('reserves AI capacity before accepting DTMF consent and falls back to the human queue on budget exhaustion: %j', async quotas => {
    // Isolate ingress admission/consent accounting; DO/provider readiness is covered
    // separately. This test cannot open media or call an external provider.
    vi.spyOn(readiness, 'liveActivationIssues').mockReturnValue([]);
    const initializePhone = vi.fn(async () => ({ ok: true }));
    const phoneConsent = vi.fn(async () => ({ ok: true }));
    const options = config({ PROVIDER_MODE: 'live', ...quotas, PHONE_MAX_CONCURRENT: '4', MAX_ACTIVE_CALLS_PER_WORKSPACE: '4', CALL_SESSIONS: {
      idFromName: (name: string) => bindings.CALL_SESSIONS.idFromName(name),
      get: () => ({ initializePhone, phoneConsent }),
    } as unknown as Env['CALL_SESSIONS'] });
    const first = await send('/phone/twilio/voice', parameters(), options);
    expect(await first.text()).toContain('<Gather'); expect(initializePhone).toHaveBeenCalledOnce(); expect(phoneConsent).not.toHaveBeenCalled(); expect(await rows('audio_reservations')).toHaveLength(0);
    const accepted = await send('/phone/twilio/consent', parameters(sid(), { Digits: '1' }), options);
    expect(accepted.status).toBe(200); expect(phoneConsent).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'accepted', recordingAccepted: true, disclosureVersion: 'voice-agent-recording-v1' }));
    expect(await rows('audio_reservations')).toHaveLength(1);
    await send('/phone/twilio/consent', parameters(sid(), { Digits: '1' }), options);
    expect(await rows('audio_reservations')).toHaveLength(1);
    await send('/phone/twilio/voice', parameters(sid(2)), options);
    const exhausted = await send('/phone/twilio/consent', parameters(sid(2), { Digits: '1' }), options);
    expect(await exhausted.text()).toContain('Automated intake is unavailable');
    expect(phoneConsent).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'unavailable' }));
    expect(await rows('phone_reservations')).toHaveLength(2); expect(await rows('audio_reservations')).toHaveLength(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects disabled ingress, absent/expired routes, malformed parameters, and unsafe public origins', async () => {
    expect(await handlePhoneRequest(new Request(origin + '/health'), config())).toBeNull();
    expect((await send('/phone/twilio/voice', parameters(), config({ PHONE_INBOUND_ENABLED: 'false' }))).status).toBe(404);
    expect((await send('/phone/twilio/voice', parameters(), config({ TWILIO_INBOUND_ROUTES: '{}' }))).status).toBe(404);
    expect((await send('/phone/twilio/voice', parameters(), config({ TWILIO_INBOUND_ROUTES: '{broken' }))).status).toBe(503);
    expect((await send('/phone/twilio/voice', parameters(sid(), { Direction: 'outbound-api' }))).status).toBe(400);
    await bindings.DB.prepare('UPDATE workspaces SET expires_at=0 WHERE id=?').bind(workspace).run();
    expect((await send()).status).toBe(410); expect(await rows('participants')).toHaveLength(0); expect(await rows('calls')).toHaveLength(0);
    expect(() => publicPhoneOrigin(config({ TWILIO_PUBLIC_ORIGIN: 'http://public.example' }))).toThrow();
    expect(() => publicPhoneOrigin(config({ TWILIO_PUBLIC_ORIGIN: 'http://localhost:8788', PROVIDER_MODE: 'live' }))).toThrow();
    expect(() => publicPhoneOrigin(config({ TWILIO_PUBLIC_ORIGIN: 'https://phone.example.test/path' }))).toThrow();
    expect(publicPhoneOrigin(config({ TWILIO_PUBLIC_ORIGIN: 'http://localhost:8788' }))).toBe('http://localhost:8788');
  });

  it('shares workspace admission with browser calls and fences a quota rejection', async () => {
    await bindings.DB.prepare('INSERT INTO call_initializations(workspace_id,participant_id,command_id,call_id,created_at) VALUES(?,?,?,?,?)').bind(workspace, 'browser-participant', crypto.randomUUID(), crypto.randomUUID(), Date.now()).run();
    const limited = config({ MAX_ACTIVE_CALLS_PER_WORKSPACE: '1' });
    const response = await send('/phone/twilio/voice', parameters(), limited);
    expect(await response.text()).toContain('reached its call limit'); expect(await rows('phone_reservations')).toHaveLength(0); expect(await rows('calls')).toHaveLength(0);
    await bindings.DB.prepare('DELETE FROM call_initializations WHERE workspace_id=?').bind(workspace).run();
    expect(await (await send()).text()).not.toContain('<Stream'); expect((await active()).terminal_at).not.toBeNull();
  });

  it('enforces atomic phone concurrency and daily minutes without releasing waiting or elapsed-but-unconfirmed lines', async () => {
    const limited = config({ PHONE_MAX_CONCURRENT: '1', MAX_ACTIVE_CALLS_PER_WORKSPACE: '8' });
    const responses = await Promise.all([send('/phone/twilio/voice', parameters(sid()), limited), send('/phone/twilio/voice', parameters(sid(2)), limited)]);
    const bodies = await Promise.all(responses.map(response => response.text()));
    expect(bodies.filter(body => body.includes('<Stream'))).toHaveLength(1); expect(await rows('phone_reservations')).toHaveLength(1);
    await bindings.DB.prepare('UPDATE phone_reservations SET expires_at=0').run();
    expect(await (await send('/phone/twilio/voice', parameters(sid(3)), limited)).text()).toContain('reached its call limit');
    const admitted = (await rows('phone_reservations'))[0]!;
    await releasePhoneReservation(config(), String(admitted.call_id));
    const daily = config({ PHONE_MAX_CONCURRENT: '4', PHONE_DAILY_MINUTES: '10', MAX_ACTIVE_CALLS_PER_WORKSPACE: '8' });
    expect(await (await send('/phone/twilio/voice', parameters(sid(4)), daily)).text()).toContain('reached its call limit');
    expect(await rows('phone_reservations')).toHaveLength(1);
  });

  it('persists early terminal callbacks, and late or duplicate callbacks cannot recreate or reopen the call', async () => {
    expect((await send('/phone/twilio/status', parameters(sid(), { CallStatus: 'completed' }))).status).toBe(204);
    expect(await (await send()).text()).not.toContain('<Stream'); expect(await rows('calls')).toHaveLength(0);
    expect((await send('/phone/twilio/status', parameters(sid(2), { CallStatus: 'invented-status' }))).status).toBe(400);
    expect(await rows('inbound_calls')).toHaveLength(1);
    expect((await send('/phone/twilio/voice', parameters(sid(3)))).status).toBe(200);
    const row = await active(sid(3));
    expect((await send('/phone/twilio/status', parameters(sid(3), { CallStatus: 'completed', SequenceNumber: '2' }))).status).toBe(204);
    expect((await send('/phone/twilio/status', parameters(sid(3), { CallStatus: 'ringing', SequenceNumber: '1' }))).status).toBe(204);
    expect((await snapshot(sid(3))).queueState).toBe('CLOSED');
    expect((await rows('phone_reservations')).find(item => item.call_id === row.call_id)).toMatchObject({ released: 1 });
    expect(await (await send('/phone/twilio/voice', parameters(sid(3)))).text()).not.toContain('<Stream');
    expect(await rows('calls')).toHaveLength(1);
  });

  it('retains stable admission when initialization projection fails and succeeds on retry', async () => {
    const originalGet = config().CALL_SESSIONS;
    let attempts = 0;
    const failing = config({ CALL_SESSIONS: { idFromName: (name: string) => originalGet.idFromName(name), get: (id: DurableObjectId) => {
      const real = originalGet.get(id);
      return { initializePhone: async (input: Parameters<typeof real.initializePhone>[0]) => { attempts++; return attempts === 1 ? { ok: false, status: 503, error: 'Synthetic projection failure' } : real.initializePhone(input); }, phoneConsent: (input: Parameters<typeof real.phoneConsent>[0]) => real.phoneConsent(input) };
    } } as unknown as Env['CALL_SESSIONS'] });
    expect((await send('/phone/twilio/voice', parameters(), failing)).status).toBe(503);
    const first = await active(); expect(await rows('phone_reservations')).toHaveLength(1);
    expect((await send('/phone/twilio/voice', parameters(), failing)).status).toBe(200);
    const retried = await active(); expect(retried.call_id).toBe(first.call_id); expect(retried.created_at).toBe(first.created_at); expect(await rows('phone_reservations')).toHaveLength(1);
  });

  it('retains failed carrier cleanup after deletion until a signed terminal callback confirms the line ended', async () => {
    expect((await send()).status).toBe(200);
    const row = await active(), stub = bindings.CALL_SESSIONS.getByName(row.call_id);
    await runInDurableObject(stub, instance => {
      const internal = instance as unknown as { env: Env };
      internal.env = { ...internal.env, TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: secret };
    });
    expect(await stub.command({ workspaceId: workspace, participantId: 'synthetic-admin', role: 'admin', commandId: crypto.randomUUID(), type: 'delete' })).toMatchObject({ ok: true, snapshot: { deleted: true } });
    expect(await active()).toMatchObject({ template_json: null, consent_decision: null, status: 'deleted' });
    expect(globalThis.fetch).toHaveBeenCalledOnce(); // Its mock rejects carrier termination.
    const pendingCleanup = () => runInDurableObject(stub, (instance, state) => {
      expect((instance as unknown as { phone: unknown }).phone).toMatchObject({ terminationPending: true, terminated: false, streamTokenHash: '', accountSid: '' });
      expect(state.storage.sql.exec('SELECT body FROM phone_binding').toArray()).toHaveLength(1);
    });
    await pendingCleanup();
    expect((await send('/phone/twilio/status', parameters(sid(), { CallStatus: 'ringing' }))).status).toBe(204);
    await pendingCleanup();
    expect((await rows('phone_reservations'))[0]).toMatchObject({ released: 0 });
    expect((await send('/phone/twilio/status', parameters(sid(), { CallStatus: 'completed' }))).status).toBe(204);
    await runInDurableObject(stub, (instance, state) => {
      expect((instance as unknown as { phone: unknown }).phone).toBeUndefined();
      expect(state.storage.sql.exec('SELECT body FROM phone_binding').toArray()).toHaveLength(0);
    });
    expect((await rows('phone_reservations'))[0]).toMatchObject({ released: 1 });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(await (await send()).text()).not.toContain('<Stream'); expect(await rows('calls')).toHaveLength(0);
  });

  it('validates signed WebSocket handshakes including only the documented trailing-slash variant', async () => {
    const path = '/phone/connect/' + crypto.randomUUID();
    for (const signedPath of [path, path + '/']) {
      const request = new Request(origin + path, { headers: { Upgrade: 'websocket', 'X-Twilio-Signature': getExpectedTwilioSignature(secret, origin + signedPath, {}) } });
      await expect(authenticateTwilio(request, config())).resolves.toBeInstanceOf(URLSearchParams);
    }
    const bad = new Request(origin + path, { headers: { Upgrade: 'websocket', 'X-Forwarded-Host': 'attacker.example', 'X-Twilio-Signature': getExpectedTwilioSignature(secret, 'https://attacker.example' + path + '/', {}) } });
    await expect(authenticateTwilio(bad, config())).rejects.toMatchObject({ status: 403 });
    const fields = parameters(); const post = signed('/phone/twilio/voice', fields); post.headers.set('X-Twilio-Signature', getExpectedTwilioSignature(secret, origin + '/phone/twilio/voice/', fields));
    expect((await handlePhoneRequest(post, config()))?.status).toBe(403);
  });

  it('bounds authenticated request bodies and rejects ambiguous identity fields', async () => {
    const fields = parameters();
    const form = new URLSearchParams(fields); form.append('CallSid', sid(2));
    const signature = getExpectedTwilioSignature(secret, origin + '/phone/twilio/voice', { ...fields, CallSid: [sid(), sid(2)] });
    const ambiguous = new Request(origin + '/phone/twilio/voice', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }, body: form });
    expect((await handlePhoneRequest(ambiguous, config()))?.status).toBe(400);
    expect((await send('/phone/twilio/voice', parameters(sid(), { Extra: 'x'.repeat(17_000) }))).status).toBe(413);
    expect(await rows('inbound_calls')).toHaveLength(0);
  });

  it('terminates only an existing call on the fixed Twilio endpoint and supports an internal test transport', async () => {
    const transport = { fetch: vi.fn(async () => Response.json({ status: 'completed' })) };
    await terminatePhoneCall(config({ TWILIO_HTTP: transport as unknown as Fetcher }), sid());
    expect(transport.fetch).toHaveBeenCalledOnce();
    const [url, options] = transport.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${account}/Calls/${sid()}.json`);
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', body: 'Status=completed' }); expect(options.signal).toBeDefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await expect(terminatePhoneCall(config(), '../../Calls')).rejects.toThrow('configuration');
    transport.fetch.mockImplementationOnce(async () => new Response('private provider details', { status: 500 }));
    await expect(terminatePhoneCall(config({ TWILIO_HTTP: transport as unknown as Fetcher }), sid())).rejects.toThrow('could not be confirmed');
  });
});
