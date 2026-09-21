import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  // Keep test config beside fixtures so Wrangler cannot load app .dev.vars.
  plugins: [cloudflareTest({ wrangler: { configPath: fileURLToPath(new URL('./tests/wrangler.jsonc', import.meta.url)) } })],
  test: { include: ['apps/realtime/tests/**/*.test.ts'], testTimeout: 15000, hookTimeout: 15000, fileParallelism: false },
});
