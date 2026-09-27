#!/usr/bin/env python3
"""Embed kri-speed-compare-data.json into kri-speed-compare.html."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "assets" / "crewsight"
data = json.loads((ROOT / "kri-speed-compare-data.json").read_text(encoding="utf-8"))
html = (ROOT / "kri-speed-compare.html").read_text(encoding="utf-8")

fetch_block = """    fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then(buildCharts)
      .catch(err => {
        document.getElementById('meta').innerHTML = '<span class="err">Failed to load ' + DATA_URL + ': ' + err.message + '</span><br>Serve this folder (e.g. <code>npx serve assets/crewsight</code>) or re-run <code>python scripts/collect-kri-speed-compare.py</code>.';
      });"""

html = html.replace("const DATA_URL = './kri-speed-compare-data.json';", "")
html = html.replace(fetch_block, f"    buildCharts({json.dumps(data, separators=(',', ':'))});")
(ROOT / "kri-speed-compare.html").write_text(html, encoding="utf-8")
print(f"Baked {len(data['samples'])} samples into {ROOT / 'kri-speed-compare.html'}")
