import { RECORDING_DISCLOSURE, RECORDING_DISCLOSURE_VERSION, type IntakeTemplate, type RpcResult } from '@nursebridge/contracts';
import { DEFAULT_TEMPLATE } from '@nursebridge/intake-policy';
import { CALL_DURATION_MS, RETENTION_MS } from '@nursebridge/database';
import type { Env } from '../env';
import { liveActivationIssues } from '../providers/readiness';
import { authenticateTwilio, PhoneRequestError, PHONE_NUMBER, phoneHash, phoneStreamToken, publicPhoneOrigin, releasePhoneReservation } from './twilio';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
const STATUSES = new Set(['queued', 'initiated', 'ringing', 'in-progress', ...TERMINAL]);
type Decision = 'accepted' | 'declined' | 'unavailable';
type Receipt = {
  provider: 'twilio'; account_sid: string; provider_call_sid: string;
  call_id: string | null; workspace_id: string | null; caller_participant_id: string | null;
  destination_hash: string | null; template_json: string | null; created_at: number;
  expires_at: number | null; deadline_at: number | null; stream_token_expires_at: number | null;
  status: string; terminal_at: number | null; consent_decision: Decision | null;
};
type Admitted = Receipt & { call_id: string; workspace_id: string; caller_participant_id: string; template_json: string; expires_at: number; deadline_at: number; stream_token_expires_at: number };
type PhoneRpc = {
  initializePhone(input: { callId: string; workspaceId: string; callerParticipantId: string; mode: 'mock' | 'live'; template: IntakeTemplate; provider: 'twilio'; accountSid: string; providerCallSid: string; streamTokenHash: string; streamTokenExpiresAt: number; createdAt: number; expiresAt: number }): Promise<RpcResult>;
  phoneConsent(input: { workspaceId: string; providerCallSid: string; commandId: string; decision: Decision; recordingAccepted?: boolean; disclosureVersion?: string }): Promise<RpcResult>;
  phoneStatus(input: { workspaceId: string; providerCallSid: string; status: string; eventId?: string }): Promise<RpcResult>;
  fetch(request: Request): Promise<Response>;
};
function object(env: Env, callId: string): PhoneRpc { return env.CALL_SESSIONS.get(env.CALL_SESSIONS.idFromName(callId)) as unknown as PhoneRpc; }
function checked(result: RpcResult) { if (!result.ok) throw new PhoneRequestError(result.status, result.status >= 500 ? 'Phone service is temporarily unavailable.' : 'This phone call is unavailable.'); }
function integer(value: string | undefined, fallback: number, maximum = 10_000): number { const number = Number(value ?? fallback); if (!Number.isInteger(number) || number < 1 || number > maximum) throw new PhoneRequestError(503, 'Phone quota configuration is unavailable.'); return number; }
function xml(value: string) { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!); }
function twiml(content: string) { return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${content}</Response>`, { headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' } }); }
function hangup(message = 'This demonstration call is no longer available.') { return twiml(`<Say>${xml(message)}</Say><Hangup/>`); }
function admitted(row: Receipt | null): row is Admitted { return Boolean(row?.call_id && row.workspace_id && row.caller_participant_id && row.template_json && row.expires_at && row.deadline_at && row.stream_token_expires_at); }
function aiReady(env: Env) { return env.PROVIDER_MODE === 'live' && liveActivationIssues({ ...env, FICTIONAL_LIVE_TEST: undefined }).length === 0; }
async function receipt(env: Env, callSid: string): Promise<Receipt | null> { return env.DB.prepare("SELECT * FROM inbound_calls WHERE provider='twilio' AND account_sid=? AND provider_call_sid=?").bind(env.TWILIO_ACCOUNT_SID, callSid).first<Receipt>(); }

function routes(env: Env): Record<string, string> {
  try {
    const value: unknown = JSON.parse(env.TWILIO_INBOUND_ROUTES ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    for (const [number, workspace] of Object.entries(value)) if (!PHONE_NUMBER.test(number) || typeof workspace !== 'string' || !UUID.test(workspace)) throw new Error();
    return value as Record<string, string>;
  } catch { throw new PhoneRequestError(503, 'Phone routing configuration is unavailable.'); }
}

async function fence(env: Env, callSid: string, status: string): Promise<Receipt | null> {
  await env.DB.prepare("INSERT INTO inbound_calls(provider,account_sid,provider_call_sid,created_at,status,terminal_at) VALUES('twilio',?,?,?,?,?) ON CONFLICT(provider,account_sid,provider_call_sid) DO UPDATE SET status=CASE WHEN inbound_calls.terminal_at IS NULL THEN excluded.status ELSE inbound_calls.status END,terminal_at=COALESCE(inbound_calls.terminal_at,excluded.terminal_at)").bind(env.TWILIO_ACCOUNT_SID, callSid, Date.now(), status, Date.now()).run();
  return receipt(env, callSid);
}

async function admit(env: Env, form: URLSearchParams): Promise<Receipt> {
  const callSid = form.get('CallSid')!;
  const destination = form.get('To') ?? '';
  if (!PHONE_NUMBER.test(destination) || form.get('Direction') !== 'inbound') throw new PhoneRequestError(400, 'Expected an inbound telephone call.');
  const destinationHash = await phoneHash(destination);
  const existing = await receipt(env, callSid);
  if (existing) {
    if (existing.destination_hash && existing.destination_hash !== destinationHash) throw new PhoneRequestError(409, 'Provider call routing changed.');
    return existing;
  }
  const workspaceId = routes(env)[destination];
  if (!workspaceId) throw new PhoneRequestError(404, 'No inbound demonstration route is available.');
  const now = Date.now();
  const workspace = await env.DB.prepare('SELECT expires_at FROM workspaces WHERE id=? AND expires_at>?').bind(workspaceId, now).first<{ expires_at: number }>();
  if (!workspace) throw new PhoneRequestError(410, 'The routed demonstration workspace has expired.');
  const current = await env.DB.prepare('SELECT body_json FROM template_versions WHERE workspace_id=? ORDER BY version DESC LIMIT 1').bind(workspaceId).first<{ body_json: string }>();
  const templateJson = current?.body_json ?? JSON.stringify(DEFAULT_TEMPLATE);
  const callId = crypto.randomUUID(), participantId = crypto.randomUUID();
  const duration = integer(env.MAX_CALL_SECONDS, 600, 600) * 1000;
  const deadline = Math.min(now + duration, workspace.expires_at);
  const expires = Math.min(now + RETENTION_MS, workspace.expires_at);
  const minutes = Math.ceil(duration / 60_000), day = new Date(now).toISOString().slice(0, 10);
  const account = env.TWILIO_ACCOUNT_SID!;
  // D1 batch is transactional: this reservation and the shared browser admission
  // row become visible together. Retries select the winning stable receipt IDs.
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO inbound_calls(provider,account_sid,provider_call_sid,call_id,workspace_id,caller_participant_id,destination_hash,template_json,created_at,expires_at,deadline_at,stream_token_expires_at,status)
      SELECT 'twilio',?,?,?,?,?,?,?,?,?,?,?,'pending'
      WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=? AND expires_at>?)
      AND (SELECT COUNT(*) FROM phone_reservations WHERE released=0)<?
      AND (SELECT COALESCE(SUM(minutes),0) FROM phone_reservations WHERE day=?)<=?
      AND (SELECT COUNT(*) FROM call_initializations i LEFT JOIN calls c ON c.id=i.call_id WHERE i.workspace_id=? AND i.created_at>? AND (c.queue_state IS NULL OR c.queue_state<>'CLOSED'))<?`)
      .bind(account, callSid, callId, workspaceId, participantId, destinationHash, templateJson, now, expires, deadline, Math.min(deadline, now + 180_000), workspaceId, now, integer(env.PHONE_MAX_CONCURRENT, 2), day, integer(env.PHONE_DAILY_MINUTES, 60) - minutes, workspaceId, now - CALL_DURATION_MS, integer(env.MAX_ACTIVE_CALLS_PER_WORKSPACE, 2)),
    env.DB.prepare("INSERT OR IGNORE INTO participants(id,workspace_id,role,created_at) SELECT caller_participant_id,workspace_id,'caller',created_at FROM inbound_calls WHERE provider='twilio' AND account_sid=? AND provider_call_sid=? AND call_id IS NOT NULL AND terminal_at IS NULL").bind(account, callSid),
    env.DB.prepare("INSERT OR IGNORE INTO call_initializations(workspace_id,participant_id,command_id,call_id,created_at) SELECT workspace_id,caller_participant_id,'phone:'||call_id,call_id,created_at FROM inbound_calls WHERE provider='twilio' AND account_sid=? AND provider_call_sid=? AND call_id IS NOT NULL AND terminal_at IS NULL").bind(account, callSid),
    env.DB.prepare("INSERT OR IGNORE INTO phone_reservations(call_id,workspace_id,day,minutes,expires_at) SELECT call_id,workspace_id,?,?,deadline_at FROM inbound_calls WHERE provider='twilio' AND account_sid=? AND provider_call_sid=? AND call_id IS NOT NULL AND terminal_at IS NULL").bind(day, minutes, account, callSid),
    env.DB.prepare("INSERT OR IGNORE INTO inbound_calls(provider,account_sid,provider_call_sid,created_at,status,terminal_at) VALUES('twilio',?,?,?,'rejected',?)").bind(account, callSid, now, now),
  ]);
  let row = await receipt(env, callSid);
  if (!row) row = await fence(env, callSid, 'rejected');
  if (!row) throw new PhoneRequestError(503, 'Phone admission could not be confirmed.');
  if (row.destination_hash && row.destination_hash !== destinationHash) throw new PhoneRequestError(409, 'Provider call routing changed.');
  return row;
}

