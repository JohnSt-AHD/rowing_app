/**
 * Dashboard timing lines — draw course lines, split courses, live crossing times.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  let timingLayer = null;
  let timingDraftLayer = null;
  let timingEditLayer = null;
  let lines = [];
  let drawMode = null;
  let editLinesMode = false;
  let startDraft = [];
  let finishDraft = [];
  let previewLayer = null;
  let monitorCourseGroup = localStorage.getItem('rnz_timing_monitor_course') || '';

  const EARTH_R = 6371000;

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

  function toRad(d) {
    return (d * Math.PI) / 180;
  }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180) / Math.PI;
  }

  function destinationLatLon(lat, lon, brg, distM) {
    if (!Number.isFinite(distM) || distM <= 0) return [lat, lon];
    const δ = distM / EARTH_R;
    const θ = toRad(brg);
    const φ1 = toRad(lat);
    const λ1 = toRad(lon);
    const φ2 = Math.asin(
      Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
    );
    const λ2 =
      λ1 +
      Math.atan2(
        Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
        Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
      );
    return [(φ2 * 180) / Math.PI, (λ2 * 180) / Math.PI];
  }

  function parallelLineAtDistance(lat1, lon1, lat2, lon2, courseBearingDeg, offsetM) {
    const [a1, b1] = destinationLatLon(lat1, lon1, courseBearingDeg, offsetM);
    const [a2, b2] = destinationLatLon(lat2, lon2, courseBearingDeg, offsetM);
    return { lat1: a1, lon1: b1, lat2: a2, lon2: b2 };
  }

  function courseBearingFromLine(lat1, lon1, lat2, lon2, direction) {
    const lineBrg = bearingDeg(lat1, lon1, lat2, lon2);
    return direction === 'left' ? (lineBrg + 270) % 360 : (lineBrg + 90) % 360;
  }

  function lineMidpoint(lat1, lon1, lat2, lon2) {
    return { lat: (lat1 + lat2) / 2, lon: (lon1 + lon2) / 2 };
  }

  function distanceAlongBearing(lat1, lon1, lat2, lon2, bearing) {
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const dist =
      2 *
      EARTH_R *
      Math.asin(
        Math.sqrt(
          Math.sin((φ2 - φ1) / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2,
        ),
      );
    if (dist < 0.01) return 0;
    const toBrg = (Math.atan2(y, x) * 180) / Math.PI;
    const Δ = toRad(((toBrg - bearing) + 540) % 360 - 180);
    return dist * Math.cos(Δ);
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δλ = toRad(lon2 - lon1);
    const a =
      Math.sin((φ2 - φ1) / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.sqrt(a));
  }

  function getSelectedLineId(selId) {
    const v = $(selId)?.value;
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function lineById(id) {
    return lines.find((l) => Number(l.id) === id) || null;
  }

  /** @returns {{ lat1: number, lon1: number, lat2: number, lon2: number } | null} */
  function resolveStartLine() {
    const selId = getSelectedLineId('#timingSelectStart');
    if (selId) {
      const line = lineById(selId);
      if (line) return { lat1: line.lat1, lon1: line.lon1, lat2: line.lat2, lon2: line.lon2 };
    }
    if (startDraft.length >= 2) {
      return {
        lat1: startDraft[0].lat,
        lon1: startDraft[0].lon,
        lat2: startDraft[1].lat,
        lon2: startDraft[1].lon,
      };
    }
    return null;
  }

  /** @returns {{ lat1: number, lon1: number, lat2: number, lon2: number } | null} */
  function resolveFinishLine() {
    const selId = getSelectedLineId('#timingSelectFinish');
    if (selId) {
      const line = lineById(selId);
      if (line) return { lat1: line.lat1, lon1: line.lon1, lat2: line.lat2, lon2: line.lon2 };
    }
    if (finishDraft.length >= 2) {
      return {
        lat1: finishDraft[0].lat,
        lon1: finishDraft[0].lon,
        lat2: finishDraft[1].lat,
        lon2: finishDraft[1].lon,
      };
    }
    return null;
  }

  function measureCourseDistanceM(start, finish, direction) {
    const brg = courseBearingFromLine(start.lat1, start.lon1, start.lat2, start.lon2, direction);
    const sm = lineMidpoint(start.lat1, start.lon1, start.lat2, start.lon2);
    const fm = lineMidpoint(finish.lat1, finish.lon1, finish.lat2, finish.lon2);
    let d = distanceAlongBearing(sm.lat, sm.lon, fm.lat, fm.lon, brg);
    if (d <= 0) {
      const altBrg = (brg + 180) % 360;
      d = distanceAlongBearing(sm.lat, sm.lon, fm.lat, fm.lon, altBrg);
    }
    return d > 0 ? d : null;
  }

  function computeSplitDistances(totalDistanceM, splitCount) {
    const total = Number(totalDistanceM);
    const n = Math.max(0, Math.floor(Number(splitCount) || 0));
    if (!Number.isFinite(total) || total <= 0) return [];
    if (n === 0) return [];
    const step = total / (n + 1);
    const out = [];
    for (let i = 1; i <= n; i++) out.push(Math.round(step * i));
    return out;
  }

  function updateSplitPreview() {
    const el = $('#timingSplitPreview');
    const measuredEl = $('#timingMeasuredDistance');
    if (!el) return;

    const direction = $('#timingCourseDirection')?.value || 'right';
    const target = Number($('#timingTotalDistance')?.value) || 2000;
    const splitCount = Number($('#timingSplitCount')?.value) || 0;
    const adjust = $('#timingAdjustDistance')?.checked !== false;
    const parallel = $('#timingParallelLines')?.checked !== false;

    const start = resolveStartLine();
    const finish = resolveFinishLine();
    let total = target;
    let measured = null;

    if (start && finish) {
      measured = measureCourseDistanceM(start, finish, direction);
      if (measured != null) {
        if (adjust) {
          total = target;
          if (measuredEl) {
            measuredEl.textContent = `Measured between lines: ${Math.round(measured)} m → adjusting to ${Math.round(total)} m (parallel lines moved equally).`;
          }
        } else {
          total = measured;
          if (measuredEl) {
            measuredEl.textContent = `Measured course distance: ${Math.round(measured)} m (using drawn line positions).`;
          }
        }
      } else if (measuredEl) {
        measuredEl.textContent =
          'Could not measure distance — check course direction or finish placement.';
      }
    } else if (start) {
      total = target;
      if (measuredEl) {
        measuredEl.textContent = 'Finish not set — finish line will be generated at target distance.';
      }
    } else if (measuredEl) {
      measuredEl.textContent = '';
    }

    const splits = computeSplitDistances(total, splitCount);
    const parallelNote = parallel ? 'parallel' : 'as drawn';
    if (!splitCount) {
      el.textContent = `Start and finish only · ${Math.round(total)} m (${parallelNote}).`;
    } else {
      el.textContent = `Splits at ${splits.map((d) => `${d} m`).join(', ')} · finish at ${Math.round(total)} m (${parallelNote}).`;
    }
    updateCoursePreviewLayer();
  }

  function updateCoursePreviewLayer() {
    const map = getMap();
    const start = resolveStartLine();
    if (!map || typeof L === 'undefined' || !start) {
      previewLayer?.clearLayers();
      return;
    }
    if (!previewLayer) previewLayer = L.layerGroup().addTo(map);
    previewLayer.clearLayers();

    const { lat1, lon1, lat2, lon2 } = start;
    const dir = $('#timingCourseDirection')?.value || 'right';
    const brg = courseBearingFromLine(lat1, lon1, lat2, lon2, dir);
    const adjust = $('#timingAdjustDistance')?.checked !== false;
    const parallel = $('#timingParallelLines')?.checked !== false;
    const target = Number($('#timingTotalDistance')?.value) || 2000;
    const splitCount = Number($('#timingSplitCount')?.value) || 0;

    const finish = resolveFinishLine();
    let total = target;
    if (finish) {
      const measured = measureCourseDistanceM(start, finish, dir);
      if (measured != null) total = adjust ? target : measured;
    }

    const splits = computeSplitDistances(total, splitCount);

    const drawLine = (pts, style) => {
      L.polyline(
        [
          [pts.lat1, pts.lon1],
          [pts.lat2, pts.lon2],
        ],
        style,
      ).addTo(previewLayer);
    };

    drawLine({ lat1, lon1, lat2, lon2 }, { color: '#22c55e', weight: 2, dashArray: '6 4', opacity: 0.85 });

    for (const d of splits) {
      drawLine(parallelLineAtDistance(lat1, lon1, lat2, lon2, brg, d), {
        color: '#3b82f6',
        weight: 2,
        dashArray: '8 6',
        opacity: 0.7,
      });
    }

    const finishPts =
      finish && !parallel
        ? finish
        : parallelLineAtDistance(lat1, lon1, lat2, lon2, brg, total);
    drawLine(finishPts, {
      color: '#ef4444',
      weight: 2,
      dashArray: '6 4',
      opacity: 0.85,
    });
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

    const drawDraft = (draft, color) => {
      if (!draft.length) return;
      for (const p of draft) {
        L.circleMarker([p.lat, p.lon], {
          radius: 6,
          color,
          fillColor: '#fff',
          fillOpacity: 1,
          weight: 2,
        }).addTo(timingDraftLayer);
      }
      if (draft.length >= 2) {
        L.polyline(
          draft.map((p) => [p.lat, p.lon]),
          { color, weight: 3 },
        ).addTo(timingDraftLayer);
      }
    };

    drawDraft(startDraft, '#22c55e');
    drawDraft(finishDraft, '#ef4444');
  }

  function updateDrawStatus() {
    const status = $('#timingDrawStatus');
    if (!status) return;
    const startOk = !!resolveStartLine();
    const finishOk = !!resolveFinishLine();
    if (drawMode === 'start') {
      status.textContent = `Start line: ${startDraft.length}/2 point(s) on map.`;
    } else if (drawMode === 'finish') {
      status.textContent = `Finish line: ${finishDraft.length}/2 point(s) on map.`;
    } else if (startOk && finishOk) {
      status.textContent = 'Start and finish ready — set options and click Generate course.';
    } else if (startOk) {
      status.textContent = 'Start line ready — draw or select finish, or generate from target distance only.';
    } else {
      status.textContent = 'Draw or select start and finish lines on the map.';
    }
  }

  function updateDrawButtons() {
    const startBtn = $('#timingDrawStartBtn');
    const finishBtn = $('#timingDrawFinishBtn');
    if (startBtn) {
      startBtn.textContent = drawMode === 'start' ? 'Click map: start line…' : 'Draw start line';
      startBtn.classList.toggle('hub-btn--primary', drawMode === 'start');
    }
    if (finishBtn) {
      finishBtn.textContent = drawMode === 'finish' ? 'Click map: finish line…' : 'Draw finish line';
      finishBtn.classList.toggle('hub-btn--primary', drawMode === 'finish');
    }
    const map = getMap();
    if (map) map.getContainer().style.cursor = drawMode ? 'crosshair' : '';
    updateDrawStatus();
  }

  function setDrawMode(mode) {
    if (drawMode === mode) {
      drawMode = null;
    } else {
      drawMode = mode;
      if (mode === 'start') startDraft = [];
      if (mode === 'finish') finishDraft = [];
    }
    updateDraftLayer();
    updateDrawButtons();
    updateCoursePreviewLayer();
  }

  function populateLineSelects() {
    const startSel = $('#timingSelectStart');
    const finishSel = $('#timingSelectFinish');
    if (!startSel || !finishSel) return;

    const startVal = startSel.value;
    const finishVal = finishSel.value;
    const opts = lines
      .map((line) => {
        const label = `${line.courseGroup ? line.courseGroup + ' · ' : ''}${line.name} (${line.lineType})`;
        return `<option value="${line.id}">${esc(label)}</option>`;
      })
      .join('');

    startSel.innerHTML = `<option value="">— draw on map —</option>${opts}`;
    finishSel.innerHTML = `<option value="">— draw on map —</option>${opts}`;
    if (startVal) startSel.value = startVal;
    if (finishVal) finishSel.value = finishVal;
  }

  function setEditLinesMode(on) {
    editLinesMode = on;
    const btn = $('#timingEditLinesBtn');
    if (btn) {
      btn.textContent = on ? 'Editing course (drag endpoints)' : 'Edit course on map';
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
    populateLineSelects();
    populateMonitorCourseSelect();
    drawTimingLines();
    renderTimingTable();
    if (data.persisted) setStatus(`${lines.length} line(s) across timing courses loaded.`);
  }

  function courseSummary(groupLines) {
    const finish = groupLines.find((l) => l.lineType === 'finish');
    const splits = groupLines.filter((l) => l.lineType === 'split');
    const total = finish?.distanceM;
    const splitList = splits
      .map((l) => l.distanceM)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (Number.isFinite(total)) {
      if (splitList.length) {
        return `${Math.round(total)} m · ${splitList.length} split(s) at ${splitList.map((d) => `${Math.round(d)}m`).join(', ')}`;
      }
      return `${Math.round(total)} m · start + finish`;
    }
    return `${groupLines.length} parallel lines`;
  }

  function populateMonitorCourseSelect() {
    const sel = $('#timingMonitorCourse');
    if (!sel) return;
    const groups = typeof window.dashboardGetTimingCourseGroups === 'function'
      ? window.dashboardGetTimingCourseGroups()
      : [];
    sel.innerHTML =
      '<option value="">All courses</option>' +
      groups.map((g) => `<option value="${esc(g)}"${g === monitorCourseGroup ? ' selected' : ''}>${esc(g)}</option>`).join('');
  }

  function linesForMonitor() {
    const active = sortedLines().filter((l) => l.enabled !== false);
    if (!monitorCourseGroup) return active;
    return active.filter((l) => (l.courseGroup || 'Other') === monitorCourseGroup);
  }

  function renderLineList() {
    const el = $('#timingLineList');
    if (!el) return;
    if (!lines.length) {
      el.innerHTML =
        '<p class="poll-line">No courses yet. Draw or select start and finish lines, then Generate course.</p>';
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
        const summary = courseSummary(groupLines);
        const lineRows = groupLines
          .map(
            (line) => `
          <li class="timing-course-line">
            <span class="timing-course-line__type timing-course-line__type--${esc(line.lineType)}">${esc(line.lineType)}</span>
            ${esc(line.name)}${line.distanceM != null ? ` · ${Math.round(line.distanceM)} m` : ''}
          </li>`,
          )
          .join('');
        return `<div class="timing-line-group">
          <div class="timing-line-group__head">
            <div>
              <strong>${esc(group)}</strong>
              <span class="timing-line-item__meta">${esc(summary)}</span>
            </div>
            <button type="button" class="hub-btn hub-btn--danger hub-btn--sm timing-delete-group-btn" data-group="${esc(group)}">Delete</button>
          </div>
          <ul class="timing-course-lines">${lineRows}</ul>
        </div>`;
      })
      .join('');

    el.querySelectorAll('.timing-delete-group-btn').forEach((btn) => {
      btn.addEventListener('click', () => void deleteCourseGroup(btn.getAttribute('data-group')));
    });
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

  async function createCourse(ev) {
    ev.preventDefault();
    const start = resolveStartLine();
    const finish = resolveFinishLine();
    const startLineId = getSelectedLineId('#timingSelectStart');
    const finishLineId = getSelectedLineId('#timingSelectFinish');

    if (!start) {
      setStatus('Draw or select a start line first.', true);
      return;
    }

    const courseGroup = $('#timingCourseName')?.value?.trim();
    const totalDistanceM = Number($('#timingTotalDistance')?.value);
    const splitCount = Number($('#timingSplitCount')?.value);
    const courseDirection = $('#timingCourseDirection')?.value || 'right';
    const parallelLines = $('#timingParallelLines')?.checked !== false;
    const adjustToDistance = $('#timingAdjustDistance')?.checked !== false;

    if (!courseGroup) {
      setStatus('Course name is required.', true);
      return;
    }

    const payload = {
      generateCourse: true,
      courseGroup,
      lat1: start.lat1,
      lon1: start.lon1,
      lat2: start.lat2,
      lon2: start.lon2,
      splitCount: Number.isFinite(splitCount) ? splitCount : 0,
      courseDirection,
      parallelLines,
      adjustToDistance,
    };

    if (startLineId && finishLineId) {
      payload.startLineId = startLineId;
      payload.finishLineId = finishLineId;
      delete payload.lat1;
      delete payload.lon1;
      delete payload.lat2;
      delete payload.lon2;
      if (adjustToDistance) {
        if (!Number.isFinite(totalDistanceM) || totalDistanceM < 100) {
          setStatus('Target distance must be at least 100 m when adjusting.', true);
          return;
        }
        payload.totalDistanceM = totalDistanceM;
      }
    } else if (finish) {
      payload.finishLat1 = finish.lat1;
      payload.finishLon1 = finish.lon1;
      payload.finishLat2 = finish.lat2;
      payload.finishLon2 = finish.lon2;
      if (adjustToDistance) {
        if (!Number.isFinite(totalDistanceM) || totalDistanceM < 100) {
          setStatus('Target distance must be at least 100 m when adjusting.', true);
          return;
        }
        payload.totalDistanceM = totalDistanceM;
      }
    } else {
      if (!Number.isFinite(totalDistanceM) || totalDistanceM < 100) {
        setStatus('Target distance must be at least 100 m when finish is not drawn.', true);
        return;
      }
      payload.totalDistanceM = totalDistanceM;
    }

    setStatus('Generating course…');
    const res = await fetch(`${apiBase()}/api/timing-lines`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'Create failed', true);
      return;
    }
    startDraft = [];
    finishDraft = [];
    drawMode = null;
    $('#timingSelectStart') && ($('#timingSelectStart').value = '');
    $('#timingSelectFinish') && ($('#timingSelectFinish').value = '');
    updateDrawButtons();
    previewLayer?.clearLayers();
    updateDraftLayer();
    monitorCourseGroup = courseGroup;
    localStorage.setItem('rnz_timing_monitor_course', courseGroup);
    await loadTimingLines();
    setStatus(`Course "${courseGroup}" created with ${data.lines?.length ?? 0} lines.`);
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

  function formatSpeedDisplay(mps, deviceId, athleteId) {
    const RS = window.RowingSpeed;
    if (!RS) return '—';
    return RS.formatPaceWithPrognostic(mps, deviceId, athleteId, { suffix: true });
  }

  function formatSpeedMps(mps, deviceId, athleteId) {
    return formatSpeedDisplay(mps, deviceId, athleteId);
  }

  function activeLines() {
    return linesForMonitor();
  }

  function sectionLines() {
    const active = linesForMonitor();
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
      el.innerHTML = '<p class="poll-line">Create a course to see live split times.</p>';
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
      '<th>Section</th><th>Pace</th></tr></thead><tbody>';

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
            speed = formatSpeedMps(dist / ((t1 - t0) / 1000), deviceId);
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
    if (!drawMode) return;
    const draft = drawMode === 'start' ? startDraft : finishDraft;
    if (draft.length >= 2) {
      if (drawMode === 'start') startDraft = [];
      else finishDraft = [];
    }
    const target = drawMode === 'start' ? startDraft : finishDraft;
    target.push({ lat: e.latlng.lat, lon: e.latlng.lng });
    if (drawMode === 'start') {
      $('#timingSelectStart') && ($('#timingSelectStart').value = '');
    } else {
      $('#timingSelectFinish') && ($('#timingSelectFinish').value = '');
    }
    updateDraftLayer();
    updateDrawButtons();
    updateCoursePreviewLayer();
    if (target.length >= 2) drawMode = null;
    updateDrawButtons();
  }

  function bind() {
    $('#timingCourseForm')?.addEventListener('submit', createCourse);
    $('#timingDrawStartBtn')?.addEventListener('click', () => setDrawMode('start'));
    $('#timingDrawFinishBtn')?.addEventListener('click', () => setDrawMode('finish'));
    $('#timingEditLinesBtn')?.addEventListener('click', () => setEditLinesMode(!editLinesMode));
    $('#timingResetBtn')?.addEventListener('click', resetTimings);
    $('#timingRefreshBtn')?.addEventListener('click', () =>
      void loadTimingLines().catch((err) => setStatus(String(err.message || err), true)),
    );
    $('#timingMonitorToggle')?.addEventListener('change', (ev) => {
      monitorEnabled = ev.target.checked;
    });
    $('#timingMonitorCourse')?.addEventListener('change', (ev) => {
      monitorCourseGroup = ev.target.value;
      localStorage.setItem('rnz_timing_monitor_course', monitorCourseGroup);
      renderTimingTable();
    });
    $('#timingSelectStart')?.addEventListener('change', () => {
      startDraft = [];
      updateDraftLayer();
      updateSplitPreview();
      updateDrawStatus();
    });
    $('#timingSelectFinish')?.addEventListener('change', () => {
      finishDraft = [];
      updateDraftLayer();
      updateSplitPreview();
      updateDrawStatus();
    });
    [
      '#timingTotalDistance',
      '#timingSplitCount',
      '#timingCourseDirection',
      '#timingParallelLines',
      '#timingAdjustDistance',
    ].forEach((sel) => {
      $(sel)?.addEventListener('input', updateSplitPreview);
      $(sel)?.addEventListener('change', updateSplitPreview);
    });

    const map = getMap();
    if (map) map.on('click', onMapClick);
    updateSplitPreview();
    updateDrawButtons();
  }

  window.dashboardInitTimingLines = function () {
    bind();
    void loadTimingLines().catch((e) => setStatus(String(e.message || e), true));
  };

  window.dashboardComputeSplitDistances = computeSplitDistances;

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
