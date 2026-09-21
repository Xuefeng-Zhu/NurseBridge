import {detail,command} from '@/server/api';
import {endpoint} from '@/server/http';
export const dynamic='force-dynamic';
export const GET=endpoint(async(req,ctx)=>detail(req,(await ctx.params).id));
export const DELETE=endpoint(async(req,ctx)=>command(req,(await ctx.params).id,'delete'));
