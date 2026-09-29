import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preflight, repositoryRoot } from './deploy-preflight.mjs';

/** Both bundles must build successfully before the first remote mutation. */
export function deploymentCommands(environment) {
  return [
    ['--filter', '@nursebridge/audio-client', 'build'],
    ['--filter', '@nursebridge/web', 'exec', 'opennextjs-cloudflare', 'build', '--env', environment],
    ['--filter', '@nursebridge/realtime', 'exec', 'wrangler', 'deploy', '--dry-run', '--env', environment],
    ['--filter', '@nursebridge/web', 'exec', 'wrangler', 'deploy', '--dry-run', '--env', environment],
    ['--filter', '@nursebridge/web', 'exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--env', environment],
    ['--filter', '@nursebridge/realtime', 'exec', 'wrangler', 'deploy', '--env', environment],
    ['--filter', '@nursebridge/web', 'exec', 'wrangler', 'deploy', '--env', environment],
  ];
}

export function deploy({ args = process.argv.slice(2), configs, run = spawnSync, output = console.log } = {}) {
  const result = preflight({ args, ...(configs ? { configs } : {}) });
  output(`Deploying ${result.environment}: ${result.webWorker} and ${result.realtimeWorker}.`);
  output('Local configuration checks do not verify cloud secrets, access policies, clinical readiness or provider acceptance.');
  for (const command of deploymentCommands(result.environment)) {
    output(`pnpm ${command.join(' ')}`);
    const child = run('pnpm', command, { cwd: repositoryRoot, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
    if (child.error || child.signal || child.status !== 0) {
      const reason = child.error ? 'could not start' : child.signal ? `terminated by ${child.signal}` : `exited with status ${child.status ?? 'unknown'}`;
      // Keep arbitrary subprocess exception text (which can contain credentials) out of our error.
      throw new Error(`Deployment stopped: command ${reason}. Later steps were not run. Earlier remote changes, if any, were not rolled back.`);
    }
  }
  output(`Uploaded both ${result.environment} Workers. Complete the post-deployment acceptance checklist before enabling traffic.`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { deploy(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
