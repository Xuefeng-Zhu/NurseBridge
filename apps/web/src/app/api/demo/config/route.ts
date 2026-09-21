import {env} from '@/server/env';
import {json,endpoint} from '@/server/http';
export const dynamic='force-dynamic';
export const GET=endpoint(async()=>{const bindings=env();return json({turnstileSiteKey:bindings.TURNSTILE_SITE_KEY??null})});
