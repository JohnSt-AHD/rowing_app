/**
 * Dashboard timing lines — draw course lines, split courses, live crossing times.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  let timingLayer = null;
  let timingDraftLayer = null;
  let timingEditLayer = null;
  let lines = [];
  let drawLineMode = false;
  let editLinesMode = false;
  let lineDraft = [];
  let courseDirectionClick = false;

  /** @type {Map<string, { lat: number, lon: number, t: number }>} */
  const lastPosByDevice = new Map();
  /** @type {Map<string, Map<number, number>>} deviceId -> lineId -> crossingMs */
  const crossingsByDevice = new Map();
  let monitorEnabled = true;

  const LINE_STYLE = {
    start: { color: '#22c55e', weight: 3 },
    finish: { color: '#ef4444', weight: 3 },
    split: { color: '#3b82f6', weight: 2, dashArray: '8 6' },
  };

  function headers() {
    if (typeof window.dashboardHeaders === 'function') return window.dashboardHeaders();
    return { Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  function apiBase() {
    if (typeof window.dashboardApiBase === 'function') return window.dashboardApiBase();
    return window.location.origin;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function getMap() {
    return window.dashboardFleetMap || null;
  }

  function setStatus(msg, isError) {
    const el = $('#timingLineStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('poll-line--warn', !!isError);
  }

  function lineStyle(line) {
    const base = LINE_STYLE[line.lineType] || LINE_STYLE.split;
    return { ...base, opacity: line.enabled === false ? 0.35 : 1 };
  }

  function sortedLines() {
    return [...lines].sort((a, b) => {
      const ga = a.courseGroup || '';
      const gb = b.courseGroup || '';
      if (ga !== gb) return ga.localeCompare(gb);
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.distanceM ?? 0) - (b.distanceM ?? 0);
    });
  }

  function drawTimingLines() {
    const map = getMap();
    if (!map || typeof L === 'undefined') return;
    if (!timingLayer) timingLayer = L.layerGroup().addTo(map);
    timingLayer.clearLayers();
    timingEditLayer?.clearLayers();

    for (const line of sortedLines()) {
      if (line.enabled === false) continue;
      const latLngs = [
        [line.lat1, line.lon1],
        [line.lat2, line.lon2],
      ];
      const layer = L.polyline(latLngs, lineStyle(line));
      const label =
        line.distanceM != null ? `${esc(line.name)} · ${Math.round(line.distanceM)} m` : esc(line.name);
      layer.bindPopup(`<strong>${label}</strong><br>${esc(line.lineType)} line`);
      timingLayer.addLayer(layer);

      if (editLinesMode) {
        attachLineEditHandles(line);
      }
    }
  }

  function attachLineEditHandles(line) {
    const map = getMap();
    if (!map) return;
    if (!timingEditLayer) timingEditLayer = L.layerGroup().addTo(map);

    const saveEndpoint = async (which, lat, lon) => {
      const payload =
        which === 1
          ? { lat1: lat, lon1: lon }
          : { lat2: lat, lon2: lon };
      setStatus(`Saving ${line.name}…`);
      const res = await fetch(`${apiBase()}/api/timing-lines?id=${encodeURIComponent(line.id)}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setStatus(data.error || 'Save failed', true);
        return;
      }
      await loadTimingLines();
    };

    const mk = (lat, lon, which) =>
      L.marker([lat, lon], {
        draggable: true,
        icon: L.divIcon({
          className: 'timing-line-handle',
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        }),
      })
        .on('dragend', (e) => {
          const { lat: la, lng: lo } = e.target.getLatLng();
          void saveEndpoint(which, la, lo);
        })
        .addTo(timingEditLayer);

    mk(line.lat1, line.lon1, 1);
    mk(line.lat2, line.lon2, 2);
  }

  function updateDraftLayer() {
    const map = getMap();
    if (!map || typeof L === 'undefined') return;
    if (!timingDraftLayer) timingDraftLayer = L.layerGroup().addTo(map);
    timingDraftLayer.clearLayers();
    if (!lineDraft.length) return;
    for (const p of lineDraft) {
      L.circleMarker([p.lat, p.lon], {
        radius: 6,
        color: '#3b82f6',
        fillColor: '#fff',
        fillOpacity: 1,
        weight: 2,
      }).addTo(timingDraftLayer);
    }
    if (lineDraft.length >= 2) {
      L.polyline(
        lineDraft.map((p) => [p.lat, p.lon]),
        { color: '#3b82f6', weight: 3 },
      ).addTo(timingDraftLayer);
    }
  }

  function setDrawLineMode(on) {
    drawLineMode = on;
    if (on) {
      lineDraft = [];
      updateDraftLayer();
    }
    const btn = $('#timingDrawLineBtn');
    if (btn) {
      btn.textContent = on ? 'Click map: point 1 & 2…' : 'Draw line on map';
      btn.classList.toggle('hub-btn--primary', on);
    }
    const map = getMap();
    if (map) map.getContainer().style.cursor = on || courseDirectionClick ? 'crosshair' : '';
    const status = $('#timingDrawStatus');
    if (status) {
      status.textContent = on
        ? `Line draw: ${lineDraft.length}/2 point(s) on map.`
        : lineDraft.length >= 2
          ? 'Line ready — enter name/type and Add line.'
          : 'No line drawn yet.';
    }
  }

  function setEditLinesMode(on) {
    editLinesMode = on;
    const btn = $('#timingEditLinesBtn');
    if (btn) {
      btn.textContent = on ? 'Editing lines (drag endpoints)' : 'Edit lines on map';
      btn.classList.toggle('hub-btn--primary', on);
    }
    if (!on) timingEditLayer?.clearLayers();
    drawTimingLines();
  }

  async function loadTimingLines() {
    const res = await fetch(`${apiBase()}/api/timing-lines`, { headers: headers() });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    lines = data.lines || [];
    renderLineList();
    drawTimingLines();
    renderTimingTable();
    if (data.persisted) setStatus(`${lines.length} timing line(s) loaded.`);
  }

  function renderLineList() {
    const el = $('#timingLineList');
    if (!el) return;
    if (!lines.length) {
      el.innerHTML = '<p class="poll-line">No timing lines yet. Draw a line or generate a split course.</p>';
      return;
    }
    const groups = new Map();
    for (const line of sortedLines()) {
      const g = line.courseGroup || 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(line);
    }
    el.innerHTML = [...groups.entries()]
      .map(([group, groupLines]) => {
        const groupDelete =
          group !== 'Other'
            ? `<button type="button" class="hub-btn hub-btn--danger hub-btn--sm timing-delete-group-btn" data-group="${esc(group)}">Delete course</button>`
            : '';
        const rows = groupLines
          .map(
            (line) => `
          <div class="timing-line-item" data-id="${line.id}">
            <div class="timing-line-item__main">
              <strong>${esc(line.name)}</strong>
              <span class="timing-line-item__meta">${esc(line.lineType)}${line.distanceM != null ? ` · ${Math.round(line.distanceM)} m` : ''}</span>
            </div>
            <button type="button" class="hub-btn hub-btn--danger hub-btn--sm timing-delete-btn" data-id="${line.id}">Delete</button>
          </div>`,
          )
          .join('');
        return `<div class="timing-line-group"><div class="timing-line-group__head"><strong>${esc(group)}</strong>${groupDelete}</div>${rows}</div>`;
      })
      .join('');

    el.querySelectorAll('.timing-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => void deleteLine(btn.getAttribute('data-id')));
    });
    el.querySelectorAll('.timing-delete-group-btn').forEach((btn) => {
      btn.addEventListener('click', () => void deleteCourseGroup(btn.getAttribute('data-group')));
    });
  }

  async function deleteLine(id) {
    if (!id || !confirm('Delete this timing line?')) return;
    const res = await fetch(`${apiBase()}/api/timing-lines?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headers(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'Delete failed', true);
      return;
    }
    await loadTimingLines();
  }

  async function deleteCourseGroup(group) {
    if (!group || !confirm(`Delete entire course "${group}" and all its lines?`)) return;
    const res = await fetch(
      `${apiBase()}/api/timing-lines?courseGroup=${encodeURIComponent(group)}`,
      { method: 'DELETE', headers: headers() },
    );
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'Delete failed', true);
      return;
    }
    await loadTimingLines();
  }

  async function createLine(ev) {
    ev.preventDefault();
    if (lineDraft.length < 2) {
      setStatus('Draw a line on the map (two points).', true);
      return;
    }
    const name = $('#timingLineName')?.value?.trim();
    const lineType = $('#timingLineType')?.value || 'split';
    const distanceM = Number($('#timingLineDistance')?.value);
    if (!name) {
      setStatus('Line name is required.', true);
      return;
    }
    const payload = {
      name,
      lineType,
      lat1: lineDraft[0].lat,
      lon1: lineDraft[0].lon,
      lat2: lineDraft[1].lat,
      lon2: lineDraft[1].lon,
      distanceM: Number.isFinite(distanceM) ? distanceM : null,
    };
    setStatus('Saving line…');
    const res = await fetch(`${apiBase()}/api/timing-lines`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'Save failed', true);
      return;
    }
    lineDraft = [];
    setDrawLineMode(false);
    updateDraftLayer();
    $('#timingLineForm')?.reset();
    await loadTimingLines();
  }

  async function generateSplitCourse(ev) {
    ev.preventDefault();
    if (lineDraft.length < 2) {
      setStatus('Draw the start line on the map first (two points).', true);
      return;
    }
    const courseGroup = $('#timingCourseName')?.value?.trim() || 'Course';
    const splitIntervalM = Number($('#timingSplitInterval')?.value) || 500;
    const totalDistanceM = Number($('#timingTotalDistance')?.value) || 2000;
    const courseDirection = $('#timingCourseDirection')?.value || 'right';
    const payload = {
      generateSplits: true,
      courseGroup,
      lat1: lineDraft[0].lat,
      lon1: lineDraft[0].lon,
      lat2: lineDraft[1].lat,
      lon2: lineDraft[1].lon,
      splitIntervalM,
      totalDistanceM,
      courseDirection,
    };
    setStatus('Generating split course…');
    const res = await fetch(`${apiBase()}/api/timing-lines`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'Generate failed', true);
      return;
    }
    lineDraft = [];
    setDrawLineMode(false);
    updateDraftLayer();
    await loadTimingLines();
    setStatus(`Created ${data.lines?.length ?? 0} lines for ${courseGroup}.`);
  }

  function ccw(a, b, c) {
    return (c.lat - a.lat) * (b.lon - a.lon) > (b.lat - a.lat) * (c.lon - a.lon);
  }

  function segmentsCross(a, b, c, d) {
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  }

  function posLatLon(p) {
    const lat = p.latitude ?? p.lat;
    const lon = p.longitude ?? p.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }

  function formatMs(ms) {
    if (!Number.isFinite(ms)) return '—';
    const sec = ms / 1000;
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m > 0 ? `${m}:${s.toFixed(1).padStart(m > 0 ? 4 : 1, '0')}` : `${s.toFixed(1)}s`;
  }

  function formatSpeedMps(mps) {
    if (!Number.isFinite(mps) || mps <= 0) return '—';
    const split500 = 500 / mps;
    const mm = Math.floor(split500 / 60);
    const ss = Math.round(split500 - mm * 60);
    return `${mps.toFixed(2)} m/s (${mm}:${String(ss).padStart(2, '0')}/500)`;
  }

  function activeLines() {
    return sortedLines().filter((l) => l.enabled !== false);
  }

  function sectionLines() {
    const active = activeLines();
    const start = active.find((l) => l.lineType === 'start') || active[0];
    const finish = [...active].reverse().find((l) => l.lineType === 'finish') || active[active.length - 1];
    const splits = active.filter((l) => l.lineType === 'split' || (l.id !== start?.id && l.id !== finish?.id));
    return { start, finish, splits, all: active };
  }

  function detectCrossings(positions, nowMs) {
    if (!monitorEnabled) return;
    const { all } = sectionLines();
    if (!all.length) return;

    for (const p of positions) {
      const deviceId = p.deviceId || p.uniqueId;
      if (!deviceId) continue;
      const cur = posLatLon(p);
      if (!cur) continue;
      const prev = lastPosByDevice.get(deviceId);
      lastPosByDevice.set(deviceId, { ...cur, t: nowMs });

      if (!prev) continue;
      if (!crossingsByDevice.has(deviceId)) crossingsByDevice.set(deviceId, new Map());
      const crossed = crossingsByDevice.get(deviceId);

      for (const line of all) {
        if (crossed.has(line.id)) continue;
        const a = { lat: prev.lat, lon: prev.lon };
        const b = { lat: cur.lat, lon: cur.lon };
        const c = { lat: line.lat1, lon: line.lon1 };
        const d = { lat: line.lat2, lon: line.lon2 };
        if (segmentsCross(a, b, c, d)) {
          crossed.set(line.id, nowMs);
        }
      }
    }
    renderTimingTable();
  }

  function renderTimingTable() {
    const el = $('#timingLiveTable');
    if (!el) return;
    const { start, finish, splits, all } = sectionLines();
    if (!all.length) {
      el.innerHTML = '<p class="poll-line">Add timing lines to see live split times.</p>';
      return;
    }

    const cols = all.map((l) => ({
      id: l.id,
      label: l.distanceM != null ? `${Math.round(l.distanceM)}m` : l.name,
    }));

    const deviceIds = [...crossingsByDevice.keys()].sort();
    if (!deviceIds.length) {
      el.innerHTML =
        '<p class="poll-line">Waiting for device GPS tracks to cross lines…</p>' +
        `<p class="poll-line timing-live-cols">${cols.map((c) => esc(c.label)).join(' · ')}</p>`;
      return;
    }

    let html =
      '<table class="timing-live-table"><thead><tr><th>Device</th>' +
      cols.map((c) => `<th>${esc(c.label)}</th>`).join('') +
      '<th>Section</th><th>Speed</th></tr></thead><tbody>';

    for (const deviceId of deviceIds) {
      const crossed = crossingsByDevice.get(deviceId);
      const cells = cols.map((c) => {
        const t0 = start ? crossed.get(start.id) : null;
        const t = crossed.get(c.id);
        if (!t) return '<td>—</td>';
        if (start && c.id !== start.id && t0) {
          return `<td>+${formatMs(t - t0)}</td>`;
        }
        return `<td>${formatMs(t)}</td>`;
      });

      let section = '—';
      let speed = '—';
      if (start && finish) {
        const t0 = crossed.get(start.id);
        const t1 = crossed.get(finish.id);
        if (t0 && t1 && t1 > t0) {
          section = formatMs(t1 - t0);
          const dist = (finish.distanceM ?? 0) - (start.distanceM ?? 0);
          if (dist > 0) {
            speed = formatSpeedMps(dist / ((t1 - t0) / 1000));
          }
        } else if (t0 && !t1) {
          section = 'On course';
        }
      }

      html += `<tr><td><strong>${esc(deviceId)}</strong></td>${cells.join('')}<td>${section}</td><td>${speed}</td></tr>`;
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  function resetTimings() {
    crossingsByDevice.clear();
    lastPosByDevice.clear();
    renderTimingTable();
    setStatus('Timing crossings reset.');
  }

  function onMapClick(e) {
    if (drawLineMode) {
      if (lineDraft.length >= 2) lineDraft = [];
      lineDraft.push({ lat: e.latlng.lat, lon: e.latlng.lng });
      updateDraftLayer();
      const status = $('#timingDrawStatus');
      if (status) {
        status.textContent =
          lineDraft.length >= 2
            ? 'Line ready — add single line or generate split course.'
            : `Line draw: ${lineDraft.length}/2 point(s).`;
      }
      if (lineDraft.length >= 2) setDrawLineMode(false);
      return;
    }
  }

  function bind() {
    $('#timingLineForm')?.addEventListener('submit', createLine);
    $('#timingSplitForm')?.addEventListener('submit', generateSplitCourse);
    $('#timingDrawLineBtn')?.addEventListener('click', () => setDrawLineMode(!drawLineMode));
    $('#timingEditLinesBtn')?.addEventListener('click', () => setEditLinesMode(!editLinesMode));
    $('#timingResetBtn')?.addEventListener('click', resetTimings);
    $('#timingRefreshBtn')?.addEventListener('click', () =>
      void loadTimingLines().catch((err) => setStatus(String(err.message || err), true)),
    );
    $('#timingMonitorToggle')?.addEventListener('change', (ev) => {
      monitorEnabled = ev.target.checked;
    });

    const map = getMap();
    if (map) map.on('click', onMapClick);
  }

  window.dashboardInitTimingLines = function () {
    bind();
    void loadTimingLines().catch((e) => setStatus(String(e.message || e), true));
  };

  window.dashboardGetTimingLines = function () {
    return lines.slice();
  };

  window.dashboardGetTimingCourseGroups = function () {
    const groups = new Set();
    for (const line of lines) {
      if (line.enabled === false) continue;
      groups.add(line.courseGroup || 'Other');
    }
    return [...groups].sort();
  };

  window.dashboardOnMapPositions = function (positions, nowMs) {
    detectCrossings(positions || [], nowMs || Date.now());
  };

  window.dashboardRefreshTimingLines = function () {
    void loadTimingLines().catch(() => {});
  };
})();
