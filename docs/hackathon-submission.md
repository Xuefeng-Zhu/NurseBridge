# NurseBridge submission packet

Presentation packet prepared September 29, 2026 for the **AssemblyAI - Voice Agent Hackathon on LabLab**; source and submission status updated September 30. The saved LabLab draft now contains cover, video, PDF, and repository/application links. Final submission remains pending. The local assets listed below are the original preparation packet; the saved form uses the newer seven-page deck and 3:20 narrated prototype video.

## Copy for the submission form

### Project title

NurseBridge

### Short description

NurseBridge uses AssemblyAI Voice Agent to turn a fictional caller's story into an intake draft with supporting quotes, corrections, and uncertainty, then connects a nurse to the same audio session for human review.

### Long description

A nurse joining a call needs context: what the caller said, what changed, and what still needs clarification. NurseBridge explores how a voice agent can prepare that context while keeping a human responsible for the conversation.

In our fictional demonstration, a caller joins a queue and chooses whether to begin automated intake. AssemblyAI Voice Agent handles the spoken conversation. NurseBridge turns finalized caller statements into a structured draft with exact supporting quotes. If the caller corrects “yesterday” to “this morning,” the nurse can see the current answer and its revision history. Answers such as “I haven't checked my temperature” remain explicitly not measured. The system asks one clarification for an unresolved answer, then requests nurse help if the uncertainty remains.

The central interaction is human takeover. A nurse claims the call, enables audio, and joins the same session. NurseBridge clears queued agent audio and checks playback in both directions before showing the human connection as ready. The waiting period and nurse conversation are not forwarded to the AI provider. Callers who decline automated intake retain access to the nurse queue.

AssemblyAI provides the conversation and speech layer, configured with Nebius Nemotron-3.5-Lightning. A separate extraction step validates facts against finalized caller evidence. Next.js runs on Cloudflare Workers through OpenNext, and a Durable Object coordinates each call. D1 stores workspace records and projections, while private R2 storage holds case exports.

The browser workflow runs locally. A September 29 fictional local test exercised the real AssemblyAI and Nebius integration through transcript finalization, evidence extraction, an agent reply, and nurse takeover, with non-silent human-channel playback measured in both browser worklets. The supplied walkthrough was refreshed September 29 and is clearly labeled transcript replay with providers off. An optional Twilio inbound adapter is included in the source and has local protocol and browser audio test coverage; real telephone-network acceptance remains pending.

NurseBridge is a simulation using fictional information. It does not diagnose, recommend treatment, assess clinical urgency, or establish that waiting is safe. Public live AI remains blocked while provider recording controls and physical-device behavior await verification. Our next step is to validate the workflow with nurses using fictional scenarios and measure draft quality, correction handling, and handoff reliability before considering a clinical pilot.

### Technology and category tags

Suggested technology tags: AssemblyAI, Voice Agent, Nebius, NVIDIA Nemotron, TypeScript, Next.js, Cloudflare Workers, Durable Objects, D1, R2, Web Audio, WebSockets, Twilio.

Suggested category tags: Voice AI, Healthcare, Workflow Automation, Human-in-the-loop. Select the closest tags actually offered by the form.

## Product and judging narrative

**Target user:** a nurse reviewing an incoming caller's account. The eventual buyer hypothesis is an organization operating a nurse advice line. No customers, clinical partners, or interviews are claimed.

**Problem hypothesis:** useful intake context may be missing when a nurse joins. This project tests whether caller-supported notes can make that handoff easier to review. It does not claim measured reductions in workload or waiting time.

**Distinctive interaction:** source-backed draft fields, visible corrections and uncertainty, followed by takeover of the same audio session. Show the correction and takeover in the demo; these are more persuasive than a generic voice-chat introduction.

**Business hypothesis:** an organization subscription with usage-based voice charges could support the product after validation. Pricing, demand, market size, clinical workflow fit, and deployment requirements remain research questions. Do not invent TAM, adoption, revenue, or ROI numbers.

