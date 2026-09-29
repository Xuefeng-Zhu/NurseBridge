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

function request(options: { origin?: string; accessToken?: string; cookie?: boolean; data?: unknown } = {}) {
    const origin = options.origin ?? runtime.bindings.APP_ORIGIN;
    return new Request(`${origin}/api/demo/session`, {
        method: options.data === undefined ? 'GET' : 'POST',
        headers: {
            Origin: origin,
            ...(options.cookie ? { Cookie: `nb_session=${sessionToken}` } : {}),
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
