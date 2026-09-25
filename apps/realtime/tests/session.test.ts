import { env, exports } from 'cloudflare:workers';
import { reset, runInDurableObject, evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../packages/database/migrations/0001_initial.sql?raw';
import type { Env } from '../src/env';
import { projectSnapshot } from '../src/persistence/project';
import type { CallSnapshot } from '@nursebridge/contracts';
import { AudioStreamKind, decodeAudioFrame, encodeAudioFrame } from '@nursebridge/audio-client/protocol';
import type { CallState } from '../src/state';

const bindings=env as unknown as Env;
beforeEach(async()=>{await bindings.DB.exec(schema);});
afterEach(async()=>{vi.restoreAllMocks();await reset();});
async function create(){const callId=crypto.randomUUID();const stub=bindings.CALL_SESSIONS.getByName(callId);const result=await stub.initialize({callId,workspaceId:'workspace-a',callerParticipantId:'caller-a',mode:'mock'});expect(result.ok).toBe(true);return{stub,callId};}
const command=(type:string,participantId='nurse-a',role:'nurse'|'caller'|'admin'='nurse',payload?:Record<string,unknown>)=>({workspaceId:'workspace-a',participantId,role,commandId:crypto.randomUUID(),type,payload});
function message(socket:WebSocket,type:string):Promise<Record<string,unknown>>{return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(`Timed out waiting for ${type}`)),3000);const listener=(event:MessageEvent)=>{if(typeof event.data!=='string')return;const body=JSON.parse(event.data);if(body.type===type){clearTimeout(timeout);socket.removeEventListener('message',listener);resolve(body);}};socket.addEventListener('message',listener);});}
async function connect(callId:string,ticket:string){const response=await exports.default.fetch(`http://localhost/connect/${callId}`,{headers:{Upgrade:'websocket',Origin:'http://localhost:8787'}});const socket=response.webSocket!;socket.accept();const auth=message(socket,'authenticated');socket.send(JSON.stringify({type:'auth',ticket}));await auth;return socket;}
async function waitSnapshot(stub:ReturnType<Env['CALL_SESSIONS']['getByName']>,predicate:(s:CallSnapshot)=>boolean):Promise<CallSnapshot>{for(let i=0;i<100;i++){const result=await stub.snapshot('workspace-a');if(result.ok&&result.snapshot&&predicate(result.snapshot))return result.snapshot;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Snapshot condition did not settle');}
function binary(socket:WebSocket):Promise<ArrayBuffer>{return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Missing relayed binary audio')),3000);const listener=(event:MessageEvent)=>{if(typeof event.data==='string')return;clearTimeout(timeout);socket.removeEventListener('message',listener);resolve(event.data as ArrayBuffer);};socket.addEventListener('message',listener);});}

describe('real Durable Object authority',()=>{
 it('reports Nebius extraction separately from speech without probing providers',async()=>{
  const response=await exports.default.fetch('http://localhost/health');const health=await response.json() as {providers:Record<string,{provider:string;verified:boolean}>};
  expect(response.headers.get('Cache-Control')).toBe('no-store');expect(health.providers.extraction).toMatchObject({provider:'nebius',verified:false});expect(health.providers.voiceAgent).toMatchObject({provider:'assemblyai-voice-agent',verified:false});
 });
 it('uses independent Nebius extraction in the Durable Object without standalone speech',async()=>{
  const{stub}=await create();const request=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({facts:[{field:'onset',value:'yesterday',rawWording:'yesterday',status:'reported',evidence:[{turnId:'live-test:0',quote:'It started yesterday.'}]}],nextQuestionId:'location'})}}]}));
  await runInDurableObject(stub,async instance=>{
   const internal=instance as unknown as {env:Env;state:CallState;updateDraft():Promise<void>};
   const originalEnv=internal.env;internal.env={...originalEnv,PROVIDER_MODE:'live',NEBIUS_API_KEY:'fictional-nebius-worker-key',};
   internal.state.mode='live';internal.state.consent=true;internal.state.conversationOwner='AI';internal.state.turns=[{id:'live-test:0',sessionId:'live-test',order:0,text:'It started yesterday.',final:true,at:Date.now()}];
   try{await internal.updateDraft();}finally{internal.env=originalEnv;}
  });
  expect(request).toHaveBeenCalledOnce();const result=await stub.snapshot('workspace-a');expect(result.ok&&result.snapshot?.facts).toEqual(expect.arrayContaining([expect.objectContaining({field:'onset',value:'yesterday'})]));expect(result.ok&&result.snapshot?.providerSession.lastFinalizedTurnId).toBe('live-test:0');
 });
 it('makes queue discoverable before initialization succeeds',async()=>{const{callId}=await create();const row=await bindings.DB.prepare('SELECT id FROM calls WHERE id=? AND workspace_id=?').bind(callId,'workspace-a').first();expect(row).not.toBeNull();});
 it('has one winner for competing claims and returns the same idempotent response',async()=>{
  const{stub}=await create();const a=command('claim');const b=command('claim','nurse-b');
  const results=await Promise.all([stub.command(a),stub.command(b)]);expect(results.filter(r=>r.ok)).toHaveLength(1);const replay=await stub.command(a);expect(replay).toEqual(results[0]);
 });
 it('rejects reuse of a command ID for a different request',async()=>{
  const{stub}=await create();const first=command('claim');expect((await stub.command(first)).ok).toBe(true);
  expect(await stub.command({...first,type:'end'})).toMatchObject({ok:false,status:409,code:'command_mismatch'});
  expect(await stub.command({...first,expectedRevision:4})).toMatchObject({ok:false,status:409,code:'command_mismatch'});
 });
 it('rejects cross-workspace reads and ticket requests',async()=>{const{stub}=await create();expect(await stub.snapshot('workspace-b')).toMatchObject({ok:false,status:404});expect(await stub.issueTicket({workspaceId:'workspace-b',participantId:'caller-a',role:'caller'})).toMatchObject({ok:false,status:404});});
 it('authenticates exactly once and rejects ticket replay and invalid origins',async()=>{
  const{stub,callId}=await create();const issued=await stub.issueTicket({workspaceId:'workspace-a',participantId:'caller-a',role:'caller'});expect(issued.ok).toBe(true);
  const socket=await connect(callId,String(issued.ok&&issued.ticket));
  const invalid=await exports.default.fetch(`http://localhost/connect/${callId}`,{headers:{Upgrade:'websocket',Origin:'https://evil.example'}});expect(invalid.status).toBe(403);
  const response=await exports.default.fetch(`http://localhost/connect/${callId}`,{headers:{Upgrade:'websocket',Origin:'http://localhost:8787'}});const replay=response.webSocket!;replay.accept();const closed=new Promise<number>(resolve=>replay.addEventListener('close',event=>resolve(event.code)));replay.send(JSON.stringify({type:'auth',ticket:issued.ok&&issued.ticket}));expect(await closed).toBe(1008);socket.close();
 });
 it('rejects expired tickets',async()=>{
  const{stub,callId}=await create();const issued=await stub.issueTicket({workspaceId:'workspace-a',participantId:'caller-a',role:'caller'});
  await runInDurableObject(stub,(_instance,state)=>{state.storage.sql.exec('UPDATE tickets SET expires_at=0');});
  const response=await exports.default.fetch(`http://localhost/connect/${callId}`,{headers:{Upgrade:'websocket',Origin:'http://localhost:8787'}});const socket=response.webSocket!;socket.accept();const closed=new Promise<number>(resolve=>socket.addEventListener('close',event=>resolve(event.code)));socket.send(JSON.stringify({type:'auth',ticket:issued.ok&&issued.ticket}));expect(await closed).toBe(1008);
 });
 it('completes a client close handshake and accepts a fresh authenticated connection',async()=>{
  const{stub,callId}=await create();const issued=await stub.issueTicket({workspaceId:'workspace-a',participantId:'caller-a',role:'caller'});
  const socket=await connect(callId,String(issued.ok&&issued.ticket));
  const closed=new Promise<number>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Client close handshake did not finish')),1500);socket.addEventListener('close',event=>{clearTimeout(timeout);resolve(event.code);});});
  socket.close(1000,'Client reconnecting');expect(await closed).toBe(1000);
  await waitSnapshot(stub,s=>!s.participants.caller);
  const next=await stub.issueTicket({workspaceId:'workspace-a',participantId:'caller-a',role:'caller'});expect(next.ok&&next.ticket).not.toBe(issued.ok&&issued.ticket);
  const replacement=await connect(callId,String(next.ok&&next.ticket));await waitSnapshot(stub,s=>s.participants.caller);replacement.close();
 });
 it.each([
  {facts:'invalid'},
  {facts:[{field:'reason',value:'Fictional headache',rawWording:'Fictional headache',status:'reported',evidence:[{turnId:'missing-turn',quote:'Fictional headache'}]}]},
 ])('rejects invalid nurse intake as a client error without changing state or spending its command ID',async payload=>{
  const{stub}=await create();const attempted=command('intake','nurse-a','nurse',payload);
  expect(await stub.command(attempted)).toMatchObject({ok:false,status:400,code:'invalid_intake'});
  expect(await stub.snapshot('workspace-a')).toMatchObject({ok:true,snapshot:{controlRevision:0,facts:[],factRevisions:[]}});
  expect(await stub.command({...attempted,payload:{facts:[]}})).toMatchObject({ok:true,snapshot:{controlRevision:1}});
 });
 it('keeps unexpected persistence failures as server errors after valid intake validation',async()=>{
  const{stub}=await create();
  const result=await runInDurableObject(stub,async instance=>{
   const internal=instance as unknown as {store:{commit(...args:unknown[]):void}};
   const commit=vi.spyOn(internal.store,'commit').mockImplementationOnce(()=>{throw new Error('Synthetic storage failure');});
   try{return await instance.command(command('intake','nurse-a','nurse',{facts:[]}));}finally{commit.mockRestore();}
  });
  expect(result).toMatchObject({ok:false,status:503,code:'session_unavailable'});
  expect(await stub.snapshot('workspace-a')).toMatchObject({ok:true,snapshot:{controlRevision:0,facts:[]}});
 });
 it('recovers authoritative claims after actual object eviction',async()=>{
  const{stub}=await create();await stub.command(command('claim'));await evictDurableObject(stub);const result=await stub.snapshot('workspace-a');expect(result.ok&&result.snapshot).toMatchObject({queueState:'CLAIMED',claim:{participantId:'nurse-a'}});
 });
 it('rejects old control revisions and recovers timed-out claims through alarms',async()=>{
  const{stub}=await create();await stub.command(command('claim'));expect(await stub.command({...command('takeover'),expectedRevision:0})).toMatchObject({ok:false,status:409});
  await runInDurableObject(stub,(_instance,state)=>{const row=state.storage.sql.exec<{body:string}>('SELECT body FROM active_state').one();const body=JSON.parse(row.body);body.claim.expiresAt=0;state.storage.sql.exec('UPDATE active_state SET body=?',JSON.stringify(body));});
  await evictDurableObject(stub);await runDurableObjectAlarm(stub);expect((await stub.snapshot('workspace-a'))).toMatchObject({ok:true,snapshot:{queueState:'WAITING'}});
 });
 it('acknowledges only the requested escalation and restricts deletion to admins',async()=>{
  const{stub}=await create();await stub.command(command('request-human','caller-a','caller'));const second=await stub.command(command('request-human','caller-a','caller'));const escalations=second.ok&&second.snapshot?.escalations;
  expect(escalations).toHaveLength(2);if(!escalations)throw new Error('Missing escalations');
  const result=await stub.command(command('acknowledge-escalation','nurse-a','nurse',{escalationId:escalations[0]!.id}));expect(result.ok&&result.snapshot?.escalations[0]?.acknowledgedBy).toBe('nurse-a');expect(result.ok&&result.snapshot?.escalations[1]?.acknowledgedBy).toBeUndefined();
  expect(await stub.command(command('delete'))).toMatchObject({ok:false,status:403});
 });
 it('requires decoded audio proof in both directions, then preserves human ownership on request-human',async()=>{
  const{stub,callId}=await create();await stub.command(command('claim'));
  const callerTicket=await stub.issueTicket({workspaceId:'workspace-a',participantId:'caller-a',role:'caller'});const nurseTicket=await stub.issueTicket({workspaceId:'workspace-a',participantId:'nurse-a',role:'nurse'});
  const caller=await connect(callId,String(callerTicket.ok&&callerTicket.ticket));const nurse=await connect(callId,String(nurseTicket.ok&&nurseTicket.ticket));caller.binaryType='arraybuffer';nurse.binaryType='arraybuffer';
  caller.send(JSON.stringify({type:'media-ready',microphone:true,playback:true}));nurse.send(JSON.stringify({type:'media-ready',microphone:true,playback:true}));
  await waitSnapshot(stub,s=>s.participants.caller&&s.participants.nurse);
  await stub.command(command('takeover'));const pending=await waitSnapshot(stub,s=>s.conversationOwner==='HANDOFF_PENDING');
  caller.send(JSON.stringify({type:'playback-flushed',controlEpoch:pending.controlEpoch,generation:pending.responseGeneration}));await waitSnapshot(stub,s=>Boolean(s.handoff?.callerFlushed));
  const frame=(sequence:number)=>encodeAudioFrame({streamKind:AudioStreamKind.Agent,sequence,sampleRate:24000,controlEpoch:pending.controlEpoch,generation:pending.responseGeneration,responseId:0,payload:new Uint8Array(2400)});
  const patientAudio=binary(nurse);caller.send(frame(1));const received=decodeAudioFrame(await patientAudio);expect(received.streamKind).toBe(AudioStreamKind.Patient);
  nurse.send(JSON.stringify({type:'audio-ack',sequence:1,streamKind:AudioStreamKind.Patient,dropped:true}));
  const nurseAudio=binary(caller);nurse.send(frame(1));expect(decodeAudioFrame(await nurseAudio).streamKind).toBe(AudioStreamKind.Nurse);caller.send(JSON.stringify({type:'audio-ack',sequence:1,streamKind:AudioStreamKind.Nurse,dropped:false}));
  const oneDirection=await waitSnapshot(stub,s=>Boolean(s.handoff?.callerHeard));expect(oneDirection.queueState).toBe('CLAIMED');expect(oneDirection.handoff?.nurseHeard).toBe(false);
  const patientRetry=binary(nurse);caller.send(frame(2));await patientRetry;nurse.send(JSON.stringify({type:'audio-ack',sequence:2,streamKind:AudioStreamKind.Patient,dropped:false}));await waitSnapshot(stub,s=>s.queueState==='CONNECTED');
  const requested=await stub.command(command('request-human','caller-a','caller'));expect(requested).toMatchObject({ok:true,snapshot:{queueState:'CONNECTED',conversationOwner:'NURSE'}});
  nurse.close();await waitSnapshot(stub,s=>s.conversationOwner==='NONE'&&s.humanRequested);caller.close();
 });
 it('ignores the provisional flush acknowledgment while waiting for nurse media readiness',async()=>{
  const{stub,callId}=await create();await stub.command(command('claim'));
  const callerTicket=await stub.issueTicket({workspaceId:'workspace-a',participantId:'caller-a',role:'caller'});const nurseTicket=await stub.issueTicket({workspaceId:'workspace-a',participantId:'nurse-a',role:'nurse'});
  const caller=await connect(callId,String(callerTicket.ok&&callerTicket.ticket));const nurse=await connect(callId,String(nurseTicket.ok&&nurseTicket.ticket));
  try{
   caller.send(JSON.stringify({type:'media-ready',microphone:true,playback:true}));await waitSnapshot(stub,s=>(s as CallState).mediaReady.caller);
   await stub.command(command('takeover'));const pending=await waitSnapshot(stub,s=>s.conversationOwner==='HANDOFF_PENDING');
   caller.send(JSON.stringify({type:'playback-flushed',controlEpoch:pending.controlEpoch,generation:pending.responseGeneration}));
   const heartbeat=message(caller,'heartbeat');caller.send(JSON.stringify({type:'heartbeat'}));await heartbeat;
   const early=await stub.snapshot('workspace-a');expect(early.ok&&early.snapshot?.handoff?.callerFlushed).toBe(false);
   nurse.send(JSON.stringify({type:'media-ready',microphone:true,playback:true}));const ready=await waitSnapshot(stub,s=>(s as CallState).mediaReady.nurse);
   expect(ready.controlEpoch).toBeGreaterThan(pending.controlEpoch);expect(ready.handoff?.callerFlushed).toBe(false);
   caller.send(JSON.stringify({type:'playback-flushed',controlEpoch:ready.controlEpoch,generation:ready.responseGeneration}));await waitSnapshot(stub,s=>Boolean(s.handoff?.callerFlushed));
  }finally{caller.close();nurse.close();}
 });
 it.each(['nurse','admin'] as const)('reconciles pre-claim %s readiness without transferring AI ownership or reusing its epoch',async role=>{
  const{stub,callId}=await create();
  const callerTicket=await stub.issueTicket({workspaceId:'workspace-a',participantId:'caller-a',role:'caller'});const nurseTicket=await stub.issueTicket({workspaceId:'workspace-a',participantId:'nurse-a',role});
  const caller=await connect(callId,String(callerTicket.ok&&callerTicket.ticket));const nurse=await connect(callId,String(nurseTicket.ok&&nurseTicket.ticket));caller.binaryType='arraybuffer';nurse.binaryType='arraybuffer';
  try{
   await stub.command(command('consent','caller-a','caller',{accepted:true}));
   nurse.send(JSON.stringify({type:'media-ready',microphone:true,playback:true}));const heartbeat=message(nurse,'heartbeat');nurse.send(JSON.stringify({type:'heartbeat'}));await heartbeat;
   const before=await waitSnapshot(stub,s=>s.conversationOwner==='AI');expect(before.participants.nurse).toBe(false);
   const claim=command('claim','nurse-a',role);const claimed=await stub.command(claim);
   expect(claimed).toMatchObject({ok:true,snapshot:{queueState:'CLAIMED',conversationOwner:'AI',controlEpoch:before.controlEpoch,responseGeneration:before.responseGeneration,participants:{nurse:true},mediaReady:{nurse:true}}});
   expect(await stub.command(claim)).toEqual(claimed);
   await stub.command(command('takeover','nurse-a',role));caller.send(JSON.stringify({type:'media-ready',microphone:true,playback:true}));
   const ready=await waitSnapshot(stub,s=>s.controlEpoch>before.controlEpoch);expect(ready).toMatchObject({queueState:'CLAIMED',conversationOwner:'HANDOFF_PENDING',handoff:{callerFlushed:false,callerHeard:false,nurseHeard:false}});
   caller.send(JSON.stringify({type:'playback-flushed',controlEpoch:ready.controlEpoch,generation:ready.responseGeneration}));await waitSnapshot(stub,s=>Boolean(s.handoff?.callerFlushed));
   const frame=(streamKind:AudioStreamKind)=>encodeAudioFrame({streamKind,sequence:1,sampleRate:24000,controlEpoch:ready.controlEpoch,generation:ready.responseGeneration,responseId:0,payload:new Uint8Array(2400)});
   const atNurse=binary(nurse);caller.send(frame(AudioStreamKind.Patient));await atNurse;nurse.send(JSON.stringify({type:'audio-ack',sequence:1,streamKind:AudioStreamKind.Patient,dropped:false}));
   const oneDirection=await waitSnapshot(stub,s=>Boolean(s.handoff?.nurseHeard));expect(oneDirection.queueState).toBe('CLAIMED');
   const atCaller=binary(caller);nurse.send(frame(AudioStreamKind.Nurse));await atCaller;caller.send(JSON.stringify({type:'audio-ack',sequence:1,streamKind:AudioStreamKind.Nurse,dropped:false}));
   const connected=await waitSnapshot(stub,s=>s.queueState==='CONNECTED');expect(connected.conversationOwner).toBe('NURSE');expect(connected.controlEpoch).toBe(ready.controlEpoch);
  }finally{caller.close();nurse.close();}
 });
 it('does not adopt a different nurse socket readiness when claiming',async()=>{
  const{stub,callId}=await create();const issued=await stub.issueTicket({workspaceId:'workspace-a',participantId:'nurse-b',role:'nurse'});const other=await connect(callId,String(issued.ok&&issued.ticket));
  try{other.send(JSON.stringify({type:'media-ready',microphone:true,playback:true}));const heartbeat=message(other,'heartbeat');other.send(JSON.stringify({type:'heartbeat'}));await heartbeat;
   expect(await stub.command(command('claim'))).toMatchObject({ok:true,snapshot:{participants:{nurse:false},mediaReady:{nurse:false}}});
  }finally{other.close();}
 });
 it('ends a ten-minute call operationally while retaining review and expiry cleanup',async()=>{
  const{stub}=await create();await runInDurableObject(stub,(_instance,state)=>{const row=state.storage.sql.exec<{body:string}>('SELECT body FROM active_state').one();const body=JSON.parse(row.body);body.createdAt=Date.now()-601000;body.callDeadlineAt=Date.now()-1000;state.storage.sql.exec('UPDATE active_state SET body=?',JSON.stringify(body));});await evictDurableObject(stub);await runDurableObjectAlarm(stub);
  const result=await stub.snapshot('workspace-a');expect(result).toMatchObject({ok:true,snapshot:{queueState:'CLOSED',conversationOwner:'NONE'}});expect(result.ok&&result.snapshot?.warnings.join(' ')).toContain('not a clinical disposition');
  expect((await stub.command(command('review'))).ok).toBe(true);
  const alarm=await runInDurableObject(stub,(_instance,state)=>state.storage.getAlarm());expect(alarm).toBeGreaterThan(Date.now()+86400000);
 });
 it('makes duplicate and out-of-order projections idempotent and blocks deletion resurrection',async()=>{
  const{stub,callId}=await create();const result=await stub.snapshot('workspace-a');const initial=(result.ok&&result.snapshot) as CallSnapshot;
  await expect(projectSnapshot(bindings.DB,{...initial,revision:initial.revision+3})).rejects.toThrow('predecessor');
  const newer={...initial,revision:initial.revision+1,queueState:'CLAIMED' as const};await projectSnapshot(bindings.DB,newer);await projectSnapshot(bindings.DB,initial);await projectSnapshot(bindings.DB,newer);
  expect(await bindings.DB.prepare('SELECT revision FROM calls WHERE id=?').bind(callId).first('revision')).toBe(newer.revision);
  await projectSnapshot(bindings.DB,{...newer,revision:newer.revision+1,deleted:true});await expect(projectSnapshot(bindings.DB,{...initial,revision:newer.revision+100})).rejects.toThrow('predecessor');
  expect(await bindings.DB.prepare('SELECT id FROM calls WHERE id=?').bind(callId).first()).toBeNull();expect(await bindings.DB.prepare('SELECT call_id FROM deletion_tombstones WHERE call_id=?').bind(callId).first()).not.toBeNull();
 });
});
