#!/usr/bin/env node
// Isolated local demo and signed-protocol QA. No provider account or PSTN connection is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const flags = new Set(process.argv.slice(2).filter(argument => argument !== '--'));
const allowedFlags = new Set(['--skip-build', '--all', '--demo', '--help']);
function localPort(name, fallback) {
  const value = process.env[name] ?? String(fallback);
  if (!/^[0-9]+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
    throw new Error(`${name} must be a local port between 1024 and 65535.`);
  }
  return Number(value);
}
const webPort = localPort('NURSEBRIDGE_QA_WEB_PORT', 8787);
const realtimePort = localPort('NURSEBRIDGE_QA_REALTIME_PORT', 8788);
if (webPort === realtimePort) throw new Error('The web and realtime QA ports must be different.');
const baseURL = `http://localhost:${webPort}`;
const phoneOrigin = `http://localhost:${realtimePort}`;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const children = new Set();
const listeners = new Set();
const sockets = new Set();
const abort = new AbortController();
let directory;
let runtimeReady = false;
let stopping = false;
let cleanupPromise;

// Preserve tool/runtime discovery without passing provider credentials, browser
// test opt-ins, proxy settings, NODE_OPTIONS, or an operator's Worker variables.
const environment = Object.fromEntries([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'PNPM_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
  'PLAYWRIGHT_CHANNEL', 'PLAYWRIGHT_BROWSERS_PATH',
].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
Object.assign(environment, {
  CI: '1', NO_COLOR: '1', DO_NOT_TRACK: '1', NEXT_TELEMETRY_DISABLED: '1',
  WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', NURSEBRIDGE_LIVE_E2E: '0',
});

function signalChild(record, signal) {
  if (record.closed || !record.child.pid) return;
  // Every spawned command owns a new POSIX process group. This also stops its
  // Wrangler/workerd or browser descendants without touching existing servers.
  try { process.kill(-record.child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') record.child.kill(signal); }
}

function command(name, args, { timeout = 120_000, echo = false, env = {} } = {}) {
  if (stopping) throw new Error('Phone QA was interrupted.');
  const log = createWriteStream(join(directory, `${name}.log`), { flags: 'wx', mode: 0o600 });
  const child = spawn('pnpm', args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...environment, ...env } });
  const record = { child, closed: false, log, done: undefined, timedOut: false };
  children.add(record);
  let size = 0;
  const capture = chunk => {
    if (size < MAX_LOG_BYTES) {
      const kept = chunk.subarray(0, MAX_LOG_BYTES - size);
      log.write(kept); size += kept.length;
      if (echo) process.stdout.write(kept);
      if (size === MAX_LOG_BYTES) log.write('\n[Harness log size limit reached.]\n');
    }
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  let startupError;
  child.once('error', error => { startupError = error; });
  let forceTimer;
  const timeoutTimer = timeout ? setTimeout(() => {
    record.timedOut = true;
    signalChild(record, 'SIGTERM');
    forceTimer = setTimeout(() => signalChild(record, 'SIGKILL'), 3000);
  }, timeout) : undefined;
  record.done = new Promise(resolve => child.once('close', (code, signal) => {
    record.closed = true;
    clearTimeout(timeoutTimer); clearTimeout(forceTimer);
    log.end(() => resolve({ code, signal, error: startupError }));
  }));
  return record;
}

async function checked(name, args, options) {
  const record = command(name, args, options);
  const result = await record.done;
  if (result.error) throw new Error(`${name} could not start (${result.error.code ?? 'spawn failed'}).`);
  if (record.timedOut) throw new Error(`${name} exceeded its time limit; see ${name}.log.`);
  if (result.code !== 0) throw new Error(`${name} failed (${result.signal ?? `exit ${result.code}`}); see ${name}.log.`);
}

function cleanup(code = 0) {
  if (code && !process.exitCode) process.exitCode = code;
  if (cleanupPromise) return cleanupPromise;
  stopping = true; runtimeReady = false; abort.abort();
  cleanupPromise = (async () => {
    for (const server of listeners) server.close();
    for (const socket of sockets) socket.destroy();
    for (const record of children) signalChild(record, 'SIGTERM');
    const closed = Promise.all([...children].map(record => record.done));
    await Promise.race([closed, delay(4000, undefined, { ref: false })]);
    for (const record of children) signalChild(record, 'SIGKILL');
    await Promise.race([closed, delay(2000, undefined, { ref: false })]);
  })();
  return cleanupPromise;
}

process.once('SIGINT', () => { void cleanup(130); });
process.once('SIGTERM', () => { void cleanup(143); });

async function listen(port, host, forward = false) {
  if (stopping) throw new Error('Phone QA was interrupted.');
  const server = createServer(socket => {
    if (!forward || !runtimeReady || stopping || sockets.size >= 128) { socket.destroy(); return; }
    const upstream = connect({ host: '127.0.0.1', port: webPort });
    sockets.add(socket); sockets.add(upstream);
    for (const stream of [socket, upstream]) {
      stream.setTimeout(60_000, () => stream.destroy());
      stream.setNoDelay(true);
    }
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.on('close', () => { sockets.delete(socket); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); });
    // pipe applies backpressure; there is no application-level audio buffer.
    socket.pipe(upstream); upstream.pipe(socket);
  });
  listeners.add(server);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port, host, ipv6Only: host === '::1', exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    server.close(); listeners.delete(server);
    if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) return undefined;
    throw new Error(`Local port ${port} is unavailable (${error.code ?? 'listen failed'}). Stop its existing owner before running phone QA.`);
  }
  if (stopping) { await release(server); throw new Error('Phone QA was interrupted.'); }
  server.on('error', () => { console.error(`Phone QA lost its local port ${port}.`); void cleanup(1); });
  return server;
}

