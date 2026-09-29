# Test results

## Demo and recovery polish verified on 2026-09-29

The review branch based on `main` at `4ffafcb` includes bounded API requests, retryable workspace and case loading, serialized queue polling, isolated queue/detail failures, settings draft protection, accessible error/loading/not-found pages, and mobile layout improvements. Realtime recovery preserves closed calls and explicitly re-establishes human media after a disconnect without automatically returning audio to AI providers. Thirteen new Workers regressions cover these lifecycle fixes.

Two additional timing defects were reproduced before repair: a caller action between the nurse's read, claim and takeover left the case waiting or claimed; a one-second microphone delivery backlog disconnected a valid 20fps stream. Takeover now refreshes and retries once only after a confirmed revision rejection, preserving ownership and cancellation and never retrying an ambiguous write. Audio now permits a bounded 20-frame backlog while limiting sustained capture to 20fps. Nine Workers regressions verify jitter, excessive traffic, clock rollback, stale frames and replacement sockets.

| Executed check | Result |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` | Pass |
| `pnpm test` | 165 tests pass in 12 files |
| `pnpm test:workers` | 173 tests pass in 9 files |
| `pnpm test:tooling` | 19 tests pass |
| `pnpm build` | Audio worklets and Next.js/OpenNext Worker pass |
| Isolated `pnpm test:e2e --skip-build` | 29 pass in 59.6 seconds; 1 opt-in live-provider test skipped |
| `pnpm demo --skip-build` on ports 8899/8900 | Fresh local runtime starts, workspace creation and fictional replay produce a nurse draft |
| `git diff --check` | Pass |

The final browser suite passed against the current built app, including stale queue/detail responses, outage recovery, retained invitation retries, settings drafts, takeover revision races, two-way fake microphones, mute/unmute, and signed local phone-protocol emulation. An earlier integrated run exceeded the shared local client's 30-enrollment hourly quota after the two new scenarios added four sessions. Those scenarios now use separate documentation IP identities only on exact loopback URLs; the unchanged production limiter remains exercised. This is local mock evidence; no PSTN call, new live-provider call or hosted deployment was exercised by this polish pass. The separate September 29 live-provider measurements below predate these final lifecycle changes and do not reverify them against providers.

Remote `main` had a failed [Verify run 36542985041](https://github.com/Xuefeng-Zhu/NurseBridge/actions/runs/36542985041): static tests/build passed, but browser tests had an observation race during queued agent playback and a post-unmute audio dropout. The queued-playback assertion now checks both measurements in one snapshot. The first polish revision `98c75da` passed those audio assertions remotely but failed takeover, staying WAITING in [PR run 36547001172](https://github.com/Xuefeng-Zhu/NurseBridge/actions/runs/36547001172) and CLAIMED in [push run 36546985432](https://github.com/Xuefeng-Zhu/NurseBridge/actions/runs/36546985432). Both revision races were reproduced locally before the repair above. The jitter defect was independently reproduced; it is not established as the cause of the older post-unmute failure.

CI successfully retained its allowlisted failure JSON in both remote runs. It now includes test locations/statuses/timing, numeric audio/state diagnostics, and known takeover status/error codes. Raw reports, screenshots, session cookies, traces, URLs and raw errors are excluded. Sanitization and recovered-conflict console handling have unit coverage. See [PR #10 checks](https://github.com/Xuefeng-Zhu/NurseBridge/pull/10/checks) for remote verification of subsequent revisions; the table above records local verification.

The refreshed 80-second narrated mock walkthrough, editable seven-slide deck, selectable-text PDF and cover use current UI screenshots. These assets describe fictional data and distinguish transcript replay from the earlier local real-provider evidence. `pnpm demo` runs a fresh loopback-only mock runtime without reading provider credentials; it is a rehearsal tool, not a hosted judge URL. Source publication, hosted identity/provider gates, physical devices, real telephone acceptance and the event's signed-in submission form remain outstanding.

## Normal local app enabled and verified on 2026-09-29

The app at `http://localhost:8787` now runs in live provider mode using ignored local configuration; its health endpoint reports live activation ready. The local-only acceptance exception is enabled on exact loopback origins. Hosted activation checks and recording-control verification flags remain unchanged. The caller screen is ready to start a new call, and the configuration persists across `pnpm dev` restarts.

`NURSEBRIDGE_BASE_URL=http://localhost:8787 NURSEBRIDGE_LIVE_E2E=1 pnpm exec playwright test tests/browser/live.spec.ts --workers=1 --reporter=list` passed in **30.1 seconds** against that normal app, using the installed Playwright headless shell. The browser and runner exited automatically. Branded Chrome's updater delay from the earlier run is avoided by leaving `PLAYWRIGHT_CHANNEL` unset.

