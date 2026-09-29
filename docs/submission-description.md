# NurseBridge — submission draft

NurseBridge explores a practical voice-agent workflow for a busy nurse line: a fictional caller explains their situation while waiting, an automated intake assistant prepares an evidence-linked draft, and a nurse joins the same browser call with context.

AssemblyAI Voice Agent is the integrated conversation and speech layer, configured with Nebius Nemotron-3.5-Lightning. Independent extraction validates finalized caller turns and preserves corrections as evidence-linked revisions. The agent only collects information; it does not diagnose or assess clinical urgency. One unsuccessful clarification requests nurse help; completed callers also wait for a nurse.

Next.js App Router runs on Cloudflare Workers through OpenNext. A SQLite-backed Durable Object coordinates state, provider tool validation, audio and nurse takeover. D1 holds workspace records and projections; R2 stores private JSON/Markdown exports only. Provider recordings of fictional automated intake require explicit consent. Hosted live readiness is blocked until provider compatibility and recording controls are verified; separate local live-provider acceptance is documented below.

Demonstration story: busy nurse → caller's story → evidence-linked draft → corrected detail → preserved uncertainty → nurse takeover during agent speech → direct human conversation.

This is a synthetic-data demonstration. Optional Twilio inbound support connects a configured telephone number to the nurse browser; real-number deployment and acceptance remain pending. It makes no clinical-safety, compliance, accuracy or time-savings claims.

## Submission materials

The [complete submission packet](hackathon-submission.md) contains form-ready short and long descriptions, technology tags, judge instructions, source-linked requirements, asset links, and the remaining checklist. The [recording script](submission-recording-script.md) outlines a three-minute presentation.

The [event page](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon), rechecked September 29, shows September 30, 2026 at 8:00 AM PDT as the deadline. The signed-in event form still needs review.

- The [80-second narrated video](../artifacts/demo/nursebridge-demo.mp4) was refreshed September 29 with the polished UI and captions. It shows labeled transcript replay with providers off; upload is pending.
- The [PDF pitch deck](../artifacts/submission/nursebridge-pitch.pdf), [editable PowerPoint](../artifacts/submission/nursebridge-pitch.pptx), and [16:9 cover](../artifacts/submission/nursebridge-cover.png) are local submission assets.
- A September 29 fictional local real-provider acceptance test verified the agent reply, evidence extraction, nurse takeover and non-silent human-channel playback in both browser worklets; see [redacted live proof](evidence/local-live-voice-2026-09-29.json) and [test results](test-results.md). The latest polish pass separately passed 165 unit, 173 Workers, 19 tooling and 29 browser tests; its live-provider test was skipped. Public live AI, provider recording controls, physical-device acceptance, and real telephone-network acceptance remain separate checks.
- Run `pnpm install --frozen-lockfile` followed by `pnpm demo` for the isolated local walkthrough. It builds and seeds fresh temporary storage, ignores local provider credentials, and listens only on this computer.
- The GitHub API confirms the repository remains private as of September 29, and no public interactive demo URL is verified. Phone support is merged into `main`; the latest local polish changes must be included in the source revision shared with judges.
- Registration, uploads, final entry, and agreement to event rules have not been performed by this preparation task.