async function initialize(env: Env, row: Admitted): Promise<string> {
  const token = await phoneStreamToken(env, { callId: row.call_id, workspaceId: row.workspace_id, participantId: row.caller_participant_id, providerCallSid: row.provider_call_sid });
  checked(await object(env, row.call_id).initializePhone({ callId: row.call_id, workspaceId: row.workspace_id, callerParticipantId: row.caller_participant_id, mode: env.PROVIDER_MODE, template: JSON.parse(row.template_json) as IntakeTemplate, provider: 'twilio', accountSid: row.account_sid, providerCallSid: row.provider_call_sid, streamTokenHash: await phoneHash(token), streamTokenExpiresAt: row.stream_token_expires_at, createdAt: row.created_at, expiresAt: row.expires_at }));
  return token;
}

async function reserveAi(env: Env, row: Admitted): Promise<boolean> {
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  const minutes = Math.ceil((row.deadline_at - row.created_at) / 60_000);
  const limit = integer(env.MAX_LIVE_CONCURRENCY, 4), daily = integer(env.DAILY_AUDIO_MINUTES, 120);
  await env.DB.prepare(`INSERT OR IGNORE INTO audio_reservations(call_id,workspace_id,day,minutes,expires_at)
    SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM audio_reservations WHERE expires_at>? AND released=0)<?
    AND (SELECT COALESCE(SUM(minutes),0) FROM audio_reservations WHERE day=?)<=?`).bind(row.call_id, row.workspace_id, day, minutes, row.deadline_at, now, limit, day, daily - minutes).run();
  return Boolean(await env.DB.prepare('SELECT call_id FROM audio_reservations WHERE call_id=? AND workspace_id=? AND expires_at>? AND released=0').bind(row.call_id, row.workspace_id, now).first());
}

