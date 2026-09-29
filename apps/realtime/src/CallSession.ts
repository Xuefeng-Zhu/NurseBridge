import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { EMERGENCY_COPY, FieldSchema, ProposedFactSchema, type IntakeTemplate, type TranscriptTurn, type RpcResult } from '@nursebridge/contracts';
import { assessCollection, markQuestion, mockExtraction, validateExtraction } from '@nursebridge/intake-policy';
import { AudioStreamKind, decodeAudioFrame, encodeAudioFrame, type AudioFrame } from '@nursebridge/audio-client/protocol';
import { SessionStore } from './persistence/store';
import { projectSnapshot } from './persistence/project';
import { connectVoiceAgent, deleteVoiceAgentSession, type VoiceAgent, type VoiceToolCall } from './providers/voice-agent';
import { liveActivationIssues } from './providers/readiness';
import { intakePrompt, INTAKE_TOOLS, explicitRequest } from './intake-agent';
import { extract } from './providers/nebius';
import { newState, transition, requestHandoff, applyFacts, CommandError, fail, type CallState, type Command, type Role } from './state';
import type { Env } from './env';
import { PhoneTransport } from './telephony/transport';
import { terminatePhoneCall, releasePhoneReservation } from './telephony/twilio';

type Attachment={authenticated:boolean;role?:Role;participantId?:string;expiresAt:number;lastHeartbeat:number;mediaReady:boolean;lastSequence:number;audioWindowStart?:number;audioFrames?:number;pending:{sequence:number;streamKind:number;responseId?:number}[];transport?:'phone';phone?:{streamSid:string;lastEventSequence:number;nextAudioSequence:number;lastTimestamp:number;captureReady:boolean;playbackReady:boolean}};
type PhoneBinding={provider:'twilio';workspaceId:string;accountSid:string;providerCallSid:string;streamTokenHash:string;streamTokenExpiresAt:number;consumed:boolean;streamSid?:string;terminated:boolean;terminationPending:boolean;terminationAttempts:number;terminationRetryAt?:number;reservationReleasePending?:boolean;consentDecision?:'accepted'|'declined'|'unavailable';consentCommandId?:string};
type Ticket={workspaceId:string;participantId:string;role:Role;expiresAt:number;audience:'nursebridge-realtime';callId:string};
const errorResult=(error:unknown):RpcResult=>error instanceof CommandError?{ok:false,status:error.status,error:error.message,code:error.code}:{ok:false,status:503,error:'The session is temporarily unavailable.',code:'session_unavailable'};
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const intakeValidationErrors=new Set(['Field outside template','Evidence quote does not match finalized transcript','Raw wording is unsupported','Value must preserve supported wording','Not measured cannot be a denial','Uncertainty must be retained','Question outside template']);

export class CallSession extends DurableObject<Env>{
 private store:SessionStore;
 private state?:CallState;
 private voice?:VoiceAgent;
 private providerConnection=0;
 private openingSession?:string;
 private voiceReplies=new Map<string,{epoch:number;generation:number;responseId:number;startedAt:number;playbackMeasured:boolean;audioReadyMeasured:boolean}>();
 private voiceQueue:{pcm:Uint8Array;replyId:string}[]=[];
 private voiceQueueBytes=0;
 private voiceDrain=false;
 private connecting=false;
 private projectionTask?:Promise<void>;
 private extractionBusy=false;
 private extractionAbort?:AbortController;
 private extractionAgain=false;
 private speechSequence=0;
 private generationJob=0;
 private currentSpeech?:{epoch:number;generation:number;responseId:number;startedAt:number;playbackMeasured:boolean};
 private reconnectAt=0;
 private projectionRetryAt=0;
 private phone?:PhoneBinding;
 private phoneTransports=new Map<WebSocket,PhoneTransport>();
 private phoneTerminationBusy=false;
 constructor(ctx:DurableObjectState,env:Env){
  super(ctx,env);this.store=new SessionStore(ctx.storage);this.state=this.store.load();
  this.store.storage.sql.exec('CREATE TABLE IF NOT EXISTS phone_binding(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL)');
  const phoneRow=this.store.storage.sql.exec<{body:string}>('SELECT body FROM phone_binding WHERE id=1').toArray()[0];if(phoneRow)this.phone=JSON.parse(phoneRow.body) as PhoneBinding;
  this.store.storage.sql.exec("UPDATE provider_connections SET status='manual_reconciliation_required' WHERE status='connecting'");
  if(this.state&&!this.state.deleted&&(this.state.provider.connected||this.state.participants.caller||this.state.participants.nurse)){
   this.mutate(s=>{s.provider.connected=false;s.provider.warning='Session restarted; a transcription gap may be present.';s.providerSession.status='interrupted';s.aiStatus='stopped';s.conversationOwner='NONE';s.waitingReason='technical_failure';s.humanRequested=true;s.controlEpoch++;s.responseGeneration++;s.participants={caller:false,nurse:false};s.mediaReady={caller:false,nurse:false};s.queueState=s.claim?'CLAIMED':'WAITING';delete s.handoff;s.warnings.push('Session restarted. Automated intake will not restart; reconnect for nurse help.');s.escalations.push({id:crypto.randomUUID(),reason:'technical_failure',message:'Call interrupted by restart; nurse help requested.',at:Date.now()});},'recovery','Session recovered from durable storage.');
   for(const socket of ctx.getWebSockets())socket.close(1012,'Reconnect with a new connection ticket');
  }
  // A phone cannot obtain a fresh browser ticket after object recovery. End its
  // carrier leg durably instead of keeping an inaudible, billable call alive.
  if(this.phone&&!this.phone.terminated&&this.phone.consumed){
   if(this.state&&!this.state.deleted&&this.state.queueState!=='CLOSED')this.mutate(s=>{s.queueState='CLOSED';s.conversationOwner='NONE';s.aiStatus='stopped';s.controlEpoch++;s.responseGeneration++;delete s.handoff;},'phone-restart','Phone media interrupted by restart; carrier call is ending.');
   this.requestPhoneTermination();this.ctx.waitUntil(this.flushProjection());
  }else if(this.phone?.terminationPending||this.phone?.reservationReleasePending)this.ctx.waitUntil(this.retryPhoneTermination());
 }
 private mutate(update:(state:CallState)=>void,type:string,message:string){
  if(!this.state)fail(404,'not_found','Call not found.');
  const next=structuredClone(this.state!);
  this.ctx.storage.transactionSync(()=>{update(next);this.store.commit(next,type,message);});this.state=next;
 }
 private checkpoint(){if(this.state)this.store.save(this.state);}
 private visibleSnapshot(){return this.state?structuredClone(this.state):undefined;}
 private send(socket:WebSocket,message:unknown){
  const a=socket.deserializeAttachment() as Attachment|null;
  if(a?.transport==='phone'){
   const input=message as {type?:string;controlEpoch?:number;generation?:number};
   if(input.type==='flush'&&typeof input.controlEpoch==='number'&&typeof input.generation==='number'){
    try{this.phoneTransports.get(socket)?.flush(input.controlEpoch,input.generation);}catch{this.phoneTransportFailure(socket);}
   }
   return;
  }
  try{socket.send(JSON.stringify(message));}catch{/* Disconnected; close handler updates durable state. */}
 }
 private broadcast(message:unknown){for(const socket of this.ctx.getWebSockets()){const a=socket.deserializeAttachment() as Attachment|null;if(a?.authenticated&&a.expiresAt>Date.now())this.send(socket,message);}}
 private publish(){this.broadcast({type:'snapshot',snapshot:this.visibleSnapshot()});this.ctx.waitUntil(this.flushProjection());this.ctx.waitUntil(this.scheduleAlarm());}
 private scoped(workspaceId:string){if(!this.state||this.state.workspaceId!==workspaceId)fail(404,'not_found','Call not found.');if(this.state!.deleted)fail(410,'deleted','Call has been deleted.');return this.state!;}
 private abortAi(reason:string,increment=true){
  this.generationJob++;this.currentSpeech=undefined;this.extractionAbort?.abort();this.voiceReplies.clear();this.voiceQueue=[];this.voiceQueueBytes=0;
  if(reason==='barge-in'||reason==='speech-started')this.voice?.interrupt();
  if(increment&&this.state)this.mutate(s=>{s.responseGeneration++;},'interruption','Agent output interrupted.');
  for(const socket of this.ctx.getWebSockets()){const a=socket.deserializeAttachment() as Attachment|null;if(a){a.pending=[];socket.serializeAttachment(a);}}
  if(this.state)this.broadcast({type:'flush',controlEpoch:this.state.controlEpoch,generation:this.state.responseGeneration,reason});
 }
 private stopProvider(){
  this.providerConnection++;this.voice?.close();this.voice=undefined;this.connecting=false;this.reconnectAt=0;
  this.voiceReplies.clear();this.voiceQueue=[];this.voiceQueueBytes=0;
  if(this.state){this.state.provider.connected=false;if(['active','connecting','ending'].includes(this.state.providerSession.status)){this.state.providerSession.status='ended';this.state.providerSession.endedAt=Date.now();}this.checkpoint();}
 }