async function release(server) {
  if (!server) return;
  await new Promise(resolve => server.close(resolve));
  listeners.delete(server);
}

async function save(name, value) {
  if (stopping) throw new Error('Phone QA was interrupted.');
  const path = join(directory, name);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  return path;
}

async function prepare() {
  const workspaceId = randomUUID(), participantId = randomUUID(), token = randomBytes(32).toString('hex');
  const accountSid = `AC${randomBytes(16).toString('hex')}`;
  const authToken = `phone-e2e-test-only-${randomBytes(24).toString('hex')}`;
  const phoneNumber = '+15550101001';
  const now = Date.now(), expires = now + 7 * 86_400_000, sessionExpires = now + 4 * 3_600_000;
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const seed = await save('seed.sql', `INSERT INTO workspaces(id,created_at,expires_at) VALUES(${quote(workspaceId)},${now},${expires});
INSERT INTO participants(id,workspace_id,role,created_at) VALUES(${quote(participantId)},${quote(workspaceId)},'admin',${now});
INSERT INTO sessions(token_hash,workspace_id,participant_id,role,expires_at) VALUES(${quote(createHash('sha256').update(token).digest('hex'))},${quote(workspaceId)},${quote(participantId)},'admin',${sessionExpires});\n`);
  // Empty template_versions intentionally exercises the shared DEFAULT_TEMPLATE fallback.
  const storageState = await save('staff-state.json', { cookies: [{ name: 'nb_session', value: token, domain: 'localhost', path: '/', expires: sessionExpires / 1000, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] });
  await save('fixture.json', { workspaceId, participantId, phoneNumber, accountSid, verification: 'Local signed protocol emulator; no real PSTN or provider calls.' });
  const common = { compatibility_date: '2026-09-18', observability: { enabled: false } };
  const database = { binding: 'DB', database_name: 'nursebridge-phone-qa', database_id: randomUUID(), migrations_dir: join(root, 'packages/database/migrations') };
  const buckets = [{ binding: 'EXPORTS', bucket_name: 'nursebridge-phone-qa-exports' }];
  const realtimeName = 'nursebridge-phone-qa-realtime', webName = 'nursebridge-phone-qa-web', carrierName = 'nursebridge-phone-qa-carrier';
  const carrierSource = `// Local-only service binding. It never forwards to the internet.
export default { async fetch(request) {
  const url = new URL(request.url);
  const prefix = '/2010-04-01/Accounts/${accountSid}/Calls/';
  const suffix = url.pathname.slice(prefix.length);
  if (request.method !== 'POST' || url.origin !== 'https://api.twilio.com' || url.search || !url.pathname.startsWith(prefix) || !/^CA[0-9a-f]{32}\\.json$/i.test(suffix)
    || request.headers.get('Authorization') !== ${JSON.stringify(`Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`)}
    || await request.text() !== 'Status=completed') return new Response('Unexpected local carrier request', { status: 400 });
  console.log('Accepted simulated carrier termination; no external request made.');
  return Response.json({ sid: suffix.slice(0, -5), status: 'completed' });
} };
`;
  const carrierMain = await save('carrier.mjs', carrierSource);
  const carrier = await save('carrier.json', { ...common, name: carrierName, main: carrierMain });
  const gateway = await save('gateway.json', { ...common, name: 'nursebridge-phone-qa-gateway', main: join(root, 'scripts/local/gateway.mjs'), services: [{ binding: 'WEB', service: webName }, { binding: 'REALTIME', service: realtimeName }] });
  const web = await save('web.json', {
    ...common, name: webName, main: join(root, 'apps/web/.open-next/worker.js'), compatibility_flags: ['nodejs_compat'],
    assets: { directory: join(root, 'apps/web/.open-next/assets'), binding: 'ASSETS' }, d1_databases: [database], r2_buckets: buckets,
    durable_objects: { bindings: [{ name: 'CALL_SESSIONS', class_name: 'CallSession', script_name: realtimeName }] },
    services: [{ binding: 'REALTIME', service: realtimeName }],
    vars: { APP_ORIGIN: baseURL, REALTIME_URL: `ws://localhost:${realtimePort}`, PROVIDER_MODE: 'mock', ALLOW_TEST_DIAGNOSTICS: 'true', ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'true', MAX_ACTIVE_CALLS_PER_WORKSPACE: '2', MAX_LIVE_CONCURRENCY: '4', DAILY_AUDIO_MINUTES: '120' },
  });
  const realtime = await save('realtime.json', {
    ...common, name: realtimeName, main: join(root, 'apps/realtime/src/index.ts'), compatibility_flags: ['nodejs_compat'],
    durable_objects: { bindings: [{ name: 'CALL_SESSIONS', class_name: 'CallSession' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['CallSession'] }],
    d1_databases: [database], r2_buckets: buckets, services: [{ binding: 'TWILIO_HTTP', service: carrierName }],
    vars: { PROVIDER_MODE: 'mock', ALLOW_TEST_DIAGNOSTICS: 'true', ALLOWED_ORIGINS: baseURL, MAX_CALL_SECONDS: '600', RETENTION_SECONDS: '604800', VOICE_AGENT_COMPATIBILITY_VERIFIED: 'false',
      PHONE_INBOUND_ENABLED: 'true', TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken, TWILIO_PUBLIC_ORIGIN: phoneOrigin, TWILIO_INBOUND_ROUTES: JSON.stringify({ [phoneNumber]: workspaceId }),
      PHONE_MAX_CONCURRENT: '2', PHONE_DAILY_MINUTES: '120', MAX_ACTIVE_CALLS_PER_WORKSPACE: '2', MAX_LIVE_CONCURRENCY: '4', DAILY_AUDIO_MINUTES: '120' },
  });
  return { workspaceId, token, seed, storageState, accountSid, authToken, phoneNumber, gateway, web, realtime, carrier };
}

async function waitForRuntime(fixture) {
  const deadline = Date.now() + 120_000;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${webPort}/health`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]) });
      if (response.ok) {
        const health = await response.json();
        assert.equal(health.mode, 'mock');
        assert.equal(health.phoneInbound?.enabled, true); assert.equal(health.phoneInbound?.configured, true);
        const sessionResponse = await fetch(`${baseURL}/api/demo/session`, { headers: { Cookie: `nb_session=${fixture.token}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]) });
        if (sessionResponse.ok) {
          const session = await sessionResponse.json();
          assert.equal(session.mode, 'mock'); assert.equal(session.diagnostics, true);
          assert.equal(session.session.workspaceId, fixture.workspaceId); assert.equal(session.session.role, 'admin');
          return;
        }
      }
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw new Error('Local runtime failed the mock-mode or fixture-identity guard.');
    }
    await delay(300);
  }
  throw new Error(stopping ? 'Phone QA was interrupted.' : 'Local runtime did not become ready; see runtime.log.');
}