async function decide(env: Env, row: Admitted, wanted: Decision): Promise<Admitted> {
  let decision = row.consent_decision;
  if (!decision) {
    decision = wanted === 'accepted' && (!aiReady(env) || !await reserveAi(env, row)) ? 'unavailable' : wanted;
    await env.DB.prepare("UPDATE inbound_calls SET consent_decision=COALESCE(consent_decision,?) WHERE provider='twilio' AND account_sid=? AND provider_call_sid=? AND terminal_at IS NULL").bind(decision, row.account_sid, row.provider_call_sid).run();
    const current = await receipt(env, row.provider_call_sid);
    if (!admitted(current) || current.terminal_at !== null) throw new PhoneRequestError(410, 'This phone call has ended.');
    row = current; decision = row.consent_decision;
  }
  if (!decision) throw new PhoneRequestError(503, 'Phone consent could not be confirmed.');
  if (decision !== 'accepted') await env.DB.prepare('UPDATE audio_reservations SET released=1 WHERE call_id=?').bind(row.call_id).run();
  checked(await object(env, row.call_id).phoneConsent({ workspaceId: row.workspace_id, providerCallSid: row.provider_call_sid, commandId: `phone-consent:${row.call_id}`, decision, ...(decision === 'accepted' ? { recordingAccepted: true, disclosureVersion: RECORDING_DISCLOSURE_VERSION } : {}) }));
  return row;
}

function stream(env: Env, row: Admitted, token: string, decision: Decision): Response {
  const origin = publicPhoneOrigin(env);
  const socketOrigin = origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  const words = decision === 'accepted' ? 'Automated intake will begin. Press zero at any time to request a person.' : decision === 'declined' ? 'Automated intake is off. Your request is in the nurse queue. Press zero to request a person. This demonstration does not assess whether waiting is safe.' : 'Automated intake is unavailable. You are in the nurse queue for a human conversation. Press zero to request a person. This demonstration does not assess whether waiting is safe.';
  return twiml(`<Say>${xml("This is a fictional demonstration, not medical care. " + words)}</Say><Connect><Stream url="${xml(`${socketOrigin}/phone/connect/${row.call_id}`)}"><Parameter name="token" value="${xml(token)}"/></Stream></Connect><Hangup/>`);
}

