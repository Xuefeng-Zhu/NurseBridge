import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentEnvironment, parseConfiguration, validateDeployment } from './deploy-preflight.mjs';
import { deploy, deploymentCommands } from './deploy.mjs';

function fixture() {
  const configs = {
    web: { name: 'nursebridge-web-local', d1_databases: [{ binding: 'DB', database_id: '00000000-0000-0000-0000-000000000001', database_name: 'local' }], r2_buckets: [{ binding: 'EXPORTS', bucket_name: 'exports-local' }], env: {} },
    realtime: { name: 'nursebridge-realtime-local', d1_databases: [{ binding: 'DB', database_id: '00000000-0000-0000-0000-000000000001', database_name: 'local' }], r2_buckets: [{ binding: 'EXPORTS', bucket_name: 'exports-local' }], env: {} },
  };
  for (const [index, environment] of ['staging', 'production'].entries()) {
    const realtimeName = `nursebridge-realtime-${environment}`;
    const common = {
      vars: { PROVIDER_MODE: 'live', ALLOW_TEST_DIAGNOSTICS: 'false', FICTIONAL_LIVE_TEST: 'false', MAX_ACTIVE_CALLS_PER_WORKSPACE: '2', MAX_LIVE_CONCURRENCY: '4', DAILY_AUDIO_MINUTES: '120' },
      d1_databases: [{ binding: 'DB', database_id: `ad39d124-fc8b-4251-9b47-149caf0ccec${index}`, database_name: `nursebridge-${environment}`, migrations_dir: '../../packages/database/migrations' }],
      r2_buckets: [{ binding: 'EXPORTS', bucket_name: `nursebridge-exports-${environment}` }],
    };
    configs.web.env[environment] = {
      ...structuredClone(common), name: `nursebridge-web-${environment}`,
      vars: { ...common.vars, APP_ORIGIN: `https://${environment}.nursebridge.example.com`, REALTIME_URL: `wss://realtime-${environment}.nursebridge.example.com`, ALLOW_LOCAL_SANDBOX_ENROLLMENT: 'false', ACCESS_ISSUER: 'https://staff.cloudflareaccess.com', ACCESS_AUDIENCE: 'staff-application-audience' },
      durable_objects: { bindings: [{ name: 'CALL_SESSIONS', class_name: 'CallSession', script_name: realtimeName }] },
      services: [{ binding: 'REALTIME', service: realtimeName }],
    };
    configs.realtime.env[environment] = {
      ...structuredClone(common), name: realtimeName,
      vars: { ...common.vars, ALLOWED_ORIGINS: `https://${environment}.nursebridge.example.com`, MAX_CALL_SECONDS: '600', RETENTION_SECONDS: '604800', PHONE_MAX_CONCURRENT: '2', PHONE_DAILY_MINUTES: '60', PHONE_INBOUND_ENABLED: 'false' },
      durable_objects: { bindings: [{ name: 'CALL_SESSIONS', class_name: 'CallSession' }] },
    };
  }
  return configs;
}

function invalid(change, pattern) {
  const configs = fixture();
  change(configs.web.env.staging, configs.realtime.env.staging, configs);
  assert.throws(() => validateDeployment(configs, 'staging'), pattern);
}

test('requires exactly one explicit known environment, including legacy aliases', () => {
  assert.equal(deploymentEnvironment(['--env', 'production']), 'production');
  assert.equal(deploymentEnvironment(['--', '--staging']), 'staging');
  assert.equal(deploymentEnvironment(['--env=staging']), 'staging');
  for (const args of [[], ['--env'], ['--env', 'preview'], ['--production', '--staging'], ['--env', 'staging', '--force'], ['--env', 'production', '--env', 'production']]) {
    assert.throws(() => deploymentEnvironment(args));
  }
});

test('parses JSONC comments and trailing commas without damaging HTTPS strings', () => {
  const config = parseConfiguration('{/* comment */ "url": "https://example.com", // comment\n "value": true, }', 'fixture.jsonc');
  assert.deepEqual(config, { url: 'https://example.com', value: true });
  assert.throws(() => parseConfiguration('{"key": FICTIONAL_SECRET}', 'fixture.jsonc'), error => error.message.includes('invalid JSONC') && !error.message.includes('FICTIONAL_SECRET'));
});

test('accepts isolated hosted environments and ignores placeholders in an unselected environment', () => {
  for (const environment of ['staging', 'production']) assert.equal(validateDeployment(fixture(), environment).environment, environment);
  const configs = fixture();
  configs.web.env.production.vars.APP_ORIGIN = 'https://REPLACE-PRODUCTION.workers.dev';
  configs.realtime.env.production.d1_databases[0].database_id = 'REPLACE_WITH_PRODUCTION_D1_ID';
  assert.equal(validateDeployment(configs, 'staging').environment, 'staging');
  assert.throws(() => validateDeployment(configs, 'production'), /replace the placeholder/);
});

