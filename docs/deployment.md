# Deployment

NurseBridge runs as two Cloudflare Workers with a shared D1 database per environment. Case exports download directly through the authenticated web API; new exports do not use R2. The web Worker serves the application through OpenNext; the realtime Worker owns the SQLite-backed `CallSession` Durable Objects and provider connections. Web accesses realtime through a service binding and the exported Durable Object class.

Deployment tooling validates configuration and release artifacts. It does not establish service availability, provider privacy controls, or authorization to process patient information. Complete the [production readiness requirements](production-readiness.md) before processing patient information.

## Environments

| Environment | Purpose | Data and access |
| --- | --- | --- |
| Local | Development and deterministic tests | Mock providers by default, loopback-only workspace enrollment, isolated emulator storage |
| Staging | Hosted integration and acceptance | Separate D1 and Durable Object data, isolated self-service workspaces, diagnostics disabled |
| Production | Controlled releases after acceptance | Separate resources and secrets, managed staff access, documented operating ownership |

The staging configuration targets the existing `nursebridge-web-staging` and `nursebridge-realtime-staging` Workers and `nursebridge-staging` D1 database, with no R2 bindings. It selects live providers and isolated public workspace access; this configuration is not evidence that the current source revision has been deployed or accepted. Production still contains placeholders and requires independent provisioning. Configure both `apps/web/wrangler.jsonc` and `apps/realtime/wrangler.jsonc` for the selected environment. Bindings and variables must be repeated explicitly; do not assume local bindings carry into a named environment.

## Local development

Use the Node and pnpm versions declared in the root `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The runner builds the application and starts one multi-Worker runtime: web at `http://localhost:8787`, realtime at `ws://localhost:8788`. It shares a single emulator authority for D1 and Durable Object storage in `.local/state`. Stop the runner before database CLI mutations. Running separate Wrangler processes against that directory can cause database errors.

Local workspace enrollment requires `ALLOW_LOCAL_SANDBOX_ENROLLMENT=true`, no Access issuer/audience configuration, a canonical HTTP loopback `APP_ORIGIN`, and an actual request from that same origin. The flag cannot enable enrollment on a hosted URL.

Copy the appropriate `.dev.vars.example` to `.dev.vars` only when provider testing needs local secrets. Actual environment files are ignored by Git. Copy matching untracked environment files into a new worktree before credential-dependent verification; never print their values. The default local workflow needs no paid provider credentials. Device microphone tests require HTTPS.

For optional fictional live testing, realtime `LLM_PROVIDER=assemblyai` selects AssemblyAI's managed conversation (`llm: []` on its stored agent) and Gateway extraction using `qwen3.5-4b-32k-fast`. Only `ASSEMBLYAI_API_KEY` is needed; clear an old `EXTRACTION_MODEL` override. Check Gateway account access and rate limits before selecting this path. Keep the matching stored agent ID/reviewed revision and follow the loopback-only activation procedure in [Voice Agent setup](voice-agent.md). `LLM_PROVIDER` defaults to `nebius`, preserving the existing Nebius path and its two-key requirement. Provider selection does not enable live mode or bypass consent and recording-control gates.

## Prepare a hosted environment

1. Provision or verify the environment's D1 database in the intended Cloudflare account. Staging uses the existing `nursebridge-staging` database; use separate resources for production. New deployments do not require an R2 bucket.
2. Verify the selected environment's resource IDs and hostnames, replacing placeholders where present. Both Workers must reference the same environment's D1 database. Web's `REALTIME` service and `CALL_SESSIONS.script_name` must identify that environment's realtime Worker.
3. Set `APP_ORIGIN` to the exact HTTPS web origin and `REALTIME_URL` to the exact WSS realtime origin. Set realtime `ALLOWED_ORIGINS` to exactly the web origin. Set `PROVIDER_MODE=live` on both Workers; hosted replay responses are rejected by preflight. Set `ALLOW_TEST_DIAGNOSTICS=false` and `FICTIONAL_LIVE_TEST=false` on both, and `ALLOW_LOCAL_SANDBOX_ENROLLMENT=false` on web. Match positive shared quota values between Workers.
4. Choose the workspace access policy below. Staging can explicitly enable isolated self-service enrollment with web `PUBLIC_WORKSPACE_ACCESS=true` and no Access issuer/audience bindings. Other hosted deployments require staff Access configuration; managed organization provisioning and identity lifecycle remain production release requirements.
5. Keep web R2 bindings absent. If an older deployment still has saved objects requiring deletion, realtime may temporarily retain its private `EXPORTS` binding for cleanup. Verify cleanup before removing that binding or bucket.
6. Install any needed provider secrets only in their designated Worker and environment. Provider credentials belong in secret bindings, never Wrangler `vars`, browser code, URLs, logs, or committed environment files.

