/**
 * Course view — speed vs distance, split table, course map (RNZ Manager theme).
 */
(function () {
  const LS_COURSE = 'rnz_course_view_course';
  const LS_COURSE_REVERSE = 'rnz_course_view_reverse';
  const LS_ROLLING_START = 'rnz_course_view_rolling_start';
  const LS_SAVED_RACES = 'rnz_course_view_saved_races';
  const EARTH_R = 6371000;
  const REST_SPEED_MPS = 0.5;
  const ROLLING_START_DIST_M = 200;
  const ROLLING_PROGNOSTIC_PCT = 50;
  const MAX_SAVED_RACES = 30;
  const CHART_SMOOTH = { tauDistM: 40, maxAccelMps2: 1.5, glitchHoldAboveMps: 1.5 };
  const CHART_DENSIFY_STEP_M = 3;
  const DEVICE_COLORS = [
    '#00e5ff',
    '#4ade80',
    '#a78bfa',
    '#fbbf24',
    '#fb7185',
    '#38bdf8',
    '#f97316',
    '#86efac',
    '#c084fc',
    '#34d399',
  ];

  const $ = (sel) => document.querySelector(sel);

  let open = false;
  let selectedCourse = '';
  let courseMap = null;
  let courseLineLayer = null;
  let courseDeviceLayer = null;
  /** @type {Map<string, L.Marker>} */
  const courseDeviceMarkers = new Map();

  /** @type {Map<string, { lat: number, lon: number, t: number }>} */
  const lastPosByDevice = new Map();
  /** @type {Map<string, Map<number, number>>} */
  const crossingsByDevice = new Map();
  /** @type {Map<string, { distM: number, speedMps: number }[]>} */
  const tracesByDevice = new Map();
  /** @type {Map<string, { speedMps: number|null, strokeRate: number|null, online: boolean }>} */
  const liveByDevice = new Map();
  /** @type {Map<string, { mps: number, at: number }>} */
  const paceHoldByDevice = new Map();
  const PACE_HOLD_MS = 24000;
  /** @type {Set<string>} */
  const hiddenDevices = new Set();
  /** @type {Map<string, { confirmed: boolean, tMs?: number, distM?: number, lat?: number, lon?: number, pendingDistM: number, pendingStartT?: number, pendingStartAlong?: number, pendingStartLat?: number, pendingStartLon?: number, lastAlong?: number, source?: string }>} */
  const raceStartByDevice = new Map();

  /** Fine rotation preview (degrees) around fixed start line. */
  let rotationPreviewDeg = 0;
  let courseReversed = false;
  let rollingStartEnabled = true;
  /** @type {object|null} */
  let recalledRace = null;

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

  function courseWithRotation(course, deltaDeg) {
    if (!course?.start || !Number.isFinite(deltaDeg) || Math.abs(deltaDeg) < 0.01) {
      return course;
    }
    const start = course.start;
    const newBearing = (course.bearing + deltaDeg + 360) % 360;
    const startDist = course.startDist ?? 0;
    const lines = course.lines.map((line) => {
      if (line.lineType === 'start') {
        return { ...line, courseBearingDeg: newBearing };
      }
      const offsetM = (line.distanceM ?? 0) - startDist;
      const pts = parallelLineAtDistance(
        start.lat1,
        start.lon1,
        start.lat2,
        start.lon2,
        newBearing,
        offsetM,
      );
      return { ...line, ...pts, courseBearingDeg: newBearing };
    });
    const markers = lines.filter(
      (l) => l.lineType === 'start' || l.lineType === 'finish' || l.lineType === 'split',
    );
    return { ...course, lines, markers, bearing: newBearing };
  }

  function getDisplayCourse() {
    const base = parseCourse(selectedCourse);
    if (!base) return null;
    return courseWithRotation(base, rotationPreviewDeg);
  }

  function resetRotationUi() {
    rotationPreviewDeg = 0;
    const slider = $('#courseViewRotate');
    const val = $('#courseViewRotateVal');
    const saveBtn = $('#courseViewSaveRotateBtn');
    if (slider) slider.value = '0';
    if (val) val.textContent = '0.0°';
    if (saveBtn) saveBtn.disabled = true;
  }

  function updateRotationUi() {
    const val = $('#courseViewRotateVal');
    const saveBtn = $('#courseViewSaveRotateBtn');
    if (val) val.textContent = `${rotationPreviewDeg.toFixed(1)}°`;
    if (saveBtn) saveBtn.disabled = Math.abs(rotationPreviewDeg) < 0.05;
  }

  function refreshCourseView() {
    const course = getDisplayCourse();
    if (!course) return;
    ensureCourseMap(course);
    drawChart(course);
    renderTable(course);
  }

  async function saveRotation() {
    const base = parseCourse(selectedCourse);
    if (!base?.start || Math.abs(rotationPreviewDeg) < 0.05) return;
    const rotated = courseWithRotation(base, rotationPreviewDeg);
    setStatus('Saving course rotation…');
    try {
      for (const line of rotated.lines) {
        const payload = {
          lat1: line.lat1,
          lon1: line.lon1,
          lat2: line.lat2,
          lon2: line.lon2,
          courseBearingDeg: line.courseBearingDeg,
        };
        const res = await fetch(timingLinesUrl(line.id), {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `Save failed for ${line.name}`);
        }
      }
      resetRotationUi();
      if (typeof window.dashboardRefreshTimingLines === 'function') {
        window.dashboardRefreshTimingLines();
      }
      setTimeout(() => {
        refreshCourseView();
        setStatus(`Rotation saved for "${selectedCourse}".`);
      }, 400);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  function headers() {
    if (typeof window.dashboardHeaders === 'function') return window.dashboardHeaders();
    return { Accept: 'application/json' };
  }

  function apiBase() {
    if (typeof window.dashboardApiBase === 'function') return window.dashboardApiBase();
    return window.location.origin;
  }

  function timingLinesUrl(id) {
    if (typeof window.RNZ_courseViewTimingUrl === 'function') {
      return window.RNZ_courseViewTimingUrl(id);
    }
    const q = id ? `?id=${encodeURIComponent(id)}` : '';
    return `${apiBase()}/api/timing-lines${q}`;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function toRad(d) {
    return (d * Math.PI) / 180;
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.sqrt(a));
  }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180) / Math.PI;
  }

  function lineMidpoint(line) {
    return { lat: (line.lat1 + line.lat2) / 2, lon: (line.lon1 + line.lon2) / 2 };
  }

  function colorForDevice(id) {
    let h = 0;
    const s = String(id);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return DEVICE_COLORS[h % DEVICE_COLORS.length];
  }

  function getLines() {
    if (typeof window.dashboardGetTimingLines === 'function') {
      return window.dashboardGetTimingLines();
    }
    return [];
  }

  function linesForCourse(group) {
    return getLines()
      .filter((l) => l.enabled !== false && (l.courseGroup || 'Other') === group)
      .sort(
        (a, b) =>
          (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
          (a.distanceM ?? 0) - (b.distanceM ?? 0),
      );
  }

  function dedupeMarkersByDistance(markers) {
    const seen = new Set();
    const out = [];
    for (const line of markers) {
      const key =
        line.lineType === 'start'
          ? 'start'
          : line.lineType === 'finish'
            ? 'finish'
            : String(line.distanceM ?? line.id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return out;
  }

  function parseCourse(group) {
    const courseLines = linesForCourse(group);
    if (!courseLines.length) return null;
    const start = courseLines.find((l) => l.lineType === 'start') || courseLines[0];
    const startDist = start?.distanceM ?? 0;
    const finishCandidates = courseLines.filter(
      (l) => l.lineType === 'finish' && (l.distanceM ?? 0) > startDist,
    );
    const finish =
      finishCandidates.sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0))[0] ||
      [...courseLines].reverse().find((l) => l.lineType === 'finish') ||
      courseLines[courseLines.length - 1];
    let bearing = start?.courseBearingDeg;
    if (!Number.isFinite(bearing) && start) {
      bearing = (bearingDeg(start.lat1, start.lon1, start.lat2, start.lon2) + 90 + 360) % 360;
    }
    let finishDist = finish?.distanceM;
    if (!Number.isFinite(finishDist)) {
      finishDist = Math.max(
        ...courseLines
          .map((l) => l.distanceM ?? 0)
          .filter((d) => Number.isFinite(d) && d > startDist),
      );
    }
    if (!Number.isFinite(finishDist) || finishDist <= startDist) {
      finishDist = startDist + 2000;
    }
    const totalDist = finishDist - startDist;
    const lines = courseLines.filter((l) => {
      if (l.id === start.id) return true;
      const d = l.distanceM ?? 0;
      return d > startDist && d <= finishDist;
    });
    const markers = dedupeMarkersByDistance(
      lines.filter(
        (l) => l.lineType === 'start' || l.lineType === 'finish' || l.lineType === 'split',
      ),
    );
    return {
      group,
      start,
      finish,
      lines,
      markers,
      bearing,
      startDist,
      finishDist,
      totalDist,
    };
  }

  function distanceAlongCourse(lat, lon, course) {
    if (!course?.start || !Number.isFinite(course.bearing)) return null;
    const mid = lineMidpoint(course.start);
    const dist = haversineM(mid.lat, mid.lon, lat, lon);
    const brg = bearingDeg(mid.lat, mid.lon, lat, lon);
    const along = dist * Math.cos(toRad(brg - course.bearing));
    return along;
  }

  function effectiveAlong(lat, lon, course) {
    const along = distanceAlongCourse(lat, lon, course);
    if (along == null || !Number.isFinite(along)) return null;
    return courseReversed ? course.totalDist - along : along;
  }

  function timingStartLine(course) {
    if (!course) return null;
    return courseReversed && course.finish ? course.finish : course.start;
  }

  function prognosticThresholdMps(deviceId, athleteId) {
    const RS = window.RowingSpeed;
    if (!RS?.parseBoatClass || !RS?.reference2kSec) return null;
    const boat = RS.parseBoatClass(deviceId, athleteId);
    const refSec = RS.reference2kSec(boat);
    if (!refSec) return null;
    const pct = ROLLING_PROGNOSTIC_PCT / 100;
    return 2000 / (refSec / pct);
  }

  function crossingTimeForLine(deviceId, line, course) {
    const crossed = crossingsByDevice.get(deviceId);
    if (!crossed || !line) return null;
    if (crossed.has(line.id)) return crossed.get(line.id);
    if (line.distanceM == null) return null;
    for (const marker of course.markers || []) {
      if (marker.distanceM === line.distanceM && crossed.has(marker.id)) {
        return crossed.get(marker.id);
      }
    }
    return null;
  }

  function getEffectiveStartMs(deviceId, course) {
    const rolling = raceStartByDevice.get(deviceId);
    if (rolling?.confirmed && Number.isFinite(rolling.tMs)) return rolling.tMs;
    const startLine = timingStartLine(course);
    const t = crossingTimeForLine(deviceId, startLine, course);
    if (Number.isFinite(t)) {
      if (rollingStartEnabled && prognosticThresholdMps(deviceId) != null) return null;
      return t;
    }
    return null;
  }

  function isDeviceHidden(deviceId) {
    return hiddenDevices.has(deviceId);
  }

  function visibleDeviceIds(extraKeys = []) {
    const ids = new Set([...tracesByDevice.keys(), ...crossingsByDevice.keys(), ...extraKeys]);
    return [...ids]
      .filter((id) => !isDeviceHidden(id))
      .sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
  }

  function serializeCrossings(map) {
    const out = {};
    for (const [deviceId, lineMap] of map) {
      out[deviceId] = Object.fromEntries(lineMap);
    }
    return out;
  }

  function deserializeCrossings(obj) {
    const map = new Map();
    for (const [deviceId, lines] of Object.entries(obj || {})) {
      const inner = new Map();
      for (const [lineId, t] of Object.entries(lines || {})) {
        inner.set(Number(lineId), Number(t));
      }
      map.set(deviceId, inner);
    }
    return map;
  }

  function serializeTraces(map) {
    const out = {};
    for (const [deviceId, trace] of map) {
      out[deviceId] = trace.slice();
    }
    return out;
  }

  function deserializeTraces(obj) {
    const map = new Map();
    for (const [deviceId, trace] of Object.entries(obj || {})) {
      map.set(deviceId, Array.isArray(trace) ? trace.slice() : []);
    }
    return map;
  }

  function serializeRaceStarts(map) {
    const out = {};
    for (const [deviceId, st] of map) {
      out[deviceId] = { ...st };
    }
    return out;
  }

  function deserializeRaceStarts(obj) {
    const map = new Map();
    for (const [deviceId, st] of Object.entries(obj || {})) {
      map.set(deviceId, { ...st });
    }
    return map;
  }

  function loadSavedRacesList() {
    try {
      const raw = localStorage.getItem(LS_SAVED_RACES);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function persistSavedRacesList(list) {
    try {
      localStorage.setItem(LS_SAVED_RACES, JSON.stringify(list.slice(0, MAX_SAVED_RACES)));
    } catch {
      /* ignore */
    }
  }

  function populateRecallSelect() {
    const sel = $('#courseViewRecallSelect');
    if (!sel) return;
    const races = loadSavedRacesList();
    const current = recalledRace?.id != null ? String(recalledRace.id) : '';
    sel.innerHTML =
      '<option value="">Live timing</option>' +
      races
        .map(
          (r) =>
            `<option value="${r.id}"${String(r.id) === current ? ' selected' : ''}>${esc(r.name || r.courseGroup || r.id)}</option>`,
        )
        .join('');
  }

  function saveCurrentRace() {
    const course = getDisplayCourse();
    if (!course) {
      setStatus('Select a course before saving.', true);
      return;
    }
    const name =
      window.prompt('Race name (optional):', `${course.group} ${new Date().toLocaleString()}`) ||
      `${course.group} ${new Date().toLocaleString()}`;
    const race = {
      id: Date.now(),
      name,
      courseGroup: selectedCourse,
      courseReversed,
      rollingStartEnabled,
      savedAt: Date.now(),
      crossings: serializeCrossings(crossingsByDevice),
      traces: serializeTraces(tracesByDevice),
      raceStarts: serializeRaceStarts(raceStartByDevice),
      live: Object.fromEntries(liveByDevice),
      hiddenDevices: [...hiddenDevices],
    };
    const list = loadSavedRacesList();
    list.unshift(race);
    persistSavedRacesList(list);
    populateRecallSelect();
    setStatus(`Race saved: ${name}`);
  }

  function restoreRaceState(race) {
    crossingsByDevice.clear();
    for (const [k, v] of deserializeCrossings(race.crossings)) crossingsByDevice.set(k, v);
    tracesByDevice.clear();
    for (const [k, v] of deserializeTraces(race.traces)) tracesByDevice.set(k, v);
    raceStartByDevice.clear();
    for (const [k, v] of deserializeRaceStarts(race.raceStarts)) raceStartByDevice.set(k, v);
    liveByDevice.clear();
    for (const [k, v] of Object.entries(race.live || {})) liveByDevice.set(k, v);
    hiddenDevices.clear();
    for (const id of race.hiddenDevices || []) hiddenDevices.add(id);
    courseReversed = Boolean(race.courseReversed);
    rollingStartEnabled = race.rollingStartEnabled !== false;
    const revEl = $('#courseViewReverse');
    const rollEl = $('#courseViewRollingStart');
    if (revEl) revEl.checked = courseReversed;
    if (rollEl) rollEl.checked = rollingStartEnabled;
    try {
      localStorage.setItem(LS_COURSE_REVERSE, courseReversed ? '1' : '0');
      localStorage.setItem(LS_ROLLING_START, rollingStartEnabled ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  function recallRace(id) {
    if (!id) {
      recalledRace = null;
      populateRecallSelect();
      refreshCourseView();
      setStatus('Live timing restored.');
      return;
    }
    const race = loadSavedRacesList().find((r) => String(r.id) === String(id));
    if (!race) {
      setStatus('Saved race not found.', true);
      return;
    }
    recalledRace = race;
    if (race.courseGroup && race.courseGroup !== selectedCourse) {
      selectedCourse = race.courseGroup;
      const sel = $('#courseViewSelect');
      if (sel) sel.value = selectedCourse;
      localStorage.setItem(LS_COURSE, selectedCourse);
    }
    restoreRaceState(race);
    populateRecallSelect();
    refreshCourseView();
    setStatus(`Recalled: ${race.name || race.courseGroup}`);
  }

  function updateRollingStart(deviceId, { spd, along, nowMs, cur, athleteId }) {
    if (!rollingStartEnabled || recalledRace) return;
    const threshold = prognosticThresholdMps(deviceId, athleteId);
    if (threshold == null) return;

    let st = raceStartByDevice.get(deviceId);
    if (!st) {
      st = { confirmed: false, pendingDistM: 0 };
      raceStartByDevice.set(deviceId, st);
    }
    if (st.confirmed) return;

    const isFast = Number.isFinite(spd) && spd >= threshold;
    const isRest = !Number.isFinite(spd) || spd < REST_SPEED_MPS;

    if (isFast && along != null) {
      if (st.pendingStartT == null) {
        st.pendingStartT = nowMs;
        st.pendingStartAlong = along;
        st.pendingStartLat = cur.lat;
        st.pendingStartLon = cur.lon;
        st.pendingDistM = 0;
      } else if (Number.isFinite(st.lastAlong)) {
        st.pendingDistM += Math.max(0, along - st.lastAlong);
      }
      if (st.pendingDistM >= ROLLING_START_DIST_M) {
        st.confirmed = true;
        st.tMs = st.pendingStartT;
        st.distM = st.pendingStartAlong;
        st.lat = st.pendingStartLat;
        st.lon = st.pendingStartLon;
        st.source = 'rolling';
      }
    } else if (isRest) {
      st.pendingStartT = undefined;
      st.pendingDistM = 0;
      st.pendingStartAlong = undefined;
      st.pendingStartLat = undefined;
      st.pendingStartLon = undefined;
    }
    if (along != null) st.lastAlong = along;
  }

  function ccw(a, b, c) {
    return (c.lat - a.lat) * (b.lon - a.lon) > (b.lat - a.lat) * (c.lon - a.lon);
  }

  function segmentsCross(a, b, c, d) {
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  }

  function segmentsCrossDirected(prev, cur, line, course) {
    if (
      !segmentsCross(
        prev,
        cur,
        { lat: line.lat1, lon: line.lon1 },
        { lat: line.lat2, lon: line.lon2 },
      )
    ) {
      return false;
    }
    const alongPrev = effectiveAlong(prev.lat, prev.lon, course);
    const alongCur = effectiveAlong(cur.lat, cur.lon, course);
    if (alongPrev == null || alongCur == null) return false;
    return alongCur - alongPrev > 0.3;
  }

  function posFromRecord(p) {
    const lat = p.latitude ?? p.lat;
    const lon = p.longitude ?? p.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }

  function formatClock(ms) {
    if (!Number.isFinite(ms)) return '—';
    return new Date(ms).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatElapsed(ms) {
    if (!Number.isFinite(ms)) return '—';
    const sec = ms / 1000;
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
  }

  function formatSplit500(mps) {
    const RS = window.RowingSpeed;
    if (RS) return RS.formatSplit500m(mps);
    if (!Number.isFinite(mps) || mps <= 0) return '—';
    const t = 500 / mps;
    const mm = Math.floor(t / 60);
    const ss = Math.round(t - mm * 60);
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }

  function formatSpeedDisplay(mps, deviceId, athleteId) {
    const RS = window.RowingSpeed;
    if (RS) {
      const parts = [deviceId];
      if (athleteId) parts.push(athleteId);
      return RS.formatPaceWithPrognostic(mps, ...parts, { suffix: false });
    }
    return formatSplit500(mps);
  }

  /** Ticket pace from API (recent-ground EMA); falls back to 30s path. */
  function coachFacingSpeedMps(p, deviceId) {
    const now = Date.now();
    if (p?.telemetryStale === true) {
      if (deviceId) paceHoldByDevice.delete(deviceId);
      return null;
    }
    const mps = p?.displaySpeedMps ?? p?.pathSpeedMps ?? null;
    if (mps != null && Number.isFinite(mps) && mps >= 0.25) {
      if (deviceId) paceHoldByDevice.set(deviceId, { mps, at: now });
      return mps;
    }
    if (deviceId) {
      const held = paceHoldByDevice.get(deviceId);
      if (held && now - held.at <= PACE_HOLD_MS) return held.mps;
    }
    return null;
  }

  function coachFacingStrokeRate(p, stale) {
    if (stale) return null;
    const spm = p?.displayStrokeRate ?? p?.strokeRate ?? p?.attributes?.strokeRate ?? null;
    if (spm == null || !Number.isFinite(spm) || spm <= 0) return null;
    return spm;
  }

  function markerAlongM(line, course) {
    if (line?.distanceM == null || !Number.isFinite(line.distanceM)) return null;
    return courseReversed
      ? (course.finishDist ?? 0) - line.distanceM
      : line.distanceM - (course.startDist ?? 0);
  }

  function boatClassFor(deviceId, athleteId) {
    const RS = window.RowingSpeed;
    if (!RS?.parseBoatClass) return null;
    return RS.parseBoatClass(deviceId, athleteId);
  }

  function formatPrognosticForDevice(mps, deviceId, athleteId) {
    const RS = window.RowingSpeed;
    if (!RS?.formatPrognostic || mps == null || !Number.isFinite(mps) || mps <= 0) return null;
    const boat = boatClassFor(deviceId, athleteId);
    if (!boat) return null;
    return RS.formatPrognostic(mps, boat);
  }

  function prognosticPercentForDevice(mps, deviceId, athleteId) {
    const RS = window.RowingSpeed;
    if (!RS?.prognosticPercent || mps == null || !Number.isFinite(mps) || mps <= 0) return null;
    const boat = boatClassFor(deviceId, athleteId);
    if (!boat) return null;
    return RS.prognosticPercent(mps, boat);
  }

  function avgSpeedInSegment(trace, distFrom, distTo) {
    if (!trace?.length || distFrom == null || distTo == null) return null;
    const lo = Math.min(distFrom, distTo);
    const hi = Math.max(distFrom, distTo);
    const samples = trace.filter(
      (p) =>
        p.speedMps > 0 &&
        Number.isFinite(p.distM) &&
        p.distM >= lo - 0.5 &&
        p.distM <= hi + 0.5,
    );
    if (!samples.length) return null;
    return samples.reduce((sum, p) => sum + p.speedMps, 0) / samples.length;
  }

  function avgStrokeInSegment(trace, distFrom, distTo) {
    if (!trace?.length || distFrom == null || distTo == null) return null;
    const lo = Math.min(distFrom, distTo);
    const hi = Math.max(distFrom, distTo);
    const samples = trace.filter(
      (p) =>
        p.strokeRate > 0 &&
        Number.isFinite(p.distM) &&
        p.distM >= lo - 0.5 &&
        p.distM <= hi + 0.5,
    );
    if (!samples.length) return null;
    return samples.reduce((sum, p) => sum + p.strokeRate, 0) / samples.length;
  }

  function courseStats(deviceId, course, athleteId) {
    const trace = tracesByDevice.get(deviceId) || [];
    const avgMps = avgSpeedInSegment(trace, 0, course.totalDist);
    const avgSpm = avgStrokeInSegment(trace, 0, course.totalDist);
    const avgProg = formatPrognosticForDevice(avgMps, deviceId, athleteId);
    const progNum = prognosticPercentForDevice(avgMps, deviceId, athleteId);
    return { avgMps, avgSpm, avgProg, progNum };
  }

  function hasFinishedCourse(deviceId, course) {
    const crossed = crossingsByDevice.get(deviceId);
    if (!crossed || !course.finish) return false;
    return (
      crossed.has(course.finish.id) ||
      crossingTimeForLine(deviceId, course.finish, course) != null
    );
  }

  function formatPaceCell(mps, deviceId, athleteId) {
    if (mps == null || !Number.isFinite(mps) || mps <= 0) return '—';
    const split = formatSplit500(mps);
    const prog = formatPrognosticForDevice(mps, deviceId, athleteId);
    return prog ? `${split} · ${prog}` : split;
  }

  function speedFromPosition(p, prev, dtSec) {
    if (!prev || dtSec <= 0) return null;
    const cur = posFromRecord(p);
    if (!cur) return null;
    const d = haversineM(prev.lat, prev.lon, cur.lat, cur.lon);
    return d / dtSec;
  }

  function setStatus(msg, isError) {
    const el = $('#courseViewStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('poll-line--warn', !!isError);
  }

  function populateCourseSelect() {
    const sel = $('#courseViewSelect');
    if (!sel) return;
    const groups =
      typeof window.dashboardGetTimingCourseGroups === 'function'
        ? window.dashboardGetTimingCourseGroups()
        : [];
    const saved = localStorage.getItem(LS_COURSE) || '';
    sel.innerHTML =
      groups.length === 0
        ? '<option value="">No courses — add timing lines in Geofences</option>'
        : groups
            .map(
              (g) =>
                `<option value="${esc(g)}"${g === saved || g === selectedCourse ? ' selected' : ''}>${esc(g)}</option>`,
            )
            .join('');
    if (groups.length && !groups.includes(selectedCourse)) {
      selectedCourse = groups.includes(saved) ? saved : groups[0];
      sel.value = selectedCourse;
    }
  }

  function courseBounds(course) {
    const pts = [];
    for (const l of course.lines) {
      pts.push([l.lat1, l.lon1], [l.lat2, l.lon2]);
    }
    return pts;
  }

  function ensureCourseMap(course) {
    if (typeof L === 'undefined') return;
    const el = $('#courseViewMap');
    if (!el) return;

    if (!courseMap) {
      courseMap = L.map(el, { zoomControl: true, attributionControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap',
      }).addTo(courseMap);
      courseLineLayer = L.layerGroup().addTo(courseMap);
      courseDeviceLayer = L.layerGroup().addTo(courseMap);
    }

    courseLineLayer.clearLayers();
    for (const line of course.lines) {
      const style =
        line.lineType === 'start'
          ? { color: '#22c55e', weight: 3 }
          : line.lineType === 'finish'
            ? { color: '#ef4444', weight: 3 }
            : { color: '#3b82f6', weight: 2, dashArray: '8 6' };
      const label =
        line.distanceM != null
          ? `${line.name} (${Math.round(
              courseReversed
                ? (course.finishDist ?? 0) - line.distanceM
                : line.distanceM - (course.startDist ?? 0),
            )} m)${courseReversed ? ' ↺' : ''}`
          : line.name;
      L.polyline(
        [
          [line.lat1, line.lon1],
          [line.lat2, line.lon2],
        ],
        style,
      )
        .bindTooltip(label, { sticky: true })
        .addTo(courseLineLayer);
    }

    const bounds = courseBounds(course);
    if (bounds.length) {
      courseMap.fitBounds(bounds, { padding: [28, 28] });
    }
    setTimeout(() => courseMap?.invalidateSize(), 120);
  }

  function updateCourseMapDevices(positions, course) {
    if (!courseMap || !courseDeviceLayer || !course) return;
    const seen = new Set();
    for (const p of positions) {
      const id = p.deviceId || p.uniqueId;
      if (!id) continue;
      if (isDeviceHidden(id)) continue;
      const pos = posFromRecord(p);
      if (!pos) continue;
      const along = distanceAlongCourse(pos.lat, pos.lon, course);
      if (along == null || along < -80 || along > course.totalDist + 120) continue;
      seen.add(id);
      const color = colorForDevice(id);
      let marker = courseDeviceMarkers.get(id);
      const icon = L.divIcon({
        className: 'course-view-device-marker',
        html: `<span style="background:${color}"></span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      if (marker) {
        marker.setLatLng([pos.lat, pos.lon]);
        marker.setIcon(icon);
      } else {
        marker = L.marker([pos.lat, pos.lon], { icon }).bindTooltip(id, {
          direction: 'top',
          offset: [0, -8],
        });
        courseDeviceLayer.addLayer(marker);
        courseDeviceMarkers.set(id, marker);
      }
    }
    for (const [id, marker] of courseDeviceMarkers) {
      if (!seen.has(id)) {
        courseDeviceLayer.removeLayer(marker);
        courseDeviceMarkers.delete(id);
      }
    }
  }

  function smoothSpeedAlongDistance(points, opts = {}) {
    if (points.length <= 1) return points.map((p) => ({ ...p }));

    const tauDistM = opts.tauDistM ?? 40;
    const maxAccel = opts.maxAccelMps2 ?? 1.5;
    const glitchHold = opts.glitchHoldAboveMps ?? 1.5;
    const out = [{ distM: points[0].distM, speedMps: points[0].speedMps }];

    for (let i = 1; i < points.length; i++) {
      const prev = out[out.length - 1];
      const sample = points[i];
      const distDelta = Math.max(0.5, sample.distM - prev.distM);
      const avgSpd = Math.max(0.5, (prev.speedMps + sample.speedMps) / 2);
      const dtSec = distDelta / avgSpd;

      let target = sample.speedMps;
      if (target < 0.3 && prev.speedMps >= glitchHold) {
        target = prev.speedMps * Math.exp(-dtSec / 18);
      }

      const maxDelta = maxAccel * dtSec;
      const clamped = Math.max(
        prev.speedMps - maxDelta,
        Math.min(prev.speedMps + maxDelta, target),
      );
      const alpha = 1 - Math.exp(-distDelta / tauDistM);
      const speedMps = prev.speedMps + alpha * (clamped - prev.speedMps);
      out.push({ distM: sample.distM, speedMps: Math.max(0, speedMps) });
    }

    return out;
  }

  function densifyDistanceSeries(points, stepM = CHART_DENSIFY_STEP_M) {
    if (points.length <= 1) return points.map((p) => ({ ...p }));

    const step = Math.max(1, stepM);
    const out = [{ ...points[0] }];

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const span = b.distM - a.distM;
      if (span <= 0) continue;

      for (let distM = a.distM + step; distM < b.distM; distM += step) {
        const f = (distM - a.distM) / span;
        out.push({ distM, speedMps: a.speedMps + f * (b.speedMps - a.speedMps) });
      }
      out.push({ ...b });
    }

    return out;
  }

  function prepareTraceForChart(trace, maxDist) {
    const inRange = trace
      .filter(
        (pt) =>
          pt.distM >= 0 &&
          pt.distM <= maxDist &&
          Number.isFinite(pt.speedMps) &&
          pt.speedMps > 0,
      )
      .sort((a, b) => a.distM - b.distM);
    if (inRange.length < 2) return inRange;

    const deduped = [{ ...inRange[0] }];
    for (let i = 1; i < inRange.length; i++) {
      const prev = deduped[deduped.length - 1];
      const pt = inRange[i];
      if (pt.distM - prev.distM < 0.5) {
        prev.speedMps = pt.speedMps;
        prev.distM = pt.distM;
      } else {
        deduped.push({ distM: pt.distM, speedMps: pt.speedMps });
      }
    }

    return densifyDistanceSeries(
      smoothSpeedAlongDistance(deduped, CHART_SMOOTH),
      CHART_DENSIFY_STEP_M,
    );
  }

  function drawChart(course) {
    const canvas = $('#courseViewChart');
    if (!canvas || !course) return;
    const wrap = canvas.closest('.course-view__chart-wrap') || canvas.parentElement;
    const w = wrap?.clientWidth || 640;
    const h = Math.max(160, wrap?.clientHeight || 280);
    canvas.width = w * (window.devicePixelRatio || 1);
    canvas.height = h * (window.devicePixelRatio || 1);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pad = { l: 52, r: 16, t: 20, b: 40 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    ctx.fillStyle = '#0c1220';
    ctx.fillRect(0, 0, w, h);

    const maxDist = course.totalDist;
    let maxSpeed = 6;
    for (const trace of tracesByDevice.values()) {
      for (const pt of trace) {
        if (pt.speedMps > maxSpeed) maxSpeed = pt.speedMps;
      }
    }
    maxSpeed = Math.ceil(maxSpeed * 1.15 * 10) / 10;

    const xAt = (distM) => pad.l + (distM / maxDist) * plotW;
    const yAt = (spd) => pad.t + plotH - (spd / maxSpeed) * plotH;

    ctx.strokeStyle = 'rgba(0, 229, 255, 0.12)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();
    }

    for (const line of course.markers) {
      if (line.lineType === 'start' || !Number.isFinite(line.distanceM)) continue;
      const dist = courseReversed
        ? (course.finishDist ?? 0) - line.distanceM
        : line.distanceM - course.startDist;
      if (dist <= 0 || dist >= maxDist) continue;
      const x = xAt(dist);
      ctx.strokeStyle =
        line.lineType === 'finish'
          ? 'rgba(239, 68, 68, 0.55)'
          : 'rgba(59, 130, 246, 0.45)';
      ctx.setLineDash(line.lineType === 'split' ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px Segoe UI, system-ui, sans-serif';
      ctx.textAlign = 'center';
      const label =
        line.lineType === 'finish'
          ? `Finish ${Math.round(dist)}m`
          : `${Math.round(dist)}m`;
      ctx.fillText(label, x, pad.t + plotH + 14);
    }

    ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.l, pad.t, plotW, plotH);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px Segoe UI, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Distance (m)', pad.l + plotW / 2, h - 8);
    ctx.save();
    ctx.translate(14, pad.t + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Pace /500m', 0, 0);
    ctx.restore();

    for (let i = 0; i <= 4; i++) {
      const dist = (maxDist * i) / 4;
      ctx.textAlign = 'center';
      ctx.fillText(String(Math.round(dist)), xAt(dist), pad.t + plotH + 26);
    }
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const spd = (maxSpeed * i) / 4;
      ctx.fillText(formatSplit500(spd), pad.l - 6, yAt(spd) + 4);
    }

    for (const [deviceId, trace] of tracesByDevice) {
      if (isDeviceHidden(deviceId)) continue;
      const plotTrace = prepareTraceForChart(trace, maxDist);
      if (plotTrace.length < 2) continue;
      ctx.strokeStyle = colorForDevice(deviceId);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      plotTrace.forEach((pt, i) => {
        const x = xAt(pt.distM);
        const y = yAt(Math.min(pt.speedMps, maxSpeed));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    ctx.font = '11px Segoe UI, system-ui, sans-serif';
    ctx.textAlign = 'left';
    let ly = pad.t + 4;
    for (const deviceId of tracesByDevice.keys()) {
      if (isDeviceHidden(deviceId)) continue;
      ctx.fillStyle = colorForDevice(deviceId);
      ctx.fillRect(pad.l + 4, ly, 10, 10);
      ctx.fillStyle = '#e8f4fc';
      ctx.fillText(deviceId, pad.l + 18, ly + 9);
      ly += 14;
      if (ly > pad.t + plotH - 10) break;
    }
  }

  function renderTable(course) {
    const el = $('#courseViewTable');
    if (!el || !course) return;

    const ordered = [...course.markers].sort(
      (a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0),
    );

    const splitLines = ordered.filter((l) => l.lineType !== 'start');
    let prevAlong = 0;
    const segments = splitLines.map((line) => {
      const along = markerAlongM(line, course);
      const seg = { line, from: prevAlong, to: along ?? prevAlong };
      if (along != null) prevAlong = along;
      return seg;
    });

    const deviceIds = visibleDeviceIds().sort((a, b) => {
      const liveA = liveByDevice.get(a) || {};
      const liveB = liveByDevice.get(b) || {};
      const progA = courseStats(a, course, liveA.athleteId).progNum ?? -1;
      const progB = courseStats(b, course, liveB.athleteId).progNum ?? -1;
      if (progB !== progA) return progB - progA;
      return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
    });
    if (!deviceIds.length) {
      el.innerHTML =
        '<p class="poll-line">Waiting for devices on course…</p>';
      return;
    }

    let html =
      '<table class="course-view-table"><thead><tr><th>Device</th><th>Start</th>';
    for (const line of splitLines) {
      const label =
        line.distanceM != null
          ? `${Math.round(
              courseReversed
                ? (course.finishDist ?? 0) - line.distanceM
                : line.distanceM - course.startDist,
            )}m`
          : line.name;
      html += `<th>${esc(label)}</th>`;
    }
    html += '<th>Pace</th><th>Rating</th><th></th></tr></thead><tbody>';

    for (const deviceId of deviceIds) {
      const crossed = crossingsByDevice.get(deviceId) || new Map();
      const live = liveByDevice.get(deviceId) || {};
      const trace = tracesByDevice.get(deviceId) || [];
      const finished = hasFinishedCourse(deviceId, course);
      const stats = courseStats(deviceId, course, live.athleteId);
      const tStart = getEffectiveStartMs(deviceId, course);
      const rolling = raceStartByDevice.get(deviceId);
      const startLabel = tStart
        ? rolling?.confirmed
          ? `${formatClock(tStart)} ↺`
          : formatClock(tStart)
        : rollingStartEnabled && prognosticThresholdMps(deviceId, live.athleteId) != null
          ? '↺ pending'
          : '—';
      html += `<tr><td><span class="course-view-table__dot" style="background:${colorForDevice(deviceId)}"></span><strong>${esc(deviceId)}</strong></td>`;
      html += `<td>${startLabel}</td>`;
      for (const seg of segments) {
        const t = crossingTimeForLine(deviceId, seg.line, course);
        if (!t || !tStart) {
          html += '<td>—</td>';
          continue;
        }
        const elapsed = formatElapsed(t - tStart);
        const segSpeed = avgSpeedInSegment(trace, seg.from, seg.to);
        const segProg = formatPrognosticForDevice(segSpeed, deviceId, live.athleteId);
        html += `<td>${esc(elapsed)}${segProg ? ` · ${esc(segProg)}` : ''}</td>`;
      }
      let paceCell;
      if (finished) {
        paceCell =
          stats.avgMps != null ? formatPaceCell(stats.avgMps, deviceId, live.athleteId) : '—';
      } else if (live.stale && live.lastSeenAgoSec != null) {
        paceCell = `<span class="course-view-stale">Stale ${live.lastSeenAgoSec}s</span>`;
      } else {
        const spd = live.speedMps;
        paceCell =
          Number.isFinite(spd) && spd > 0
            ? formatSpeedDisplay(spd, deviceId, live.athleteId)
            : '—';
      }
      html += `<td>${paceCell}</td>`;
      let ratingCell = '—';
      if (finished) {
        ratingCell =
          stats.avgSpm != null && stats.avgSpm > 0 ? `${Math.round(stats.avgSpm)} spm` : '—';
      } else if (!live.stale && live.strokeRate != null && live.strokeRate > 0) {
        ratingCell = `${Math.round(live.strokeRate)} spm`;
      }
      html += `<td>${ratingCell}</td>`;
      html += `<td><button type="button" class="course-view-hide-btn" data-hide-device="${esc(deviceId)}">Hide</button></td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  function processPoll(positions, nowMs) {
    if (!open || !selectedCourse) return;
    if (recalledRace) return;
    const course = getDisplayCourse();
    if (!course) return;

    for (const p of positions) {
      const deviceId = p.deviceId || p.uniqueId;
      if (!deviceId) continue;
      const cur = posFromRecord(p);
      if (!cur) continue;

      const prev = lastPosByDevice.get(deviceId);
      const dtSec = prev ? Math.max(0.05, (nowMs - prev.t) / 1000) : 0;
      lastPosByDevice.set(deviceId, { ...cur, t: nowMs });

      const spd = coachFacingSpeedMps(p, deviceId);
      const receiveAgo = p.lastSeenAgoSec ?? p.ingestAgoSec ?? null;
      const stale = p.telemetryStale === true || (receiveAgo != null && receiveAgo > 30);
      const strokeRate = coachFacingStrokeRate(p, stale);
      liveByDevice.set(deviceId, {
        speedMps: stale ? null : spd,
        strokeRate: strokeRate,
        online: Boolean(p.online),
        athleteId: p.athleteId ?? null,
        stale,
        lastSeenAgoSec: receiveAgo,
      });

      const effAlong = effectiveAlong(cur.lat, cur.lon, course);
      updateRollingStart(deviceId, {
        spd: coachFacingSpeedMps(p, deviceId) ?? speedFromPosition(p, prev, dtSec),
        along: effAlong,
        nowMs,
        cur,
        athleteId: p.athleteId,
      });

      if (!crossingsByDevice.has(deviceId)) crossingsByDevice.set(deviceId, new Map());
      const crossed = crossingsByDevice.get(deviceId);
      if (prev) {
        for (const line of course.lines) {
          if (crossed.has(line.id)) continue;
          if (!segmentsCrossDirected(prev, cur, line, course)) continue;
          crossed.set(line.id, nowMs);
        }
      }

      if (effAlong == null) continue;
      const tStart = getEffectiveStartMs(deviceId, course);
      const onCourse = tStart || (effAlong >= -20 && effAlong <= course.totalDist + 40);
      if (!onCourse) continue;
      if (!Number.isFinite(spd) || spd <= 0) continue;

      const distM = Math.max(0, Math.min(course.totalDist, effAlong));
      if (!tracesByDevice.has(deviceId)) tracesByDevice.set(deviceId, []);
      const trace = tracesByDevice.get(deviceId);
      const last = trace[trace.length - 1];
      if (!last || Math.abs(last.distM - distM) > 2 || Math.abs(last.speedMps - spd) > 0.15) {
        trace.push({
          distM,
          speedMps: spd,
          strokeRate:
            strokeRate != null && Number.isFinite(strokeRate) && strokeRate > 0
              ? strokeRate
              : null,
        });
        if (trace.length > 800) trace.shift();
      }
    }

    drawChart(course);
    renderTable(course);
    updateCourseMapDevices(positions, course);
    const hiddenNote = hiddenDevices.size ? ` · ${hiddenDevices.size} hidden` : '';
    const recallNote = recalledRace ? ' · recalled race' : '';
    const reverseNote = courseReversed ? ' · reverse' : '';
    setStatus(
      `${course.group} · ${Math.round(course.totalDist)} m · ${visibleDeviceIds().length} visible on course${hiddenNote}${reverseNote}${recallNote}${Math.abs(rotationPreviewDeg) >= 0.05 ? ` · preview ${rotationPreviewDeg.toFixed(1)}°` : ''}`,
    );
  }

  function deviceIdsOnCourse() {
    let n = 0;
    for (const id of tracesByDevice.keys()) n++;
    return n;
  }

  function resetTimingData() {
    lastPosByDevice.clear();
    crossingsByDevice.clear();
    tracesByDevice.clear();
    raceStartByDevice.clear();
    courseDeviceMarkers.clear();
    courseDeviceLayer?.clearLayers();
  }

  function resetSession() {
    resetTimingData();
    liveByDevice.clear();
    paceHoldByDevice.clear();
    hiddenDevices.clear();
    recalledRace = null;
    populateRecallSelect();
    refreshCourseView();
    setStatus('Course session reset.');
  }

  function openOverlay() {
    open = true;
    const overlay = $('#courseViewOverlay');
    if (overlay) {
      overlay.hidden = false;
      overlay.setAttribute('aria-hidden', 'false');
    }
    document.body.classList.add('course-view-open');
    populateCourseSelect();
    populateRecallSelect();
    resetRotationUi();
    try {
      courseReversed = localStorage.getItem(LS_COURSE_REVERSE) === '1';
      rollingStartEnabled = localStorage.getItem(LS_ROLLING_START) !== '0';
    } catch {
      courseReversed = false;
      rollingStartEnabled = true;
    }
    const revEl = $('#courseViewReverse');
    const rollEl = $('#courseViewRollingStart');
    if (revEl) revEl.checked = courseReversed;
    if (rollEl) rollEl.checked = rollingStartEnabled;
    selectedCourse = $('#courseViewSelect')?.value || selectedCourse;
    localStorage.setItem(LS_COURSE, selectedCourse);
    const course = getDisplayCourse();
    if (course) {
      setTimeout(() => {
        refreshCourseView();
        courseMap?.invalidateSize();
      }, 80);
      setStatus(`${course.group} · ${Math.round(course.totalDist)} m course loaded.`);
    } else {
      setStatus('Add timing lines with start and finish in Geofences.');
    }
    if (typeof window.dashboardRefreshTimingLines === 'function') {
      window.dashboardRefreshTimingLines();
    }
    if (typeof window.dashboardGetLatestPositions === 'function') {
      const pos = window.dashboardGetLatestPositions();
      if (pos?.length) processPoll(pos, Date.now());
    }
  }

  function closeOverlay() {
    open = false;
    const overlay = $('#courseViewOverlay');
    if (overlay) {
      overlay.hidden = true;
      overlay.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('course-view-open');
  }

  function bind() {
    $('#courseViewBtn')?.addEventListener('click', openOverlay);
    $('#courseViewCloseBtn')?.addEventListener('click', closeOverlay);
    $('#courseViewBackdrop')?.addEventListener('click', closeOverlay);
    $('#courseViewResetBtn')?.addEventListener('click', resetSession);
    $('#courseViewSaveRaceBtn')?.addEventListener('click', saveCurrentRace);
    $('#courseViewRecallSelect')?.addEventListener('change', (ev) => {
      recallRace(ev.target.value || '');
    });
    $('#courseViewReverse')?.addEventListener('change', (ev) => {
      courseReversed = Boolean(ev.target.checked);
      try {
        localStorage.setItem(LS_COURSE_REVERSE, courseReversed ? '1' : '0');
      } catch {
        /* ignore */
      }
      resetTimingData();
      refreshCourseView();
      setStatus(courseReversed ? 'Course reversed — finish is now start.' : 'Course direction normal.');
    });
    $('#courseViewRollingStart')?.addEventListener('change', (ev) => {
      rollingStartEnabled = Boolean(ev.target.checked);
      try {
        localStorage.setItem(LS_ROLLING_START, rollingStartEnabled ? '1' : '0');
      } catch {
        /* ignore */
      }
      raceStartByDevice.clear();
      refreshCourseView();
    });
    $('#courseViewTable')?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-hide-device]');
      if (!btn) return;
      const id = btn.getAttribute('data-hide-device');
      if (!id) return;
      hiddenDevices.add(id);
      refreshCourseView();
      setStatus(`${id} hidden — data still saved. Use Save race to keep results.`);
    });
    $('#courseViewSaveRotateBtn')?.addEventListener('click', () => void saveRotation());
    $('#courseViewRotate')?.addEventListener('input', (ev) => {
      rotationPreviewDeg = Number(ev.target.value) || 0;
      updateRotationUi();
      refreshCourseView();
    });
    $('#courseViewSelect')?.addEventListener('change', (ev) => {
      selectedCourse = ev.target.value;
      localStorage.setItem(LS_COURSE, selectedCourse);
      resetRotationUi();
      resetSession();
      setTimeout(() => courseMap?.invalidateSize(), 80);
    });
    window.addEventListener('resize', () => {
      if (!open) return;
      refreshCourseView();
      courseMap?.invalidateSize();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && open) closeOverlay();
    });
  }

  window.dashboardInitCourseView = function () {
    bind();
    selectedCourse = localStorage.getItem(LS_COURSE) || '';
    try {
      courseReversed = localStorage.getItem(LS_COURSE_REVERSE) === '1';
      rollingStartEnabled = localStorage.getItem(LS_ROLLING_START) !== '0';
    } catch {
      courseReversed = false;
      rollingStartEnabled = true;
    }
  };

  window.dashboardOnPollUpdate = function (payload) {
    if (!open) return;
    processPoll(payload?.positions || [], payload?.polledAt || Date.now());
  };
})();
