import { automatedIntakeAllowed, type WorkspacePreferences } from '@nursebridge/contracts';
import { RECORDING_DISCLOSURE_VERSION, type CallSnapshot, type CallCommand, type IntakeTemplate, type ProposedFact, type IntakeFact, type EscalationReason } from '@nursebridge/contracts';
import { DEFAULT_TEMPLATE, validateExtraction, nextQuestion as selectQuestion, createCollection, assessCollection } from '@nursebridge/intake-policy';
export type Role = 'caller' | 'nurse' | 'observer' | 'admin';
export type CallState = CallSnapshot & {
  provider: { connected:boolean; sessionId:string|null; medicalMode:'pending'|'confirmed'|'unavailable'; warning:string|null; reconnects:number };
  mediaReady:{caller:boolean;nurse:boolean};
  handoffStartedAt?:number;
  lastAudioAt?:number;
  aiStartedAt?:number;
  flushIssuedFor?:string;
  legacyIntakeBlocked?:boolean;
};
export type Command = CallCommand;
export class CommandError extends Error { constructor(public status:number,public code:string,message:string){super(message);} }
export const fail=(status:number,code:string,message:string):never=>{throw new CommandError(status,code,message);};
export const defaultTemplate=DEFAULT_TEMPLATE;
export function newState(input:{callId:string;workspaceId:string;callerParticipantId:string;mode:'mock'|'live';channel?:'browser'|'phone';template?:IntakeTemplate;createdAt?:number;expiresAt?:number;callDeadlineAt?:number;workspacePreferences?:WorkspacePreferences}):CallState{
 const now=input.createdAt??Date.now();
 return {workspacePreferences:input.workspacePreferences,version:2,id:input.callId,channel:input.channel??'browser',workspaceId:input.workspaceId,callerParticipantId:input.callerParticipantId,mode:input.mode,createdAt:now,expiresAt:input.expiresAt??now+7*86400000,callDeadlineAt:input.callDeadlineAt??now+600000,revision:0,controlRevision:0,controlEpoch:1,responseGeneration:1,consent:false,queueState:'WAITING',intakeState:'NOT_STARTED',conversationOwner:'NONE',aiStatus:'idle',humanRequested:false,nurseReviewStatus:'pending',template:input.template??DEFAULT_TEMPLATE,askedQuestions:[],turns:[],assistantTurns:[],collection:createCollection(),providerSession:{status:'idle'},facts:[],factRevisions:[],timeline:[],escalations:[],participants:{caller:false,nurse:false},mediaReady:{caller:false,nurse:false},provider:{connected:false,sessionId:null,medicalMode:'unavailable',warning:null,reconnects:0},projection:{revision:0,updatedAt:now},warnings:[],timings:{}};
}
/** Upgrade durable control data without treating legacy transcription consent as
 * permission for provider recording or switching an active old audio pipeline. */
