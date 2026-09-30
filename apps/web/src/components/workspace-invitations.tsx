"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons";
import { errorMessage, mutate, Notice, useWorkspace } from "./workspace";

type Invitation = { url: string; expiresAt: number | string };

export function WorkspaceInvitations({ role }: { role: "caller" | "nurse" }) {
  const { session } = useWorkspace();
  const headingId = useId();
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const invitationVersion = useRef(0);
  const link = useRef<HTMLAnchorElement>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "selected" | "unavailable" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = invitation ? new Date(invitation.expiresAt).getTime() : 0;
  const expired = Boolean(invitation && expiresAt <= now);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!invitation) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [invitation]);

  const createInvitation = async () => {
    if (inFlight.current || session?.role !== "admin") return;
    inFlight.current = true;
    invitationVersion.current++;
    setBusy(true); setError(null); setCopyStatus(null);
    try {
      const value = await mutate<Invitation>("/api/demo/invitations", { role });
      if (mounted.current) { setInvitation(value); setNow(Date.now()); }
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const copyInvitation = async () => {
    if (!invitation || expired) return;
    const version = invitationVersion.current;
    const current = () => mounted.current && version === invitationVersion.current;
    try {
      await navigator.clipboard.writeText(invitation.url);
      if (current()) setCopyStatus("copied");
    } catch {
      if (!current()) return;
      // Keep sharing usable when clipboard permission is unavailable.
      const selection = window.getSelection();
      if (selection && link.current) {
        link.current.focus();
        const range = document.createRange();
        range.selectNodeContents(link.current);
        selection.removeAllRanges(); selection.addRange(range);
        setCopyStatus("selected");
      } else setCopyStatus("unavailable");
    }
  };

  return <section className="panel settings-section" aria-labelledby={headingId}>
    <div className="panel-heading"><h2 id={headingId}>{role === "caller" ? "Invite a caller" : "Invite another nurse"}</h2><Icon name="link" size={17} /></div>
    <div className="panel-content">
      <p className="fine-print">{role === "caller" ? "Create a private link for the caller to join this workspace’s queue from their own device." : "Give a nurse access to this workspace. Organization sign-in is also required when staff access is protected."} Each invitation can be used once and expires after 10 minutes.</p>
      {session?.role === "admin" ? <>
        <button className="button primary small" type="button" style={{ marginTop: 14 }} disabled={busy} onClick={() => void createInvitation()}>{busy ? "Creating invitation…" : error ? "Retry invitation" : invitation ? `Create another ${role} invitation` : `Create ${role} invitation`}</button>
        {error && <Notice kind="error"><div>We couldn’t create the invitation. {error}</div></Notice>}
        {invitation && <div className="invitation-result">
          <div className="row between" style={{ flexWrap: "wrap", marginBottom: 8 }}><strong style={{ fontSize: 13 }}>{role === "caller" ? "Caller" : "Nurse"} invitation</strong><button className="button small" type="button" disabled={busy || expired} onClick={() => void copyInvitation()}><Icon name={copyStatus === "copied" ? "check" : "copy"} size={13} />{copyStatus === "copied" ? "Copied" : "Copy"}</button></div>
          {expired ? <p role="status">This invitation has expired. Create another invitation to continue.</p> : <><a ref={link} href={invitation.url} target="_blank" rel="noreferrer">{invitation.url}</a><p>Expires at {new Date(invitation.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Share only with the intended {role}.</p></>}
          <p>Opening this link here changes this browser’s session. Send it to the {role} to open on their own device.</p>
          <div role="status" aria-live="polite" className="fine-print" style={{ marginTop: 8 }}>{copyStatus === "copied" ? "Invitation copied. Share it with the intended recipient." : copyStatus === "selected" ? "Clipboard access is unavailable. The link is selected; use your device’s copy command." : copyStatus === "unavailable" ? "Clipboard access is unavailable. Select and copy the link above." : ""}</div>
        </div>}
      </> : <Notice>Ask your workspace administrator to create a {role} invitation. Your current role cannot issue invitations.</Notice>}
    </div>
  </section>;
}