**Alternatives to compare in research:** manual intake notes, generic transcription, and fixed phone menus. The prototype combines a structured draft with a direct human handoff. This is a product design distinction, not a proven superiority claim against a named competitor.

**Next validation:** ask nurses to review fictional cases and compare the draft with source statements. Measure unsupported facts, correction fidelity, review time, and successful audible handoffs. Establish a baseline before claiming a benefit.

LabLab's general submission guide lists presentation, business value, application of technology, and originality. The copy above addresses those dimensions. No event-specific weights or scoring scale were available on the public event page.

## How AI and Codex were used

AssemblyAI Voice Agent is part of the active conversation path, covering speech input, turn detection, and generated speech. Its stored configuration uses Nebius Nemotron-3.5-Lightning for conversation. NurseBridge separately extracts structured facts from finalized caller turns and validates their supporting text. Server-side policy controls consent, clarification limits, waiting, and human takeover.

Codex assisted with implementation and debugging across the web app, realtime Workers, audio lifecycle, provider integration, and test harnesses. Repository tests and saved evidence support the engineering claims. The September 29 polish pass reran the local unit, Workers, tooling, build and browser checks. Its isolated browser suite kept providers off; separate saved evidence from September 29 records local real-provider acceptance before the latest polish changes. Do not publish private Codex conversation contents as submission evidence.

## Architecture summary

1. The caller browser sends microphone audio through the authenticated realtime connection to the call's Durable Object.
2. During consented automated intake, AssemblyAI Voice Agent handles conversation audio using the configured Nebius model.
3. Finalized caller turns feed independent extraction. Validated facts retain exact evidence and correction history.
4. The nurse sees queue state and the intake draft. Takeover stops provider forwarding, flushes agent playback, and establishes two-way human audio.
5. D1 holds workspace records and case projections. R2 holds private exports. Application case content has a seven-day retention policy; this is separate from unverified provider retention and deletion.

The optional phone adapter accepts signed Twilio events and translates phone audio into the same call workflow. It has local emulator coverage, not a verified deployed phone number.

## Files and links