test('does not fall back to local bindings or variables', () => {
  invalid((web) => { delete web.vars; }, /PROVIDER_MODE=live/);
  invalid((web) => { delete web.d1_databases; }, /explicit DB/);
  const configs = fixture(); delete configs.realtime.env.staging;
  assert.throws(() => validateDeployment(configs, 'staging'), /explicit environment configuration/);
});

test('rejects unsafe modes, diagnostics, local enrollment and missing identity configuration', () => {
  invalid((web) => { web.vars.PROVIDER_MODE = 'mock'; }, /mock mode is local only/);
  invalid((_web, realtime) => { realtime.vars.FICTIONAL_LIVE_TEST = 'true'; }, /FICTIONAL_LIVE_TEST/);
  invalid((web) => { web.vars.ALLOW_TEST_DIAGNOSTICS = 'true'; }, /ALLOW_TEST_DIAGNOSTICS/);
  invalid((web) => { web.vars.ALLOW_LOCAL_SANDBOX_ENROLLMENT = 'true'; }, /ALLOW_LOCAL_SANDBOX_ENROLLMENT/);
  invalid((web) => { delete web.vars.ACCESS_AUDIENCE; }, /ACCESS_AUDIENCE/);
  invalid((web) => { web.vars.ACCESS_ISSUER = 'http://staff.cloudflareaccess.com'; }, /ACCESS_ISSUER/);
});

test('rejects credentials in vars without printing their values', () => {
  invalid((_web, realtime) => { realtime.vars.NEBIUS_API_KEY = 'DO_NOT_PRINT_SECRET'; }, error => error.message.includes('Worker secret') && !error.message.includes('DO_NOT_PRINT_SECRET'));
});

test('requires exact secure origins with environment-specific CORS', () => {
  for (const value of ['http://staging.example.com', 'https://localhost', 'https://staging.example.com/path', 'https://staging.example.com/', 'https://user:password@staging.example.com', 'https://staging.example.com?token=secret', 'https://*.example.com']) {
    invalid((web) => { web.vars.APP_ORIGIN = value; }, /APP_ORIGIN must be an exact public HTTPS origin/);
  }
  invalid((web) => { web.vars.REALTIME_URL = 'ws://realtime.example.com'; }, /exact public WSS origin/);
  invalid((_web, realtime) => { realtime.vars.ALLOWED_ORIGINS += ',https://unrelated.example.com'; }, /ALLOWED_ORIGINS must exactly equal/);
});

test('requires matching databases, buckets, DO ownership and service destinations', () => {
  invalid((_web, realtime) => { realtime.d1_databases[0].database_id = 'baadf00d-fc8b-4251-9b47-149caf0ccec0'; }, /same environment D1/);
  invalid((_web, realtime) => { realtime.r2_buckets[0].bucket_name = 'unrelated-bucket'; }, /same environment R2/);
  invalid((web) => { web.durable_objects.bindings[0].script_name = 'nursebridge-realtime-production'; }, /CALL_SESSIONS/);
  invalid((_web, realtime) => { realtime.durable_objects.bindings[0].script_name = 'nursebridge-realtime-production'; }, /CALL_SESSIONS/);
  invalid((web) => { web.services[0].service = 'nursebridge-realtime-production'; }, /REALTIME service binding/);
  invalid((web) => { web.services.push({ binding: 'REALTIME', service: 'duplicate' }); }, /REALTIME service binding/);
});

test('rejects local and cross-environment resource sharing', () => {
  invalid((web, realtime, configs) => {
    for (const config of [web, realtime]) config.d1_databases[0].database_id = configs.web.d1_databases[0].database_id;
  }, /DB is shared with web\/local/);
  invalid((web, realtime, configs) => {
    for (const config of [web, realtime]) config.r2_buckets[0].bucket_name = configs.web.env.production.r2_buckets[0].bucket_name;
  }, /EXPORTS is shared with web\/production/);
  invalid((web, _realtime, configs) => { web.name = configs.web.env.production.name; }, /Worker name overlaps/);
  invalid((web, _realtime, configs) => { web.vars.APP_ORIGIN = configs.web.env.production.vars.APP_ORIGIN; }, /APP_ORIGIN overlaps/);
});

