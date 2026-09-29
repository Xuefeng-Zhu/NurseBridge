# NurseBridge hackathon materials

Updated September 29, 2026 for the AssemblyAI - Voice Agent Hackathon on LabLab. These are local preparation assets; this task has not uploaded or submitted them.

- [PDF pitch deck](nursebridge-pitch.pdf) and [editable PowerPoint](nursebridge-pitch.pptx).
- [16:9 cover](nursebridge-cover.png).
- [Standalone form copy](submission-copy.txt): title, short and long descriptions, and suggested tags.
- [Complete submission packet](../../docs/hackathon-submission.md): judge walkthrough, current evidence, official requirements, and remaining actions.
- [Three-minute recording outline](../../docs/submission-recording-script.md).
- [Refreshed 80-second narrated walkthrough](../demo/nursebridge-demo.mp4) and [captions](../demo/nursebridge-demo.srt).

The video was refreshed September 29 from the polished local application. Its fictional transcript replay is labeled with providers off; it does not show microphone transcription or physical-device audibility. Separate [September 29 local live evidence](../../docs/evidence/local-live-voice-2026-09-29.json) records a real AssemblyAI/Nebius call, an agent reply, evidence extraction, and non-silent human-channel playback in both browser worklets after takeover. That provider check predates the latest polish changes.

The latest local polish checks passed 168 unit, 177 Workers, 19 tooling and 29 browser tests, with one opt-in live-provider test skipped. See [test results](../../docs/test-results.md) for scope and limits. For a repeatable local walkthrough, run `pnpm install --frozen-lockfile` and `pnpm demo`; it creates fresh temporary storage, ignores local provider credentials, and listens only on loopback.

The source repository remains private (GitHub API check September 29), and a public interactive demo URL is still needed. Registration/team membership, the signed-in event form, uploads and final entry remain unverified or pending. Review the complete packet before submission. The official event page lists September 30, 2026 at 8:00 AM PDT as the deadline.

The optional ZIP groups presentation assets for convenience. It is not application source and does not replace individual MP4, PDF, cover, repository or application fields in the event form.

Rebuild the reviewed ZIP with `python3 scripts/package-submission.py` from the repository root. It includes only the six named presentation assets and a README, and verifies each bundled file against the source artifact.
