"use client";

import { BrowserCall } from "@nursebridge/audio-client";
import type { CallSnapshot } from "@nursebridge/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, mutate, useWorkspace } from "./workspace";
import { ApiError } from "./workspace-api";

export interface MediaState { connection: string; microphone: string; playback: string; muted: boolean; error?: string }
const INITIAL: MediaState = { connection: "idle", microphone: "idle", playback: "idle", muted: false };
export function useCallAudio(role: "caller" | "nurse", snapshotHandler: (snapshot: CallSnapshot) => void, onDeleted?: (callId: string) => void) {
  const { realtimeUrl, diagnostics } = useWorkspace();
  const [state, setState] = useState<MediaState>(INITIAL);
  const [caption, setCaption] = useState("");
  const [socketError, setSocketError] = useState<string | null>(null);
  const client = useRef<BrowserCall | null>(null);
  const callIdRef = useRef<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const snapshotRef = useRef(snapshotHandler);
  const deletedRef = useRef(onDeleted);
  snapshotRef.current = snapshotHandler;
  deletedRef.current = onDeleted;
  const disconnect = useCallback(() => {
    const previous = client.current;
    client.current = null;
    callIdRef.current = null;
    previous?.close();
    setCallId(null);
    setState(INITIAL);
    setCaption("");
    setSocketError(null);
  }, []);
  const connect = useCallback(async (id: string) => {
    if (callIdRef.current === id && client.current && ["connected", "connecting", "reconnecting"].includes(client.current.getState().connection)) return;
    const previous = client.current;
    client.current = null;
    previous?.close();
    setState(INITIAL);
    setSocketError(null);
    setCaption("");
    callIdRef.current = id;
    setCallId(id);
    const isCurrent = () => client.current === audio && callIdRef.current === id;
    const finish = (deleted = false) => {
      if (!isCurrent()) return;
      audio.close();
      client.current = null;
      callIdRef.current = null;
      setCallId(null);
      setCaption("");
      setSocketError(null);
      if (deleted) deletedRef.current?.(id);
    };
    const acceptSnapshot = (snapshot: CallSnapshot) => {
      if (!isCurrent()) return;
      snapshotRef.current(snapshot);
      if (snapshot.queueState === "CLOSED") finish();
    };
    const ticket = async () => {
      try {
        const value = await mutate<{ ticket: string; websocketPath: string; realtimeUrl?: string }>(`/api/calls/${id}/connection-ticket`, { role });
        return { ticket: value.ticket, url: new URL(value.websocketPath, value.realtimeUrl || realtimeUrl).href };
      } catch (reason) {
        if (isCurrent() && reason instanceof ApiError) {
          if (reason.status === 404 || reason.status === 410) finish(true);
          else if (reason.status === 409) {
            // A terminal call cannot issue another ticket. Recover its final
            // snapshot when the closing WebSocket event was missed.
            try {
              const { snapshot } = await api<{ snapshot: CallSnapshot }>(`/api/calls/${id}`);
              acceptSnapshot(snapshot);
            } catch (readError) {
              if (readError instanceof ApiError && (readError.status === 404 || readError.status === 410)) finish(true);
            }
          } else if (reason.status === 401 || reason.status === 403) {
            finish();
            setSocketError(errorMessage(reason));
          }
        }
        throw reason;
      }
    };
    const audio = new BrowserCall({ role, onState: (value) => { if (isCurrent()) setState(value); }, testMode: diagnostics, onDiagnostics: (value) => { if (isCurrent() && diagnostics) (window as unknown as { __nursebridgeDiagnostics: unknown }).__nursebridgeDiagnostics = value; }, getReconnectTicket: ticket, onEvent: (event) => {
      if (!isCurrent()) return;
      const message = event as { type?: string; snapshot?: CallSnapshot; turn?: { text: string; final: boolean }; text?: string; message?: string; error?: string };
      if (message.type === "authenticated") setSocketError(null);
      if (["snapshot", "authenticated"].includes(message.type || "") && message.snapshot) acceptSnapshot(message.snapshot);
      if (message.type === "deleted") { finish(true); return; }
      if (!isCurrent()) return;
      if (["caption", "partial", "transcript.partial"].includes(message.type || "")) setCaption(message.turn?.final ? "" : message.turn?.text || message.text || "");
      if (message.type === "error") setSocketError(message.message || message.error || "The audio connection needs attention.");
    } });
    client.current = audio;
    if (diagnostics) (window as unknown as { __nursebridge: BrowserCall }).__nursebridge = audio;
    try { const value = await ticket(); if (!isCurrent()) return; await audio.connect(value.ticket, value.url); }
    catch (reason) { if (isCurrent()) setSocketError(errorMessage(reason)); throw reason; }
  }, [role, realtimeUrl, diagnostics]);
  const enableMedia = useCallback(async () => {
    const audio = client.current;
    if (!audio) throw new Error("Connect to the call before enabling the microphone.");
    await audio.enableMedia();
    if (client.current === audio) setSocketError(null);
  }, []);
  const mute = useCallback((value: boolean) => client.current?.mute(value), []);
  useEffect(() => () => {
    const previous = client.current;
    client.current = null;
    callIdRef.current = null;
    previous?.close();
  }, []);
  return { state, caption, socketError, callId, connect, disconnect, enableMedia, mute, client };
}
