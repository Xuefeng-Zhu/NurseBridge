import { describe, expect, it } from 'vitest';
import { endpoint, unwrap } from '../../apps/web/src/server/http';

describe('structured public RPC errors', () => {
  it('preserves a revision-conflict code without exposing other RPC fields', async () => {
    const response = await endpoint(async () => { unwrap({ ok: false, status: 409, error: 'The call changed. Refresh and try again.', code: 'revision_conflict', providerToken: 'SECRET', stack: 'SECRET' }); return new Response(); })(new Request('http://localhost/api/calls/example/claim'), {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'The call changed. Refresh and try again.', code: 'revision_conflict' });
  });
  it('omits malformed machine codes and keeps the existing string error shape', async () => {
    const response = await endpoint(async () => { unwrap({ ok: false, status: 409, error: 'Call changed.', code: { secret: 'SECRET' } }); return new Response(); })(new Request('http://localhost/'), {});
    expect(await response.json()).toEqual({ error: 'Call changed.' });
  });
});
