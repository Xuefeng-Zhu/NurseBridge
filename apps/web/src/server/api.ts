import { z } from 'zod';
import { workspacePreferences, WorkspacePreferencesSchema, automatedIntakeAllowed, type DemoSettings } from '@nursebridge/contracts';
import { CommandBodySchema, FieldSchema, DISCLOSURE, RECORDING_DISCLOSURE_VERSION, type Session, type IntakeTemplate } from '@nursebridge/contracts';
import { DEFAULT_TEMPLATE } from '@nursebridge/intake-policy';
import { RETENTION_MS, SESSION_MS, CALL_DURATION_MS } from '@nursebridge/database';
import { env, callObject, type AppEnv } from './env';
import { session, origin, hash, token, sessionCookie, rateLimit, enrollmentMode, requireStaffAccess, preserveLegacySessionCookie } from './auth';
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
    const enrollment = enrollmentMode(request, bindings);
    const localStaffAccess = z.boolean().optional().parse(data.localStaffAccess) === true;
    if (localStaffAccess && enrollmentMode(request, bindings) !== 'sandbox')
        throw new HttpError(403, 'Local staff access is available only in an enabled local sandbox');
    if (localStaffAccess && data.invitation) throw new HttpError(400, 'Open the invitation before switching local roles');
    if (!data.invitation && enrollment === 'closed')
        throw new HttpError(403, 'Workspace creation is available only in an enabled local sandbox');
    const now = Date.now();
    await rateLimit(bindings, 'session:' + await hash(request.headers.get('cf-connecting-ip') ?? 'local'), 30, 3600000);
    if (bindings.TURNSTILE_SECRET_KEY) {
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: bindings.TURNSTILE_SECRET_KEY, response: z.string().parse(data.turnstileToken) }) });
        const checked = await response.json() as {
            success: boolean;
            hostname?: string;
        };
        if (!checked.success || checked.hostname !== new URL(bindings.APP_ORIGIN).hostname)
            throw new HttpError(403, 'Verification failed');
    }
    let recoveredWorkspaceId: string | undefined;
    if (localStaffAccess) {
        const headers = new Headers(request.headers);
        headers.set('X-NurseBridge-View', 'staff');
        // This path is guarded by exact loopback sandbox enrollment above.
        // Reuse a held staff identity; do not create participants on each reload.
        const staffRequest = new Request(request.url, { headers });
        const existing = await session(staffRequest, bindings);
        if (existing.role !== 'caller') return json({ session: existing, mode: bindings.PROVIDER_MODE, realtimeUrl: bindings.REALTIME_URL });
        headers.set('X-NurseBridge-View', 'caller');
        const caller = await session(new Request(request.url, { headers }), bindings, ['caller']);
        recoveredWorkspaceId = caller.workspaceId;
    }
    const participantId = crypto.randomUUID();
    let workspaceId = recoveredWorkspaceId ?? crypto.randomUUID();
    let role: 'admin' | 'nurse' | 'caller' = 'admin';
    const raw = token();
    const tokenHash = await hash(raw);
    if (data.invitation) {
        const invitationHash = await hash(z.string().min(32).max(128).parse(data.invitation));
        const invite = await bindings.DB.prepare('SELECT workspace_id,role FROM invitations WHERE token_hash=? AND redeemed_by IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM workspaces WHERE id=invitations.workspace_id AND expires_at>?)').bind(invitationHash, now, now).first<{
            workspace_id: string;
            role: 'nurse' | 'caller';
        }>();
        if (!invite || !['nurse', 'caller'].includes(invite.role))
            throw new HttpError(410, 'Invitation expired or already used');
        // Authenticate staff before consuming the single-use invitation. The conditional
        // update still arbitrates concurrent redemptions after identity verification.
        if (invite.role === 'nurse') await requireStaffAccess(request, bindings, invite.workspace_id);
        const redeemedAt = Date.now();
        const redeemed = await bindings.DB.prepare('UPDATE invitations SET redeemed_by=? WHERE token_hash=? AND workspace_id=? AND role=? AND redeemed_by IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM workspaces WHERE id=invitations.workspace_id AND expires_at>?) RETURNING workspace_id,role').bind(participantId, invitationHash, invite.workspace_id, invite.role, redeemedAt, redeemedAt).first();
        if (!redeemed) throw new HttpError(410, 'Invitation expired or already used');
        workspaceId = invite.workspace_id;
        role = invite.role;
    }
    else if (!recoveredWorkspaceId) {
        await bindings.DB.batch([bindings.DB.prepare('INSERT INTO workspaces(id,created_at,expires_at,settings_json) VALUES(?,?,?,?)').bind(workspaceId, now, now + RETENTION_MS, JSON.stringify(enrollment === 'public' ? { publicAccess: true } : {})), bindings.DB.prepare('INSERT INTO template_versions(id,workspace_id,version,body_json,created_at) VALUES(?,?,?,?,?)').bind(DEFAULT_TEMPLATE.id, workspaceId, 1, JSON.stringify(DEFAULT_TEMPLATE), now)]);
    }
    await bindings.DB.batch([bindings.DB.prepare('INSERT INTO participants(id,workspace_id,role,created_at) VALUES(?,?,?,?)').bind(participantId, workspaceId, role, now), bindings.DB.prepare('INSERT INTO sessions(token_hash,workspace_id,participant_id,role,expires_at) VALUES(?,?,?,?,?)').bind(tokenHash, workspaceId, participantId, role, now + SESSION_MS)]);
    const preserved = await preserveLegacySessionCookie(request, bindings, role);
    const response = json({ session: { workspaceId, participantId, role, expiresAt: now + SESSION_MS }, mode: bindings.PROVIDER_MODE, realtimeUrl: bindings.REALTIME_URL }, 201);
    response.headers.append('Set-Cookie', sessionCookie(raw, bindings));
    response.headers.append('Set-Cookie', sessionCookie(raw, bindings, role));
    if (preserved) response.headers.append('Set-Cookie', preserved);
    return response;
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
        throw new HttpError(429, 'This workspace has reached its active call limit');
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
        throw new HttpError(429, 'Live audio quota reached. Human access remains available');
}
export async function command(request: Request, id: string, type: string) { const { bindings, user, data } = await mutation(request); const parsed = CommandBodySchema.parse(data); const call = await authoritative(bindings, user, id); if (['claim', 'takeover', 'review', 'intake', 'acknowledge-escalation'].includes(type) && !staff.includes(user.role as 'admin' | 'nurse'))
    throw new HttpError(403, 'Nurse membership required'); if (type === 'delete' && user.role !== 'admin')
    throw new HttpError(403, 'Workspace administrator required'); if (['consent', 'mock-turn'].includes(type) && call.callerParticipantId !== user.participantId)
    throw new HttpError(403, 'Caller membership required'); if (type === 'consent') {
    z.boolean().parse(data.accepted);
    if (data.accepted && call.workspacePreferences && !automatedIntakeAllowed(call.workspacePreferences, call.mode)) throw new HttpError(409, 'Automated intake is disabled for this call. Request a nurse.');
    if (data.accepted && call.mode === 'live') {
        if (data.recordingAccepted !== true || data.recordingDisclosureVersion !== RECORDING_DISCLOSURE_VERSION) throw new HttpError(400, 'Current recording disclosure consent is required');
        const healthResponse = await bindings.REALTIME.fetch('https://internal/health');
        const health = await healthResponse.json() as {liveActivation?: {ready: boolean}};
        if (!health.liveActivation?.ready) throw new HttpError(503, 'Live Voice Agent activation is blocked pending provider compatibility and recording controls. You can request a nurse.');
        await reserveAudio(bindings, user, id);
    }
} if (type === 'mock-turn' && bindings.PROVIDER_MODE !== 'mock')
    throw new HttpError(403, 'Replay is unavailable in live mode'); const { commandId, expectedRevision, ...payload } = parsed; return json(unwrap(await callObject(bindings, id).command({ workspaceId: user.workspaceId, participantId: user.participantId, role: user.role, commandId, expectedRevision, type, payload }))); }
