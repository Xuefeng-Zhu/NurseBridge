import { describe, expect, it } from 'vitest';
import { AssemblyEventParser, assemblyUrl, medicalConfigurationConfirmed, finalEventDelay } from '../src/providers/assemblyai';
import { parseSpeech } from '../src/providers/workers-ai';
import { applyFacts, newState, transition } from '../src/state';
import { mockExtraction } from '@nursebridge/intake-policy';

describe('provider contracts',()=>{
 it('requests documented Medical Mode names without credentials in URL',()=>{const url=assemblyUrl();expect(url.searchParams.get('domain')).toBe('medical-v1');expect(url.searchParams.get('min_turn_silence')).toBe('800');expect(url.searchParams.has('token')).toBe(false);});
 it('replaces partials and deduplicates finals by provider session plus order',()=>{
  const turns:unknown[]=[];const warnings:string[]=[];
  const parser=new AssemblyEventParser({begin:()=>{},speechStarted:()=>{},closed:()=>{},turn:t=>turns.push(t),warning:c=>warnings.push(c)});
  parser.consume({type:'Begin',id:'one',configuration:{domain:'medical-v1'}});
  parser.consume({type:'Turn',turn_order:0,transcript:'It',end_of_turn:false});
  parser.consume({type:'Turn',turn_order:0,transcript:'It began today',end_of_turn:true});
  parser.consume({type:'Turn',turn_order:0,transcript:'It began today.',end_of_turn:true,turn_is_formatted:true});
  parser.consume({type:'Begin',id:'two',configuration:{domain:null}});
  parser.consume({type:'Turn',turn_order:0,transcript:'Actually yesterday',end_of_turn:true});
  expect(turns).toHaveLength(3);expect(turns[2]).toMatchObject({id:'two:0',text:'Actually yesterday'});expect(warnings).toContain('medical_mode_not_confirmed');
 });
 it('does not interpret MP3 as PCM and rejects unidentified output',()=>{
  expect(parseSpeech(new Uint8Array([73,68,51,0,0,0]),'audio/mpeg',24000).kind).toBe('encoded');
  expect(()=>parseSpeech(new Uint8Array([1,2,3,4]),'audio/mpeg',24000)).toThrow();
  expect(()=>parseSpeech(new Uint8Array([1,2,3]),'audio/pcm',24000)).toThrow();
  expect(()=>parseSpeech(new Uint8Array([1,2,3,4]),'application/octet-stream',24000)).toThrow();
  expect(()=>parseSpeech(new Uint8Array([1,2,3,4]),'audio/pcm',24000)).toThrow();
  expect(parseSpeech(new Uint8Array([1,2,3,4]),'audio/pcm; rate=16000',24000)).toMatchObject({kind:'pcm',sampleRate:16000});
  expect(parseSpeech(new Uint8Array([255,241,0,0]),'audio/aac',24000)).toMatchObject({kind:'encoded',mimeType:'audio/aac'});
 });
 it('confirms the effective model, medical domain, and operating mode together',()=>{
  expect(medicalConfigurationConfirmed({domain:'medical-v1'})).toBe(false);
  expect(medicalConfigurationConfirmed({domain:'medical-v1',speech_model:'universal-3-5-pro',mode:'balanced'})).toBe(true);
  expect(medicalConfigurationConfirmed({domain:'medical-v1',speech_model:'universal-3-5-pro',mode:'fast'})).toBe(false);
 });
 it('measures final-event delay from word timestamps without claiming unavailable measurements',()=>{
  expect(finalEventDelay(4000,{startedAt:1000,samples:48000},[{text:'yesterday',start:500,end:1000}])).toBe(2000);
  expect(finalEventDelay(4000,undefined,[{text:'yesterday',start:500,end:1000}])).toBeUndefined();
  expect(finalEventDelay(4000,{startedAt:1000,samples:800},[{text:'yesterday',start:500,end:1000}])).toBeUndefined();
  expect(finalEventDelay(4000,{startedAt:1000,samples:48000},[])).toBeUndefined();
 });
 it('preserves corrections as revisions and not measured as a distinct status',()=>{
  const state=newState({callId:'call-12345',workspaceId:'w',callerParticipantId:'c',mode:'mock'});
  for(const [index,text] of ['It started today.','Actually it started yesterday.','I have not checked my temperature.'].entries()){
   const turn={id:`t${index}`,sessionId:'fixture',order:index,text,final:true,at:1};state.turns.push(turn);applyFacts(state,mockExtraction(turn).facts,1);
  }
  expect(state.facts.find(f=>f.field==='onset')?.value).toContain('yesterday');
  expect(state.facts.find(f=>f.field==='uncertainties')?.status).toBe('not_measured');
  expect(state.factRevisions.find(r=>r.previous?.value.includes('today'))).toBeDefined();
 });
 it('preserves queue arrival time when AI is declined',()=>{
  const state=newState({callId:'call-12345',workspaceId:'w',callerParticipantId:'c',mode:'mock',createdAt:20});
  transition(state,{workspaceId:'w',participantId:'c',role:'caller',commandId:'one',type:'consent',payload:{accepted:false}},100);
  expect(state.createdAt).toBe(20);expect(state.queueState).toBe('WAITING');expect(state.intakeState).toBe('DECLINED');expect(state.humanRequested).toBe(true);
 });
});
