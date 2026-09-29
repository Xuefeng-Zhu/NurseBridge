# NurseBridge presentation script

Target length: about three minutes, within LabLab's general five-minute MP4 limit. The [80-second video](../artifacts/demo/nursebridge-demo.mp4), refreshed September 29, provides a captioned transcript-replay walkthrough of the polished UI. This script adds the pitch and technology explanation for a fuller recording.

Keep “fictional demonstration” visible. Label each product scene as mock replay or real-provider footage according to what was actually recorded. Do not narrate mock text insertion as speech recognition.

## 0:00–0:20 — Introduction

Show the title slide.

“This is NurseBridge, a voice-intake demonstration built with AssemblyAI. A fictional caller tells their story, the system prepares a draft with supporting words, and a nurse joins the same audio session. The nurse can see what changed and what still needs clarification.”

## 0:20–0:45 — Problem and intended value

Show the problem or workflow slide.

“Our starting point is the moment a nurse joins a call. They need context they can inspect. NurseBridge tests whether a voice agent can collect that context while preserving uncertainty and keeping human access available. We have not measured time savings or clinical outcomes. Those are questions for future validation with nurses.”

## 0:45–1:30 — Product demonstration

Show the refreshed caller intake, then the nurse evidence view. For the supplied providers-off footage, say:

“This walkthrough uses labeled mock transcript replay. The caller joins the queue before choosing automated intake. Here, the caller corrects the onset from yesterday to this morning. The nurse sees the current answer alongside its source and revision history. ‘I haven't checked my temperature’ stays not measured. The system asks one clarification for unresolved information, then requests nurse help.”

If new real-provider footage is recorded, replace only the mode sentence with an accurate description of that recording. Keep the exact fictional scenario and show the microphone input and corresponding finalized transcript. Do not imply the whole feature set has new live acceptance from one short clip.

For the takeover scene, act during the first clarification cue before entering another unresolved answer. If demonstrating repeated uncertainty and waiting too, record that in a separate call: agent output has already stopped once that call enters waiting.

## 1:30–1:55 — Human takeover

Show the nurse claiming the call, enabling audio, and connected human status.

“The nurse claims the call and joins the existing session. NurseBridge clears queued agent output and checks playback in both directions before showing the human connection as ready. The waiting period and nurse conversation are not sent to the AI provider. A caller who declines automation can still wait for a nurse.”

When using a screenshot montage, state that it shows connection status from local tests. Do not claim the recording demonstrates physical two-device audibility. For the evidence slide, identify the real-provider check as September 29 local evidence recorded after the final audio recovery fixes; the refreshed visual walkthrough uses providers-off replay.

## 1:55–2:25 — AssemblyAI and implementation

Show the architecture slide.

“AssemblyAI Voice Agent supplies the conversation and speech layer, using our configured Nebius Nemotron model. Separate extraction validates structured facts against finalized caller statements. Next.js runs on Cloudflare Workers, and a Durable Object coordinates each call, including consent, provider state, and human takeover. Codex helped implement and test these pieces.”

## 2:25–2:45 — Evidence

Show the validation slide.

“On September 29, a separate fictional local call used the real AssemblyAI and Nebius services. It finalized caller speech, extracted a supported fact, received an agent reply, and measured non-silent human audio in both browser worklets after takeover. Our polish regression suite also passed 29 browser tests, including recovery and a Twilio protocol adapter. Physical-device and real telephone-network acceptance remain pending.”

## 2:45–3:00 — Close

Show the next-step slide.

“Next, we want nurses to evaluate fictional cases and measure draft quality and handoff reliability. Public live AI remains blocked until recording controls and device checks are verified. NurseBridge is a simulation for human review, with no diagnosis or urgency assessment.”

## Recording checklist

- Use the actual [PDF deck](../artifacts/submission/nursebridge-pitch.pdf) and local application. For a repeatable walkthrough, run `pnpm demo`; it uses fresh temporary storage and keeps providers off even when local credentials exist.
- Keep mock labels and fictional-data notices legible. Avoid showing invitation links, credentials, session identifiers, or unrelated browser tabs.
- Record actual human relay only when the microphones and physical playback have been checked. Use headphones.
- Export MP4 and review narration, captions, readable text, and duration before upload.
- Describe only the features present in the source revision shared with judges.
