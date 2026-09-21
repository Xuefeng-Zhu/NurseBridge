import {command} from '@/server/api';
import {endpoint} from '@/server/http';
export const PATCH=endpoint(async(req,ctx)=>command(req,(await ctx.params).id,'intake'));
