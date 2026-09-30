#!/usr/bin/env python3
"""Render the synthetic NurseBridge browser walkthrough from acceptance screenshots.

The images are captured app UI from a scripted browser test. The final video is
deliberately labelled as a mock replay; it is not a recording of live patient care.
"""

from __future__ import annotations

import json
import argparse
import shutil
import subprocess
import tempfile
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "artifacts/demo"
SOURCES = DEST / "source"
W, H = 1920, 1080
FPS = 24
BG = "#f3f6f3"
INK = "#22383a"
TEAL = "#135f59"
MUTED = "#657774"
AMBER = "#9d6319"
CREAM = "#fff9ed"
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(BOLD if bold else FONT, size)


def fit_lines(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    result: list[str] = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        line = ""
        for word in words:
            candidate = f"{line} {word}".strip()
            if line and draw.textbbox((0, 0), candidate, font=face)[2] > max_width:
                result.append(line)
                line = word
            else:
                line = candidate
        if line:
            result.append(line)
    return result


def wrapped(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, face: ImageFont.FreeTypeFont,
            fill: str, max_width: int, line_height: int) -> int:
    x, y = xy
    for line in fit_lines(draw, text, face, max_width):
        draw.text((x, y), line, font=face, fill=fill)
        y += line_height
    return y


def badge(draw: ImageDraw.ImageDraw, dark: bool = False) -> None:
    x0, y0, x1, y1 = 1445, 28, 1840, 76
    draw.rounded_rectangle((x0, y0, x1, y1), radius=24,
                           fill="#3c4641" if dark else CREAM,
                           outline="#b67a2b" if dark else "#eadbbd", width=2)
    draw.ellipse((x0 + 20, y0 + 19, x0 + 31, y0 + 30), fill="#eabf77" if dark else AMBER)
    draw.text((x0 + 44, y0 + 12), "MOCK REPLAY  /  SYNTHETIC DATA", font=font(20, True),
              fill="#fff1d7" if dark else AMBER)


def brand(draw: ImageDraw.ImageDraw, dark: bool = False) -> None:
    c = "#f3f9f7" if dark else INK
    draw.rounded_rectangle((82, 27, 132, 77), radius=12, fill="#207067" if not dark else "#f4fcf9")
    cross = "#f4fcf9" if not dark else TEAL
    draw.rounded_rectangle((104, 36, 111, 68), radius=3, fill=cross)
    draw.rounded_rectangle((92, 48, 123, 56), radius=3, fill=cross)
    draw.text((153, 31), "NurseBridge", font=font(37, True), fill=c)


def progress(draw: ImageDraw.ImageDraw, current: int, dark: bool = False) -> None:
    base = "#65817b" if dark else "#cad8d3"
    active = "#ccdfd7" if dark else TEAL
    start, gap, bar = 760, 66, 48
    for i in range(7):
        draw.rounded_rectangle((start + i * gap, 1030, start + i * gap + bar, 1036),
                               radius=3, fill=active if i <= current else base)


def chrome(draw: ImageDraw.ImageDraw, index: int, dark: bool = False) -> None:
    brand(draw, dark)
    badge(draw, dark)
    draw.line((80, 105, 1840, 105), fill="#426260" if dark else "#dbe5df", width=2)
    draw.text((82, 1012), "BROWSER CALLING  •  HUMAN REVIEW REQUIRED", font=font(20, True),
              fill="#a9c3ba" if dark else MUTED)
    progress(draw, index, dark)


def screenshot(path: Path, box: tuple[int, int, int, int], crop: tuple[int, int, int, int],
               canvas: Image.Image, label: str | None = None) -> None:
    x0, y0, x1, y1 = box
    shadow = ImageDraw.Draw(canvas)
    shadow.rounded_rectangle((x0 + 14, y0 + 16, x1 + 14, y1 + 16), radius=22, fill="#d8e0dc")
    shadow.rounded_rectangle((x0, y0, x1, y1), radius=22, fill="white", outline="#d8e2dc", width=2)
    src = Image.open(path).convert("RGB").crop(crop)
    target_w, target_h = x1 - x0 - 28, y1 - y0 - (60 if label else 28)
    contained = ImageOps.contain(src, (target_w, target_h), Image.Resampling.LANCZOS)
    sx = x0 + 14 + (target_w - contained.width) // 2
    sy = y0 + (50 if label else 14) + (target_h - contained.height) // 2
    canvas.paste(contained, (sx, sy))
    if label:
        shadow.text((x0 + 26, y0 + 15), label, font=font(18, True), fill=MUTED)


def ordinary(index: int, step: str, title: str, body: str, note: str,
             shot: str, crop: tuple[int, int, int, int]) -> Image.Image:
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    chrome(d, index)
    d.text((92, 214), step, font=font(23, True), fill=TEAL)
    end = wrapped(d, (88, 278), title, font(64, True), INK, 560, 74)
    end = wrapped(d, (91, max(455, end + 29)), body, font(31), INK, 550, 47)
    d.rounded_rectangle((90, 756, 638, 898), radius=16, fill="#e5f1eb")
    d.rectangle((90, 772, 98, 879), fill=TEAL)
    wrapped(d, (121, 780), note, font(24, True), TEAL, 486, 37)
    screenshot(DEST / f"{shot}.png" if shot in ("landing", "workspace-ready") else SOURCES / shot,
               (708, 158, 1833, 914), crop, canvas, "ACTUAL APP UI  •  SCRIPTED BROWSER TEST")
    return canvas


def title_card(index: int, title: str, body: str, final: bool = False) -> Image.Image:
    canvas = Image.new("RGB", (W, H), "#193536")
    d = ImageDraw.Draw(canvas)
    chrome(d, index, True)
    d.ellipse((-230, 300, 530, 1090), outline="#2f7770", width=4)
    d.ellipse((-90, 420, 410, 945), outline="#2f7770", width=3)
    d.text((105, 226), "NURSEBRIDGE DEMONSTRATION" if not final else "THE HUMAN HANDOFF",
           font=font(26, True), fill="#afddd2")
    end = wrapped(d, (100, 310), title, font(80, True), "#f3faf6", 1030, 95)
    wrapped(d, (104, end + 27), body, font(33), "#d4e7de", 990, 50)
    d.rounded_rectangle((104, 825, 840, 917), radius=18, fill="#235a55")
    d.text((130, 850), "Fictional information  •  Browser call  •  Human review",
           font=font(26, True), fill="#f2faf7")
    if not final:
        screenshot(DEST / "demo-landing.png", (1110, 258, 1810, 793),
                   (202, 141, 1315, 862), canvas, None)
    else:
        screenshot(SOURCES / "human-handoff.png", (1110, 258, 1810, 793),
                   (110, 302, 1408, 759), canvas, None)
    return canvas


def evidence_card() -> Image.Image:
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    chrome(d, 4)
    d.text((92, 214), "04 / EVIDENCE", font=font(23, True), fill=TEAL)
    end = wrapped(d, (88, 278), "Evidence stays close.", font(64, True), INK, 560, 74)
    wrapped(d, (91, max(455, end + 29)),
            "Facts link to the caller’s words. Corrections remain visible, and “not measured” remains uncertain.",
            font(31), INK, 550, 47)
    d.rounded_rectangle((90, 756, 638, 898), radius=16, fill="#e5f1eb")
    d.rectangle((90, 772, 98, 879), fill=TEAL)
    wrapped(d, (121, 780), "Source words support review; they do not medically validate a fact.",
            font(24, True), TEAL, 486, 37)

    x0, y0, x1, y1 = 708, 158, 1833, 914
    d.rounded_rectangle((x0 + 14, y0 + 16, x1 + 14, y1 + 16), radius=22, fill="#d8e0dc")
    d.rounded_rectangle((x0, y0, x1, y1), radius=22, fill="white", outline="#d8e2dc", width=2)
    d.text((x0 + 26, y0 + 15), "ACTUAL APP UI  •  TWO CROPS FROM THE SAME NURSE VIEW",
           font=font(18, True), fill=MUTED)
    src = Image.open(SOURCES / "nurse-evidence.png").convert("RGB")
    # Left: current draft and its explicit uncertainty. Right: revision history.
    left = src.crop((385, 778, 1060, 1570))
    right = src.crop((1090, 376, 1408, 675))
    left = ImageOps.contain(left, (700, 677), Image.Resampling.LANCZOS)
    right = ImageOps.contain(right, (355, 677), Image.Resampling.LANCZOS)
    canvas.paste(left, (741, 209))
    canvas.paste(right, (1460, 209))
    d.line((1448, 210, 1448, 886), fill="#dce7e0", width=3)
    return canvas


def render_slide(index: int) -> Image.Image:
    if index == 0:
        return title_card(0, "The caller’s story.\nReady for a human conversation.",
                          "An evidence-linked intake draft and a two-way nurse handoff, shown with synthetic information.")
    if index == 1:
        return ordinary(1, "01 / START", "Start privately.",
                        "Each visitor creates an isolated demo workspace. A short-lived invitation brings a caller into another browser.",
                        "The walkthrough uses fictional details only.", "workspace-ready", (202, 141, 1315, 896))
    if index == 2:
        return ordinary(2, "02 / CALLER", "A caller tells their story.",
                        "The scripted replay exercises intake and spoken corrections. The caller can request a person at any time.",
                        "This visual uses supplied transcript fixtures, not live microphone transcription.",
                        "caller-intake.png", (310, 420, 1210, 1054))
    if index == 3:
        return ordinary(3, "03 / NURSE VIEW", "The nurse sees context.",
                        "The queue and patient-reported draft sit together, with source words ready for review.",
                        "Queue order follows arrival time, not clinical urgency.",
                        "nurse-evidence.png", (90, 256, 1060, 940))
    if index == 4:
        return evidence_card()
    if index == 5:
        return ordinary(5, "05 / TAKEOVER", "A person joins the same call.",
                        "The nurse takes over with two-way browser audio. Both sides see when the human connection is ready.",
                        "Automated provider forwarding stops after takeover.",
                        "human-handoff.png", (110, 302, 1408, 759))
    return title_card(6, "Human review stays in control.",
                      "NurseBridge prepares context. It does not diagnose, triage, or decide that waiting is safe.", True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--silent", action="store_true", help="Render only the visual montage (no macOS say required).")
    parser.add_argument("--preview-dir", type=Path, help="Also save the seven slide PNGs for visual inspection.")
    args = parser.parse_args()
    if not args.silent and not shutil.which("say"):
        raise SystemExit("Narration requires macOS say. Use --silent for a visual-only render.")
    DEST.mkdir(parents=True, exist_ok=True)
    missing = [p for p in (DEST / "demo-landing.png", DEST / "workspace-ready.png", SOURCES / "caller-intake.png",
                            SOURCES / "nurse-evidence.png", SOURCES / "human-handoff.png") if not p.exists()]
    if missing:
        raise SystemExit(f"Missing browser screenshots: {missing}")
    durations = [8, 10, 12, 13, 13, 13, 11]
    labels = ["title", "workspace", "caller", "nurse queue", "evidence", "human takeover", "closing"]
    timeline = []
    elapsed = 0
    narration = [line.split("|")[3].strip() for line in (DEST / "narration.md").read_text().splitlines()
                 if line.startswith("| ") and line.split("|")[1].strip().isdigit()]
    if len(narration) != len(durations):
        raise SystemExit("narration.md must contain one voiceover row per scene.")
    if args.preview_dir:
        args.preview_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="nursebridge-demo-") as tmpstr:
        tmp = Path(tmpstr)
        clips = []
        for i, duration in enumerate(durations):
            slide = tmp / f"scene-{i}.png"
            clip = tmp / f"scene-{i}.mp4"
            render_slide(i).save(slide, optimize=True)
            if args.preview_dir:
                shutil.copy2(slide, args.preview_dir / slide.name)
            # A slight push-in gives the genuine browser captures motion while
            # preserving readable labels and avoiding a fake screen recording.
            vf = ("zoompan=z='min(zoom+0.00003,1.012)':"
                  "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
                  f"d=1:s={W}x{H}:fps={FPS},"
                  f"fade=t=in:st=0:d=0.32,fade=t=out:st={duration-0.32}:d=0.32")
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-loop", "1",
                   "-framerate", str(FPS), "-i", str(slide), "-t", str(duration),
                   "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast",
                   "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(FPS), str(clip)]
            subprocess.run(cmd, check=True)
            clips.append(clip)
            timeline.append({"scene": labels[i], "start": elapsed, "end": elapsed + duration})
            elapsed += duration
        listfile = tmp / "clips.txt"
        listfile.write_text("".join(f"file '{p}'\n" for p in clips))
        output = DEST / "nursebridge-demo-silent.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat",
                        "-safe", "0", "-i", str(listfile), "-c", "copy", str(output)], check=True)
        if not args.silent:
            audio_clips, subtitles = [], []
            def timestamp(seconds: float) -> str:
                ms = round(seconds * 1000)
                return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"
            for i, (voiceover, scene) in enumerate(zip(narration, timeline)):
                words, speech, audio = tmp / f"voice-{i}.txt", tmp / f"voice-{i}.aiff", tmp / f"audio-{i}.wav"
                words.write_text(voiceover)
                subprocess.run(["say", "-v", "Samantha", "-r", "168", "-f", str(words), "-o", str(speech)], check=True)
                length = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                                       "-of", "default=noprint_wrappers=1:nokey=1", str(speech)], text=True))
                duration = scene["end"] - scene["start"]
                if length + 0.8 > duration - 0.2:
                    raise SystemExit(f"Scene {i + 1} narration is too long; shorten the text or increase its duration.")
                subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(speech),
                                "-af", f"adelay=800,apad,atrim=0:{duration}", "-ar", "48000", "-ac", "1", str(audio)], check=True)
                audio_clips.append(audio)
                subtitles.append(f"{i + 1}\n{timestamp(scene['start'] + 0.8)} --> {timestamp(scene['start'] + 0.8 + length)}\n"
                                 + "\n".join(textwrap.wrap(voiceover, width=54)) + "\n")
            srt = DEST / "nursebridge-demo.srt"
            srt.write_text("\n".join(subtitles))
            audio_list = tmp / "audio.txt"
            audio_list.write_text("".join(f"file '{p}'\n" for p in audio_clips))
            final = DEST / "nursebridge-demo.mp4"
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(output), "-f", "concat",
                            "-safe", "0", "-i", str(audio_list), "-i", str(srt), "-map", "0:v", "-map", "1:a", "-map", "2:s",
                            "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng",
                            "-movflags", "+faststart", "-t", str(elapsed), str(final)], check=True)
            output.unlink()
            output = final
    (DEST / "scene-timings.json").write_text(json.dumps({"duration_seconds": elapsed, "scenes": timeline}, indent=2) + "\n")
    print(output)


if __name__ == "__main__":
    main()
