"use client";

import Link from "next/link";
import { RECORDING_DISCLOSURE, RECORDING_DISCLOSURE_VERSION, type CallSnapshot, type FieldId, type WaitingReason } from "@nursebridge/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCallAudio } from "./call-audio";
import { ApiError } from "./workspace-api";
import { Icon } from "./icons";
import { api, AuthGate, Badge, errorMessage, mutate, Notice, PageHeader, useWorkspace } from "./workspace";

const REPLAY_LINES = ["I am calling about a headache that started yesterday afternoon. It is mostly behind my eyes. I would describe it as a six out of ten.", "I need to correct that: the headache started this morning, not yesterday. No other symptoms.", "I have not checked my temperature. I took Tylenol, but I am not sure what dose.", "I still do not know."];
const FIELD_LABELS: Record<FieldId, string> = { reason: "reason for calling", onset: "when it started", location: "location", severity: "severity", symptoms: "other symptoms", medications: "medication details", uncertainties: "unmeasured or uncertain details", callback: "fictional callback number" };
const WAITING_COPY: Record<WaitingReason, string> = {
  intake_complete: "The automated intake is complete. Your place is preserved while you wait for a nurse.",
  unresolved_answer: "One answer remained unresolved after a clarification. A nurse can continue from the transcript.",
  human_request: "You requested a person. Your place is preserved while you wait for a nurse.",
  technical_failure: "The automated intake stopped because of a technical problem. Your place is preserved for a nurse.",
  caller_reported_emergency: "The automated intake stopped after emergency-related words were reported. This demo does not contact emergency services.",
  consent_refused: "Automated intake was declined. Your place is preserved while you wait for a nurse.",
};
function remaining(deadline: number, now: number) { const seconds = Math.max(0, Math.ceil((deadline - now) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
export function CallerPage() { return <AuthGate><CallerExperience /></AuthGate>; }
function CallerExperience() {
  const { mode, session } = useWorkspace();
  const [call, setCall] = useState<CallSnapshot | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replayText, setReplayText] = useState(REPLAY_LINES[0]);
  const [replayIndex, setReplayIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [deletedCallId, setDeletedCallId] = useState<string | null>(null);
  const deletedCalls = useRef(new Set<string>());
  const [now, setNow] = useState(() => Date.now());
  const acceptSnapshot = useCallback((snapshot: CallSnapshot) => {
    if (deletedCalls.current.has(snapshot.id)) return;
    setCall((previous) => previous && previous.id === snapshot.id && previous.revision > snapshot.revision ? previous : snapshot);
  }, []);
  const acceptDeletion = useCallback((id: string) => {
    deletedCalls.current.add(id);
    setDeletedCallId(id); setCall(null); setError(null); setRestoreError(null); setLoaded(true);
  }, []);
  const audio = useCallAudio("caller", acceptSnapshot, acceptDeletion);
  useEffect(() => {
    let active = true;
    setLoaded(false); setRestoreError(null);
    void (async () => {
      let candidateId: string | undefined;
      try {
        const { calls } = await api<{ calls: CallSnapshot[] }>("/api/calls");
        const requestedId = new URLSearchParams(window.location.search).get("call");
        const candidate = calls.find((item) => item.id === requestedId && item.callerParticipantId === session?.participantId) || calls.find((item) => item.callerParticipantId === session?.participantId && item.queueState !== "CLOSED");
        candidateId = candidate?.id || requestedId || undefined;
        if (candidateId) {
          const { snapshot } = await api<{ snapshot: CallSnapshot }>(`/api/calls/${candidateId}`);
          if (snapshot.callerParticipantId !== session?.participantId) throw new Error("This call is not available to this caller.");
          if (active) acceptSnapshot(snapshot);
        }
        if (active) setLoaded(true);
      } catch (reason) {
        if (!active) return;
        if (candidateId && reason instanceof ApiError && reason.status === 410) acceptDeletion(candidateId);
        else setRestoreError(errorMessage(reason));
      }
    })();
    return () => { active = false; };
  }, [session?.participantId, restoreAttempt, acceptSnapshot, acceptDeletion]);
  useEffect(() => {
    if (deletedCallId || call?.queueState === "CLOSED") { audio.disconnect(); setError(null); return; }
    if (call) void audio.connect(call.id).catch(() => undefined);
  }, [call?.id, call?.queueState, deletedCallId, audio.connect, audio.disconnect]);
  useEffect(() => {
    if (!call || call.queueState === "CLOSED") return;
    let active = true;
    const interval = window.setInterval(() => {
      void api<{ snapshot: CallSnapshot }>(`/api/calls/${call.id}`).then(({ snapshot }) => { if (active) acceptSnapshot(snapshot); }).catch((reason) => {
        if (active && reason instanceof ApiError && reason.status === 410) { acceptDeletion(call.id); audio.disconnect(); }
      });
    }, 2500);
    return () => { active = false; clearInterval(interval); };
  }, [call?.id, call?.queueState, acceptSnapshot, acceptDeletion, audio.disconnect]);
  useEffect(() => { if (!call || call.queueState === "CLOSED") return; const interval = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(interval); }, [call?.id, call?.queueState]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(null); try { await action(); } catch (reason) { if (call && reason instanceof ApiError && reason.status === 410) { acceptDeletion(call.id); audio.disconnect(); } else setError(errorMessage(reason)); } finally { setBusy(false); } };
  const command = async (type: string, body: Record<string, unknown> = {}) => { if (!call || call.queueState === "CLOSED" || deletedCalls.current.has(call.id)) return; const response = await mutate<{ snapshot: CallSnapshot }>(`/api/calls/${call.id}/${type}`, body); acceptSnapshot(response.snapshot); };
  const join = () => run(async () => { if (!loaded || restoreError || call || deletedCallId) return; const response = await mutate<{ call: CallSnapshot }>("/api/calls"); acceptSnapshot(response.call); setConsent(false); });
  const startAnother = () => {
    const url = new URL(window.location.href); url.searchParams.delete("call"); window.history.replaceState(null, "", url);
    setCall(null); setDeletedCallId(null); setConsent(false); setError(null); setLoaded(false);
    setRestoreAttempt((attempt) => attempt + 1); setReplayIndex(0); setReplayText(REPLAY_LINES[0]);
  };
  const start = () => run(async () => { await audio.enableMedia(); await command("consent", mode === "live" ? { accepted: true, recordingAccepted: true, recordingDisclosureVersion: RECORDING_DISCLOSURE_VERSION } : { accepted: true }); });
  const decline = () => run(async () => { await command("consent", { accepted: false }); });
  const replay = () => run(async () => { if (!call || !replayText.trim()) return; if (!call.consent) await command("consent", { accepted: true }); await command("mock-turn", { text: replayText }); const next = Math.min(replayIndex + 1, REPLAY_LINES.length - 1); setReplayIndex(next); setReplayText(REPLAY_LINES[next]); });
  const ended = Boolean(deletedCallId || call?.queueState === "CLOSED");
  const human = call?.conversationOwner === "NURSE" && call.queueState === "CONNECTED";
  const pending = call?.conversationOwner === "HANDOFF_PENDING";
  const caption = audio.caption || call?.turns.at(-1)?.text;
  const questionText = call?.template.questions.find((question) => question.id === call.currentQuestion)?.text || (call?.currentQuestion === "reason" ? call.template.opening : undefined);
  const assistantText = call?.assistantTurns.at(-1)?.text || questionText;
  const unresolved = call ? (Object.entries(call.collection) as [FieldId, CallSnapshot["collection"][FieldId]][]).filter(([, progress]) => progress.status === "unresolved" || progress.status === "awaiting_clarification").map(([field]) => FIELD_LABELS[field]) : [];
  const waiting = Boolean(call?.waitingReason || call?.intakeState === "CAPTURED" && call.conversationOwner === "NONE");
  const stage = deletedCallId ? "CALL DELETED" : ended ? "CALL ENDED" : human ? "CONNECTED TO A PERSON" : pending ? "CONNECTING YOUR NURSE" : !call ? "READY WHEN YOU ARE" : waiting ? "WAITING FOR A NURSE" : call.intakeState === "DECLINED" ? "HUMAN REQUEST SENT" : !call.consent ? "IN THE DEMONSTRATION QUEUE" : call.aiStatus === "unavailable" ? "AUTOMATED INTAKE UNAVAILABLE" : call.humanRequested ? "HUMAN REQUEST SENT" : call.aiStatus === "stopped" || call.conversationOwner === "NONE" ? "AUTOMATED INTAKE PAUSED" : call.aiStatus === "speaking" ? "AUTOMATED ASSISTANT SPEAKING" : call.aiStatus === "thinking" ? "CAPTURING YOUR WORDS" : call.aiStatus === "listening" ? "LISTENING" : "AUTOMATED INTAKE PAUSED";
  return <div className="page caller-page"><PageHeader eyebrow="CALLER EXPERIENCE" title="Tell your story." description="Share the context. A nurse can join at any point." action={<Link href="/demo" className="text-link">Demo guide <Icon name="arrow" size={14} /></Link>} />
    <div className="caller-layout"><section className="panel caller-main" aria-label="Browser call"><div className="caller-heading"><div className={`caller-orb ${call && !ended ? "active" : ""}`}><Icon name={human ? "person" : "mic"} size={31} /></div><div className="call-stage" role="status" aria-live="polite"><span className="status-dot" />{stage}</div><h2>{deletedCallId ? "Your demonstration call was deleted." : ended ? "Your demonstration call has ended." : human ? "You’re connected." : "Your words. A clearer handoff."}</h2><p>{human ? "Two-way browser audio is active. Automated providers are stopped." : "I’m an automated intake assistant, not a nurse."}</p>{call && !ended && <div className="audio-state"><span><Icon name="phone" size={12} />{audio.state.connection}</span><span><Icon name="mic" size={12} />Microphone: {audio.state.microphone}</span><span><Icon name="volume" size={12} />Output: {audio.state.playback}</span></div>}</div>
      {!call && !deletedCallId && <div className="consent-section"><h3>First, join the queue.</h3><p>Your place is created before the assistant starts. You can skip automated intake and request a person instead.</p><div className="section-divider" /><button className="button primary wide" disabled={busy || !loaded || Boolean(restoreError)} onClick={() => void join()}>{busy ? "Joining…" : "Join demonstration queue"}<Icon name="arrow" size={17} /></button><p className="caller-note">This is a browser call using your microphone. The demonstration does not answer telephone calls.</p></div>}
      {restoreError && <Notice kind="error">We couldn’t restore your existing call. {restoreError} <button className="text-link" onClick={() => setRestoreAttempt((attempt) => attempt + 1)}>Retry restoring call</button></Notice>}
      {call && !ended && !waiting && !call.consent && call.intakeState !== "DECLINED" && <div className="consent-section"><h3>You’re in the queue.</h3><p>With your permission, the automated assistant prepares a draft for nurse review. It does not diagnose, give treatment advice, or assess whether waiting is safe.</p><label className="consent-label"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>{mode === "live" ? RECORDING_DISCLOSURE : <>I consent to processing the supplied <strong>fictional transcript</strong> in mock mode. AssemblyAI recording is not used.</>}</span></label><div className="consent-actions"><button className="button primary" disabled={!consent || busy || audio.state.connection !== "connected"} onClick={() => void start()}><Icon name="mic" size={17} />Enable microphone & start intake</button><button className="button" disabled={busy} onClick={() => void decline()}>Skip automated intake · request a person</button></div>{mode === "live" && <p className="fine-print">Consent disclosure: {RECORDING_DISCLOSURE_VERSION}. The call remains limited to fictional information and the overall ten-minute demonstration window.</p>}</div>}
      {call && !ended && (call.consent || call.intakeState === "DECLINED" || waiting || human || pending) && <><div className="caller-caption-box"><div className="row between"><div className="eyebrow">{human ? "HUMAN CONVERSATION" : waiting ? "WAITING FOR A NURSE" : "LIVE CAPTIONS"}</div>{audio.caption && <Badge tone="amber">Provisional</Badge>}</div>{human ? <p className="caption-text">Speak directly with the nurse. The automated voice agent is no longer receiving audio.</p> : waiting ? <><p className="caption-text">{call.waitingReason ? WAITING_COPY[call.waitingReason] : "The automated intake is complete. Your place is preserved while you wait for a nurse."}</p>{unresolved.length > 0 && <p className="caption-provisional">Nurse follow-up remains for: {unresolved.join(", ")}.</p>}</> : <><p className="caption-text">{call.intakeState === "DECLINED" ? "Automated intake is off. Your request for a person is visible in the queue." : caption || assistantText || "Please tell me what you are calling about."}</p>{audio.caption && <p className="caption-provisional">Words may change until the turn is finalized.</p>}{assistantText && caption && <p className="fine-print">Assistant: {assistantText}</p>}</>}</div>
      <div className="workspace-status" style={{ marginTop: 14 }}><span>Overall demo time remaining</span><strong className="right">{remaining(call.callDeadlineAt, now)}</strong></div>
      <div className="call-controls"><button className={`call-control ${audio.state.muted ? "active" : ""}`} aria-pressed={audio.state.muted} disabled={audio.state.microphone !== "ready"} onClick={() => audio.mute(!audio.state.muted)}><span><Icon name={audio.state.muted ? "mute" : "mic"} /></span><span>{audio.state.muted ? "Unmute" : "Mute"}</span></button><button className="call-control" disabled={busy || human} onClick={() => void run(() => command("request-human"))}><span><Icon name="person" /></span><span>Request a person</span></button><button className="call-control danger" disabled={busy} onClick={() => void run(async () => { await command("end"); audio.disconnect(); })}><span><Icon name="phone" /></span><span>End call</span></button></div>
      {(audio.state.microphone !== "ready" || audio.state.playback !== "ready") && <button className="button wide" style={{ marginTop: 18 }} disabled={busy} onClick={() => void run(audio.enableMedia)}><Icon name="mic" size={17} />{audio.state.microphone === "ready" ? "Resume audio" : "Enable microphone & output for handoff"}</button>}
      {call.intakeState === "CAPTURED" && <Notice>Intake captured — waiting for a nurse. The automated provider session has ended.</Notice>}{call.humanRequested && !human && <Notice kind="warning">A person has been requested. The demonstration does not assess clinical urgency or confirm that waiting is safe.</Notice>}
      <p className="caller-note">{human ? "The AI is no longer listening. You control when this call ends." : "A nurse can interrupt the automated intake at any time. Captions and the draft are patient-reported information."}</p></>}
      {call && !ended && !waiting && !call.consent && call.intakeState !== "DECLINED" && <button className="button ghost wide" style={{ marginTop: 15 }} disabled={busy} onClick={() => void run(async () => { await command("end"); audio.disconnect(); })}>Leave queue & end call</button>}
      {ended && <div className="consent-section"><Notice>{deletedCallId ? "This fictional case was deleted and is no longer in the queue." : "The call is closed operationally. This is not a clinical disposition or assessment."}</Notice><button className="button wide" onClick={startAnother}>Start another fictional call</button></div>}
      {!ended && (error || audio.socketError || audio.state.error) && <Notice kind="error">{error || audio.socketError || audio.state.error} {call && "Your place in the queue is preserved."} {call && <button className="text-link" onClick={() => void run(async () => { await audio.connect(call.id); })}>Reconnect audio</button>}</Notice>}
      {!ended && call?.warnings.map((warning) => <Notice key={warning} kind="warning">{warning}</Notice>)}
    </section><aside className="panel caller-aside"><h3>A little preparation helps.</h3><p>Use a headset and a quiet space for the clearest two-way browser audio.</p><ol className="step-list"><li className="current"><span className="step-number">1</span><div><strong>Keep it fictional</strong>Use the scenario in the demo guide. Please do not share real patient details.</div></li><li className={call?.consent ? "current" : ""}><span className="step-number">2</span><div><strong>Tell your story</strong>The assistant asks one question at a time. “I don’t know” is a useful answer.</div></li><li className={human ? "current" : ""}><span className="step-number">3</span><div><strong>Connect with a person</strong>A nurse sees the draft and its source words before joining.</div></li></ol><div className="privacy-note"><Icon name="file" size={15} /><span>{mode === "live" ? "Live automated intake requires consent to AssemblyAI processing and possible recording." : "Mock replay does not use AssemblyAI recording."} Nothing here determines that waiting is safe.</span></div></aside></div>
    {mode === "mock" && call && !ended && <section className="panel" style={{ marginTop: 20 }}><div className="panel-heading"><h2>Fictional transcript replay</h2><Badge tone="amber">MOCK FIXTURE</Badge></div><div className="panel-content"><p className="fine-print" style={{ marginBottom: 13 }}>These supplied words exercise the draft and corrections. They are not AssemblyAI microphone transcription. You can still test real browser-to-browser audio takeover.</p><label className="field-label" htmlFor="replay-text">Fictional caller turn</label><textarea className="text-input" id="replay-text" value={replayText} onChange={(event) => setReplayText(event.target.value)} /><div className="row between" style={{ marginTop: 13 }}><span className="fine-print">{replayIndex === 2 ? "Includes an explicit correction" : "Includes reported uncertainty"}</span><button className="button primary small" disabled={busy || !replayText.trim() || (!call.consent && !consent) || human || Boolean(call.waitingReason) || (call.consent && call.conversationOwner === "NONE")} onClick={() => void replay()}>Replay fictional turn <Icon name="play" size={14} /></button></div></div></section>}
  </div>;
}
