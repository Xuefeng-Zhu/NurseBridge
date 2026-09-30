import { z } from 'zod';
export const DISCLOSURE = 'Use sample patient information only. Not for medical care.';
export const EMERGENCY_COPY = 'This service does not provide emergency care. For an emergency, contact emergency services.';
export const RECORDING_DISCLOSURE_VERSION = 'voice-agent-recording-v2';
export const RECORDING_DISCLOSURE = 'Automated services process your audio and conversation to prepare an intake summary for your care team. Your intake may be recorded. You can decline automated intake and wait for a nurse.';
export const RoleSchema = z.enum(['admin', 'nurse', 'caller']);
export type Role = z.infer<typeof RoleSchema>;
export type Mode = 'mock' | 'live';
export const FieldSchema = z.enum(['reason', 'onset', 'location', 'severity', 'symptoms', 'medications', 'uncertainties', 'callback']);
export type FieldId = z.infer<typeof FieldSchema>;
export const FactStatusSchema = z.enum(['not_asked', 'unknown', 'not_measured', 'denied', 'reported', 'uncertain']);
export type FactStatus = z.infer<typeof FactStatusSchema>;
export const ProposedFactStatusSchema = FactStatusSchema.exclude(['not_asked']);
export type ProposedFactStatus = z.infer<typeof ProposedFactStatusSchema>;
export const EvidenceSchema = z.object({ turnId: z.string(), quote: z.string().min(1).max(4000) });
export type Evidence = z.infer<typeof EvidenceSchema>;
export const ProposedFactSchema = z.object({ field: FieldSchema, value: z.string().max(4000), rawWording: z.string().max(4000), status: ProposedFactStatusSchema, evidence: z.array(EvidenceSchema).min(1).max(8) });
export type ProposedFact = z.infer<typeof ProposedFactSchema>;
export interface IntakeFact extends Omit<ProposedFact, 'status'> {
    status: FactStatus;
    revision: number;
    nurseReviewed: boolean;
    patientConfirmed: boolean;
    updatedAt: number;
}
export interface FactRevision {
    id: string;
    field: FieldId;
    revision: number;
    previous?: IntakeFact;
    current: IntakeFact;
    actor: string;
    at: number;
}
export interface TranscriptWord {
    text: string;
    start: number;
    end: number;
    confidence?: number;
}
export interface TranscriptTurn {
    id: string;
    sessionId: string;
    order: number;
    text: string;
    final: boolean;
    words?: TranscriptWord[];
    at: number;
    providerItemId?: string;
    timingAvailability?: 'word' | 'turn' | 'unavailable';
    start?: number;
    end?: number;
}
export interface AssistantTranscriptTurn {
    id: string;
    sessionId: string;
    replyId: string;
    text: string;
    final: boolean;
    interrupted: boolean;
    at: number;
}
export interface FieldCollection {
    status: 'unasked' | 'answered' | 'awaiting_clarification' | 'unresolved';
    clarificationCount: 0 | 1;
    askedAfterTurnCount?: number;
    awaitingAnswer?: boolean;
}
export type CollectionProgress = Record<FieldId, FieldCollection>;
export type EscalationReason = 'human_request' | 'technical_failure' | 'unresolved_answer' | 'caller_reported_emergency' | 'consent_refused';
export type WaitingReason = 'intake_complete' | EscalationReason;
export interface RecordingConsent {
    disclosureVersion: string;
    acceptedAt: number;
}
export interface ProviderSession {
    status: 'idle' | 'connecting' | 'active' | 'ending' | 'ended' | 'failed' | 'interrupted';
    id?: string;
    agentId?: string;
    agentVersion?: string;
    startedAt?: number;
    endedAt?: number;
    lastFinalizedTurnId?: string;
}
export interface TimelineEvent {
    id: string;
    type: string;
    at: number;
    message: string;
    revision: number;
}
export interface Escalation {
    id: string;
    reason: EscalationReason;
    message: string;
    at: number;
    acknowledgedBy?: string;
    acknowledgedAt?: number;
}
export interface TemplateQuestion {
    id: FieldId;
    field: FieldId;
    text: string;
}
export interface IntakeTemplate {
    id: string;
    version: number;
    name: string;
    opening: string;
    questions: TemplateQuestion[];
    acknowledgments: string[];
    createdAt?: number;
}
export interface CallSnapshot {
    workspacePreferences?: WorkspacePreferences;
    version: 2;
    id: string;
    /** Missing on older snapshots; defaults to a browser caller. */
    channel?: 'browser' | 'phone';
    workspaceId: string;
    callerParticipantId: string;
    mode: Mode;
    createdAt: number;
    expiresAt: number;
    callDeadlineAt: number;
    queueState: 'WAITING' | 'CLAIMED' | 'CONNECTED' | 'CLOSED';
    intakeState: 'NOT_STARTED' | 'CONSENTED' | 'IN_PROGRESS' | 'CAPTURED' | 'DECLINED' | 'INTERRUPTED';
    conversationOwner: 'NONE' | 'AI' | 'HANDOFF_PENDING' | 'NURSE';
    revision: number;
    controlRevision: number;
    controlEpoch: number;
    responseGeneration: number;
    consent: boolean;
    recordingConsent?: RecordingConsent;
    waitingReason?: WaitingReason;
    collection: CollectionProgress;
    providerSession: ProviderSession;
    humanRequested: boolean;
    aiStatus: 'idle' | 'listening' | 'thinking' | 'speaking' | 'unavailable' | 'stopped';
    nurseReviewStatus: 'pending' | 'reviewed';
    claim?: {
        participantId: string;
        expiresAt: number;
    };
    handoff?: {
        id: string;
        deadline: number;
        callerFlushed: boolean;
        callerHeard: boolean;
        nurseHeard: boolean;
    };
    participants: {
        caller: boolean;
        nurse: boolean;
    };
    turns: TranscriptTurn[];
    assistantTurns: AssistantTranscriptTurn[];
    facts: IntakeFact[];
    factRevisions: FactRevision[];
    timeline: TimelineEvent[];
    escalations: Escalation[];
    template: IntakeTemplate;
    askedQuestions: string[];
    currentQuestion?: string;
    projection: {
        revision: number;
        updatedAt: number;
        error?: string;
    };
    warnings: string[];
    deleted?: boolean;
    timings?: Record<string, number>;
}
export interface CallCommand {
    workspaceId: string;
    participantId: string;
    role: Role;
    commandId: string;
    expectedRevision?: number;
    type: string;
    payload?: Record<string, unknown>;
}
export interface Session {
    workspaceId: string;
    participantId: string;
    role: Role;
    expiresAt: number;
}
export type RpcResult<T = Record<string, unknown>> = ({
    ok: true;
} & T) | {
    ok: false;
    status: number;
    error: string;
    code?: string;
};
export const CommandBodySchema = z.object({ commandId: z.string().uuid(), expectedRevision: z.number().int().nonnegative().optional() }).passthrough();
export const ExtractionSchema = z.object({ facts: z.array(ProposedFactSchema).max(16), nextQuestionId: FieldSchema.nullable() });
export type Extraction = z.infer<typeof ExtractionSchema>;
export const WorkspacePreferencesSchema = z.object({
    retentionDays: z.number().int().min(1).max(30),
    escalationDestination: z.string().trim().min(1).max(120),
    automatedIntake: z.boolean(),
    recordingAllowed: z.boolean(),
    phoneEnabled: z.boolean(),
});
export type WorkspacePreferences = z.infer<typeof WorkspacePreferencesSchema>;
export function workspacePreferences(raw: string | Record<string, unknown> = {}): WorkspacePreferences {
    let value: Record<string, unknown> = {};
    try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { /* Legacy empty configuration. */ }
    return WorkspacePreferencesSchema.parse({ retentionDays: 7, escalationDestination: 'Nurse queue', automatedIntake: true, recordingAllowed: true, phoneEnabled: true, ...value });
}
export function automatedIntakeAllowed(preferences: WorkspacePreferences, mode: Mode): boolean {
    return preferences.automatedIntake && (mode === 'mock' || preferences.recordingAllowed);
}
export interface DemoSettings {
    revision: number;
    preferences: WorkspacePreferences;
    capabilities: { automatedIntake: boolean; blockers: string[]; phoneNumbers: string[]; phoneAvailable: boolean; checkedAt: number };
    workspaceExpiresAt: number;
    phoneInbound?: {
        configured: boolean;
        enabled: boolean;
        provider: 'twilio';
    };
    retentionDays: number;
    recording: {
        provider: 'assemblyai';
        enabled: boolean;
        disclosureVersion: string;
        retentionVerified: boolean;
        deletionVerified: boolean;
    };
    escalationDestination: string;
    template: IntakeTemplate;
    mode: Mode;
    providers: {
        voiceAgent: {
            configured: boolean;
            verified: boolean;
        };
        extraction: {
            configured: boolean;
            verified: boolean;
        };
    };
}
