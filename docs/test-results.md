# Test results

## QA fixes verified on 2026-09-24

The confirmed local QA failures are fixed and covered by regressions. This run used the rebuilt OpenNext app and realtime Worker in one shared local runtime, explicit mock providers, synthetic microphone fixtures, and a fresh temporary D1/R2/DO persistence directory. Existing local demo data and provider credentials were not changed. Nothing was deployed, and live-provider and physical-device checks were not rerun.

| Executed check | Result |
| --- | --- |
| `pnpm typecheck` | Pass across all six workspace packages |
| `pnpm lint` | Pass; final browser-test additions also linted |
| `pnpm test` | 76 tests pass |
| `pnpm test:workers` | 119 tests pass |
| `pnpm test:voice-agent-setup` | 4 mocked tests pass |
| `pnpm build` | Next.js and OpenNext Worker build pass |
| `PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test` | 11 pass; opt-in live-provider test skipped; 1.2 minutes |
| Final HTTP regression rerun | 1 pass, including malformed/unsupported intake rejection and template-only settings updates |
| `git diff --check` | Pass |

Regression coverage now verifies:

- Switching fact editors resets wording, status and evidence to the target field; saving cannot carry the prior field's draft into another field. Context tabs support arrow keys, Home, End and roving focus.
- Selecting another case during a pending claim or an active human conversation preserves both microphone paths. Persistent controls mute, return to and end the active call by its ID. Desktop and 390px mobile panel navigation preserve the conversation without horizontal overflow.
- Remote end, `CLOSED` snapshots, deletion events and HTTP deletion recovery stop capture, close AudioContexts, cancel reconnects and remove stale waiting/reconnect controls. Late permission, worklet and decoder results cannot revive closed resources or mutate a newer connection.
- A client-initiated WebSocket close completes its handshake in Chrome. Reconnection gets one fresh ticket; authentication and ticket failures have one retry scheduler, and stale asynchronous completions are ignored. A failed initial ticket can be retried through the UI.
- Suspended audio exposes Resume audio. Both a user click and a browser-driven context resume restore playback readiness and clear the pause error.
- Failed caller list/detail restoration blocks Join until Retry succeeds, preserving the existing call and arrival instead of creating a duplicate.
- Cancel discards template edits. Destination saves preserve an unpublished template draft; publishing preserves the destination draft and concurrent saved destination changes.
- Malformed facts and unsupported evidence return HTTP 400 without changing the case. Unexpected persistence failures remain 503.

The actual two-browser audio proof measured 658.24 Hz at the caller from the 660 Hz nurse fixture, and 438.83 Hz at the nurse from the 440 Hz caller fixture. Both recorded zero stale agent samples after takeover, zero dropped frames and zero underruns; the measured handoff was 157 ms. These are local fixture observations, not live-provider or physical-device quality claims.

Screenshots of desktop/mobile active-call controls were inspected. This run's screenshots, audio proof and isolated runtime state are under `/tmp/nursebridge-fixes-20260924`; committed browser regressions regenerate evidence through Playwright. Production, real-device audibility, retention and repeated live-provider verification remain the separate acceptance work described below.

## Historical verification on 2026-09-21

Verified locally on 2026-09-21 against the Voice Agent implementation. AssemblyAI stored agent `agent_3163c2eb3794484b8d4c780107615e94` was created and read back with the configured Nebius model, voice and PCM settings. The mock browser suite and a separate fictional live-provider browser test passed. No public deployment or physical two-device test was performed.

## Executed checks

