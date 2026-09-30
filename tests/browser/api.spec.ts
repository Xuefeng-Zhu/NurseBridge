import {test,expect,request as apiRequest} from './helpers/fixtures';
import { RECORDING_DISCLOSURE_VERSION } from '../../packages/contracts/src';
const baseURL=process.env.NURSEBRIDGE_BASE_URL??'http://localhost:8787';
test('Workers HTTP preserves template versions, private exports, and terminal deletion',async({extraHTTPHeaders})=>{
 const admin=await apiRequest.newContext({baseURL,extraHTTPHeaders:{...extraHTTPHeaders,Origin:baseURL}});
 const stranger=await apiRequest.newContext({baseURL,extraHTTPHeaders:{...extraHTTPHeaders,Origin:baseURL}});
 try{
  expect((await admin.post('/api/demo/session',{data:{}})).status()).toBe(201);
  expect((await stranger.post('/api/demo/session',{data:{}})).status()).toBe(201);
  const createId=crypto.randomUUID();const created=await admin.post('/api/calls',{data:{commandId:createId}});expect(created.status()).toBe(201);const {call}=await created.json();
  expect(call.queueState).toBe('WAITING');expect(call.intakeState).toBe('NOT_STARTED');
  const retry=await admin.post('/api/calls',{data:{commandId:createId}});expect((await retry.json()).call.id).toBe(call.id);
  expect((await stranger.get(`/api/calls/${call.id}`)).status()).toBe(404);
  for (const facts of ['malformed', [{ field: 'reason', value: 'Unsupported fictional statement', rawWording: 'Unsupported fictional statement', status: 'reported', evidence: [{ turnId: 'missing-turn', quote: 'Unsupported fictional statement' }] }]]) {
   const invalid=await admin.patch(`/api/calls/${call.id}/intake`,{data:{commandId:crypto.randomUUID(),facts}});
   expect(invalid.status()).toBe(400);
   expect((await(await admin.get(`/api/calls/${call.id}`)).json()).snapshot).toMatchObject({facts:[],factRevisions:[],controlRevision:call.controlRevision});
  }
  const initialSettings=await(await admin.get('/api/settings')).json();expect(initialSettings.recording).toMatchObject({provider:'assemblyai',enabled:false,disclosureVersion:RECORDING_DISCLOSURE_VERSION,retentionVerified:false,deletionVerified:false});expect(initialSettings.providers).toHaveProperty('voiceAgent');expect(initialSettings.providers).not.toHaveProperty('tts');const updated=await admin.patch('/api/settings',{data:{template:{...initialSettings.template,name:'Second fictional template'},escalationDestination:'Synthetic staff destination'}});expect(updated.status()).toBe(200);expect((await updated.json()).template.version).toBe(2);
  expect((await(await admin.get(`/api/calls/${call.id}`)).json()).snapshot.template.version).toBe(1);
  const templateOnly=await admin.patch('/api/settings',{data:{template:{...initialSettings.template,name:'Template-only fictional update'}}});expect(templateOnly.status()).toBe(200);const templateOnlySettings=await templateOnly.json();expect(templateOnlySettings.template.version).toBe(3);expect(templateOnlySettings.escalationDestination).toBe('Synthetic staff destination');
  expect((await admin.patch('/api/settings',{data:{recording:{enabled:false}}})).status()).toBe(400);
  const consentId=crypto.randomUUID();expect((await admin.post(`/api/calls/${call.id}/consent`,{data:{commandId:consentId,accepted:false}})).status()).toBe(200);
  expect((await admin.post(`/api/calls/${call.id}/consent`,{data:{commandId:consentId,accepted:true}})).status()).toBe(409);
  const exported=await admin.post(`/api/calls/${call.id}/export`,{data:{format:'json',commandId:crypto.randomUUID()}});expect(exported.status()).toBe(201);const {url}=await exported.json();
  const downloaded=await admin.get(url);expect(downloaded.status()).toBe(200);expect(downloaded.headers()['cache-control']).toBe('private, no-store');expect((await downloaded.json()).id).toBe(call.id);
  expect((await stranger.get(url)).status()).toBe(404);
  expect((await admin.delete(`/api/calls/${call.id}`,{data:{commandId:crypto.randomUUID()}})).status()).toBe(200);
  expect((await admin.get(`/api/calls/${call.id}`)).status()).toBe(410);
  expect((await admin.get(url)).status()).toBe(410);
  await expect.poll(async()=>{const result=await(await admin.get('/api/calls')).json();return result.calls.some((item:{id:string})=>item.id===call.id)}).toBe(false);
 }finally{await admin.dispose();await stranger.dispose()}
});
