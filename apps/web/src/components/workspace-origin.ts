const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Keep a local browser on the configured cookie/CSRF origin before enrollment.
 * Different ports and hosted addresses may be different applications, so never
 * redirect them. No request origins or authentication checks are rewritten. */
export function canonicalLocalWorkspaceURL(currentHref: string, configuredOrigin?: string): string | null {
  if (!configuredOrigin) return null;
  try {
    const current = new URL(currentHref);
    const configured = new URL(configuredOrigin);
    if (configured.origin !== configuredOrigin
      || current.protocol !== 'http:' || configured.protocol !== 'http:'
      || current.username || current.password || configured.username || configured.password
      || !LOOPBACK_HOSTS.has(current.hostname) || !LOOPBACK_HOSTS.has(configured.hostname)
      || current.port !== configured.port || current.origin === configured.origin) return null;
    // Change only the authority: invitation fragments never reach the server.
    current.host = configured.host;
    return current.href;
  } catch {
    return null;
  }
}
