import { describe, expect, it } from 'vitest';
import { canonicalLocalWorkspaceURL } from '../../apps/web/src/components/workspace-origin';

const hosts = ['localhost', '127.0.0.1', '[::1]'];

describe('canonical local workspace origin', () => {
  it.each(hosts.flatMap(source => hosts.filter(target => target !== source).map(target => [source, target])))('redirects %s to configured %s on the same port', (source, target) => {
    expect(canonicalLocalWorkspaceURL(`http://${source}:8961/settings`, `http://${target}:8961`)).toBe(`http://${target}:8961/settings`);
  });

  it('preserves the complete invitation, path and query before bootstrap consumes it', () => {
    const suffix = '/caller?return=%2Fnurse&label=hello%20there#invite=sample%2Btoken&other=value';
    expect(canonicalLocalWorkspaceURL(`http://127.0.0.1:8961${suffix}`, 'http://localhost:8961')).toBe(`http://localhost:8961${suffix}`);
  });

  it('keeps a double-slash path on the configured host', () => {
    expect(canonicalLocalWorkspaceURL('http://127.0.0.1:8961//example.com/caller#invite=sample', 'http://localhost:8961')).toBe('http://localhost:8961//example.com/caller#invite=sample');
  });

  it.each(hosts)('does nothing at canonical host %s', host => {
    expect(canonicalLocalWorkspaceURL(`http://${host}:8961/nurse#invite=sample`, `http://${host}:8961`)).toBeNull();
  });

  it.each([
    ['http://127.0.0.1:8961/settings', undefined],
    ['http://127.0.0.1:8961/settings', ''],
    ['not a URL', 'http://localhost:8961'],
    ['http://127.0.0.1:8961/settings', 'not a URL'],
    ['http://127.0.0.1:8961/settings', 'http://localhost:8961/'],
    ['http://127.0.0.1:8961/settings', 'http://localhost:8961/nurse'],
    ['http://127.0.0.1:8961/settings', 'http://localhost:8961?next=/caller'],
    ['http://127.0.0.1:8961/settings', 'http://localhost:8961#invite=sample'],
    ['http://user:password@127.0.0.1:8961/settings', 'http://localhost:8961'],
    ['http://127.0.0.1:8961/settings', 'http://user:password@localhost:8961'],
    ['http://127.0.0.1:8961/settings', ' http://localhost:8961'],
  ])('rejects malformed, missing or non-bare configuration: %s / %s', (current, configured) => {
    expect(canonicalLocalWorkspaceURL(current!, configured)).toBeNull();
  });

  it.each([
    ['http://127.0.0.1:8961/settings', 'http://localhost:8787'],
    ['http://127.0.0.1:8961/settings', 'http://localhost'],
    ['https://127.0.0.1:8961/settings', 'http://localhost:8961'],
    ['http://127.0.0.1:8961/settings', 'https://localhost:8961'],
    ['https://127.0.0.1:8961/settings', 'https://localhost:8961'],
    ['http://nursebridge.example:8961/settings', 'http://localhost:8961'],
    ['http://127.0.0.1:8961/settings', 'http://nursebridge.example:8961'],
    ['http://localhost.evil.example:8961/settings', 'http://localhost:8961'],
    ['http://127.0.0.1:8961/settings', 'http://localhost.evil.example:8961'],
    ['http://127.0.0.2:8961/settings', 'http://localhost:8961'],
    ['http://0.0.0.0:8961/settings', 'http://localhost:8961'],
  ])('does not redirect across applications or to a lookalike: %s / %s', (current, configured) => {
    expect(canonicalLocalWorkspaceURL(current, configured)).toBeNull();
  });
});