async function settingsValue(bindings: AppEnv, workspaceId: string): Promise<DemoSettings> {
    const row = await bindings.DB.prepare('SELECT settings_json,expires_at FROM workspaces WHERE id=?').bind(workspaceId).first<{settings_json: string; expires_at: number}>();
    if (!row) throw new HttpError(404, 'Workspace not found');
    const stored = JSON.parse(row.settings_json);
    const preferences = workspacePreferences(stored);
    const providers = { voiceAgent: { configured: false, verified: false }, extraction: { configured: false, verified: false } };
    let value = { providers, liveActivation: { ready: false, issues: ['service_status_unavailable'] }, phoneInbound: { enabled: false, configured: false }, phoneNumbers: [] as string[] };
    try {
        const response = await bindings.REALTIME.fetch('https://internal/health?workspaceId=' + encodeURIComponent(workspaceId));
        if (!response.ok) throw new Error('Health unavailable');
        value = { ...value, ...await response.json() as Partial<typeof value> };
    } catch { /* Keep unavailable status visible. */ }
    const blockers = bindings.PROVIDER_MODE === 'mock' ? [] : [...value.liveActivation.issues];
    if (!preferences.automatedIntake) blockers.push('workspace_automated_intake_disabled');
    if (bindings.PROVIDER_MODE === 'live' && !preferences.recordingAllowed) blockers.push('recording_off_requires_nurse_only');
    const phoneAvailable = value.phoneInbound.enabled && value.phoneInbound.configured && value.phoneNumbers.length > 0;
    return { revision: stored.revision ?? 0, preferences, workspaceExpiresAt: row.expires_at,
        escalationDestination: preferences.escalationDestination, retentionDays: preferences.retentionDays,
        template: await template(bindings, workspaceId), mode: bindings.PROVIDER_MODE, providers: value.providers,
        capabilities: { automatedIntake: blockers.length === 0, blockers, phoneNumbers: value.phoneNumbers, phoneAvailable, checkedAt: Date.now() },
        phoneInbound: { provider: 'twilio', configured: phoneAvailable, enabled: phoneAvailable && preferences.phoneEnabled },
        recording: { provider: 'assemblyai', enabled: bindings.PROVIDER_MODE === 'live' && blockers.length === 0 && preferences.recordingAllowed && preferences.automatedIntake, disclosureVersion: RECORDING_DISCLOSURE_VERSION, retentionVerified: false, deletionVerified: false },
    };
}
export async function settings(request: Request) {
    const bindings = env(), user = await session(request, bindings, ['admin', 'nurse']);
    return json(await settingsValue(bindings, user.workspaceId));
}
const TemplateSchema = z.object({ id: z.string().min(1).max(64), name: z.string().trim().min(1).max(100), opening: z.string().trim().min(1).max(500), acknowledgments: z.array(z.string().trim().min(1).max(500)).min(1).max(8), questions: z.array(z.object({ id: FieldSchema, field: FieldSchema, text: z.string().trim().min(1).max(500) })).min(1).max(8) });
const SettingsPatchSchema = WorkspacePreferencesSchema.partial().extend({ commandId: z.string().uuid().optional(), expectedRevision: z.number().int().nonnegative().optional(), template: TemplateSchema.optional() }).strict();
export async function updateSettings(request: Request) {
    const { bindings, user, data } = await mutation(request, ['admin']);
    const parsed = SettingsPatchSchema.parse(data);
    const { expectedRevision, template: input } = parsed;
    const patch = WorkspacePreferencesSchema.partial().parse(parsed);
    const row = await bindings.DB.prepare('SELECT settings_json FROM workspaces WHERE id=?').bind(user.workspaceId).first<{settings_json: string}>();
    if (!row) throw new HttpError(404, 'Workspace not found');
    const stored = JSON.parse(row.settings_json), revision = stored.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new HttpError(409, 'Settings changed in another session. Refresh settings before saving again. Your drafts are preserved.');
    const preferences = workspacePreferences({ ...stored, ...patch });
    const statements = [];
    if (input) {
        if (new Set(input.questions.map(q => q.id)).size !== input.questions.length || input.questions.some(q => q.id !== q.field)) throw new HttpError(400, 'Template question IDs must be unique and match their fields');
        const current = await template(bindings, user.workspaceId);
        const next = { ...input, version: current.version + 1, createdAt: Date.now() };
        statements.push(bindings.DB.prepare('INSERT INTO template_versions(id,workspace_id,version,body_json,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=? AND settings_json=?)').bind(input.id, user.workspaceId, next.version, JSON.stringify(next), next.createdAt, user.workspaceId, row.settings_json));
    }
    statements.push(bindings.DB.prepare('UPDATE workspaces SET settings_json=?,expires_at=MAX(expires_at,?) WHERE id=? AND settings_json=?').bind(JSON.stringify({ ...stored, ...preferences, revision: revision + 1 }), Date.now() + preferences.retentionDays * 86400000, user.workspaceId, row.settings_json));
    const results = await bindings.DB.batch(statements);
    if (!results.at(-1)?.meta.changes) throw new HttpError(409, 'Settings changed in another session. Refresh settings before saving again. Your drafts are preserved.');
    return json(await settingsValue(bindings, user.workspaceId));
}
export async function exportCase(request: Request, id: string) {
    const { bindings, user, data } = await mutation(request, ['admin', 'nurse']);
    const format = z.enum(['json', 'markdown']).parse(data.format ?? 'json');
    const call = await authoritative(bindings, user, id);
    // Do not depend on the retention alarm having run before serving a download.
    if (call.expiresAt <= Date.now()) throw new HttpError(410, 'Case retention expired');
    const content = format === 'json' ? JSON.stringify(call, null, 2) : ['# NurseBridge case', DISCLOSURE, ...call.facts.map(f => `\n## ${f.field}\n${f.value}\nStatus: ${f.status}\n${f.evidence.map(e => `Source ${e.turnId}: ${e.quote}`).join('\n')}`)].join('\n');
    return new Response(content, { headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="nursebridge-${id}.${format === 'json' ? 'json' : 'md'}"`,
        'X-Content-Type-Options': 'nosniff',
    } });
}
export async function downloadExport(request: Request, id: string): Promise<never> {
    const bindings = env(), user = await session(request, bindings, ['admin', 'nurse']);
    await authoritative(bindings, user, id);
    throw new HttpError(410, 'Saved export links are no longer available. Export the case again to download a fresh copy.');
}
