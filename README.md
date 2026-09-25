# NurseBridge

An operational voice-call demonstration: a fictional caller tells their story, an automated assistant prepares an evidence-linked intake draft, and a nurse joins the same audio session. Callers can use a browser or an operator-configured Twilio phone number.

**Simulation only — use fictional patient information. Not for medical care.** This demo does not diagnose, recommend treatment, assess urgency, or determine that waiting is safe. For a real emergency, contact emergency services.

## Run locally

Requires Node 24.14.1 and pnpm 11.19.0.

```sh
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open http://localhost:8787/demo. Create an isolated workspace, copy a caller invitation into a separate browser/profile, and open the nurse workspace in the first browser. Enable audio in each browser with its visible control. Use headphones.

The default is explicitly labeled **mock mode**. Scenario buttons insert fictional transcript fixtures; they do not claim speech recognition. Microphone capture, audio framing, WebSocket relay, playback, and handoff still run through the real browser/Workers audio path. Mock agent output is an audible synthetic test tone with approved text captions, not fake synthesized speech.

The Voice Agent integration replaces the previous standalone STT/Aura-2 pipeline. AssemblyAI handles conversation audio; Nebius Nemotron-3.5-Lightning is configured for both conversation and independent evidence extraction. The Cloudflare Workers AI binding is no longer needed.

The AI collects information only. Every completed caller stays connected for a nurse. Each unresolved answer gets one clarification; if it remains unresolved, intake stops and requests nurse help. Explicit human requests, explicit emergency statements, consent refusal and technical failures also retain human access. The demo does not infer emergencies from symptoms.

**Public live AI activation is currently blocked.** One fictional local browser call exercised the configured AssemblyAI Voice Agent, Nebius model, evidence extraction, and nurse handoff. Provider recording retention controls and physical-device behavior remain unverified, so keys alone cannot bypass the public recording gate. See [Voice Agent integration](docs/voice-agent.md) and [test results](docs/test-results.md). The default local configuration runs without provider credentials or paid calls.

Live fictional intake requires separate recording consent. Provider recordings are permitted for the automated portion only; the waiting period and nurse conversation are not forwarded to the Voice Agent. Application case content expires after seven days. Provider deletion and retention are reported separately.

Optional [inbound phone support](docs/phone-inbound.md) routes a Twilio number into the same nurse queue and carries audio between the telephone and nurse browser. Phone-to-nurse calls work while AI activation remains blocked; callers hear that automation is unavailable. Phone support is disabled by default and requires an owned number, server secrets, HTTPS deployment and a real-number acceptance test. Mock AI mode does not eliminate carrier charges.

## Commands

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:workers
pnpm build
pnpm preview
pnpm exec playwright install chromium
pnpm test:browser
PLAYWRIGHT_CHANNEL=chrome pnpm test:phone
pnpm bindings
```

`dev` and `preview` build the real Next.js/OpenNext artifact and start both Workers in one shared local runtime. A local-only gateway/proxy preserves web port 8787 and realtime port 8788 while D1/R2 each have one emulator authority. `dev:next` provides optional fast UI development on port 3000; it is not runtime acceptance evidence. Local D1 and R2 use `.local/state`. No case content belongs in localStorage or source control.

Install Playwright Chromium once before browser tests, or use an installed Chrome with `PLAYWRIGHT_CHANNEL=chrome pnpm test:browser`. The development servers must be running while browser tests execute. The suite refuses live provider mode before enabling synthetic microphones.

`test:phone` builds and starts its own isolated mock Workers runtime, tests a simulated Twilio call against a real nurse browser, and stops the runtime afterward. Stop any existing local dev server on ports 8787/8788 first. It uses no real carrier or AI credentials and preserves its temporary evidence directory. Add `-- --all` to include the full browser suite.

## Structure

- `apps/web`: Next.js App Router, business HTTP endpoints, session authorization, UI.
- `apps/realtime`: CallSession Durable Object, authenticated WebSockets, provider adapters, durable projections.
- `packages/contracts`, `audio-client`, `intake-policy`, `database`: shared boundaries, DSP, bounded intake policy, D1 schema.
- `tests/fixtures`: exclusively fictional transcript/audio fixtures.

Read [architecture](docs/architecture.md), [safety and privacy](docs/safety-and-privacy.md), [demo script](docs/demo-script.md), [compatibility](docs/compatibility.md), and [test results](docs/test-results.md).

Watch the [80-second narrated demo](artifacts/demo/nursebridge-demo.mp4). It uses synthetic information and explicitly labeled mock transcript replay; [captions and source notes](artifacts/demo/README.md) are included.

This repository is deployable; no public deployment, real clinical authentication, verified PSTN call, or medical validation is implied. The implementation result and remaining live checks are recorded in test-results.md.