async function main() {
  for (const flag of flags) if (!allowedFlags.has(flag)) throw new Error(`Unknown option ${flag}. Use --help.`);
  if (flags.has('--help')) {
    console.log('Usage: node scripts/test-phone.mjs [--skip-build] [--all | --demo]\nRuns isolated mock phone QA; --all includes the browser suite. --demo keeps the local runtime open for a manual walkthrough with providers off. Artifacts remain in a private temporary directory.');
    return;
  }
  if (flags.has('--demo') && flags.has('--all')) throw new Error('Choose either --demo or --all.');
  if (process.platform === 'win32') throw new Error('Run this process-group QA harness on macOS, Linux, or WSL.');
  directory = await mkdtemp(join(tmpdir(), 'nursebridge-phone-qa-'));
  await chmod(directory, 0o700);
  console.log(`Phone QA artifacts and logs: ${directory}`);
  // Reserve both families so an existing localhost listener fails immediately.
  // Keep the realtime proxy reserved; release the web port when Wrangler starts.
  const webPorts = [];
  for (const host of ['127.0.0.1', '::1']) {
    webPorts.push(await listen(webPort, host));
    await listen(realtimePort, host, true);
  }
  const fixture = await prepare();
  if (!flags.has('--skip-build')) {
    console.log('Building the web Worker and audio worklets…');
    await checked('build', ['build'], { timeout: 600_000 });
  }
  await access(join(root, 'apps/web/.open-next/worker.js'));
  const persistence = join(directory, 'state');
  const wrangler = ['--filter', '@nursebridge/web', 'exec', 'wrangler'];
  console.log('Migrating and seeding a fresh isolated database…');
  await checked('migrate', [...wrangler, 'd1', 'migrations', 'apply', 'DB', '--config', fixture.web, '--local', '--persist-to', persistence]);
  await checked('seed', [...wrangler, 'd1', 'execute', 'DB', '--config', fixture.web, '--local', '--persist-to', persistence, '--file', fixture.seed]);
  for (const server of webPorts) await release(server);
  const runtime = command('runtime', [...wrangler, 'dev', '-c', fixture.gateway, '-c', fixture.web, '-c', fixture.realtime, '-c', fixture.carrier, '--ip', '127.0.0.1', '--port', String(webPort), '--inspector-port', '0', '--persist-to', persistence, '--local'], { timeout: 0 });
  runtime.done.then(() => {
    if (!stopping) { console.error('Local runtime exited unexpectedly; see runtime.log.'); void cleanup(1); }
  });
  await waitForRuntime(fixture);
  runtimeReady = true;
  if (flags.has('--demo')) {
    console.log(`\nLocal app ready: ${baseURL}/nurse\nCreate a local workspace, then choose Invite a caller in the call queue. Open the invitation in a separate browser profile.\nTranscript replay and synthetic phone emulator only; AssemblyAI, Nebius and real Twilio calls are off.\nThis demo listens on this computer only. Press Ctrl+C to stop; the next run starts with fresh data.`);
    await runtime.done;
    return;
  }
  console.log(`Running ${flags.has('--all') ? 'the mock browser suite, including phone QA' : 'signed phone-protocol browser QA'}…`);
  await checked('browser', ['exec', 'playwright', 'test', ...(flags.has('--all') ? [] : ['tests/browser/phone.spec.ts']), '--workers=1', '--reporter=list,html,./tests/reporters/safe-diagnostics.ts', `--output=${join(directory, 'results')}`], {
    timeout: flags.has('--all') ? 1_200_000 : 180_000, echo: true,
    env: { NURSEBRIDGE_LIVE_E2E: '0', NURSEBRIDGE_PHONE_E2E: '1', NURSEBRIDGE_BASE_URL: baseURL, NURSEBRIDGE_PHONE_ORIGIN: phoneOrigin,
      NURSEBRIDGE_PHONE_WORKSPACE_STATE: fixture.storageState, NURSEBRIDGE_PHONE_WORKSPACE_ID: fixture.workspaceId,
      NURSEBRIDGE_PHONE_NUMBER: fixture.phoneNumber, NURSEBRIDGE_PHONE_ACCOUNT_SID: fixture.accountSid, NURSEBRIDGE_PHONE_AUTH_TOKEN: fixture.authToken,
      PLAYWRIGHT_HTML_OUTPUT_DIR: join(directory, 'report'), PLAYWRIGHT_HTML_OPEN: 'never' },
  });
  console.log('Local phone QA passed. This verifies the signed protocol emulator, not real PSTN delivery.');
}

try { await main(); }
catch (error) { if (!stopping) console.error(error.message); process.exitCode ||= 1; }
finally {
  await cleanup();
  if (directory) console.log(`Preserved phone QA artifacts: ${directory}`);
}
