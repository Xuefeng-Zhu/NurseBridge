# Inbound phone calls

NurseBridge can receive a Twilio Voice call and connect its audio to a nurse in the existing browser workspace. The caller needs an ordinary telephone. The nurse uses the existing microphone, queue, claim and end-call controls.

The carrier connection is independent of automated intake. When live AI is unavailable or its recording checks have not passed, callers hear that limitation and enter the human queue. If automated intake is unavailable, callers are routed to a person without generated responses. Pressing 0 requests a person. When live AI is fully enabled, a spoken disclosure asks for DTMF 1 to accept automated intake and possible provider recording; 0, another digit or timeout routes to a person.

## Operator setup

1. Deploy web and realtime to your own HTTPS hosts following [deployment](deployment.md), including D1 migration `0002_phone_inbound.sql`. Both Workers must share the same D1 database. Keep the realtime Worker’s `nodejs_compat` flag; webhook authentication uses the official Twilio SDK.
2. Complete the managed staff and workspace provisioning requirements in [production readiness](production-readiness.md) before enabling a hosted phone route. Public workspace creation is disabled on hosted environments. Staff need an authorized workspace membership and a verified Access identity; no managed provisioning or renewal flow is implemented yet. Do not use test cookies or database seeding as production onboarding. For local protocol tests, the isolated harness provisions test fixtures automatically. Existing sessions expire after four hours and workspaces after seven days. Once a supported hosted workflow exists, Settings exposes **Workspace ID for phone routing** to the workspace administrator.
3. Configure these **realtime** variables for the intended environment. Numbers below are examples; use your own Twilio Voice-capable number in E.164 format and the workspace ID from step 2.

   ```json
   {
     "PHONE_INBOUND_ENABLED": "true",
     "TWILIO_ACCOUNT_SID": "AC...",
     "TWILIO_PUBLIC_ORIGIN": "https://realtime.example.com",
     "TWILIO_INBOUND_ROUTES": "{\"+15551234567\":\"your-workspace-uuid\"}",
     "PHONE_MAX_CONCURRENT": "2",
     "PHONE_DAILY_MINUTES": "60",
     "MAX_ACTIVE_CALLS_PER_WORKSPACE": "2"
   }
   ```

   `TWILIO_PUBLIC_ORIGIN` is the exact public realtime origin without a path or trailing slash. Match workspace limits between web and realtime. Number routing is operator-owned server configuration; a workspace member cannot assign the workspace someone else’s phone number. Settings reports configuration presence, not a verified route or telephone call.
4. Store the matching account’s auth token as a realtime secret, never in source or the browser:

   ```sh
   pnpm --filter @nursebridge/realtime exec wrangler secret put TWILIO_AUTH_TOKEN --env staging
   ```

5. In the owned number’s Twilio Voice configuration, set **A call comes in** to a POST webhook at `https://realtime.example.com/phone/twilio/voice`. Set the call status callback to POST `https://realtime.example.com/phone/twilio/status`. Ensure Twilio can reach these endpoints and `/phone/connect/*` without a browser login or Cloudflare Access challenge; each request is independently authenticated. The consent action URL is generated automatically.
6. Deploy the updated realtime configuration, call the number with test data, select the phone case in the nurse browser, enable audio, and claim it. Verify speech in both directions, DTMF 0, caller hangup, browser End call, and terminal status delivery before sharing the number. Confirm the call is completed in Twilio after each test.

Setting `PROVIDER_MODE=mock` disables paid AI, **not carrier charges**. An enabled real phone number still uses Twilio. Phone-to-nurse operation does not require enabling live AI. Automated intake additionally requires the existing [Voice Agent activation and recording checks](voice-agent.md); the local `FICTIONAL_LIVE_TEST` bypass does not enable public phone AI. This integration does not request Twilio call recording or dial outbound numbers.

## Call behavior and limits

- Arrival creates one case before consent. Signed webhook retries reuse its original workspace, template, participant and arrival time. Phone cases are labeled **Phone caller** in the nurse queue. The application does not store the caller’s `From` number.
- Twilio’s 8 kHz mono G.711 μ-law audio is converted to the application’s 24 kHz PCM stream, and nurse audio is converted back. Takeover clears queued phone output, waits for a new playback marker, then requires playback acknowledgments in both directions before showing Connected.
- Phone concurrency is reserved until the carrier confirms termination. Waiting and nurse conversations continue to occupy a telephone slot. Daily minutes reserve the configured maximum call duration conservatively and are not refunded. Browser and phone arrivals share the workspace call limit; live AI has a separate budget.
- The application ends media at `MAX_CALL_SECONDS`, at most 600 seconds, and requests carrier hangup. Media failure or Durable Object restart also requests termination. App-initiated hangup uses Twilio’s existing-call completion API with durable retries; carrier failures can extend billable time until termination is confirmed. A signed terminal callback or authenticated stream stop releases the reservation.
- A failed termination remains reserved until confirmed. Check Twilio’s call state and webhook delivery when a slot remains occupied; do not blindly clear active reservations. Setting inbound enabled to false rejects all phone endpoints, including status callbacks, so drain calls before disabling it.
- D1 keeps a minimal provider call receipt and quota ledger to reject late replay and account for reservations. Deleting a case removes its content, stored template and consent decision; the receipt retains provider/account/call identifiers, routing hashes and timestamps. Outstanding carrier cleanup retains only the identifiers it needs until termination succeeds. This is distinct from provider retention and the application’s seven-day case content policy.

## Verification boundaries

Automated tests validate signed webhook routing, isolated quotas, replay rejection, consent behavior, lifecycle cleanup, codecs and a local Twilio protocol test stream connected to a real Chrome nurse microphone/playback path. They do not place a PSTN call, verify an owned number, deploy a public endpoint, or establish physical-device audio quality. See [test results](test-results.md) for executed evidence.

Run `PLAYWRIGHT_CHANNEL=chrome pnpm test:phone` with ports 8787/8788 free, or choose separate ports with `NURSEBRIDGE_QA_WEB_PORT=8987 NURSEBRIDGE_QA_REALTIME_PORT=8988`. The harness builds the app, migrates a fresh temporary database, seeds a test staff session and route, starts the isolated Workers runtime, runs the phone browser test and stops its own services. Add `-- --all` for the full browser suite or `-- --skip-build` only after building the current source. Its temporary directory preserves logs, screenshots and audio measurements.

The underlying `tests/browser/phone.spec.ts` is opt-in (`NURSEBRIDGE_PHONE_E2E=1`) and refuses non-loopback or live-AI targets. The QA runtime binds `TWILIO_HTTP` to a local completion stub so failure cleanup cannot reach the carrier. Production uses the fixed Twilio API endpoint and must not bind this test service.

Protocol references: [Twilio Media Streams messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages), [Stream TwiML](https://www.twilio.com/docs/voice/twiml/stream), [webhook security](https://www.twilio.com/docs/usage/security), and [Call resource](https://www.twilio.com/docs/voice/api/call-resource).
