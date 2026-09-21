/** AssemblyAI Voice Agent wire protocol. All transport and credentials stay in Workers. */
export const VOICE_AGENT_MODEL = 'nvidia/Nemotron-3_5-Lightning';
export const VOICE_AGENT_LLM_BASE = 'https://api.tokenfactory.nebius.com/v1';
export interface VoiceAgentTool {
  type: 'function'; name: string; description?: string; parameters: Record<string, unknown>;
  execution_mode?: 'interactive' | 'hold'; timeout_seconds?: number;
}
export interface VoiceAgentConfiguration { systemPrompt: string; tools: VoiceAgentTool[]; }
export interface VoiceAgentOptions extends VoiceAgentConfiguration { apiKey: string; agentId: string; }
export type VoiceToolCall = { sessionId: string; replyId: string; callId: string; name: string; arguments: Record<string, unknown> };
export type UnidentifiedSessionReason = 'connection_failed' | 'connection_timeout' | 'session_ended_without_id';
export interface VoiceAgentCallbacks {
  sessionCreated?(event: { sessionId: string }): void;
  unidentifiedSession?(event: { reason: UnidentifiedSessionReason }): void;
  ready(event: { sessionId: string }): void;
  userTranscript(event: { id: string; sessionId: string; itemId: string; text: string; final: boolean; at: number }): void;
  agentTranscript(event: { sessionId: string; itemId: string; replyId: string; text: string; interrupted: boolean; at: number }): void;
  replyStarted(event: { sessionId: string; replyId: string }): void;
  audio(event: { sessionId: string; replyId: string; sequence: number; pcm: Uint8Array; sampleRate: 24000 }): void;
  replyDone(event: { sessionId: string; replyId: string; status: 'completed' | 'interrupted' }): void;
  speechStarted(): void;
  toolCall(event: VoiceToolCall): Promise<unknown> | unknown;
  warning(code: string): void;
  closed(code: string): void;
}
export interface VoiceAgent {
  readonly sessionId: string | null; readonly ready: boolean;
  send(pcm: Uint8Array): boolean; requestReply(instructions: string): boolean; interrupt(): void; update(config: VoiceAgentConfiguration): boolean; close(): void;
}
type ObjectValue = Record<string, unknown>;
type Transport = { send(value: string): boolean; close(): void };
type PendingTool = { signature: string; replyId: string; result?: string; error: boolean; sent: boolean; cancelled: boolean; timer?: ReturnType<typeof setTimeout> };
function reportUnidentified(callbacks: VoiceAgentCallbacks, reason: UnidentifiedSessionReason) {
  try { void Promise.resolve(callbacks.unidentifiedSession?.({ reason })).catch(() => { /* Application owns durable reconciliation. */ }); } catch { /* Never expose callback exceptions. */ }
}
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value); }
function canonical(value: unknown, depth = 0): string {
  if (depth > 20) throw new Error('Invalid configuration');
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function normalizedTools(value: unknown): string {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid tools');
  return canonical(value.map(tool => {
    if (!object(tool) || tool.type !== 'function' || typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || !object(tool.parameters) || tool.parameters.type !== 'object') throw new Error('Invalid tools');
    return { type: tool.type, name: tool.name, description: tool.description ?? '', parameters: tool.parameters, execution_mode: tool.execution_mode ?? 'interactive', timeout_seconds: tool.timeout_seconds ?? 120 };
  }));
}
function configuration(config: VoiceAgentConfiguration): VoiceAgentConfiguration {
  if (typeof config.systemPrompt !== 'string' || !config.systemPrompt.trim() || config.systemPrompt.length > 24000 || normalizedTools(config.tools).length > 32000) throw new Error('Invalid voice agent configuration');
  return JSON.parse(JSON.stringify(config)) as VoiceAgentConfiguration;
}
function verifiedAudioAndModel(config: unknown): config is ObjectValue {
  if (!object(config)) return false;
  for (const side of [config.input, config.output]) {
    if (!object(side) || !object(side.format) || side.format.encoding !== 'audio/pcm' || side.format.sample_rate !== 24000) return false;
  }
  if (!Array.isArray(config.llm) || config.llm.length !== 1 || !object(config.llm[0])) return false;
  return config.llm[0].model === VOICE_AGENT_MODEL && config.llm[0].base_url === VOICE_AGENT_LLM_BASE && !config.greeting;
}

/** Exported to exercise the exact production state machine with synthetic events. */
export class VoiceAgentProtocol implements VoiceAgent {
  sessionId: string | null = null;
  ready = false;
  private stopped = false;
  private started = false;
  private closingBeforeIdentity = false;
  private expected: VoiceAgentConfiguration;
  private awaitingUpdate = false;
  private configurationTimer?: ReturnType<typeof setTimeout>;
  private activeReply: string | null = null;
  private pendingByte: number | null = null;
  private sequence = 0;
  private events = 0;
  private latestEvent = '';
  private lastDone: { replyId: string; status: string } | null = null;
  private userFinals = new Set<string>();
  private agentFinals = new Set<string>();
  private replies = new Set<string>();
  private finished = new Set<string>();
  private tools = new Map<string, PendingTool>();
  constructor(private transport: Transport, private callbacks: VoiceAgentCallbacks, config: VoiceAgentConfiguration) { this.expected = configuration(config); }
  start(agentId: string) {
    if (!id(agentId)) throw new Error('Invalid voice agent identifier');
    if (this.started || this.stopped) return;
    this.started = true;
    if (this.write({ type: 'session.update', session: { agent_id: agentId } })) this.armConfigurationTimeout();
  }
  private armConfigurationTimeout() {
    clearTimeout(this.configurationTimer ?? null);
    this.configurationTimer = setTimeout(() => this.fail('provider_configuration_timeout'), 10000);
  }
  private notify(run: () => unknown) {
    try { void Promise.resolve(run()).catch(() => this.fail('provider_callback_failed')); } catch { this.fail('provider_callback_failed'); }
  }
  private write(value: unknown): boolean {
    if (this.stopped) return false;
    try { if (this.transport.send(JSON.stringify(value))) return true; } catch { /* Never expose transport errors. */ }
    this.fail('provider_disconnected'); return false;
  }
  private halt() {
    this.stopped = true; this.ready = false; this.activeReply = null;
    clearTimeout(this.configurationTimer ?? null);
    for (const tool of this.tools.values()) { tool.cancelled = true; clearTimeout(tool.timer ?? null); }
    try { this.transport.close(); } catch { /* Already disconnected. */ }
  }
  fail(code: string) {
    if (this.stopped) return;
    if (this.started && !this.sessionId) reportUnidentified(this.callbacks, code === 'provider_configuration_timeout' ? 'connection_timeout' : code === 'provider_ended' ? 'session_ended_without_id' : 'connection_failed');
    // A failed configuration must also end the potentially billable session.
    try { this.transport.send(JSON.stringify({ type: 'session.end' })); } catch { /* Best effort. */ }
    this.halt();
    try { this.callbacks.closed(code); } catch { /* Consumer failure cannot expose upstream data. */ }
  }
  close() {
    if (this.stopped) return;
    if (!this.sessionId && this.started) {
      // The provider may already have created a recording. Keep only the
      // identity handshake alive until its original bounded deadline; never
      // configure the prompt, send mic audio, or expose agent events meanwhile.
      this.closingBeforeIdentity = true; this.ready = false; this.interrupt();
      return;
    }
    try { this.transport.send(JSON.stringify({ type: 'session.end' })); } catch { /* Best effort. */ }
    this.halt();
  }
  interrupt() {
    this.activeReply = null; this.pendingByte = null;
    for (const tool of this.tools.values()) if (!tool.sent) { tool.cancelled = true; clearTimeout(tool.timer ?? null); }
    this.latestEvent = 'local.interrupt';
    // No undocumented cancel event: the provider handles barge-in; ownership
    // changes call close(). This immediately gates any late output frames.
  }
  send(pcm: Uint8Array): boolean {
    if (!this.ready || this.stopped || !pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 4800) return false;
    let binary = ''; for (const byte of pcm) binary += String.fromCharCode(byte);
    return this.write({ type: 'input.audio', audio: btoa(binary) });
  }
  requestReply(instructions: string): boolean {
    if (!this.ready || this.stopped || typeof instructions !== 'string' || !instructions.trim() || instructions.length > 4000) return false;
    this.latestEvent = 'local.reply';
    return this.write({ type: 'reply.create', instructions });
  }
  update(config: VoiceAgentConfiguration): boolean {
    if (!this.sessionId || this.stopped || this.closingBeforeIdentity || this.awaitingUpdate) return false;
    try { this.expected = configuration(config); } catch { return false; }
    this.ready = false; this.awaitingUpdate = true; this.interrupt(); this.armConfigurationTimeout();
    return this.write({ type: 'session.update', session: { system_prompt: this.expected.systemPrompt, tools: this.expected.tools } });
  }
  receive(raw: unknown) {
    if (this.stopped) return;
    if (typeof raw !== 'string' || raw.length > 128000 || ++this.events > 60000) { this.fail('provider_event_limit'); return; }
    let event: ObjectValue;
    try { const decoded: unknown = JSON.parse(raw); if (!object(decoded) || typeof decoded.type !== 'string') throw new Error(); event = decoded; }
    catch { this.fail('provider_invalid_event'); return; }
    this.latestEvent = event.type as string;
    try { this.consume(event); } catch { this.fail('provider_invalid_event'); }
  }
  private consume(event: ObjectValue) {
    if (event.type === 'session.error') { this.fail('provider_error'); return; }
    if (event.type === 'session.ended') { this.fail('provider_ended'); return; }
    if (event.type === 'session.ready') {
      if (this.sessionId || !id(event.session_id)) { this.fail('provider_configuration_mismatch'); return; }
      this.sessionId = event.session_id;
      this.notify(() => this.callbacks.sessionCreated?.({ sessionId: this.sessionId! }));
      if (this.closingBeforeIdentity) { this.close(); return; }
      if (this.stopped) return;
      if (!verifiedAudioAndModel(event.config)) { this.fail('provider_configuration_mismatch'); return; }
      this.update(this.expected); return;
    }
    if (this.closingBeforeIdentity) return;
    if (event.type === 'session.updated') {
      if (!this.awaitingUpdate || !this.sessionId || !verifiedAudioAndModel(event.config)) { this.fail('provider_configuration_mismatch'); return; }
      if (event.config.system_prompt !== this.expected.systemPrompt || normalizedTools(event.config.tools) !== normalizedTools(this.expected.tools)) { this.fail('provider_configuration_mismatch'); return; }
      this.awaitingUpdate = false; this.ready = true; clearTimeout(this.configurationTimer ?? null);
      this.notify(() => this.callbacks.ready({ sessionId: this.sessionId! })); return;
    }
    if (!this.ready || !this.sessionId) return;
    const sessionId = this.sessionId;
    if (event.type === 'input.speech.started') { this.interrupt(); this.notify(() => this.callbacks.speechStarted()); return; }
    if (event.type === 'transcript.user' || event.type === 'transcript.user.delta') {
      if (!id(event.item_id) || typeof event.text !== 'string' || event.text.length > 12000) throw new Error();
      if (this.userFinals.has(event.item_id)) return;
      const final = event.type === 'transcript.user';
      if (final) { if (this.userFinals.size >= 2048) throw new Error(); this.userFinals.add(event.item_id); }
      this.notify(() => this.callbacks.userTranscript({ id: `${sessionId}:${event.item_id}`, sessionId, itemId: event.item_id as string, text: event.text as string, final, at: Date.now() })); return;
    }
    if (event.type === 'reply.started') {
      if (!id(event.reply_id)) throw new Error();
      if (this.replies.has(event.reply_id)) return;
      if (this.replies.size >= 2048) throw new Error();
      this.replies.add(event.reply_id);
      for (const tool of this.tools.values()) if (tool.replyId !== event.reply_id && !tool.sent) { tool.cancelled = true; clearTimeout(tool.timer ?? null); }
      this.activeReply = event.reply_id.startsWith('fc-') ? null : event.reply_id;
      this.pendingByte = null;
      if (this.activeReply) this.notify(() => this.callbacks.replyStarted({ sessionId, replyId: event.reply_id as string }));
    } else if (event.type === 'reply.audio') {
      if (!this.activeReply || (event.reply_id !== undefined && event.reply_id !== this.activeReply)) return;
      if (typeof event.data !== 'string' || !event.data.length || event.data.length > 64000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data)) throw new Error();
      const binary = atob(event.data); if (!binary.length || binary.length > 48000) throw new Error();
      const bytes = new Uint8Array(binary.length + (this.pendingByte === null ? 0 : 1));
      let offset = 0; if (this.pendingByte !== null) bytes[offset++] = this.pendingByte;
      for (const char of binary) bytes[offset++] = char.charCodeAt(0);
      this.pendingByte = bytes.length % 2 ? bytes[bytes.length - 1] : null;
      const pcm = bytes.subarray(0, bytes.length - bytes.length % 2);
      if (!pcm.length) return;
      this.notify(() => this.callbacks.audio({ sessionId, replyId: this.activeReply!, sequence: this.sequence++, pcm, sampleRate: 24000 }));
    } else if (event.type === 'transcript.agent') {
      if (!id(event.reply_id) || !id(event.item_id) || typeof event.text !== 'string' || event.text.length > 12000 || typeof event.interrupted !== 'boolean') throw new Error();
      if (event.reply_id.startsWith('fc-') || this.agentFinals.has(event.reply_id)) return;
      if (this.agentFinals.size >= 2048) throw new Error(); this.agentFinals.add(event.reply_id);
      this.notify(() => this.callbacks.agentTranscript({ sessionId, itemId: event.item_id as string, replyId: event.reply_id as string, text: event.text as string, interrupted: event.interrupted as boolean, at: Date.now() }));
    } else if (event.type === 'reply.done') {
      if (!id(event.reply_id) || (event.status !== 'completed' && event.status !== 'interrupted')) throw new Error();
      this.lastDone = { replyId: event.reply_id, status: event.status };
      if (this.activeReply === event.reply_id) {
        if (event.status === 'completed' && this.pendingByte !== null) { this.fail('provider_audio_incomplete'); return; }
        this.activeReply = null; this.pendingByte = null;
      }
      if (event.status === 'interrupted') for (const tool of this.tools.values()) if (tool.replyId === event.reply_id) { tool.cancelled = true; clearTimeout(tool.timer ?? null); }
      if (!this.finished.has(event.reply_id)) {
        if (this.finished.size >= 2048) throw new Error(); this.finished.add(event.reply_id);
        this.notify(() => this.callbacks.replyDone({ sessionId, replyId: event.reply_id as string, status: event.status as 'completed' | 'interrupted' }));
      }
      this.flushTools();
    } else if (event.type === 'tool.call') this.callTool(event);
  }
  private callTool(event: ObjectValue) {
    if (!id(event.call_id) || typeof event.name !== 'string' || !object(event.arguments) || canonical(event.arguments).length > 16000) throw new Error();
    const signature = canonical({ name: event.name, arguments: event.arguments });
    const previous = this.tools.get(event.call_id);
    if (previous) { if (previous.signature !== signature) this.fail('provider_tool_id_reused'); return; }
    if (this.tools.size >= 128 || [...this.tools.values()].filter(tool => !tool.sent && !tool.cancelled).length >= 8) { this.fail('provider_tool_limit'); return; }
    const pending: PendingTool = { signature, replyId: `fc-${event.call_id}`, error: false, sent: false, cancelled: false };
    this.tools.set(event.call_id, pending);
    const complete = (value: unknown, failed: boolean) => {
      if (pending.cancelled || pending.result !== undefined || this.stopped) return;
      clearTimeout(pending.timer ?? null);
      try { const text = JSON.stringify(value); if (!text || text.length > 16000) throw new Error(); pending.result = text; pending.error = failed; }
      catch { pending.result = '{"error":"Tool result unavailable"}'; pending.error = true; }
      this.flushTools();
    };
    pending.timer = setTimeout(() => complete({ error: 'Tool timed out' }, true), 20000);
    if (!this.expected.tools.some(tool => tool.name === event.name)) { complete({ error: 'Unknown tool' }, true); return; }
    // Do not await: reply.done must remain processable while durable work runs.
    try { void Promise.resolve(this.callbacks.toolCall({ sessionId: this.sessionId!, replyId: pending.replyId, callId: event.call_id, name: event.name, arguments: event.arguments })).then(value => complete(value, false), () => complete({ error: 'Tool unavailable' }, true)); }
    catch { complete({ error: 'Tool unavailable' }, true); }
  }
  private flushTools() {
    if (this.stopped || this.latestEvent !== 'reply.done' || this.lastDone?.status !== 'completed') return;
    for (const [callId, tool] of this.tools) {
      if (tool.replyId !== this.lastDone.replyId || tool.cancelled || tool.sent || tool.result === undefined) continue;
      tool.sent = true;
      this.write({ type: 'tool.result', call_id: callId, result: tool.result, is_error: tool.error });
    }
  }
}

