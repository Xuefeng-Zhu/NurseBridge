"use client";

import { BrowserCall } from "@nursebridge/audio-client";
import type { CallSnapshot } from "@nursebridge/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, mutate, useWorkspace } from "./workspace";

export interface MediaState { connection: string; microphone: string; playback: string; muted: boolean; error?: string }
const INITIAL: MediaState = { connection: "idle", microphone: "idle", playback: "idle", muted: false };
export function useCallAudio(role: "caller" | "nurse", snapshotHandler: (snapshot: CallSnapshot) => void) {
  const { realtimeUrl, diagnostics } = useWorkspace();
  const [state, setState] = useState<MediaState>(INITIAL);
  const [caption, setCaption] = useState("");
  const [socketError, setSocketError] = useState<string | null>(null);
  const client = useRef<BrowserCall | null>(null);
  const callId = useRef<string | null>(null);
  const snapshotRef = useRef(snapshotHandler);
  snapshotRef.current = snapshotHandler;
  const disconnect = useCallback(() => { client.current?.close(); client.current = null; callId.current = null; setState(INITIAL); setCaption(""); }, []);
  const connect = useCallback(async (id: string) => {
    if (callId.current === id && client.current && !["closed", "error", "disconnected"].includes(client.current.getState().connection)) return;
    client.current?.close(); setSocketError(null); setCaption(""); callId.current = id;
    const ticket = async () => { const value = await mutate<{ ticket: string; websocketPath: string; realtimeUrl?: string }>(`/api/calls/${id}/connection-ticket`, { role }); return { ticket: value.ticket, url: new URL(value.websocketPath, value.realtimeUrl || realtimeUrl).href }; };
    const audio = new BrowserCall({ role, onState: setState, testMode: diagnostics, onDiagnostics: (value) => { if (diagnostics) (window as unknown as { __nursebridgeDiagnostics: unknown }).__nursebridgeDiagnostics = value; }, getReconnectTicket: ticket, onEvent: (event) => {
      const message = event as { type?: string; snapshot?: CallSnapshot; turn?: { text: string; final: boolean }; text?: string; message?: string; error?: string };
      if (message.type === "authenticated") setSocketError(null);
      if (["snapshot", "authenticated"].includes(message.type || "") && message.snapshot) snapshotRef.current(message.snapshot);
      if (["caption", "partial", "transcript.partial"].includes(message.type || "")) setCaption(message.turn?.final ? "" : message.turn?.text || message.text || "");
      if (message.type === "error") setSocketError(message.message || message.error || "The audio connection needs attention.");
    } });
    client.current = audio;
    if (diagnostics) (window as unknown as { __nursebridge: BrowserCall }).__nursebridge = audio;
    try { const value = await ticket(); if (client.current !== audio) return; await audio.connect(value.ticket, value.url); }
    catch (reason) { setSocketError(errorMessage(reason)); throw reason; }
  }, [role, realtimeUrl, diagnostics]);
  const enableMedia = useCallback(async () => { if (!client.current) throw new Error("Connect to the call before enabling the microphone."); await client.current.enableMedia(); }, []);
  const mute = useCallback((value: boolean) => client.current?.mute(value), []);
  useEffect(() => () => client.current?.close(), []);
  return { state, caption, socketError, connect, disconnect, enableMedia, mute, client };
}
