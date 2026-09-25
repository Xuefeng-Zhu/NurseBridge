import { env, exports } from 'cloudflare:workers';
import { reset, runInDurableObject, evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../packages/database/migrations/0001_initial.sql?raw';
import phoneSchema from '../../../packages/database/migrations/0002_phone_inbound.sql?raw';
import { AudioStreamKind, decodeAudioFrame, encodeAudioFrame } from '@nursebridge/audio-client/protocol';
import type { CallSnapshot } from '@nursebridge/contracts';
import type { Env } from '../src/env';

const bindings=env as unknown as Env;
const accountSid=`AC${'1'.repeat(32)}`, providerCallSid=`CA${'2'.repeat(32)}`, streamSid=`MZ${'3'.repeat(32)}`, nonce='fictional-phone-stream-token-for-workers-only';
type Stub=ReturnType<Env['CALL_SESSIONS']['getByName']>;
const openCalls:Stub[]=[];
beforeEach(async()=>{await bindings.DB.exec(schema);await bindings.DB.batch(phoneSchema.replace(/^--.*$/gm,'').split(';').filter(sql=>sql.trim()).map(sql=>bindings.DB.prepare(sql)));vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('External requests disabled in phone tests'));});
afterEach(async()=>{for(const stub of openCalls.splice(0)){try{await stub.phoneStatus({workspaceId:'workspace-a',providerCallSid,status:'completed'});}catch{}}vi.restoreAllMocks();await reset();});
async function create(){
 const callId=crypto.randomUUID(),stub=bindings.CALL_SESSIONS.getByName(callId);
 const streamTokenHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(nonce))),n=>n.toString(16).padStart(2,'0')).join('');
 const input={callId,workspaceId:'workspace-a',callerParticipantId:'phone-caller-a',mode:'mock' as const,provider:'twilio' as const,accountSid,providerCallSid,streamTokenHash,streamTokenExpiresAt:Date.now()+180000};
 expect(await stub.initializePhone(input)).toMatchObject({ok:true,snapshot:{channel:'phone',queueState:'WAITING',consent:false}});openCalls.push(stub);
 await runInDurableObject(stub,instance=>{const internal=instance as unknown as {env:Env};internal.env={...internal.env,TWILIO_ACCOUNT_SID:accountSid,TWILIO_AUTH_TOKEN:'fictional-test-secret'};});
 return{stub,callId,input};
}
async function snapshot(stub:Stub,predicate:(snapshot:CallSnapshot)=>boolean){for(let i=0;i<100;i++){const result=await stub.snapshot('workspace-a');if(result.ok&&result.snapshot&&predicate(result.snapshot))return result.snapshot;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Phone snapshot condition did not settle');}
const cmd=(type:string,payload?:Record<string,unknown>)=>({workspaceId:'workspace-a',participantId:'nurse-a',role:'nurse' as const,commandId:crypto.randomUUID(),type,payload});
type Wire={event:string;streamSid?:string;media?:{payload:string};mark?:{name:string}};
async function phone(stub:Stub,startOverrides:Record<string,unknown>={}){
 const current=await stub.snapshot('workspace-a');const response=await stub.fetch(new Request(`http://localhost/phone/connect/${current.ok&&current.snapshot?.id}`,{headers:{Upgrade:'websocket'}}));expect(response.status).toBe(101);
 const socket=response.webSocket!;socket.accept();const received:Wire[]=[];const history:unknown[]=[];let sequence=1,timestamp=0;
 socket.addEventListener('message',event=>{history.push(event.data);if(typeof event.data==='string')received.push(JSON.parse(event.data) as Wire);});
 const send=(event:string,body:Record<string,unknown>={})=>socket.send(JSON.stringify({event,sequenceNumber:String(++sequence),streamSid,...body}));
 const next=async(event:string)=>{for(let i=0;i<150;i++){const index=received.findIndex(item=>item.event===event);if(index>=0)return received.splice(index,1)[0]!;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error(`Missing phone ${event}`);};
 const mark=(name:string)=>send('mark',{mark:{name}});
 const media=(samples=480)=>{const payload=btoa(String.fromCharCode(...new Uint8Array(samples).fill(255)));send('media',{media:{track:'inbound',timestamp:String(timestamp),payload}});timestamp+=samples/8;};
 const stop=()=>send('stop',{stop:{accountSid,callSid:providerCallSid}});
 socket.send(JSON.stringify({event:'connected',protocol:'Call',version:'1.0.0'}));
 socket.send(JSON.stringify({event:'start',sequenceNumber:'1',streamSid,start:{accountSid,callSid:providerCallSid,streamSid,tracks:['inbound'],mediaFormat:{encoding:'audio/x-mulaw',sampleRate:8000,channels:1},customParameters:{token:nonce},...startOverrides}}));
 return{socket,send,next,mark,media,stop,history};
}
async function ready(stub:Stub){const peer=await phone(stub);const barrier=await peer.next('mark');peer.mark(barrier.mark!.name);peer.media();await snapshot(stub,s=>s.participants.caller&&Boolean((s as CallSnapshot&{mediaReady:{caller:boolean}}).mediaReady.caller));return peer;}
function event(socket:WebSocket,type:string):Promise<Record<string,unknown>>{return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Missing ${type}`)),2000);const listener=(e:MessageEvent)=>{if(typeof e.data!=='string')return;const body=JSON.parse(e.data);if(body.type===type){clearTimeout(timer);socket.removeEventListener('message',listener);resolve(body);}};socket.addEventListener('message',listener);});}
function binary(socket:WebSocket):Promise<ArrayBuffer>{return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Missing patient PCM')),2000);const listener=(e:MessageEvent)=>{if(typeof e.data==='string')return;clearTimeout(timer);socket.removeEventListener('message',listener);resolve(e.data as ArrayBuffer);};socket.addEventListener('message',listener);});}
async function nurse(stub:Stub,callId:string){const ticket=await stub.issueTicket({workspaceId:'workspace-a',participantId:'nurse-a',role:'nurse'});const response=await exports.default.fetch(`http://localhost/connect/${callId}`,{headers:{Upgrade:'websocket',Origin:'http://localhost:8787'}});const socket=response.webSocket!;socket.accept();socket.binaryType='arraybuffer';const authenticated=event(socket,'authenticated');socket.send(JSON.stringify({type:'auth',ticket:ticket.ok&&ticket.ticket}));await authenticated;socket.send(JSON.stringify({type:'media-ready',microphone:true,playback:true}));return socket;}

describe('phone media in the authoritative CallSession',()=>{
 it('accepts media immediately following start without racing nonce authentication',async()=>{
  const{stub}=await create();const peer=await phone(stub);peer.media();const barrier=await peer.next('mark');peer.mark(barrier.mark!.name);
  await snapshot(stub,s=>Boolean((s as CallSnapshot&{mediaReady:{caller:boolean}}).mediaReady.caller));expect(globalThis.fetch).not.toHaveBeenCalled();peer.stop();await snapshot(stub,s=>s.queueState==='CLOSED');
 });
 it('waits for capture and a fresh playback barrier, exposes no provider identity, and stops without REST',async()=>{
  const{stub,input}=await create();expect(await stub.initializePhone(input)).toMatchObject({ok:true});
  const peer=await phone(stub);await peer.next('clear');const barrier=await peer.next('mark');
  const waiting=await snapshot(stub,s=>s.participants.caller);expect((waiting as CallSnapshot&{mediaReady:{caller:boolean}}).mediaReady.caller).toBe(false);
  peer.media();await new Promise(resolve=>setTimeout(resolve,30));expect((await stub.snapshot('workspace-a'))).toMatchObject({ok:true,snapshot:{mediaReady:{caller:false},consent:false,conversationOwner:'NONE'}});
  peer.mark(barrier.mark!.name);const active=await snapshot(stub,s=>Boolean((s as CallSnapshot&{mediaReady:{caller:boolean}}).mediaReady.caller));
  expect(JSON.stringify(active)).not.toMatch(/AC111|CA222|MZ333|streamToken/);expect(await stub.issueTicket({workspaceId:'workspace-a',participantId:'phone-caller-a',role:'caller'})).toMatchObject({ok:false,status:403});
  expect(peer.history.every(item=>typeof item==='string'&&['clear','media','mark'].includes((JSON.parse(item) as Wire).event))).toBe(true);
  peer.stop();await snapshot(stub,s=>s.queueState==='CLOSED');expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(await stub.fetchPhone(new Request('http://localhost/phone/connect/test',{headers:{Upgrade:'websocket'}}))).toHaveProperty('status',404);
 });
 it.each([
  {accountSid:`AC${'9'.repeat(32)}`},
  {callSid:`CA${'9'.repeat(32)}`},
  {customParameters:{token:'wrong-stream-token-that-is-long-enough'}},
  {mediaFormat:{encoding:'audio/x-mulaw',sampleRate:16000,channels:1}},
 ])('rejects a wrong phone start without consuming the legitimate binding',async overrides=>{
  const{stub}=await create();const peer=await phone(stub,overrides);const closed=new Promise<number>(resolve=>peer.socket.addEventListener('close',event=>resolve(event.code)));expect(await closed).toBe(1008);
  expect(await stub.snapshot('workspace-a')).toMatchObject({ok:true,snapshot:{participants:{caller:false},queueState:'WAITING'}});const valid=await ready(stub);valid.stop();await snapshot(stub,s=>s.queueState==='CLOSED');expect(globalThis.fetch).not.toHaveBeenCalled();
 });
 it('keeps unavailable intake distinct from caller refusal and never plays mock AI',async()=>{
  const{stub}=await create();expect(await stub.phoneConsent({workspaceId:'workspace-a',providerCallSid,commandId:'accepted',decision:'accepted'})).toMatchObject({ok:false,status:503});
  const consent={workspaceId:'workspace-a',providerCallSid,commandId:'unavailable',decision:'unavailable' as const};expect(await stub.phoneConsent(consent)).toMatchObject({ok:true,snapshot:{consent:false,waitingReason:'technical_failure',intakeState:'INTERRUPTED',humanRequested:true,aiStatus:'stopped'}});expect(await stub.phoneConsent(consent)).toMatchObject({ok:true});
  const peer=await ready(stub);expect(await stub.snapshot('workspace-a')).toMatchObject({ok:true,snapshot:{consent:false,conversationOwner:'NONE',assistantTurns:[]}});peer.stop();await snapshot(stub,s=>s.queueState==='CLOSED');
 });
 it('preserves explicit refusal and scopes phone callbacks to their private binding',async()=>{
  const{stub}=await create();expect(await stub.phoneConsent({workspaceId:'workspace-b',providerCallSid,commandId:'declined',decision:'declined'})).toMatchObject({ok:false,status:404});
  expect(await stub.phoneStatus({workspaceId:'workspace-a',providerCallSid:`CA${'4'.repeat(32)}`,status:'completed'})).toMatchObject({ok:false,status:404});
  expect(await stub.phoneConsent({workspaceId:'workspace-a',providerCallSid,commandId:'declined',decision:'declined'})).toMatchObject({ok:true,snapshot:{waitingReason:'consent_refused',consent:false,humanRequested:true,intakeState:'DECLINED'}});
 });
 it('fences a carrier completion that arrived before call initialization',async()=>{
  const callId=crypto.randomUUID(),stub=bindings.CALL_SESSIONS.getByName(callId);await bindings.DB.prepare("INSERT INTO inbound_calls(provider,account_sid,provider_call_sid,created_at,status,terminal_at) VALUES('twilio',?,?,?,'completed',?)").bind(accountSid,providerCallSid,Date.now(),Date.now()).run();
  const result=await stub.initializePhone({callId,workspaceId:'workspace-a',callerParticipantId:'phone-caller-a',mode:'mock',provider:'twilio',accountSid,providerCallSid,streamTokenHash:'a'.repeat(64),streamTokenExpiresAt:Date.now()+180000});expect(result).toMatchObject({ok:false,status:409,code:'closed'});expect(await stub.snapshot('workspace-a')).toMatchObject({ok:false,status:404});
 });
 it('retains the carrier binding and deadline alarm when queue projection fails',async()=>{
  const callId=crypto.randomUUID(),stub=bindings.CALL_SESSIONS.getByName(callId);openCalls.push(stub);
  await runInDurableObject(stub,async(instance,state)=>{
   const internal=instance as unknown as {flushProjection():Promise<void>;phone:unknown};const projection=vi.spyOn(internal,'flushProjection').mockResolvedValue();
   try{expect(await instance.initializePhone({callId,workspaceId:'workspace-a',callerParticipantId:'phone-caller-a',mode:'mock',provider:'twilio',accountSid,providerCallSid,streamTokenHash:'a'.repeat(64),streamTokenExpiresAt:Date.now()+180000})).toMatchObject({ok:false,status:503});expect(internal.phone).toMatchObject({providerCallSid,consumed:false});expect(await state.storage.getAlarm()).not.toBeNull();}finally{projection.mockRestore();}
  });
  expect(await stub.phoneStatus({workspaceId:'workspace-a',providerCallSid,status:'completed'})).toMatchObject({ok:true,snapshot:{queueState:'CLOSED'}});expect(globalThis.fetch).not.toHaveBeenCalled();
 });
 it('requires fresh carrier marks and browser playback proof for two-way human ownership',async()=>{
  const{stub,callId}=await create();const peer=await ready(stub);await stub.command(cmd('claim'));const staff=await nurse(stub,callId);
  await stub.command(cmd('takeover'));const interrupted=await peer.next('mark');const barrier=await peer.next('mark');
  const pending=await snapshot(stub,s=>s.conversationOwner==='HANDOFF_PENDING');peer.mark(interrupted.mark!.name);await new Promise(resolve=>setTimeout(resolve,20));expect(await stub.snapshot('workspace-a')).toMatchObject({ok:true,snapshot:{handoff:{callerFlushed:false}}});
  peer.mark(barrier.mark!.name);const flushed=await snapshot(stub,s=>Boolean(s.handoff?.callerFlushed));
  const atNurse=binary(staff);peer.media(480);const patient=decodeAudioFrame(await atNurse);expect(patient).toMatchObject({streamKind:AudioStreamKind.Patient,sampleRate:24000,controlEpoch:flushed.controlEpoch});expect(patient.payload.byteLength).toBe(2400);
  staff.send(JSON.stringify({type:'audio-ack',sequence:patient.sequence,streamKind:AudioStreamKind.Patient,dropped:false}));await snapshot(stub,s=>Boolean(s.handoff?.nurseHeard));
  staff.send(encodeAudioFrame({streamKind:AudioStreamKind.Nurse,sequence:1,sampleRate:24000,controlEpoch:flushed.controlEpoch,generation:flushed.responseGeneration,responseId:0,payload:new Uint8Array(2400)}));
  const played=await peer.next('mark');expect(await stub.snapshot('workspace-a')).toMatchObject({ok:true,snapshot:{queueState:'CLAIMED',handoff:{callerHeard:false}}});peer.mark(played.mark!.name);
  const connected=await snapshot(stub,s=>s.queueState==='CONNECTED');expect(connected).toMatchObject({conversationOwner:'NURSE',controlEpoch:pending.controlEpoch});
  peer.send('dtmf',{dtmf:{track:'inbound_track',digit:'0'}});await snapshot(stub,s=>s.humanRequested);expect(await stub.snapshot('workspace-a')).toMatchObject({ok:true,snapshot:{conversationOwner:'NURSE'}});
  peer.stop();await snapshot(stub,s=>s.queueState==='CLOSED');expect(globalThis.fetch).not.toHaveBeenCalled();staff.close();
 });
 it('keeps an AI reply speaking until the carrier acknowledges its resampler tail',async()=>{
  const{stub}=await create();const peer=await ready(stub);
  await runInDurableObject(stub,(instance,state)=>{
   const internal=instance as unknown as {state:{conversationOwner:string;consent:boolean;controlEpoch:number;responseGeneration:number};voiceReplies:Map<string,unknown>;currentSpeech:unknown;enqueueVoiceAudio(pcm:Uint8Array,replyId:string):void;finishVoiceReply(replyId:string,status:'completed'):Promise<void>};
   internal.state.conversationOwner='AI';internal.state.consent=true;
   const reply={epoch:internal.state.controlEpoch,generation:internal.state.responseGeneration,responseId:7,startedAt:Date.now(),playbackMeasured:false,audioReadyMeasured:false};internal.voiceReplies.set('tail-regression',reply);internal.currentSpeech=reply;
   internal.enqueueVoiceAudio(new Uint8Array(2400),'tail-regression');state.waitUntil(internal.finishVoiceReply('tail-regression','completed'));
  });
  const audio=await peer.next('mark');const tail=await peer.next('mark');peer.mark(audio.mark!.name);
  await new Promise(resolve=>setTimeout(resolve,30));expect(await stub.snapshot('workspace-a')).toMatchObject({ok:true,snapshot:{aiStatus:'speaking'}});
  peer.mark(tail.mark!.name);await snapshot(stub,s=>s.aiStatus==='listening');
  const media=peer.history.filter((entry):entry is string=>typeof entry==='string').map(entry=>JSON.parse(entry) as Wire).filter(entry=>entry.event==='media').map(entry=>atob(entry.media!.payload).length);
  expect(media.slice(-2).reduce((sum,n)=>sum+n,0)).toBe(400);peer.stop();await snapshot(stub,s=>s.queueState==='CLOSED');expect(globalThis.fetch).not.toHaveBeenCalled();
 });
 it('terminates after a stream failure and durably retries before releasing admission',async()=>{
  const{stub}=await create();const peer=await ready(stub);peer.socket.close(1000,'Synthetic network interruption');await snapshot(stub,s=>s.queueState==='CLOSED');
  await runInDurableObject(stub,instance=>{const phone=(instance as unknown as {phone:{terminationPending:boolean;terminationRetryAt?:number};savePhone():void}).phone;expect(phone.terminationPending).toBe(true);phone.terminationRetryAt=0;(instance as unknown as {savePhone():void}).savePhone();});
  vi.mocked(globalThis.fetch).mockImplementation(async()=>new Response('{}',{status:200}));await runDurableObjectAlarm(stub);expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  await runInDurableObject(stub,instance=>{expect((instance as unknown as {phone:unknown}).phone).toMatchObject({terminated:true,terminationPending:false,reservationReleasePending:false});});expect(globalThis.fetch).toHaveBeenCalledTimes(2);
 });
 it('ends and scrubs a deleted phone case while retaining failed carrier cleanup for retry',async()=>{
  const{stub}=await create();await ready(stub);expect(await stub.command({...cmd('delete'),role:'admin'})).toMatchObject({ok:true,snapshot:{deleted:true}});
  await runInDurableObject(stub,(instance,state)=>{const internal=instance as unknown as {phone:{terminationPending:boolean;terminationRetryAt:number;streamTokenHash:string}};expect(internal.phone).toMatchObject({terminationPending:true,streamTokenHash:'',accountSid:''});internal.phone.terminationRetryAt=0;(instance as unknown as {savePhone():void}).savePhone();expect(state.storage.sql.exec('SELECT body FROM phone_binding').toArray()).toHaveLength(1);});
  vi.mocked(globalThis.fetch).mockImplementation(async()=>new Response('{}',{status:200}));await runDurableObjectAlarm(stub);expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  await runInDurableObject(stub,(_instance,state)=>{expect(state.storage.sql.exec('SELECT body FROM phone_binding').toArray()).toHaveLength(0);});expect(await stub.phoneStatus({workspaceId:'workspace-a',providerCallSid,status:'completed'})).toMatchObject({ok:true});
 });
 it('ends the carrier leg on object recovery without restarting AI',async()=>{
  const{stub}=await create();await ready(stub);vi.mocked(globalThis.fetch).mockImplementation(async()=>new Response('{}',{status:200}));await evictDurableObject(stub);await snapshot(stub,s=>s.queueState==='CLOSED');await runInDurableObject(stub,instance=>{const internal=instance as unknown as {env:Env;phone:{terminationRetryAt:number};savePhone():void};internal.env={...internal.env,TWILIO_ACCOUNT_SID:accountSid,TWILIO_AUTH_TOKEN:'fictional-test-secret'};internal.phone.terminationRetryAt=0;internal.savePhone();});await runDurableObjectAlarm(stub);expect(globalThis.fetch).toHaveBeenCalledOnce();expect(await stub.snapshot('workspace-a')).toMatchObject({ok:true,snapshot:{conversationOwner:'NONE',consent:false}});
 });
 it.each(['end','deadline'])('terminates an admitted carrier call on %s even before media starts',async action=>{
  const{stub}=await create();vi.mocked(globalThis.fetch).mockImplementation(async()=>new Response('{}',{status:200}));
  if(action==='end')await stub.command(cmd('end'));
  else{await runInDurableObject(stub,instance=>{const internal=instance as unknown as {state:{callDeadlineAt:number};checkpoint():void};internal.state.callDeadlineAt=Date.now()-1;internal.checkpoint();});await runDurableObjectAlarm(stub);}
  await snapshot(stub,s=>s.queueState==='CLOSED');for(let i=0;i<30&&!vi.mocked(globalThis.fetch).mock.calls.length;i++)await new Promise(resolve=>setTimeout(resolve,10));expect(globalThis.fetch).toHaveBeenCalledOnce();
 });
});
