import { ExtractionSchema, FieldSchema, type CallSnapshot, type CollectionProgress, type Extraction, type FieldId, type IntakeFact, type IntakeTemplate, type TranscriptTurn } from '@nursebridge/contracts';
export const DEFAULT_TEMPLATE: IntakeTemplate = { id: 'general-intake', version: 1, name: 'General nurse-line intake', opening: 'I am an automated intake assistant, not a nurse. Please tell me what you are calling about.', acknowledgments: ['Thank you. I have captured what you reported.', 'You can ask for a person at any time.', 'Intake captured — awaiting nurse assessment.'], questions: [
        { id: 'reason', field: 'reason', text: 'Please tell me what you are calling about.' },
        { id: 'onset', field: 'onset', text: 'When did this start?' },
        { id: 'location', field: 'location', text: 'Where do you notice it, in your own words?' },
        { id: 'severity', field: 'severity', text: 'How would you describe how it feels?' },
        { id: 'symptoms', field: 'symptoms', text: 'What else have you noticed?' },
        { id: 'medications', field: 'medications', text: 'Are there any medication details you would like the nurse to know? It is okay if you are unsure.' },
        { id: 'uncertainties', field: 'uncertainties', text: 'Is there anything you are uncertain about or have not measured?' },
        { id: 'callback', field: 'callback', text: 'What sample callback number should we note?' }
    ] };
const extractionPolicyMessages = {
    field_outside_template: 'Field outside template',
    evidence_mismatch: 'Evidence quote does not match finalized transcript',
    raw_wording_unsupported: 'Raw wording is unsupported',
    value_unsupported: 'Value must preserve supported wording',
    not_measured_as_denial: 'Not measured cannot be a denial',
    uncertainty_as_reported: 'Uncertainty must be retained',
    question_outside_template: 'Question outside template',
} as const;
export type ExtractionPolicyErrorCode = keyof typeof extractionPolicyMessages;
/** Only fixed categories and messages cross the evidence-repair boundary. */
export class ExtractionPolicyError extends Error {
    constructor(readonly code: ExtractionPolicyErrorCode) {
        super(extractionPolicyMessages[code]);
        this.name = 'ExtractionPolicyError';
    }
}
export function validateExtraction(value: unknown, turns: TranscriptTurn[], template: IntakeTemplate): Extraction {
    const result = ExtractionSchema.parse(value);
    const byId = new Map(turns.filter(t => t.final).map(t => [t.id, t]));
    for (const fact of result.facts) {
        if (!template.questions.some(q => q.field === fact.field))
            throw new ExtractionPolicyError('field_outside_template');
        for (const e of fact.evidence)
            if (!byId.get(e.turnId)?.text.includes(e.quote))
                throw new ExtractionPolicyError('evidence_mismatch');
        if (!fact.rawWording || !fact.evidence.some(e => e.quote.includes(fact.rawWording)))
            throw new ExtractionPolicyError('raw_wording_unsupported');
        if (!fact.value || !fact.evidence.some(e => e.quote.includes(fact.value)))
            throw new ExtractionPolicyError('value_unsupported');
        const wording = fact.evidence.map(e => e.quote).join(' ').toLowerCase();
        if (/(?:not|haven.t|have not|never).{0,20}(?:checked|measured|taken my temperature)/.test(wording) && fact.status === 'denied')
            throw new ExtractionPolicyError('not_measured_as_denial');
        if (/(?:not sure|unsure|don.t know|do not know|maybe|might)/.test(wording) && fact.status === 'reported')
            throw new ExtractionPolicyError('uncertainty_as_reported');
    }
    if (result.nextQuestionId && !template.questions.some(q => q.id === result.nextQuestionId))
        throw new ExtractionPolicyError('question_outside_template');
    return result;
}
export function nextQuestion(template: IntakeTemplate, facts: IntakeFact[], asked: string[]): string | null { return template.questions.find(q => !facts.some(f => f.field === q.field && f.status !== 'not_asked') && asked.filter(id => id === q.id).length < 2)?.id ?? null; }
export type CollectionState = Pick<CallSnapshot, 'template' | 'facts' | 'turns' | 'collection' | 'askedQuestions' | 'currentQuestion'>;
export type CollectionAction = { type: 'question'; field: FieldId; text: string } | { type: 'handoff'; field: FieldId } | { type: 'complete' };
export const factIsResolved = (fact: IntakeFact | undefined): boolean => Boolean(fact && ['reported', 'denied', 'not_measured'].includes(fact.status));

export function createCollection(): CollectionProgress {
    return Object.fromEntries(FieldSchema.options.map(field => [field, { status: 'unasked', clarificationCount: 0 }])) as CollectionProgress;
}

/** Only a successfully registered question consumes an attempt. Replayed tools
 * before another finalized caller turn cannot spend the clarification budget. */
