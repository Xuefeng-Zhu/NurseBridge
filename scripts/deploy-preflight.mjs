import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import ts from 'typescript';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const environments = new Set(['staging', 'production']);
const placeholder = /REPLACE|YOUR[_-]|<[^>]+>/i;
const secretNames = ['ASSEMBLYAI_API_KEY', 'NEBIUS_API_KEY', 'TWILIO_AUTH_TOKEN', 'TURNSTILE_SECRET_KEY'];
const sharedLimits = ['MAX_ACTIVE_CALLS_PER_WORKSPACE', 'MAX_LIVE_CONCURRENCY', 'DAILY_AUDIO_MINUTES'];
const workspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** No default: a deployment must name its destination. */
export function deploymentEnvironment(args) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--env') values.push(args[++index]);
    else if (arg.startsWith('--env=')) values.push(arg.slice(6));
    else if (arg === '--staging' || arg === '--production') values.push(arg.slice(2));
    else throw new Error('Unknown deployment argument. Use --env staging or --env production.');
  }
  if (values.length !== 1 || !environments.has(values[0])) {
    throw new Error('Choose exactly one deployment environment: --env staging or --env production.');
  }
  return values[0];
}

export function parseConfiguration(source, filename) {
  const parsed = ts.parseConfigFileTextToJson(filename, source);
  // Do not echo input: a malformed config might accidentally contain a secret.
  if (parsed.error || !parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
    throw new Error(`${filename}: invalid JSONC configuration.`);
  }
  return parsed.config;
}

export function readConfigurations(root = repositoryRoot) {
  return Object.fromEntries(['web', 'realtime'].map(app => {
    const filename = `apps/${app}/wrangler.jsonc`;
    return [app, parseConfiguration(readFileSync(resolve(root, filename), 'utf8'), filename)];
  }));
}

function exactOrigin(value, protocol) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === protocol && url.origin === value && !url.username && !url.password
      && !url.hostname.includes('*') && !/^(localhost|0\.0\.0\.0|127\..*|\[::1\])$/i.test(url.hostname)
      && !/\.(localhost|local)$/i.test(url.hostname);
  } catch { return false; }
}

function binding(items, key, name) {
  const matches = Array.isArray(items) ? items.filter(item => item?.[key] === name) : [];
  return matches.length === 1 ? matches[0] : undefined;
}

function pendingValues(value, path, errors) {
  if (typeof value === 'string' && placeholder.test(value)) errors.push(`${path}: replace the placeholder.`);
  else if (Array.isArray(value)) value.forEach((item, index) => pendingValues(item, `${path}[${index}]`, errors));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) pendingValues(item, `${path}.${key}`, errors);
  }
}

