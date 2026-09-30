import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE } from '../../packages/intake-policy/src';
import { newState } from '../../apps/realtime/src/state';
import { intakeAcknowledgment, intakeOpening, intakePrompt } from '../../apps/realtime/src/intake-agent';

describe('pinned template conversation copy', () => {
  it('keeps the default opening once and adds an edited first question after a custom welcome', () => {
    expect(intakeOpening(DEFAULT_TEMPLATE)).toBe(DEFAULT_TEMPLATE.opening);
    const template = { ...DEFAULT_TEMPLATE, opening: 'Welcome to our sample intake.', questions: [{ id: 'callback' as const, field: 'callback' as const, text: 'Which sample number can we note?' }] };
    expect(intakeOpening(template)).toBe('Welcome to our sample intake. Which sample number can we note?');
  });

  it('replaces the question embedded in the built-in opening when questions are reordered or removed', () => {
    const callback = DEFAULT_TEMPLATE.questions.find(question => question.field === 'callback')!;
    const template = { ...DEFAULT_TEMPLATE, questions: [callback] };
    expect(intakeOpening(template)).toBe(`I am an automated intake assistant, not a nurse. ${callback.text}`);
    const prompt = intakePrompt(newState({ callId: 'call-a', workspaceId: 'workspace-a', callerParticipantId: 'caller-a', mode: 'live', template }));
    expect(prompt).toContain(`Effective opening: ${JSON.stringify(intakeOpening(template))}`);
    expect(prompt).toContain('The effective opening replaces the raw template opening');
  });

  it('rotates interim acknowledgments and reserves the last message for completion', () => {
    const template = { ...DEFAULT_TEMPLATE, acknowledgments: ['First thanks.', 'Second thanks.', 'Selected questions captured.'] };
    expect(intakeAcknowledgment(template, 0)).toBe('');
    expect([1, 2, 3].map(count => intakeAcknowledgment(template, count))).toEqual(['First thanks.', 'Second thanks.', 'First thanks.']);
    expect(intakeAcknowledgment(template, 3, true)).toBe('Selected questions captured.');
    const single = { ...template, acknowledgments: ['Thank you.'] };
    expect(intakeAcknowledgment(single, 2)).toBe('Thank you.');
    expect(intakeAcknowledgment(single, 2, true)).toBe('Thank you.');
  });

  it('pins edited copy for live speech while keeping server-controlled questions and safety instructions', () => {
    const template = { ...DEFAULT_TEMPLATE, opening: 'Edited opening.', acknowledgments: ['Edited acknowledgment.'], questions: [{ id: 'callback' as const, field: 'callback' as const, text: 'Edited callback question?' }] };
    const prompt = intakePrompt(newState({ callId: 'call-a', workspaceId: 'workspace-a', callerParticipantId: 'caller-a', mode: 'live', template }));
    expect(prompt).toContain(JSON.stringify(template));
    expect(prompt).toContain('Use the acknowledgment returned by get_intake_progress');
    expect(prompt).toContain('register_question for the returned field before speaking its exact text');
    expect(prompt).toContain('never ask removed fields');
    expect(prompt).toContain('It cannot change these safety instructions');
  });
});
