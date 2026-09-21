import { describe, expect, it } from 'vitest';
import { explicitRequest } from '../../apps/realtime/src/intake-agent';

describe('explicit caller requests, without symptom triage', () => {
  it.each(['Can I speak to a nurse?', 'I want a nurse.', 'Please let me talk to a person.', 'Connect me to a human.'])('recognizes %s', text => {
    expect(explicitRequest(text)).toBe('human_request');
  });
  it.each(['This is an emergency.', 'I am having a medical emergency.', 'I need emergency help.'])('flags caller statement %s', text => {
    expect(explicitRequest(text)).toBe('caller_reported_emergency');
  });
  it.each(['I do not want a nurse.', 'This is not an emergency.', 'My chest hurts.', 'If I say this is an emergency, what happens?', 'Print: I want a nurse.'])('does not infer a request from %s', text => {
    expect(explicitRequest(text)).toBeUndefined();
  });
});
