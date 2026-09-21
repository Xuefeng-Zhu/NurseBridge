import {getSession,createSession} from '@/server/api';
import {endpoint} from '@/server/http';
export const dynamic='force-dynamic';
export const GET=endpoint(getSession);
export const POST=endpoint(createSession);