For example, after choosing and configuring staging:

```sh
pnpm --filter @nursebridge/realtime exec wrangler secret put ASSEMBLYAI_API_KEY --env staging
# Required only when LLM_PROVIDER=nebius (the default).
pnpm --filter @nursebridge/realtime exec wrangler secret put NEBIUS_API_KEY --env staging
```

Provider credentials are needed only for the applicable integration. They do not enable public automated intake by themselves. [Voice Agent setup](voice-agent.md) describes the stored, versioned agent and separate provider setup action. Default Nebius conversation and extraction use `nvidia/Nemotron-3_5-Lightning`. The optional AssemblyAI path uses managed conversation and separate Gateway extraction. Strict local Zod/evidence validation and one repair retry remain mandatory. There is no silent model substitution or replay fallback. Historical Nebius live-test evidence does not verify the AssemblyAI path; record acceptance separately for the selected configuration.

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

## Workspace access

Staging self-service enrollment requires web `PUBLIC_WORKSPACE_ACCESS=true`, an exact HTTPS `APP_ORIGIN` matching the request URL, and absent `ACCESS_ISSUER`/`ACCESS_AUDIENCE` bindings. Preflight permits this option only for staging. It uses the normal persisted application with live provider configuration; it does not enable mock calls, sample cases, diagnostics, or live AI activation.

Each visitor who chooses **Open workspace** receives a distinct workspace and administrator session. The server marks newly created workspaces with `settings_json.publicAccess=true`; only that stored marker permits staff access without Access authentication. Existing private or former demo workspaces do not gain public staff access; their staff sessions prompt users to open a new workspace. Origin checks, session cookies, quotas, optional Turnstile, and one-time scoped invitations remain enforced. Caller invitations retain their caller role; opening a separate workspace does not promote the caller in the inviting workspace. Separate caller and staff cookies preserve both identities when navigating between routes.

For deployments without self-service access, hosted staff requests require a signed Cloudflare Access JWT with the configured HTTPS `ACCESS_ISSUER` and exact `ACCESS_AUDIENCE`, in addition to an authorized workspace session. Configure a restrictive Access identity policy for the staff surface. Merely sending an Access header does not grant access. Staff invitation redemption authenticates before consuming the invitation.

Caller invitations and scoped realtime tickets are independent of staff Access. Keep caller-facing routes and authenticated Twilio webhook/media routes reachable without a staff login challenge. Do not place a blanket browser authentication challenge over the realtime service. Validate the actual routing policy in staging, including direct Worker URLs and any alternate hostnames.

Where configured, Access is currently an application-wide gate: its JWT subject is not bound to the workspace participant. Existing sessions last four hours and workspaces expire after seven days. Managed provisioning, identity-bound membership, renewal, revocation, and durable organizations remain required before operating a long-lived service.

## Case downloads

An authorized staff export request returns the current case as a JSON or Markdown attachment with private, no-store headers. Workspace membership, staff role, case existence, and retention expiry are checked before the response. No saved export URL or R2 object is created; old saved-export URLs return 410 after authorization. Downloaded copies are outside the application's retention and deletion controls.

## Optional phone service

Twilio inbound service requires the phone database migration, an owned Voice-capable number, realtime account credentials, the exact public realtime origin, and an operator-controlled number-to-workspace map. Follow [inbound phone setup](phone-inbound.md) for callbacks, carrier limits, and acceptance. Do not bind the test-only `TWILIO_HTTP` stub in a deployed environment.

Phone-to-nurse service can work while automated intake is gated. Enabling a number incurs carrier usage even if AI is disabled. Drain carrier calls and confirm termination before disabling phone ingress, changing routes, or rotating account credentials: disabling ingress also rejects status callbacks needed by outstanding calls.

## Live AI activation

Public automated intake remains blocked by the code-level provider recording-control gate. Consent and provider startup both enforce it. A compatibility flag, stored agent ID, API key, or successful deployment cannot override that decision. Resolve the documented provider controls through a reviewed implementation and independent acceptance evidence before enabling this service.

`FICTIONAL_LIVE_TEST` is a development-only exception with exact HTTP loopback Origins. It is prohibited in hosted release configuration. It does not mark recording controls or compatibility verified. See [safety and privacy](safety-and-privacy.md) for the data boundaries.

## Rollback

Record the previous versions of both Workers and the migration state before every release. Drain calls before an incompatible update; do not assume active provider or carrier sockets survive a release. Keep database and Durable Object migrations additive and compatible with the rollback target.

Worker rollback does not restore D1, Durable Object storage, downloaded copies, or any legacy R2 objects. Reverting code after an incompatible schema change can worsen an incident; use a reviewed forward repair when rollback cannot safely read the new state. Restoration and deletion reconciliation require separate staging drills, described in [operations](operations.md).
