#!/usr/bin/env python3
"""Package only the reviewed presentation files; never include source or local state."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "artifacts/submission"
FILES = [
    DEST / "nursebridge-pitch.pdf",
    DEST / "nursebridge-pitch.pptx",
    DEST / "nursebridge-cover.png",
    DEST / "submission-copy.txt",
    ROOT / "artifacts/demo/nursebridge-demo.mp4",
    ROOT / "artifacts/demo/nursebridge-demo.srt",
]
README = """NurseBridge submission materials — refreshed September 29, 2026

nursebridge-pitch.pdf: seven-slide presentation with selectable text.
nursebridge-pitch.pptx: editable presentation.
nursebridge-cover.png: 1920 x 1080 cover.
submission-copy.txt: title, short description, long description and tags.
nursebridge-demo.mp4: 80-second narrated mock walkthrough, 1080p with captions.
nursebridge-demo.srt: external subtitles.

The walkthrough uses fictional transcript replay and current local UI screenshots.
It is not a live-provider or physical-device recording. Separate repository evidence
records the September 29 local AssemblyAI/Nebius test with recorded microphone inputs.

This packet is prepared locally and has not been submitted. It is not application
source. Public source access, a hosted interactive URL, event registration and the
signed-in submission form still need completion. Review event-specific requirements
before uploading each individual file. The PDF and video are separate form assets;
this convenience ZIP does not replace the source or interactive application links.
"""


def main() -> None:
    for source in FILES:
        if not source.is_file():
            raise SystemExit(f"Missing reviewed artifact: {source.relative_to(ROOT)}")
    output = DEST / "nursebridge-submission-pack.zip"
    temporary = output.with_suffix(".zip.tmp")
    with ZipFile(temporary, "w", compression=ZIP_DEFLATED) as bundle:
        for source in FILES:
            bundle.write(source, arcname=source.name)
        bundle.writestr("README.txt", README)
    with ZipFile(temporary) as bundle:
        if bundle.testzip() is not None:
            raise SystemExit("Bundle integrity check failed.")
        for source in FILES:
            if bundle.read(source.name) != source.read_bytes():
                raise SystemExit(f"Bundle content mismatch: {source.name}")
    temporary.replace(output)
    print(f"Verified {len(FILES)} assets and README: {output}")


if __name__ == "__main__":
    main()
