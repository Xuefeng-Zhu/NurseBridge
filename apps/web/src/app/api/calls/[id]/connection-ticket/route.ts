import {ticket} from '@/server/api';
import {endpoint} from '@/server/http';
export const POST=endpoint(async(req,ctx)=>ticket(req,(await ctx.params).id));
