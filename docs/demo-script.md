# Local two-browser acceptance walkthrough

Use the local Workers runtime with sandbox enrollment enabled and fictional information only. Hosted environments require a completed staff provisioning workflow; this walkthrough does not provision production identities.

Start a clean rehearsal with `pnpm demo` (or `pnpm demo --skip-build` after a current build). This isolated runtime always uses transcript replay, ignores local provider credentials, and requires no database setup. Open the URL printed by the command. Ctrl+C stops it; rerunning creates fresh data. Both browser profiles must be on this computer because the demo binds only to loopback. Use the separately configured `pnpm dev` workflow for live-provider or device acceptance.

1. Open the printed call queue URL in the nurse browser. Read the release notice, create a local workspace, then choose **Invite a caller → Create caller invitation** and copy the link. Redeem it in a separate browser profile on the same computer; do not replace the nurse session cookie.
2. Use headphones. In live mode, review and accept the separate provider-recording disclosure. Explicitly enable audio in both browsers when their controls request it. Confirm microphone permission and output readiness.
3. In the caller browser, join the queue first. Accept the fictional-intake disclosure (including provider recording in live mode) to start automated intake, or decline and demonstrate that the queue position and human request remain available.
4. In **live mode**, speak fictional details into the microphone. In **mock mode**, expand **Transcript test tools** on the caller page; these controls replay supplied transcript text and do not recognize your voice.
5. Use the supplied fictional headache opening. Then correct it: “I need to correct that: the headache started this morning, not yesterday. No other symptoms.” Show the current draft, original evidence and correction history.
6. Say: “I have not checked my temperature. I took Tylenol, but I am not sure what dose.” Show not-measured and uncertain states without clinical confidence percentages. Take over during the clarification cue, before entering another unresolved answer.
7. While the agent output is playing, the nurse claims the call, enables microphone/output and takes over. Watch the caller flush acknowledgment, media readiness and connected status.
8. Speak from both browsers. Confirm each human hears the other and no stale agent output returns. Review the draft and acknowledge any explicit human request.
9. In a separate case, answer an intake question with “I do not know,” hear one clarification, and repeat the uncertainty. Verify that the caller waits for a nurse with the unresolved field highlighted. Complete another case and verify ordinary waiting with no escalation and AI forwarding stopped.
10. End the call. Optionally export the synthetic case and demonstrate administrator deletion.

## Manual two-device checks

- Repeat with headphones and then a controlled speaker-echo test; verify barge-in does not create an endless self-interruption loop.
- Deny microphone permission, block playback/autoplay, disconnect a device, and reconnect. Each failure must remain visible and retryable.
- Confirm both directions audibly on actual speakers/headphones; automated sample tests alone cannot prove physical output.
- Interrupt a long AI response and take over before it finishes. Listen for late or duplicated audio.
- Introduce a constrained network and verify bounded buffering, gap indicators and recovery rather than minute-long backlog playback.
- Record actual STT, extraction, first-audio and handoff timings with mode/environment labels. Do not turn targets or fixture timing into live performance claims.
