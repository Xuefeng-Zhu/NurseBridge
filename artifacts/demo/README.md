# NurseBridge demo video

[nursebridge-demo.mp4](nursebridge-demo.mp4) is an 80-second, 1920 × 1080 narrated walkthrough. It has H.264 video, AAC narration, and an embedded selectable subtitle track; [nursebridge-demo.srt](nursebridge-demo.srt) is also provided separately.

The screenshots are of the local application. The intake scenes come from the synthetic, scripted browser acceptance flow in `tests/browser/acceptance.spec.ts`; its **mock transcript replay is not microphone transcription**. The workspace opening was captured from the running local Workers preview. No patient information, invitation secret, or external media appears in the video. The narration uses macOS's local Samantha voice.

The video demonstrates isolated workspace creation, the caller experience, the nurse's evidence-linked draft and visible correction, and connected two-way browser audio takeover. It does not show a live-provider transcription session or physical-device audio. The nurse view and transcript are fictional; source words support human review and are not medical validation. NurseBridge does not diagnose, triage, or determine that waiting is safe.

The source screenshots are in [source](source), scene timing is in [scene-timings.json](scene-timings.json), narration copy is in [narration.md](narration.md), and the silent visual montage can be regenerated with `python3 scripts/render-demo.py` from the repository root (requires Pillow and FFmpeg). The completed MP4 is the shareable artifact.
