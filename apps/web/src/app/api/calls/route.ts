import {listCalls,createCall} from '@/server/api';
import {endpoint} from '@/server/http';
export const dynamic='force-dynamic';
export const GET=endpoint(listCalls);
export const POST=endpoint(createCall);
