# Deployment

Provisioning and public deployment are intentionally outside the completed repository task. These are operator instructions, not evidence of an existing cloud installation.

## Bindings and local runtime

Both Workers use `DB` for the same environment's D1 database and `EXPORTS` for the same private R2 bucket. Realtime owns `CALL_SESSIONS` and its SQLite class migration; web binds the exported CallSession class using `script_name`. Extraction uses Nebius Token Factory over server-side HTTPS. Web reads bindings using `getCloudflareContext` and uses Next's default runtime with OpenNext, not forced Edge runtime.

Local ports: web Workers preview 8787, realtime 8788, optional Next dev 3000. The preview runner uses one Wrangler multi-Worker runtime with a local-only gateway and a loopback proxy for realtime. D1/R2 share one emulator authority; do not run the two standalone Wrangler dev processes concurrently against the same SQLite directory. Application deployments remain two independent Workers. Persist the runtime and D1 migrations to repository `.local/state`; stop the preview before running database CLI mutations. Exact Origin allowlists must match the browser URL. Localhost is a browser secure-context exception for microphone use; device testing requires HTTPS.

## Staging order

1. Authenticate Wrangler in your own Cloudflare account. Create staging D1 with `wrangler d1 create nursebridge-staging` and private R2 with `wrangler r2 bucket create nursebridge-exports-staging`.
2. Replace staging IDs, web/realtime hostnames, and exact Origins in both Wrangler configurations. Bindings are explicitly repeated per environment. Never point staging at a production database or bucket.
3. Apply D1 migrations: `pnpm --filter @nursebridge/web exec wrangler d1 migrations apply DB --remote --env staging`.
4. Install both provider secrets only on realtime: `pnpm --filter @nursebridge/realtime exec wrangler secret put ASSEMBLYAI_API_KEY --env staging` and `pnpm --filter @nursebridge/realtime exec wrangler secret put NEBIUS_API_KEY --env staging`. Configure the versioned AssemblyAI Voice Agent using the explicit setup script described in voice-agent.md. No provider key belongs in browser code, Wrangler vars, or a URL.
5. Set optional Turnstile secret/site key on web and staff Access configuration if used. Configure R2 lifecycle expiry at seven days as defense against orphaned exports; application expiry also follows parent-case retention.
6. Deploy realtime first, then build and deploy web via OpenNext. `pnpm deploy --staging` rejects unresolved placeholders and performs migrations, realtime deploy, build, and web deploy.
7. Perform the live acceptance checklist before sharing a public demo. Disable test diagnostics for staging. Verify Voice Agent PCM24k configuration, Nemotron streaming/tools and independent schema extraction, and provider recording retention/deletion; configuration is not proof of provider availability.

Copy `.dev.vars.example` to `.dev.vars` only for local secrets. Git ignores actual `.dev.vars`; do not print or commit its contents. A new worktree must receive matching untracked environment files before live verification.

The default local configuration uses explicit mock mode and requires no paid provider access. Set both Workers to the same mode. `VOICE_AGENT_ID` and `VOICE_AGENT_VERSION` identify the stored configuration; `VOICE_AGENT_COMPATIBILITY_VERIFIED` reports a completed manual compatibility check but cannot bypass unverified recording controls. Normal live consent and provider startup both fail closed while that gate remains. For a fictional local compatibility test, realtime `FICTIONAL_LIVE_TEST=true` bypasses only recording-control and compatibility activation checks when every allowed Origin is an exact HTTP loopback origin; see voice-agent.md. It does not mark those checks verified and is ineffective with the staging Origin. Credentials are never presence-based evidence of working inference.

`EXTRACTION_MODEL` remains `nvidia/Nemotron-3_5-Lightning` at the fixed Nebius Token Factory endpoint. Conversation uses the same model through AssemblyAI's stored-agent BYO LLM integration. There is no fallback to another model or to mock results. The old Cloudflare `AI`, `TTS_MODEL`, and `TTS_SPEAKER` bindings have been removed. Run `pnpm setup:voice-agent` for a secret-free dry run; see voice-agent.md before any explicit remote setup.

Web quota variables are `MAX_ACTIVE_CALLS_PER_WORKSPACE=2`, `MAX_LIVE_CONCURRENCY=4`, and `DAILY_AUDIO_MINUTES=120`. Live calls reserve ten minutes conservatively; unused reserved daily minutes are not refunded, while concurrency is released when AI stops. Intake cannot restart after it enters waiting; a new fictional call is required. Realtime's `MAX_CALL_SECONDS=600` bounds the total synthetic call independently of seven-day case retention.

## Staff Access option

Use a hostname-based Cloudflare Access application for staff/admin traffic, with a restrictive identity policy. Configure an HTTPS `ACCESS_ISSUER` and exact `ACCESS_AUDIENCE`. Validate JWT signature against issuer JWKS, issuer, audience and expiry, then require workspace membership. A header's presence alone grants nothing. Do not put worker-level Access policies on the realtime upgrade endpoint; current Cloudflare documentation notes incompatibility with WebSocket upgrades. Caller access still uses scoped invitations and tickets.

## Rollback and operational limits

Worker rollback does not roll back D1, Durable Object storage or R2. Keep schema migrations additive and backward compatible; destructive DO class changes can block rollback. Use forward repair for incompatible data changes.

The ten-minute demo bound avoids reliance on indefinitely active objects. Outbound provider sockets incur duration charges. Inspect only content-free operational status and timing data. Projection errors are surfaced in the nurse workspace; they must not sever human audio. No `setInterval`, `next/after`, filesystem write or always-running Node daemon is used for durable production work.


Before changing an existing environment from the old provider pipeline, let active calls finish or expire. Upgrade code alone never turns legacy consent into recording consent. Call deadlines are authoritative and provider work stops during waiting. Keep rollout in mock mode until the live gates pass. No public deployment is performed by implementation tests.
