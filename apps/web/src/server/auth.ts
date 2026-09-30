import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Session, Role } from '@nursebridge/contracts';
import type { AppEnv } from './env';
import { HttpError } from './http';
const COOKIE = 'nb_session';
const STAFF_COOKIE = 'nb_staff_session';
const CALLER_COOKIE = 'nb_caller_session';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
let accessKeys: { issuer: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

/** Hosted self-service and local enrollment require explicit, exact-origin configuration. */
export function enrollmentMode(request: Request, bindings: AppEnv): 'sandbox' | 'public' | 'closed' {
    if (bindings.PUBLIC_WORKSPACE_ACCESS === 'true') {
        if (bindings.ACCESS_ISSUER || bindings.ACCESS_AUDIENCE) return 'closed';
        try {
            const configured = new URL(bindings.APP_ORIGIN);
            const actual = new URL(request.url);
            if (configured.protocol === 'https:' && configured.origin === bindings.APP_ORIGIN
                && actual.origin === configured.origin) return 'public';
        } catch { return 'closed'; }
    }
    if (bindings.ALLOW_LOCAL_SANDBOX_ENROLLMENT !== 'true' || bindings.ACCESS_ISSUER || bindings.ACCESS_AUDIENCE)
        return 'closed';
    try {
        const configured = new URL(bindings.APP_ORIGIN);
        const actual = new URL(request.url);
        return configured.protocol === 'http:' && LOOPBACK_HOSTS.has(configured.hostname)
            && configured.origin === bindings.APP_ORIGIN && actual.origin === configured.origin ? 'sandbox' : 'closed';
    }
    catch { return 'closed'; }
}

export async function requireStaffAccess(request: Request, bindings: AppEnv, workspaceId?: string): Promise<void> {
    const enrollment = enrollmentMode(request, bindings);
    if (enrollment === 'sandbox') return;
    // Existing protected memberships and invitations retain their Access requirement.
    if (enrollment === 'public' && workspaceId) {
        const workspace = await bindings.DB.prepare("SELECT json_extract(settings_json,'$.publicAccess') AS public_access FROM workspaces WHERE id=? AND expires_at>?").bind(workspaceId, Date.now()).first<{ public_access: number | null }>();
        if (workspace?.public_access === 1) return;
        throw new HttpError(401, 'Open a new workspace');
    }
    const issuer = bindings.ACCESS_ISSUER;
    const audience = bindings.ACCESS_AUDIENCE;
    try {
        if (!issuer || !audience || audience.trim() !== audience || /\s/.test(audience) || audience.length > 512)
            throw new Error('Missing Access configuration');
        const parsed = new URL(issuer);
        if (parsed.protocol !== 'https:' || parsed.origin !== issuer)
            throw new Error('Invalid Access issuer');
    }
    catch { throw new HttpError(503, 'Staff authentication is not configured'); }
    const jwt = request.headers.get('cf-access-jwt-assertion');
    if (!jwt) throw new HttpError(403, 'Staff Access authentication required');
    try {
        // Reuse one issuer's bounded JWKS cache across requests in this Worker isolate.
        if (accessKeys?.issuer !== issuer)
            accessKeys = { issuer, keys: createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer)) };
        const { payload } = await jwtVerify(jwt, accessKeys.keys, {
            issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'],
        });
        if (typeof payload.sub !== 'string' || !payload.sub.trim()) throw new Error('Staff identity required');
    }
    catch { throw new HttpError(403, 'Invalid staff Access identity'); }
}

export async function hash(value: string) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join(''); }
export function token() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join(''); }
export function origin(request: Request, bindings: AppEnv) { const allowed = new Set([bindings.APP_ORIGIN]); if (bindings.APP_ORIGIN.startsWith('http://localhost:'))
    allowed.add('http://localhost:3000'); if (!allowed.has(request.headers.get('origin') ?? ''))
    throw new HttpError(403, 'Origin is not allowed'); }
