import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectVoiceAgent, deleteVoiceAgentSession, VoiceAgentProtocol, VOICE_AGENT_LLM_BASE, VOICE_AGENT_MODEL, type VoiceAgentCallbacks, type VoiceAgentTool } from '../src/providers/voice-agent';

const tools: VoiceAgentTool[] = [{ type: 'function', name: 'record_fact', description: 'Store sourced facts', parameters: { type: 'object', properties: {}, additionalProperties: false } }];
const config = { systemPrompt: 'Only approved fictional intake.', tools };
const resolved = () => ({ system_prompt: config.systemPrompt, tools, input: { format: { encoding: 'audio/pcm', sample_rate: 24000 } }, output: { format: { encoding: 'audio/pcm', sample_rate: 24000 } }, llm: [{ base_url: VOICE_AGENT_LLM_BASE, model: VOICE_AGENT_MODEL }] });
const open: VoiceAgentProtocol[] = [];
function fixture() {
  const sent: Record<string, any>[] = [];
  const callbacks: VoiceAgentCallbacks = { sessionCreated: vi.fn(), unidentifiedSession: vi.fn(), ready: vi.fn(), userTranscript: vi.fn(), agentTranscript: vi.fn(), replyStarted: vi.fn(), audio: vi.fn(), replyDone: vi.fn(), speechStarted: vi.fn(), toolCall: vi.fn(() => ({ ok: true })), warning: vi.fn(), closed: vi.fn() };
  const transport = { send: vi.fn((message: string) => { sent.push(JSON.parse(message)); return true; }), close: vi.fn() };
  const agent = new VoiceAgentProtocol(transport, callbacks, config); open.push(agent);
  const receive = (value: unknown) => agent.receive(JSON.stringify(value));
  const ready = () => { agent.start('agent-fixture'); receive({ type: 'session.updated', config: resolved() }); receive({ type: 'session.ready', session_id: 'sess-fixture', config: resolved() }); receive({ type: 'session.updated', config: resolved() }); };
  return { agent, callbacks, transport, sent, receive, ready };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
afterEach(() => { for (const agent of open.splice(0)) agent.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Voice Agent protocol in Workers', () => {
  it('uses documented reply.create only after the mutable configuration is ready', () => {
    const f = fixture(); expect(f.agent.requestReply('Begin fictional intake.')).toBe(false); f.ready();
    expect(f.agent.requestReply('Begin fictional intake.')).toBe(true); expect(f.sent.at(-1)).toEqual({ type: 'reply.create', instructions: 'Begin fictional intake.' });
    expect(f.agent.requestReply('x'.repeat(4001))).toBe(false); f.agent.close(); expect(f.agent.requestReply('Begin')).toBe(false);
  });
  it('binds the stored agent alone, then requires the verified mutable configuration before PCM', () => {
    const f = fixture(); f.agent.start('agent-fixture');
    expect(f.sent).toEqual([{ type: 'session.update', session: { agent_id: 'agent-fixture' } }]);
    expect(f.agent.send(new Uint8Array(2400))).toBe(false);
    f.receive({ type: 'session.updated', config: resolved() });
    expect(f.callbacks.sessionCreated).not.toHaveBeenCalled(); expect(f.callbacks.ready).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(1); expect(f.agent.send(new Uint8Array(2400))).toBe(false);
    f.receive({ type: 'session.ready', session_id: 'sess-fixture', config: resolved() });
    expect(f.callbacks.sessionCreated).toHaveBeenCalledWith({ sessionId: 'sess-fixture' });
    expect(f.agent.ready).toBe(false);
    expect(f.sent[1]).toEqual({ type: 'session.update', session: { system_prompt: config.systemPrompt, tools } });
    f.receive({ type: 'session.updated', config: resolved() });
    expect(f.agent.ready).toBe(true); expect(f.callbacks.ready).toHaveBeenCalledTimes(1);
    expect(f.agent.send(new Uint8Array([1, 2]))).toBe(true);
    expect(f.sent.at(-1)).toEqual({ type: 'input.audio', audio: 'AQI=' });
    expect(f.agent.send(new Uint8Array(3))).toBe(false); expect(f.agent.send(new Uint8Array(4802))).toBe(false);
  });
  it.each(['format', 'model', 'greeting', 'missing'])('fails closed on pre-identity %s mismatch', mismatch => {
    const f = fixture(); f.agent.start('agent-fixture'); const applied: any = resolved();
    if (mismatch === 'format') applied.input.format.sample_rate = 16000;
    if (mismatch === 'model') applied.llm[0].base_url = 'https://unapproved.example/v1';
    if (mismatch === 'greeting') applied.greeting = 'Unexpected initial speech';
    f.receive({ type: 'session.updated', config: mismatch === 'missing' ? {} : applied });
    expect(f.callbacks.closed).toHaveBeenCalledWith('provider_configuration_mismatch');
    expect(f.callbacks.unidentifiedSession).toHaveBeenCalledExactlyOnceWith({ reason: 'connection_failed' });
    expect(f.callbacks.sessionCreated).not.toHaveBeenCalled(); expect(f.callbacks.ready).not.toHaveBeenCalled();
    expect(f.sent.at(-1)?.type).toBe('session.end'); expect(f.agent.send(new Uint8Array(2400))).toBe(false);
  });
  it.each(['format', 'model', 'greeting', 'missing'])('fails closed on stored %s mismatch while retaining session identity for deletion', mismatch => {
    const f = fixture(); const applied: any = resolved();
    if (mismatch === 'format') applied.output.format.sample_rate = 16000;
    if (mismatch === 'model') applied.llm[0].model = 'different';
    if (mismatch === 'greeting') applied.greeting = 'Unexpected initial speech';
    f.receive({ type: 'session.ready', session_id: 'sess-cleanup', config: mismatch === 'missing' ? {} : applied });
    expect(f.callbacks.sessionCreated).toHaveBeenCalledWith({ sessionId: 'sess-cleanup' });
    expect(f.callbacks.closed).toHaveBeenCalledWith('provider_configuration_mismatch');
    expect(f.callbacks.ready).not.toHaveBeenCalled(); expect(f.agent.send(new Uint8Array(2400))).toBe(false);
    expect(f.sent.at(-1)?.type).toBe('session.end');
  });
  it('requires an exact prompt and semantically matching tool echo', () => {
    const f = fixture(); f.receive({ type: 'session.ready', session_id: 'sess-fixture', config: resolved() });
    f.receive({ type: 'session.updated', config: { ...resolved(), system_prompt: 'unapproved' } });
    expect(f.callbacks.closed).toHaveBeenCalledWith('provider_configuration_mismatch');
  });
  it('bounds configuration acknowledgement time and never sends buffered mic input', () => {
    vi.useFakeTimers(); const f = fixture(); f.agent.start('agent-fixture');
    f.agent.send(new Uint8Array(2400)); vi.advanceTimersByTime(10000);
    expect(f.callbacks.closed).toHaveBeenCalledWith('provider_configuration_timeout'); expect(f.sent.some(event => event.type === 'input.audio')).toBe(false);
  });
  it('blocks PCM during a mutable update and accepts server-filled tool defaults', () => {
    const f = fixture(); f.ready(); expect(f.agent.update({ ...config, systemPrompt: 'Updated approved intake.' })).toBe(true);
    expect(f.agent.send(new Uint8Array(2400))).toBe(false); expect(f.agent.update(config)).toBe(false);
    f.receive({ type: 'session.updated', config: { ...resolved(), system_prompt: 'Updated approved intake.', tools: tools.map(tool => ({ ...tool, execution_mode: 'interactive', timeout_seconds: 120 })) } });
    expect(f.agent.ready).toBe(true); expect(f.agent.send(new Uint8Array(2400))).toBe(true);
  });
  it('accepts provider JSON Schema normalization while preserving tool semantics', () => {
    const f = fixture(); f.agent.start('agent-fixture');
    f.receive({ type: 'session.updated', config: resolved() });
    f.receive({ type: 'session.ready', session_id: 'sess-fixture', config: resolved() });
    f.receive({ type: 'session.updated', config: { ...resolved(), tools: [{ ...tools[0], parameters: { type: 'object', properties: {}, required: [] }, execution_mode: 'interactive', timeout_seconds: 120, deployment_id: null }] } });
    expect(f.agent.ready).toBe(true);
    expect(f.callbacks.closed).not.toHaveBeenCalled();
  });
  it('deduplicates final item/reply ids and treats user deltas as replacement text', () => {
    const f = fixture(); f.ready();
    f.receive({ type: 'transcript.user.delta', item_id: 'item-1', text: 'My' });
    f.receive({ type: 'transcript.user.delta', item_id: 'item-1', text: 'My throat' });
    const final = { type: 'transcript.user', item_id: 'item-1', text: 'My throat hurts' }; f.receive(final); f.receive(final);
    f.receive({ type: 'transcript.user.delta', item_id: 'item-1', text: 'Late' });
    expect(f.callbacks.userTranscript).toHaveBeenCalledTimes(3);
    expect(vi.mocked(f.callbacks.userTranscript).mock.calls[1][0].text).toBe('My throat');
    const agentFinal = { type: 'transcript.agent', reply_id: 'reply-1', item_id: 'item-2', text: 'What changed?', interrupted: true }; f.receive(agentFinal); f.receive(agentFinal);
    expect(f.callbacks.agentTranscript).toHaveBeenCalledTimes(1);
  });
  it('drops old audio after barge-in and refuses replayed starts and foreign explicit ids', () => {
    const f = fixture(); f.ready(); const start = { type: 'reply.started', reply_id: 'reply-1' };
    f.receive(start); f.receive({ type: 'reply.audio', data: 'AQI=' });
    f.receive({ type: 'input.speech.started' }); f.receive({ type: 'reply.audio', data: 'AQI=' }); f.receive(start); f.receive({ type: 'reply.audio', data: 'AQI=' });
    expect(f.callbacks.audio).toHaveBeenCalledTimes(1); expect(f.callbacks.speechStarted).toHaveBeenCalledTimes(1);
    f.receive({ type: 'reply.started', reply_id: 'reply-2' }); f.receive({ type: 'reply.audio', reply_id: 'reply-1', data: 'AQI=' }); f.receive({ type: 'reply.audio', data: 'AwQ=' });
    expect(f.callbacks.audio).toHaveBeenCalledTimes(2); expect(vi.mocked(f.callbacks.audio).mock.calls[1][0]).toMatchObject({ replyId: 'reply-2', sampleRate: 24000, sequence: 1 });
  });
  it('preserves odd PCM bytes across chunks and discards the remainder on interruption', () => {
    const f = fixture(); f.ready(); f.receive({ type: 'reply.started', reply_id: 'reply-1' });
    f.receive({ type: 'reply.audio', data: 'AQ==' }); expect(f.callbacks.audio).not.toHaveBeenCalled();
    f.receive({ type: 'reply.audio', data: 'AgME' }); expect([...vi.mocked(f.callbacks.audio).mock.calls[0][0].pcm]).toEqual([1, 2, 3, 4]);
    f.receive({ type: 'reply.audio', data: 'BQ==' }); f.agent.interrupt(); f.receive({ type: 'reply.started', reply_id: 'reply-2' }); f.receive({ type: 'reply.audio', data: 'Bgc=' });
    expect([...vi.mocked(f.callbacks.audio).mock.calls[1][0].pcm]).toEqual([6, 7]);
  });
  it('rejects a completed reply with an incomplete PCM sample', () => {
    const f = fixture(); f.ready(); f.receive({ type: 'reply.started', reply_id: 'reply-1' }); f.receive({ type: 'reply.audio', data: 'AQ==' }); f.receive({ type: 'reply.done', reply_id: 'reply-1', status: 'completed' });
    expect(f.callbacks.closed).toHaveBeenCalledWith('provider_audio_incomplete');
  });
  it('treats reply.done without status as completion, while rejecting unknown status', () => {
    const f = fixture(); f.ready(); f.receive({ type: 'reply.started', reply_id: 'reply-1' });
    f.receive({ type: 'reply.done', reply_id: 'reply-1' });
    expect(f.callbacks.replyDone).toHaveBeenCalledWith({ sessionId: 'sess-fixture', replyId: 'reply-1', status: 'completed' });
    expect(f.callbacks.closed).not.toHaveBeenCalled();
    f.receive({ type: 'reply.done', reply_id: 'reply-2', status: 'unexpected' });
    expect(f.callbacks.closed).toHaveBeenCalledWith('provider_invalid_event');
  });
  it('executes a duplicate tool once, never waits on it in the event handler, and sends only after its completed reply.done', async () => {
    const f = fixture(); f.ready(); let finish!: (value: unknown) => void;
    vi.mocked(f.callbacks.toolCall).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    f.receive({ type: 'reply.started', reply_id: 'fc-call-1' }); f.receive({ type: 'reply.audio', data: 'AQI=' });
    const tool = { type: 'tool.call', call_id: 'call-1', name: 'record_fact', arguments: { field: 'onset' } }; f.receive(tool); f.receive(tool);
    f.receive({ type: 'reply.done', reply_id: 'fc-call-1', status: 'completed' });
    expect(f.callbacks.replyDone).toHaveBeenCalled(); expect(f.callbacks.audio).not.toHaveBeenCalled(); expect(f.callbacks.replyStarted).not.toHaveBeenCalled();
    expect(f.sent.some(event => event.type === 'tool.result')).toBe(false); finish({ receipt: 'durable-1' }); await flush();
    expect(f.callbacks.toolCall).toHaveBeenCalledTimes(1); expect(f.sent.at(-1)).toEqual({ type: 'tool.result', call_id: 'call-1', result: '{"receipt":"durable-1"}', is_error: false });
    f.receive({ type: 'reply.done', reply_id: 'fc-call-1', status: 'completed' }); expect(f.sent.filter(event => event.type === 'tool.result')).toHaveLength(1);
  });
  it('holds a durable result through a new reply and flushes it after that reply completes', async () => {
    const f = fixture(); f.ready(); let finish!: (value: unknown) => void;
    vi.mocked(f.callbacks.toolCall).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    f.receive({ type: 'tool.call', call_id: 'call-1', name: 'record_fact', arguments: {} }); f.receive({ type: 'reply.done', reply_id: 'fc-call-1', status: 'completed' });
    f.receive({ type: 'reply.started', reply_id: 'reply-2' }); finish({ receipt: 'already-durable' }); await flush();
    expect(f.sent.some(event => event.type === 'tool.result')).toBe(false);
    f.receive({ type: 'reply.done', reply_id: 'reply-2', status: 'completed' });
    expect(f.sent.at(-1)).toEqual({ type: 'tool.result', call_id: 'call-1', result: '{"receipt":"already-durable"}', is_error: false });
    f.receive({ type: 'reply.done', reply_id: 'fc-call-1', status: 'completed' });
    expect(f.sent.filter(event => event.type === 'tool.result')).toHaveLength(1); expect(f.callbacks.toolCall).toHaveBeenCalledTimes(1);
  });
  it('keeps the completed reply idle through transcripts and flushes all ready tools, including late results', async () => {
    const f = fixture(); f.ready(); let finish!: (value: unknown) => void;
    vi.mocked(f.callbacks.toolCall).mockImplementation(({ callId }) => callId === 'call-2' ? new Promise(resolve => { finish = resolve; }) : { receipt: 'first' });
    f.receive({ type: 'tool.call', call_id: 'call-1', name: 'record_fact', arguments: { first: true } });
    f.receive({ type: 'tool.call', call_id: 'call-2', name: 'record_fact', arguments: { second: true } });
    await flush();
    f.receive({ type: 'reply.done', reply_id: 'fc-call-2' });
    expect(f.sent.filter(event => event.type === 'tool.result')).toEqual([{ type: 'tool.result', call_id: 'call-1', result: '{"receipt":"first"}', is_error: false }]);
    f.receive({ type: 'transcript.user.delta', item_id: 'item-1', text: 'fictional' });
    finish({ receipt: 'second' }); await flush();
    expect(f.sent.filter(event => event.type === 'tool.result')).toEqual([
      { type: 'tool.result', call_id: 'call-1', result: '{"receipt":"first"}', is_error: false },
      { type: 'tool.result', call_id: 'call-2', result: '{"receipt":"second"}', is_error: false },
    ]);
  });
  it('holds a pending tool through speech start and discards it only when the reply is interrupted', async () => {
    const f = fixture(); f.ready(); let finish!: (value: unknown) => void;
    vi.mocked(f.callbacks.toolCall).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    f.receive({ type: 'tool.call', call_id: 'call-1', name: 'record_fact', arguments: {} });
    f.receive({ type: 'input.speech.started' }); finish({ receipt: 'stored' }); await flush();
    expect(f.sent.some(event => event.type === 'tool.result')).toBe(false);
    f.receive({ type: 'reply.done', reply_id: 'reply-2', status: 'completed' });
    expect(f.sent.at(-1)).toMatchObject({ type: 'tool.result', call_id: 'call-1' });

    const g = fixture(); g.ready(); let finishInterrupted!: (value: unknown) => void;
    vi.mocked(g.callbacks.toolCall).mockImplementation(() => new Promise(resolve => { finishInterrupted = resolve; }));
    g.receive({ type: 'tool.call', call_id: 'call-2', name: 'record_fact', arguments: {} });
    g.receive({ type: 'reply.done', reply_id: 'reply-interrupted', status: 'interrupted' });
    finishInterrupted({ receipt: 'too-late' }); await flush();
    g.receive({ type: 'reply.done', reply_id: 'reply-next', status: 'completed' });
    expect(g.sent.some(event => event.type === 'tool.result')).toBe(false);
  });
  it('rejects a tool call id reused with changed arguments', () => {
    const f = fixture(); f.ready(); f.receive({ type: 'tool.call', call_id: 'call-1', name: 'record_fact', arguments: {} }); f.receive({ type: 'tool.call', call_id: 'call-1', name: 'record_fact', arguments: { other: true } });
    expect(f.callbacks.closed).toHaveBeenCalledWith('provider_tool_id_reused'); expect(f.callbacks.toolCall).toHaveBeenCalledTimes(1);
  });
  it('never returns an interrupted tool result or executes an undeclared tool', async () => {
    const f = fixture(); f.ready(); f.receive({ type: 'tool.call', call_id: 'call-1', name: 'record_fact', arguments: {} });
    f.receive({ type: 'reply.done', reply_id: 'fc-call-1', status: 'interrupted' }); await flush(); expect(f.sent.some(event => event.type === 'tool.result')).toBe(false);
    f.receive({ type: 'tool.call', call_id: 'call-2', name: 'undeclared_tool', arguments: {} }); f.receive({ type: 'reply.done', reply_id: 'fc-call-2', status: 'completed' });
    expect(f.callbacks.toolCall).toHaveBeenCalledTimes(1); expect(f.sent.at(-1)).toMatchObject({ type: 'tool.result', call_id: 'call-2', is_error: true });
  });
  it('sanitizes tool failure messages and provider errors', async () => {
    const f = fixture(); f.ready(); vi.mocked(f.callbacks.toolCall).mockRejectedValue(new Error('FICTIONAL_SENSITIVE_MARKER'));
    f.receive({ type: 'tool.call', call_id: 'call-1', name: 'record_fact', arguments: {} }); await flush(); f.receive({ type: 'reply.done', reply_id: 'fc-call-1', status: 'completed' });
    expect(JSON.stringify(f.sent)).not.toContain('FICTIONAL_SENSITIVE_MARKER'); expect(f.sent.at(-1)?.is_error).toBe(true);
    f.receive({ type: 'session.error', message: 'FICTIONAL_SENSITIVE_MARKER' }); expect(f.callbacks.closed).toHaveBeenCalledWith('provider_error');
  });
  it('bounds input events and output audio chunks', () => {
    const f = fixture(); f.ready(); f.receive({ type: 'reply.started', reply_id: 'reply-1' }); f.receive({ type: 'reply.audio', data: 'A'.repeat(64004) });
    expect(f.callbacks.audio).not.toHaveBeenCalled(); expect(f.callbacks.closed).toHaveBeenCalledWith('provider_invalid_event');
    const g = fixture(); g.agent.receive('A'.repeat(128001)); expect(g.callbacks.closed).toHaveBeenCalledWith('provider_event_limit');
  });
  it('ends once and gates all late events after intentional close', () => {
    const f = fixture(); f.ready(); f.agent.close(); f.agent.close(); f.receive({ type: 'reply.started', reply_id: 'late' });
    expect(f.sent.filter(event => event.type === 'session.end')).toHaveLength(1); expect(f.callbacks.closed).not.toHaveBeenCalled(); expect(f.agent.ready).toBe(false);
  });
  it('captures an eventual identity after early close without activating prompt, tools, or PCM', () => {
    const f = fixture(); f.agent.start('agent-fixture'); f.agent.close(); f.agent.close();
    expect(f.transport.close).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(1);
    expect(f.agent.send(new Uint8Array(2400))).toBe(false); expect(f.agent.requestReply('Begin')).toBe(false); expect(f.agent.update(config)).toBe(false);
    f.receive({ type: 'reply.started', reply_id: 'early-reply' }); f.receive({ type: 'reply.audio', data: 'AQI=' });
    f.receive({ type: 'tool.call', call_id: 'early-tool', name: 'record_fact', arguments: {} });
    // Identity cleanup must not depend on the configuration being acceptable.
    f.receive({ type: 'session.ready', session_id: 'sess-created-after-close', config: {} });
    expect(f.callbacks.sessionCreated).toHaveBeenCalledWith({ sessionId: 'sess-created-after-close' });
    expect(f.sent).toEqual([{ type: 'session.update', session: { agent_id: 'agent-fixture' } }, { type: 'session.end' }]);
    expect(f.transport.close).toHaveBeenCalledTimes(1); expect(f.callbacks.ready).not.toHaveBeenCalled(); expect(f.callbacks.audio).not.toHaveBeenCalled(); expect(f.callbacks.toolCall).not.toHaveBeenCalled();
    expect(f.callbacks.unidentifiedSession).not.toHaveBeenCalled(); expect(f.callbacks.closed).not.toHaveBeenCalled();
  });
  it('early close keeps the original handshake deadline and reports unidentified timeout once', () => {
    vi.useFakeTimers(); const f = fixture(); f.agent.start('agent-fixture'); vi.advanceTimersByTime(9000); f.agent.close();
    vi.advanceTimersByTime(999); expect(f.transport.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(f.transport.close).toHaveBeenCalledTimes(1);
    expect(f.callbacks.unidentifiedSession).toHaveBeenCalledExactlyOnceWith({ reason: 'connection_timeout' });
    f.agent.fail('provider_disconnected'); f.agent.close(); f.receive({ type: 'session.ready', session_id: 'too-late', config: resolved() });
    expect(f.callbacks.unidentifiedSession).toHaveBeenCalledTimes(1); expect(f.callbacks.sessionCreated).not.toHaveBeenCalled();
  });
  it('reports disconnection without identity even after an intentional early close', () => {
    const f = fixture(); f.agent.start('agent-fixture'); f.agent.close(); f.agent.fail('provider_disconnected');
    expect(f.callbacks.unidentifiedSession).toHaveBeenCalledExactlyOnceWith({ reason: 'connection_failed' }); expect(f.transport.close).toHaveBeenCalledTimes(1);
  });
  it('does not invent a session identity from the session.ended event', () => {
    const f = fixture(); f.agent.start('agent-fixture'); f.agent.close(); f.receive({ type: 'session.ended', session_duration_seconds: 0, timestamp: 123 });
    expect(f.callbacks.sessionCreated).not.toHaveBeenCalled(); expect(f.callbacks.unidentifiedSession).toHaveBeenCalledExactlyOnceWith({ reason: 'session_ended_without_id' });
  });
  it('still closes immediately with a known identity before the configuration acknowledgement', () => {
    const f = fixture(); f.agent.start('agent-fixture'); f.receive({ type: 'session.ready', session_id: 'sess-known', config: resolved() }); f.agent.close();
    expect(f.transport.close).toHaveBeenCalledTimes(1); expect(f.sent.at(-1)?.type).toBe('session.end'); expect(f.callbacks.unidentifiedSession).not.toHaveBeenCalled();
    f.receive({ type: 'session.updated', config: resolved() }); expect(f.callbacks.ready).not.toHaveBeenCalled();
  });
  it('reports an uncertain failed upgrade using only a sanitized reason', async () => {
    const f = fixture(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('FICTIONAL_SENSITIVE_MARKER'));
    await expect(connectVoiceAgent({ ...config, apiKey: 'synthetic-test-key', agentId: 'agent-test' }, f.callbacks)).rejects.toThrow('Voice agent connection unavailable');
    expect(f.callbacks.unidentifiedSession).toHaveBeenCalledExactlyOnceWith({ reason: 'connection_failed' });
  });
  it('uses an actual Workers WebSocket upgrade without Node transport', async () => {
    const pair = new WebSocketPair(); pair[1].accept(); const received: any[] = []; pair[1].addEventListener('message', event => { received.push(JSON.parse(event.data as string)); });
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 101, webSocket: pair[0] }));
    const f = fixture(); const connection = await connectVoiceAgent({ ...config, apiKey: 'synthetic-test-key', agentId: 'agent-test' }, f.callbacks);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(request.mock.calls[0][0]).toBe('https://agents.assemblyai.com/v1/ws'); expect(request.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer synthetic-test-key', Upgrade: 'websocket' });
    expect(received[0]).toEqual({ type: 'session.update', session: { agent_id: 'agent-test' } }); connection.close(); pair[1].close();
  });
  it('does not abort an upgraded socket when the handshake deadline passes', async () => {
    vi.useFakeTimers();
    const pair = new WebSocketPair(); pair[1].accept();
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 101, webSocket: pair[0] }));
    const f = fixture(); const connection = await connectVoiceAgent({ ...config, apiKey: 'synthetic-test-key', agentId: 'agent-test' }, f.callbacks);
    const signal = request.mock.calls[0][1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    vi.advanceTimersByTime(10001);
    expect(signal?.aborted).toBe(false);
    connection.close(); pair[1].close();
  });
});

