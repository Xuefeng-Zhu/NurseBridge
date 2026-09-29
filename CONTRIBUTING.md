# Contributing

NurseBridge is a TypeScript workspace for caller intake, realtime audio and nurse handoff. Changes should preserve tenant isolation, explicit consent, human control, evidence provenance and durable cleanup. Read the [architecture](docs/architecture.md), [safety boundaries](docs/safety-and-privacy.md) and [readiness requirements](docs/production-readiness.md) before changing call behavior.

## Development setup

Use the Node and pnpm versions declared in `package.json`. Install with `pnpm install --frozen-lockfile`, apply local migrations with `pnpm db:migrate`, then run `pnpm db:seed` and `pnpm dev`. The default workflow uses local replay and test data with providers disabled. See [deployment](docs/deployment.md) for the shared local runtime and optional secret files.

Check the working tree before editing and preserve unrelated work. Keep changes focused. Never commit credentials, real caller information, local runtime databases, exports, browser storage or unredacted provider logs. Do not introduce a license or change usage rights without the repository owner's decision.

## Validation

```sh
pnpm verify
```

Run relevant tests while developing, then the full required checks before review. Tests under `tests/unit` cover contracts, policy and audio utilities. Realtime tests use local Workers, Durable Objects and D1 with isolated fixture configuration. Browser tests exercise the compiled application.

For the isolated local phone and browser workflow, use free ports 8787/8788 (or set `NURSEBRIDGE_QA_WEB_PORT` and `NURSEBRIDGE_QA_REALTIME_PORT`) and run:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

The harness builds, migrates a temporary database, runs its own Workers services and closes them. It stubs carrier completion and refuses remote/live-AI targets. Use `PLAYWRIGHT_CHANNEL=chrome` when explicitly testing installed Chrome. Read [phone verification](docs/phone-inbound.md#verification-boundaries) for scope. Paid provider, public deployment, and PSTN testing require their own configured environment and authorization; ordinary tests must remain isolated.

## Change expectations

- Add regression coverage for changes to authorization, call transitions, concurrency, provider protocols, media acknowledgments, retention or deletion. Include rejection and recovery paths, not just successful requests.
- Keep shared wire schemas in `packages/contracts` aligned with callers and server handlers. Treat model/provider payloads as untrusted input.
- Use additive database migrations and preserve compatibility with the planned rollback target. Never edit a migration already applied to a shared environment to disguise a schema change.
- Keep provider secrets and network access server-side. Do not weaken consent, live activation, Origin or ticket checks to simplify a test.
- Describe the user-visible behavior, tests actually run, and remaining acceptance layers in the pull request. Local tests are not evidence of physical audibility, live-provider behavior or clinical readiness.

Changes to deployment, data retention, identity or provider contracts must update the relevant runbook. Do not deploy or change account resources as a side effect of a test or documentation change.
