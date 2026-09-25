import { z } from 'zod';
import { CommandBodySchema, FieldSchema, RECORDING_DISCLOSURE_VERSION, type Session, type IntakeTemplate } from '@nursebridge/contracts';
import { DEFAULT_TEMPLATE } from '@nursebridge/intake-policy';
import { RETENTION_MS, SESSION_MS, CALL_DURATION_MS } from '@nursebridge/database';
import { env, callObject, type AppEnv } from './env';
import { session, origin, hash, token, sessionCookie, rateLimit } from './auth';
import { body, json, HttpError, unwrap } from './http';
const uuid = z.string().uuid();
const staff = ['admin', 'nurse'] as const;
function quota(value: string | undefined, fallback: number) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
async function mutation(request: Request, roles?: ('admin' | 'nurse' | 'caller')[]) { const bindings = env(); origin(request, bindings); const user = await session(request, bindings, roles); return { bindings, user, data: await body(request) }; }
async function authoritative(bindings: AppEnv, user: Session, id: string) { uuid.parse(id); const result = unwrap(await callObject(bindings, id).snapshot(user.workspaceId)); if (!result.ok)
    throw new HttpError(404, 'Call not found'); const call = result.snapshot; if (user.role === 'caller' && call.callerParticipantId !== user.participantId)
    throw new HttpError(404, 'Call not found'); return call; }