describe('provider session deletion', () => {
  it.each([204, 404])('treats status %i as idempotent logical deletion', async status => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
    await deleteVoiceAgentSession('synthetic-key', 'sess-fixture');
    expect(request).toHaveBeenCalledWith('https://agents.assemblyai.com/v1/sessions/sess-fixture', expect.objectContaining({ method: 'DELETE', headers: { Authorization: 'Bearer synthetic-key' } }));
  });
  it('does not accept other statuses or disclose transport/body errors', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ cancel() { throw new Error('FICTIONAL_SENSITIVE_MARKER'); } }), { status: 503 }));
    await expect(deleteVoiceAgentSession('synthetic-key', 'sess-fixture')).rejects.toThrow('Voice agent deletion not confirmed');
    request.mockRejectedValue(new Error('FICTIONAL_SENSITIVE_MARKER')); await expect(deleteVoiceAgentSession('synthetic-key', 'sess-fixture')).rejects.toThrow('Voice agent deletion unavailable');
  });
  it('rejects malformed session ids without making a request', async () => {
    const request = vi.spyOn(globalThis, 'fetch'); await expect(deleteVoiceAgentSession('synthetic-key', '../other')).rejects.toThrow('configuration invalid'); expect(request).not.toHaveBeenCalled();
  });
});
