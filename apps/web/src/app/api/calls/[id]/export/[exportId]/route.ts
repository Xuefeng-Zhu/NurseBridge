import {downloadExport} from '@/server/api';
import {endpoint} from '@/server/http';
export const dynamic='force-dynamic';
export const GET=endpoint(async(req,ctx)=>{const p=await ctx.params;return downloadExport(req,p.id,p.exportId)});
