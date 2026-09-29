# Production readiness

NurseBridge has a tested realtime call core and release safeguards. It is a pre-production application: managed staff onboarding, live environment acceptance, provider privacy controls, and service operations still need completion. Repository checks alone do not authorize clinical use or real patient information.

This document separates shipped mechanisms from the evidence required to operate them. An environment called `production` is a deployment target, not a readiness certification.

## Readiness matrix

| Area | Implemented in the repository | Required before general availability |
| --- | --- | --- |
| Call ownership | Durable state machine, atomic claims, idempotent commands, explicit human takeover, playback acknowledgments | Two-device audibility, echo, permissions, reconnect, constrained-network and repeated timing tests |
| Tenant authorization | Workspace/role checks, hashed sessions, one-use invitations, scoped socket tickets, Origin checks | Managed organization provisioning, identity-bound membership, renewal, revocation, staff lifecycle and deployed policy verification |
| Hosted enrollment | Public administrator creation rejected outside explicitly enabled loopback development | Authenticated organization setup and recovery; no test-cookie or database-seeding workaround |
| Release configuration | Selected-environment preflight, isolated resources, required staff authentication configuration, build and Worker dry runs | Provisioned resources, secret verification, staging acceptance and release ownership |
| CI | Repository validation and deterministic test commands | Required branch checks, dependency response ownership and release approval policy configured in the hosting service |
| State and recovery | Durable Object authority, ordered D1 projection retries, deletion tombstones, bounded call lifecycle | Failure drills, backlog alerting, restore/reconciliation procedure, measured recovery objectives |
| Data retention | Seven-day case content expiry, administrator deletion, export cleanup retries | Bounded operational-metadata retention, backup policy, provider/region agreements and audited deletion verification |
| Phone ingress | Signed Twilio webhooks, operator-owned routing, replay protection, codecs, durable termination retries | Owned number, public callback delivery, PSTN call and hangup tests, carrier billing reconciliation |
| AI intake | Consent gates, versioned provider setup, bounded extraction, transcript evidence, interruption handling | Supported and verified provider recording/retention controls; repeated live compatibility and failure testing |
| Monitoring | Content-free configuration health, in-app projection and provider warnings | External probes, alert delivery, service objectives, on-call ownership and incident drills |
| Clinical operation | Restricted collection scope, human handoff, explicit unknowns and evidence | Clinical governance, approved workflows, privacy/security assessment, accessibility and usability validation, organizational authorization |

The detailed local evidence is in [test results](test-results.md). Counts and recorded runs are historical evidence, not a guarantee for a later revision or deployment.

## Blocking work

1. **Managed staff and organizations.** The current session lasts four hours and workspace lasts seven days. Implement authenticated provisioning, identity binding, organization persistence, session renewal, offboarding, and recovery. Verify caller and staff routing policies without exposing enrollment or granting role authority from an arbitrary Access identity.
2. **Provider recording controls.** `RECORDING_CONTROLS_VERIFIED` remains false. Establish a supported recording/retention policy, implement the necessary controls, and verify deletion and account behavior before changing the gate. Credentials and local AI success are insufficient.
3. **Hosted acceptance.** Deploy isolated staging, prove database/bucket/binding isolation and Access behavior, then run physical browser audio and real inbound-phone checks. Record the tested source revision, environment, devices, provider versions, failures, and measured outcomes.
4. **Service operation and data lifecycle.** Assign an operator, enable content-free alerting, define service and recovery objectives, validate restoration with deletion reconciliation, and add explicit metadata cleanup. Test carrier termination and provider cleanup outages without silently releasing reservations or losing cleanup identifiers.
5. **Clinical release approval.** Process patient information only after the responsible organization approves the intended clinical workflow, information handling, consent, staff training, incident response, and accessibility. This repository does not claim a clinical validation or compliance certification.

## Release evidence

Keep a release record containing:

- Source revision, CI result, dependency lockfile and generated bundle validation.
- Target environment, Worker versions, migration state, and resource identifiers without secrets.
- Staff/caller access checks, tenant isolation checks and development-control rejection.
- Call acceptance results, including failure paths and carrier completion where enabled.
- Retention/deletion checks, provider policy evidence, incident owner and rollback decision.

Runbooks: [deployment](deployment.md), [operations](operations.md), [phone ingress](phone-inbound.md), [Voice Agent](voice-agent.md), and [safety and privacy](safety-and-privacy.md).