| Item | Prepared asset or status |
| --- | --- |
| Asset bundle | [ZIP with deck, cover, form text, video, and captions](../artifacts/submission/nursebridge-submission-pack.zip) — presentation assets only, not application source |
| Form text | [Standalone copy file](../artifacts/submission/submission-copy.txt) |
| Source repository | [Xuefeng-Zhu/NurseBridge](https://github.com/Xuefeng-Zhu/NurseBridge) — **public**, verified September 30 through the GitHub API |
| Interactive application URL | [Hosted staging demo](https://nursebridge-web-staging.pullthread-commerce-worker.workers.dev/nurse) — reachable; successful end-to-end intake verification remains pending |
| Pitch deck | [PDF](../artifacts/submission/nursebridge-pitch.pdf) and [editable PowerPoint](../artifacts/submission/nursebridge-pitch.pptx) |
| Cover | [16:9 PNG](../artifacts/submission/nursebridge-cover.png) |
| Video | [nursebridge-demo.mp4](../artifacts/demo/nursebridge-demo.mp4) — refreshed September 29; 80 seconds, 1920 × 1080, H.264/AAC, embedded captions |
| Captions | [nursebridge-demo.srt](../artifacts/demo/nursebridge-demo.srt), also embedded in the MP4 |
| Saved LabLab video | [Uploaded 3:20 narrated prototype](https://storage.googleapis.com/lablab-video-submissions/submissions/v442vkpxphkzzfdbzwjx3155/s32sf6g6kmllg2bhee59rj1q/video/video_ox97hlbh8hs51e5bykqzd21z.mp4) — fictional transcript replay, providers off; saved September 30 |
| Video context | [Asset provenance and disclosures](../artifacts/demo/README.md) |
| Full demo walkthrough | [Two-browser steps](demo-script.md) |
| Presentation script | [Three-minute recording outline](submission-recording-script.md) |
| Engineering evidence | [Test results](test-results.md), [September 29 fictional live proof](evidence/polished-live-voice-2026-09-29.json), [local phone protocol proof](evidence/phone-protocol-proof.json) |

Phone support, persistent settings, and editable intake templates are merged into `main` via [PR #10](https://github.com/Xuefeng-Zhu/NurseBridge/pull/10). Each call keeps its original template version when an administrator publishes changes. The [source repository](https://github.com/Xuefeng-Zhu/NurseBridge) is **public**, verified through the GitHub API on September 30, 2026. The [hosted staging demo](https://nursebridge-web-staging.pullthread-commerce-worker.workers.dev/nurse) is reachable, but successful end-to-end intake still needs verification. Local staging and presentation changes have not all been published to `main`.

## Judge testing instructions

These are a local fallback, not a replacement for LabLab's requested interactive application URL.

Prerequisites: Node 24.14.1, pnpm 11.19.0, macOS/Linux/WSL, two separate browser profiles, and headphones for audible human relay. The isolated demo requires no AI or carrier credentials.

Run these commands from the source revision shared with judges. `pnpm demo` builds the app, migrates and seeds fresh temporary storage, and starts both Workers on loopback with providers off. It ignores local provider credentials and preserves the normal development database.

```sh
pnpm install --frozen-lockfile
pnpm demo
```

If ports 8787/8788 are occupied, run `NURSEBRIDGE_QA_WEB_PORT=8987 NURSEBRIDGE_QA_REALTIME_PORT=8988 pnpm demo` and use the printed workspace URL. Stop with Ctrl+C; the next run starts with fresh data. This loopback-only session is for an in-person or screen-shared demo, not a public submission URL.

1. Open the printed workspace URL (by default `http://localhost:8787/workspace`). Create a local isolated workspace and keep the nurse workspace in that browser.
2. Redeem the caller invitation in a separate browser/profile. Join the queue, then accept the fictional-intake disclosure.
3. Use the visible **mock** scenario controls to replay fictional intake. They insert transcript fixtures; they do not transcribe the microphone. Mock agent output is a tone with text captions.
4. Open the nurse draft and inspect supporting quotes. Replay the correction from “yesterday” to “this morning,” then inspect revision history.
5. Show an explicitly not-measured or uncertain answer. For the takeover demonstration, stop before repeating an unresolved answer so the agent's first clarification cue is still playing.
6. Enable microphone and playback in both browsers. Claim and take over the call during that cue. Confirm the human connection and listen in both directions.
7. In a separate fictional call, repeat an unresolved answer after its one clarification. Confirm the caller waits for nurse help and automated intake has stopped.
8. End the calls. Optionally export and delete the fictional cases using authorized controls.

For deterministic automated browser and phone checks, run `pnpm exec playwright install chromium`, then `pnpm test:e2e`. If the demo already uses ports 8787/8788, use `NURSEBRIDGE_QA_WEB_PORT=8987 NURSEBRIDGE_QA_REALTIME_PORT=8988 pnpm test:e2e`. This isolated harness uses synthetic microphones and a Twilio protocol emulator; it does not place a real phone call or use AI credentials. Installed Chrome is also supported with `PLAYWRIGHT_CHANNEL=chrome`.

## Proof and claim boundaries

| Claim | Evidence and scope |
| --- | --- |
| Local workflow and regression coverage | The September 29 polish pass passed 168 unit tests, 177 Workers tests, 19 tooling tests and 29 browser tests, with 1 opt-in live-provider test skipped. Typecheck, lint and the production build also passed. Browser coverage includes desktop/mobile recovery, queue refresh, settings draft preservation, terminal calls, takeover revision races and phone protocol audio. |
| AssemblyAI integration exercised | The September 29 local real-provider acceptance on source `743cce2` completed in 30.8 seconds: one finalized caller turn, one evidence-linked fact, a subsequent agent reply, non-silent human-channel playback in both browser worklets after takeover, and successful case/provider cleanup. This run covers the final audio recovery fixes; a single fictional observation does not establish ongoing availability or broad accuracy. |
| Human relay | Local fixture audio tests exercised microphone capture, transport, and receiving worklets in both directions, with zero stale agent samples in the captured takeover proofs. Physical-device audibility is still a separate check. |
| Optional inbound phone | Local signed protocol-emulator and browser tests exercised phone-to-nurse relay. No PSTN call, owned number, or live carrier deployment was verified. |
| Demo video | An 80-second narrated montage refreshed September 29 from the polished local application, including the current active-call controls; explicitly labeled transcript replay with providers off. It is not a recording of live speech recognition or an audible human conversation. |

Public AI is blocked pending recording-control and compatibility acceptance. The hosted staging URL is reachable, but its complete intake workflow remains unverified. Clinical validation, compliance certification, measured clinical benefit, and real telephone-call acceptance remain pending. The submission screenshots were refreshed September 29 against the polished local app; their mode labels remain visible.

## Screenshots and captions

Use fictional data and retain visible mock labels. Omit invitation URLs and private debug information from shareable captures.

1. [Workspace](../artifacts/demo/workspace-ready.png): “Create an isolated workspace for a fictional intake demonstration.”
2. [Caller intake](../artifacts/demo/source/caller-intake.png): “The caller joins the nurse queue before choosing automated intake. Shown in mock replay mode.”
3. [Evidence and correction](../artifacts/demo/source/nurse-evidence.png): “The draft preserves the caller's correction and its supporting words, with uncertainty visible for human review.”
4. [Human handoff](../artifacts/demo/source/human-handoff.png): “The nurse joins the existing audio session and automated forwarding stops. Screenshot from local mock testing.”

For a gallery, use the refreshed September 29 captures and keep the key evidence and active-call controls legible. Screenshots show the observed local UI; the separate test evidence supports persistence and audio claims.

## Official requirements checked

Sources rechecked September 29, 2026 through the rendered official pages:

- [AssemblyAI event page](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon): the live page shows a submission deadline of **September 30, 2026, 8:00 AM PDT** (15:00 UTC), a September 1–30 build window, and AssemblyAI as the required technology.
- [LabLab submission guide](https://lablab.ai/delivering-your-hackathon-solution): short description up to 255 characters; long description at least 100 words; technology/category tags; PNG/JPG cover; MP4 video at most five minutes; PDF slides; source repository and interactive app URL.
- [LabLab rule book](https://lablab.ai/hackathon-rules): specifies a 16:9 cover, MP4/PDF formats, public GitHub source, and an interactive application URL.
- [LabLab general guide](https://lablab.ai/guide): registration and team membership apply even to solo entrants.

The signed-in event form was reviewed September 30. It has three steps, accepts “Other” as the demo platform, and shows all required fields filled at 100%. Cover, MP4, PDF, and repository/application links are saved. Final entry and any eligibility or rule acceptance remain separate actions. General LabLab guidance contains IBM Bob and hosting language that was not confirmed as an AssemblyAI-specific requirement; no IBM Bob usage or report is claimed.

## Remaining actions before final entry

- [x] Inspect the signed-in LabLab form and its required fields. The saved form was reviewed September 30.
- [ ] Confirm any eligibility and rule agreements required by the final entry step.
- [x] Make the source repository public. GitHub visibility was verified September 30; phone support, settings, and editable intake templates are merged into `main`.
- [ ] Publish the intended reviewed staging and presentation changes that remain local.
- [ ] Complete hosted demo acceptance at the linked staging URL: verify anonymous entry, intake transcript and draft, settings, export, and handoff. Reachability is confirmed; successful intake remains pending. Public live AI also needs the documented recording and device acceptance work.
- [x] Review the saved deck, cover, copy, and 3:20 transcript-replay video. The uploaded files match the intended assets and their rendered presentation was checked September 30; actual voice-provider behavior remains separate evidence.
- [x] Save the MP4, PDF, cover, and repository/application links in the event form.
- [ ] Submit the final entry after resolving the hosted-demo acceptance issue, then verify the submission receipt.

Local preparation is ready for review once the linked artifacts are present. Submission readiness still depends on the access, hosting, and event-form checks above.
