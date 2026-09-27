#!/usr/bin/env python3
"""Query production /api/devices for stroke/battery fields."""
import json
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


data = get("/api/devices?includeMetrics=1&windowMs=120000")
for d in data.get("devices") or []:
    if d.get("deviceId") not in ("M1x TM", "W2x EH"):
        continue
    print(json.dumps({
        "deviceId": d.get("deviceId"),
        "online": d.get("online"),
        "totalSamples": d.get("totalSamples"),
        "motion": d.get("motion"),
        "rowing": d.get("rowing"),
        "battery": d.get("battery"),
    }, indent=2))