test('rejects invalid or mismatched operational limits', () => {
  invalid((web) => { web.vars.DAILY_AUDIO_MINUTES = '0'; }, /positive integer/);
  invalid((_web, realtime) => { realtime.vars.RETENTION_SECONDS = 'forever'; }, /positive integer/);
  invalid((_web, realtime) => { realtime.vars.MAX_LIVE_CONCURRENCY = '20'; }, /MAX_LIVE_CONCURRENCY must match/);
  invalid((_web, realtime) => { realtime.vars.MAX_CALL_SECONDS = '1200'; }, /must be 600/);
  invalid((_web, realtime) => { realtime.vars.RETENTION_SECONDS = '86400'; }, /must be 604800/);
});

test('enabled phone ingress requires the real endpoint, account and operator route map', () => {
  const configs = fixture();
  const realtime = configs.realtime.env.staging;
  realtime.vars.PHONE_INBOUND_ENABLED = 'true';
  assert.throws(() => validateDeployment(configs, 'staging'), /TWILIO_ACCOUNT_SID/);
  realtime.vars.TWILIO_ACCOUNT_SID = `AC${'a'.repeat(32)}`;
  realtime.vars.TWILIO_PUBLIC_ORIGIN = 'https://realtime-staging.nursebridge.example.com';
  realtime.vars.TWILIO_INBOUND_ROUTES = '{"+12025550123":"ad39d124-fc8b-4251-9b47-149caf0ccec0"}';
  assert.equal(validateDeployment(configs, 'staging').environment, 'staging');
  realtime.vars.TWILIO_PUBLIC_ORIGIN = 'https://other.example.com';
  assert.throws(() => validateDeployment(configs, 'staging'), /HTTPS origin of this environment/);
  realtime.vars.TWILIO_PUBLIC_ORIGIN = 'https://realtime-staging.nursebridge.example.com';
  realtime.vars.TWILIO_INBOUND_ROUTES = '{}';
  assert.throws(() => validateDeployment(configs, 'staging'), /non-empty E.164/);
  realtime.vars.TWILIO_INBOUND_ROUTES = '{"+12025550123":"operator-workspace"}';
  assert.throws(() => validateDeployment(configs, 'staging'), /workspace UUID/);
  invalid((_web, target) => { target.services = [{ binding: 'TWILIO_HTTP', service: 'fake-carrier' }]; }, /test-only TWILIO_HTTP/);
});

test('deployment builds and dry-runs both Workers before remote migrations and uploads', () => {
  const calls = [];
  const result = deploy({ args: ['--env', 'production'], configs: fixture(), output: () => {}, run: (command, args, options) => {
    calls.push(args);
    assert.equal(command, 'pnpm');
    assert.equal(options.env.CI, 'true');
    return { status: 0 };
  } });
  assert.equal(result.environment, 'production');
  assert.deepEqual(calls, deploymentCommands('production'));
  assert.equal(calls.findIndex(args => args.includes('--remote')), 4);
  assert.deepEqual(calls.slice(2, 4).map(args => args.includes('--dry-run')), [true, true]);
  assert.deepEqual(calls.slice(1).map(args => args.at(-1)), Array(6).fill('production'));
});

test('preflight failures run no subprocesses', () => {
  const configs = fixture(); configs.web.env.staging.vars.ALLOW_TEST_DIAGNOSTICS = 'true';
  let calls = 0;
  assert.throws(() => deploy({ args: ['--staging'], configs, output: () => {}, run: () => { calls++; return { status: 0 }; } }), /ALLOW_TEST_DIAGNOSTICS/);
  assert.equal(calls, 0);
});

test('build and dry-run failures, spawn errors, signals and null statuses stop before remote mutations', () => {
  for (const failure of [{ status: 1 }, { status: null }, { status: null, signal: 'SIGTERM' }, { status: null, error: new Error('DO_NOT_PRINT_SECRET') }]) {
    for (const failAt of [1, 3]) {
      const calls = [];
      assert.throws(() => deploy({ args: ['--staging'], configs: fixture(), output: () => {}, run: (_command, args) => {
        calls.push(args);
        return calls.length - 1 === failAt ? failure : { status: 0 };
      } }), error => error.message.includes('Deployment stopped') && !error.message.includes('DO_NOT_PRINT_SECRET'));
      assert.equal(calls.length, failAt + 1);
      assert.equal(calls.some(args => args.includes('--remote')), false);
    }
  }
});

test('migration failure stops uploads and reports that earlier remote changes cannot be rolled back', () => {
  const calls = [];
  assert.throws(() => deploy({ args: ['--staging'], configs: fixture(), output: () => {}, run: (_command, args) => {
    calls.push(args); return { status: args.includes('--remote') ? 1 : 0 };
  } }), /not rolled back/);
  assert.equal(calls.length, 5);
});
