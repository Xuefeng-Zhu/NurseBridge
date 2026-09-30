import { describe, expect, it } from 'vitest';
import { RECORDING_DISCLOSURE_VERSION, type CallCommand, type FieldId, type ProposedFact } from '../../packages/contracts/src';
import { assessCollection, markQuestion } from '../../packages/intake-policy/src';
import { applyFacts, completeCollection, migrateState, newState, requestHandoff, transition, type CallState } from '../../apps/realtime/src/state';

const state = (mode: 'mock' | 'live' = 'mock') => newState({ callId: 'call-a', workspaceId: 'workspace-a', callerParticipantId: 'caller-a', mode, createdAt: 100 });
const consent = (payload: Record<string, unknown>): CallCommand => ({ workspaceId: 'workspace-a', participantId: 'caller-a', role: 'caller', commandId: 'consent-a', type: 'consent', payload });
function answer(call: CallState, field: FieldId, text: string, status: ProposedFact['status'] = 'reported') {
    const id = `caller:${call.turns.length}`;
    call.turns.push({ id, sessionId: 'session-a', order: call.turns.length, text, final: true, at: 200 + call.turns.length });
    applyFacts(call, [{ field, value: text, rawWording: text, status, evidence: [{ turnId: id, quote: text }] }], 200 + call.turns.length);
}