| Check | Result |
| --- | --- |
| Pinned install and `pnpm peers check` | Pass; no peer conflicts at baseline installation |
| Local D1 migrations and seed | Pass |
| `pnpm bindings` | Generated both Workers' binding/runtime types |
| `pnpm typecheck` | Pass across all six workspace packages |
| `pnpm lint` | Pass |
| `pnpm test` | 61 tests pass |
| `pnpm test:voice-agent-setup` | 4 tests pass; all provider requests mocked |
| `pnpm test:workers` | 115 tests pass in the Workers runtime |
| `pnpm build` | Next.js 16.3.5 and OpenNext Worker bundle pass |
| Realtime `wrangler deploy --dry-run` | Pass; bundle generated, nothing deployed |
| `PLAYWRIGHT_CHANNEL=chrome pnpm test:browser` | 5 mock-mode tests pass in 15.0 seconds; live test skipped without opt-in |
| `NURSEBRIDGE_LIVE_E2E=1 PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test tests/browser/live.spec.ts` | 1 fictional live-provider browser test passed in 54.1 seconds |

Browser tests run against OpenNext Workers preview at localhost:8787 and the realtime Worker at localhost:8788. Both execute in one shared local runtime through the preview gateway/proxy, preserving separate Worker code and deployment. They use installed Chrome because the pinned Playwright browser download is absent. A fresh machine can instead run `pnpm exec playwright install chromium`. Screenshots are inspected at desktop 1440×1050 and mobile 390×844. The nurse workspace switches to a single panel on narrow screens. Assertions cover horizontal overflow, uncaught page errors and unexpected browser console errors in the two-browser audio flow. The initial unauthenticated session probe is expected to return 401 before workspace creation.

The suite covers isolated workspaces and invitations, queue creation before consent, correction revisions, exact evidence, one clarification followed by unresolved waiting, ordinary completed waiting, refusal without changing arrival, cross-workspace restrictions, CSRF, role restrictions, template versions, authorized exports and terminal deletion. Waiting leaves the browser session available; a repeated intake-consent command is rejected after automation stops. The completed-intake test injects one temporary session-read failure and verifies the nurse workspace recovers without creating a new workspace. Unit tests verify the read retry limit and that mutations/authentication failures are never retried.

Workers tests exercise real local Durable Objects, SQLite and D1: claim races, command receipts, replayed tickets, eviction recovery, alarms, binary relay, exact playback-flush acknowledgment, readiness-before-claim reconciliation, dropped-frame rejection, both-direction playback proof, nurse disconnect, ten-minute call bounds, seven-day retention, ordered projections and deletion fences. Voice Agent tests use the production adapter with synthetic protocol events, including a Workers WebSocketPair upgrade. They cover configuration echoes, transcript replacement/deduplication, separate assistant evidence, tool authority and receipts, tool completion ordering, odd PCM bytes, interruption without speech-start events, stale audio rejection, provider cleanup retries, and closure before a provider session ID arrives. Nebius requests, bounded schema repair and error sanitization remain covered. Legacy standalone STT/TTS utility tests remain; those utilities are no longer the active pipeline.

## Measured fixture audio — not live provider performance

The two-browser test launches separate Chromium processes with distinct 440 Hz caller and 660 Hz nurse microphone files. Actual capture, 24 kHz resampling, WebSocket transport and receiving AudioWorklets run in both directions. The test initiates takeover while the 220 Hz mock agent cue is playing and checks zero agent samples in the new media epoch after flushing.

| Measurement | Final local fixture result |
| --- | --- |
| Caller received nurse microphone | 658.24 Hz estimated, 660 Hz source |
| Nurse received caller microphone | 438.83 Hz estimated, 440 Hz source |
| Agent samples after takeover epoch | 0 in both browsers |
| Human samples consumed after takeover | Caller 40,192; nurse 41,216 |
| Dropped frames / underruns | 0 / 0 in both captured proofs |
| Handoff through both playback acknowledgments | 171 ms |
| Mock extraction | 0 ms at millisecond clock resolution |
| Mock first audio ready / first playback | 1 ms / 100 ms |

The final run had no unexpected browser console errors, uncaught page errors or horizontal overflow in the two-browser audio flow. Fixture timings are one local observation, not targets, live latency guarantees, recognition accuracy or clinical evidence. The mock cue is a tone with text captions, not synthesized speech. No live transcription timing is reported.

