# Deployment

NurseBridge runs as two Cloudflare Workers with a shared D1 database and private R2 bucket per environment. The web Worker serves the application through OpenNext; the realtime Worker owns the SQLite-backed `CallSession` Durable Objects and provider connections. Web accesses realtime through a service binding and the exported Durable Object class.

Deployment tooling validates configuration and release artifacts. It does not establish service availability, provider privacy controls, or authorization to process patient information. Complete the [production readiness requirements](production-readiness.md) before processing patient information.

## Environments

| Environment | Purpose | Data and access |
| --- | --- | --- |
| Local | Development and deterministic tests | Providers disabled, loopback-only workspace enrollment, isolated emulator storage |
| Staging | Hosted integration and acceptance | Separate D1/R2 resources, authenticated staff, diagnostics disabled |
| Production | Controlled releases after acceptance | Separate resources and secrets, managed staff access, documented operating ownership |

The checked-in hosted configurations contain placeholders. They are templates, not provisioned environments. Configure both `apps/web/wrangler.jsonc` and `apps/realtime/wrangler.jsonc` for the selected environment. Bindings and variables must be repeated explicitly; do not assume local bindings carry into a named environment.

## Local development

Use the Node and pnpm versions declared in the root `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The runner builds the application and starts one multi-Worker runtime: web at `http://localhost:8787`, realtime at `ws://localhost:8788`. It shares a single emulator authority for D1/R2/DO storage in `.local/state`. Stop the runner before database CLI mutations. Running separate Wrangler processes against that directory can cause database errors.

Local workspace enrollment requires `ALLOW_LOCAL_SANDBOX_ENROLLMENT=true`, no Access issuer/audience configuration, a canonical HTTP loopback `APP_ORIGIN`, and an actual request from that same origin. The flag cannot enable enrollment on a hosted URL.

Copy the appropriate `.dev.vars.example` to `.dev.vars` only when provider testing needs local secrets. Actual environment files are ignored by Git. Copy matching untracked environment files into a new worktree before credential-dependent verification; never print their values. The default local workflow needs no paid provider credentials. Device microphone tests require HTTPS.

## Prepare a hosted environment

1. Provision a D1 database and private R2 bucket for the environment in the intended Cloudflare account. For staging, the names in the templates are `nursebridge-staging` and `nursebridge-exports-staging`; use separate resources for production.
2. Replace the selected environment's resource IDs and hostnames. Both Workers must reference the same environment's D1/R2 resources. Web's `REALTIME` service and `CALL_SESSIONS.script_name` must identify that environment's realtime Worker.
3. Set `APP_ORIGIN` to the exact HTTPS web origin and `REALTIME_URL` to the exact WSS realtime origin. Set realtime `ALLOWED_ORIGINS` to exactly the web origin. Set `PROVIDER_MODE=live` on both Workers; hosted replay responses are rejected by preflight. Set `ALLOW_TEST_DIAGNOSTICS=false` and `FICTIONAL_LIVE_TEST=false` on both, and `ALLOW_LOCAL_SANDBOX_ENROLLMENT=false` on web. Match positive shared quota values between Workers.
4. Configure staff Access authentication as described below. A hosted deployment cannot create administrator workspaces through public enrollment. Managed organization provisioning and staff identity lifecycle remain release requirements; do not bypass them with test cookies or direct production database inserts.
5. Configure R2 lifecycle expiration at seven days as protection against orphaned exports. Confirm bucket public access is disabled. Application export deletion follows the parent case and retries failed object deletions.
6. Install any needed provider secrets only in their designated Worker and environment. Provider credentials belong in secret bindings, never Wrangler `vars`, browser code, URLs, logs, or committed environment files.

For example, after choosing and configuring staging:

```sh
pnpm --filter @nursebridge/realtime exec wrangler secret put ASSEMBLYAI_API_KEY --env staging
pnpm --filter @nursebridge/realtime exec wrangler secret put NEBIUS_API_KEY --env staging
```

Provider credentials are needed only for the applicable integration. They do not enable public automated intake by themselves. [Voice Agent setup](voice-agent.md) describes the stored, versioned agent and separate provider setup action. Conversation and extraction use `nvidia/Nemotron-3_5-Lightning`; there is no silent model substitution or replay fallback.

