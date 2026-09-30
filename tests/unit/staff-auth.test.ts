import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../apps/web/src/server/env';
import { enrollmentMode, hash, session } from '../../apps/web/src/server/auth';
import { createSession } from '../../apps/web/src/server/api';

const runtime = vi.hoisted(() => ({ bindings: undefined as unknown as AppEnv }));
vi.mock('../../apps/web/src/server/env', () => ({ env: () => runtime.bindings, callObject: vi.fn() }));

const issuer = 'https://staff-auth-test.cloudflareaccess.com';
const audience = 'synthetic-staff-application';
const localOrigin = 'http://localhost:8787';
const hostedOrigin = 'https://nursebridge.example';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const participantId = '22222222-2222-4222-8222-222222222222';
const invitationToken = 'synthetic-invitation-'.padEnd(64, '0');
const sessionToken = 'synthetic-session-'.padEnd(64, '0');
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const migration = readFileSync(new URL('../../packages/database/migrations/0001_initial.sql', import.meta.url), 'utf8');
let database: DatabaseSync;

// Use the real SQLite schema and queries without a Workers runtime or network.
class Statement {
    private values: SQLInputValue[] = [];
    constructor(private readonly sql: string) {}
    bind(...values: SQLInputValue[]) { this.values = values; return this; }
    async first() { return database.prepare(this.sql).get(...this.values) ?? null; }
    async run() { return database.prepare(this.sql).run(...this.values); }
}

function bindings(overrides: Partial<AppEnv> = {}): AppEnv {
    return {
        APP_ORIGIN: hostedOrigin, PROVIDER_MODE: 'mock', REALTIME_URL: 'wss://realtime.example',
        DB: {
            prepare: (sql: string) => new Statement(sql),
            batch: async (statements: Statement[]) => {
                database.exec('BEGIN');
                try {
                    const result = [];
                    for (const statement of statements) result.push(await statement.run());
                    database.exec('COMMIT');
                    return result;
                } catch (error) { database.exec('ROLLBACK'); throw error; }
            },
        } as unknown as AppEnv['DB'],
        ...overrides,
    } as AppEnv;
}

