#!/usr/bin/env python3
"""Compare KRI vs CrewSight GPS reporting (103a130 KRI vs current CrewSight)."""
import re
import urllib.request
from pathlib import Path
from urllib.parse import quote

SHA = "103a1308933828e7fe278b012cb530ee882d200a"
BASE = f"https://raw.githubusercontent.com/JohnSt-AHD/rowing_app/{SHA}"
ROOT = Path(__file__).resolve().parents[1]


def fetch(path: str) -> str:
    url = BASE + "/" + quote(path, safe="/")
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read().decode("utf-8", errors="replace")


def extract_block(text: str, start_pat: str, end_pat: str | None = None) -> str:
    m = re.search(start_pat, text, re.MULTILINE)
    if not m:
        return "(not found)"
    start = m.start()
    if end_pat:
        m2 = re.search(end_pat, text[m.end() :], re.MULTILINE)
        end = m.end() + m2.start() if m2 else len(text)
    else:
        # next method at same indent private/public
        m2 = re.search(r"\n    (?:public|private) ", text[m.end() :])
        end = m.end() + m2.start() if m2 else min(len(text), m.end() + 2000)
    return text[start:end].strip()


def summarize_gps(label: str, text: str) -> None:
    print(f"\n{'=' * 60}\n{label}\n{'=' * 60}")
    checks = {
        "deliverLocation uploads GPS": "maybeUploadGpsFix" in extract_block(
            text, r"private void deliverLocation"
        ),
        "tickScheduled cached+fresh (double)": bool(
            re.search(
                r"tickScheduledGpsUpload[\s\S]*?maybeUploadGpsFix\(cached[\s\S]*?maybeUploadGpsFix\(copyLocationForUpload",
                text,
            )
        ),
        "tickScheduled fresh-first single": bool(
            re.search(
                r"tickScheduledGpsUpload[\s\S]*?requestFreshGpsLocation[\s\S]*?if \(loc != null\)[\s\S]*?return;[\s\S]*?cached = resolveCachedUploadLocation",
                text,
            )
        ),
        "economy overrides gps interval": bool(
            re.search(r"economyActive \? economyGpsIntervalMs : gpsIntervalMs", text)
        ),
        "fused upload on deliverLocation": bool(
            re.search(
                r"deliverLocation[\s\S]*?maybeUploadGpsFix\(copyLocationForUpload\(location\), false\)",
                text,
            )
        ),
        "geofence in recorder.ts": False,
        "HR upload path": "enableHr" in text or "HeartRate" in text,
        "compass on GPS sample": "compass" in text.lower(),
        "live map mode": "liveMapActive" in text,
    }
    for k, v in checks.items():
        if k == "geofence in recorder.ts":
            continue
        print(f"  {'Y' if v else 'N'}  {k}")

    for name, pat in [
        ("deliverLocation", r"private void deliverLocation\("),
        ("tickScheduledGpsUpload", r"/\*\* Timer[\s\S]*?private void tickScheduledGpsUpload\("),
        ("effectiveGpsIntervalMs", r"private long effectiveGpsIntervalMs\("),
        ("locationTrackingIntervalMs", r"/\*\* Fused[\s\S]*?private long locationTrackingIntervalMs\("),
    ]:
        block = extract_block(text, pat)
        print(f"\n--- {name} ---")
        print(block[:1200] + ("..." if len(block) > 1200 else ""))


kri_java = fetch("apps/kri-native/android/app/src/main/java/nz/org/kri/gps/CapsizeMonitorService.java")
cs_old_java = fetch(
    "apps/recorder-native/android/app/src/main/java/nz/org/rowing/recorder/CapsizeMonitorService.java"
)
cs_new_java = (ROOT / "apps/recorder-native/android/app/src/main/java/nz/org/rowing/recorder/CapsizeMonitorService.java").read_text(
    encoding="utf-8"
)

kri_rec = fetch("KRI GPS/src/session/recorder.ts")
cs_old_rec = fetch("apps/recorder-pwa/src/session/recorder.ts")
cs_new_rec = (ROOT / "apps/recorder-pwa/src/session/recorder.ts").read_text(encoding="utf-8")

for label, text in [
    ("KRI native @103a130", kri_java),
    ("CrewSight native @103a130", cs_old_java),
    ("CrewSight native CURRENT (local)", cs_new_java),
]:
    summarize_gps(label, text)

print(f"\n{'=' * 60}\nPWA recorder.ts — geofence / economy\n{'=' * 60}")
for label, text in [
    ("KRI GPS @103a130", kri_rec),
    ("CrewSight @103a130", cs_old_rec),
    ("CrewSight CURRENT", cs_new_rec),
]:
    has_geo = "geofence" in text.lower() or "inBoatPark" in text
    has_economy = "applyEconomyMode" in text
    has_hr = "enableHr" in text or "HeartRate" in text
    user_wins = "settings.gpsIntervalMs" in text and "effectiveGpsIntervalMs = settings.gpsIntervalMs" in text
    print(f"\n{label}:")
    print(f"  geofence/economy: {'Y' if has_geo or has_economy else 'N'}")
    print(f"  heart rate: {'Y' if has_hr else 'N'}")
    print(f"  user interval always wins: {'Y' if user_wins else 'N'}")

# Line counts
print(f"\n{'=' * 60}\nFile sizes\n{'=' * 60}")
print(f"  KRI CapsizeMonitorService:     {len(kri_java.splitlines())} lines")
print(f"  CrewSight @103a130:             {len(cs_old_java.splitlines())} lines")
print(f"  CrewSight current:              {len(cs_new_java.splitlines())} lines")
