# NurseBridge hackathon materials

Original September 29, 2026 preparation assets for the AssemblyAI - Voice Agent Hackathon on LabLab. Access and saved-form status were updated September 30. The saved LabLab form uses a newer seven-page deck, cover, and 3:20 narrated prototype video; the files in this directory remain the original local packet. Final submission is pending.

- [PDF pitch deck](nursebridge-pitch.pdf) and [editable PowerPoint](nursebridge-pitch.pptx).
- [16:9 cover](nursebridge-cover.png).
- [Standalone form copy](submission-copy.txt): title, short and long descriptions, and suggested tags.
- [Complete submission packet](../../docs/hackathon-submission.md): judge walkthrough, current evidence, official requirements, and remaining actions.
- [Three-minute recording outline](../../docs/submission-recording-script.md).
- [Refreshed 80-second narrated walkthrough](../demo/nursebridge-demo.mp4) and [captions](../demo/nursebridge-demo.srt).

The video was refreshed September 29 from the polished local application. Its fictional transcript replay is labeled with providers off; it does not show microphone transcription or physical-device audibility. Separate [September 29 polished-build live evidence](../../docs/evidence/polished-live-voice-2026-09-29.json) records a real AssemblyAI/Nebius call against source revision `743cce2`, with an agent reply, evidence extraction, non-silent human-channel playback in both browser worklets after takeover, and completed case/provider cleanup. This separately opted-in local test passed in 30.8 seconds using recorded microphones. It does not establish physical-device, real telephone-network, or public-deployment acceptance.

The latest local polish checks passed 168 unit, 177 Workers, 19 tooling and 29 browser tests, with one opt-in live-provider test skipped. See [test results](../../docs/test-results.md) for scope and limits. For a repeatable local walkthrough, run `pnpm install --frozen-lockfile` and `pnpm demo`; it creates fresh temporary storage, ignores local provider credentials, and listens only on loopback.

The [source repository](https://github.com/Xuefeng-Zhu/NurseBridge) is **public**, verified through the GitHub API on September 30, 2026. The [hosted staging demo](https://nursebridge-web-staging.pullthread-commerce-worker.workers.dev/nurse) is reachable, but successful end-to-end intake still needs verification. Local staging and presentation changes have not all been published to `main`. The signed-in LabLab form now has saved cover, video, PDF, and repository/application links. Final submission remains pending. Review the complete packet before submission. The earlier official event-page check recorded September 30, 2026 at 8:00 AM PDT as the deadline.

The optional ZIP groups presentation assets for convenience. It is not application source and does not replace individual MP4, PDF, cover, repository or application fields in the event form.

Rebuild the reviewed ZIP with `python3 scripts/package-submission.py` from the repository root. It includes only the six named presentation assets and a README, and verifies each bundled file against the source artifact.
