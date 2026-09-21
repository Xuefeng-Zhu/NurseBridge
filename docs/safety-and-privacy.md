# Safety and privacy boundaries

**Simulation only — use fictional patient information. Not for medical care.** The AI collects information; it does not diagnose, recommend treatment, triage symptoms, infer urgency, or determine that waiting is safe.

The queue exists before consent. Live automated intake needs explicit transcription and provider-recording consent, stored with disclosure version and acceptance time. Legacy consent does not authorize recording. Declining leaves the caller waiting for a nurse. Dedicated read-back remains omitted.

The Voice Agent uses natural short questions within the collection template. Exact static wording is no longer guaranteed by the conversational model. An independent Nebius structured extraction pass validates finalized caller evidence; assistant transcripts cannot support patient facts. Exact quotes demonstrate provenance, not clinical truth or audio-verbatim speech. Unknown, uncertain, denied, not measured and reported values remain distinct. One unsuccessful clarification requests nurse help.

All callers wait for a nurse once intake completes. Explicit caller requests, technical failures, consent refusal, and explicit caller reports of emergencies also permit handoff. Emergency wording directs real emergencies to emergency services; there is no symptom classifier or clinical emergency-detection claim. Detection of explicit statements is deliberately narrow and is not comprehensive. No automatic emergency call is made.

AssemblyAI receives microphone audio only during consented automated intake. Its Voice Agent uses Nebius for conversation; separate extraction sends bounded finalized fictional turns and draft context to Nebius. Stored agent configuration requires sending a dedicated Nebius credential to AssemblyAI. Credentials remain server-side and are excluded from logs. Live setup is an explicit operator action.

Provider recordings are allowed only for fictional automated intake. Waiting and human conversation audio bypass providers. No recordings are downloaded to R2. Application transcripts, drafts and exports expire after seven days; administrator deletion can occur earlier. A durable provider-session cleanup queue calls the documented soft-deletion endpoint and retries failures. Soft deletion is not proof of physical purge or backup expiration. Provider account retention is still unverified and live activation is deliberately blocked in code until a supported policy is implemented and verified.

Sessions, invitations, tickets and case access remain workspace-scoped. Mutations enforce Origin and cookie/session authorization; sockets consume short-lived first-message tickets. Case content uses private no-store responses and is excluded from localStorage and application logs. Provider tool calls have no public action endpoint, role authority, arbitrary network access, or access to other cases.

Demo authentication, templates and scripted tests are not production clinical infrastructure. Physical audio, live provider behavior, account privacy controls and public deployment need separate verification.