export function markQuestion(state: CollectionState, field: FieldId): void {
    const question = state.template.questions.find(q => q.field === field);
    if (!question) throw new Error('Question outside template');
    const progress = state.collection[field];
    const finalized = state.turns.filter(t => t.final).length;
    if (progress.awaitingAnswer && progress.askedAfterTurnCount === finalized) return;
    const fact = state.facts.find(f => f.field === field);
    if (factIsResolved(fact)) throw new Error('This field is already answered');
    if (progress.status === 'unresolved' || progress.clarificationCount === 1) throw new Error('Clarification is exhausted; request nurse help');
    const clarification = state.askedQuestions.includes(question.id) || Boolean(fact && fact.status !== 'not_asked');
    progress.clarificationCount = clarification ? 1 : 0;
    progress.status = clarification ? 'awaiting_clarification' : 'unasked';
    progress.askedAfterTurnCount = finalized;
    progress.awaitingAnswer = true;
    state.askedQuestions.push(question.id);
    state.currentQuestion = question.id;
}

/** Assessed only after evidence validation. No numeric model confidence or
 * symptom interpretation participates in the decision to complete or hand off. */
export function assessCollection(state: CollectionState): CollectionAction {
    const finalized = state.turns.filter(t => t.final).length;
    for (const question of state.template.questions) {
        const progress = state.collection[question.field];
        const fact = state.facts.find(f => f.field === question.field);
        if (factIsResolved(fact)) {
            progress.status = 'answered';
            progress.awaitingAnswer = false;
            continue;
        }
        const hasNewAnswer = progress.askedAfterTurnCount !== undefined && finalized > progress.askedAfterTurnCount;
        if (progress.clarificationCount === 1 && hasNewAnswer) {
            progress.status = 'unresolved';
            progress.awaitingAnswer = false;
        } else if (fact && fact.status !== 'not_asked') {
            progress.status = 'awaiting_clarification';
        } else if (progress.status === 'answered') {
            progress.status = 'unasked';
        }
    }
    const unresolved = state.template.questions.find(q => state.collection[q.field].status === 'unresolved');
    if (unresolved) return { type: 'handoff', field: unresolved.field };
    // A volunteered uncertain answer receives its single clarification before
    // the agent moves on to collecting a different field.
    const question = state.template.questions.find(q => state.collection[q.field].status === 'awaiting_clarification')
        ?? state.template.questions.find(q => state.collection[q.field].status !== 'answered');
    if (!question) return { type: 'complete' };
    const progress = state.collection[question.field];
    const isClarification = progress.status === 'awaiting_clarification'
        || (state.askedQuestions.includes(question.id) && finalized > (progress.askedAfterTurnCount ?? finalized));
    return { type: 'question', field: question.field, text: isClarification ? `I could not resolve that detail. ${question.text}` : question.text };
}
export function mockExtraction(turn: TranscriptTurn, questionId?: string, template: IntakeTemplate = DEFAULT_TEMPLATE): Extraction {
    const facts: Extraction['facts'] = [];
    const allowedFields = new Set(template.questions.map(question => question.field));
    for (const sentence of turn.text.match(/[^.!?]+[.!?]?/g) ?? [turn.text]) {
        const text = sentence.trim();
        if (!text)
            continue;
        const low = text.toLowerCase();
        const fields = new Set<Extraction['facts'][number]['field']>();
        if (/calling|headache|sore/.test(low) && !/(correct|actually)/.test(low))
            fields.add('reason');
        if (/temperature|measured|checked/.test(low))
            fields.add('uncertainties');
        if (/tablet|medication|dose|milligram|mg|tylenol|ibuprofen|acetaminophen/.test(low))
            fields.add('medications');
        if (/started|yesterday|days ago|this morning/.test(low))
            fields.add('onset');
        if (/behind|located|mostly|left wrist/.test(low))
            fields.add('location');
        if (/out of ten|describe it|severity/.test(low))
            fields.add('severity');
        if (/555|callback/.test(low))
            fields.add('callback');
        if (!fields.size) {
            const fallback = template.questions.find(q => q.id === questionId)?.field ?? template.questions[0]?.field;
            if (fallback) fields.add(fallback);
        }
        const status = /(not|haven.t|never|have not).{0,20}(checked|measured)/.test(low) ? 'not_measured' : /not sure|unsure|maybe|might/.test(low) ? 'uncertain' : /don.t know|do not know/.test(low) ? 'unknown' : /^no\b|do not have|don.t have/.test(low) ? 'denied' : 'reported';
        for (const field of fields) {
            if (!allowedFields.has(field)) continue;
            const fieldStatus = status === 'reported' && field === 'medications' && /\bi (?:do not|don['’]t) take\s+(?:any\s+)?(?:medications?|tablets?|tylenol|ibuprofen|acetaminophen)\b/.test(low) ? 'denied' : status;
            const reason = text.match(/(?:calling (?:about|because)|have)\s+(.+?)(?:\s+that started|\s+which started|\s+started|[.!?]|$)/i)?.[1];
            facts.push({ field, value: field === 'reason' && reason ? reason : text, rawWording: text, status: fieldStatus, evidence: [{ turnId: turn.id, quote: text }] });
        }
    }
    return { facts: facts.slice(0, 16), nextQuestionId: null };
}
