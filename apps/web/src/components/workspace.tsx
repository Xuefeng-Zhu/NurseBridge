"use client";

import Link from "next/link";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { ApiError, requestJson } from "./workspace-api";

export type Session = { workspaceId: string; participantId: string; role: "admin" | "nurse" | "caller"; expiresAt: number | string };
type SessionResponse = { session: Session; mode: "mock" | "live"; realtimeUrl: string; diagnostics?: boolean };
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  return requestJson<T>(path, options);
}
export function mutate<T>(path: string, body: Record<string, unknown> = {}, method = "POST") {
  return api<T>(path, { method, body: JSON.stringify({ commandId: crypto.randomUUID(), ...body }) });
}
type WorkspaceContext = { enrollmentMode: "sandbox" | "closed"; session: Session | null; mode: "mock" | "live" | null; realtimeUrl: string; diagnostics: boolean; loading: boolean; error: string | null; hasInvitation: boolean; verificationReady: boolean; turnstileSiteKey: string | null; verificationAttempt: number; setVerificationToken: (token: string | null) => void; refresh: () => Promise<void>; retry: () => Promise<void>; create: (invitation?: string) => Promise<void> };
const Context = createContext<WorkspaceContext | null>(null);
export function useWorkspace() { const context = useContext(Context); if (!context) throw new Error("Workspace provider is missing."); return context; }

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const [verificationToken, setVerificationToken] = useState<string | null>(null);
  const [verificationAttempt, setVerificationAttempt] = useState(0);
  const [enrollmentMode, setEnrollmentMode] = useState<"sandbox" | "closed">("closed");
  const [configurationReady, setConfigurationReady] = useState(false);
  const [pendingInvitation, setPendingInvitation] = useState<string | null>(null);
  const initialized = useRef(false);
  const initialization = useRef<{ invitation?: string; work: Promise<void> } | null>(null);
  const refresh = useCallback(async () => {
    try { setData(await api<SessionResponse>("/api/demo/session")); setError(null); }
    catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) { setData(null); setError(null); }
      else setError(errorMessage(reason));
    }
    finally { setLoading(false); }
  }, []);
  const issueSession = useCallback(async (invitation?: string, turnstileToken?: string) => {
    setLoading(true); setError(null);
    try {
      await mutate("/api/demo/session", { ...(invitation ? { invitation } : {}), ...(turnstileToken ? { turnstileToken } : {}) });
      // The cookie now belongs to the new session; do not show the previous
      // identity if loading that session fails. Retry can read the new cookie.
      setData(null);
      setPendingInvitation((pending) => pending === invitation ? null : pending);
      await refresh();
    }
    catch (reason) { setError(errorMessage(reason)); setLoading(false); throw reason; }
    finally { setVerificationToken(null); setVerificationAttempt((value) => value + 1); }
  }, [refresh]);
  const create = useCallback(async (invitation?: string) => {
    if (!configurationReady) throw new Error("Workspace configuration is unavailable. Reload to try again.");
    if (!invitation && !pendingInvitation && enrollmentMode !== "sandbox") throw new Error("Use a workspace invitation from your administrator.");
    if (turnstileSiteKey && !verificationToken) throw new Error("Complete the verification before opening your workspace.");
    await issueSession(invitation || pendingInvitation || undefined, verificationToken || undefined);
  }, [configurationReady, enrollmentMode, turnstileSiteKey, verificationToken, pendingInvitation, issueSession]);
  const initialize = useCallback((invitation?: string) => {
    if (initialization.current && initialization.current.invitation === invitation) return initialization.current.work;
    const load = async () => {
      setLoading(true); setError(null);
      try {
        const configuration = await api<{ turnstileSiteKey: string | null; enrollmentMode: "sandbox" | "closed" }>("/api/demo/config");
        setTurnstileSiteKey(configuration.turnstileSiteKey); setEnrollmentMode(configuration.enrollmentMode === "sandbox" ? "sandbox" : "closed"); setConfigurationReady(true);
        if (invitation) { if (configuration.turnstileSiteKey) setLoading(false); else await issueSession(invitation); }
        else await refresh();
      } catch (reason) { setError(errorMessage(reason)); setLoading(false); }
    };
    // Finish an anonymous lookup before redeeming a newly opened invitation.
    // This also prevents repeated clicks from consuming the same link twice.
    const work = (initialization.current?.work ?? Promise.resolve()).then(load, load);
    initialization.current = { invitation, work };
    const clear = () => { if (initialization.current?.work === work) initialization.current = null; };
    void work.then(clear, clear);
    return work;
  }, [refresh, issueSession]);
  const retry = useCallback(() => initialize(pendingInvitation || undefined), [initialize, pendingInvitation]);
  useEffect(() => {
    const openInvitation = () => {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const invitation = fragment.get("invite") || fragment.get("invitation");
      if (!invitation) return false;
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setPendingInvitation(invitation);
      void initialize(invitation);
      return true;
    };
    const onHashChange = () => { openInvitation(); };
    window.addEventListener("hashchange", onHashChange);
    if (!initialized.current) {
      initialized.current = true;
      if (!openInvitation()) void initialize();
    }
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [initialize]);
  return <Context.Provider value={{ enrollmentMode, session: data?.session || null, mode: data?.mode || null, realtimeUrl: data?.realtimeUrl || "", diagnostics: Boolean(data?.diagnostics), loading, error, hasInvitation: Boolean(pendingInvitation), verificationReady: configurationReady && (!turnstileSiteKey || Boolean(verificationToken)), turnstileSiteKey, verificationAttempt, setVerificationToken, refresh, retry, create }}>{children}</Context.Provider>;
}
type TurnstileApi = { render: (element: HTMLElement, options: { sitekey: string; theme: string; size: string; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void }) => string; remove: (widgetId: string) => void };
export function Verification() {
  const { turnstileSiteKey, verificationAttempt, setVerificationToken } = useWorkspace();
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ready || !turnstileSiteKey || !container.current) return;
    const turnstile = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
    if (!turnstile) return;
    const widgetId = turnstile.render(container.current, { sitekey: turnstileSiteKey, theme: "light", size: "flexible", callback: (token) => { setFailure(false); setVerificationToken(token); }, "expired-callback": () => setVerificationToken(null), "error-callback": () => { setFailure(true); setVerificationToken(null); } });
    return () => { turnstile.remove(widgetId); setVerificationToken(null); };
  }, [ready, turnstileSiteKey, verificationAttempt, setVerificationToken]);
  if (!turnstileSiteKey) return null;
  return <div style={{ marginTop: 18, marginBottom: 12, maxWidth: 400 }}><Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" strategy="afterInteractive" onReady={() => setReady(true)} onError={() => setFailure(true)} /><div ref={container} aria-label="Workspace access verification" />{failure && <Notice kind="error">Verification could not load. Check your connection and reload. A verification token is required on this deployment.</Notice>}</div>;
}
export function errorMessage(reason: unknown) { return reason instanceof Error ? reason.message : "Something interrupted this action. Please try again."; }
const navigation: { href: string; label: string; icon: IconName }[] = [
  { href: "/nurse", label: "Nurse workspace", icon: "queue" },
  { href: "/settings", label: "Settings", icon: "settings" },
];
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { mode, session } = useWorkspace();
  const callerView = path === "/caller" || session?.role === "caller";
  return <div className={`application ${callerView ? "caller-application" : "staff-application"}`}>
    {!callerView && <aside className="sidebar">
      <Link className="brand-symbol" href="/nurse" aria-label="NurseBridge workspace home"><span /><span /></Link>
      <nav aria-label="Primary navigation">{navigation.map((item) => <Link key={item.href} href={item.href} className={`nav-icon ${path === item.href ? "active" : ""}`} aria-current={path === item.href ? "page" : undefined} title={item.label}><Icon name={item.icon} /><span>{item.label}</span></Link>)}</nav>
      <div className="sidebar-foot" title="NurseBridge">NB</div>
    </aside>}
    <div className="application-main">
      <header className="topbar">
        <Link href={callerView ? "/caller" : "/nurse"} className="wordmark">Nurse<span>Bridge</span></Link>
        <span className="topbar-divider" /><span className="topbar-label">{callerView ? "YOUR CALL" : "CARE TEAM WORKSPACE"}</span>
        <div className="topbar-right">
          {callerView ? <span className="caller-header-label"><Icon name="phone" size={15} />Connect with your care team</span> : <>
            <span className={`mode-label ${mode === "mock" ? "amber" : ""}`}><span className="status-dot" />{mode === "mock" ? "TEST ENVIRONMENT" : "VOICE INTAKE"}</span>
            {session && <span className="avatar" title={session.role === "admin" ? "Workspace administrator" : "Nurse"}>{session.role === "admin" ? "A" : "N"}</span>}
          </>}
        </div>
      </header>
      <div className="simulation-banner"><Icon name="warning" size={15} /><span>Clinical use requires completed release approval. Do not enter patient information.</span></div>
      <main id="main-content" tabIndex={-1}>{children}</main>
      <footer className="app-footer">NurseBridge supports voice intake and human handoff. It does not provide emergency care. For a real emergency in the US, contact 911.</footer>
    </div>
  </div>;
}
export function AuthGate({ children, callerAllowed = true, audience = "staff" }: { children: ReactNode; callerAllowed?: boolean; audience?: "staff" | "caller" }) {
  const { session, loading, error, create, hasInvitation, verificationReady, refresh, retry, enrollmentMode } = useWorkspace();
  const caller = audience === "caller";
  if (loading) return <div className="welcome-card" role="status"><span className="spinner" /> {caller ? "Opening your call…" : "Opening your workspace…"}</div>;
  if ((!session || hasInvitation) && error) return <div className="welcome-card"><div className="eyebrow">{caller ? "CALL CONNECTION" : "WORKSPACE CONNECTION"}</div><h1>{caller ? "Your call couldn’t open." : "Workspace temporarily unavailable."}</h1><p>{caller ? "We couldn’t open your call invitation. Try again in a moment." : "We couldn’t open your workspace. Try again in a moment."}</p><Notice kind="error">{error}</Notice><button className="button primary" onClick={() => void retry()}>{caller ? "Retry opening call" : "Retry opening workspace"} <Icon name="arrow" size={17} /></button></div>;
  if (!session || hasInvitation) return <div className="welcome-card">
    <div className="eyebrow">{caller ? "YOUR CALL" : "CARE TEAM ACCESS"}</div>
    <h1>{caller ? hasInvitation ? "Your call is almost ready." : "Open your call invitation." : "Your care team workspace."}</h1>
    <p>{hasInvitation ? "Complete verification to securely open your invitation." : caller ? "Use the private invitation sent by your care team to start your call. If you haven’t received a link, contact your care team." : enrollmentMode === "sandbox" ? "Open a workspace to manage incoming calls, review intake, and connect with callers." : "Access is managed by your workspace administrator. Open your invitation to continue; staff access also requires organization sign-in."}</p>
    {(hasInvitation || !caller && enrollmentMode === "sandbox") && <><Verification /><button className="button primary" disabled={!verificationReady} onClick={() => void create().catch(() => undefined)}>{hasInvitation ? caller ? "Open call invitation" : "Open workspace invitation" : "Create local workspace"} <Icon name="arrow" size={17} /></button></>}
    {!caller && <Link href="/caller" className="text-link">Joining as a caller? <Icon name="arrow" size={14} /></Link>}
    <p className="fine-print">{caller ? "Your microphone stays off until you choose to enable it." : "Caller invitations open a separate call page with access limited to that caller."}</p>
  </div>;
  if (!callerAllowed && session.role === "caller") return <div className="welcome-card"><h1>This invitation is for a caller.</h1><p>Your private session does not include nurse or administrator access.</p><Link className="button primary" href="/caller">Open your call <Icon name="arrow" size={17} /></Link></div>;
  return <>{error && <Notice kind="error">{error}<button className="text-link" onClick={() => void refresh()}>Retry workspace status</button></Notice>}{children}</>;
}
export function Notice({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "error" | "warning" }) { return <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}><Icon name={kind === "info" ? "file" : "warning"} size={18} /><div>{children}</div></div>; }
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "teal" | "amber" | "red" }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) { return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action && <div className="page-header-action">{action}</div>}</div>; }
export function timeAgo(value: number | string) { const milliseconds = typeof value === "number" ? value : new Date(value).getTime(); const seconds = Math.max(0, Math.floor((Date.now() - milliseconds) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`; }
export function clockTime(value: number | string) { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
