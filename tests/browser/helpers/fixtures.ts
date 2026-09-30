import { randomBytes } from 'node:crypto';
import { test as base } from '@playwright/test';

export * from '@playwright/test';

export const test = base.extend({
  extraHTTPHeaders: async ({ baseURL, extraHTTPHeaders }, use) => {
    const url = baseURL ? new URL(baseURL) : undefined;
    const loopback = url?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const hasClientAddress = Object.keys(extraHTTPHeaders ?? {}).some(name => name.toLowerCase() === 'cf-connecting-ip');
    if (!loopback || hasClientAddress) return use(extraHTTPHeaders);

    // Independent tests represent independent clients in the local Worker.
    // Keep one documentation address for every request within a test so the
    // application's enrollment quota still applies, including to retries.
    const address = `2001:db8:${randomBytes(12).toString('hex').match(/.{4}/g)!.join(':')}`;
    await use({ ...extraHTTPHeaders, 'CF-Connecting-IP': address });
  },
});
