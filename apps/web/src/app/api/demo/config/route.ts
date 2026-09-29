import {env} from '@/server/env';
import {json,endpoint} from '@/server/http';
import {enrollmentMode} from '@/server/auth';
export const dynamic='force-dynamic';
export const GET=endpoint(async(request: Request)=>{const bindings=env();return json({turnstileSiteKey:bindings.TURNSTILE_SITE_KEY??null,enrollmentMode:enrollmentMode(request,bindings)})});