 async initialize(input:{callId:string;workspaceId:string;callerParticipantId:string;template?:IntakeTemplate;mode:'mock'|'live';channel?:'browser'|'phone';createdAt?:number;expiresAt?:number}):Promise<RpcResult>{
  try{
   if(!/^[a-zA-Z0-9_-]{8,100}$/.test(input.callId)||!input.workspaceId||!input.callerParticipantId)fail(400,'invalid_call','Invalid call initialization.');
   if(this.state){this.scoped(input.workspaceId);if(this.state.callerParticipantId!==input.callerParticipantId)fail(403,'forbidden','Call owner mismatch.');}
   else{
    if(input.mode!==this.env.PROVIDER_MODE)fail(400,'mode_mismatch','Requested provider mode does not match the configured worker.');
    const createdAt=input.createdAt??Date.now();this.state=newState({...input,createdAt,callDeadlineAt:createdAt+Number(this.env.MAX_CALL_SECONDS??600)*1000});this.ctx.storage.transactionSync(()=>this.store.commit(this.state!,'arrived','Caller joined the queue before intake.'));
   }
   await this.flushProjection();
   if(!this.state||this.state.projection.revision<1)fail(503,'queue_initializing','Queue entry is still initializing. Retry with the same command ID.');
   await this.scheduleAlarm();return{ok:true,snapshot:this.visibleSnapshot()};
  }catch(error){return errorResult(error);}
 }
 async initializePhone(input:{callId:string;workspaceId:string;callerParticipantId:string;mode:'mock'|'live';template?:IntakeTemplate;provider:'twilio';accountSid:string;providerCallSid:string;streamTokenHash:string;streamTokenExpiresAt:number;createdAt?:number;expiresAt?:number}):Promise<RpcResult>{
  try{
   if(input.provider!=='twilio'||!/^AC[0-9a-f]{32}$/i.test(input.accountSid)||!/^CA[0-9a-f]{32}$/i.test(input.providerCallSid)||!/^[0-9a-f]{64}$/.test(input.streamTokenHash)||!Number.isFinite(input.streamTokenExpiresAt))fail(400,'invalid_phone','Invalid phone initialization.');
   const receipt=await this.env.DB.prepare('SELECT terminal_at FROM inbound_calls WHERE provider=? AND account_sid=? AND provider_call_sid=?').bind(input.provider,input.accountSid,input.providerCallSid).first<{terminal_at:number|null}>();
   if(receipt?.terminal_at!==null&&receipt?.terminal_at!==undefined)fail(409,'closed','Phone call has already ended.');
   if(this.state&&this.state.channel!=='phone')fail(409,'phone_binding_mismatch','An existing browser call cannot become a phone call.');
   if(this.phone){
    if(this.phone.workspaceId!==input.workspaceId||this.phone.accountSid!==input.accountSid||this.phone.providerCallSid!==input.providerCallSid||this.phone.streamTokenHash!==input.streamTokenHash||this.phone.streamTokenExpiresAt!==input.streamTokenExpiresAt)fail(409,'phone_binding_mismatch','Phone initialization does not match the existing binding.');
    if(this.phone.terminated||this.phone.terminationPending)fail(409,'closed','Phone call has ended.');
   }else if(input.streamTokenExpiresAt<=Date.now()||input.streamTokenExpiresAt>Date.now()+300000)fail(400,'phone_token_expiry','Phone stream token must expire within five minutes.');
   if(!/^[a-zA-Z0-9_-]{8,100}$/.test(input.callId)||!input.workspaceId||!input.callerParticipantId||input.mode!==this.env.PROVIDER_MODE)fail(400,'invalid_phone','Invalid phone initialization.');
   if(!this.phone){this.phone={provider:'twilio',workspaceId:input.workspaceId,accountSid:input.accountSid,providerCallSid:input.providerCallSid,streamTokenHash:input.streamTokenHash,streamTokenExpiresAt:input.streamTokenExpiresAt,consumed:false,terminated:false,terminationPending:false,terminationAttempts:0};this.savePhone();}
   const initialized=await this.initialize({...input,channel:'phone'});await this.scheduleAlarm();return initialized;
  }catch(error){return errorResult(error);}
 }
 async phoneConsent(input:{workspaceId:string;providerCallSid:string;commandId:string;decision:'accepted'|'declined'|'unavailable';recordingAccepted?:boolean;disclosureVersion?:string}):Promise<RpcResult>{
  try{
   const state=this.scoped(input.workspaceId);this.assertPhone(input.workspaceId,input.providerCallSid);
   if(!input.commandId||input.commandId.length>120||!['accepted','declined','unavailable'].includes(input.decision))fail(400,'invalid_phone_consent','Invalid phone consent decision.');
   if(this.phone!.consentDecision){
    if(this.phone!.consentDecision!==input.decision||this.phone!.consentCommandId!==input.commandId)fail(409,'phone_consent_mismatch','The phone disclosure already has a decision.');
    return{ok:true,snapshot:this.visibleSnapshot()};
   }
   if(state.queueState==='CLOSED'||this.phone!.terminated||this.phone!.terminationPending)fail(409,'closed','Phone call has ended.');
   let result:RpcResult;
   if(input.decision==='unavailable'){
    this.mutate(s=>{requestHandoff(s,'technical_failure','Automated phone intake is unavailable. The caller is waiting for a nurse.',Date.now());s.controlRevision++;},'phone-intake-unavailable','Phone intake unavailable; nurse help requested.');this.abortAi('phone-intake-unavailable',false);this.stopProvider();this.publish();result={ok:true,snapshot:this.visibleSnapshot()};
   }else{
    if(input.decision==='accepted'&&state.mode!=='live')fail(503,'phone_ai_unavailable','Automated phone intake requires configured live speech.');
    result=await this.command({workspaceId:input.workspaceId,participantId:state.callerParticipantId,role:'caller',commandId:input.commandId,type:'consent',payload:{accepted:input.decision==='accepted',recordingAccepted:input.recordingAccepted,recordingDisclosureVersion:input.disclosureVersion}});
   }
   if(result.ok){this.phone!.consentDecision=input.decision;this.phone!.consentCommandId=input.commandId;this.savePhone();}
   return result;
  }catch(error){return errorResult(error);}
 }
 async phoneStatus(input:{workspaceId:string;providerCallSid:string;status:string;eventId?:string}):Promise<RpcResult>{
  try{
   if(!this.phone&&this.state?.deleted&&this.state.workspaceId===input.workspaceId)return{ok:true};
   this.assertPhone(input.workspaceId,input.providerCallSid);
   if(!['queued','ringing','in-progress','completed','canceled','failed','busy','no-answer'].includes(input.status))fail(400,'invalid_phone_status','Unknown phone status.');
   if(['completed','canceled','failed','busy','no-answer'].includes(input.status)){
    this.phone!.terminated=true;this.phone!.terminationPending=false;this.phone!.reservationReleasePending=true;delete this.phone!.terminationRetryAt;this.savePhone();this.finishPhoneCall('Phone caller disconnected.');await this.retryPhoneTermination();
   }
   return{ok:true,...(!this.state?.deleted?{snapshot:this.visibleSnapshot()}: {})};
  }catch(error){return errorResult(error);}
 }
 private assertPhone(workspaceId:string,callSid:string){if(!this.phone||this.phone.workspaceId!==workspaceId||this.phone.providerCallSid!==callSid)fail(404,'phone_not_found','Phone call not found.');}
 private savePhone(){if(this.phone)this.store.storage.sql.exec('INSERT INTO phone_binding(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',JSON.stringify(this.phone));}
 private requestPhoneTermination(){
  if(!this.phone||this.phone.terminated)return;
  this.phone.terminationPending=true;this.savePhone();this.ctx.waitUntil(this.retryPhoneTermination());this.ctx.waitUntil(this.scheduleAlarm());
 }
 private async retryPhoneTermination(){
  if(!this.phone||!this.phone.terminationPending&&!this.phone.reservationReleasePending||this.phoneTerminationBusy||(this.phone.terminationRetryAt??0)>Date.now())return;
  this.phoneTerminationBusy=true;
  try{
   if(this.phone.terminationPending&&!this.phone.terminated){await terminatePhoneCall(this.env,this.phone.providerCallSid);if(this.phone){this.phone.terminated=true;this.phone.terminationPending=false;this.phone.reservationReleasePending=true;this.savePhone();}}
   if(this.phone?.reservationReleasePending&&this.state){await releasePhoneReservation(this.env,this.state.id);if(this.phone)this.phone.reservationReleasePending=false;}
   if(this.phone)delete this.phone.terminationRetryAt;
  }
  catch{if(this.phone){this.phone.terminationAttempts++;this.phone.terminationRetryAt=Date.now()+Math.min(300000,10000*2**Math.min(this.phone.terminationAttempts-1,5));}}
  finally{this.savePhone();this.scrubDeletedPhone();this.phoneTerminationBusy=false;await this.scheduleAlarm();}
 }
 private scrubDeletedPhone(){
  if(!this.state?.deleted||!this.phone)return;
  if(this.phone.terminated&&!this.phone.reservationReleasePending){this.store.storage.sql.exec('DELETE FROM phone_binding');this.phone=undefined;return;}
  // Retain only the identifiers required for authenticated status handling and
  // carrier termination until that external side effect succeeds.
  this.phone.accountSid='';this.phone.streamTokenHash='';this.phone.streamTokenExpiresAt=0;delete this.phone.streamSid;delete this.phone.consentDecision;delete this.phone.consentCommandId;this.savePhone();
 }
 private finishPhoneCall(message:string){
  if(this.state&&!this.state.deleted&&this.state.queueState!=='CLOSED'){
   this.mutate(s=>{s.queueState='CLOSED';s.conversationOwner='NONE';s.aiStatus='stopped';s.participants.caller=false;s.mediaReady.caller=false;s.controlEpoch++;s.responseGeneration++;s.controlRevision++;delete s.handoff;},'phone-ended',message);
   this.abortAi('phone-ended',false);this.stopProvider();this.publish();
  }
  for(const [socket,transport] of this.phoneTransports){transport.close();this.phoneTransports.delete(socket);}
  for(const socket of this.ctx.getWebSockets()){try{socket.close(1000,'Phone call ended');}catch{}}
  this.requestPhoneTermination();
 }
 private phoneTransportFailure(socket:WebSocket){
  this.phoneTransports.get(socket)?.close();this.phoneTransports.delete(socket);
  try{socket.close(1008,'Phone media unavailable');}catch{}
  this.finishPhoneCall('Phone media interrupted; carrier call is ending.');
 }
 async snapshot(workspaceId:string):Promise<RpcResult>{try{this.scoped(workspaceId);return{ok:true,snapshot:this.visibleSnapshot()};}catch(error){return errorResult(error);}}
 async issueTicket(input:{workspaceId:string;participantId:string;role:Role}):Promise<RpcResult>{
  try{
   const state=this.scoped(input.workspaceId);if(state.queueState==='CLOSED')fail(409,'closed','Call has ended.');
   if(this.phone&&input.role==='caller')fail(403,'phone_caller','Phone callers connect through the authenticated carrier stream.');
   if(input.role==='caller'&&state.callerParticipantId!==input.participantId)fail(403,'forbidden','Caller identity mismatch.');
   if(!['caller','nurse','observer','admin'].includes(input.role))fail(403,'forbidden','Invalid connection role.');
   const ticket=token();const ticketHash=await hash(ticket);const expiresAt=Date.now()+60000;
   this.scoped(input.workspaceId);
   this.store.storage.sql.exec('INSERT INTO tickets(hash,body,expires_at) VALUES(?,?,?)',ticketHash,JSON.stringify({...input,callId:state.id,audience:'nursebridge-realtime',expiresAt}),expiresAt);
   return{ok:true,ticket,expiresAt,websocketPath:`/connect/${state.id}`};
  }catch(error){return errorResult(error);}
 }
 async command(command:Command):Promise<RpcResult>{
  try{
   this.scoped(command.workspaceId);if(!command.commandId||command.commandId.length>120)fail(400,'command_id','An idempotency command ID is required.');
   const requestHash=await hash(canonical(command));this.scoped(command.workspaceId);
   const prior=this.store.storage.sql.exec<{participant_id:string;request_hash:string;body:string}>('SELECT participant_id,request_hash,body FROM commands WHERE id=?',command.commandId).toArray()[0];
   if(prior){if(prior.participant_id!==command.participantId||prior.request_hash!==requestHash)fail(409,'command_mismatch','Command ID was already used for a different request.');return JSON.parse(prior.body) as RpcResult;}
   const fixtureText=command.payload?.text;
   if(command.type==='mock-turn'&&(typeof fixtureText!=='string'||fixtureText.length>6000))fail(400,'invalid_fixture','A replay transcript within the size limit is required.');
   if(command.type==='consent'&&command.payload?.accepted===true&&this.state!.mode==='live'&&liveActivationIssues(this.phone?{...this.env,FICTIONAL_LIVE_TEST:undefined}:this.env).length)fail(503,'live_activation_blocked','Voice Agent requires verified Nemotron compatibility and provider recording controls. Request a nurse instead.');
   const next=structuredClone(this.state!);
   this.ctx.storage.transactionSync(()=>{
    transition(next,command,Date.now());
    if(command.type==='consent'&&next.consent&&next.mode==='mock')next.providerSession={...next.providerSession,status:'active',id:`fixture-${next.id}`,startedAt:Date.now()};
    if(command.type==='claim'){
     // A nurse can enable media while observing, before owning the claim. Use
     // only this claimant's live authenticated staff sockets, in the same
     // transaction as the claim and its idempotent response.
     const now=Date.now();
     const claimant=this.ctx.getWebSockets().flatMap(socket=>{
      const a=socket.deserializeAttachment() as Attachment|null;
      return socket.readyState===WebSocket.OPEN&&a?.authenticated&&a.participantId===next.claim?.participantId&&(a.role==='nurse'||a.role==='admin')&&a.expiresAt>now&&now-a.lastHeartbeat<=30000?[a]:[];
     });
     next.participants.nurse=claimant.length>0;next.mediaReady.nurse=claimant.some(a=>a.mediaReady);
    }
    if(command.type==='intake'){
     let facts;
     try{facts=ProposedFactSchema.array().max(16).parse(command.payload?.facts);validateExtraction({facts,nextQuestionId:null},next.turns,next.template);}
     catch(error){
      if(error instanceof z.ZodError||error instanceof Error&&intakeValidationErrors.has(error.message))fail(400,'invalid_intake','Intake facts must use valid fields and matching finalized caller evidence.');
      throw error;
     }
     applyFacts(next,facts,Date.now(),command.participantId);
    }

    this.store.commit(next,command.type,`Call action: ${command.type}.`);
    const result={ok:true,snapshot:next};this.store.storage.sql.exec('INSERT INTO commands(id,participant_id,request_hash,body) VALUES(?,?,?,?)',command.commandId,command.participantId,requestHash,JSON.stringify(result));
   });this.state=next;
   if(['end','delete'].includes(command.type)||command.type==='request-human'&&next.conversationOwner!=='NURSE'||command.type==='consent'&&!next.consent){this.abortAi(command.type,false);this.stopProvider();}
   if(['end','delete'].includes(command.type))this.requestPhoneTermination();
   if(command.type==='takeover'){this.abortAi('takeover',true);this.stopProvider();this.ctx.waitUntil(this.beginHandoff());}
   if(command.type==='consent'&&next.consent)this.ctx.waitUntil(this.startIntake());
   if(command.type==='mock-turn'){
    this.ctx.waitUntil(this.acceptTurn({id:`mock:${crypto.randomUUID()}`,sessionId:'fixture',order:next.turns.length,text:fixtureText as string,final:true,at:Date.now()}));
   }
   if(command.type==='delete')await this.eraseContent();
   if(command.type==='end'){this.publish();for(const socket of this.ctx.getWebSockets())socket.close(1000,'Call ended');}
   this.publish();return{ok:true,snapshot:this.visibleSnapshot()};
  }catch(error){return errorResult(error);}
 }
 async reserveExport(input:{workspaceId:string;exportId:string;key:string;expiresAt?:number}):Promise<RpcResult>{
  try{const state=this.scoped(input.workspaceId);if(!input.key.startsWith(`${state.workspaceId}/${state.id}/`))fail(400,'export_key','Invalid export key.');this.store.storage.sql.exec('INSERT OR IGNORE INTO export_reservations(id,object_key,status) VALUES(?,?,?)',input.exportId,input.key,'reserved');return{ok:true,snapshot:this.visibleSnapshot()};}catch(error){return errorResult(error);}
 }
 async finalizeExport(input:{workspaceId:string;exportId:string;key:string}):Promise<RpcResult>{
  try{this.scoped(input.workspaceId);const row=this.store.storage.sql.exec<{object_key:string}>('SELECT object_key FROM export_reservations WHERE id=?',input.exportId).toArray()[0];if(row?.object_key!==input.key)fail(404,'export_missing','Export reservation not found.');this.store.storage.sql.exec('UPDATE export_reservations SET status=? WHERE id=?','complete',input.exportId);return{ok:true};}catch(error){await this.env.EXPORTS?.delete(input.key);return errorResult(error);}
 }
 async fetch(request:Request):Promise<Response>{
  if(new URL(request.url).pathname===`/phone/connect/${this.state?.id}`)return this.fetchPhone(request);
  if(!this.state||this.state.deleted||this.state.queueState==='CLOSED')return new Response('Call unavailable',{status:404});
  if(!this.env.ALLOWED_ORIGINS.split(',').map(o=>o.trim()).includes(request.headers.get('Origin')??''))return new Response('Origin not allowed',{status:403});
  if(this.ctx.getWebSockets().length>=12)return new Response('Connection limit',{status:429});
  const pair=new WebSocketPair();const [client,server]=Object.values(pair) as [WebSocket,WebSocket];
  this.ctx.acceptWebSocket(server);
  const attachment:Attachment={authenticated:false,expiresAt:Date.now()+3000,lastHeartbeat:Date.now(),mediaReady:false,lastSequence:-1,pending:[]};server.serializeAttachment(attachment);
  setTimeout(()=>{const a=server.deserializeAttachment() as Attachment|null;if(!a?.authenticated){try{server.close(1008,'Authentication timed out');}catch{}}},3000);
  return new Response(null,{status:101,webSocket:client});
 }
 async fetchPhone(request:Request):Promise<Response>{
  if(request.method!=='GET'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});
  if(!this.state||this.state.deleted||this.state.queueState==='CLOSED'||!this.phone||this.phone.terminated||this.phone.terminationPending||this.phone.consumed||this.phone.streamTokenExpiresAt<Date.now())return new Response('Phone call unavailable',{status:404});
  if(this.ctx.getWebSockets().length>=12)return new Response('Connection limit',{status:429});
  const pair=new WebSocketPair();const [client,server]=Object.values(pair) as [WebSocket,WebSocket];this.ctx.acceptWebSocket(server);
  const attachment:Attachment={transport:'phone',authenticated:false,expiresAt:Date.now()+3000,lastHeartbeat:Date.now(),mediaReady:false,lastSequence:-1,pending:[]};server.serializeAttachment(attachment);
  setTimeout(()=>{const a=server.deserializeAttachment() as Attachment|null;if(!a?.authenticated){try{server.close(1008,'Phone start timed out');}catch{}}},3000);
  return new Response(null,{status:101,webSocket:client});
 }
 private async receivePhoneMessage(socket:WebSocket,a:Attachment,message:string|ArrayBuffer){
  try{
   if(typeof message!=='string'||message.length>16000)throw new Error('Invalid phone message');
   if(!this.state||this.state.deleted||this.state.queueState==='CLOSED'||!this.phone||this.phone.terminated||this.phone.terminationPending||a.expiresAt<Date.now())throw new Error('Inactive phone call');
   const input=JSON.parse(message) as {event?:string;sequenceNumber?:string;streamSid?:string;protocol?:string;version?:string;start?:{accountSid?:string;callSid?:string;streamSid?:string;customParameters?:{token?:string};mediaFormat?:{encoding?:string;sampleRate?:number;channels?:number}};media?:{track?:string;timestamp?:string;payload?:string};mark?:{name?:string};dtmf?:{track?:string;digit?:string};stop?:{accountSid?:string;callSid?:string}};
   if(!a.authenticated){
    if(input.event==='connected'&&input.protocol==='Call'&&input.version==='1.0.0')return;
    const start=input.start;const nonce=start?.customParameters?.token;
    if(input.event!=='start'||!start||typeof nonce!=='string'||nonce.length<32||nonce.length>256||start.accountSid!==this.phone.accountSid||start.callSid!==this.phone.providerCallSid||!/^MZ[0-9a-f]{32}$/i.test(start.streamSid??'')||input.streamSid&&input.streamSid!==start.streamSid||start.mediaFormat?.encoding!=='audio/x-mulaw'||start.mediaFormat.sampleRate!==8000||start.mediaFormat.channels!==1)throw new Error('Invalid phone start');
    const sequence=Number(input.sequenceNumber);if(!Number.isSafeInteger(sequence)||sequence<1)throw new Error('Invalid sequence');
    let authenticated=false;
    await this.ctx.blockConcurrencyWhile(async()=>{
     const digest=await hash(nonce);
     if(!this.phone||this.phone.consumed||this.phone.terminated||this.phone.terminationPending||this.phone.streamTokenExpiresAt<Date.now()||digest!==this.phone.streamTokenHash||!this.state||this.state.deleted||this.state.queueState==='CLOSED')return;
     this.phone.consumed=true;this.phone.streamSid=start.streamSid!;this.savePhone();
     a={...a,authenticated:true,role:'caller',participantId:this.state.callerParticipantId,expiresAt:this.state.callDeadlineAt,lastHeartbeat:Date.now(),phone:{streamSid:start.streamSid!,lastEventSequence:sequence,nextAudioSequence:0,lastTimestamp:-1,captureReady:false,playbackReady:false}};socket.serializeAttachment(a);
     const transport=new PhoneTransport(start.streamSid!,socket);this.phoneTransports.set(socket,transport);
     this.mutate(s=>{s.participants.caller=true;},'phone-connected','Authenticated phone stream connected; checking caller media.');
     transport.flush(this.state.controlEpoch,this.state.responseGeneration);this.publish();authenticated=true;
    });
    if(!authenticated)throw new Error('Invalid stream token');return;
   }
   if(!a.phone||input.streamSid!==a.phone.streamSid)throw new Error('Wrong phone stream');
   const sequence=Number(input.sequenceNumber);if(!Number.isSafeInteger(sequence)||sequence<=a.phone.lastEventSequence)throw new Error('Replayed phone event');
   a.phone.lastEventSequence=sequence;a.lastHeartbeat=Date.now();socket.serializeAttachment(a);
   const transport=this.phoneTransports.get(socket);if(!transport)throw new Error('Phone transport lost');
   if(input.event==='media'){
    const timestamp=Number(input.media?.timestamp);
    if(input.media?.track!=='inbound'||typeof input.media.payload!=='string'||!Number.isSafeInteger(timestamp)||timestamp<0||timestamp<=a.phone.lastTimestamp)throw new Error('Invalid phone audio');
    a.phone.lastTimestamp=timestamp;const frames=transport.decode(input.media.payload);
    if(frames.length)a.phone.captureReady=true;socket.serializeAttachment(a);await this.phoneMediaReady(socket,a);a=socket.deserializeAttachment() as Attachment;
    for(const payload of frames){
     if((this.state as CallState|undefined)?.queueState==='CLOSED'||this.state?.deleted)break;
     const frame:AudioFrame={streamKind:AudioStreamKind.Patient,sequence:++a.phone!.nextAudioSequence,sampleRate:24000,controlEpoch:this.state!.controlEpoch,generation:this.state!.responseGeneration,responseId:0,payload};
     await this.receiveAudio(socket,a,encodeAudioFrame(frame));
    }
    return;
   }
   if(input.event==='mark'){
    if(typeof input.mark?.name!=='string'||input.mark.name.length>200)throw new Error('Invalid phone mark');
    const receipt=transport.acknowledge(input.mark.name);
    if(!receipt||receipt.epoch!==this.state.controlEpoch||receipt.generation!==this.state.responseGeneration)return;
    if(receipt.type==='flush'){
     a.phone.playbackReady=true;socket.serializeAttachment(a);await this.phoneMediaReady(socket,a);
     this.playbackFlushed(a,{controlEpoch:receipt.epoch,generation:receipt.generation});
    }else if(receipt.type==='audio')await this.audioAcknowledged(socket,a,{sequence:receipt.sequence,streamKind:receipt.streamKind,dropped:false});
    return;
   }
   if(input.event==='dtmf'){
    if(input.dtmf?.track!=='inbound_track'||typeof input.dtmf.digit!=='string'||!/^[0-9*#]$/.test(input.dtmf.digit))throw new Error('Invalid phone digit');
    if(input.dtmf.digit==='0')await this.command({workspaceId:this.state.workspaceId,participantId:this.state.callerParticipantId,role:'caller',commandId:`phone-dtmf-${a.phone.streamSid}-${sequence}`,type:'request-human'});
    return;
   }
   if(input.event==='stop'){
    if(input.stop?.accountSid!==this.phone.accountSid||input.stop.callSid!==this.phone.providerCallSid)throw new Error('Invalid phone stop');
    // This authenticated event confirms the carrier is already done. Never
    // call its REST API merely to terminate an already ended stream.
    await this.phoneStatus({workspaceId:this.phone.workspaceId,providerCallSid:this.phone.providerCallSid,status:'completed'});return;
   }
   throw new Error('Unsupported phone event');
  }catch{
   if(a.authenticated)this.phoneTransportFailure(socket);else try{socket.close(1008,'Invalid phone start');}catch{}
  }
 }
 private async phoneMediaReady(socket:WebSocket,a:Attachment){
  if(a.mediaReady||!a.phone?.captureReady||!a.phone.playbackReady||!this.state||this.state.deleted||this.state.queueState==='CLOSED')return;
  a.mediaReady=true;socket.serializeAttachment(a);this.mutate(s=>{s.mediaReady.caller=true;},'media-ready','Phone input and carrier playback readiness confirmed.');
  await this.beginHandoff();this.ctx.waitUntil(this.startIntake());this.publish();
 }
 async webSocketMessage(socket:WebSocket,message:string|ArrayBuffer){
  let a=socket.deserializeAttachment() as Attachment|null;if(!a)return socket.close(1008,'Authentication required');
  if(a.transport==='phone'){await this.receivePhoneMessage(socket,a,message);return;}
  if(a.expiresAt<Date.now())return socket.close(1008,'Session expired; obtain a new ticket');
  if(!a.authenticated){
   if(typeof message!=='string'||message.length>4096)return socket.close(1008,'Authentication required');
   try{
    const input=JSON.parse(message) as {type?:string;ticket?:string};if(input.type!=='auth'||typeof input.ticket!=='string'||input.ticket.length!==64)throw new Error('Invalid authentication');
    const ticketHash=await hash(input.ticket);let ticket:Ticket|undefined;
    this.ctx.storage.transactionSync(()=>{
     const row=this.store.storage.sql.exec<{body:string;consumed:number;expires_at:number}>('SELECT body,consumed,expires_at FROM tickets WHERE hash=?',ticketHash).toArray()[0];
     if(!row||row.consumed||row.expires_at<Date.now())throw new Error('Ticket invalid');
     ticket=JSON.parse(row.body) as Ticket;
     if(ticket.callId!==this.state?.id||ticket.workspaceId!==this.state.workspaceId||ticket.audience!=='nursebridge-realtime'||this.state.deleted)throw new Error('Scope invalid');
     this.store.storage.sql.exec('UPDATE tickets SET consumed=1 WHERE hash=?',ticketHash);
    });
    a={authenticated:true,role:ticket!.role,participantId:ticket!.participantId,expiresAt:Date.now()+600000,lastHeartbeat:Date.now(),mediaReady:false,lastSequence:-1,pending:[]};socket.serializeAttachment(a);
    if(a.role==='caller')this.mutate(s=>{s.participants.caller=true;},'caller-connected','Caller connection established.');
    if((a.role==='nurse'||a.role==='admin')&&this.state?.claim?.participantId===a.participantId)this.mutate(s=>{s.participants.nurse=true;},'nurse-connected','Claimed nurse connection established.');
    this.send(socket,{type:'authenticated',role:a.role,snapshot:this.visibleSnapshot(),credits:20});this.publish();return;
   }catch{return socket.close(1008,'Invalid or expired one-time ticket');}
  }
  a.lastHeartbeat=Date.now();socket.serializeAttachment(a);
  if(typeof message!=='string'){await this.receiveAudio(socket,a,message);return;}
  if(message.length>16000)return socket.close(1009,'Control message too large');
  try{
   const input=JSON.parse(message) as Record<string,unknown>;
   if(input.type==='heartbeat'){if(this.state?.claim&&this.state.claim.participantId===a.participantId&&a.role!=='caller'){this.state.claim.expiresAt=Date.now()+30000;this.checkpoint();}this.send(socket,{type:'heartbeat',now:Date.now()});return;}
   if(input.type==='media-ready'){
    a.mediaReady=input.microphone===true&&input.playback===true;socket.serializeAttachment(a);
    if(a.role==='caller')this.mutate(s=>{s.mediaReady.caller=a!.mediaReady;},'media-ready','Caller microphone and playback readiness updated.');
    else if((a.role==='nurse'||a.role==='admin')&&this.state?.claim?.participantId===a.participantId)this.mutate(s=>{s.mediaReady.nurse=a!.mediaReady;s.participants.nurse=true;},'media-ready','Nurse microphone and playback readiness updated.');
    await this.beginHandoff();if(a.role==='caller')this.ctx.waitUntil(this.startIntake());this.publish();return;
   }
   if(input.type==='playback-flushed'){this.playbackFlushed(a,input);return;}
   if(input.type==='audio-ack'){await this.audioAcknowledged(socket,a,input);return;}
   if(input.type==='barge-in'&&a.role==='caller'&&this.state?.conversationOwner==='AI'){this.abortAi('barge-in');this.publish();return;}
   if(input.type==='audio-gap'){this.gap('Audio interrupted by bounded transport backpressure.');return;}
   if(input.type==='mock-turn'&&a.role==='caller'&&this.state?.mode==='mock'&&typeof input.text==='string'&&input.text.length<=6000){await this.acceptTurn({id:`fixture:${crypto.randomUUID()}`,sessionId:'fixture',order:this.state.turns.length,text:input.text,final:true,at:Date.now()});return;}
  }catch{this.send(socket,{type:'error',code:'invalid_message',message:'Invalid control message.',recoverable:true});}
 }
 private playbackFlushed(a:Attachment,input:{controlEpoch?:unknown;generation?:unknown}){
  // Only the handoff's new epoch proves that prior caller output was cleared.
  if(a.role==='caller'&&this.state?.handoff&&this.state.flushIssuedFor===this.state.handoff.id&&input.controlEpoch===this.state.controlEpoch&&input.generation===this.state.responseGeneration){this.mutate(s=>{s.handoff!.callerFlushed=true;},'handoff-flushed','Caller confirmed that queued agent audio was cleared.');this.publish();}
 }
 private async audioAcknowledged(socket:WebSocket,a:Attachment,input:{sequence?:unknown;streamKind?:unknown;dropped?:unknown}){
  const index=a.pending.findIndex(p=>p.sequence===input.sequence&&p.streamKind===input.streamKind);if(index<0)return;
  const frame=a.pending.splice(index,1)[0]!;socket.serializeAttachment(a);
  const speech=this.currentSpeech;
  if(input.dropped!==true&&frame.streamKind===AudioStreamKind.Agent&&speech&&speech.responseId===frame.responseId&&!speech.playbackMeasured&&this.current(speech.epoch,speech.generation)){
   speech.playbackMeasured=true;const playbackMs=Date.now()-speech.startedAt;this.mutate(s=>{s.timings={...s.timings,firstAudioPlaybackMs:playbackMs};},'speech-playback',a.transport==='phone'?'Carrier playback mark acknowledged first agent audio.':'Caller worklet acknowledged first agent audio playback.');this.publish();
  }
  if(input.dropped!==true&&this.state?.conversationOwner==='HANDOFF_PENDING'&&this.state.handoff?.callerFlushed){
   if(a.role==='caller'&&frame.streamKind===AudioStreamKind.Nurse)this.mutate(s=>{s.handoff!.callerHeard=true;},'media-proof',a.transport==='phone'?'Carrier playback mark acknowledged nurse audio.':'Caller playback acknowledged nurse audio.');
   else if(a.participantId===this.state.claim?.participantId&&frame.streamKind===AudioStreamKind.Patient)this.mutate(s=>{s.handoff!.nurseHeard=true;},'media-proof','Nurse playback acknowledged caller audio.');
   await this.finishHandoff();
  }
 }
 private sendAudio(socket:WebSocket,a:Attachment,frame:AudioFrame){
  if(a.transport==='phone'){
   const transport=this.phoneTransports.get(socket);if(!transport){this.phoneTransportFailure(socket);return;}
   try{transport.sendAudio(frame);}catch{this.phoneTransportFailure(socket);return;}
  }else socket.send(encodeAudioFrame(frame));
  a.pending.push({sequence:frame.sequence,streamKind:frame.streamKind,responseId:frame.responseId});socket.serializeAttachment(a);
 }
 private async receiveAudio(socket:WebSocket,a:Attachment,bytes:ArrayBuffer){
  const state=this.state;if(!state||state.deleted||state.queueState==='CLOSED'||Date.now()>=state.callDeadlineAt)return;
  let frame:AudioFrame;try{frame=decodeAudioFrame(bytes);}catch{return socket.close(1009,'Invalid audio frame');}
  if(frame.payload.length!==2400||frame.sampleRate!==24000)return socket.close(1008,'Expected 50 ms mono PCM16 at 24 kHz');
  this.send(socket,{type:'audio-ack',sequence:frame.sequence,streamKind:frame.streamKind,credits:1});
  if(frame.sequence<=a.lastSequence||frame.controlEpoch!==state.controlEpoch)return;
  const now=Date.now();if(!a.audioWindowStart||now-a.audioWindowStart>=1000){a.audioWindowStart=now;a.audioFrames=0;}a.audioFrames=(a.audioFrames??0)+1;
  if(a.audioFrames>30){this.gap('Audio sender exceeded the realtime delivery limit.');socket.close(1008,'Audio rate exceeded');return;}
  a.lastSequence=frame.sequence;socket.serializeAttachment(a);
  if(a.role==='caller'&&a.participantId===state.callerParticipantId){
   frame.streamKind=AudioStreamKind.Patient;
   if(state.conversationOwner==='NURSE'||state.conversationOwner==='HANDOFF_PENDING'&&state.handoff?.callerFlushed){this.relay(frame,'nurse');return;}
   if(state.conversationOwner==='AI'&&state.consent&&state.mode==='live'&&this.voice){
    if(!this.voice.send(frame.payload))this.gap('Voice intake is not ready; part of the audio may be missing.');
   }
  }else if(a.participantId===state.claim?.participantId&&(a.role==='nurse'||a.role==='admin')){
   frame.streamKind=AudioStreamKind.Nurse;
   if(state.conversationOwner==='NURSE'||state.conversationOwner==='HANDOFF_PENDING'&&state.handoff?.callerFlushed)this.relay(frame,'caller');
  }
 }
 private relay(frame:AudioFrame,target:'caller'|'nurse'){
  for(const socket of this.ctx.getWebSockets()){
   const a=socket.deserializeAttachment() as Attachment|null;
   if(!a?.authenticated||!a.mediaReady||a.expiresAt<Date.now())continue;
   if(target==='caller'?a.role!=='caller':a.participantId!==this.state?.claim?.participantId||!(a.role==='nurse'||a.role==='admin'))continue;
   if(a.pending.length>=20){this.gap('Human audio interrupted by network congestion.');continue;}
   try{this.sendAudio(socket,a,{...frame,controlEpoch:this.state!.controlEpoch,generation:this.state!.responseGeneration});}catch{if(a.transport==='phone')this.phoneTransportFailure(socket);}
  }
 }
 private gap(message:string){if(!this.state||this.state.warnings.at(-1)===message)return;this.mutate(s=>{s.warnings.push(message);s.warnings=s.warnings.slice(-20);},'audio-gap',message);this.publish();}
 private async beginHandoff(){
  const s=this.state;if(!s?.handoff||s.conversationOwner!=='HANDOFF_PENDING'||!s.mediaReady.caller||!s.mediaReady.nurse||!s.participants.caller||!s.participants.nurse)return;
  if(s.handoff.callerFlushed||s.flushIssuedFor===s.handoff.id)return;
  this.mutate(next=>{next.flushIssuedFor=next.handoff!.id;next.controlEpoch++;next.responseGeneration++;next.aiStatus='stopped';next.intakeState=next.intakeState==='CAPTURED'?'CAPTURED':'INTERRUPTED';next.handoff!.callerFlushed=false;},'handoff-flush','Revoked AI output; awaiting caller playback flush.');
  this.abortAi('takeover',false);this.stopProvider();this.publish();
 }
 private async finishHandoff(){
  const s=this.state;if(!s?.handoff||!s.handoff.callerFlushed||!s.handoff.callerHeard||!s.handoff.nurseHeard)return;
  this.mutate(next=>{next.queueState='CONNECTED';next.conversationOwner='NURSE';next.aiStatus='stopped';next.controlRevision++;next.claim!.expiresAt=Date.now()+600000;next.timings={...next.timings,handoffMs:Date.now()-(next.handoffStartedAt??Date.now())};delete next.handoff;},'connected','Two-way human audio playback confirmed. AI provider audio forwarding is disabled.');this.stopProvider();this.publish();
 }
 async webSocketClose(socket:WebSocket,code=1000,reason=''){
  this.disconnected(socket);
  // Hibernatable sockets require our half of a peer-initiated close handshake.
  // Reserved synthetic close codes cannot be sent back over the wire.
  try{socket.close([1005,1006,1015].includes(code)?1000:code,reason);}catch{/* Already closed. */}
 }
 async webSocketError(socket:WebSocket){this.disconnected(socket);try{socket.close(1011,'Connection failed');}catch{}}
 private disconnected(socket:WebSocket){
  const a=socket.deserializeAttachment() as Attachment|null;if(!a?.authenticated||!this.state)return;
  if(a.transport==='phone'){this.phoneTransportFailure(socket);return;}
  if(this.state.deleted)return;
  if(this.ctx.getWebSockets().some(other=>{if(other===socket)return false;const peer=other.deserializeAttachment() as Attachment|null;return peer?.authenticated&&peer.participantId===a.participantId&&peer.role===a.role&&other.readyState===WebSocket.OPEN;}))return;
  if(a.role==='caller'){this.mutate(s=>{s.participants.caller=false;s.mediaReady.caller=false;},'caller-disconnected','Caller disconnected; queue arrival time preserved.');if(this.state.conversationOwner==='AI')this.waitForNurse('technical_failure','Caller disconnected during intake. Reconnect for nurse help.');else{this.abortAi('caller-disconnected');this.stopProvider();}}
  else if(a.participantId===this.state.claim?.participantId){this.mutate(s=>{s.participants.nurse=false;s.mediaReady.nurse=false;s.conversationOwner='NONE';s.queueState=s.queueState==='CLOSED'?'CLOSED':'CLAIMED';s.humanRequested=true;s.aiStatus='stopped';s.controlEpoch++;s.responseGeneration++;if(s.claim)s.claim.expiresAt=Date.now()+30000;delete s.handoff;},'nurse-disconnected','Nurse disconnected. Retry human access; AI will not restart automatically.');this.abortAi('nurse-disconnected',false);this.stopProvider();}
  this.publish();
 }
 private async startIntake(){
  const state=this.state;if(!state||state.deleted||state.queueState==='CLOSED'||!state.consent||state.conversationOwner!=='AI'||!state.mediaReady.caller)return;
  if(Date.now()>=state.callDeadlineAt)return;
  if(this.phone&&state.mode!=='live'){this.waitForNurse('technical_failure','Automated phone intake requires live speech. Waiting for a nurse.');return;}
  if(state.mode==='live'){
   if(liveActivationIssues(this.phone?{...this.env,FICTIONAL_LIVE_TEST:undefined}:this.env).length||!state.recordingConsent){this.providerFailure('live_activation_blocked');return;}
   if(this.voice||this.connecting)return;
   this.connecting=true;const connectionId=++this.providerConnection;const attemptId=crypto.randomUUID();
   this.store.storage.sql.exec('INSERT INTO provider_connections(attempt_id,agent_id,started_at,status) VALUES(?,?,?,?)',attemptId,this.env.VOICE_AGENT_ID!,Date.now(),'connecting');
   const valid=()=>this.providerConnection===connectionId&&this.state?.conversationOwner==='AI'&&!this.state?.deleted&&Date.now()<this.state!.callDeadlineAt;
   this.mutate(s=>{s.providerSession={status:'connecting',agentId:this.env.VOICE_AGENT_ID,agentVersion:this.env.VOICE_AGENT_VERSION};},'provider-connecting','Connecting the configured Voice Agent.');
   try{
    const connection=await connectVoiceAgent({apiKey:this.env.ASSEMBLYAI_API_KEY!,agentId:this.env.VOICE_AGENT_ID!,systemPrompt:intakePrompt(state),tools:INTAKE_TOOLS},{
     sessionCreated:({sessionId})=>{if(!this.state)return;this.ctx.storage.transactionSync(()=>{this.store.storage.sql.exec('INSERT OR IGNORE INTO provider_cleanup(session_id,expires_at) VALUES(?,?)',sessionId,this.state!.expiresAt);this.store.storage.sql.exec('DELETE FROM provider_connections WHERE attempt_id=?',attemptId);});if(this.state.deleted)this.ctx.waitUntil(this.cleanupProviderSessions().then(()=>this.scheduleAlarm()));},
     unidentifiedSession:()=>{this.store.storage.sql.exec("UPDATE provider_connections SET status='manual_reconciliation_required' WHERE attempt_id=?",attemptId);if(this.state&&!this.state.deleted)this.gap('Provider session identity could not be confirmed. Recording cleanup requires operator reconciliation.');},
     ready:({sessionId})=>{if(!valid())return;this.mutate(s=>{s.provider.connected=true;s.provider.sessionId=sessionId;s.provider.medicalMode='unavailable';s.provider.warning=null;s.providerSession={...s.providerSession,status:'active',id:sessionId,startedAt:Date.now()};s.intakeState='IN_PROGRESS';s.aiStatus='listening';},'provider-ready','Voice Agent ready; no Medical Mode claim.');this.publish();this.startVoiceOpening();},
     speechStarted:()=>{if(!valid())return;this.abortAi('speech-started');this.mutate(s=>{s.aiStatus='listening';},'caller-speaking','Caller interrupted agent output.');this.publish();},
     userTranscript:turn=>{if(!valid())return;const normalized:TranscriptTurn={id:turn.id,sessionId:turn.sessionId,providerItemId:turn.itemId,order:this.state!.turns.length,text:turn.text,final:turn.final,at:turn.at,timingAvailability:'unavailable'};this.broadcast({type:'caption',turn:normalized});if(turn.final)this.ctx.waitUntil(this.acceptTurn(normalized));},
     agentTranscript:turn=>{if(!valid())return;const id=`${turn.sessionId}:${turn.replyId}`;if(this.state!.assistantTurns.some(t=>t.id===id))return;this.mutate(s=>{s.assistantTurns.push({id,sessionId:turn.sessionId,replyId:turn.replyId,text:turn.text,interrupted:turn.interrupted,at:turn.at,final:true});s.assistantTurns=s.assistantTurns.slice(-120);},'agent-transcript','Assistant transcript captured separately from caller evidence.');this.broadcast({type:'agent-text',text:turn.text});this.publish();},
     replyStarted:({replyId})=>{if(!valid())return;const info={epoch:this.state!.controlEpoch,generation:this.state!.responseGeneration,responseId:++this.generationJob,startedAt:Date.now(),playbackMeasured:false,audioReadyMeasured:false};this.voiceReplies.set(replyId,info);this.currentSpeech=info;this.mutate(s=>{s.aiStatus='thinking';},'agent-reply','Voice Agent is preparing a reply.');this.publish();},
     audio:({pcm,replyId})=>{if(valid())this.enqueueVoiceAudio(pcm,replyId);},
     replyDone:({replyId,status})=>{if(valid())this.ctx.waitUntil(this.finishVoiceReply(replyId,status));},
     toolCall:call=>valid()?this.handleVoiceTool(call):{error:'inactive_session'},
     warning:code=>{if(valid())this.gap(`Voice Agent warning: ${code}`);},
     closed:code=>{if(valid())this.providerFailure(code);},
    });
    if(!valid()){connection.close();return;}this.voice=connection;this.connecting=false;this.startVoiceOpening();
   }catch{this.store.storage.sql.exec("UPDATE provider_connections SET status='manual_reconciliation_required' WHERE attempt_id=?",attemptId);if(valid()){this.connecting=false;this.providerFailure('voice_agent_connection_failed');}}
   return;
  }
  if(!state.askedQuestions.length){
   const field=state.template.questions[0]?.field;if(!field){this.finishCollection();return;}
   this.mutate(s=>{s.intakeState='IN_PROGRESS';markQuestion(s,field);s.aiStatus='listening';},'opening','Automated intake disclosure and opening question.');
   this.ctx.waitUntil(this.say(state.template.opening));this.publish();
  }
 }
 private startVoiceOpening(){
  if(!this.voice?.ready||!this.state||this.state.conversationOwner!=='AI'||this.openingSession===this.voice.sessionId)return;
  this.openingSession=this.voice.sessionId??undefined;
  if(!this.voice.requestReply('Introduce yourself as an automated intake assistant, then call get_intake_progress and register_question before asking the first question.'))this.providerFailure('opening_reply_failed');
 }
 private providerFailure(code:string){
  if(!this.state||this.state.deleted||this.state.conversationOwner!=='AI')return;
  this.waitForNurse('technical_failure',`Automated intake unavailable (${code}). A person can still join this call.`);
  this.mutate(s=>{s.provider.warning=code;s.providerSession.status='failed';s.aiStatus='unavailable';s.warnings.push('Voice intake interrupted: words may be missing. Nurse help requested.');},'provider-failure','Voice Agent unavailable; no automatic AI restart.');this.publish();
 }
 private waitForNurse(reason:'unresolved_answer'|'human_request'|'technical_failure'|'caller_reported_emergency',message:string){
  if(!this.state||this.state.deleted||this.state.queueState==='CLOSED'||this.state.conversationOwner!=='AI')return;
  this.mutate(s=>{s.waitingReason=reason;s.humanRequested=true;s.intakeState='INTERRUPTED';s.conversationOwner='NONE';s.aiStatus='stopped';s.controlEpoch++;s.responseGeneration++;s.controlRevision++;delete s.currentQuestion;s.escalations.push({id:crypto.randomUUID(),reason,message,at:Date.now()});if(reason==='caller_reported_emergency')s.warnings.push(EMERGENCY_COPY);},'waiting-for-nurse',message);
  this.abortAi('waiting-for-nurse',false);this.stopProvider();this.publish();
 }
 private finishCollection(){
  if(!this.state||this.state.conversationOwner!=='AI')return;
  this.mutate(s=>{s.waitingReason='intake_complete';s.intakeState='CAPTURED';s.conversationOwner='NONE';s.aiStatus='stopped';s.controlEpoch++;s.responseGeneration++;s.controlRevision++;delete s.currentQuestion;},'intake-captured','Intake complete — waiting for a nurse.');
  this.abortAi('intake-complete',false);this.stopProvider();this.broadcast({type:'agent-text',text:'Intake complete — waiting for a nurse.'});this.publish();
 }
 private enqueueVoiceAudio(pcm:Uint8Array,replyId:string){
  const reply=this.voiceReplies.get(replyId);if(!reply||!this.current(reply.epoch,reply.generation))return;
  // Provider chunks arrive independently of browser credits. Bound their total
  // duration, never build an unbounded promise chain holding PCM in closures.
  if(pcm.byteLength%2||this.voiceQueueBytes+pcm.byteLength>24000*2*2){this.providerFailure('provider_audio_overload');return;}
  this.voiceQueue.push({pcm,replyId});this.voiceQueueBytes+=pcm.byteLength;
  if(!this.voiceDrain)this.ctx.waitUntil(this.drainVoiceAudio());
 }
 private async finishVoiceReply(replyId:string,status:'completed'|'interrupted'){
  const reply=this.voiceReplies.get(replyId);if(!reply||!this.current(reply.epoch,reply.generation))return;
  if(status==='interrupted'){
   this.abortAi('provider-interrupted');this.mutate(s=>{s.aiStatus='listening';},'reply-interrupted','Provider interrupted agent output; queued playback flushed.');this.publish();return;
  }
  const started=Date.now();let phoneDrained=false;
  while(this.current(reply.epoch,reply.generation)){
   const generating=this.voiceDrain||this.voiceQueue.some(item=>item.replyId===replyId);
   if(!generating&&!phoneDrained){for(const [socket,transport] of this.phoneTransports){try{transport.finishAudio(reply.responseId);}catch{this.phoneTransportFailure(socket);}}phoneDrained=true;}
   const pending=generating||[...this.phoneTransports.values()].some(transport=>transport.hasPending(reply.responseId))||this.ctx.getWebSockets().some(socket=>{const a=socket.deserializeAttachment() as Attachment|null;return a?.authenticated&&a.role==='caller'&&a.pending.some(frame=>frame.streamKind===AudioStreamKind.Agent&&frame.responseId===reply.responseId);});
   if(!pending)break;
   if(Date.now()-started>5000){this.providerFailure('playback_ack_timeout');return;}await delay(10);
  }
  if(this.current(reply.epoch,reply.generation)&&this.currentSpeech?.responseId===reply.responseId){this.mutate(s=>{s.aiStatus='listening';},'reply-done','Caller playback completed the Voice Agent reply.');this.publish();}
  this.voiceReplies.delete(replyId);
 }
 private async drainVoiceAudio(){
  if(this.voiceDrain)return;this.voiceDrain=true;
  try{while(this.voiceQueue.length){const entry=this.voiceQueue.shift()!;this.voiceQueueBytes-=entry.pcm.length;const reply=this.voiceReplies.get(entry.replyId);if(!reply)continue;
   for(let offset=0;offset<entry.pcm.length;offset+=2400){
    if(!this.current(reply.epoch,reply.generation)||!this.voiceReplies.has(entry.replyId))break;
    const started=Date.now();let recipients:WebSocket[]=[];
    while(this.current(reply.epoch,reply.generation)){
     recipients=this.ctx.getWebSockets().filter(socket=>{const a=socket.deserializeAttachment() as Attachment|null;return a?.authenticated&&a.role==='caller'&&a.mediaReady&&a.expiresAt>Date.now();});
     if(!recipients.length)break;if(recipients.every(socket=>(socket.deserializeAttachment() as Attachment).pending.length<20))break;
     if(Date.now()-started>1500){this.providerFailure('playback_backpressure');return;}await delay(10);
    }
    if(!this.current(reply.epoch,reply.generation))break;
    const sequence=++this.speechSequence;const payload=entry.pcm.slice(offset,offset+2400);
    for(const socket of recipients){const a=socket.deserializeAttachment() as Attachment;this.sendAudio(socket,a,{streamKind:AudioStreamKind.Agent,sequence,sampleRate:24000,controlEpoch:reply.epoch,generation:reply.generation,responseId:reply.responseId,payload});}
    if(!reply.audioReadyMeasured){reply.audioReadyMeasured=true;this.mutate(s=>{s.aiStatus='speaking';s.timings={...s.timings,firstAudioReadyMs:Date.now()-reply.startedAt};},'voice-audio','Voice Agent audio ready.');this.publish();}
   }
  }}finally{this.voiceDrain=false;}
 }
 private async handleVoiceTool(call:VoiceToolCall,validatedMockBoundary=false):Promise<unknown>{
  if(!this.state||this.state.deleted||this.state.conversationOwner!=='AI'||Date.now()>=this.state.callDeadlineAt||this.state.providerSession.id!==call.sessionId)return{error:'inactive_session'};
  const id=`${call.sessionId}:${call.callId}`;const request=canonical({name:call.name,arguments:call.arguments});
  const prior=this.store.storage.sql.exec<{request:string;body:string}>('SELECT request,body FROM tool_receipts WHERE id=?',id).toArray()[0];
  if(prior)return prior.request===request?JSON.parse(prior.body):{error:'tool_id_reused'};
  const epoch=this.state.controlEpoch;const generation=this.state.responseGeneration;const waitStarted=Date.now();
  while(this.extractionBusy&&!(validatedMockBoundary&&this.state.mode==='mock')){if(Date.now()-waitStarted>11000)return{error:'extraction_pending'};await delay(10);}
  if(!this.state||this.state.deleted||this.state.conversationOwner!=='AI'||this.state.controlEpoch!==epoch||this.state.responseGeneration!==generation)return{error:'inactive_session'};
  const raced=this.store.storage.sql.exec<{request:string;body:string}>('SELECT request,body FROM tool_receipts WHERE id=?',id).toArray()[0];if(raced)return raced.request===request?JSON.parse(raced.body):{error:'tool_id_reused'};
  if(this.state.turns.at(-1)?.id!==this.state.providerSession.lastFinalizedTurnId&&this.state.turns.length)return{error:'unvalidated_turn'};
  let result:unknown;
  try{
   const next=structuredClone(this.state);const action=assessCollection(next);
   if(call.name==='get_intake_progress'){z.object({}).strict().parse(call.arguments);result={action,collection:next.collection,callerEvidence:next.turns.slice(-4).map(t=>({turnId:t.id,text:t.text.slice(0,2000)}))};}
   else if(call.name==='register_question'){
    const args=z.object({field:FieldSchema}).strict().parse(call.arguments);
    if(action.type!=='question'||action.field!==args.field)throw new Error('Question is not currently eligible');markQuestion(next,args.field);result={ok:true,field:args.field,text:action.text};
   }else if(call.name==='complete_intake'){
    z.object({}).strict().parse(call.arguments);if(action.type!=='complete')throw new Error('Intake incomplete');result={ok:true,waiting:true};
   }else if(call.name==='request_handoff'){
    const args=z.object({reason:z.enum(['human_request','caller_reported_emergency','unresolved_answer']),turnId:z.string(),quote:z.string().min(1)}).strict().parse(call.arguments);
    const source=next.turns.find(t=>t.id===args.turnId&&t.final);if(!source?.text.includes(args.quote))throw new Error('Unsupported handoff evidence');
    if(args.reason==='unresolved_answer'?action.type!=='handoff':explicitRequest(source.text)!==args.reason)throw new Error('Unsupported handoff reason');result={ok:true,waiting:true};
   }else throw new Error('Unsupported tool');
   this.ctx.storage.transactionSync(()=>{this.store.commit(next,'intake-tool',`Validated intake tool: ${call.name}.`);this.store.storage.sql.exec('INSERT OR IGNORE INTO tool_receipts(id,request,body) VALUES(?,?,?)',id,request,JSON.stringify(result));});this.state=next;
   if(call.name==='complete_intake')this.finishCollection();
   if(call.name==='request_handoff'){const args=call.arguments as {reason:'human_request'|'caller_reported_emergency'|'unresolved_answer'};this.waitForNurse(args.reason,'Voice intake requested nurse help with finalized caller evidence.');}
   this.publish();return result;
  }catch{return{error:'invalid_intake_action',message:'Read current intake progress; do not repeat an ineligible action.'};}
 }
 private async acceptTurn(turn:TranscriptTurn){
  if(!this.state||this.state.deleted||!this.state.consent||this.state.conversationOwner!=='AI'||Date.now()>=this.state.callDeadlineAt||!turn.final||!turn.text.trim()||this.state.turns.some(t=>t.id===turn.id))return;
  if(this.state.turns.length>=120){this.providerFailure('transcript_limit');return;}
  this.abortAi('final-turn');
  this.mutate(s=>{s.turns.push(turn);s.aiStatus='thinking';},'transcript-final','Final patient-reported transcript turn captured; word timing unavailable unless supplied.');this.publish();
  const requested=explicitRequest(turn.text);if(requested){this.waitForNurse(requested,requested==='caller_reported_emergency'?EMERGENCY_COPY:'Caller explicitly requested a person.');return;}

  if(this.extractionBusy){this.extractionAgain=true;return;}
  this.extractionBusy=true;
  try{do{this.extractionAgain=false;await this.updateDraft();}while(this.extractionAgain&&this.state?.conversationOwner==='AI');}finally{this.extractionBusy=false;}
 }
 private async updateDraft(){
  if(!this.state||this.state.conversationOwner!=='AI')return;
  const epoch=this.state.controlEpoch;const generation=this.state.responseGeneration;const startedAt=Date.now();
  const source=structuredClone(this.state);const extractionAbort=new AbortController();this.extractionAbort=extractionAbort;
  try{
   const output=source.mode==='mock'?mockExtraction(source.turns.at(-1)!,source.currentQuestion):await extract({apiKey:this.env.NEBIUS_API_KEY??'',model:this.env.EXTRACTION_MODEL,signal:extractionAbort.signal,validate:candidate=>validateExtraction(candidate,source.turns,source.template)},{allowedFields:source.template.questions.map(q=>q.field),allowedQuestions:source.template.questions.map(q=>({id:q.id,field:q.field})),turns:source.turns.slice(-20),currentFacts:source.facts});
   const checked=validateExtraction(output,source.turns,source.template);
   if(!this.current(epoch,generation))return;
   this.mutate(s=>{applyFacts(s,checked.facts,Date.now());s.providerSession.lastFinalizedTurnId=source.turns.at(-1)?.id;s.timings={...s.timings,extractionMs:Date.now()-startedAt};},'draft-revised','Evidence-linked intake draft updated; nurse review remains required.');
  }catch{
   if(!this.current(epoch,generation))return;
   this.providerFailure('extraction_validation_failed');return;
  }finally{if(this.extractionAbort===extractionAbort)this.extractionAbort=undefined;}
  if(!this.current(epoch,generation))return;
  this.mutate(s=>{assessCollection(s);},'collection-progress','Collection progress checked against validated evidence.');
  const action=assessCollection(structuredClone(this.state!));
  if(action.type==='handoff'){this.waitForNurse('unresolved_answer',`The ${action.field} answer remains unresolved after one clarification.`);return;}
  if(action.type==='complete'){this.finishCollection();return;}
  if(this.state!.mode==='mock'){
   const question=action;const result=await this.handleVoiceTool({sessionId:this.state!.providerSession.id!,replyId:'fixture-tool',callId:crypto.randomUUID(),name:'register_question',arguments:{field:question.field}},true) as {ok?:boolean};if(!this.current(epoch,generation))return;if(!result?.ok){this.providerFailure('fixture_tool_failed');return;}this.ctx.waitUntil(this.say(question.text));
  }
  this.publish();
 }
 private current(epoch:number,generation:number){return this.state?.controlEpoch===epoch&&this.state.responseGeneration===generation&&this.state.conversationOwner==='AI'&&!this.state.deleted&&this.state.queueState!=='CLOSED'&&Date.now()<this.state.callDeadlineAt;}
 private async say(text:string){
  if(!this.state||this.state.conversationOwner!=='AI')return;
  const epoch=this.state.controlEpoch;const generation=this.state.responseGeneration;const responseId=++this.generationJob;const startedAt=Date.now();
  this.currentSpeech={epoch,generation,responseId,startedAt,playbackMeasured:false};this.broadcast({type:'agent-text',text,controlEpoch:epoch,generation,responseId});
  this.mutate(s=>{s.aiStatus='thinking';s.assistantTurns.push({id:`fixture:${responseId}`,sessionId:'fixture',replyId:String(responseId),text,final:true,interrupted:false,at:Date.now()});},'speech-preparing','Preparing approved wording.');this.broadcast({type:'agent-status',status:'thinking'});
  try{
   let speech;
   if(this.state.mode==='mock'){
    // Deterministic audible fixture. This is visibly a cue tone, never claimed as speech.
    const samples=48000;const bytes=new Uint8Array(samples*2);const view=new DataView(bytes.buffer);
    for(let i=0;i<samples;i++)view.setInt16(i*2,Math.round(Math.sin(i*2*Math.PI*220/24000)*1800),true);
    speech={kind:'pcm' as const,bytes,sampleRate:24000};this.broadcast({type:'fixture-audio',message:'Replay audio: test cue tone; approved wording is shown as text.'});
   }else{return;}
   if(!this.current(epoch,generation)||responseId!==this.generationJob)return;
   this.mutate(s=>{s.aiStatus='speaking';s.timings={...s.timings,firstAudioReadyMs:Date.now()-startedAt};},'speech-started','Approved wording audio ready.');this.broadcast({type:'agent-status',status:'speaking'});
   {
    const length=Math.round(speech.sampleRate*.05)*2;this.broadcast({type:'audio-format',sampleRate:speech.sampleRate,codec:'pcm_s16le'});
    for(let offset=0;offset<speech.bytes.length;offset+=length){
     if(!this.current(epoch,generation)||responseId!==this.generationJob)return;
     const waitStarted=Date.now();let recipients:WebSocket[]=[];
     while(this.current(epoch,generation)&&responseId===this.generationJob){
      recipients=this.ctx.getWebSockets().filter(socket=>{const a=socket.deserializeAttachment() as Attachment|null;return a?.authenticated&&a.role==='caller'&&a.mediaReady&&a.expiresAt>Date.now();});
      if(!recipients.length)return;
      if(recipients.every(socket=>(socket.deserializeAttachment() as Attachment).pending.length<20))break;
      if(Date.now()-waitStarted>3000)throw new Error('Playback backpressure timeout');
      await delay(10);
     }
     if(!this.current(epoch,generation)||responseId!==this.generationJob)return;
     const sequence=++this.speechSequence;const payload=speech.bytes.slice(offset,Math.min(speech.bytes.length,offset+length));
     for(const socket of recipients){const a=socket.deserializeAttachment() as Attachment;this.sendAudio(socket,a,{streamKind:AudioStreamKind.Agent,sequence,sampleRate:speech.sampleRate,controlEpoch:epoch,generation,responseId,payload});}
    }
   }
   const drainStarted=Date.now();
   while(this.current(epoch,generation)&&responseId===this.generationJob&&this.ctx.getWebSockets().some(socket=>{const a=socket.deserializeAttachment() as Attachment|null;return a?.authenticated&&a.role==='caller'&&a.pending.some(p=>p.streamKind===AudioStreamKind.Agent);})){if(Date.now()-drainStarted>10000)throw new Error('Playback acknowledgment timed out');await delay(20);}
   if(this.current(epoch,generation)&&responseId===this.generationJob){this.mutate(s=>{s.aiStatus='listening';},'listening','Listening for caller information or correction.');this.broadcast({type:'agent-status',status:'listening'});this.publish();}
  }catch{
   if(this.current(epoch,generation)){this.providerFailure('fixture_playback_failed');this.abortAi('tts-failure');this.mutate(s=>{s.aiStatus='unavailable';s.warnings.push('Speech output unavailable. Read the approved text or request a person.');s.escalations.push({id:crypto.randomUUID(),reason:'technical_failure',message:'Speech output unavailable; staff review required. Approved text remains available.',at:Date.now()});},'tts-failure','Speech output failed; approved text and human access remain available.');this.broadcast({type:'agent-status',status:'unavailable'});this.publish();}
  }
 }
 private flushProjection():Promise<void>{
  // Concurrent admission retries need the same durable queue result. A busy
  // boolean made later callers return before the first projection committed.
  if(this.projectionTask)return this.projectionTask;
  this.projectionTask=this.flushProjectionBatch().finally(()=>{this.projectionTask=undefined;});
  return this.projectionTask;
 }
 private async flushProjectionBatch(){
  if(!this.state)return;
  try{
   for(const row of this.store.pending()){
    const projected=JSON.parse(row.body) as CallState;
    try{
     await projectSnapshot(this.env.DB,projected);
     if(projected.queueState==='CLOSED'||projected.conversationOwner==='NURSE'||projected.intakeState==='DECLINED'||Boolean(projected.waitingReason))await this.env.DB.prepare('UPDATE audio_reservations SET released=1 WHERE call_id=? AND workspace_id=?').bind(projected.id,projected.workspaceId).run();
     this.store.storage.sql.exec('DELETE FROM outbox WHERE id=?',row.id);
     if(this.state){this.state.projection={revision:Math.max(this.state.projection.revision,row.revision),updatedAt:Date.now()};this.checkpoint();}
     this.projectionRetryAt=0;
    }catch{
     this.store.storage.sql.exec('UPDATE outbox SET attempts=attempts+1 WHERE id=?',row.id);
     if(this.state){this.state.projection.error='Queue projection delayed; active call remains available.';this.checkpoint();}
     this.projectionRetryAt=Date.now()+Math.min(60000,1000*2**Math.min(row.attempts,6));break;
    }
   }
  }finally{await this.scheduleAlarm();}
 }
 private async cleanupProviderSessions(){
  if(!this.state)return;
  const due=this.store.storage.sql.exec<{session_id:string}>('SELECT session_id FROM provider_cleanup WHERE expires_at<=? OR ?=1',Date.now(),this.state.deleted?1:0).toArray();
  for(const row of due){
   try{
    if(!this.env.ASSEMBLYAI_API_KEY)throw new Error('cleanup_key_missing');
    await deleteVoiceAgentSession(this.env.ASSEMBLYAI_API_KEY,row.session_id);
    this.store.storage.sql.exec('DELETE FROM provider_cleanup WHERE session_id=?',row.session_id);
   }catch{this.store.storage.sql.exec("UPDATE provider_cleanup SET status='pending_deletion',attempts=attempts+1 WHERE session_id=?",row.session_id);}
  }
 }
 private async eraseContent(){
  if(!this.state)return;this.stopProvider();this.requestPhoneTermination();
  const keys=this.store.storage.sql.exec<{object_key:string}>('SELECT object_key FROM export_reservations').toArray();
  // Tombstone survives content deletion and fences every delayed D1 write.
  this.ctx.storage.transactionSync(()=>{
   this.store.clearContent();
   this.state!.turns=[];this.state!.assistantTurns=[];this.state!.facts=[];this.state!.factRevisions=[];this.state!.timeline=[];this.state!.escalations=[];this.state!.warnings=[];this.state!.deleted=true;this.state!.providerSession={status:'ended'};this.state!.provider.sessionId=null;
   this.store.commit(this.state!,'deleted','Case deleted.');
  });
  this.scrubDeletedPhone();
  for(const row of keys){try{await this.env.EXPORTS?.delete(row.object_key);this.store.storage.sql.exec('DELETE FROM export_reservations WHERE object_key=?',row.object_key);}catch{/* Alarm retries object deletion. */}}
  await this.cleanupProviderSessions();this.broadcast({type:'deleted'});for(const socket of this.ctx.getWebSockets())socket.close(1000,'Case deleted');await this.flushProjection();
 }
 private async scheduleAlarm(){
  if(!this.state)return;
  const now=Date.now();const active=this.state.queueState!=='CLOSED'||this.ctx.getWebSockets().length>0||this.connecting||Boolean(this.voice)||Boolean(this.state.handoff)||Boolean(this.store.pending().length);let at=this.state.deleted?now+60000:active?Math.min(this.state.expiresAt,now+10000):this.state.expiresAt;
  if(this.state.queueState!=='CLOSED')at=Math.min(at,this.state.callDeadlineAt);
  if(this.reconnectAt)at=Math.min(at,this.reconnectAt);
  if(this.projectionRetryAt)at=Math.min(at,this.projectionRetryAt);
  if(this.phone?.terminationPending||this.phone?.reservationReleasePending)at=Math.min(at,this.phone.terminationRetryAt??now+10000);
  if(this.state.deleted&&!this.phone?.terminationPending&&!this.phone?.reservationReleasePending&&!this.store.pending().length&&!this.store.storage.sql.exec('SELECT id FROM export_reservations LIMIT 1').toArray().length&&!this.store.storage.sql.exec('SELECT session_id FROM provider_cleanup LIMIT 1').toArray().length){await this.ctx.storage.deleteAlarm();return;}
  await this.ctx.storage.setAlarm(Math.max(now+1000,at));
 }
 async alarm(){
  const state=this.state;if(!state)return;const now=Date.now();
  await this.retryPhoneTermination();
  if(!state.deleted&&now>=state.expiresAt){this.mutate(s=>{s.deleted=true;s.queueState='CLOSED';s.conversationOwner='NONE';s.controlEpoch++;s.responseGeneration++;},'retention-expired','Case retention expired.');await this.eraseContent();return;}
  if(state.deleted){await this.cleanupProviderSessions();for(const row of this.store.storage.sql.exec<{object_key:string}>('SELECT object_key FROM export_reservations').toArray()){try{await this.env.EXPORTS?.delete(row.object_key);this.store.storage.sql.exec('DELETE FROM export_reservations WHERE object_key=?',row.object_key);}catch{}}await this.flushProjection();await this.scheduleAlarm();return;}
  if(this.state&&this.state.queueState!=='CLOSED'&&now>=this.state.callDeadlineAt){this.mutate(s=>{s.queueState='CLOSED';s.conversationOwner='NONE';s.aiStatus='stopped';s.controlEpoch++;s.responseGeneration++;delete s.handoff;s.warnings.push('Call duration limit reached. The call is closed operationally; this is not a clinical disposition.');},'duration-limit','Call duration limit reached.');this.abortAi('duration-limit',false);this.stopProvider();this.requestPhoneTermination();this.publish();for(const socket of this.ctx.getWebSockets())socket.close(1000,'Call duration limit reached');}
  for(const socket of this.ctx.getWebSockets()){const a=socket.deserializeAttachment() as Attachment|null;if(a&&(a.expiresAt<now||a.authenticated&&now-a.lastHeartbeat>30000)){this.disconnected(socket);socket.close(1008,'Heartbeat or session expired');}}
  if(this.state?.handoff&&this.state.handoff.deadline<now){this.mutate(s=>{delete s.handoff;s.conversationOwner='NONE';s.aiStatus='stopped';s.humanRequested=true;s.controlEpoch++;s.responseGeneration++;},'handoff-timeout','Human audio checks timed out. Caller session preserved; retry available.');this.abortAi('handoff-timeout',false);this.stopProvider();this.publish();}
  if(this.state?.claim&&this.state.claim.expiresAt<now&&this.state.queueState==='CLAIMED'){this.mutate(s=>{delete s.claim;s.queueState='WAITING';s.participants.nurse=false;s.mediaReady.nurse=false;},'claim-expired','Nurse claim expired; queue arrival time preserved.');this.publish();}
  if(this.state?.aiStartedAt&&now-this.state.aiStartedAt>Number(this.env.MAX_CALL_SECONDS??600)*1000&&this.state?.conversationOwner==='AI'){this.abortAi('duration-limit');this.stopProvider();this.mutate(s=>{s.conversationOwner='NONE';s.aiStatus='stopped';s.humanRequested=true;s.intakeState='INTERRUPTED';s.warnings.push('AI audio duration limit reached. Human access remains available.');},'duration-limit','Bounded AI intake duration reached.');this.publish();}
  if(this.reconnectAt&&now>=this.reconnectAt){this.reconnectAt=0;await this.startIntake();}
  this.store.storage.sql.exec('DELETE FROM tickets WHERE expires_at<?',now);
  if(!this.projectionRetryAt||now>=this.projectionRetryAt)await this.flushProjection();
  await this.scheduleAlarm();
 }
}
