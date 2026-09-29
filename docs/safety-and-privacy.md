# Safety and privacy

NurseBridge collects caller information and supports human handoff. It does not diagnose, recommend treatment, triage symptoms, infer urgency, or determine that waiting is safe. The [readiness requirements](production-readiness.md) define the validation and operational controls required before processing patient information.

## Human control and evidence

A call enters the queue before automated-intake consent. Declining or withdrawing consent leaves human assistance available. Live AI requires separate, explicit transcription and provider-recording consent with a stored disclosure version and acceptance timestamp. Older consent does not authorize a new recording disclosure.

Automated questions stay within the collection template. A separate extraction pass validates finalized caller evidence before attaching it to structured facts. Assistant speech is not patient evidence. Exact transcript quotes establish provenance, not clinical truth or guaranteed audio transcription accuracy. Unknown, uncertain, denied, not measured, and reported values remain distinct. An unsuccessful clarification requests nurse assistance.

Every completed intake waits for a nurse. Explicit caller requests, technical failure, consent refusal, and explicit reports of an emergency can also request handoff. Emergency wording directs real emergencies to emergency services. The application does not classify symptom severity, comprehensively detect emergencies, or place an emergency call. A queue state or call closure is not a clinical disposition.

## Data flow

| Data | Processing destination | Boundary |
| --- | --- | --- |
| Browser caller audio during consented AI intake | Realtime Worker, AssemblyAI Voice Agent | Forwarding stops when AI ownership ends |
| AI conversation context | AssemblyAI's configured Nebius integration | Dedicated server-side provider credential; versioned agent configuration |
| Finalized caller turns and bounded draft context | Nebius extraction endpoint | Structured evidence validation; no assistant-authored facts |
| Waiting and nurse conversation audio | Realtime relay between participants | Not forwarded to the AI providers; application does not archive audio |
| Telephone audio and carrier metadata | Twilio and realtime Worker | Carrier remains in the phone path during waiting and nurse conversation; integration does not request carrier recording |
| Transcripts, draft facts, review and case events | CallSession storage and D1 projections | Workspace-scoped access |
| Requested case exports | Private R2 bucket | Authorized download; expiration follows parent case |

The application does not store the phone caller's `From` number. Twilio receives and processes carrier metadata independently; application minimization is not a statement about carrier retention. Phone receipts retain provider account/call identifiers, route hashes, and timestamps for lifecycle cleanup and replay protection.

## Retention and deletion

Case content expires after seven days. Administrators can delete a case sooner. Durable Object alarms erase case content, project deletion to D1, and retry R2 export deletion. Tombstones prevent a delayed projection from recreating deleted content. Previously downloaded exports are outside application control.

The seven-day content policy is not a claim that every operational record is purged. Workspace membership, expired authentication records, initialization/quota ledgers, deletion tombstones, provider cleanup records, and minimal phone receipts have separate operational purposes. This release does not implement a complete metadata retention and purge policy. Deletion may retain the identifiers needed to finish carrier termination or provider cleanup.

Provider sessions have a durable cleanup queue that requests session soft deletion and retries failures. A provider session whose identity was never received requires operator reconciliation. Successful soft deletion does not establish physical erasure, backup expiration, or account retention compliance. Provider recording controls remain unverified, and public AI activation is blocked in code.

The operating organization must establish retention, backups, restoration, deletion reconciliation, and provider obligations before using patient information. Do not remove tombstones or cleanup state as a shortcut: they prevent data resurrection and orphaned carrier/provider activity.

## Access and secret handling

Session cookies are HTTP-only, same-site, and secure on HTTPS. Server-side sessions, single-use invitations, short-lived socket tickets, commands, and case lookups enforce workspace and role boundaries. Mutations validate the expected Origin. Case responses and downloads use private, non-cacheable responses. Case content is excluded from application logs and localStorage.

Hosted staff access additionally requires verified Access identity. Public administrator enrollment is limited to explicitly enabled, matching loopback development requests. Access identity is not yet bound to the participant; managed identity, organization provisioning, renewal, and revocation workflows remain required.

Provider credentials remain server-side. Provider tool calls cannot select a workspace, change their role, perform arbitrary network requests, or act on another case. Untrusted transcripts, model responses, browser commands, and webhook fields must continue to pass schema, scope, freshness, and authorization checks.

## Acceptance boundary

Automated tests exercise local protocol and lifecycle behavior. They do not establish clinical suitability, physical-device audibility, live carrier delivery, provider account privacy controls, remote resource configuration, or regulatory compliance. The [operations runbook](operations.md) and [readiness matrix](production-readiness.md) identify the evidence and operating decisions still required.
