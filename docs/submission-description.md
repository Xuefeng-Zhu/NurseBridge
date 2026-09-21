# NurseBridge — submission draft

NurseBridge explores a practical voice-agent workflow for a busy nurse line: a fictional caller explains their situation while waiting, an automated intake assistant prepares an evidence-linked draft, and a nurse joins the same browser call with context.

AssemblyAI Voice Agent is the integrated conversation and speech layer, configured with Nebius Nemotron-3.5-Lightning. Independent extraction validates finalized caller turns and preserves corrections as evidence-linked revisions. The agent only collects information; it does not diagnose or assess clinical urgency. One unsuccessful clarification requests nurse help; completed callers also wait for a nurse.

Next.js App Router runs on Cloudflare Workers through OpenNext. A SQLite-backed Durable Object coordinates state, provider tool validation, audio and nurse takeover. D1 holds workspace records and projections; R2 stores private JSON/Markdown exports only. Provider recordings of fictional automated intake require explicit consent. Live readiness is blocked until provider compatibility and recording controls are verified.

Demonstration story: busy nurse → caller's story → evidence-linked draft → corrected detail → preserved uncertainty → nurse takeover during agent speech → direct human conversation.

This is a synthetic-data browser simulation. It answers no telephone numbers and makes no clinical-safety, compliance, accuracy or time-savings claims.

## Submission checklist

The [event page](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon) lists September 1–30, 2026 and requires building on AssemblyAI. [LabLab's general guide](https://lablab.ai/guide) calls for a usable online prototype, video presentation and pitch deck. Event-specific submission form requirements must be rechecked before submitting; no judging rubric is invented here.

- Repository and implementation description: supplied here.
- Public live deployment, real-provider acceptance, video and pitch deck: separate release/submission work.
- Registration, submission and agreement to event rules: user-controlled actions; not performed by this repository task.