/** Validate only local configuration. This never contacts Cloudflare or providers. */
export function validateDeployment(configs, environment) {
  if (!environments.has(environment)) throw new Error('Unsupported deployment environment.');
  const errors = [];
  const selected = {};
  for (const app of ['web', 'realtime']) {
    const config = configs[app]?.env?.[environment];
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      errors.push(`${app}.env.${environment}: explicit environment configuration is required.`);
      continue;
    }
    selected[app] = config;
    pendingValues(config, `${app}.env.${environment}`, errors);
    if (typeof config.name !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(config.name)) errors.push(`${app}: an explicit valid Worker name is required.`);
    const vars = config.vars ?? {};
    if (vars.PROVIDER_MODE !== 'live') errors.push(`${app}: hosted deployments require PROVIDER_MODE=live; mock mode is local only.`);
    if (vars.ALLOW_TEST_DIAGNOSTICS !== 'false') errors.push(`${app}: ALLOW_TEST_DIAGNOSTICS must explicitly be false.`);
    if (vars.FICTIONAL_LIVE_TEST !== 'false') errors.push(`${app}: FICTIONAL_LIVE_TEST must explicitly be false.`);
    for (const name of secretNames) {
      if (name in vars) errors.push(`${app}: ${name} must be installed as a Worker secret, never a Wrangler variable.`);
    }
    for (const name of sharedLimits) {
      if (!/^[1-9]\d*$/.test(vars[name] ?? '') || !Number.isSafeInteger(Number(vars[name]))) errors.push(`${app}: ${name} must be a positive integer.`);
    }
    if (config.services?.some(item => item?.binding === 'TWILIO_HTTP')) errors.push(`${app}: the test-only TWILIO_HTTP binding is forbidden.`);
  }
  if (!selected.web || !selected.realtime) throw new Error(`Deployment preflight failed:\n- ${errors.join('\n- ')}`);
  const { web, realtime } = selected;
  const webVars = web.vars ?? {};
  const realtimeVars = realtime.vars ?? {};
  if (webVars.ALLOW_LOCAL_SANDBOX_ENROLLMENT !== 'false') errors.push('web: ALLOW_LOCAL_SANDBOX_ENROLLMENT must explicitly be false.');
  if (!exactOrigin(webVars.ACCESS_ISSUER, 'https:')) errors.push('web: ACCESS_ISSUER must be an exact public HTTPS origin.');
  if (typeof webVars.ACCESS_AUDIENCE !== 'string' || !webVars.ACCESS_AUDIENCE.trim() || webVars.ACCESS_AUDIENCE !== webVars.ACCESS_AUDIENCE.trim()) errors.push('web: a non-empty ACCESS_AUDIENCE is required.');
  if (!exactOrigin(webVars.APP_ORIGIN, 'https:')) errors.push('web: APP_ORIGIN must be an exact public HTTPS origin without a path or trailing slash.');
  if (!exactOrigin(webVars.REALTIME_URL, 'wss:')) errors.push('web: REALTIME_URL must be an exact public WSS origin without a path or trailing slash.');
  if (realtimeVars.ALLOWED_ORIGINS !== webVars.APP_ORIGIN) errors.push('realtime: ALLOWED_ORIGINS must exactly equal this environment\'s web APP_ORIGIN.');
  if (web.name === realtime.name) errors.push('web and realtime must use distinct Worker names.');
  for (const name of sharedLimits) {
    if (webVars[name] !== realtimeVars[name]) errors.push(`${name} must match between web and realtime.`);
  }
  for (const name of ['MAX_CALL_SECONDS', 'RETENTION_SECONDS', 'PHONE_MAX_CONCURRENT', 'PHONE_DAILY_MINUTES']) {
    if (!/^[1-9]\d*$/.test(realtimeVars[name] ?? '') || !Number.isSafeInteger(Number(realtimeVars[name]))) errors.push(`realtime: ${name} must be a positive integer.`);
  }
  // Web reservations and database retention currently use fixed shared constants.
  // Do not let a Worker variable promise a policy the rest of the app cannot honor.
  if (realtimeVars.MAX_CALL_SECONDS !== '600') errors.push('realtime: MAX_CALL_SECONDS must be 600 to match web call reservations.');
  if (realtimeVars.RETENTION_SECONDS !== '604800') errors.push('realtime: RETENTION_SECONDS must be 604800 to match the current seven-day database retention policy.');
  const resources = {};
  for (const [app, config] of Object.entries(selected)) {
    const database = binding(config.d1_databases, 'binding', 'DB');
    const bucket = binding(config.r2_buckets, 'binding', 'EXPORTS');
    resources[app] = { database, bucket };
    if (!database || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(database.database_id ?? '')
      || !database.database_name || database.migrations_dir !== '../../packages/database/migrations') errors.push(`${app}: one explicit DB binding with a real D1 ID, name and repository migrations directory is required.`);
    if (!bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket.bucket_name ?? '')) errors.push(`${app}: one explicit EXPORTS binding with a valid R2 bucket name is required.`);
    const object = binding(config.durable_objects?.bindings, 'name', 'CALL_SESSIONS');
    if (!object || object.class_name !== 'CallSession' || (app === 'web' ? object.script_name !== realtime.name : !!object.script_name)
      || (object.environment && object.environment !== environment)) errors.push(`${app}: CALL_SESSIONS must reference this environment's realtime CallSession class.`);
    for (const [otherApp, base] of Object.entries(configs)) {
      for (const [otherEnvironment, other] of [['local', base], ...Object.entries(base.env ?? {}).filter(([name]) => name !== environment)]) {
        if (config.name && config.name === other.name) errors.push(`${app}: Worker name overlaps ${otherApp}/${otherEnvironment}.`);
        const otherDatabase = binding(other.d1_databases, 'binding', 'DB');
        const otherBucket = binding(other.r2_buckets, 'binding', 'EXPORTS');
        if (database?.database_id && database.database_id === otherDatabase?.database_id) errors.push(`${app}: DB is shared with ${otherApp}/${otherEnvironment}; isolate deployment environments.`);
        if (database?.database_name && database.database_name === otherDatabase?.database_name) errors.push(`${app}: DB name overlaps ${otherApp}/${otherEnvironment}.`);
        if (bucket?.bucket_name && bucket.bucket_name === otherBucket?.bucket_name) errors.push(`${app}: EXPORTS is shared with ${otherApp}/${otherEnvironment}; isolate deployment environments.`);
        for (const name of ['APP_ORIGIN', 'REALTIME_URL']) {
          if (config.vars?.[name] && config.vars[name] === other.vars?.[name]) errors.push(`${app}: ${name} overlaps ${otherApp}/${otherEnvironment}.`);
        }
      }
    }
  }
  if (resources.web.database?.database_id !== resources.realtime.database?.database_id
    || resources.web.database?.database_name !== resources.realtime.database?.database_name) errors.push('web and realtime must bind the same environment D1 database.');
  if (resources.web.bucket?.bucket_name !== resources.realtime.bucket?.bucket_name) errors.push('web and realtime must bind the same environment R2 bucket.');
  const service = binding(web.services, 'binding', 'REALTIME');
  if (!service || service.service !== realtime.name || (service.environment && service.environment !== environment)) errors.push('web: REALTIME service binding must target this environment\'s realtime Worker.');

  if (!['true', 'false'].includes(realtimeVars.PHONE_INBOUND_ENABLED)) errors.push('realtime: PHONE_INBOUND_ENABLED must explicitly be true or false.');
  if (realtimeVars.PHONE_INBOUND_ENABLED === 'true') {
    if (!/^AC[0-9a-fA-F]{32}$/.test(realtimeVars.TWILIO_ACCOUNT_SID ?? '')) errors.push('realtime: enabled phone ingress requires a valid TWILIO_ACCOUNT_SID.');
    if (!exactOrigin(realtimeVars.TWILIO_PUBLIC_ORIGIN, 'https:') || realtimeVars.TWILIO_PUBLIC_ORIGIN !== webVars.REALTIME_URL?.replace(/^wss:/, 'https:')) errors.push('realtime: TWILIO_PUBLIC_ORIGIN must be the HTTPS origin of this environment\'s REALTIME_URL.');
    try {
      const routes = JSON.parse(realtimeVars.TWILIO_INBOUND_ROUTES);
      if (!routes || Array.isArray(routes) || typeof routes !== 'object' || !Object.keys(routes).length
        || Object.entries(routes).some(([number, workspace]) => !/^\+[1-9][0-9]{7,14}$/.test(number) || typeof workspace !== 'string' || !workspaceId.test(workspace))) throw new Error();
    } catch { errors.push('realtime: enabled phone ingress requires a non-empty E.164 number-to-workspace UUID map in TWILIO_INBOUND_ROUTES.'); }
  }
  if (errors.length) throw new Error(`Deployment preflight failed:\n- ${errors.join('\n- ')}`);
  return { environment, webWorker: web.name, realtimeWorker: realtime.name };
}

export function preflight({ args = process.argv.slice(2), configs = readConfigurations() } = {}) {
  return validateDeployment(configs, deploymentEnvironment(args));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = preflight();
    console.log(`Local configuration passed for ${result.environment}: ${result.webWorker} and ${result.realtimeWorker}.`);
    console.log('No remote changes. Cloud resources, secret installation, staff access policies, provider readiness and real-call acceptance require separate verification.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