| Live-call check | Observed result |
| --- | --- |
| First agent audio ready / playback | 966 ms / 983 ms |
| Final caller transcript | 1 turn; 1,305 ms from speech start |
| Evidence-linked extraction | 1 fact; 1,341 ms |
| Agent response after the caller's finalized turn | Passed; 2 assistant turns recorded |
| Nurse takeover | 137 ms |
| Human audio after takeover | Both receiving worklets rendered non-silent audio above RMS 0.02 |
| Stale agent samples after takeover | 0 in both receiving proofs |
| Dropped frames | 0 in both receiving proofs |
| Playback underruns | Caller 3; nurse 0 |
| Case and provider cleanup | Deleted/closed; no pending provider deletions or unresolved connections |

The [redacted local live evidence](evidence/local-live-voice-2026-09-29.json) contains the measurements and cleanup receipt. The live test now waits for an agent reply after caller speech and non-silent playback in each handoff direction, so silent PCM no longer satisfies the handoff check. The visible local workspace reports Live provider mode, and its caller page presents an enabled Join call queue action. That caller screen was visually inspected at 1280×720 with no framework overlay or browser console errors.

Restored calls retain their original mode. A caller UI fix uses the saved mode for disclosures and shows end/restart guidance if the runtime has changed modes; it disables incompatible automation while retaining human and end-call controls. Both isolated browser regressions passed in 2.9 seconds, with no console or page errors and no provider calls. The web typecheck, focused ESLint, rebuilt OpenNext bundle, and `git diff --check` passed.

This verifies the local browser voice path with recorded microphone inputs. Physical-device audibility, echo, PSTN delivery, hosted operation and production recording controls remain separate acceptance work. No deployment was performed.

## Live voice verification on 2026-09-29

The live browser acceptance test passed against an isolated local Workers runtime using the configured AssemblyAI Voice Agent and Nebius extraction service. A repository speech recording entered through Chrome's microphone capture and the application's audio transport. The agent returned audio, one caller turn was finalized, one intake fact linked to exact transcript evidence, and three assistant turns were recorded. Nurse takeover completed and both receiving AudioWorklets consumed human-channel PCM with zero stale agent samples.

| Measurement | Observed result |
| --- | --- |
| First agent audio ready / browser playback | 1,023 ms / 1,065 ms |
| Speech start to finalized transcript | 1,210 ms |
| Evidence extraction | 1,434 ms |
| Nurse takeover through both playback acknowledgments | 148 ms |
| Caller / nurse human-channel samples after takeover | 10,240 / 3,328 |
| Stale agent samples after takeover | 0 in both browsers |
| Dropped frames | 0 in both browser snapshots |
| Playback underruns | Caller 2; nurse 0 |

The command was `NURSEBRIDGE_BASE_URL=http://localhost:8987 NURSEBRIDGE_LIVE_E2E=1 PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test tests/browser/live.spec.ts --workers=1 --reporter=list`. Call assertions completed in 34 seconds. The runner reported **1 passed** after 2.7 minutes: Chrome's background update helpers inherited the test's stderr and delayed shutdown until those identified helper processes were stopped. An earlier attempt passed the call assertions but timed out during browser teardown. The test now owns its browsers directly, stops capture before closing them, and deletes its case during cleanup; automatic Chrome helper shutdown remains an environment limitation.

Both attempts' cases were deleted through the authenticated admin API and subsequently returned HTTP 410. Read-only inspection of their local Durable Object stores confirmed closed/deleted state, no pending provider deletions and no unresolved provider connections. The provider adapter removes deletion work only after the provider returns HTTP 204 or 404. This verifies logical deletion acceptance, not physical erasure or backup expiry. The isolated runtime was stopped and its temporary credential copy removed. The user's local app remains available separately in transcript-replay mode.

The [redacted verification evidence](evidence/live-voice-verification-2026-09-29.json) preserves timings, playback counters and cleanup results without call identifiers, provider session identifiers or credentials. These are local observations, not latency guarantees. The nurse playback snapshot had zero RMS, so this run proves human-channel PCM transport but does not establish sustained audible caller speech after takeover. Physical audibility, intelligibility, echo, PSTN delivery and production account controls remain unverified.

## Production foundation verified on 2026-09-29

This revision replaces event-oriented project presentation with product documentation, a workspace guide, release checks and operator runbooks. It remains pre-production; the [release requirements](production-readiness.md) are explicit.