export function migrateState(raw: CallState): CallState {
 const legacy = raw.version !== 2;
 const defaults = newState({callId:raw.id,workspaceId:raw.workspaceId,callerParticipantId:raw.callerParticipantId,mode:raw.mode,template:raw.template,createdAt:raw.createdAt,expiresAt:raw.expiresAt});
 const state:CallState={...defaults,...raw,version:2,collection:{...defaults.collection,...raw.collection},assistantTurns:raw.assistantTurns??[],providerSession:raw.providerSession??{status:'idle'},callDeadlineAt:raw.callDeadlineAt??defaults.callDeadlineAt};
 if(legacy){
  delete state.recordingConsent;
  state.collection=createCollection();
  for(const question of state.template.questions){
   const attempts=state.askedQuestions.filter(id=>id===question.id).length;
   state.collection[question.field]={status:'unasked',clarificationCount:attempts>1?1:0,...(attempts?{askedAfterTurnCount:state.turns.filter(t=>t.final).length,awaitingAnswer:false}:{})};
  }
  assessCollection(state);
  if(state.mode==='live'&&state.queueState!=='CLOSED'){
   state.legacyIntakeBlocked=true;
   if(state.conversationOwner==='AI'){
    requestHandoff(state,'technical_failure','This older intake session cannot switch voice providers. Continue with a nurse.',Date.now());
    state.provider={...state.provider,connected:false,medicalMode:'unavailable'};
    state.providerSession={status:'interrupted'};
   }
  }
 }
 return state;
}
export function requestHandoff(state:CallState,reason:EscalationReason,message:string,now:number):void{
 state.humanRequested=true;
 state.waitingReason=reason;
 if(state.conversationOwner!=='NURSE'){
  state.intakeState=reason==='consent_refused'||state.intakeState==='DECLINED'?'DECLINED':'INTERRUPTED';
  state.conversationOwner='NONE';state.aiStatus='stopped';state.controlEpoch++;state.responseGeneration++;
 }
 state.escalations.push({id:crypto.randomUUID(),reason,message,at:now});
}
export function completeCollection(state:CallState):void{
 if(assessCollection(state).type!=='complete')fail(409,'intake_incomplete','Validated intake information is incomplete.');
 if(state.conversationOwner!=='AI')fail(409,'intake_inactive','Automated intake is no longer active.');
 state.intakeState='CAPTURED';state.waitingReason='intake_complete';state.conversationOwner='NONE';state.aiStatus='stopped';state.controlEpoch++;state.responseGeneration++;
}
export function evidenceValid(fact:ProposedFact,state:CallState):boolean{
 try {validateExtraction({facts:[fact],nextQuestionId:null},state.turns,state.template);return true;}catch{return false;}
}
export function applyFacts(state:CallState,facts:ProposedFact[],now:number,actor='AI'){
 for(const proposal of facts){
  if(!evidenceValid(proposal,state))continue;
  const previous=state.facts.find(f=>f.field===proposal.field);
  if(previous&&previous.value===proposal.value&&previous.status===proposal.status&&JSON.stringify(previous.evidence)===JSON.stringify(proposal.evidence))continue;
  const current:IntakeFact={...proposal,revision:(previous?.revision??0)+1,patientConfirmed:false,nurseReviewed:actor!=='AI',updatedAt:now};
  state.factRevisions.push({id:crypto.randomUUID(),field:proposal.field,revision:current.revision,previous,current,actor,at:now});
  state.facts=[...state.facts.filter(f=>f.field!==proposal.field),current];state.nurseReviewStatus='pending';
 }
}
export function nextQuestion(state:CallState,proposed?:string|null){
 const eligible=state.template.questions.filter(q=>!state.facts.some(f=>f.field===q.field&&f.status!=='not_asked')&&state.askedQuestions.filter(id=>id===q.id).length<2);
 return eligible.find(q=>q.id===proposed)??state.template.questions.find(q=>q.id===selectQuestion(state.template,state.facts,state.askedQuestions));
}
export function transition(state:CallState,command:Command,now:number){
 if(command.workspaceId!==state.workspaceId)fail(404,'not_found','Call not found.');
 if(state.deleted)fail(410,'deleted','Call has been deleted.');
 if(now>=state.callDeadlineAt&&!['delete','review','acknowledge-escalation'].includes(command.type))fail(409,'call_expired','The call time limit has been reached.');
 if(command.expectedRevision!==undefined&&command.expectedRevision!==state.controlRevision)fail(409,'revision_conflict','The call changed. Refresh and try again.');
 const staff=command.role==='nurse'||command.role==='admin';
 const caller=command.participantId===state.callerParticipantId;
 if(!staff&&!caller)fail(403,'forbidden','This participant cannot change the call.');
 if(state.queueState==='CLOSED'&&!['delete','review','acknowledge-escalation'].includes(command.type))fail(409,'closed','Call has ended.');
 switch(command.type){
  case 'consent':{
   if(!caller)fail(403,'forbidden','Only the caller can consent.');
   if(['NURSE','HANDOFF_PENDING'].includes(state.conversationOwner))fail(409,'human_owned','Human access is in progress.');
   const accepted=command.payload?.accepted===true;
   if(accepted&&state.workspacePreferences&&!automatedIntakeAllowed(state.workspacePreferences,state.mode))fail(409,'intake_disabled','Automated intake is disabled for this call. Request a nurse.');
   if(accepted&&state.legacyIntakeBlocked)fail(409,'legacy_session','This existing call must finish with a nurse before switching voice providers.');
   if(accepted&&state.waitingReason)fail(409,'intake_stopped','Automated intake has ended. Continue waiting for a nurse.');
   if(accepted&&state.mode==='live'){
    if(command.payload?.recordingAccepted!==true||command.payload?.recordingDisclosureVersion!==RECORDING_DISCLOSURE_VERSION)fail(400,'recording_consent_required','Accept the current provider recording disclosure before automated intake.');
    state.recordingConsent={disclosureVersion:RECORDING_DISCLOSURE_VERSION,acceptedAt:now};
   }
   state.consent=accepted;if(accepted&&!state.aiStartedAt)state.aiStartedAt=now;
   state.intakeState=accepted?'CONSENTED':'DECLINED';state.conversationOwner=accepted?'AI':'NONE';state.aiStatus=accepted?'listening':'stopped';
   if(!accepted)requestHandoff(state,'consent_refused','Automated intake consent was declined. The caller is waiting for a nurse.',now);
   else delete state.waitingReason;
   break;
  }
  case 'claim':{
   if(!staff)fail(403,'forbidden','A nurse must claim the call.');
   if(state.claim&&state.claim.participantId!==command.participantId&&(state.claim.expiresAt>now||state.queueState==='CONNECTED'))fail(409,'already_claimed','Another nurse has claimed this call.');
   state.claim={participantId:command.participantId,expiresAt:now+30000};state.queueState=state.queueState==='CONNECTED'?'CONNECTED':'CLAIMED';break;
  }
  case 'takeover':{
   if(!staff||state.claim?.participantId!==command.participantId||state.claim.expiresAt<=now)fail(409,'claim_required','Claim the call before joining.');
   state.conversationOwner='HANDOFF_PENDING';state.handoffStartedAt=now;state.handoff={id:crypto.randomUUID(),deadline:now+10000,callerFlushed:false,callerHeard:false,nurseHeard:false};break;
  }
  case 'request-human':requestHandoff(state,'human_request','A person has been requested. Staff acknowledgment is pending.',now);break;
  case 'review':if(!staff)fail(403,'forbidden','Nurse review required.');state.nurseReviewStatus='reviewed';state.facts.forEach(f=>{f.nurseReviewed=true;});break;
  case 'acknowledge-escalation':if(!staff)fail(403,'forbidden','Staff acknowledgment required.');{const target=state.escalations.find(e=>e.id===command.payload?.escalationId);if(!target)fail(404,'escalation_missing','Escalation not found.');target!.acknowledgedAt=now;target!.acknowledgedBy=command.participantId;}break;
  case 'end':state.queueState='CLOSED';state.conversationOwner='NONE';state.aiStatus='stopped';state.controlEpoch++;state.responseGeneration++;delete state.handoff;break;
  case 'delete':if(command.role!=='admin')fail(403,'forbidden','Staff deletion required.');state.queueState='CLOSED';state.conversationOwner='NONE';state.aiStatus='stopped';state.deleted=true;state.controlEpoch++;state.responseGeneration++;break;
  case 'intake':if(!staff)fail(403,'forbidden','Only a nurse can revise the draft.');break;
  case 'confirm':if(!caller)fail(403,'forbidden','Only the caller can confirm their words.');state.facts.forEach(f=>{f.patientConfirmed=true;});break;
  case 'mock-turn':if(state.mode!=='mock')fail(400,'not_mock','Replay input is disabled in live mode.');break;
  default:fail(400,'unknown_command','Unknown call command.');
 }
 state.controlRevision++;
}
