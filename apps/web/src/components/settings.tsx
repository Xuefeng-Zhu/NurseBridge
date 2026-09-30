"use client";

import { RECORDING_DISCLOSURE, RECORDING_DISCLOSURE_VERSION, type WorkspacePreferences, type DemoSettings, type IntakeTemplate } from "@nursebridge/contracts";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { IntakeTemplateEditor } from "./intake-template-editor";
import { WorkspaceInvitations } from "./workspace-invitations";
import { api, AuthGate, Badge, errorMessage, mutate, Notice, PageHeader, useWorkspace } from "./workspace";

export function SettingsPage() { return <AuthGate callerAllowed={false}><SettingsWorkspace /></AuthGate>; }
function SettingsWorkspace() {
  const { session } = useWorkspace();
  const admin = session?.role === "admin";
  const [settings, setSettings] = useState<DemoSettings | null>(null);
  const [template, setTemplate] = useState<IntakeTemplate | null>(null);
  const [preferences, setPreferences] = useState<WorkspacePreferences | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [destination, setDestination] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState<"template" | "destination" | "configuration" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [editTemplate, setEditTemplate] = useState(false);
  const [discard, setDiscard] = useState<"template" | "destination" | "configuration" | null>(null);
  const mounted = useRef(false);
  const saveInFlight = useRef(false);
  const templateToggle = useRef<HTMLButtonElement>(null);
  const destinationInput = useRef<HTMLInputElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const busy = saving !== null || refreshing;
  const templateDirty = Boolean(editTemplate && settings && template && JSON.stringify(template) !== JSON.stringify(settings.template));
  const destinationDirty = Boolean(settings && destination !== settings.escalationDestination);
  const configurationDirty = Boolean(settings && preferences && ["automatedIntake", "recordingAllowed", "phoneEnabled", "retentionDays"].some(key => preferences[key as keyof WorkspacePreferences] !== settings.preferences[key as keyof WorkspacePreferences]));
  const dirty = templateDirty || destinationDirty || configurationDirty;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void api<DemoSettings>("/api/settings", { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setSettings(value); setTemplate(value.template); setDestination(value.escalationDestination); setPreferences(value.preferences);
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

  const save = async (publish: boolean, templateDraft = template) => {
    if (!admin || !settings || !template || saveInFlight.current || refreshing) return;
    saveInFlight.current = true;
    setSaving(publish ? "template" : "destination"); setError(null); setSaved(null); setDiscard(null);
    try {
      const value = await mutate<DemoSettings>("/api/settings", publish ? { template: templateDraft, expectedRevision: settings.revision } : { escalationDestination: destination, expectedRevision: settings.revision }, "PATCH");
      if (!mounted.current) return;
      setSettings(value);
      if (publish) { setTemplate(value.template); setEditTemplate(false); requestAnimationFrame(() => templateToggle.current?.focus()); }
      else { setDestination(value.escalationDestination); if (!editTemplate) setTemplate(value.template); }
      setSaved(publish ? `Template version ${value.template.version} published for new calls. Active calls retain their original template.` : "Workspace settings saved.");
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { saveInFlight.current = false; if (mounted.current) setSaving(null); }
  };
  const refresh = async () => {
    if (saveInFlight.current || refreshing) return;
    setRefreshing(true); setError(null); setSaved(null);
    try {
      const value = await api<DemoSettings>("/api/settings");
      if (!mounted.current) return;
      setSettings(value);
      if (!templateDirty) setTemplate(value.template);
      if (!destinationDirty) setDestination(value.escalationDestination);
      if (!configurationDirty) setPreferences(value.preferences);
      setSaved("Settings refreshed. Unsaved drafts were preserved; review them before saving.");
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { if (mounted.current) setRefreshing(false); }
  };
  const saveConfiguration = async () => {
    if (!admin || !settings || !preferences || saveInFlight.current || refreshing) return;
    saveInFlight.current = true; setSaving("configuration"); setError(null); setSaved(null);
    try {
      const { automatedIntake, recordingAllowed, phoneEnabled, retentionDays } = preferences;
      const value = await mutate<DemoSettings>("/api/settings", { automatedIntake, recordingAllowed, phoneEnabled, retentionDays, expectedRevision: settings.revision }, "PATCH");
      if (!mounted.current) return;
      setSettings(value); setPreferences(value.preferences);
      if (!templateDirty) setTemplate(value.template);
      if (!destinationDirty) setDestination(value.escalationDestination);
      setSaved("Configuration saved for new calls. Active calls keep their original settings.");
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { saveInFlight.current = false; if (mounted.current) setSaving(null); }
  };
  const toggleTemplateEditor = () => {
    if (!settings || busy) return;
    setSaved(null);
    if (templateDirty) { setDiscard("template"); return; }
    setTemplate(settings.template); setEditTemplate((editing) => !editing); setDiscard(null);
    requestAnimationFrame(() => {
      if (editTemplate) templateToggle.current?.focus();
      else document.getElementById("template-name")?.focus();
    });
  };
  const resolveDiscard = (confirmed: boolean) => {
    if (!settings || busy) return;
    if (confirmed) {
      if (discard === "template") { setTemplate(settings.template); setEditTemplate(false); }
      else if (discard === "configuration") setPreferences(settings.preferences);
      else setDestination(settings.escalationDestination);
      setSaved(null); setError(null);
    }
    if (discard === "template") requestAnimationFrame(() => templateToggle.current?.focus());
    else destinationInput.current?.focus();
    setDiscard(null);
  };
  return <div className="page settings-page"><PageHeader eyebrow="WORKSPACE CONFIGURATION" title="A consistent starting point." description="Approved prompts, explicit boundaries, and provider visibility." action={<Badge tone={admin ? "teal" : "neutral"}>{admin ? "Workspace administrator" : "Read-only staff access"}</Badge>} />
    {error && <Notice kind="error">{error}</Notice>}{saved && <Notice>{saved}</Notice>}{saving && <Notice>{saving === "template" ? "Saving template…" : saving === "configuration" ? "Saving workspace configuration…" : "Saving the staff destination…"}</Notice>}{dirty && !discard && <Notice kind="warning">You have unsaved changes. Save them before leaving settings.</Notice>}{discard && <Notice kind="warning"><div role="group" aria-label="Confirm discarding changes"><p>{discard === "template" ? "Discard your unpublished template changes?" : discard === "configuration" ? "Discard your configuration changes?" : "Discard your unsaved destination changes?"} Your other settings will be preserved.</p><div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}><button ref={keepEditing} className="button small" type="button" onClick={() => resolveDiscard(false)}>Keep editing</button><button className="button danger small" type="button" onClick={() => resolveDiscard(true)}>{discard === "template" ? "Discard template changes" : discard === "configuration" ? "Discard configuration changes" : "Discard destination changes"}</button></div></div></Notice>}{!admin && <Notice>Only authorized workspace administrators can edit templates or settings.</Notice>}
    {settings && <div className="settings-actions" style={{ marginBottom: 18 }}><button type="button" className="button small" disabled={busy} onClick={() => void refresh()}>{refreshing ? "Refreshing settings…" : "Refresh settings & status"}</button><span className="fine-print">Changes apply to new calls. Server credentials are managed by the deployment operator.</span></div>}
    {settings && preferences && <section className="panel settings-section"><div className="panel-heading"><h2>Workspace configuration</h2><Badge tone={settings.capabilities.automatedIntake ? "teal" : "amber"}>{settings.capabilities.automatedIntake ? "Intake available" : "Nurse-only available"}</Badge></div><form className="panel-content form-grid" onSubmit={event => { event.preventDefault(); void saveConfiguration(); }}>
      <label className="consent-label"><input type="checkbox" checked={preferences.automatedIntake} disabled={!admin || busy} onChange={event => setPreferences({ ...preferences, automatedIntake: event.target.checked })} /><span>Enable automated intake using server connections</span></label>
      <label className="consent-label"><input type="checkbox" checked={preferences.recordingAllowed} disabled={!admin || busy} onChange={event => setPreferences({ ...preferences, recordingAllowed: event.target.checked })} /><span>Allow provider recording with caller consent</span></label>
      <p className="field-hint">Recording permission does not start recording. If disabled, live calls use nurse-only conversation because the current provider cannot guarantee recording is off. Transcript test mode does not record audio.</p>
      <label className="consent-label"><input type="checkbox" checked={preferences.phoneEnabled} disabled={!admin || busy} onChange={event => setPreferences({ ...preferences, phoneEnabled: event.target.checked })} /><span>Accept inbound calls on assigned phone numbers</span></label>
      <p className="field-hint">{settings.capabilities.phoneNumbers.length ? `Assigned numbers: ${settings.capabilities.phoneNumbers.join(", ")}` : "No phone number is assigned to this workspace. Ask the deployment operator to configure a number using the workspace ID below."} {!settings.capabilities.phoneAvailable && "Phone service is not currently available."}</p>
      <div><label className="field-label" htmlFor="case-retention">Case retention</label><select className="text-input" id="case-retention" value={preferences.retentionDays} disabled={!admin || busy} onChange={event => setPreferences({ ...preferences, retentionDays: Number(event.target.value) })}>{Array.from({ length: 30 }, (_, index) => index + 1).map(days => <option key={days} value={days}>{days} {days === 1 ? "day" : "days"}</option>)}</select><p className="field-hint">Applies to new cases and their exports. Existing cases keep their expiry. Sessions and invitations still expire separately.</p></div>
      {settings.capabilities.blockers.length > 0 && <Notice kind="warning">Automated intake is unavailable: {settings.capabilities.blockers.map(issue => issue.replace(/_/g, " ")).join("; ")}. Browser nurse handoff remains available.</Notice>}
      {admin && <div className="settings-actions"><button className="button primary" type="submit" disabled={busy || !configurationDirty}>{saving === "configuration" ? "Saving configuration…" : "Save configuration"}</button>{configurationDirty && <button className="button" type="button" disabled={busy} onClick={() => setDiscard("configuration")}>Discard configuration edit</button>}</div>}
    </form></section>}
    {!settings || !template ? <section className="panel" aria-busy={loading}><div className="empty-state"><p role="status">{loading ? "Loading workspace settings…" : "Settings could not be loaded. Try again to continue."}</p>{!loading && <button className="button primary" type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry loading settings</button>}</div></section> : <div className="settings-grid" aria-busy={busy}><div><section className="panel settings-section"><div className="panel-heading"><h2>Intake template</h2><Badge tone="teal">VERSION {settings.template.version}</Badge></div><div className="panel-content"><div className="template-summary-heading"><h3>{settings.template.name}</h3>{admin && !editTemplate && <button ref={templateToggle} className="text-link" type="button" disabled={busy} onClick={toggleTemplateEditor}>Edit template</button>}</div>
        <p className="template-meta">Saving creates a new version for new calls. Each active call retains its approved template.</p>
        {editTemplate ? <IntakeTemplateEditor template={template} busy={busy} saving={saving === "template"} dirty={templateDirty} cancelButtonRef={templateToggle} onChange={setTemplate} onSave={value => void save(true, value)} onCancel={toggleTemplateEditor} /> : <>
          <div className="approved-copy">“{settings.template.opening}”</div>
          <div style={{ marginTop: 13 }}>{settings.template.questions.map((question, index) => <div className="template-question" key={question.id}><span>{String(index + 1).padStart(2, "0")}</span><span>{question.text}</span></div>)}</div>
          <div className="template-acknowledgments"><h3>Acknowledgments</h3><ul>{settings.template.acknowledgments.map((message, index) => <li key={index}>{message}</li>)}</ul></div>
          <p className="fine-print" style={{ marginTop: 16 }}>The assistant asks one missing question at a time. After one unsuccessful clarification, uncertainty stays visible for the nurse.</p>
        </>}</div></section>
      <section className="panel settings-section"><div className="panel-heading"><h2>Inbound phone calls</h2><Badge tone={settings.phoneInbound?.enabled && settings.phoneInbound.configured ? "teal" : "amber"}>{settings.phoneInbound?.enabled && settings.phoneInbound.configured ? "Configuration present" : settings.capabilities.phoneAvailable ? "Disabled for new calls" : "Needs setup"}</Badge></div><div className="panel-content"><div className="setting-line"><div><strong>Twilio phone → browser nurse</strong><p>Phone callers enter this workspace’s queue when an operator routes a number here. Take over and speak using the same nurse call controls.</p></div></div><p className="fine-print">Automated intake requires separate caller consent and verified provider activation. When it is unavailable, callers can still wait for a nurse. Phone callers can press 0 to request a person.</p>{admin && <div style={{ marginTop: 14 }}><label className="field-label" htmlFor="phone-workspace">Workspace ID for phone routing</label><input className="text-input" id="phone-workspace" readOnly value={session?.workspaceId || ""} /><p className="field-hint">Give this ID to the deployment operator. Phone numbers and account secrets are configured on the server. Keep an active staff session or invitation to return. Workspace availability extends to cover retained cases.</p></div>}<p className="fine-print" style={{ marginTop: 12 }}>Configuration does not confirm a working telephone call. Test the connected number before sharing it. Do not enter patient information before release approval.</p></div></section>
      <section className="panel settings-section"><div className="panel-heading"><h2>Approved boundaries</h2><Icon name="file" size={17} /></div><div className="panel-content"><div className="approved-copy">“Clinical use requires completed release approval. Do not enter patient information.”</div><div className="section-divider" /><div className="setting-line"><div><strong>Assistant identity</strong><p>An automated intake assistant, not a nurse.</p></div></div><div className="setting-line"><div><strong>Intake completion</strong><p>“Intake captured — awaiting nurse assessment.”</p></div></div><div className="setting-line"><div><strong>Emergency limitations</strong><p>NurseBridge does not provide emergency care. Real emergencies require contacting emergency services. No automatic emergency calls.</p></div></div><div className="setting-line"><div><strong>Human access</strong><p>Consent refusal, incomplete intake and provider failure never remove a caller from the queue.</p></div></div></div></section></div>
      <div><WorkspaceInvitations key={session?.participantId} role="nurse" /><section className="panel settings-section"><div className="panel-heading"><h2>Intake service status</h2><Badge tone={settings.mode === "mock" ? "amber" : "teal"}>{settings.mode.toUpperCase()} MODE</Badge></div><div className="panel-content">{([ ["voiceAgent", "V", "Voice intake", "Real-time conversation, speech processing and consented audio recording"], ["extraction", "C", "Conversation processing", "Drafts linked to supporting transcript evidence"] ] as const).map(([key, letter, label, detail]) => { const provider = settings.providers[key]; return <div className="provider-line" key={key}><span className="provider-letter">{letter}</span><div style={{ flex: 1 }}><h3>{label}</h3><p>{detail}</p><p>{settings.mode === "mock" ? "Explicit fixture adapter; no live integration claim." : provider.verified ? "Service connection verified." : provider.configured ? "Configuration present; live operation not yet verified." : "Required live intake configuration is missing."}</p></div><Badge tone={settings.mode === "mock" || !provider.verified ? "amber" : "teal"}>{settings.mode === "mock" ? "Fixture" : provider.verified ? "Verified" : provider.configured ? "Configured" : "Missing"}</Badge></div>; })}<p className="fine-print" style={{ borderTop: "1px solid var(--line)", marginTop: 18, paddingTop: 13 }}>Configuration is not evidence of a successful live call. Service warnings remain visible in the case.</p></div></section>
      <section className="panel settings-section"><div className="panel-heading"><h2>Human-request destination</h2><Icon name="person" size={17} /></div><form className="panel-content" onSubmit={(event) => { event.preventDefault(); void save(false); }}><label className="field-label" htmlFor="escalation-destination">Staff destination</label><input ref={destinationInput} className="text-input" id="escalation-destination" value={destination} onChange={(event) => setDestination(event.target.value)} disabled={!admin || busy} maxLength={120} required /><p className="field-hint">Shown to callers and nurses during handoff to this workspace’s browser nurse queue. It does not transfer to an external phone number.</p><div className="section-divider" /><p className="fine-print">Human requests and technical failures require visible staff acknowledgment. This workflow is not a clinical escalation protocol.</p>{admin && <div className="settings-actions" style={{ flexWrap: "wrap" }}>{destinationDirty && <button className="button small" type="button" disabled={busy} onClick={() => setDiscard("destination")}>Discard destination edit</button>}<button className="button primary small" disabled={busy || !destination.trim() || !destinationDirty} type="submit">{saving === "destination" ? "Saving destination…" : "Save destination"}</button></div>}</form></section>
      <section className="panel settings-section"><div className="panel-heading"><h2>Privacy defaults</h2><Icon name="file" size={17} /></div><div className="panel-content"><div className="setting-line"><div><strong>Audio recording</strong><p>{settings.mode === "mock" ? "Audio recording is off in transcript test mode." : settings.recording.enabled ? RECORDING_DISCLOSURE : "Audio recording is disabled."}</p>{settings.mode === "live" && <p className="fine-print">Disclosure {settings.recording.disclosureVersion || RECORDING_DISCLOSURE_VERSION} · provider retention verified: {settings.recording.retentionVerified ? "yes" : "no"} · deletion controls verified: {settings.recording.deletionVerified ? "yes" : "no"}</p>}</div><span className="toggle-static">{settings.mode === "live" && settings.recording.enabled ? "CONSENT" : "OFF"}</span></div><div className="setting-line"><div><strong>Human takeover</strong><p>After takeover, caller and nurse audio bypass automated intake providers.</p></div></div><div className="setting-line"><div><strong>Case retention</strong><p>Case records expire after {settings.retentionDays} days. Backup and provider retention can differ from active case deletion.</p></div><span className="toggle-static">{settings.retentionDays} DAYS</span></div><div className="setting-line"><div><strong>Private exports</strong><p>Explicitly requested JSON/Markdown exports require authorization and have limited retention.</p></div></div><div className="setting-line"><div><strong>Browser storage</strong><p>Case content is not stored in localStorage.</p></div></div><div className="setting-line"><div><strong>Clinical use</strong><p>Clinical use requires completed identity, privacy, and operational validation.</p></div><Badge tone="amber">PRE-PRODUCTION</Badge></div></div></section></div></div>}
  </div>;
}
