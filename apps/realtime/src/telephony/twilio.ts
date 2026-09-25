import { validateRequest } from 'twilio/lib/webhooks/webhooks';
import type { Env } from '../env';

export const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
export const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
export const PHONE_NUMBER = /^\+[1-9][0-9]{7,14}$/;
const MAX_WEBHOOK_BYTES = 16_384;
export class PhoneRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function publicPhoneOrigin(env: Env): string {
  try {
    const value = env.TWILIO_PUBLIC_ORIGIN ?? '';
    const url = new URL(value);
    const local = env.PROVIDER_MODE === 'mock' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !local)) throw new Error();
    return value;
  } catch { throw new PhoneRequestError(503, 'Phone ingress configuration is unavailable.'); }
}

async function boundedBody(request: Request): Promise<string> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_WEBHOOK_BYTES) throw new PhoneRequestError(413, 'Webhook body is too large.');
  if (!request.body) return '';
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_WEBHOOK_BYTES) { await reader.cancel(); throw new PhoneRequestError(413, 'Webhook body is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/** Validate the canonical operator-configured URL and every received form field with Twilio's SDK. */
export async function authenticateTwilio(request: Request, env: Env): Promise<URLSearchParams> {
  const origin = publicPhoneOrigin(env);
  if (!ACCOUNT_SID.test(env.TWILIO_ACCOUNT_SID ?? '') || !env.TWILIO_AUTH_TOKEN?.trim()) throw new PhoneRequestError(503, 'Phone ingress configuration is unavailable.');
  const url = new URL(request.url);
  // Neither request Host nor proxy-forwarded headers choose the signed origin.
  const canonical = origin + url.pathname + url.search;
  const signature = request.headers.get('x-twilio-signature');
  if (!signature || signature.length > 256) throw new PhoneRequestError(403, 'Invalid provider authentication.');
  let form = new URLSearchParams();
  if (request.method === 'POST') {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new PhoneRequestError(415, 'Expected a form webhook.');
    form = new URLSearchParams(await boundedBody(request));
  } else if (request.method !== 'GET') throw new PhoneRequestError(405, 'Method not allowed.');
  const params: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
  for (const key of new Set(form.keys())) { const values = form.getAll(key); params[key] = values.length === 1 ? values[0]! : values; }
  const valid = validateRequest(env.TWILIO_AUTH_TOKEN, signature, canonical, params);
  // Twilio documents a trailing-slash variant for Voice WSS handshake signatures.
  // Only that pinned-origin handshake variant is allowed; POST URLs remain exact.
  const handshakeVariant = request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket'
    && !url.pathname.endsWith('/') && validateRequest(env.TWILIO_AUTH_TOKEN, signature, origin + url.pathname + '/' + url.search, params);
  if (!valid && !handshakeVariant) throw new PhoneRequestError(403, 'Invalid provider authentication.');
  for (const key of ['AccountSid', 'CallSid', 'To', 'Digits', 'CallStatus', 'Direction', 'SequenceNumber']) {
    if (form.getAll(key).length > 1) throw new PhoneRequestError(400, 'Ambiguous provider parameters.');
  }
  if (request.method === 'POST' && (form.get('AccountSid') !== env.TWILIO_ACCOUNT_SID || !CALL_SID.test(form.get('CallSid') ?? ''))) throw new PhoneRequestError(403, 'Provider call identity is invalid.');
  return form;
}

export async function phoneHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function phoneStreamToken(env: Env, identity: { callId: string; workspaceId: string; participantId: string; providerCallSid: string }): Promise<string> {
  if (!env.TWILIO_AUTH_TOKEN) throw new PhoneRequestError(503, 'Phone ingress configuration is unavailable.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TWILIO_AUTH_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const scope = JSON.stringify(['nursebridge-phone-stream-v1', env.TWILIO_ACCOUNT_SID, identity.providerCallSid, identity.callId, identity.workspaceId, identity.participantId]);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(scope))), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** End this existing carrier call only; this helper cannot create or dial a call. */
export async function terminatePhoneCall(env: Env, callSid: string): Promise<void> {
  if (!ACCOUNT_SID.test(env.TWILIO_ACCOUNT_SID ?? '') || !CALL_SID.test(callSid) || !env.TWILIO_AUTH_TOKEN) throw new Error('Phone termination configuration is unavailable.');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
  const options: RequestInit = {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ Status: 'completed' }).toString(),
  };
  const response = await (env.TWILIO_HTTP ? env.TWILIO_HTTP.fetch(url, options) : fetch(url, options));
  // Do not surface provider bodies or credentials in errors/logs.
  if (!response.ok) { await response.body?.cancel(); throw new Error('Phone termination could not be confirmed.'); }
  await response.body?.cancel();
}

/** Call only after a verified terminal callback or successful carrier termination. */
export async function releasePhoneReservation(env: Env, callId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE phone_reservations SET released=1 WHERE call_id=?').bind(callId),
    env.DB.prepare("UPDATE inbound_calls SET status=CASE WHEN terminal_at IS NULL THEN 'completed' ELSE status END,terminal_at=COALESCE(terminal_at,?) WHERE call_id=?").bind(Date.now(), callId),
    env.DB.prepare('UPDATE audio_reservations SET released=1 WHERE call_id=?').bind(callId),
  ]);
}