| Executed check | Result |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` | Pass |
| `pnpm test` | 132 tests pass, including 46 staff authentication regressions |
| `pnpm test:workers` | 151 tests pass |
| `pnpm test:tooling` | 19 tests pass: deployment guards and mocked provider setup |
| `pnpm build` | Audio worklets and Next.js/OpenNext bundle pass |
| `pnpm bindings` | Both Worker binding types regenerated |
| `NURSEBRIDGE_QA_WEB_PORT=8987 NURSEBRIDGE_QA_REALTIME_PORT=8988 PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e` | 14 pass; 1 live-provider test skipped; isolated runtime exits successfully |
| Production preflight on the supplied templates | Rejects unresolved resource and Access placeholders, as intended |
| `git diff --check` | Pass |

Authentication tests verify actual RSA signatures against synthetic JWKS and use an in-memory SQLite database for real session/invitation queries. Coverage includes expired/wrong-issuer/wrong-audience/malformed tokens, missing claims, disabled and non-loopback enrollment, caller invitations without staff identity, rejected staff redemption without consuming the token, and concurrent single-use redemption. This does not verify a deployed Access policy or establish identity-bound organization membership.

Deployment tests reject insecure origins, mismatched or shared resources, test controls, credentials in variables and unsupported limits. Build/dry-run failures, signals and spawn failures stop later steps before remote mutations. No deployment was performed. The new GitHub Actions workflow is configured; its remote execution and branch protection remain unverified.

Browser acceptance used the rebuilt mock Workers runtime with synthetic credentials on ports 8987/8988. It covered the workspace redirect, enrollment and staff navigation at desktop 1440×1050 and mobile 390×844, closed-enrollment guidance, existing intake/recovery/privacy flows, and signed phone protocol audio. No unexpected page or console errors occurred in the workspace flow; the initial unauthenticated session HTTP 401 is expected. Real provider calls, PSTN, physical devices and production account controls were not tested in this run.

## Inbound phone implementation verified on 2026-09-24

Twilio inbound integration now connects a telephone media stream to the existing case, nurse queue and browser audio path. All verification in this section uses fictional local fixtures. No Twilio number was provisioned, no PSTN call was placed, no live AI was enabled, and nothing was deployed. [Operator setup](phone-inbound.md) documents the remaining number, credentials, HTTPS and real-call acceptance steps.

| Executed check | Result |
| --- | --- |
| `pnpm typecheck` and `pnpm lint` | Pass |
| `pnpm test` | 86 tests pass |
| `pnpm test:workers` | 151 tests pass |
| `pnpm test:voice-agent-setup` | 4 mocked tests pass |
| `pnpm build` | Next.js/OpenNext and audio worklet builds pass |
| `pnpm --filter @nursebridge/realtime build` | Worker dry-run bundle passes; nothing deployed |
| `PLAYWRIGHT_CHANNEL=chrome pnpm test:phone -- --all` | 12 pass, 1 live-provider test skipped; 1.1 minutes; harness exits successfully |
| `git diff --check` | Pass |

Phone regressions cover signature validation against the configured origin, altered/ambiguous/oversized webhooks, stable concurrent admission, shared workspace limits, phone and AI budgets, consent refusal and unavailable-AI routing, short-lived single-use stream tokens, immediate media after authentication, media format and identity checks, playback barriers, DTMF 0, final filtered audio-tail playback, terminal callbacks, hangup retries, deadline, restart and deletion. A deterministic test holds the first D1 projection while five duplicate arrivals wait; all five receive one stable successful case. A post-delete ringing callback cannot confirm carrier termination; a signed completed event can finish cleanup even after the template is scrubbed.

The browser phone test connects a signed local Twilio protocol emulator to an actual Chrome nurse microphone and AudioWorklet. It holds carrier playback receipts and verifies that neither a clear nor one-way playback alone marks the call Connected. It verifies both audio directions, CLOSED cleanup of the microphone and AudioContext, phone labels, mobile layout and Settings routing information. This is a protocol emulator, not telephone-network or physical-device proof.

The saved [redacted phone audio proof](evidence/phone-protocol-proof.json) measured 438.83 Hz at the nurse from the 440 Hz phone fixture and 660.00 Hz at simulated phone playback from the 660 Hz nurse microphone fixture. The nurse worklet consumed 39,680 human samples with zero stale agent samples, dropped frames or underruns in that capture. Desktop, 390px mobile and Settings screenshots were inspected. These are local fixture observations, not real-call quality or latency guarantees.

The reproducible `test:phone` command uses a fresh temporary D1/R2/DO runtime, synthetic account credentials and a local carrier-completion service. Its mock-mode and workspace checks run before media starts. Existing local data and `.dev.vars` are preserved. Phone service is disabled by default. Public AI activation remains subject to the separate recording and compatibility checks described below; phone-to-nurse routing does not bypass them.

An initial full browser run passed its assertions but stalled during macOS Chrome teardown because crash helpers retained a stderr pipe. Test launches now disable crashpad with Chromium's test-only flag; the complete rerun exited successfully and stopped its local services. The final screenshots, HTML report and logs are in `/var/folders/0k/rqgj4mxn54j3_78wyykw4xnh0000gn/T/nursebridge-phone-qa-22Om1P`. The harness prints a new private temporary artifact directory each run.

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

Also pending: physical two-device audibility, echo, permissions, autoplay, interruption and constrained-network behavior; repeated live timing and reliability measurements; remote D1/R2/Access/Turnstile; staging/public deployment; and hackathon publishing materials. The [manual checklist](demo-script.md#manual-two-device-checks) is separate from fixture evidence. No clinical use, symptom-based emergency detection or verified PSTN delivery is claimed. Optional inbound phone implementation and its separate local evidence are described above.

Retention and call-duration alarms are exercised with time controls, not a seven-day wall-clock run. Application deletion fences and provider soft deletion are distinct. WebSocket audio remains subject to TCP head-of-line blocking. No real patient data was used.
