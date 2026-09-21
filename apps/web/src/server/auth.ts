import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Session, Role } from '@nursebridge/contracts';
import type { AppEnv } from './env';
import { HttpError } from './http';
const COOKIE = 'nb_session';
export async function hash(value: string) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join(''); }
export function token() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join(''); }
export function origin(request: Request, bindings: AppEnv) { const allowed = new Set([bindings.APP_ORIGIN]); if (bindings.APP_ORIGIN.startsWith('http://localhost:'))
    allowed.add('http://localhost:3000'); if (!allowed.has(request.headers.get('origin') ?? ''))
    throw new HttpError(403, 'Origin is not allowed'); }
export async function session(request: Request, bindings: AppEnv, roles?: Role[]): Promise<Session> {
    const cookie = request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (!cookie)
        throw new HttpError(401, 'Create or join a demo workspace first');
    const row = await bindings.DB.prepare('SELECT s.workspace_id,s.participant_id,s.role,s.expires_at FROM sessions s JOIN workspaces w ON w.id=s.workspace_id JOIN participants p ON p.id=s.participant_id AND p.workspace_id=s.workspace_id AND p.role=s.role WHERE s.token_hash=? AND s.expires_at>? AND w.expires_at>?').bind(await hash(cookie), Date.now(), Date.now()).first<{
        workspace_id: string;
        participant_id: string;
        role: Role;
        expires_at: number;
    }>();
    if (!row)
        throw new HttpError(401, 'Demo session expired');
    if (roles && !roles.includes(row.role))
        throw new HttpError(403, 'This action requires a staff role');
    if (row.role !== 'caller' && bindings.ACCESS_ISSUER && bindings.ACCESS_AUDIENCE) {
        const jwt = request.headers.get('cf-access-jwt-assertion');
        if (!jwt)
            throw new HttpError(403, 'Staff Access authentication required');
        try {
            await jwtVerify(jwt, createRemoteJWKSet(new URL('/cdn-cgi/access/certs', bindings.ACCESS_ISSUER)), { issuer: bindings.ACCESS_ISSUER, audience: bindings.ACCESS_AUDIENCE });
        }
        catch {
            throw new HttpError(403, 'Invalid staff Access identity');
        }
    }
    return { workspaceId: row.workspace_id, participantId: row.participant_id, role: row.role, expiresAt: row.expires_at };
}
export function sessionCookie(value: string, bindings: AppEnv) { return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=14400${bindings.APP_ORIGIN.startsWith('https:') ? '; Secure' : ''}`; }
export async function rateLimit(bindings: AppEnv, key: string, max: number, windowMs: number) { const start = Math.floor(Date.now() / windowMs) * windowMs; const row = await bindings.DB.prepare('INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count').bind(key, start).first<{
    count: number;
}>(); if (!row || row.count > max)
    throw new HttpError(429, 'Demo request limit reached; try again later'); }