type SessionCookieName = typeof COOKIE | typeof STAFF_COOKIE | typeof CALLER_COOKIE;
function cookieValue(request: Request, name: SessionCookieName): string | undefined {
    return request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='))?.slice(name.length + 1);
}
async function storedSession(value: string, bindings: AppEnv): Promise<Session | undefined> {
    const row = await bindings.DB.prepare('SELECT s.workspace_id,s.participant_id,s.role,s.expires_at FROM sessions s JOIN workspaces w ON w.id=s.workspace_id JOIN participants p ON p.id=s.participant_id AND p.workspace_id=s.workspace_id AND p.role=s.role WHERE s.token_hash=? AND s.expires_at>? AND w.expires_at>?').bind(await hash(value), Date.now(), Date.now()).first<{
        workspace_id: string;
        participant_id: string;
        role: Role;
        expires_at: number;
    }>();
    if (row) return { workspaceId: row.workspace_id, participantId: row.participant_id, role: row.role, expiresAt: row.expires_at };
}
export async function session(request: Request, bindings: AppEnv, roles?: Role[]): Promise<Session> {
    const view = request.headers.get('x-nursebridge-view');
    const staffOnly = roles?.every(role => role === 'admin' || role === 'nurse');
    type Candidate = [SessionCookieName, Role[]];
    const staffCandidates: Candidate[] = [[STAFF_COOKIE, ['admin', 'nurse']], [COOKIE, ['admin', 'nurse']], [COOKIE, ['caller']], [CALLER_COOKIE, ['caller']]];
    const candidates: Candidate[] = view === 'caller'
        ? [[CALLER_COOKIE, ['caller']], [COOKIE, ['caller']], [STAFF_COOKIE, ['admin']], [COOKIE, ['admin', 'nurse']]]
        : view === 'staff' || staffOnly ? staffCandidates
            : [[COOKIE, ['admin', 'nurse', 'caller']], [STAFF_COOKIE, ['admin', 'nurse']], [CALLER_COOKIE, ['caller']]];
    const read = new Map<string, Promise<Session | undefined>>();
    let hasCookie = false;
    for (const [name, allowed] of candidates) {
        const value = cookieValue(request, name);
        if (!value) continue;
        hasCookie = true;
        if (!read.has(value)) read.set(value, storedSession(value, bindings));
        const user = await read.get(value);
        // Cookie names and the view header select an existing identity; only
        // verified database membership can establish that identity's role.
        if (!user || !allowed.includes(user.role)) continue;
        if (roles && !roles.includes(user.role)) throw new HttpError(403, 'This action requires a staff role');
        if (user.role !== 'caller') await requireStaffAccess(request, bindings, user.workspaceId);
        return user;
    }
    throw new HttpError(401, hasCookie ? 'Workspace session expired' : 'Workspace access is required');
}
export function sessionCookie(value: string, bindings: AppEnv, role?: Role, maxAge = 14400) {
    const name = role === 'caller' ? CALLER_COOKIE : role ? STAFF_COOKIE : COOKIE;
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${bindings.APP_ORIGIN.startsWith('https:') ? '; Secure' : ''}`;
}
/** Preserve a pre-upgrade identity before replacing the legacy cookie. Copying
 * its already-held token grants no new authority; staff use still checks Access. */
export async function preserveLegacySessionCookie(request: Request, bindings: AppEnv, newRole: Role): Promise<string | undefined> {
    const value = cookieValue(request, COOKIE);
    if (!value) return;
    const user = await storedSession(value, bindings);
    if (!user || (user.role === 'caller') === (newRole === 'caller')) return;
    const name = user.role === 'caller' ? CALLER_COOKIE : STAFF_COOKIE;
    const held = cookieValue(request, name);
    const existing = held ? await storedSession(held, bindings) : undefined;
    if (existing && (existing.role === 'caller') === (user.role === 'caller')) return;
    return sessionCookie(value, bindings, user.role, Math.max(1, Math.floor((user.expiresAt - Date.now()) / 1000)));
}
export async function rateLimit(bindings: AppEnv, key: string, max: number, windowMs: number) { const start = Math.floor(Date.now() / windowMs) * windowMs; const row = await bindings.DB.prepare('INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count').bind(key, start).first<{
    count: number;
}>(); if (!row || row.count > max)
    throw new HttpError(429, 'Request limit reached; try again later'); }