async function terminalStatus(env: Env, form: URLSearchParams): Promise<Response> {
  const status = form.get('CallStatus') ?? '';
  if (!STATUSES.has(status)) throw new PhoneRequestError(400, 'Unknown provider call status.');
  const callSid = form.get('CallSid')!;
  const event = form.get('SequenceNumber');
  if (event && !/^[0-9]{1,12}$/.test(event)) throw new PhoneRequestError(400, 'Invalid provider event sequence.');
  let row = await receipt(env, callSid);
  if (row?.destination_hash && form.has('To') && await phoneHash(form.get('To')!) !== row.destination_hash) throw new PhoneRequestError(409, 'Provider call routing changed.');
  if (TERMINAL.has(status)) {
    row = await fence(env, callSid, status);
    if (row?.call_id) await releasePhoneReservation(env, row.call_id);
  }
  if (row?.call_id && row.workspace_id && (TERMINAL.has(status) || row.terminal_at === null)) {
    // Deleted receipts retain identity for carrier cleanup, not their template.
    // Ignore late nonterminal events: a local deletion fence is not proof that
    // the carrier stopped billing and must never become a completed callback.
    const effectiveStatus = status === 'initiated' ? 'queued' : status;
    checked(await object(env, row.call_id).phoneStatus({ workspaceId: row.workspace_id, providerCallSid: callSid, status: effectiveStatus, ...(event ? { eventId: event } : {}) }));
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

async function voice(env: Env, form: URLSearchParams, consent: boolean): Promise<Response> {
  if (TERMINAL.has(form.get('CallStatus') ?? '')) { await terminalStatus(env, form); return hangup(); }
  const row = consent ? await receipt(env, form.get('CallSid')!) : await admit(env, form);
  if (!admitted(row) || row.terminal_at !== null) return hangup(row?.status === 'rejected' ? 'This demonstration has reached its call limit. Please try again later.' : undefined);
  if (form.has('To') && row.destination_hash !== await phoneHash(form.get('To')!)) throw new PhoneRequestError(409, 'Provider call routing changed.');
  if (row.deadline_at <= Date.now()) { await fence(env, row.provider_call_sid, 'completed'); return hangup(); }
  const workspace = await env.DB.prepare('SELECT id FROM workspaces WHERE id=? AND expires_at>?').bind(row.workspace_id, Date.now()).first();
  if (!workspace) return hangup('The demonstration workspace has expired.');
  const token = await initialize(env, row);
  // Recheck the terminal fence after the cross-system initialization await.
  const latest = await receipt(env, row.provider_call_sid);
  if (!admitted(latest)) return hangup();
  if (latest.terminal_at !== null) { checked(await object(env, latest.call_id).phoneStatus({ workspaceId: latest.workspace_id, providerCallSid: latest.provider_call_sid, status: TERMINAL.has(latest.status) ? latest.status : 'completed' })); return hangup(); }
  if (consent || latest.consent_decision || !aiReady(env)) {
    const wanted: Decision = consent ? form.get('Digits') === '1' ? 'accepted' : 'declined' : 'unavailable';
    const decided = await decide(env, latest, wanted);
    return stream(env, decided, token, decided.consent_decision!);
  }
  return twiml(`<Gather input="dtmf" numDigits="1" timeout="7" actionOnEmptyResult="true" method="POST" action="${xml(publicPhoneOrigin(env) + '/phone/twilio/consent')}"><Say>${xml(`This is a fictional demonstration, not medical care. ${RECORDING_DISCLOSURE} Press 1 to accept automated intake and possible recording. Press 0 to decline and request a person.`)}</Say></Gather><Hangup/>`);
}

/** Dedicated signed provider ingress; browser cookie and Origin routes remain unchanged. */
export async function handlePhoneRequest(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/phone/')) return null;
  if (env.PHONE_INBOUND_ENABLED !== 'true') return new Response('Not found', { status: 404 });
  try {
    if (path.startsWith('/phone/connect/')) {
      const callId = path.slice('/phone/connect/'.length);
      if (!UUID.test(callId)) return new Response('Not found', { status: 404 });
      if (request.method !== 'GET') throw new PhoneRequestError(405, 'Method not allowed.');
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new PhoneRequestError(426, 'WebSocket required.');
      await authenticateTwilio(request, env);
      return object(env, callId).fetch(request);
    }
    if (!['/phone/twilio/voice', '/phone/twilio/consent', '/phone/twilio/status'].includes(path)) return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') throw new PhoneRequestError(405, 'Method not allowed.');
    const form = await authenticateTwilio(request, env);
    return path.endsWith('/status') ? await terminalStatus(env, form) : await voice(env, form, path.endsWith('/consent'));
  } catch (error) {
    if (error instanceof PhoneRequestError) return new Response(error.message, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
    return new Response('Phone service is temporarily unavailable.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
