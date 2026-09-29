# Security

NurseBridge handles workspace access, realtime audio, transcripts and provider connections. The [production readiness requirements](docs/production-readiness.md) track remaining release controls and acceptance work.

## Reporting a vulnerability

Report suspected vulnerabilities privately to the repository maintainer using an established private contact channel. If GitHub private vulnerability reporting is enabled for this repository, use **Security → Report a vulnerability**. Its availability is repository configuration and is not guaranteed by this file.

If no private channel is available, open an issue asking for a secure contact method without publishing exploit details, credentials, case content or personal information. There is no published response-time commitment or bug bounty program.

Include the affected revision/component, the security boundary that failed, the expected and observed behavior, and a minimal reproduction using test data. Do not test against a deployed service or third-party account without authorization. Stop if a reproduction exposes another person's data.

## Security-critical boundaries

- Every case read, mutation, export and socket ticket must enforce workspace and role scope. Access identity does not independently grant a workspace role.
- Hosted administrator enrollment must remain closed unless replaced by an explicitly authenticated provisioning workflow. Development enrollment and diagnostics must remain local-only.
- Socket tickets and invitations must reject invalid scope, expiration and replay. Signed carrier retries must be idempotent and cannot create duplicate cases or revive ended calls. Caller or provider content must not grant tool or staff authority.
- AI may receive audio only under current consent and AI ownership. Human takeover must stop AI forwarding and discard stale audio before confirming connection.
- Deletion must fence delayed writes and preserve required cleanup retries. Carrier reservations must not be released before termination is confirmed.
- Provider credentials, session/invitation tokens and case content must not leak through logs, errors, URLs, public storage or generated artifacts.

Broken authorization, secret exposure, unconsented audio forwarding, deletion bypass, replay, and reachable resource-exhaustion paths warrant investigation. There are no blanket exclusions for third-party integration code or previously tested paths.

## Maintenance and deployment

Report the exact version or commit: no supported-release schedule has been published. Apply dependency and platform changes through reviewed updates and the appropriate regression tests. Deployment operators own account access, secrets, storage exposure, monitoring and incident response in their environment.

See [safety and privacy](docs/safety-and-privacy.md) for retention and provider limits, and [operations](docs/operations.md) for incidents and cleanup. Do not treat this policy as evidence of clinical validation, provider privacy controls or a completed security assessment.
