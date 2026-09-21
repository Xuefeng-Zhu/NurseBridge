import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = new Set();
const sockets = new Set();
let forwarding;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  forwarding?.close();
  for (const socket of sockets) socket.destroy();
  for (const child of children) child.kill('SIGTERM');
}
function run(args) {
  const child = spawn('pnpm', args, { cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  children.add(child);
  child.once('error', () => { console.error('Unable to start the local development command.'); stop(1); });
  child.once('exit', () => children.delete(child));
  return child;
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());

async function start() {
  await access(new URL('../apps/web/.open-next/worker.js', import.meta.url));
  // Wrangler exposes one public port for a multi-config runtime. This byte
  // forwarder preserves WebSocket upgrades and streams without another runtime
  // opening the persisted D1/R2/DO files. It owns no application state.
  forwarding = createServer(socket => {
    if (stopping) { socket.destroy(); return; }
    const upstream = connect({ host: '127.0.0.1', port: 8787 });
    sockets.add(socket); sockets.add(upstream);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => { sockets.delete(socket); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); });
    socket.pipe(upstream); upstream.pipe(socket);
  });
  forwarding.on('error', error => { console.error(`Realtime port unavailable (${error.code ?? 'listen_failed'}). Stop the older local dev processes first.`); stop(1); });
  await new Promise((resolve, reject) => {
    forwarding.once('error', reject);
    forwarding.listen(8788, '127.0.0.1', resolve);
  });
  if (stopping) return;
  // One runtime is essential: independent Miniflare processes must not open
  // the same persisted local D1 database concurrently. Each auxiliary config
  // still loads its own .dev.vars and remains independently deployable.
  const runtime = run([
    '--filter', '@nursebridge/web', 'exec', 'wrangler', 'dev',
    '-c', '../../scripts/local/wrangler.jsonc',
    '-c', 'wrangler.jsonc',
    '-c', '../realtime/wrangler.jsonc',
    '--port', '8787', '--inspector-port', '9230',
    '--persist-to', '../../.local/state', '--local',
  ]);
  runtime.once('exit', code => stop(code ?? 1));
  console.log('One local Workers runtime: web http://localhost:8787, realtime ws://localhost:8788.');
}

if (process.argv.includes('--skip-build')) {
  start().catch(() => { console.error('Local startup failed. Build the web Worker first and ensure ports 8787/8788 are available.'); stop(1); });
} else {
  const build = run(['build']);
  build.once('exit', code => {
    if (stopping) return;
    if (code) { stop(code); return; }
    start().catch(() => { console.error('Local startup failed. Ensure ports 8787/8788 are available.'); stop(1); });
  });
}
