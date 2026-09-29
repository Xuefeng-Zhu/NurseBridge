"use client";

import { RECORDING_DISCLOSURE, RECORDING_DISCLOSURE_VERSION, type DemoSettings, type IntakeTemplate } from "@nursebridge/contracts";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { api, AuthGate, Badge, errorMessage, mutate, Notice, PageHeader, useWorkspace } from "./workspace";

export function SettingsPage() { return <AuthGate callerAllowed={false}><SettingsWorkspace /></AuthGate>; }
function SettingsWorkspace() {
  const { session } = useWorkspace();
  const admin = session?.role === "admin";
  const [settings, setSettings] = useState<DemoSettings | null>(null);
  const [template, setTemplate] = useState<IntakeTemplate | null>(null);
  const [destination, setDestination] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState<"template" | "destination" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [editTemplate, setEditTemplate] = useState(false);
  const [discard, setDiscard] = useState<"template" | "destination" | null>(null);
  const mounted = useRef(false);
  const saveInFlight = useRef(false);
  const templateToggle = useRef<HTMLButtonElement>(null);
  const destinationInput = useRef<HTMLInputElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const busy = saving !== null;
  const templateDirty = Boolean(editTemplate && settings && template && JSON.stringify(template) !== JSON.stringify(settings.template));
  const destinationDirty = Boolean(settings && destination !== settings.escalationDestination);
  const dirty = templateDirty || destinationDirty;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void api<DemoSettings>("/api/settings", { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setSettings(value); setTemplate(value.template); setDestination(value.escalationDestination);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault(); event.returnValue = "";
    };
    const confirmNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.hasAttribute("download") || link.target && link.target !== "_self") return;
      const next = new URL(link.href, window.location.href);
      if (next.origin !== window.location.origin || next.pathname === window.location.pathname) return;
      if (!window.confirm("Leave settings and discard your unsaved changes?")) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    document.addEventListener("click", confirmNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      document.removeEventListener("click", confirmNavigation, true);
    };
  }, [dirty]);

  useEffect(() => { if (discard) keepEditing.current?.focus(); }, [discard]);

  const save = async (publish: boolean) => {
    if (!admin || !settings || !template || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(publish ? "template" : "destination"); setError(null); setSaved(null); setDiscard(null);
    try {
      const value = await mutate<DemoSettings>("/api/settings", publish ? { template } : { escalationDestination: destination }, "PATCH");
      if (!mounted.current) return;
      setSettings(value);
      if (publish) { setTemplate(value.template); setEditTemplate(false); }
      else { setDestination(value.escalationDestination); if (!editTemplate) setTemplate(value.template); }
      setSaved(publish ? `Template version ${value.template.version} published for new calls. Active calls retain their original template.` : "Workspace settings saved.");
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { saveInFlight.current = false; if (mounted.current) setSaving(null); }
  };
  const toggleTemplateEditor = () => {
    if (!settings || busy) return;
    setSaved(null);
    if (templateDirty) { setDiscard("template"); return; }
    setTemplate(settings.template); setEditTemplate((editing) => !editing); setDiscard(null);
  };
  const resolveDiscard = (confirmed: boolean) => {
    if (!settings || busy) return;
    if (confirmed) {
      if (discard === "template") { setTemplate(settings.template); setEditTemplate(false); }
      else setDestination(settings.escalationDestination);
      setSaved(null); setError(null);
    }
    if (discard === "template") templateToggle.current?.focus();
    else destinationInput.current?.focus();
    setDiscard(null);
  };
  return <div className="page settings-page"><PageHeader eyebrow="WORKSPACE CONFIGURATION" title="A consistent starting point." description="Approved prompts, explicit boundaries, and provider visibility." action={<Badge tone={admin ? "teal" : "neutral"}>{admin ? "Workspace administrator" : "Read-only staff access"}</Badge>} />
    {error && <Notice kind="error">{error}</Notice>}{saved && <Notice>{saved}</Notice>}{saving && <Notice>{saving === "template" ? "Publishing the next template version…" : "Saving the staff destination…"}</Notice>}{dirty && !discard && <Notice kind="warning">You have unsaved changes. Save or publish them before leaving settings.</Notice>}{discard && <Notice kind="warning"><div role="group" aria-label="Confirm discarding changes"><p>{discard === "template" ? "Discard your unpublished template changes?" : "Discard your unsaved destination changes?"} Your other settings will be preserved.</p><div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}><button ref={keepEditing} className="button small" type="button" onClick={() => resolveDiscard(false)}>Keep editing</button><button className="button danger small" type="button" onClick={() => resolveDiscard(true)}>{discard === "template" ? "Discard template changes" : "Discard destination changes"}</button></div></div></Notice>}{!admin && <Notice>Only authorized workspace administrators can publish templates or edit settings.</Notice>}
    {!settings || !template ? <section className="panel" aria-busy={loading}><div className="empty-state"><p role="status">{loading ? "Loading workspace settings…" : "Settings could not be loaded. Try again to continue."}</p>{!loading && <button className="button primary" type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry loading settings</button>}</div></section> : <div className="settings-grid" aria-busy={busy}><div><section className="panel settings-section"><div className="panel-heading"><h2>Intake template</h2><Badge tone="teal">VERSION {settings.template.version}</Badge></div><div className="panel-content"><div className="row between" style={{ marginBottom: 7 }}><h3>{settings.template.name}</h3>{admin && <button ref={templateToggle} className="text-link" disabled={busy} onClick={toggleTemplateEditor}>{editTemplate ? "Cancel editing" : "Create next version"}</button>}</div><p className="template-meta">New versions apply to new calls. Each active call retains its approved template.</p>{editTemplate ? <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void save(true); }}><div><label className="field-label" htmlFor="template-name">Template name</label><input className="text-input" id="template-name" maxLength={100} required disabled={busy} value={template.name} onChange={(event) => setTemplate({ ...template, name: event.target.value })} /></div><div><label className="field-label" htmlFor="template-opening">Approved opening question</label><textarea className="text-input" id="template-opening" maxLength={500} required disabled={busy} value={template.opening} onChange={(event) => setTemplate({ ...template, opening: event.target.value })} /></div>{template.questions.map((question, index) => <div key={question.id}><label className="field-label" htmlFor={`question-${question.id}`}>{question.field.replace(/_/g, " ")}</label><input className="text-input" id={`question-${question.id}`} maxLength={500} required disabled={busy} value={question.text} onChange={(event) => setTemplate({ ...template, questions: template.questions.map((item, number) => number === index ? { ...item, text: event.target.value } : item) })} /></div>)}<Notice kind="warning">Approved wording must collect patient-reported information only. Do not introduce diagnosis, treatment, reassurance, or advice that waiting is safe.</Notice><button className="button primary" disabled={busy || !templateDirty} type="submit">{saving === "template" ? "Publishing template…" : "Publish next template version"}</button></form> : <><div className="approved-copy">“{settings.template.opening}”</div><div style={{ marginTop: 13 }}>{settings.template.questions.map((question, index) => <div className="template-question" key={question.id}><span>{String(index + 1).padStart(2, "0")}</span><span>{question.text}</span></div>)}</div><p className="fine-print" style={{ marginTop: 16 }}>The assistant asks one missing question at a time. After one unsuccessful clarification, uncertainty stays visible for the nurse.</p></>}</div></section>
      <section className="panel settings-section"><div className="panel-heading"><h2>Inbound phone calls</h2><Badge tone={settings.phoneInbound?.enabled && settings.phoneInbound.configured ? "teal" : "amber"}>{settings.phoneInbound?.enabled && settings.phoneInbound.configured ? "Configuration present" : "Needs setup"}</Badge></div><div className="panel-content"><div className="setting-line"><div><strong>Twilio phone → browser nurse</strong><p>Phone callers enter this workspace’s queue when an operator routes a number here. Take over and speak using the same nurse call controls.</p></div></div><p className="fine-print">Automated intake requires separate caller consent and verified provider activation. When it is unavailable, callers can still wait for a nurse. Phone callers can press 0 to request a person.</p>{admin && <div style={{ marginTop: 14 }}><label className="field-label" htmlFor="phone-workspace">Workspace ID for phone routing</label><input className="text-input" id="phone-workspace" readOnly value={session?.workspaceId || ""} /><p className="field-hint">Give this ID to the deployment operator. Phone numbers and account secrets are configured on the server. This workspace expires after seven days; keep an active staff session or invitation to return.</p></div>}<p className="fine-print" style={{ marginTop: 12 }}>Configuration does not confirm a working telephone call. Test the connected number before sharing it. Do not enter patient information before release approval.</p></div></section>
      <section className="panel settings-section"><div className="panel-heading"><h2>Approved boundaries</h2><Icon name="file" size={17} /></div><div className="panel-content"><div className="approved-copy">“Clinical use requires completed release approval. Do not enter patient information.”</div><div className="section-divider" /><div className="setting-line"><div><strong>Assistant identity</strong><p>An automated intake assistant, not a nurse.</p></div></div><div className="setting-line"><div><strong>Intake completion</strong><p>“Intake captured — awaiting nurse assessment.”</p></div></div><div className="setting-line"><div><strong>Emergency limitations</strong><p>NurseBridge does not provide emergency care. Real emergencies require contacting emergency services. No automatic emergency calls.</p></div></div><div className="setting-line"><div><strong>Human access</strong><p>Consent refusal, incomplete intake and provider failure never remove a caller from the queue.</p></div></div></div></section></div>
      <div><section className="panel settings-section"><div className="panel-heading"><h2>Provider connectivity</h2><Badge tone={settings.mode === "mock" ? "amber" : "teal"}>{settings.mode.toUpperCase()} MODE</Badge></div><div className="panel-content">{([ ["voiceAgent", "A", "AssemblyAI Voice Agent", "Streaming conversation, speech and consented provider recording"], ["extraction", "N", "Nebius Token Factory", "Nemotron-3.5-Lightning · evidence-validated extraction"] ] as const).map(([key, letter, label, detail]) => { const provider = settings.providers[key]; return <div className="provider-line" key={key}><span className="provider-letter">{letter}</span><div style={{ flex: 1 }}><h3>{label}</h3><p>{detail}</p><p>{settings.mode === "mock" ? "Explicit fixture adapter; no live integration claim." : provider.verified ? "Provider connection verified." : provider.configured ? "Configuration present; live operation not yet verified." : "Required live intake configuration is missing."}</p></div><Badge tone={settings.mode === "mock" || !provider.verified ? "amber" : "teal"}>{settings.mode === "mock" ? "Fixture" : provider.verified ? "Verified" : provider.configured ? "Configured" : "Missing"}</Badge></div>; })}<p className="fine-print" style={{ borderTop: "1px solid var(--line)", marginTop: 18, paddingTop: 13 }}>Configuration is not evidence of a successful live call. Provider warnings remain visible in the case.</p></div></section>
      <section className="panel settings-section"><div className="panel-heading"><h2>Human-request destination</h2><Icon name="person" size={17} /></div><form className="panel-content" onSubmit={(event) => { event.preventDefault(); void save(false); }}><label className="field-label" htmlFor="escalation-destination">Staff destination</label><input ref={destinationInput} className="text-input" id="escalation-destination" value={destination} onChange={(event) => setDestination(event.target.value)} disabled={!admin || busy} maxLength={120} required /><p className="field-hint">A visible destination label for this workspace. It does not connect to a real clinic or send an emergency alert.</p><div className="section-divider" /><p className="fine-print">Human requests and technical failures require visible staff acknowledgment. This workflow is not a clinical escalation protocol.</p>{admin && <div className="settings-actions" style={{ flexWrap: "wrap" }}>{destinationDirty && <button className="button small" type="button" disabled={busy} onClick={() => setDiscard("destination")}>Discard destination edit</button>}<button className="button primary small" disabled={busy || !destination.trim() || !destinationDirty} type="submit">{saving === "destination" ? "Saving destination…" : "Save destination"}</button></div>}</form></section>
      <section className="panel settings-section"><div className="panel-heading"><h2>Privacy defaults</h2><Icon name="file" size={17} /></div><div className="panel-content"><div className="setting-line"><div><strong>Automated-intake recording</strong><p>{settings.mode === "mock" ? "Transcript replay does not use AssemblyAI recording." : settings.recording.enabled ? RECORDING_DISCLOSURE : "AssemblyAI recording is disabled for this deployment."}</p>{settings.mode === "live" && <p className="fine-print">Disclosure {settings.recording.disclosureVersion || RECORDING_DISCLOSURE_VERSION} · provider retention verified: {settings.recording.retentionVerified ? "yes" : "no"} · deletion controls verified: {settings.recording.deletionVerified ? "yes" : "no"}</p>}</div><span className="toggle-static">{settings.mode === "live" && settings.recording.enabled ? "CONSENT" : "OFF"}</span></div><div className="setting-line"><div><strong>Human takeover</strong><p>After takeover, caller and nurse audio bypass automated intake providers.</p></div></div><div className="setting-line"><div><strong>Case retention</strong><p>Case records expire after {settings.retentionDays} days. Backup and provider retention can differ from active case deletion.</p></div><span className="toggle-static">{settings.retentionDays} DAYS</span></div><div className="setting-line"><div><strong>Private exports</strong><p>Explicitly requested JSON/Markdown exports require authorization and have limited retention.</p></div></div><div className="setting-line"><div><strong>Browser storage</strong><p>Case content is not stored in localStorage.</p></div></div><div className="setting-line"><div><strong>Clinical use</strong><p>Clinical use requires completed identity, privacy, and operational validation.</p></div><Badge tone="amber">PRE-PRODUCTION</Badge></div></div></section></div></div>}
  </div>;
}
