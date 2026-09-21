import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
if(!process.argv.includes('--staging')){console.error('Deployment is explicit: pnpm deploy --staging. Configure resource IDs, origins and secrets first.');process.exit(1)}
for(const app of ['web','realtime']){if(readFileSync(`apps/${app}/wrangler.jsonc`,'utf8').includes('REPLACE')){console.error(`Configure staging values in apps/${app}/wrangler.jsonc before deployment.`);process.exit(1)}}
for(const args of [['--filter','@nursebridge/web','exec','wrangler','d1','migrations','apply','DB','--remote','--env','staging'],['--filter','@nursebridge/realtime','exec','wrangler','deploy','--env','staging'],['build'],['--filter','@nursebridge/web','exec','wrangler','deploy','--env','staging']]){const result=spawnSync('pnpm',args,{stdio:'inherit'});if(result.status)process.exit(result.status)}