## Validate and release

Run the configuration check before making a remote change:

```sh
pnpm deploy:check --env staging
```

It checks the selected local configuration: resource isolation, bindings, origins, staff authentication requirements, disabled development controls, quotas, and optional phone settings. It does not contact Cloudflare or verify secrets, DNS, Access policy, Twilio delivery, or provider behavior.

Current release limits are fixed at `MAX_CALL_SECONDS=600` and `RETENTION_SECONDS=604800`, matching the shared call-reservation and seven-day content policy. Preflight rejects other values because changing a single Worker variable cannot safely change those policies. Shared quota defaults are two active calls per workspace, four concurrent live-AI sessions, and 120 reserved AI minutes per day; phone defaults are two concurrent calls and 60 reserved minutes per day. Daily reservations are conservative and unused minutes are not refunded.

After the release checklist and environment acceptance are complete:

```sh
pnpm deploy --env staging
```

The release command validates configuration, builds locally, dry-runs both Worker bundles, applies the selected environment's D1 migrations, deploys realtime, then deploys web. Use `--env production` for the independently configured production environment. `--staging` and `--production` are supported aliases. A deploy failure after migrations or the first Worker deploy may leave a partial release; inspect both deployed versions before retrying.

Run the [post-release checks](operations.md#release-and-post-release-checks) with test data. Keep evidence for the deployed revision and environment. A passing local test suite or successful upload is not acceptance of the deployed service.

## Staff access

Hosted staff requests require a signed Cloudflare Access JWT with the configured HTTPS `ACCESS_ISSUER` and exact `ACCESS_AUDIENCE`, in addition to an authorized workspace session. Configure a restrictive Access identity policy for the staff surface. Merely sending an Access header does not grant access. Staff invitation redemption authenticates before consuming the invitation.

Caller invitations and scoped realtime tickets are independent of staff Access. Keep caller-facing routes and authenticated Twilio webhook/media routes reachable without a staff login challenge. Do not place a blanket browser authentication challenge over the realtime service. Validate the actual routing policy in staging, including direct Worker URLs and any alternate hostnames.

Access is currently an application-wide gate: its JWT subject is not bound to the workspace participant. Existing sessions last four hours and workspaces expire after seven days. Managed provisioning, identity-bound membership, renewal, revocation, and durable organizations remain required before operating a long-lived service.

## Optional phone service

Twilio inbound service requires the phone database migration, an owned Voice-capable number, realtime account credentials, the exact public realtime origin, and an operator-controlled number-to-workspace map. Follow [inbound phone setup](phone-inbound.md) for callbacks, carrier limits, and acceptance. Do not bind the test-only `TWILIO_HTTP` stub in a deployed environment.

Phone-to-nurse service can work while automated intake is gated. Enabling a number incurs carrier usage even if AI is disabled. Drain carrier calls and confirm termination before disabling phone ingress, changing routes, or rotating account credentials: disabling ingress also rejects status callbacks needed by outstanding calls.

## Live AI activation

Public automated intake remains blocked by the code-level provider recording-control gate. Consent and provider startup both enforce it. A compatibility flag, stored agent ID, API key, or successful deployment cannot override that decision. Resolve the documented provider controls through a reviewed implementation and independent acceptance evidence before enabling this service.

`FICTIONAL_LIVE_TEST` is a development-only exception with exact HTTP loopback Origins. It is prohibited in hosted release configuration. It does not mark recording controls or compatibility verified. See [safety and privacy](safety-and-privacy.md) for the data boundaries.

## Rollback

Record the previous versions of both Workers and the migration state before every release. Drain calls before an incompatible update; do not assume active provider or carrier sockets survive a release. Keep database and Durable Object migrations additive and compatible with the rollback target.

Worker rollback does not restore D1, Durable Object storage, or R2. Reverting code after an incompatible schema change can worsen an incident; use a reviewed forward repair when rollback cannot safely read the new state. Restoration and deletion reconciliation require separate staging drills, described in [operations](operations.md).