async function template(bindings: AppEnv, workspaceId: string): Promise<IntakeTemplate> { const row = await bindings.DB.prepare('SELECT body_json FROM template_versions WHERE workspace_id=? ORDER BY version DESC LIMIT 1').bind(workspaceId).first<{
    body_json: string;
}>(); return row ? JSON.parse(row.body_json) : DEFAULT_TEMPLATE; }
export async function getSession(request: Request) { const bindings = env(); const user = await session(request, bindings); return json({ session: user, mode: bindings.PROVIDER_MODE, realtimeUrl: bindings.REALTIME_URL, diagnostics: bindings.ALLOW_TEST_DIAGNOSTICS === 'true' }); }
export async function createSession(request: Request) {
    const bindings = env();
    origin(request, bindings);
    const data = await body(request);
    const now = Date.now();
    await rateLimit(bindings, 'session:' + await hash(request.headers.get('cf-connecting-ip') ?? 'local'), 30, 3600000);
    if (bindings.TURNSTILE_SECRET_KEY) {
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: bindings.TURNSTILE_SECRET_KEY, response: z.string().parse(data.turnstileToken) }) });
        const checked = await response.json() as {
            success: boolean;
            hostname?: string;
        };
        if (!checked.success || checked.hostname !== new URL(bindings.APP_ORIGIN).hostname)
            throw new HttpError(403, 'Demo verification failed');
    }
    const participantId = crypto.randomUUID();
    let workspaceId = crypto.randomUUID();
    let role: 'admin' | 'nurse' | 'caller' = 'admin';
    const raw = token();
    const tokenHash = await hash(raw);
    if (data.invitation) {
        const invitationHash = await hash(z.string().min(32).max(128).parse(data.invitation));
        const invite = await bindings.DB.prepare('UPDATE invitations SET redeemed_by=? WHERE token_hash=? AND redeemed_by IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM workspaces WHERE id=invitations.workspace_id AND expires_at>?) RETURNING workspace_id,role').bind(participantId, invitationHash, now, now).first<{
            workspace_id: string;
            role: 'nurse' | 'caller';
        }>();
        if (!invite)
            throw new HttpError(410, 'Invitation expired or already used');
        workspaceId = invite.workspace_id;
        role = invite.role;
    }
    else {
        await bindings.DB.batch([bindings.DB.prepare('INSERT INTO workspaces(id,created_at,expires_at) VALUES(?,?,?)').bind(workspaceId, now, now + RETENTION_MS), bindings.DB.prepare('INSERT INTO template_versions(id,workspace_id,version,body_json,created_at) VALUES(?,?,?,?,?)').bind(DEFAULT_TEMPLATE.id, workspaceId, 1, JSON.stringify(DEFAULT_TEMPLATE), now)]);
    }
    await bindings.DB.batch([bindings.DB.prepare('INSERT INTO participants(id,workspace_id,role,created_at) VALUES(?,?,?,?)').bind(participantId, workspaceId, role, now), bindings.DB.prepare('INSERT INTO sessions(token_hash,workspace_id,participant_id,role,expires_at) VALUES(?,?,?,?,?)').bind(tokenHash, workspaceId, participantId, role, now + SESSION_MS)]);
    return json({ session: { workspaceId, participantId, role, expiresAt: now + SESSION_MS }, mode: bindings.PROVIDER_MODE, realtimeUrl: bindings.REALTIME_URL }, 201, { 'Set-Cookie': sessionCookie(raw, bindings) });
}
export async function invitation(request: Request) { const { bindings, user, data } = await mutation(request, ['admin']); const role = z.enum(['caller', 'nurse']).parse(data.role); await rateLimit(bindings, 'invite:' + user.workspaceId, 20, 3600000); const value = token(), expiresAt = Date.now() + 600000; await bindings.DB.prepare('INSERT INTO invitations(token_hash,workspace_id,role,expires_at) VALUES(?,?,?,?)').bind(await hash(value), user.workspaceId, role, expiresAt).run(); return json({ url: bindings.APP_ORIGIN + '/' + (role === 'caller' ? 'caller' : 'nurse') + '#invite=' + value, expiresAt }, 201); }
export async function listCalls(request: Request) { const bindings = env(), user = await session(request, bindings); const sql = user.role === 'caller' ? 'SELECT snapshot_json,updated_at FROM calls WHERE workspace_id=? AND caller_participant_id=? AND expires_at>? ORDER BY created_at' : 'SELECT snapshot_json,updated_at FROM calls WHERE workspace_id=? AND expires_at>? ORDER BY created_at'; const args = user.role === 'caller' ? [user.workspaceId, user.participantId, Date.now()] : [user.workspaceId, Date.now()]; const rows = await bindings.DB.prepare(sql).bind(...args).all<{
    snapshot_json: string;
    updated_at: number;
}>(); return json({ calls: rows.results.map(row => ({ ...JSON.parse(row.snapshot_json), projectedAt: row.updated_at })), updatedAt: Date.now() }); }
export async function createCall(request: Request) {
    const { bindings, user, data } = await mutation(request);
    const { commandId } = CommandBodySchema.parse(data);
    if (user.role === 'nurse')
        throw new HttpError(403, 'Use a caller invitation to start a call');
    const now = Date.now();
    const candidate = crypto.randomUUID();
    await bindings.DB.prepare('INSERT OR IGNORE INTO call_initializations(workspace_id,participant_id,command_id,call_id,created_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM call_initializations i LEFT JOIN calls c ON c.id=i.call_id WHERE i.workspace_id=? AND i.created_at>? AND (c.queue_state IS NULL OR c.queue_state<>\'CLOSED\'))<?').bind(user.workspaceId, user.participantId, commandId, candidate, now, user.workspaceId, now - CALL_DURATION_MS, quota(bindings.MAX_ACTIVE_CALLS_PER_WORKSPACE, 2)).run();
    const row = await bindings.DB.prepare('SELECT call_id FROM call_initializations WHERE workspace_id=? AND participant_id=? AND command_id=?').bind(user.workspaceId, user.participantId, commandId).first<{
        call_id: string;
    }>();
    if (!row)
        throw new HttpError(429, 'This demo workspace already has two active calls');
    const result = unwrap(await callObject(bindings, row.call_id).initialize({ callId: row.call_id, workspaceId: user.workspaceId, callerParticipantId: user.participantId, template: await template(bindings, user.workspaceId), mode: bindings.PROVIDER_MODE }));
    if (!result.ok)
        throw new HttpError(503, 'Call initialization pending');
    return json({ call: result.snapshot }, 201);
}
export async function detail(request: Request, id: string) { const bindings = env(), user = await session(request, bindings); return json({ ok: true, snapshot: await authoritative(bindings, user, id) }); }
export async function ticket(request: Request, id: string) { const { bindings, user, data } = await mutation(request); const call = await authoritative(bindings, user, id); const role = z.enum(['caller', 'nurse', 'observer']).parse(data.role ?? (user.role === 'caller' ? 'caller' : 'nurse')); if (role === 'caller' && call.callerParticipantId !== user.participantId)
    throw new HttpError(403, 'Caller membership required'); if (role !== 'caller' && user.role === 'caller')
    throw new HttpError(403, 'Nurse membership required'); const result = unwrap(await callObject(bindings, id).issueTicket({ workspaceId: user.workspaceId, participantId: user.participantId, role })); return json({ ...result, realtimeUrl: bindings.REALTIME_URL }); }