function jwt(overrides: Record<string, unknown> = {}, algorithm = 'RS256') {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: algorithm, kid: 'test-key' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: [audience], sub: 'synthetic-staff-user', iat: now, exp: now + 600, ...overrides })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key.privateKey).toString('base64url')}`;
}

function request(options: { origin?: string; accessToken?: string; cookie?: boolean; cookies?: string; view?: string; data?: unknown } = {}) {
    const origin = options.origin ?? runtime.bindings.APP_ORIGIN;
    return new Request(`${origin}/api/demo/session`, {
        method: options.data === undefined ? 'GET' : 'POST',
        headers: {
            Origin: origin,
            ...(options.cookie ? { Cookie: `nb_session=${sessionToken}` } : {}),
            ...(options.cookies ? { Cookie: options.cookies } : {}),
            ...(options.view ? { 'X-NurseBridge-View': options.view } : {}),
            ...(options.accessToken ? { 'cf-access-jwt-assertion': options.accessToken } : {}),
            ...(options.data === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(options.data === undefined ? {} : { body: JSON.stringify(options.data) }),
    });
}

function count(table: 'workspaces' | 'participants' | 'sessions') {
    return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count;
}
function seedWorkspace(expiresAt = Date.now() + 3600000) {
    database.prepare('INSERT INTO workspaces(id,created_at,expires_at) VALUES(?,?,?)').run(workspaceId, Date.now(), expiresAt);
}
async function seedSession(role: 'admin' | 'nurse' | 'caller') {
    seedWorkspace();
    database.prepare('INSERT INTO participants(id,workspace_id,role,created_at) VALUES(?,?,?,?)').run(participantId, workspaceId, role, Date.now());
    database.prepare('INSERT INTO sessions(token_hash,workspace_id,participant_id,role,expires_at) VALUES(?,?,?,?,?)').run(await hash(sessionToken), workspaceId, participantId, role, Date.now() + 3600000);
}
async function seedInvitation(role: string, expiresAt = Date.now() + 600000) {
    seedWorkspace();
    database.prepare('INSERT INTO invitations(token_hash,workspace_id,role,expires_at) VALUES(?,?,?,?)').run(await hash(invitationToken), workspaceId, role, expiresAt);
}
function redeemedBy() { return database.prepare('SELECT redeemed_by FROM invitations').get()!.redeemed_by; }

beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(migration);
    runtime.bindings = bindings();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== `${issuer}/cdn-cgi/access/certs`) throw new Error('Unexpected network request');
        return Response.json({ keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] });
    }));
});
afterEach(() => { database.close(); vi.unstubAllGlobals(); });

describe('explicit local sandbox enrollment', () => {
    it.each(['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'])('allows an opted-in exact loopback origin: %s', origin => {
        runtime.bindings = bindings({ APP_ORIGIN: origin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true' });
        expect(enrollmentMode(request(), runtime.bindings)).toBe('sandbox');
    });

    it.each([
        [localOrigin, localOrigin, undefined],
        [localOrigin, localOrigin, 'false'],
        [hostedOrigin, hostedOrigin, 'true'],
        ['https://localhost:8787', 'https://localhost:8787', 'true'],
        [localOrigin, hostedOrigin, 'true'],
        [hostedOrigin, localOrigin, 'true'],
        [localOrigin, 'http://localhost:3000', 'true'],
        ['http://localhost.evil.example:8787', 'http://localhost.evil.example:8787', 'true'],
        ['http://localhost:8787/path', localOrigin, 'true'],
    ])('stays closed for configuration %s, actual URL %s and flag %s', (configured, actual, flag) => {
        runtime.bindings = bindings({ APP_ORIGIN: configured, ALLOW_LOCAL_SANDBOX_ENROLLMENT: flag });
        const incoming = request({ origin: actual });
        incoming.headers.set('Origin', localOrigin);
        incoming.headers.set('X-Forwarded-Host', 'localhost:8787');
        expect(enrollmentMode(incoming, runtime.bindings)).toBe('closed');
    });

    it('creates a usable local admin session only when explicitly enabled', async () => {
        runtime.bindings = bindings({ APP_ORIGIN: localOrigin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true' });
        const response = await createSession(request({ data: {} }));
        expect(response.status).toBe(201);
        expect((await response.json()).session.role).toBe('admin');
        const cookie = response.headers.get('Set-Cookie')!;
        expect(cookie).toContain('HttpOnly; SameSite=Lax');
        const authenticated = request();
        authenticated.headers.set('Cookie', cookie.split(';')[0]!);
        await expect(session(authenticated, runtime.bindings)).resolves.toMatchObject({ role: 'admin' });
        expect(count('workspaces')).toBe(1);
        expect(count('participants')).toBe(1);
        expect(count('sessions')).toBe(1);
    });

    it.each([localOrigin, hostedOrigin])('denies bootstrap without writing workspace data at %s', async origin => {
        runtime.bindings = bindings({ APP_ORIGIN: origin });
        await expect(createSession(request({ data: {} }))).rejects.toMatchObject({ status: 403 });
        expect(count('workspaces')).toBe(0);
        expect(count('participants')).toBe(0);
        expect(count('sessions')).toBe(0);
    });

    it('never enables hosted bootstrap, even with an enabled flag and valid staff identity', async () => {
        runtime.bindings = bindings({ ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true', ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience });
        await expect(createSession(request({ data: {}, accessToken: jwt() }))).rejects.toMatchObject({ status: 403 });
        expect(count('workspaces')).toBe(0);
    });
});

describe('staff Access authentication', () => {
    it.each([
        {}, { ACCESS_ISSUER: issuer }, { ACCESS_AUDIENCE: audience },
        { ACCESS_ISSUER: '', ACCESS_AUDIENCE: audience },
        { ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: ' ' },
        { ACCESS_ISSUER: 'http://staff-auth-test.cloudflareaccess.com', ACCESS_AUDIENCE: audience },
        { ACCESS_ISSUER: `${issuer}/path`, ACCESS_AUDIENCE: audience },
        { ACCESS_ISSUER: 'https://user:password@staff-auth-test.cloudflareaccess.com', ACCESS_AUDIENCE: audience },
    ])('denies hosted staff sessions for missing or invalid configuration: %j', async configuration => {
        runtime.bindings = bindings(configuration);
        await seedSession('admin');
        await expect(session(request({ cookie: true, accessToken: jwt() }), runtime.bindings)).rejects.toMatchObject({ status: 503 });
    });

    it('requires Access even on loopback when either Access setting is supplied', async () => {
        runtime.bindings = bindings({ APP_ORIGIN: localOrigin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true', ACCESS_ISSUER: issuer });
        await seedSession('nurse');
        expect(enrollmentMode(request(), runtime.bindings)).toBe('closed');
        await expect(session(request({ cookie: true }), runtime.bindings)).rejects.toMatchObject({ status: 503 });
        runtime.bindings.ACCESS_AUDIENCE = audience;
        await expect(session(request({ cookie: true }), runtime.bindings)).rejects.toMatchObject({ status: 403 });
    });

    it.each(['admin', 'nurse'] as const)('requires a JWT for a configured hosted %s session', async role => {
        runtime.bindings = bindings({ ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience });
        await seedSession(role);
        await expect(session(request({ cookie: true }), runtime.bindings)).rejects.toMatchObject({ status: 403 });
        await expect(session(request({ cookie: true, accessToken: jwt() }), runtime.bindings)).resolves.toMatchObject({ role });
    });

    it.each([
        { aud: 'another-application' }, { iss: 'https://another-team.cloudflareaccess.com' },
        { exp: 1 }, { exp: undefined }, { iat: undefined }, { sub: undefined }, { sub: '' },
    ])('rejects signed tokens with invalid required claims: %j', async claims => {
        runtime.bindings = bindings({ ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience });
        await seedSession('nurse');
        await expect(session(request({ cookie: true, accessToken: jwt(claims) }), runtime.bindings)).rejects.toMatchObject({ status: 403 });
    });

    it('rejects a forged signature and an unexpected signing algorithm', async () => {
        runtime.bindings = bindings({ ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience });
        await seedSession('nurse');
        const signed = jwt();
        const forged = `${signed.slice(0, signed.lastIndexOf('.') + 1)}${Buffer.alloc(256).toString('base64url')}`;
        for (const accessToken of [forged, jwt({}, 'HS256')])
            await expect(session(request({ cookie: true, accessToken }), runtime.bindings)).rejects.toMatchObject({ status: 403 });
    });

    it('preserves caller sessions independently of staff Access configuration', async () => {
        runtime.bindings = bindings({ ACCESS_ISSUER: issuer });
        await seedSession('caller');
        await expect(session(request({ cookie: true }), runtime.bindings)).resolves.toMatchObject({ role: 'caller' });
        await expect(session(request({ cookie: true }), runtime.bindings, ['admin', 'nurse'])).rejects.toMatchObject({ status: 403 });
    });
});

describe('invitation redemption', () => {
    it.each([
        [{}, undefined, 503],
        [{ ACCESS_ISSUER: issuer }, undefined, 503],
        [{ ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience }, undefined, 403],
        [{ ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience }, 'invalid-jwt', 403],
    ] as const)('does not consume a nurse invitation when staff authentication fails: %j', async (configuration, accessToken, status) => {
        runtime.bindings = bindings(configuration);
        await seedInvitation('nurse');
        await expect(createSession(request({ data: { invitation: invitationToken }, accessToken }))).rejects.toMatchObject({ status });
        expect(redeemedBy()).toBeNull();
        expect(count('participants')).toBe(0);
        expect(count('sessions')).toBe(0);
    });

    it('redeems an authenticated nurse invitation once and establishes a protected session', async () => {
        runtime.bindings = bindings({ ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience });
        await seedInvitation('nurse');
        const accessToken = jwt();
        const response = await createSession(request({ data: { invitation: invitationToken }, accessToken }));
        expect(response.status).toBe(201);
        const result = await response.json();
        expect(result.session).toMatchObject({ workspaceId, role: 'nurse' });
        expect(redeemedBy()).toBe(result.session.participantId);
        const incoming = request({ accessToken });
        incoming.headers.set('Cookie', response.headers.get('Set-Cookie')!.split(';')[0]!);
        await expect(session(incoming, runtime.bindings)).resolves.toMatchObject({ workspaceId, role: 'nurse' });
        incoming.headers.delete('cf-access-jwt-assertion');
        await expect(session(incoming, runtime.bindings)).rejects.toMatchObject({ status: 403 });
        await expect(createSession(request({ data: { invitation: invitationToken }, accessToken }))).rejects.toMatchObject({ status: 410 });
        expect(count('participants')).toBe(1);
        expect(count('sessions')).toBe(1);
    });

    it('preserves hosted caller invitations with enrollment closed and incomplete staff configuration', async () => {
        runtime.bindings = bindings({ ACCESS_ISSUER: issuer });
        await seedInvitation('caller');
        expect(enrollmentMode(request(), runtime.bindings)).toBe('closed');
        const response = await createSession(request({ data: { invitation: invitationToken } }));
        expect(response.status).toBe(201);
        expect((await response.json()).session).toMatchObject({ workspaceId, role: 'caller' });
        const cookie = response.headers.get('Set-Cookie')!;
        expect(cookie).toContain('; Secure');
        const incoming = request();
        incoming.headers.set('Cookie', cookie.split(';')[0]!);
        await expect(session(incoming, runtime.bindings)).resolves.toMatchObject({ role: 'caller' });
        expect(count('workspaces')).toBe(1);
    });

    it('keeps concurrent caller redemptions single-use after the authorization lookup', async () => {
        await seedInvitation('caller');
        const results = await Promise.allSettled([0, 1].map(() => createSession(request({ data: { invitation: invitationToken } }))));
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 410 }) })]);
        expect(count('participants')).toBe(1);
        expect(count('sessions')).toBe(1);
    });

    it.each(['expired', 'workspace-expired', 'admin'])('rejects an invalid invitation: %s', async condition => {
        await seedInvitation(condition === 'admin' ? 'admin' : 'caller', condition === 'expired' ? 1 : Date.now() + 600000);
        if (condition === 'workspace-expired') database.prepare('UPDATE workspaces SET expires_at=1').run();
        await expect(createSession(request({ data: { invitation: invitationToken } }))).rejects.toMatchObject({ status: 410 });
        expect(redeemedBy()).toBeNull();
        expect(count('sessions')).toBe(0);
    });
});


function responseCookies(response: Response) {
    return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}
async function addSession(role: 'admin' | 'nurse' | 'caller', tokenValue = crypto.randomUUID(), expiry = Date.now() + 3600000) {
    database.prepare('INSERT OR IGNORE INTO workspaces(id,created_at,expires_at) VALUES(?,?,?)').run(workspaceId, Date.now(), Date.now() + 7 * 86400000);
    const id = crypto.randomUUID();
    database.prepare('INSERT INTO participants(id,workspace_id,role,created_at) VALUES(?,?,?,?)').run(id, workspaceId, role, Date.now());
    database.prepare('INSERT INTO sessions(token_hash,workspace_id,participant_id,role,expires_at) VALUES(?,?,?,?,?)').run(await hash(tokenValue), workspaceId, id, role, expiry);
    return { id, token: tokenValue };
}

describe('separate caller and staff sessions', () => {
    it('preserves a legacy-only staff identity when a caller invitation is opened', async () => {
        runtime.bindings = bindings({ ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience });
        await seedSession('admin');
        database.prepare('INSERT INTO invitations(token_hash,workspace_id,role,expires_at) VALUES(?,?,?,?)').run(await hash(invitationToken), workspaceId, 'caller', Date.now() + 600000);
        const response = await createSession(request({ cookie: true, data: { invitation: invitationToken } }));
        const cookies = responseCookies(response);
        expect(response.headers.getSetCookie()).toHaveLength(3);
        for (const value of response.headers.getSetCookie()) expect(value).toContain('HttpOnly; SameSite=Lax; Max-Age=');
        expect(cookies).toContain(`nb_staff_session=${sessionToken}`);
        const caller = await session(request({ cookies, view: 'caller' }), runtime.bindings);
        expect(caller.role).toBe('caller');
        expect(caller.participantId).not.toBe(participantId);
        await expect(session(request({ cookies, view: 'staff' }), runtime.bindings)).rejects.toMatchObject({ status: 403 });
        await expect(session(request({ cookies, view: 'staff', accessToken: jwt() }), runtime.bindings)).resolves.toMatchObject({ role: 'admin', participantId });
    });

    it('preserves an existing role cookie instead of overwriting it from legacy state', async () => {
        runtime.bindings = bindings({ APP_ORIGIN: localOrigin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true' });
        const held = await addSession('admin');
        const legacy = await addSession('admin');
        database.prepare('INSERT INTO invitations(token_hash,workspace_id,role,expires_at) VALUES(?,?,?,?)').run(await hash(invitationToken), workspaceId, 'caller', Date.now() + 600000);
        const response = await createSession(request({ cookies: `nb_staff_session=${held.token}; nb_session=${legacy.token}`, data: { invitation: invitationToken } }));
        expect(response.headers.getSetCookie().some(value => value.startsWith('nb_staff_session='))).toBe(false);
        const cookies = `${responseCookies(response)}; nb_staff_session=${held.token}`;
        await expect(session(request({ cookies, view: 'staff' }), runtime.bindings)).resolves.toMatchObject({ participantId: held.id });
    });

    it('preserves a legacy caller when a nurse invitation is redeemed', async () => {
        runtime.bindings = bindings({ ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience });
        await seedSession('caller');
        database.prepare('INSERT INTO invitations(token_hash,workspace_id,role,expires_at) VALUES(?,?,?,?)').run(await hash(invitationToken), workspaceId, 'nurse', Date.now() + 600000);
        const response = await createSession(request({ cookie: true, accessToken: jwt(), data: { invitation: invitationToken } }));
        const cookies = responseCookies(response);
        expect(cookies).toContain(`nb_caller_session=${sessionToken}`);
        await expect(session(request({ cookies, view: 'caller' }), runtime.bindings)).resolves.toMatchObject({ role: 'caller', participantId });
        await expect(session(request({ cookies, view: 'staff', accessToken: jwt() }), runtime.bindings)).resolves.toMatchObject({ role: 'nurse' });
    });

    it('selects two held identities independently and keeps direct requests legacy compatible', async () => {
        runtime.bindings = bindings({ APP_ORIGIN: localOrigin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true' });
        const staff = await addSession('admin'), caller = await addSession('caller');
        const cookies = `nb_staff_session=${staff.token}; nb_caller_session=${caller.token}; nb_session=${caller.token}`;
        await expect(session(request({ cookies, view: 'staff' }), runtime.bindings)).resolves.toMatchObject({ participantId: staff.id });
        await expect(session(request({ cookies, view: 'caller' }), runtime.bindings)).resolves.toMatchObject({ participantId: caller.id });
        await expect(session(request({ cookies }), runtime.bindings)).resolves.toMatchObject({ participantId: caller.id });
        // Browser download navigations do not carry the view header.
        await expect(session(request({ cookies }), runtime.bindings, ['admin', 'nurse'])).resolves.toMatchObject({ participantId: staff.id });
        await expect(session(request({ cookies, view: 'caller' }), runtime.bindings, ['admin', 'nurse'])).rejects.toMatchObject({ status: 403 });
    });

    it.each(['admin', 'nurse', 'caller'] as const)('retains legacy-cookie lookup for %s', async role => {
        runtime.bindings = bindings({ APP_ORIGIN: localOrigin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true' });
        await seedSession(role);
        await expect(session(request({ cookie: true }), runtime.bindings)).resolves.toMatchObject({ role, participantId });
        await expect(session(request({ cookie: true, view: role === 'caller' ? 'caller' : 'staff' }), runtime.bindings)).resolves.toMatchObject({ role, participantId });
    });

    it('allows the existing admin identity to make its own caller-side call', async () => {
        runtime.bindings = bindings({ APP_ORIGIN: localOrigin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true' });
        const staff = await addSession('admin');
        await expect(session(request({ cookies: `nb_staff_session=${staff.token}`, view: 'caller' }), runtime.bindings)).resolves.toMatchObject({ role: 'admin', participantId: staff.id });
    });

    it('does not trust role-cookie names or the view header as authorization', async () => {
        runtime.bindings = bindings({ APP_ORIGIN: localOrigin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true' });
        const staff = await addSession('admin'), caller = await addSession('caller');
        await expect(session(request({ cookies: `nb_staff_session=${caller.token}`, view: 'staff' }), runtime.bindings)).rejects.toMatchObject({ status: 401 });
        await expect(session(request({ cookies: `nb_caller_session=${staff.token}`, view: 'caller' }), runtime.bindings)).rejects.toMatchObject({ status: 401 });
        await expect(session(request({ cookies: `nb_session=${caller.token}`, view: 'staff' }), runtime.bindings, ['admin'])).rejects.toMatchObject({ status: 403 });
    });

    it('ignores expired role cookies and enforces membership and hosted Access on selected staff', async () => {
        runtime.bindings = bindings({ ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience });
        const expired = await addSession('admin', 'expired-staff', 1), caller = await addSession('caller');
        const cookies = `nb_staff_session=${expired.token}; nb_session=${caller.token}`;
        await expect(session(request({ cookies, view: 'staff' }), runtime.bindings)).resolves.toMatchObject({ role: 'caller' });
        const staff = await addSession('admin');
        await expect(session(request({ cookies: `nb_staff_session=${staff.token}`, view: 'staff' }), runtime.bindings)).rejects.toMatchObject({ status: 403 });
        database.prepare('UPDATE participants SET role=? WHERE id=?').run('caller', staff.id);
        await expect(session(request({ cookies: `nb_staff_session=${staff.token}`, view: 'staff', accessToken: jwt() }), runtime.bindings)).rejects.toMatchObject({ status: 401 });
    });
});

describe('explicit local staff-role recovery', () => {
    it('restores staff in the held caller workspace without replacing settings or losing the caller', async () => {
        runtime.bindings = bindings({ APP_ORIGIN: localOrigin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true' });
        await seedSession('caller');
        const settings = JSON.stringify({ escalationDestination: 'Existing local nurse desk', revision: 7 });
        database.prepare('UPDATE workspaces SET settings_json=? WHERE id=?').run(settings, workspaceId);
        database.prepare('INSERT INTO template_versions(id,workspace_id,version,body_json,created_at) VALUES(?,?,?,?,?)').run('custom', workspaceId, 3, '{"name":"Retained template"}', Date.now());
        const response = await createSession(request({ cookie: true, data: { localStaffAccess: true } }));
        const result = await response.json();
        expect(result.session).toMatchObject({ workspaceId, role: 'admin' });
        expect(count('workspaces')).toBe(1);
        expect(count('participants')).toBe(2);
        expect(database.prepare('SELECT settings_json FROM workspaces WHERE id=?').get(workspaceId)!.settings_json).toBe(settings);
        expect(database.prepare('SELECT version FROM template_versions WHERE workspace_id=?').all(workspaceId)).toEqual([{ version: 3 }]);
        const cookies = responseCookies(response);
        await expect(session(request({ cookies, view: 'caller' }), runtime.bindings)).resolves.toMatchObject({ role: 'caller', participantId });
        await expect(session(request({ cookies, view: 'staff' }), runtime.bindings)).resolves.toMatchObject({ role: 'admin', participantId: result.session.participantId });
        const repeated = await createSession(request({ cookies, data: { localStaffAccess: true } }));
        expect(repeated.status).toBe(200);
        expect((await repeated.json()).session.participantId).toBe(result.session.participantId);
        expect(count('participants')).toBe(2);
        expect(count('sessions')).toBe(2);
    });

    it.each([
        { APP_ORIGIN: hostedOrigin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true' },
        { APP_ORIGIN: localOrigin },
        { APP_ORIGIN: localOrigin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true', ACCESS_ISSUER: issuer },
    ])('rejects recovery outside the explicit local sandbox, even with an invitation: %j', async configuration => {
        runtime.bindings = bindings(configuration);
        await seedInvitation('caller');
        await expect(createSession(request({ data: { localStaffAccess: true, invitation: invitationToken } }))).rejects.toMatchObject({ status: 403 });
        expect(redeemedBy()).toBeNull();
        expect(count('participants')).toBe(0);
    });

    it('requires an existing caller or staff session and rejects cross-origin recovery', async () => {
        runtime.bindings = bindings({ APP_ORIGIN: localOrigin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true' });
        await expect(createSession(request({ data: { localStaffAccess: true, workspaceId } }))).rejects.toMatchObject({ status: 401 });
        expect(count('workspaces')).toBe(0);
        await seedSession('caller');
        const incoming = request({ cookie: true, data: { localStaffAccess: true } });
        incoming.headers.set('Origin', 'http://127.0.0.1:8787');
        await expect(createSession(incoming)).rejects.toMatchObject({ status: 403 });
        expect(count('participants')).toBe(1);
    });

    it('retains enrollment rate limits and Turnstile verification for recovery', async () => {
        runtime.bindings = bindings({ APP_ORIGIN: localOrigin, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true' });
        await seedSession('caller');
        const windowStart = Math.floor(Date.now() / 3600000) * 3600000;
        database.prepare('INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,?)').run('session:' + await hash('local'), windowStart, 30);
        await expect(createSession(request({ cookie: true, data: { localStaffAccess: true } }))).rejects.toMatchObject({ status: 429 });
        database.prepare('DELETE FROM rate_limits').run();
        runtime.bindings.TURNSTILE_SECRET_KEY = 'local-test-only';
        vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: false }));
        await expect(createSession(request({ cookie: true, data: { localStaffAccess: true, turnstileToken: 'synthetic-proof' } }))).rejects.toMatchObject({ status: 403 });
        expect(count('participants')).toBe(1);
    });
});


describe('explicit hosted self-service workspaces', () => {
    it.each(['mock', 'live'] as const)('opens exact HTTPS enrollment independently of provider mode: %s', mode => {
        runtime.bindings = bindings({ PUBLIC_WORKSPACE_ACCESS: 'true', PROVIDER_MODE: mode });
        expect(enrollmentMode(request(), runtime.bindings)).toBe('public');
    });

    it.each([
        { PUBLIC_WORKSPACE_ACCESS: undefined },
        { PUBLIC_WORKSPACE_ACCESS: 'false' },
        { APP_ORIGIN: 'http://nursebridge.example' },
        { APP_ORIGIN: hostedOrigin + '/path' },
        { APP_ORIGIN: 'https://user:password@nursebridge.example' },
        { ACCESS_ISSUER: issuer },
        { ACCESS_AUDIENCE: audience },
    ])('keeps invalid or conflicting hosted enrollment closed: %j', configuration => {
        runtime.bindings = bindings({ PUBLIC_WORKSPACE_ACCESS: 'true', ...configuration });
        expect(enrollmentMode(request({ origin: hostedOrigin }), runtime.bindings)).toBe('closed');
    });

    it('rejects an alias even when Origin and forwarded headers name the configured host', async () => {
        runtime.bindings = bindings({ PUBLIC_WORKSPACE_ACCESS: 'true' });
        const incoming = request({ origin: 'https://alias.example', data: {} });
        incoming.headers.set('Origin', hostedOrigin);
        incoming.headers.set('X-Forwarded-Host', 'nursebridge.example');
        expect(enrollmentMode(incoming, runtime.bindings)).toBe('closed');
        await expect(createSession(incoming)).rejects.toMatchObject({ status: 403 });
        expect(count('workspaces')).toBe(0);
    });

    it('creates independent persisted admin workspaces and preserves each identity on reads', async () => {
        runtime.bindings = bindings({ PUBLIC_WORKSPACE_ACCESS: 'true', PROVIDER_MODE: 'live' });
        const first = await createSession(request({ data: {} }));
        const second = await createSession(request({ data: { workspaceId, role: 'nurse', publicAccess: false } }));
        const a = (await first.json()).session, b = (await second.json()).session;
        expect(a.role).toBe('admin');
        expect(b.role).toBe('admin');
        expect(a.workspaceId).not.toBe(b.workspaceId);
        expect(b.workspaceId).not.toBe(workspaceId);
        expect(count('workspaces')).toBe(2);
        expect(count('participants')).toBe(2);
        expect(database.prepare("SELECT json_extract(settings_json,'$.publicAccess') AS enabled FROM workspaces").all()).toEqual([{ enabled: 1 }, { enabled: 1 }]);
        await expect(session(request({ cookies: responseCookies(first), view: 'staff' }), runtime.bindings)).resolves.toMatchObject(a);
        await expect(session(request({ cookies: responseCookies(first), view: 'caller' }), runtime.bindings)).resolves.toMatchObject(a);
        expect(count('participants')).toBe(2);
        for (const value of first.headers.getSetCookie()) expect(value).toContain('; Secure');
    });

    it('does not grant staff access to old workspaces, and disabling the flag restores Access enforcement', async () => {
        runtime.bindings = bindings({ PUBLIC_WORKSPACE_ACCESS: 'true' });
        await seedSession('admin');
        database.prepare('UPDATE workspaces SET settings_json=? WHERE id=?').run('{"publicDemo":true}', workspaceId);
        await expect(session(request({ cookie: true }), runtime.bindings)).rejects.toMatchObject({ status: 401 });
        database.prepare('UPDATE workspaces SET settings_json=? WHERE id=?').run('{"publicAccess":"true"}', workspaceId);
        await expect(session(request({ cookie: true }), runtime.bindings)).rejects.toMatchObject({ status: 401 });
        database.prepare('UPDATE workspaces SET settings_json=? WHERE id=?').run('{"publicAccess":true}', workspaceId);
        await expect(session(request({ cookie: true }), runtime.bindings)).resolves.toMatchObject({ role: 'admin' });
        runtime.bindings.PUBLIC_WORKSPACE_ACCESS = 'false';
        runtime.bindings.ACCESS_ISSUER = issuer;
        runtime.bindings.ACCESS_AUDIENCE = audience;
        await expect(session(request({ cookie: true }), runtime.bindings)).rejects.toMatchObject({ status: 403 });
        await expect(session(request({ cookie: true, accessToken: jwt() }), runtime.bindings)).resolves.toMatchObject({ role: 'admin' });
    });

    it('redeems nurse invitations only for marked public workspaces without weakening private invitations', async () => {
        runtime.bindings = bindings({ PUBLIC_WORKSPACE_ACCESS: 'true' });
        await seedInvitation('nurse');
        await expect(createSession(request({ data: { invitation: invitationToken } }))).rejects.toMatchObject({ status: 401 });
        expect(redeemedBy()).toBeNull();
        database.prepare('UPDATE workspaces SET settings_json=? WHERE id=?').run('{"publicAccess":true}', workspaceId);
        const response = await createSession(request({ data: { invitation: invitationToken } }));
        expect((await response.json()).session).toMatchObject({ workspaceId, role: 'nurse' });
        await expect(session(request({ cookies: responseCookies(response), view: 'staff' }), runtime.bindings)).resolves.toMatchObject({ workspaceId, role: 'nurse' });
    });

    it('never promotes an invited caller and opens a separate workspace when they request one', async () => {
        runtime.bindings = bindings({ PUBLIC_WORKSPACE_ACCESS: 'true' });
        await seedInvitation('caller');
        database.prepare('UPDATE workspaces SET settings_json=? WHERE id=?').run('{"publicAccess":true}', workspaceId);
        const invitationResponse = await createSession(request({ data: { invitation: invitationToken, role: 'admin' } }));
        const caller = (await invitationResponse.json()).session;
        const callerCookies = responseCookies(invitationResponse);
        expect(caller).toMatchObject({ workspaceId, role: 'caller' });
        await expect(session(request({ cookies: callerCookies, view: 'staff' }), runtime.bindings, ['admin', 'nurse'])).rejects.toMatchObject({ status: 403 });
        await expect(createSession(request({ cookies: callerCookies, data: { localStaffAccess: true } }))).rejects.toMatchObject({ status: 403 });
        const own = await createSession(request({ cookies: callerCookies, data: { workspaceId } }));
        const admin = (await own.json()).session;
        expect(admin.role).toBe('admin');
        expect(admin.workspaceId).not.toBe(workspaceId);
        const browserCookies = responseCookies(own) + '; ' + callerCookies.split('; ').find(value => value.startsWith('nb_caller_session='));
        await expect(session(request({ cookies: browserCookies, view: 'caller' }), runtime.bindings)).resolves.toMatchObject(caller);
        await expect(session(request({ cookies: browserCookies, view: 'staff' }), runtime.bindings)).resolves.toMatchObject(admin);
    });

    it('keeps origin, rate limits, and Turnstile checks before workspace writes', async () => {
        runtime.bindings = bindings({ PUBLIC_WORKSPACE_ACCESS: 'true' });
        const wrongOrigin = request({ data: {} });
        wrongOrigin.headers.set('Origin', 'https://other.example');
        await expect(createSession(wrongOrigin)).rejects.toMatchObject({ status: 403 });
        const windowStart = Math.floor(Date.now() / 3600000) * 3600000;
        database.prepare('INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,?)').run('session:' + await hash('local'), windowStart, 30);
        await expect(createSession(request({ data: {} }))).rejects.toMatchObject({ status: 429 });
        database.prepare('DELETE FROM rate_limits').run();
        runtime.bindings.TURNSTILE_SECRET_KEY = 'synthetic-test-only';
        vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: false }));
        await expect(createSession(request({ data: { turnstileToken: 'synthetic-proof' } }))).rejects.toMatchObject({ status: 403 });
        expect(count('workspaces')).toBe(0);
        expect(count('participants')).toBe(0);
    });
});