Generated evidence is ignored by Git: [audio proof](../output/playwright/results/acceptance-visible-intake--f0397--distinct-human-microphones/audio-proof.json), [browser report](../output/playwright/report/index.html), and desktop/mobile screenshots in the same test-result directory. Tests regenerate these artifacts.

## Measured fictional live-provider call

The opt-in local test used synthesized fictional caller speech and two separate Chrome processes. The caller microphone passed through browser capture, resampling and WebSocket transport to the real AssemblyAI Voice Agent. Its configured Nebius model and AssemblyAI speech pipeline produced agent audio. The application finalized one caller turn, attached one intake fact to exact transcript evidence, and recorded two assistant turns. The nurse then took over during the call; both playback processors received human audio in the new epoch, with no stale agent samples. These are observations from one local run, not claims about clinical accuracy or production reliability.

| Measurement | Local fictional live-provider result |
| --- | --- |
| First agent audio ready / first browser playback | 15 ms / 30 ms |
| Caller speech start to finalized transcript | 1,302 ms, including the spoken phrase and turn detection |
| Evidence extraction | 1,280 ms |
| Takeover through both playback acknowledgments | 179 ms |
| Caller received nurse microphone | 656.25 Hz estimated, 660 Hz source |
| Nurse received caller microphone | 443.18 Hz estimated, 440 Hz source |
| Agent samples in takeover epoch | 0 in both browsers |
| Dropped frames | 0 in both browsers |
| Playback underruns | Caller 2; nurse 0 |

The [redacted fictional live proof](evidence/fictional-live-proof.json) preserves the call-level timings and per-browser audio counters without call or provider session identifiers. The test also generates a full local proof under ignored `output/playwright/results`. These timings reflect this local fixture and do not establish service latency bounds. A physical two-device test is still needed for audible quality, echo, permission and network behavior.

## Limits and remaining acceptance

Repeated browser runs reached the built-in 30-session/hour limit, and live attempts exhausted the local 120-minute audio reservation ledger. Only exhausted, released local synthetic-test counters and reservations were cleared; sessions, case content and production limits were preserved. Browser verification also exposed a missing favicon and a transient session-read failure that previously appeared as lost authentication; these were corrected. Arrival and call deadline now use the same timestamp. Concurrent standalone emulators also produced D1 internal errors, so the local runner now uses one shared multi-Worker runtime.

The default runtime is explicit mock mode. Deterministic tests require no provider credentials and the standard browser suite refuses live mode before enabling synthetic microphones. Local credential presence and stored-agent configuration are not live-provider verification. Mock intake uses the same collection and server tool checks, while supplying synthetic finalized transcripts and tone playback.

The opt-in live browser test uses synthesized fictional caller speech and a local-only `FICTIONAL_LIVE_TEST` gate to exercise the real providers while recording-retention controls remain unverified. This one run demonstrates the exercised AssemblyAI Voice Agent, Nemotron, extraction, playback and handoff path locally; it does not establish broad provider compatibility, reliability or production readiness. Production live activation remains blocked pending supported account recording-retention controls and independent production verification. The documented provider DELETE is soft deletion; mocked DELETE tests do not prove physical erasure or backup expiry. A connection failure before a session ID arrives may require manual provider-history reconciliation. See [Voice Agent integration](voice-agent.md).

Also pending: physical two-device audibility, echo, permissions, autoplay, interruption and constrained-network behavior; repeated live timing and reliability measurements; remote D1/R2/Access/Turnstile; staging/public deployment; and hackathon publishing materials. The [manual checklist](demo-script.md#manual-two-device-checks) is separate from fixture evidence. No clinical use, symptom-based emergency detection or telephony capability is claimed.

Retention and call-duration alarms are exercised with time controls, not a seven-day wall-clock run. Application deletion fences and provider soft deletion are distinct. WebSocket audio remains subject to TCP head-of-line blocking. No real patient data was used.