async function reserveAudio(bindings: AppEnv, user: Session, id: string) {
    const now = Date.now(), day = new Date().toISOString().slice(0, 10);
    const resumed = await bindings.DB.prepare('UPDATE audio_reservations SET released=0 WHERE call_id=? AND workspace_id=? AND expires_at>? AND (released=0 OR (SELECT COUNT(*) FROM audio_reservations WHERE expires_at>? AND released=0)<?) RETURNING call_id').bind(id, user.workspaceId, now, now, quota(bindings.MAX_LIVE_CONCURRENCY, 4)).first();
    if (resumed)
        return;
    const inserted = await bindings.DB.prepare('INSERT OR IGNORE INTO audio_reservations(call_id,workspace_id,day,minutes,expires_at) SELECT ?,?,?,10,? WHERE (SELECT COUNT(*) FROM audio_reservations WHERE expires_at>? AND released=0)<? AND (SELECT COALESCE(SUM(minutes),0) FROM audio_reservations WHERE day=?)<=? RETURNING call_id').bind(id, user.workspaceId, day, now + CALL_DURATION_MS, now, quota(bindings.MAX_LIVE_CONCURRENCY, 4), day, quota(bindings.DAILY_AUDIO_MINUTES, 120) - 10).first();
    if (!inserted)
        throw new HttpError(429, 'Live demonstration audio quota reached. Human access remains available');
}
export async function command(request: Request, id: string, type: string) { const { bindings, user, data } = await mutation(request); const parsed = CommandBodySchema.parse(data); const call = await authoritative(bindings, user, id); if (['claim', 'takeover', 'review', 'intake', 'acknowledge-escalation'].includes(type) && !staff.includes(user.role as 'admin' | 'nurse'))
    throw new HttpError(403, 'Nurse membership required'); if (type === 'delete' && user.role !== 'admin')
    throw new HttpError(403, 'Demo administrator required'); if (['consent', 'mock-turn'].includes(type) && call.callerParticipantId !== user.participantId)
    throw new HttpError(403, 'Caller membership required'); if (type === 'consent') {
    z.boolean().parse(data.accepted);
    if (data.accepted && bindings.PROVIDER_MODE === 'live') {
        if (data.recordingAccepted !== true || data.recordingDisclosureVersion !== RECORDING_DISCLOSURE_VERSION) throw new HttpError(400, 'Current recording disclosure consent is required');
        const healthResponse = await bindings.REALTIME.fetch('https://internal/health');
        const health = await healthResponse.json() as {liveActivation?: {ready: boolean}};
        if (!health.liveActivation?.ready) throw new HttpError(503, 'Live Voice Agent activation is blocked pending provider compatibility and recording controls. You can request a nurse.');
        await reserveAudio(bindings, user, id);
    }
} if (type === 'mock-turn' && bindings.PROVIDER_MODE !== 'mock')
    throw new HttpError(403, 'Replay is unavailable in live mode'); const { commandId, expectedRevision, ...payload } = parsed; return json(unwrap(await callObject(bindings, id).command({ workspaceId: user.workspaceId, participantId: user.participantId, role: user.role, commandId, expectedRevision, type, payload }))); }
