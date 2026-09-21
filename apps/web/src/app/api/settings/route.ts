import {settings,updateSettings} from '@/server/api';
import {endpoint} from '@/server/http';
export const dynamic='force-dynamic';
export const GET=endpoint(settings);
export const PATCH=endpoint(updateSettings);