describe('versioned collection control', () => {
    it('sets the call deadline independently of seven-day content expiry', () => {
        const call = state();
        expect(call.version).toBe(2);
        expect(call.callDeadlineAt).toBe(600100);
        expect(call.expiresAt).toBe(100 + 7 * 86400000);
        expect(call.assistantTurns).toEqual([]);
        expect(call.providerSession.status).toBe('idle');
    });

    it('accepts mock consent but requires current recording consent for live intake', () => {
        const fixture = state();
        transition(fixture, consent({ accepted: true }), 200);
        expect(fixture.conversationOwner).toBe('AI');
        expect(fixture.recordingConsent).toBeUndefined();
        const live = state('live');
        expect(() => transition(live, consent({ accepted: true }), 200)).toThrow('recording disclosure');
        expect(() => transition(live, consent({ accepted: true, recordingAccepted: true, recordingDisclosureVersion: 'voice-agent-recording-v1' }), 200)).toThrow('recording disclosure');
        expect(live.consent).toBe(false);
        transition(live, consent({ accepted: true, recordingAccepted: true, recordingDisclosureVersion: RECORDING_DISCLOSURE_VERSION }), 250);
        expect(live.recordingConsent).toEqual({ disclosureVersion: RECORDING_DISCLOSURE_VERSION, acceptedAt: 250 });
    });

    it('keeps arrival and human access when consent is refused', () => {
        const call = state('live');
        transition(call, consent({ accepted: false }), 200);
        expect(call).toMatchObject({ createdAt: 100, queueState: 'WAITING', intakeState: 'DECLINED', humanRequested: true, waitingReason: 'consent_refused' });
        expect(call.escalations).toEqual([expect.objectContaining({ reason: 'consent_refused' })]);
    });

    it('registers questions idempotently and cannot consume clarification through repeated progress reads', () => {
        const call = state();
        markQuestion(call, 'reason');
        markQuestion(call, 'reason');
        expect(call.askedQuestions).toEqual(['reason']);
        answer(call, 'reason', 'I do not know.', 'unknown');
        expect(assessCollection(call)).toMatchObject({ type: 'question', field: 'reason' });
        markQuestion(call, 'reason');
        for (let i = 0; i < 3; i++) {
            expect(assessCollection(call)).toMatchObject({ type: 'question', field: 'reason' });
            markQuestion(call, 'reason');
        }
        expect(call.collection.reason.clarificationCount).toBe(1);
        expect(call.askedQuestions).toEqual(['reason', 'reason']);
        answer(call, 'reason', 'I still do not know.', 'unknown');
        expect(assessCollection(call)).toEqual({ type: 'handoff', field: 'reason' });
        expect(call.collection.reason.status).toBe('unresolved');
        expect(() => markQuestion(call, 'reason')).toThrow('exhausted');
    });

    it('clarifies volunteered uncertainty before asking a different missing field', () => {
        const call = state();
        answer(call, 'medications', 'I am unsure which tablet.', 'uncertain');
        expect(assessCollection(call)).toMatchObject({ type: 'question', field: 'medications' });
        markQuestion(call, 'medications');
        expect(call.collection.medications.clarificationCount).toBe(1);
        answer(call, 'medications', 'The label says fictional medicine A.');
        expect(assessCollection(call)).toMatchObject({ type: 'question', field: 'reason' });
        expect(call.collection.medications.status).toBe('answered');
    });

    it('keeps explicit denial and unmeasured information as valid completed answers', () => {
        const call = state();
        for (const question of call.template.questions) {
            if (question.field === 'symptoms') answer(call, question.field, 'No other symptoms.', 'denied');
            else if (question.field === 'uncertainties') answer(call, question.field, 'I have not measured my temperature.', 'not_measured');
            else answer(call, question.field, `Fictional answer for ${question.field}.`);
        }
        expect(assessCollection(call)).toEqual({ type: 'complete' });
        transition(call, consent({ accepted: true }), 300);
        completeCollection(call);
        expect(call).toMatchObject({ intakeState: 'CAPTURED', queueState: 'WAITING', waitingReason: 'intake_complete', conversationOwner: 'NONE', aiStatus: 'stopped' });
        expect(call.escalations).toHaveLength(0);
    });

    it('does not permit completion from a tool while validated fields remain missing', () => {
        const call = state();
        transition(call, consent({ accepted: true }), 200);
        answer(call, 'reason', 'I am calling about a headache.');
        expect(() => completeCollection(call)).toThrow('incomplete');
        expect(call.intakeState).toBe('CONSENTED');
    });

    it('preserves a correction and clears uncertainty without repeating resolved fields', () => {
        const call = state();
        answer(call, 'onset', 'Maybe yesterday or this morning.', 'uncertain');
        markQuestion(call, 'onset');
        answer(call, 'onset', 'Actually it started yesterday afternoon.');
        expect(assessCollection(call)).toMatchObject({ type: 'question', field: 'reason' });
        expect(call.collection.onset.status).toBe('answered');
        expect(call.factRevisions.at(-1)).toMatchObject({ field: 'onset', revision: 2, previous: { status: 'uncertain' }, current: { status: 'reported', patientConfirmed: false } });
    });

    it('hands off unresolved contradictory answers after the single clarification', () => {
        const call = state();
        answer(call, 'onset', 'Maybe yesterday; maybe last week.', 'uncertain');
        markQuestion(call, 'onset');
        answer(call, 'onset', 'I am still unsure between those two dates.', 'uncertain');
        expect(assessCollection(call)).toEqual({ type: 'handoff', field: 'onset' });
        requestHandoff(call, 'unresolved_answer', 'The onset answer remains unresolved.', 400);
        expect(call).toMatchObject({ waitingReason: 'unresolved_answer', conversationOwner: 'NONE', humanRequested: true });
    });

    it('cannot use assistant words as caller evidence', () => {
        const call = state();
        call.assistantTurns.push({ id: 'assistant:1', sessionId: 'session-a', replyId: 'reply-a', text: 'I have a headache.', final: true, interrupted: false, at: 200 });
        applyFacts(call, [{ field: 'reason', value: 'a headache', rawWording: 'I have a headache.', status: 'reported', evidence: [{ turnId: 'assistant:1', quote: 'I have a headache.' }] }], 200);
        expect(call.facts).toHaveLength(0);
    });

    it('migrates old control records without authorizing recording or restarting live intake', () => {
        const raw = state('live');
        raw.consent = true;
        raw.conversationOwner = 'AI';
        const legacy = { ...raw, version: undefined, recordingConsent: { disclosureVersion: 'incorrect-legacy-value', acceptedAt: 100 } } as unknown as CallState;
        const upgraded = migrateState(legacy);
        expect(upgraded).toMatchObject({ version: 2, createdAt: 100, conversationOwner: 'NONE', intakeState: 'INTERRUPTED', humanRequested: true, legacyIntakeBlocked: true });
        expect(upgraded.recordingConsent).toBeUndefined();
        expect(() => transition(upgraded, consent({ accepted: true, recordingAccepted: true, recordingDisclosureVersion: RECORDING_DISCLOSURE_VERSION }), 300)).toThrow('existing call');
    });

    it('preserves a v2 active session and existing nurse ownership during migration', () => {
        const current = state('live');
        current.conversationOwner = 'NURSE';
        current.providerSession = { status: 'ended', id: 'provider-session' };
        const migrated = migrateState(current);
        expect(migrated.conversationOwner).toBe('NURSE');
        expect(migrated.providerSession.id).toBe('provider-session');
        expect(migrated.legacyIntakeBlocked).toBeUndefined();
    });

    it('preserves nurse ownership for new caller requests and forbids cross-workspace control', () => {
        const call = state();
        call.conversationOwner = 'NURSE';
        call.queueState = 'CONNECTED';
        const epoch = call.controlEpoch;
        requestHandoff(call, 'human_request', 'Another staff member requested.', 200);
        expect(call.conversationOwner).toBe('NURSE');
        expect(call.controlEpoch).toBe(epoch);
        expect(() => transition(call, { ...consent({ accepted: false }), workspaceId: 'workspace-b' }, 200)).toThrow('Call not found');
    });

    it('cannot restart automated intake after completion, refusal, or human fallback', () => {
        for (const waitingReason of ['intake_complete', 'consent_refused', 'technical_failure', 'unresolved_answer'] as const) {
            const call = state();
            call.waitingReason = waitingReason;
            expect(() => transition(call, consent({ accepted: true }), 200)).toThrow('Automated intake has ended');
            expect(call.conversationOwner).toBe('NONE');
        }
    });

    it('rejects new call activity at the deadline while allowing review and deletion', () => {
        const call = state();
        expect(() => transition(call, consent({ accepted: true }), call.callDeadlineAt)).toThrow('time limit');
        const review: CallCommand = { workspaceId: 'workspace-a', participantId: 'nurse-a', role: 'nurse', commandId: 'review-a', type: 'review' };
        expect(() => transition(call, review, call.callDeadlineAt + 1)).not.toThrow();
        expect(() => transition(call, { ...review, type: 'delete', role: 'admin' }, call.callDeadlineAt + 1)).not.toThrow();
    });
});
