import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, process.argv[2] ?? '../../apps/web/public/worklets');
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: [resolve(root, 'src/worklets/capture.ts'), resolve(root, 'src/worklets/playback.ts')],
  outdir, bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
  minify: false, sourcemap: false,
});
