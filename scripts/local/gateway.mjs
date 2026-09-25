// Local development only; deployment continues to use apps/*/wrangler.jsonc.
// Path routing also works when Wrangler normalizes the incoming Host header.
export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    return (path === '/health' || path.startsWith('/connect/') || path.startsWith('/phone/') ? env.REALTIME : env.WEB).fetch(request);
  },
};
