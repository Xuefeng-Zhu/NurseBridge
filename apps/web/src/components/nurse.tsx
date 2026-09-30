"use client";

import type { CallSnapshot, EscalationReason, FactStatus, FieldId, IntakeFact, WaitingReason } from "@nursebridge/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCallAudio } from "./call-audio";
import { ApiError } from "./workspace-api";
import { startPolling } from "./serialized-polling";
import { recoverTakeover } from "./takeover-recovery";
import { Icon } from "./icons";
import { WorkspaceInvitations } from "./workspace-invitations";
import { arrivalAge, firstQueueCall, matchesQueueFilter, QUEUE_FILTERS, queueCounts, queueStateLabel, sessionRemaining, type QueueFilter } from "./nurse-queue";
import { api, AuthGate, Badge, clockTime, errorMessage, mutate, Notice, PageHeader, timeAgo, useWorkspace } from "./workspace";

const FIELDS: { id: FieldId; label: string }[] = [{ id: "reason", label: "Reason for calling" }, { id: "onset", label: "Onset & duration" }, { id: "location", label: "Location in caller’s words" }, { id: "severity", label: "Caller-described severity" }, { id: "symptoms", label: "Reported symptoms" }, { id: "medications", label: "Reported medications" }, { id: "uncertainties", label: "Uncertainties" }, { id: "callback", label: "Callback number" }];
const CONTEXT_TABS = [["transcript", "Transcript"], ["evidence", "Revisions"], ["timeline", "Timeline"]] as const;
const STATUSES: Record<FactStatus, string> = { not_asked: "Not asked", unknown: "Patient did not know", not_measured: "Not measured", denied: "Explicitly denied", reported: "Patient reported", uncertain: "Uncertain" };
const WAITING_LABELS: Record<WaitingReason, string> = { intake_complete: "Intake complete", unresolved_answer: "Unresolved answer", human_request: "Person requested", technical_failure: "Technical failure", caller_reported_emergency: "Emergency words reported", consent_refused: "Automated intake declined" };
const ESCALATION_TITLES: Record<EscalationReason, string> = { human_request: "A person has been requested", technical_failure: "Technical failure requires staff attention", unresolved_answer: "An answer remains unresolved", caller_reported_emergency: "Emergency-related words require staff attention", consent_refused: "Automated intake was declined" };
const COLLECTION_LABELS: Record<CallSnapshot["collection"][FieldId]["status"], string> = { unasked: "Not asked · no information captured", answered: "Answered · transcript available", awaiting_clarification: "Awaiting one clarification", unresolved: "Unresolved after one clarification · nurse follow-up needed" };
function caseLabel(call: Pick<CallSnapshot, "id" | "channel">) { return `${call.channel === "phone" ? "Phone caller" : "Caller"} ${call.id.slice(-4).toUpperCase()}`; }
function intakeLabel(call: CallSnapshot) { return ({ NOT_STARTED: "Not started", CONSENTED: "Consented", IN_PROGRESS: "Intake in progress", CAPTURED: "Intake captured", DECLINED: "Transcription declined", INTERRUPTED: "Intake interrupted" })[call.intakeState]; }
function arrivalDate(at: number) { return new Date(at).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
export function NursePage() { return <AuthGate callerAllowed={false}><NurseWorkspace /></AuthGate>; }
function NurseWorkspace() {
  const { session, mode } = useWorkspace();
  const [calls, setCalls] = useState<CallSnapshot[]>([]);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all");
  const [invitationsOpen, setInvitationsOpen] = useState(false);
  const invitationPanel = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<CallSnapshot | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [activeAudioCallId, setActiveAudioCallId] = useState<string | null>(null);
  const activeAudioCallIdRef = useRef<string | null>(null);
  const takeoverAttempt = useRef(0);
  const participantIdRef = useRef(session?.participantId);
  participantIdRef.current = session?.participantId;
  const [activeCall, setActiveCall] = useState<CallSnapshot | null>(null);
  const deletedCallIds = useRef(new Set<string>());
  const releasedCallIds = useRef(new Set<string>());
  const contextTabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [loading, setLoading] = useState(true);
  const [queueRefreshing, setQueueRefreshing] = useState(false);
  const queuePoll = useRef<ReturnType<typeof startPolling> | null>(null);
  const detailPolls = useRef(new Map<string, ReturnType<typeof startPolling>>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [evidenceTab, setEvidenceTab] = useState<"transcript" | "evidence" | "timeline">("transcript");
  const [mobilePanel, setMobilePanel] = useState<"queue" | "draft" | "context">("queue");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [editing, setEditing] = useState<IntakeFact | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [lastQueueUpdated, setLastQueueUpdated] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const selectCall = useCallback((id: string | null) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    setSelected((previous) => previous?.id === id ? previous : null);
    setEditing(null); setDeleteConfirm(false); setHighlight(null);
  }, []);
  const lockAudio = useCallback((snapshot: CallSnapshot) => {
    releasedCallIds.current.delete(snapshot.id);
    activeAudioCallIdRef.current = snapshot.id;
    setActiveAudioCallId(snapshot.id);
    setActiveCall(snapshot);
  }, []);
  const acceptSnapshot = useCallback((snapshot: CallSnapshot) => {
    if (deletedCallIds.current.has(snapshot.id)) return;
    if (snapshot.id === selectedIdRef.current) setSelected((previous) => previous?.id === snapshot.id && previous.revision > snapshot.revision ? previous : snapshot);
    if (snapshot.id === activeAudioCallIdRef.current) setActiveCall((previous) => previous?.id === snapshot.id && previous.revision > snapshot.revision ? previous : snapshot);
    else if (!activeAudioCallIdRef.current && !releasedCallIds.current.has(snapshot.id) && snapshot.queueState !== "CLOSED" && snapshot.claim?.participantId === session?.participantId) lockAudio(snapshot);
    setCalls((previous) => previous.map((call) => call.id === snapshot.id && call.revision <= snapshot.revision ? snapshot : call));
  }, [lockAudio, session?.participantId]);
  const forgetCall = useCallback((id: string) => {
    deletedCallIds.current.add(id);
    setCalls((previous) => previous.filter((call) => call.id !== id));
    if (selectedIdRef.current === id) selectCall(null);
    if (activeAudioCallIdRef.current === id) {
      takeoverAttempt.current++;
      activeAudioCallIdRef.current = null; setActiveAudioCallId(null); setActiveCall(null);
      setNotice("The active case is no longer available. Its audio connection has ended.");
    }
  }, [selectCall]);
  const audio = useCallAudio("nurse", acceptSnapshot, forgetCall);
  const releaseAudio = useCallback((id = activeAudioCallIdRef.current) => {
    if (!id || activeAudioCallIdRef.current !== id) return;
    takeoverAttempt.current++;
    releasedCallIds.current.add(id);
    activeAudioCallIdRef.current = null; setActiveAudioCallId(null); setActiveCall(null);
    audio.disconnect();
  }, [audio.disconnect]);
  const acceptQueue = useCallback((result: { calls: CallSnapshot[] }) => {
    const available = result.calls.filter((call) => !deletedCallIds.current.has(call.id));
    setCalls((previous) => {
      const currentCalls = new Map(previous.map((call) => [call.id, call]));
      return available.map((call) => { const current = currentCalls.get(call.id); return current && current.revision > call.revision ? current : call; }).sort((a, b) => a.createdAt - b.createdAt);
    });
    setQueueError(null);
    setLastQueueUpdated(Date.now());
  }, []);
  useEffect(() => {
    // Filtering never replaces an existing case or discards an in-progress edit.
    if (!selectedIdRef.current || !calls.some((call) => call.id === selectedIdRef.current)) {
      const next = firstQueueCall(calls, queueFilter)?.id ?? null;
      if (next !== selectedIdRef.current) selectCall(next);
    }
    // Restore assignments from revision-merged data, not an older queue projection.
    const owned = calls.find((call) => !releasedCallIds.current.has(call.id) && call.queueState !== "CLOSED" && call.claim?.participantId === session?.participantId);
    if (!activeAudioCallIdRef.current && owned) acceptSnapshot(owned);
  }, [calls, queueFilter, selectedId, selectCall, acceptSnapshot, session?.participantId]);
  useEffect(() => {
    const poll = startPolling({
      intervalMs: 2000,
      read: (signal) => api<{ calls: CallSnapshot[] }>("/api/calls", { signal }),
      onSuccess: acceptQueue,
      onError: (reason) => setQueueError(errorMessage(reason)),
      onPending: (pending) => { setQueueRefreshing(pending); if (!pending) setLoading(false); },
    });
    queuePoll.current = poll;
    return () => { poll.stop(); queuePoll.current = null; };
  }, [acceptQueue]);
  useEffect(() => {
    const ids = [...new Set([selectedId, activeAudioCallId].filter((id): id is string => Boolean(id)))];
    const polls = new Map(ids.map((id) => {
      const isRelevant = () => selectedIdRef.current === id || activeAudioCallIdRef.current === id;
      const poll = startPolling({
        intervalMs: 2500,
        read: (signal) => api<{ snapshot: CallSnapshot }>(`/api/calls/${id}`, { signal }),
        onSuccess: ({ snapshot }) => {
          if (!isRelevant()) return;
          acceptSnapshot(snapshot);
          setDetailErrors((previous) => { const next = { ...previous }; delete next[id]; return next; });
        },
        onError: (reason) => {
          if (!isRelevant()) return;
          if (reason instanceof ApiError && [404, 410].includes(reason.status)) {
            if (activeAudioCallIdRef.current === id || !activeAudioCallIdRef.current && selectedIdRef.current === id) audio.disconnect();
            forgetCall(id);
          } else setDetailErrors((previous) => ({ ...previous, [id]: errorMessage(reason) }));
        },
      });
      return [id, poll] as const;
    }));
    detailPolls.current = polls;
    return () => { for (const poll of polls.values()) poll.stop(); detailPolls.current = new Map(); };
  }, [selectedId, activeAudioCallId, acceptSnapshot, audio.disconnect, forgetCall]);
  useEffect(() => { const interval = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(interval); }, []);
  useEffect(() => () => { takeoverAttempt.current++; }, []);
  useEffect(() => {
    if (activeAudioCallId) {
      if (activeCall?.queueState === "CLOSED") { releaseAudio(); return; }
      void audio.connect(activeAudioCallId).catch(() => undefined);
      return;
    }
    if (selected?.id !== selectedId || !selected) return;
    if (selected.queueState === "CLOSED") { audio.disconnect(); return; }
    void audio.connect(selected.id).catch(() => undefined);
  }, [activeAudioCallId, activeCall?.queueState, selectedId, selected?.id, selected?.queueState, audio.connect, audio.disconnect, releaseAudio]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(null); setNotice(null); try { await action(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } };
  const commandForCall = async (id: string, type: string, body: Record<string, unknown> = {}, method = "POST") => {
    const response = await mutate<{ snapshot: CallSnapshot }>(`/api/calls/${id}/${type}`, body, method);
    acceptSnapshot(response.snapshot); return response.snapshot;
  };
  const command = async (type: string, body: Record<string, unknown> = {}, method = "POST") => { if (selected) return commandForCall(selected.id, type, body, method); };
  const takeover = () => run(async () => {
    const target = selected;
    const participantId = session?.participantId;
    if (!target || !participantId || activeAudioCallIdRef.current && activeAudioCallIdRef.current !== target.id) return;
    const attempt = ++takeoverAttempt.current;
    // Lock immediately, before microphone permissions or HTTP responses can yield.
    lockAudio(target);
    await audio.enableMedia();
    await recoverTakeover({
      callId: target.id, participantId,
      isCurrent: () => takeoverAttempt.current === attempt && activeAudioCallIdRef.current === target.id && participantIdRef.current === participantId && !deletedCallIds.current.has(target.id) && !releasedCallIds.current.has(target.id),
      read: async () => (await api<{ snapshot: CallSnapshot }>(`/api/calls/${target.id}`)).snapshot,
      command: (type, revision) => commandForCall(target.id, type, { expectedRevision: revision }),
      onSnapshot: acceptSnapshot,
    });
  });
  const endActiveCall = () => run(async () => {
    const id = activeAudioCallIdRef.current;
    if (!id) return;
    await commandForCall(id, "end"); releaseAudio(id);
  });
  const evidence = (turnId: string) => { setHighlight(turnId); setEvidenceTab("transcript"); setMobilePanel("context"); };
  const counts = queueCounts(calls);
  const visibleCalls = calls.filter((call) => matchesQueueFilter(call, queueFilter));
  const selectedQueueCall = calls.find((call) => call.id === selectedId) ?? selected;
  const selectedOutsideFilter = Boolean(selectedQueueCall && !matchesQueueFilter(selectedQueueCall, queueFilter));
  const emptyFilterTitle = { all: "No callers yet.", waiting: "No callers waiting.", "in-progress": "No calls in progress.", closed: "No closed calls." }[queueFilter];
  const unreviewed = selected?.facts.filter((fact) => !fact.nurseReviewed).length || 0;
  const hasOtherClaim = selected?.claim && selected.claim.participantId !== session?.participantId && selected.claim.expiresAt > Date.now();
  const connected = selected?.queueState === "CONNECTED";
  const selectedHasAudio = audio.callId === selected?.id;
  const viewingAnotherCall = Boolean(activeAudioCallId && activeAudioCallId !== selectedId);
  const activeConnected = activeCall?.queueState === "CONNECTED";
  const activePending = activeCall?.conversationOwner === "HANDOFF_PENDING";
  const canAbandonAudio = Boolean(activeCall && !activeConnected && !activePending && !busy);
  const questionText = selected?.template.questions.find((question) => question.id === selected.currentQuestion)?.text || (selected?.currentQuestion === "reason" ? selected.template.opening : undefined);
  const activeEscalations = selected?.escalations.filter((item) => !item.acknowledgedAt) || [];
  const unresolvedFields = selected ? FIELDS.filter((field) => selected.collection[field.id].status === "unresolved" || selected.collection[field.id].status === "awaiting_clarification").map((field) => field.label) : [];
  const projectionLag = selected ? Math.max(0, selected.revision - selected.projection.revision) : 0;
  return <div className="page nurse-page"><PageHeader eyebrow="NURSE WORKSPACE" title="Call queue" description="Review caller-reported intake and join the conversation." action={<button type="button" className="button" aria-expanded={invitationsOpen} aria-controls="caller-invitations" onClick={() => setInvitationsOpen((open) => !open)}><Icon name="person" size={15} />Invite a caller</button>} />
    <div id="caller-invitations" ref={invitationPanel} hidden={!invitationsOpen}><WorkspaceInvitations key={session?.participantId} role="caller" /></div>
    <div className="workspace-status"><span className="row"><span className="status-dot" style={{ color: "var(--teal)" }} /><strong>Nurse workspace</strong></span><span>{lastQueueUpdated ? `${counts.waiting} waiting · ${counts["in-progress"]} in progress · ${counts.closed} closed${queueError ? " · last known" : ""}` : "Queue counts unavailable"}</span><span className="row"><Icon name="clock" size={13} />Arrival order · no clinical ranking</span><span className="right">{queueError ? "Queue refresh delayed · " : ""}{lastQueueUpdated ? `Queue checked ${timeAgo(lastQueueUpdated)} ago` : queueError ? "Not yet loaded" : "Checking queue…"}{projectionLag > 0 ? ` · ${projectionLag} updates awaiting projection` : queueError ? " · Retrying automatically" : " · Automatic refresh"}</span></div>
    {(error || audio.socketError) && <Notice kind="error">{error || audio.socketError}</Notice>}{[...new Set([selectedId, activeAudioCallId].filter((id): id is string => Boolean(id)))].filter((id) => detailErrors[id]).map((id) => <Notice kind="error" key={id}><strong>Case details could not refresh.</strong><p>{id === activeAudioCallId && id !== selectedId ? "The active call’s" : "The selected case’s"} details may be outdated. {detailErrors[id]}</p><button className="button small" onClick={() => void detailPolls.current.get(id)?.refresh()}>Retry {id === activeAudioCallId && id !== selectedId ? "active call" : "case details"}</button></Notice>)}{notice && <Notice>{notice}</Notice>}{selected?.conversationOwner === "HANDOFF_PENDING" && <Notice>Checking both audio paths and clearing the assistant’s queued speech. Connection is confirmed only after both participants are ready.</Notice>}
    {activeCall && <section className="panel" aria-label="Active call controls" style={{ position: "sticky", top: 8, zIndex: 5, padding: "14px 18px", marginBottom: 16, boxShadow: "0 3px 12px #183e3914" }}>
      <div className="row between" style={{ flexWrap: "wrap" }}><div><strong>{caseLabel(activeCall)} · {activeConnected ? "Human audio connected" : activePending ? "Checking handoff readiness" : "Audio connection needs attention"}</strong><p className="fine-print">{viewingAnotherCall ? "Your conversation stays connected while you review another case." : "This call stays active while you review the queue."}</p></div><button className="button small" onClick={() => { if (!matchesQueueFilter(calls.find((call) => call.id === activeCall.id) ?? activeCall, queueFilter)) setQueueFilter("all"); selectCall(activeCall.id); setMobilePanel("draft"); }}>Return to active call</button></div>
      <div className="small-actions" style={{ marginTop: 10 }}><button className="button small" aria-pressed={audio.state.muted} disabled={audio.state.microphone !== "ready"} onClick={() => audio.mute(!audio.state.muted)}><Icon name={audio.state.muted ? "mute" : "mic"} size={14} />{audio.state.muted ? "Unmute microphone" : "Mute microphone"}</button>{(audio.state.microphone !== "ready" || audio.state.playback !== "ready") && <button className="button small" disabled={busy || audio.state.connection !== "connected"} onClick={() => void run(audio.enableMedia)}>Resume audio</button>}{audio.state.connection !== "connected" && <button className="button small" disabled={busy} onClick={() => void run(() => audio.connect(activeCall.id))}>Reconnect audio</button>}<button className="button danger small" disabled={busy} onClick={() => void endActiveCall()}>End call</button>{canAbandonAudio && <button className="button ghost small" onClick={() => { releaseAudio(); setNotice("You left the audio connection. The caller remains in the queue for a nurse."); }}>Leave audio connection</button>}</div>
      <p className="fine-print" style={{ marginTop: 8 }}>Microphone: {audio.state.microphone} · Output: {audio.state.playback} · Connection: {audio.state.connection}</p>{audio.state.error && <Notice kind="error">{audio.state.error}</Notice>}
    </section>}
    {activeEscalations.map((item) => <div className="escalation-strip" key={item.id}><Icon name="warning" size={20} /><div style={{ flex: 1 }}><strong>{ESCALATION_TITLES[item.reason]}</strong><p>{item.message}</p></div><button className="button danger small" disabled={busy} onClick={() => void run(async () => { await command("acknowledge-escalation", { escalationId: item.id }); })}>Acknowledge request</button></div>)}
    <div className="mobile-panel-tabs" aria-label="Workspace panels">{([ ["queue", "Queue"], ["draft", "Intake draft"], ["context", "Transcript & evidence"] ] as const).map(([id, label]) => <button key={id} className={mobilePanel === id ? "active" : ""} aria-pressed={mobilePanel === id} onClick={() => setMobilePanel(id)}>{label}</button>)}</div>
    <div className="nurse-grid">
    <section className={`panel queue-panel ${mobilePanel === "queue" ? "mobile-visible" : ""}`} aria-label="Caller queue" aria-busy={loading}>
      <div className="queue-header">
        <div className="row between"><h2>Calls</h2><span className="count-badge">{lastQueueUpdated ? visibleCalls.length : "—"}</span></div>
        <p className="fine-print">Intake never blocks nurse access.</p>
        <div className="queue-status-filter">
          <label className="field-label" htmlFor="queue-status">Status</label>
          <select id="queue-status" className="text-input" value={queueFilter} onChange={(event) => setQueueFilter(event.target.value as QueueFilter)}>
            {QUEUE_FILTERS.map(({ value, label }) => <option key={value} value={value}>{label} ({lastQueueUpdated ? counts[value] : "—"})</option>)}
          </select>
        </div>
        {queueError && <Notice kind="error"><strong>{lastQueueUpdated ? "Queue refresh interrupted." : "The queue could not be loaded."}</strong><p>{queueError} {lastQueueUpdated ? "Showing the last known cases. New callers may be missing." : "The caller counts are unavailable until the queue loads."}</p><button className="button small" disabled={queueRefreshing} onClick={() => void queuePoll.current?.refresh()}>{queueRefreshing ? "Retrying queue…" : "Retry queue"}</button></Notice>}
      </div>
      <div className="queue-list">
        {visibleCalls.map((call) => <button key={call.id} className={`queue-item ${selectedId === call.id ? "selected" : ""}`} aria-pressed={selectedId === call.id} onClick={() => { selectCall(call.id); setMobilePanel("draft"); }}>
          <div className="row"><span className="caller-avatar">{call.id.slice(-2).toUpperCase()}</span><h3>{caseLabel(call)}</h3></div>
          <div className="queue-timing">
            <span className="queue-time"><Icon name="clock" size={11} /><time dateTime={new Date(call.createdAt).toISOString()}>{call.queueState === "CLOSED" ? `Arrived ${arrivalDate(call.createdAt)}` : `Arrived ${arrivalAge(call.createdAt, now)} ago`}</time></span>
            {call.queueState !== "CLOSED" && <span className="queue-time">Session ends in {sessionRemaining(call.callDeadlineAt, now)}</span>}
          </div>
          <p className="queue-reason">{call.facts?.find((fact) => fact.field === "reason")?.value || (call.queueState === "CLOSED" ? "No caller-reported details" : "Waiting for caller-reported details")}</p>
          <div className="queue-state-row">
            <Badge tone={call.queueState === "CONNECTED" ? "teal" : "neutral"}>{queueStateLabel(call)}</Badge>
            {(call.channel === "phone" || call.mode === "mock") && <span className="queue-channel">{call.channel === "phone" ? "PHONE" : "FIXTURE"}</span>}
          </div>
          {call.queueState !== "CLOSED" && <p className={`queue-detail ${call.humanRequested ? "attention" : ""}`}>{call.waitingReason ? WAITING_LABELS[call.waitingReason] : intakeLabel(call)}</p>}
        </button>)}
      </div>
      {visibleCalls.length === 0 && <div className="empty-state">
        <Icon name="queue" size={28} />
        <h3>{!lastQueueUpdated ? loading ? "Loading your queue…" : "Queue unavailable." : calls.length === 0 ? "No callers yet." : emptyFilterTitle}</h3>
        <p>{!lastQueueUpdated ? loading ? "Checking for callers and their latest intake." : "Retry to check for waiting callers." : queueError ? "No matching calls in the last known queue. Retry to check for updates." : calls.length === 0 ? "Invite a caller to join. Their intake will appear here when they enter the queue." : "Choose another status to see other calls."}</p>
        {lastQueueUpdated && !queueError && calls.length === 0 && <button type="button" className="text-link" onClick={() => { setInvitationsOpen(true); window.requestAnimationFrame(() => invitationPanel.current?.scrollIntoView({ block: "nearest" })); }}>Create a caller invitation <Icon name="arrow" size={13} /></button>}
      </div>}
      <div className="queue-footer"><Icon name="file" size={15} /><span>Queue order reflects arrival time. It is not a clinical urgency assessment.</span></div>
    </section>
    <section className={`panel case-panel ${mobilePanel === "draft" ? "mobile-visible" : ""}`} aria-label="Selected intake draft">{selected ? <>{selectedOutsideFilter && <div className="case-filter-notice"><Notice><strong>This case is outside the current filter</strong><button type="button" className="text-link" onClick={() => { setQueueFilter("all"); setMobilePanel("queue"); }}>Show in list</button></Notice></div>}<div className="case-heading"><div className="row between"><div className="case-id">{selected.channel === "phone" ? "PHONE CALL" : "BROWSER CALL"} · {selected.id.slice(-8).toUpperCase()}</div><Badge tone={mode === "mock" ? "amber" : "neutral"}>{selected.channel === "phone" ? "Inbound phone" : mode === "mock" ? "Transcript replay" : "Live voice agent"}</Badge></div><h2>{caseLabel(selected)}</h2><p className="fine-print">Human-request destination: {selected.workspacePreferences?.escalationDestination ?? "Nurse queue"}</p><div className="case-meta"><Badge tone={selected.intakeState === "INTERRUPTED" || selected.intakeState === "DECLINED" ? "amber" : "teal"}>{intakeLabel(selected)}</Badge><span className="fine-print">Arrived {selected.queueState === "CLOSED" ? arrivalDate(selected.createdAt) : clockTime(selected.createdAt)}</span><span className="fine-print">·</span><span className="fine-print">{selected.nurseReviewStatus === "reviewed" ? "Nurse reviewed" : "Awaiting nurse review"}</span></div></div><div className="case-toolbar"><div><div className="row" style={{ gap: 6, marginBottom: 3 }}><span className="status-dot" style={{ color: connected ? "var(--teal)" : "#9caa91" }} /><strong style={{ fontSize: 12 }}>{connected ? "Human audio connected" : selected.queueState === "CLOSED" ? "Call ended" : selected.conversationOwner === "HANDOFF_PENDING" ? "Checking handoff readiness" : selected.aiStatus === "unavailable" ? "Automated intake unavailable" : selected.waitingReason ? "Waiting for nurse" : `Assistant ${selected.aiStatus}`}</strong></div><p>{selected.queueState === "CLOSED" ? "Review the intake draft and call history." : connected ? "Automated provider forwarding is stopped." : "You can join before intake is complete."}</p></div><button className="button primary" disabled={busy || viewingAnotherCall || Boolean(hasOtherClaim) || selected.queueState === "CLOSED" || connected || !selectedHasAudio || audio.state.connection !== "connected"} onClick={() => void takeover()}><Icon name="phone" size={16} />{selected.queueState === "CLOSED" ? "Call ended" : busy ? "Connecting…" : viewingAnotherCall ? "Active call in progress" : hasOtherClaim ? "Claimed by another nurse" : connected ? "Connected" : "Take over call"}</button></div>
      <div className="audio-state" style={{ justifyContent: "flex-start", padding: "0 23px", marginTop: 12 }}><span><Icon name="person" size={12} />Caller {selected.participants.caller ? "online" : "offline"}</span>{selectedHasAudio ? <><span><Icon name="mic" size={12} />Your microphone: {audio.state.microphone}</span><span><Icon name="volume" size={12} />Your output: {audio.state.playback}</span><span>Connection: {audio.state.connection}</span></> : <span>{viewingAnotherCall ? "Viewing case details · audio remains with the active call" : selected.queueState === "CLOSED" ? "Audio ended" : "Connecting to this call…"}</span>}{selected.queueState !== "CLOSED" && <span><Icon name="clock" size={12} />Session ends in {sessionRemaining(selected.callDeadlineAt, now)}</span>}</div>
      {selected.waitingReason && <div style={{ padding: "0 20px" }}><Notice>{WAITING_LABELS[selected.waitingReason]}. The automated provider session is {selected.providerSession.status}; {selected.queueState === "CONNECTED" ? "the caller is connected to the nurse" : selected.queueState === "CLOSED" ? "the call has ended" : "the caller remains available for nurse takeover"}.{unresolvedFields.length > 0 ? ` Follow up on: ${unresolvedFields.join(", ")}.` : ""}</Notice></div>}
      {selected.warnings.length > 0 && <div style={{ padding: "0 20px" }}>{selected.warnings.map((warning) => <Notice key={warning} kind="warning">{warning}</Notice>)}</div>}
      {!activeCall && selected.queueState !== "CLOSED" && audio.state.connection !== "connected" && <div style={{ padding: "14px 23px 0" }}><button className="button small" disabled={busy} onClick={() => void run(() => audio.connect(selected.id))}>Reconnect audio</button></div>}
      {!activeCall && selectedHasAudio && audio.state.error && <div style={{ padding: "0 20px" }}><Notice kind="error">{audio.state.error}</Notice></div>}
      <div className="draft-intro"><div className="row between"><h3>Intake draft</h3><span className="fine-print">{selected.facts.length} fields captured</span></div><p>Patient-reported information. Evidence shows provenance, not medical validation.</p></div><div className="fact-list">{FIELDS.map((field) => { const fact = selected.facts.find((value) => value.field === field.id); const progress = selected.collection[field.id]; return <div className="fact-row" key={field.id}><div className="fact-heading"><span className="fact-label">{field.label}</span>{fact ? <Badge tone={["uncertain", "unknown", "not_measured"].includes(fact.status) ? "amber" : "neutral"}>{STATUSES[fact.status]}</Badge> : progress.status !== "unasked" ? <Badge tone={progress.status === "unresolved" || progress.status === "awaiting_clarification" ? "amber" : "neutral"}>{progress.status.replaceAll("_", " ")}</Badge> : null}</div>{fact ? <><p className="fact-value">{fact.value || STATUSES[fact.status]}</p>{fact.rawWording && fact.rawWording !== fact.value && <p className="fine-print" style={{ marginTop: 6 }}>Caller’s wording: “{fact.rawWording}”</p>}{fact.evidence.map((source, index) => <button className="evidence-link" key={`${source.turnId}-${index}`} onClick={() => evidence(source.turnId)}><Icon name="link" size={12} /><span>“{source.quote.length > 95 ? `${source.quote.slice(0, 95)}…` : source.quote}”</span></button>)}{fact.status === "not_measured" && <div className="fact-note">Not measured does not mean the symptom was denied.</div>}<div className="fact-actions"><span className="fine-print" style={{ fontSize: 10 }}>{fact.nurseReviewed ? "✓ Nurse reviewed" : "Nurse review pending"} · {fact.patientConfirmed ? "Patient confirmed" : "Not patient-confirmed"}</span><button className="text-link" style={{ fontSize: 10, marginLeft: "auto" }} onClick={() => setEditing(fact)}>Edit with evidence</button></div></> : <p className="fact-missing">{COLLECTION_LABELS[progress.status]}</p>}</div>; })}</div>
      {editing && <div style={{ padding: "0 23px 20px" }}><FactEditor key={`${selected.id}:${editing.field}`} fact={editing} call={selected} busy={busy} onClose={() => setEditing(null)} onSave={(fact) => void run(async () => { await command("intake", { facts: [fact] }, "PATCH"); setEditing(null); })} /></div>}
      <div className="case-bottom"><div className="review-strip"><Icon name="file" size={15} /><span>{selected.intakeState === "CAPTURED" ? selected.queueState === "CLOSED" ? "Intake captured — call ended." : connected ? "Intake captured — nurse connected." : "Intake captured — caller waiting for a nurse." : "This draft is not a diagnosis, triage decision, or assessment of whether waiting is safe."}</span></div><div className="small-actions" style={{ marginTop: 15 }}><button className="button small" disabled={busy || unreviewed === 0} onClick={() => void run(async () => { await command("review"); setNotice("The current draft is marked nurse-reviewed. New or corrected facts will require review again."); })}><Icon name="check" size={14} />Mark current draft reviewed</button><button className="button small" disabled={busy} onClick={() => void run(async () => { const result = await mutate<{ url?: string; downloadUrl?: string; exportId?: string }>(`/api/calls/${selected.id}/export`, { format: "json" }); const url = result.url || result.downloadUrl || (result.exportId ? `/api/calls/${selected.id}/export?id=${encodeURIComponent(result.exportId)}` : null); if (!url) throw new Error("Export was requested, but no download link was returned."); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `nursebridge-${selected.id}.json`; anchor.click(); setNotice("Private case export requested. Download access remains authorized and expires with retention."); })}><Icon name="download" size={14} />Export</button>{session?.role === "admin" && <button className="button ghost small" disabled={busy} onClick={() => setDeleteConfirm(!deleteConfirm)}><Icon name="trash" size={14} />Delete</button>}</div>{deleteConfirm && <div className="danger-zone"><h3>Delete this case?</h3><p className="fine-print">This ends the call and removes its active transcript, draft and exports. Backup retention may delay removal from backups.</p><div className="small-actions" style={{ marginTop: 10 }}><button className="button danger small" disabled={busy} onClick={() => void run(async () => { const id = selected.id; await mutate(`/api/calls/${id}`, {}, "DELETE"); if (activeAudioCallIdRef.current === id || !activeAudioCallIdRef.current && selectedIdRef.current === id) audio.disconnect(); forgetCall(id); setDeleteConfirm(false); await queuePoll.current?.refresh(); setNotice("The case is no longer accessible. Durable deletion cleanup removes projections and private exports."); })}>Delete case</button><button className="button small" onClick={() => setDeleteConfirm(false)}>Cancel</button></div></div>}</div></> : <div className="empty-state" style={{ paddingTop: 95 }}><Icon name="file" size={34} /><h3>{selectedId ? detailErrors[selectedId] ? "Intake details unavailable." : "Loading intake details…" : "The story starts with the caller."}</h3><p>{selectedId ? detailErrors[selectedId] ? "Retry case details to load this caller’s intake." : "Getting the selected caller’s latest intake and evidence." : "Select a call to see its evidence-linked intake. Missing information and uncertainty stay visible."}</p><div className="row" style={{ justifyContent: "center", marginTop: 30 }}><Badge>Patient reported</Badge><Badge tone="amber">Uncertainty preserved</Badge></div></div>}</section>
    <section className={`panel evidence-panel ${mobilePanel === "context" ? "mobile-visible" : ""}`} aria-label="Transcript and evidence"><div className="evidence-tabs" role="tablist" aria-label="Case context">{CONTEXT_TABS.map(([id, label], index) => <button key={id} ref={(element) => { contextTabs.current[index] = element; }} tabIndex={evidenceTab === id ? 0 : -1} onKeyDown={(event) => { let next: number; if (event.key === "ArrowRight") next = (index + 1) % CONTEXT_TABS.length; else if (event.key === "ArrowLeft") next = (index + CONTEXT_TABS.length - 1) % CONTEXT_TABS.length; else if (event.key === "Home") next = 0; else if (event.key === "End") next = CONTEXT_TABS.length - 1; else return; event.preventDefault(); setEvidenceTab(CONTEXT_TABS[next]![0]); contextTabs.current[next]?.focus(); }} role="tab" id={`tab-${id}`} aria-controls="context-panel" aria-selected={evidenceTab === id} className={evidenceTab === id ? "active" : ""} onClick={() => setEvidenceTab(id)}>{label}</button>)}</div><div className="evidence-content" id="context-panel" role="tabpanel" tabIndex={0} aria-labelledby={`tab-${evidenceTab}`}>{!selected ? <div className="empty-state" style={{ padding: "55px 0" }}><Icon name="link" size={26} /><h3>Every detail has a source.</h3><p>Finalized caller turns appear here. Select an evidence link in the draft to see the original words.</p></div> : evidenceTab === "transcript" ? <>{selected.turns.length === 0 && <p className="fine-print">No finalized caller turns yet. Automated intake begins only after explicit consent.</p>}{selected.turns.map((turn) => <article className={`transcript-item ${highlight === turn.id ? "highlighted" : ""}`} key={turn.id}><div className="transcript-heading"><span className="speaker-label">Caller</span><time>{clockTime(turn.at)}</time><span style={{ marginLeft: "auto" }}>{turn.final ? "Final" : "Provisional"}</span></div><div className={`transcript-bubble ${turn.final ? "" : "provisional"}`}>{turn.text}</div>{highlight === turn.id && <p className="fine-print" style={{ marginTop: 7, fontSize: 10 }}>Linked source · session {turn.sessionId.slice(-6)} · turn {turn.order}</p>}</article>)}{selected.assistantTurns.map((turn) => <article className="transcript-item" key={turn.id}><div className="transcript-heading"><span className="speaker-label">Automated assistant</span><time>{clockTime(turn.at)}</time>{turn.interrupted && <Badge tone="amber">Interrupted</Badge>}</div><div className={`transcript-bubble agent ${turn.final ? "" : "provisional"}`}>{turn.text}</div></article>)}{selectedHasAudio && audio.caption && <article className="transcript-item"><div className="transcript-heading"><span className="speaker-label">Caller</span><Badge tone="amber">Provisional</Badge></div><div className="transcript-bubble provisional">{audio.caption}</div></article>}{selected.assistantTurns.length === 0 && questionText && <article className="transcript-item"><div className="transcript-heading"><span className="speaker-label">Automated assistant</span></div><div className="transcript-bubble agent">{questionText}</div></article>}<p className="fine-print" style={{ borderTop: "1px solid var(--line)", paddingTop: 14, fontSize: 10 }}>Speech recognition confidence is separate from clinical certainty. Human takeover audio bypasses automated intake providers.</p></> : evidenceTab === "evidence" ? <>{selected.factRevisions.length === 0 && <p className="fine-print">Corrections will be preserved here as revisions.</p>}{[...selected.factRevisions].reverse().map((revision) => <article className="revision-row" key={revision.id}><div className="row between"><strong>{FIELDS.find((field) => field.id === revision.field)?.label}</strong><Badge>Revision {revision.revision}</Badge></div>{revision.previous && <p><s>{revision.previous.value}</s></p>}<p style={{ color: "var(--ink)" }}>{revision.current.value}</p><p className="fine-print" style={{ fontSize: 10, marginTop: 7 }}>{clockTime(revision.at)} · {revision.actor === "AI" ? "Automated extraction · review required" : "Staff edit · see review status"}</p>{revision.current.evidence.map((source, index) => <button className="evidence-link" key={index} onClick={() => evidence(source.turnId)}><Icon name="link" size={11} />View supporting words</button>)}</article>)}</> : <>{selected.timeline.map((item) => <article className="timeline-item" key={item.id}><time>{clockTime(item.at)}</time><strong>{item.type.replace(/[._]/g, " ")}</strong><p>{item.message}</p></article>)}<div className="notice info"><div><strong>Projection status</strong><p className="fine-print">Authoritative revision {selected.revision}; projected revision {selected.projection.revision}.</p>{selected.projection.error && <p className="inline-error">{selected.projection.error}</p>}</div></div></>}</div></section></div>
  </div>;
}
function FactEditor({ fact, call, busy, onClose, onSave }: { fact: IntakeFact; call: CallSnapshot; busy: boolean; onClose: () => void; onSave: (value: Record<string, unknown>) => void }) {
  const [value, setValue] = useState(fact.value);
  const [status, setStatus] = useState<FactStatus>(fact.status);
  const [turnId, setTurnId] = useState(fact.evidence[0]?.turnId || "");
  const [quote, setQuote] = useState(fact.evidence[0]?.quote || "");
  const source = call.turns.find((turn) => turn.id === turnId);
  const valid = Boolean(value.trim() && quote.trim() && source?.final && source.text.includes(quote));
  return <form className="case-command-form" onSubmit={(event) => { event.preventDefault(); if (valid) onSave({ field: fact.field, value, status, rawWording: quote, evidence: [{ turnId, quote }] }); }}><div className="row between"><h3>Edit {FIELDS.find((field) => field.id === fact.field)?.label}</h3><button type="button" aria-label="Close fact editor" onClick={onClose}><Icon name="close" size={17} /></button></div><label className="field-label" htmlFor="fact-value">Current draft wording</label><textarea className="text-input" id="fact-value" value={value} onChange={(event) => setValue(event.target.value)} /><label className="field-label" htmlFor="fact-status">Patient-report status</label><select id="fact-status" className="text-input" value={status} onChange={(event) => setStatus(event.target.value as FactStatus)}>{Object.entries(STATUSES).filter(([key]) => key !== "not_asked").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><label className="field-label" htmlFor="fact-source">Supporting finalized turn</label><select id="fact-source" className="text-input" value={turnId} onChange={(event) => { setTurnId(event.target.value); setQuote(call.turns.find((turn) => turn.id === event.target.value)?.text || ""); }}><option value="">Select source words</option>{call.turns.filter((turn) => turn.final).map((turn) => <option key={turn.id} value={turn.id}>{clockTime(turn.at)} · {turn.text.slice(0, 70)}</option>)}</select><label className="field-label" htmlFor="fact-quote">Exact supporting quote</label><textarea className="text-input" id="fact-quote" value={quote} onChange={(event) => setQuote(event.target.value)} /><p className="fine-print">Corrections preserve previous revisions. The quote must exactly match the selected finalized caller turn.</p><button className="button primary small" disabled={busy || !valid} type="submit">Save correction</button></form>;
}
