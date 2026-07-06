/**
 * Course view — speed vs distance, split table, course map (RNZ Manager theme).
 */
(function () {
  const LS_COURSE = 'rnz_course_view_course';
  const EARTH_R = 6371000;
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

  /** Fine rotation preview (degrees) around fixed start line. */
  let rotationPreviewDeg = 0;

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

  function parseCourse(group) {
    const lines = linesForCourse(group);
    if (!lines.length) return null;
    const start = lines.find((l) => l.lineType === 'start') || lines[0];
    const finish =
      [...lines].reverse().find((l) => l.lineType === 'finish') ||
      lines[lines.length - 1];
    let bearing = start?.courseBearingDeg;
    if (!Number.isFinite(bearing) && start) {
      bearing = (bearingDeg(start.lat1, start.lon1, start.lat2, start.lon2) + 90 + 360) % 360;
    }
    const startDist = start?.distanceM ?? 0;
    let finishDist = finish?.distanceM;
    if (!Number.isFinite(finishDist)) {
      finishDist = Math.max(...lines.map((l) => l.distanceM ?? 0).filter(Number.isFinite));
    }
    if (!Number.isFinite(finishDist) || finishDist <= startDist) {
      finishDist = startDist + 2000;
    }
    const totalDist = finishDist - startDist;
    const markers = lines.filter(
      (l) => l.lineType === 'start' || l.lineType === 'finish' || l.lineType === 'split',
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

  function ccw(a, b, c) {
    return (c.lat - a.lat) * (b.lon - a.lon) > (b.lat - a.lat) * (c.lon - a.lon);
  }

  function segmentsCross(a, b, c, d) {
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
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

  function formatSpeedDisplay(mps, deviceId) {
    const RS = window.RowingSpeed;
    if (RS) return RS.formatPaceWithPrognostic(mps, deviceId, { suffix: true });
    return `${formatSplit500(mps)}/500`;
  }

  function speedFromPosition(p, prev, dtSec) {
    const spd = p.speed ?? p.attributes?.speed;
    if (Number.isFinite(spd) && spd > 0) return spd;
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
          ? `${line.name} (${Math.round(line.distanceM - (course.startDist ?? 0))} m)`
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
      const dist = line.distanceM - course.startDist;
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
      if (trace.length < 2) continue;
      ctx.strokeStyle = colorForDevice(deviceId);
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (const pt of trace) {
        if (pt.distM < 0 || pt.distM > maxDist) continue;
        const x = xAt(pt.distM);
        const y = yAt(Math.min(pt.speedMps, maxSpeed));
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (started) ctx.stroke();
    }

    ctx.font = '11px Segoe UI, system-ui, sans-serif';
    ctx.textAlign = 'left';
    let ly = pad.t + 4;
    for (const deviceId of tracesByDevice.keys()) {
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

    const deviceIds = [...new Set([...tracesByDevice.keys(), ...crossingsByDevice.keys()])].sort();
    if (!deviceIds.length) {
      el.innerHTML =
        '<p class="poll-line">Waiting for devices on course…</p>';
      return;
    }

    let html =
      '<table class="course-view-table"><thead><tr><th>Device</th><th>Start</th>';
    for (const line of ordered) {
      if (line.lineType === 'start') continue;
      const label =
        line.distanceM != null
          ? `${Math.round(line.distanceM - course.startDist)}m`
          : line.name;
      html += `<th>${esc(label)}</th>`;
    }
    html += '<th>Pace</th><th>Rating</th></tr></thead><tbody>';

    for (const deviceId of deviceIds) {
      const crossed = crossingsByDevice.get(deviceId) || new Map();
      const live = liveByDevice.get(deviceId) || {};
      const tStart = course.start ? crossed.get(course.start.id) : null;
      html += `<tr><td><span class="course-view-table__dot" style="background:${colorForDevice(deviceId)}"></span><strong>${esc(deviceId)}</strong></td>`;
      html += `<td>${tStart ? formatClock(tStart) : '—'}</td>`;
      for (const line of ordered) {
        if (line.lineType === 'start') continue;
        const t = crossed.get(line.id);
        if (!t || !tStart) {
          html += '<td>—</td>';
          continue;
        }
        html += `<td>${formatElapsed(t - tStart)}</td>`;
      }
      const spd = live.speedMps;
      html += `<td>${Number.isFinite(spd) && spd > 0 ? formatSpeedDisplay(spd, deviceId) : '—'}</td>`;
      html += `<td>${live.strokeRate != null && live.strokeRate > 0 ? `${Math.round(live.strokeRate)} spm` : '—'}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  function processPoll(positions, nowMs) {
    if (!open || !selectedCourse) return;
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

      const spd = speedFromPosition(p, prev, dtSec);
      liveByDevice.set(deviceId, {
        speedMps: spd,
        strokeRate:
          p.strokeRateValid && p.strokeRate != null
            ? p.strokeRate
            : p.attributes?.strokeRate ?? null,
        online: Boolean(p.online),
      });

      if (!crossingsByDevice.has(deviceId)) crossingsByDevice.set(deviceId, new Map());
      const crossed = crossingsByDevice.get(deviceId);
      if (prev) {
        for (const line of course.lines) {
          if (crossed.has(line.id)) continue;
          if (
            segmentsCross(
              { lat: prev.lat, lon: prev.lon },
              { lat: cur.lat, lon: cur.lon },
              { lat: line.lat1, lon: line.lon1 },
              { lat: line.lat2, lon: line.lon2 },
            )
          ) {
            crossed.set(line.id, nowMs);
          }
        }
      }

      const along = distanceAlongCourse(cur.lat, cur.lon, course);
      if (along == null) continue;
      const tStart = course.start ? crossed.get(course.start.id) : null;
      const onCourse = tStart || (along >= -20 && along <= course.totalDist + 40);
      if (!onCourse) continue;
      if (!Number.isFinite(spd) || spd <= 0) continue;

      const distM = Math.max(0, Math.min(course.totalDist, along));
      if (!tracesByDevice.has(deviceId)) tracesByDevice.set(deviceId, []);
      const trace = tracesByDevice.get(deviceId);
      const last = trace[trace.length - 1];
      if (!last || Math.abs(last.distM - distM) > 2 || Math.abs(last.speedMps - spd) > 0.15) {
        trace.push({ distM, speedMps: spd });
        if (trace.length > 800) trace.shift();
      }
    }

    drawChart(course);
    renderTable(course);
    updateCourseMapDevices(positions, course);
    setStatus(
      `${course.group} · ${Math.round(course.totalDist)} m · ${deviceIdsOnCourse()} device(s) on course${Math.abs(rotationPreviewDeg) >= 0.05 ? ` · preview ${rotationPreviewDeg.toFixed(1)}°` : ''}`,
    );
  }

  function deviceIdsOnCourse() {
    let n = 0;
    for (const id of tracesByDevice.keys()) n++;
    return n;
  }

  function resetSession() {
    lastPosByDevice.clear();
    crossingsByDevice.clear();
    tracesByDevice.clear();
    liveByDevice.clear();
    courseDeviceMarkers.clear();
    courseDeviceLayer?.clearLayers();
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
    resetRotationUi();
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
  };

  window.dashboardOnPollUpdate = function (payload) {
    if (!open) return;
    processPoll(payload?.positions || [], payload?.polledAt || Date.now());
  };
})();
