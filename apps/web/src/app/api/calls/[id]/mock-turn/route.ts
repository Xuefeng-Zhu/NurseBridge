import {command} from '@/server/api';
import {endpoint} from '@/server/http';
export const POST=endpoint(async(req,ctx)=>command(req,(await ctx.params).id,'mock-turn'));