export async function settings(request: Request) { const bindings = env(), user = await session(request, bindings, ['admin', 'nurse']); const row = await bindings.DB.prepare('SELECT settings_json FROM workspaces WHERE id=?').bind(user.workspaceId).first<{
    settings_json: string;
}>(); let providers = { voiceAgent: { configured: false, verified: false }, extraction: { configured: false, verified: false } }; const recording = {provider: 'assemblyai', enabled: bindings.PROVIDER_MODE === 'live', disclosureVersion: RECORDING_DISCLOSURE_VERSION, retentionVerified: false, deletionVerified: false}; try {
    const health = await bindings.REALTIME.fetch('https://internal/health');
    const value = await health.json() as {
        providers?: typeof providers;
    };
    if (value.providers)
        providers = value.providers;
}
catch { /* Unavailable remains explicitly unverified. */ } return json({ escalationDestination: 'Demo nurse queue', ...JSON.parse(row?.settings_json ?? '{}'), retentionDays: 7, recording, template: await template(bindings, user.workspaceId), mode: bindings.PROVIDER_MODE, providers }); }
const TemplateSchema = z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(120), opening: z.string().min(1).max(1000), acknowledgments: z.array(z.string().min(1).max(500)).min(1).max(8), questions: z.array(z.object({ id: FieldSchema, field: FieldSchema, text: z.string().min(1).max(500) })).min(1).max(8) });
export async function updateSettings(request: Request) { const { bindings, user, data } = await mutation(request, ['admin']); const destination = data.escalationDestination === undefined ? undefined : z.string().min(1).max(120).parse(data.escalationDestination); if (data.recording !== undefined || data.retentionDays !== undefined && data.retentionDays !== 7)
    throw new HttpError(400, 'Provider recording is controlled by deployment configuration; application retention stays at seven days'); const statements = destination === undefined ? [] : [bindings.DB.prepare('UPDATE workspaces SET settings_json=? WHERE id=?').bind(JSON.stringify({ escalationDestination: destination }), user.workspaceId)]; if (data.template) {
    const input = TemplateSchema.parse(data.template);
    if (new Set(input.questions.map(q => q.id)).size !== input.questions.length || input.questions.some(q => q.id !== q.field))
        throw new HttpError(400, 'Template question IDs must be unique and match their fields');
    const current = await template(bindings, user.workspaceId);
    const next = { ...input, version: current.version + 1, createdAt: Date.now() };
    statements.push(bindings.DB.prepare('INSERT INTO template_versions(id,workspace_id,version,body_json,created_at) VALUES(?,?,?,?,?)').bind(input.id, user.workspaceId, next.version, JSON.stringify(next), Date.now()));
} if (statements.length > 0) await bindings.DB.batch(statements); return settings(request); }
export async function exportCase(request: Request, id: string) {
    const { bindings, user, data } = await mutation(request, ['admin', 'nurse']);
    const call = await authoritative(bindings, user, id);
    const format = z.enum(['json', 'markdown']).parse(data.format ?? 'json');
    const exportId = crypto.randomUUID(), key = user.workspaceId + '/' + id + '/' + exportId + '.' + (format === 'json' ? 'json' : 'md');
    const expiresAt = call.expiresAt;
    unwrap(await callObject(bindings, id).reserveExport({ workspaceId: user.workspaceId, exportId, key, expiresAt }));
    await bindings.DB.prepare('INSERT INTO exports(id,call_id,workspace_id,object_key,status,expires_at) VALUES(?,?,?,?,?,?)').bind(exportId, id, user.workspaceId, key, 'pending', expiresAt).run();
    const content = format === 'json' ? JSON.stringify(call, null, 2) : ['# NurseBridge synthetic case', 'Simulation only — use fictional patient information. Not for medical care.', ...call.facts.map(f => `\n## ${f.field}\n${f.value}\nStatus: ${f.status}\n${f.evidence.map(e => `Source ${e.turnId}: ${e.quote}`).join('\n')}`)].join('\n');
    await bindings.EXPORTS.put(key, content, { httpMetadata: { contentType: format === 'json' ? 'application/json' : 'text/markdown' } });
    const finalized = await callObject(bindings, id).finalizeExport({ workspaceId: user.workspaceId, exportId, key });
    if (!finalized.ok) {
        await bindings.EXPORTS.delete(key);
        throw new HttpError(410, 'Case was deleted while exporting');
    }
    await bindings.DB.prepare('UPDATE exports SET status=\'ready\' WHERE id=? AND workspace_id=? AND NOT EXISTS(SELECT 1 FROM deletion_tombstones WHERE call_id=?)').bind(exportId, user.workspaceId, id).run();
    return json({ id: exportId, url: '/api/calls/' + id + '/export/' + exportId, expiresAt }, 201);
}
export async function downloadExport(request: Request, id: string, exportId: string) { const bindings = env(), user = await session(request, bindings, ['admin', 'nurse']); await authoritative(bindings, user, id); const row = await bindings.DB.prepare('SELECT object_key FROM exports WHERE id=? AND call_id=? AND workspace_id=? AND status=\'ready\' AND expires_at>? AND NOT EXISTS(SELECT 1 FROM deletion_tombstones WHERE call_id=?)').bind(exportId, id, user.workspaceId, Date.now(), id).first<{
    object_key: string;
}>(); if (!row)
    throw new HttpError(404, 'Export not found'); const object = await bindings.EXPORTS.get(row.object_key); if (!object)
    throw new HttpError(404, 'Export expired'); return new Response(object.body, { headers: { 'Cache-Control': 'private, no-store', 'Content-Type': object.httpMetadata?.contentType ?? 'application/json', 'Content-Disposition': 'attachment; filename="synthetic-case.' + (row.object_key.endsWith('.md') ? 'md' : 'json') + '"', 'X-Content-Type-Options': 'nosniff' } }); }