export async function connectVoiceAgent(options: VoiceAgentOptions, callbacks: VoiceAgentCallbacks): Promise<VoiceAgent> {
  configuration(options);
  if (!options.apiKey || !id(options.agentId)) throw new Error('Voice agent configuration unavailable');
  let response: Response;
  const signal = AbortSignal.timeout(10000);
  try { response = await fetch('https://agents.assemblyai.com/v1/ws', { headers: { Upgrade: 'websocket', Authorization: `Bearer ${options.apiKey}` }, signal }); }
  catch { reportUnidentified(callbacks, signal.aborted ? 'connection_timeout' : 'connection_failed'); throw new Error('Voice agent connection unavailable'); }
  if (response.status !== 101 || !response.webSocket) {
    try { await response.body?.cancel(); } catch { /* Do not leak provider errors. */ }
    // Do not infer a session ID or choose an unrelated session for deletion.
    reportUnidentified(callbacks, 'connection_failed');
    throw new Error('Voice agent connection rejected');
  }
  const socket = response.webSocket;
  const protocol = new VoiceAgentProtocol({ send: value => { if (socket.readyState !== WebSocket.OPEN) return false; socket.send(value); return true; }, close: () => socket.close(1000, 'Session ended') }, callbacks, options);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', event => protocol.receive(event.data));
  socket.addEventListener('error', () => protocol.fail('provider_error'));
  socket.addEventListener('close', () => protocol.fail('provider_disconnected'));
  socket.accept(); protocol.start(options.agentId);
  return protocol;
}

/** Provider logical deletion: removes session listing/access to artifacts, not a
 * claim about physical backup erasure. Durable retries belong to CallSession. */
export async function deleteVoiceAgentSession(apiKey: string, sessionId: string): Promise<void> {
  if (!apiKey || !id(sessionId)) throw new Error('Voice agent deletion configuration invalid');
  let response: Response;
  try { response = await fetch(`https://agents.assemblyai.com/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error('Voice agent deletion unavailable'); }
  try { await response.body?.cancel(); } catch { /* Upstream body may contain sensitive data. */ }
  if (response.status !== 204 && response.status !== 404) throw new Error('Voice agent deletion not confirmed');
}
