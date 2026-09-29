# Operations

This runbook covers release checks, failures, and data lifecycle for NurseBridge. Use test data during acceptance. Assign an environment owner, incident contact, and provider-account owner before exposing a service. Automated alerting and production service objectives are not provisioned by this repository.

## Release and post-release checks

Before deploying, run the repository checks and selected-environment preflight in [deployment](deployment.md). Record the source revision, both previous Worker versions, and the current migration state. Keep migrations compatible with the rollback target and drain active calls before incompatible changes.

After deploying, verify the actual environment:

1. Web and realtime respond on the expected HTTPS/WSS hosts. Realtime `/health` returns no secrets or case content. Treat its `configured` fields as configuration presence, not dependency probes. `liveActivation.ready=false` means automated intake must remain unavailable.
2. Unauthorized staff access, cross-workspace case access, expired/replayed invitations and tickets, incorrect Origins, and public administrator enrollment are rejected. A valid Access identity alone must not confer an arbitrary workspace role.
3. Authorized staff can load the queue, select a test case, enable microphone/playback, claim, and complete a two-way handoff. Confirm sound on separate physical devices; browser media counters alone are insufficient.
4. Case closure stops forwarding and leaves no active carrier call. For phone service, test consent choices, DTMF 0, caller hangup, staff End call, status callbacks, and carrier failure recovery with the owned number.
5. Export and administrator deletion enforce access checks. Deleted case content and exports remain inaccessible after delayed projection retries. Verify lifecycle configuration and provider cleanup independently.

## Operating signals

| Signal | Interpretation and response |
| --- | --- |
| HTTP availability, error rate and latency | Add external probes and platform alerts; `/health` alone does not exercise D1, R2, media or providers |
| Queue projection warning | Durable call state may be newer than the list; investigate D1/binding availability while preserving active audio |
| Repeated handoff timeout or missing playback | Inspect permission, device, connectivity and browser readiness; retry human audio, never silently resume AI |
| Provider compatibility or recording issue | Keep live intake disabled; distinguish missing configuration from unverified controls |
| Carrier call remains in progress after closure | Treat as possible ongoing carrier usage; inspect termination/status delivery and preserve the reservation |
| Deletion/export/provider cleanup failures | Preserve durable retry state; reconcile the affected storage/provider account before declaring deletion complete |
| Quota rejection or unusual enrollment attempts | Investigate capacity or abuse; do not clear remote ledgers simply to bypass limits |

Capture aggregate timing, failure codes, environment/revision and minimal correlation identifiers. Do not log audio, transcripts, draft facts, credentials, cookies, invitation/ticket values, or full provider payloads. Wrangler observability is disabled in the templates; configure monitoring only after its data handling has been reviewed. The project currently has no centralized operations dashboard or automated backlog alerting.

## Call interruption

The Durable Object is authoritative. A restart does not automatically resume AI or replay captured audio. Browser calls return to a waiting/claimed recovery state and require participant reconnection. A phone media restart closes the application call and durably requests carrier termination; start a new call after confirming completion.

On a nurse disconnect, AI remains stopped and the nurse claim is temporarily retained. Reconnect and retry the human audio controls. An expired claim returns to waiting while preserving arrival order. Connected status requires fresh playback acknowledgment in both directions; do not change state manually to bypass a failed handshake.

Calls are bounded to at most ten minutes. Expiry is an operational limit, not a clinical disposition or confirmation that the caller's needs were resolved. A longer-lived service requires an explicit design change and verification, not a larger unchecked environment value.

## Delayed database projection

The call object writes an ordered durable outbox before projecting to D1. Failed projection retries with backoff. A stale queue list does not mean the active media connection has failed.

Check the correct environment's D1 availability, service/DO bindings, deployed migration state, and recent release changes. Restore the dependency and let the ordered outbox retry. Do not manufacture a newer D1 snapshot or delete an outbox entry: revision checkpoints and deletion tombstones prevent stale writes and content resurrection. Persistent backlogs need operator investigation; there is no public repair endpoint.

## Phone termination or callback failure

Phone concurrency stays reserved until carrier termination is confirmed. App closure requests Twilio completion and persists retries. A carrier outage can extend billable time beyond the application's media deadline.

1. Inspect the call in the intended Twilio account using the retained call identifier and inspect webhook delivery to the exact public realtime origin.
2. Check account credentials, signature validation configuration, callback reachability, and carrier API availability. Restore the same required cleanup credentials before removing or rotating them.
3. Confirm the call is terminal at the carrier. If necessary, an authorized operator may end the affected call through Twilio's controls; verify the resulting status delivery and application reconciliation.
4. Verify the reservation is released by normal lifecycle processing. Do not manually release a still-active call's quota to make room for another call.

To retire phone service, stop routing new calls at the carrier, drain existing calls, verify terminal delivery and outstanding cleanup, then disable `PHONE_INBOUND_ENABLED`. Turning it off first rejects status callbacks as well as new inbound calls. Do not replace the operator-owned route map while active receipts still depend on it.

## Provider outage and deletion

When AI fails, the application stops automated intake and requests human assistance. Do not substitute fabricated transcript text or replay results. Public AI remains gated until provider recording controls are implemented and verified.

Provider deletion retries require the account credential that can access the retained session. If the connection ended before its session identity was received, reconcile provider history using the connection attempt metadata; automatic cleanup cannot prove a session it could not identify. Use the provider's supported administrative process and retain the outcome without copying sensitive content into issue trackers.

A successful session soft-delete response is not proof of physical erasure or backup expiry. Keep the distinction between application content deletion, provider logical deletion, and provider account retention in incident and release records.

## Backups, restoration and retention

The application erases seven-day case content through Durable Object alarms and retries D1/R2/provider cleanup. Operator metadata and minimal replay/termination receipts have not yet received a complete automatic purge policy. Track this separately from content expiry.

Define recovery objectives and access-controlled backup policies for D1, Durable Object state, and R2 before production use. Restoration must account for all three and the external providers. A D1-only restore is not a complete call recovery.

Practice restoration in an isolated staging environment with phone routing and paid provider access disabled. Apply the current deletion/expiry records so restoration cannot re-expose deleted or expired content. Reconcile outstanding carrier/provider cleanup and exports before reopening access. Never erase tombstones merely to make an older backup load. Document restore duration and observed loss rather than promising unmeasured recovery targets.

## Incident handling

Preserve minimal evidence, identify the affected environment and revision, and stop new affected traffic when needed. Preserve access to cleanup callbacks and retries while draining calls. Rotate exposed credentials through the owning provider, update secret bindings, and verify recovery; never paste credentials into a report.

Use [SECURITY.md](../SECURITY.md) for vulnerability reporting. Decide rollback against the recorded migration state; Worker rollback does not undo stored data. After recovery, document impact, remaining cleanup, corrective changes, and a regression or acceptance check that reproduces the failure safely.
