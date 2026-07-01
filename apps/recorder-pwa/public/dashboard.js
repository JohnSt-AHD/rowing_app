const LS_TOKEN = 'rnz_dashboard_token';
const LS_POLL = 'rnz_dashboard_poll_ms';
const LS_POLL_BEFORE_SMOOTH = 'rnz_dashboard_poll_before_smooth';
const LS_STALE = 'rnz_dashboard_stale_sec';
const LS_MAP_POSITION = 'rnz_dashboard_map_position';
const LS_MAP_FOLLOW = 'rnz_dashboard_map_follow';
/** @deprecated migrated to LS_MAP_POSITION */
const LS_LIVE_MAP = 'rnz_dashboard_live_map';
const LS_PREDICT_MODE = 'rnz_dashboard_predict_mode';
const LS_DEVICE_COLLAPSE = 'rnz_device_collapse';

const MAP_CENTER = [-37.9305, 175.5485];
const MAP_ZOOM = 12;
const ONLINE_SEC = 120;
/** GPS fix age thresholds (seconds) for map/card colours. */
const GPS_LIVE_SEC = 30;
const GPS_STALE_SEC = 300;
/** Dead-reckoning cap after last fix (seconds). */
const MAP_INTERPOLATE_MAX_SEC = 8;
const MAP_INTERPOLATE_MIN_SPEED_MPS = 0.25;
const MAP_INTERPOLATE_TICK_MS = 100;
const EARTH_RADIUS_M = 6371000;

const $ = (sel) => document.querySelector(sel);

let map = null;
let markersLayer = null;
/** @type {Map<string, L.Marker>} */
const deviceMarkers = new Map();
let mapFollowFleet = loadMapFollowPref();
let mapIgnoreMoveEvents = false;
let lastPollDurationMs = null;
let lastMapDurationMs = null;
/** @type {Map<string, object>} */
const deviceTrackState = new Map();
let mapInterpTimer = null;
/** @type {object[]} */
let latestMapPositions = [];

function apiBase() {
  return window.location.origin;
}

window.dashboardApiBase = apiBase;

function headers() {
  const token = $('#token')?.value?.trim() || localStorage.getItem(LS_TOKEN) || '';
  const h = { Accept: 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

window.dashboardHeaders = headers;

function savePrefs() {
  const token = $('#token')?.value?.trim();
  if (token) localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_POLL, String($('#pollMs')?.value || 2000));
  localStorage.setItem(LS_STALE, String($('#staleSec')?.value || 3600));
  const mapMode = $('#mapPositionMode')?.value;
  if (mapMode === 'raw' || mapMode === 'smoothed') {
    localStorage.setItem(LS_MAP_POSITION, mapMode);
  }
  const predictMode = $('#predictMode')?.value;
  if (predictMode) localStorage.setItem(LS_PREDICT_MODE, predictMode);
}

function currentMapPositionMode() {
  const v =
    $('#mapPositionMode')?.value ||
    localStorage.getItem(LS_MAP_POSITION) ||
    (localStorage.getItem(LS_LIVE_MAP) === '1' ? 'smoothed' : 'raw');
  return v === 'smoothed' ? 'smoothed' : 'raw';
}

function isMapSmoothed() {
  return currentMapPositionMode() === 'smoothed';
}

function currentPredictMode() {
  const v = $('#predictMode')?.value || localStorage.getItem(LS_PREDICT_MODE) || 'rowing';
  return v === 'car' ? 'car' : 'rowing';
}

function isSmoothLiveMapEnabled() {
  return isMapSmoothed();
}

function updatePredictModeField() {
  const field = $('#predictModeField');
  const smoothed = isMapSmoothed();
  if (field) field.classList.toggle('ahd-field--muted', !smoothed);
}

function currentPollMs() {
  return Number($('#pollMs')?.value || localStorage.getItem(LS_POLL) || 2000);
}

function formatRefreshRateLabel() {
  const ms = currentPollMs();
  const sec = ms / 1000;
  const interval =
    sec >= 1
      ? `${Number.isInteger(sec) ? sec : sec.toFixed(1)} s`
      : `${ms} ms`;
  const smooth = isMapSmoothed() ? ' · smoothed' : ' · raw GPS';
  return `Refresh: ${interval}${smooth}`;
}

function applyMapPositionMode() {
  const smoothed = isMapSmoothed();
  const pollEl = $('#pollMs');
  const legendEl = $('#mapLegendInterpolate');
  document.querySelector('.hub-panel--map')?.classList.toggle('hub-panel--smooth-live', smoothed);
  if (legendEl) legendEl.hidden = !smoothed;
  updatePredictModeField();

  if (smoothed) {
    if (pollEl && pollEl.value !== '1000') {
      localStorage.setItem(LS_POLL_BEFORE_SMOOTH, pollEl.value);
      pollEl.value = '1000';
    }
    if (pollEl) pollEl.disabled = true;
    startMapInterpolation();
  } else {
    if (pollEl) {
      const wasLocked = pollEl.disabled;
      pollEl.disabled = false;
      if (wasLocked) {
        const before = localStorage.getItem(LS_POLL_BEFORE_SMOOTH);
        pollEl.value = before || '2000';
        if (before) localStorage.removeItem(LS_POLL_BEFORE_SMOOTH);
      }
    }
    stopMapInterpolation();
    deviceTrackState.clear();
    if (latestMapPositions.length) updateMap(latestMapPositions);
  }
  savePrefs();
  updateRefreshRateLabel();
}

function applySmoothLiveMap() {
  applyMapPositionMode();
}

function updateRefreshRateLabel() {
  const el = $('#refreshRateLabel');
  if (el) el.textContent = formatRefreshRateLabel();
}

function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function destinationLatLon(lat, lon, course, distanceM) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const δ = distanceM / EARTH_RADIUS_M;
  const θ = toRad(course);
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
  return [toDeg(φ2), ((toDeg(λ2) + 540) % 360) - 180];
}

function positionFixMs(p) {
  if (p.fixMs != null && Number.isFinite(p.fixMs)) return p.fixMs;
  if (p.fixAgeSec != null && Number.isFinite(p.fixAgeSec)) {
    return Date.now() - p.fixAgeSec * 1000;
  }
  return Date.now();
}

function mapAnchorLatLon(p) {
  if (!isSmoothLiveMapEnabled()) {
    return { lat: p.latitude, lon: p.longitude };
  }
  const slat = p.smoothLatitude ?? p.latitude;
  const slon = p.smoothLongitude ?? p.longitude;
  if (slat != null && slon != null) return { lat: slat, lon: slon };
  return { lat: p.latitude, lon: p.longitude };
}

function syncDeviceTrackState(positions) {
  const seen = new Set();
  for (const p of positions) {
    if (p.latitude == null || p.longitude == null) continue;
    seen.add(p.deviceId);
    const fixMs = positionFixMs(p);
    const { lat, lon } = mapAnchorLatLon(p);
    const prev = deviceTrackState.get(p.deviceId);
    let speedMps = p.speed ?? null;
    let courseDeg = p.course ?? null;

    if (prev && prev.fixMs !== fixMs) {
      const dt = (fixMs - prev.fixMs) / 1000;
      if (dt > 0.05) {
        const dist = haversineM(prev.lat, prev.lon, lat, lon);
        speedMps = dist / dt;
        courseDeg = bearingDeg(prev.lat, prev.lon, lat, lon);
      }
    } else if (prev) {
      speedMps = prev.speedMps;
      courseDeg = prev.courseDeg;
    }

    deviceTrackState.set(p.deviceId, {
      ...p,
      lat,
      lon,
      fixMs,
      speedMps,
      courseDeg,
    });
  }

  for (const id of deviceTrackState.keys()) {
    if (!seen.has(id)) deviceTrackState.delete(id);
  }
}

function extrapolateLatLon(state, nowMs) {
  const fixAgeSec = (nowMs - state.fixMs) / 1000;
  if (!state.online || fixAgeSec > GPS_LIVE_SEC) {
    return { lat: state.lat, lon: state.lon };
  }
  const elapsedSec = Math.max(0, (nowMs - state.fixMs) / 1000);
  const stepSec = Math.min(elapsedSec, MAP_INTERPOLATE_MAX_SEC);
  const speed = state.speedMps;
  if (
    speed != null &&
    speed >= MAP_INTERPOLATE_MIN_SPEED_MPS &&
    state.courseDeg != null &&
    Number.isFinite(state.courseDeg)
  ) {
    const [lat, lon] = destinationLatLon(
      state.lat,
      state.lon,
      state.courseDeg,
      speed * stepSec,
    );
    return { lat, lon };
  }
  return { lat: state.lat, lon: state.lon };
}

function displayLatLonForPosition(p) {
  if (!isSmoothLiveMapEnabled()) {
    return { lat: p.latitude, lon: p.longitude };
  }
  const state = deviceTrackState.get(p.deviceId);
  if (state) return extrapolateLatLon(state, Date.now());
  return mapAnchorLatLon(p);
}

function tickMapInterpolation() {
  if (!isSmoothLiveMapEnabled() || !map) return;
  for (const [id, state] of deviceTrackState) {
    const marker = deviceMarkers.get(id);
    if (!marker) continue;
    const { lat, lon } = extrapolateLatLon(state, Date.now());
    marker.setLatLng(L.latLng(lat, lon));
  }
}

function startMapInterpolation() {
  stopMapInterpolation();
  mapInterpTimer = setInterval(tickMapInterpolation, MAP_INTERPOLATE_TICK_MS);
}

function stopMapInterpolation() {
  if (mapInterpTimer) clearInterval(mapInterpTimer);
  mapInterpTimer = null;
}

function staleSec() {
  return Number($('#staleSec')?.value || localStorage.getItem(LS_STALE) || 3600);
}

function fmtHz(v) {
  if (v == null || v === 0) return '—';
  return `${v} Hz`;
}

function fmtSpm(v) {
  if (v == null || v === 0) return '—';
  return `${v} spm`;
}

function fmtAgoSec(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function fmtBatteryPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  return `${Math.round(pct)}%`;
}

/** @type {Record<string, boolean>} */
let deviceCollapse = loadDeviceCollapse();

function loadDeviceCollapse() {
  try {
    const raw = localStorage.getItem(LS_DEVICE_COLLAPSE);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveDeviceCollapse() {
  localStorage.setItem(LS_DEVICE_COLLAPSE, JSON.stringify(deviceCollapse));
}

function isDeviceCollapsed(d) {
  const id = String(d.deviceId);
  if (Object.prototype.hasOwnProperty.call(deviceCollapse, id)) {
    return Boolean(deviceCollapse[id]);
  }
  return !d.online && !d.rowing?.capsize;
}

function setDeviceCollapsed(deviceId, collapsed) {
  deviceCollapse[String(deviceId)] = collapsed;
  saveDeviceCollapse();
}

function deviceSummaryLine(d) {
  const parts = [];
  const gps = d.gps || {};
  if (gps.present) {
    parts.push(`GPS ${fmtHz(gps.rateHz)}`);
    if (gps.ageSec != null) parts.push(`${gps.ageSec}s ago`);
  } else {
    parts.push('No GPS');
  }
  if (d.battery?.pct != null) parts.push(`${fmtBatteryPct(d.battery.pct)} bat`);
  if (d.rowing?.capsize) parts.push('CAPSIZE');
  else if (d.rowing?.strokeRateValid) parts.push(`${fmtSpm(d.rowing.strokeRate)}`);
  parts.push(`seen ${d.lastSeenAgoSec}s ago`);
  return parts.join(' · ');
}

function applyDeviceCardCollapse(card, collapsed) {
  card.classList.toggle('device-card--collapsed', collapsed);
  const btn = card.querySelector('.device-collapse-btn');
  if (btn) {
    btn.setAttribute('aria-expanded', String(!collapsed));
    const id = card.dataset.deviceId || 'device';
    btn.setAttribute('aria-label', collapsed ? `Expand ${id}` : `Collapse ${id}`);
  }
}

function strokeDetail(d) {
  const rowing = d.rowing || {};
  const motion = d.motion || {};
  if (rowing.strokeRateValid) return '15–50 spm';
  if (!motion.present || (motion.count ?? 0) < 3) {
    return 'Waiting for motion uploads';
  }
  if (!rowing.calibrated) {
    return 'Hold boat still ~2s to calibrate';
  }
  if ((motion.rateHz ?? 0) < 0.4) {
    return 'Collecting motion…';
  }
  return 'Row at 15–50 spm to detect';
}

function playCapsizeAlarm() {
  if (typeof window === 'undefined') return;
  if (window.__rnzCapsizeAlarmAt && Date.now() - window.__rnzCapsizeAlarmAt < 8000) return;
  window.__rnzCapsizeAlarmAt = Date.now();
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 660;
    gain.gain.value = 0.12;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      void ctx.close();
    }, 900);
  } catch {
    /* optional */
  }
}

function updateCapsizeBanner(devices) {
  const bar = $('#capsizeAlertBar');
  const text = $('#capsizeAlertText');
  const clearBtn = $('#clearCapsizeBtn');
  if (!bar || !text) return;
  const capsized = (devices || []).filter((d) => d.rowing?.capsize);
  if (!capsized.length) {
    bar.hidden = true;
    bar.setAttribute('aria-hidden', 'true');
    text.textContent = '';
    if (clearBtn) clearBtn.disabled = false;
    return;
  }
  bar.hidden = false;
  bar.setAttribute('aria-hidden', 'false');
  text.textContent = capsized
    .map((d) => {
      const tilt = d.rowing?.tiltDeg != null ? ` (${d.rowing.tiltDeg}° tilt)` : '';
      return `${d.deviceId}${tilt}`;
    })
    .join(', ');
  if (clearBtn) clearBtn.disabled = false;
  playCapsizeAlarm();
}

async function clearCapsizeAlert(deviceId) {
  const btn = $('#clearCapsizeBtn');
  if (btn) btn.disabled = true;
  const status = $('#pollStatus');
  try {
    const body = deviceId ? { deviceId } : {};
    const res = await fetch(`${apiBase()}/api/capsize-clear`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        throw new Error('Unauthorized — ingest token must match INGEST_TOKEN.');
      }
      throw new Error(`${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    const n = data.cleared?.length ?? 0;
    if (status) {
      status.textContent =
        n > 0
          ? `Capsize alert cleared for ${n} device(s).`
          : 'No active capsize alerts to clear.';
      status.classList.remove('err');
    }
    await poll();
  } catch (e) {
    if (status) {
      status.textContent = `Clear capsize failed: ${e instanceof Error ? e.message : String(e)}`;
      status.classList.add('err');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function updateRowingSummary(devices) {
  const strokeEl = $('#strokeSummary');
  const capsizeEl = $('#capsizeSummary');
  if (!strokeEl || !capsizeEl) return;

  const list = devices || [];
  const spms = list
    .map((d) => d.rowing?.strokeRate)
    .filter((v) => v != null && v > 0);

  if (!spms.length) {
    strokeEl.textContent = 'Stroke: —';
    strokeEl.classList.remove('hub-stats-item--accent');
  } else if (spms.length === 1) {
    strokeEl.textContent = `Stroke: ${spms[0]} spm`;
    strokeEl.classList.add('hub-stats-item--accent');
  } else {
    const min = Math.min(...spms);
    const max = Math.max(...spms);
    strokeEl.textContent =
      min === max ? `Stroke: ${min} spm` : `Stroke: ${min}–${max} spm`;
    strokeEl.classList.add('hub-stats-item--accent');
  }

  const capsized = list.filter((d) => d.rowing?.capsize);
  if (!capsized.length) {
    capsizeEl.textContent = 'Capsize: clear';
    capsizeEl.classList.remove('hub-stats-item--danger');
  } else {
    capsizeEl.textContent = `Capsize: ${capsized.length} boat(s)`;
    capsizeEl.classList.add('hub-stats-item--danger');
  }
}

function loadMapFollowPref() {
  try {
    return localStorage.getItem(LS_MAP_FOLLOW) !== '0';
  } catch {
    return true;
  }
}

function saveMapFollowPref(enabled) {
  try {
    localStorage.setItem(LS_MAP_FOLLOW, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function updateMapFollowButton() {
  const btn = $('#mapFollowBtn');
  if (!btn) return;
  btn.classList.toggle('hub-btn--active', mapFollowFleet);
  btn.setAttribute('aria-pressed', mapFollowFleet ? 'true' : 'false');
}

function activeMapLatLngsFromPositions(positions) {
  const latlngs = [];
  for (const p of positions) {
    if (p.latitude == null || p.longitude == null) continue;
    if (!p.online) continue;
    const ago = p.lastSeenAgoSec ?? p.fixAgeSec ?? 999;
    if (ago > ONLINE_SEC) continue;
    const { lat, lon } = displayLatLonForPosition(p);
    latlngs.push(L.latLng(lat, lon));
  }
  return latlngs;
}

function expandBoundsMinSpan(bounds, minMeters) {
  const center = bounds.getCenter();
  const ne = bounds.getNorthEast();
  if (center.distanceTo(ne) >= minMeters / 2) return bounds;
  const halfLat = minMeters / 2 / 111320;
  const cosLat = Math.max(Math.cos((center.lat * Math.PI) / 180), 0.2);
  const halfLng = minMeters / 2 / (111320 * cosLat);
  return L.latLngBounds(
    [center.lat - halfLat, center.lng - halfLng],
    [center.lat + halfLat, center.lng + halfLng],
  );
}

function fleetOutsideMapInset(latlngs) {
  if (!map || latlngs.length === 0) return false;
  const view = map.getBounds();
  const latSpan = view.getNorth() - view.getSouth();
  const lngSpan = view.getEast() - view.getWest();
  const inset = L.latLngBounds(
    [view.getSouth() + latSpan * 0.15, view.getWest() + lngSpan * 0.15],
    [view.getNorth() - latSpan * 0.15, view.getEast() - lngSpan * 0.15],
  );
  return latlngs.some((ll) => !inset.contains(ll));
}

function fitMapToActiveDevices(latlngs) {
  if (!map || latlngs.length === 0) return;
  mapIgnoreMoveEvents = true;
  if (latlngs.length === 1) {
    const zoom = Math.min(Math.max(map.getZoom(), 15), 17);
    map.setView(latlngs[0], zoom, { animate: true });
  } else {
    let bounds = L.latLngBounds(latlngs);
    bounds = expandBoundsMinSpan(bounds, 250);
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16, animate: true });
  }
  setTimeout(() => {
    mapIgnoreMoveEvents = false;
  }, 150);
}

function followActiveDevicesOnMap(positions) {
  if (!mapFollowFleet) return;
  const active = activeMapLatLngsFromPositions(positions);
  if (active.length === 0) return;
  if (active.length === 1) {
    fitMapToActiveDevices(active);
    return;
  }
  if (fleetOutsideMapInset(active)) fitMapToActiveDevices(active);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function initMap() {
  const el = $('#fleetMap');
  if (!el || map || typeof L === 'undefined') return;

  map = L.map(el, { zoomControl: true }).setView(MAP_CENTER, MAP_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);

  const onUserMapMove = () => {
    if (mapIgnoreMoveEvents || !mapFollowFleet) return;
    mapFollowFleet = false;
    saveMapFollowPref(false);
    updateMapFollowButton();
  };
  map.on('zoomstart', onUserMapMove);
  map.on('dragstart', onUserMapMove);

  window.dashboardFleetMap = map;
  if (typeof window.dashboardInitGeofences === 'function') {
    window.dashboardInitGeofences();
  }
  if (typeof window.dashboardInitSections === 'function') {
    window.dashboardInitSections();
  }
  updateMapFollowButton();
}

/** @returns {'live' | 'amber' | 'lost'} */
function gpsFixState(fixAgeSec, gps) {
  const age = Number(
    gps?.displayAgeSec ?? gps?.ingestAgoSec ?? fixAgeSec,
  );
  if (!Number.isFinite(age)) return 'lost';
  if (age <= GPS_LIVE_SEC) return 'live';
  if (age <= GPS_STALE_SEC) return 'amber';
  return 'lost';
}

function gpsDisplayAge(gps) {
  return gps?.displayAgeSec ?? gps?.ageSec ?? null;
}

function gpsStatusLabel(state) {
  if (state === 'live') return 'GPS live (≤30s)';
  if (state === 'amber') return 'GPS delayed (30s–5min)';
  return 'Last known (>5min)';
}

function markerIcon(state, capsize = false) {
  const visual = capsize ? 'capsize' : state;
  const size = capsize ? 24 : 14;
  const half = size / 2;
  return L.divIcon({
    className: `map-marker-wrap map-marker-wrap--${visual}`,
    html: `<span class="map-marker map-marker--${visual}" aria-hidden="true"></span>`,
    iconSize: [size, size],
    iconAnchor: [half, half],
  });
}

function setCapsizeUiActive(hasCapsize) {
  document.querySelector('.hub-panel--map')?.classList.toggle(
    'hub-panel--map-capsize',
    hasCapsize,
  );
  document.getElementById('devicesGrid')?.classList.toggle(
    'devices-grid--capsize',
    hasCapsize,
  );
}

function popupHtml(p) {
  const state = gpsFixState(p.fixAgeSec);
  const status = gpsStatusLabel(state);
  const smoothNote = isMapSmoothed()
    ? '<br><span class="map-popup-note">Smoothed position (display only)</span>'
    : '';
  const hr = p.hr != null ? `<br>HR: ${p.hr} bpm` : '';
  const spm =
    p.strokeRate != null && p.strokeRate > 0
      ? `<br>Stroke rate: <strong>${p.strokeRate} spm</strong>`
      : '';
  const tilt = p.tiltDeg != null ? `<br>Tilt: ${p.tiltDeg}°` : '';
  const cap = p.capsize
    ? `<br><strong class="map-popup-capsize">⚠ CAPSIZE — boat tipped</strong>`
    : '';
  const hb =
    p.heartbeatAgeSec != null
      ? `<br>Heartbeat: ${p.heartbeatRateHz > 0 ? `${p.heartbeatRateHz} Hz · ` : ''}${p.heartbeatAgeSec}s ago`
      : '';
  const bat =
    p.batteryPct != null
      ? `<br>Battery: <strong>${fmtBatteryPct(p.batteryPct)}</strong>${p.batteryAgeSec != null ? ` · ${fmtAgoSec(p.batteryAgeSec)}` : ''}`
      : '';
  return `<div class="map-popup"><strong>${esc(p.deviceId)}</strong><br>${status}<br>GPS fix ${p.fixAgeSec}s ago · seen ${p.lastSeenAgoSec}s ago${smoothNote}${hb}${bat}${hr}${spm}${tilt}${cap}</div>`;
}

function updateMap(positions) {
  initMap();
  if (!map || !markersLayer) return;

  latestMapPositions = positions;
  if (isSmoothLiveMapEnabled()) syncDeviceTrackState(positions);

  const seen = new Set();
  const latlngs = [];

  for (const p of positions) {
    if (p.latitude == null || p.longitude == null) continue;
    seen.add(p.deviceId);
    const { lat, lon } = displayLatLonForPosition(p);
    latlngs.push([lat, lon]);

    const latlng = L.latLng(lat, lon);
    let marker = deviceMarkers.get(p.deviceId);
    const state = gpsFixState(p.fixAgeSec);
    const icon = markerIcon(state, Boolean(p.capsize));

    if (marker) {
      marker.setLatLng(latlng);
      marker.setIcon(icon);
      marker.setPopupContent(popupHtml(p));
    } else {
      marker = L.marker(latlng, { icon }).bindPopup(popupHtml(p));
      markersLayer.addLayer(marker);
      deviceMarkers.set(p.deviceId, marker);
    }
  }

  for (const [id, marker] of deviceMarkers) {
    if (!seen.has(id)) {
      markersLayer.removeLayer(marker);
      deviceMarkers.delete(id);
    }
  }

  const statusEl = $('#mapStatus');
  let liveN = 0;
  let amberN = 0;
  let lostN = 0;
  let capsizeN = 0;
  for (const p of positions) {
    if (p.latitude == null || p.longitude == null) continue;
    if (p.capsize) capsizeN++;
    const s = gpsFixState(p.fixAgeSec);
    if (s === 'live') liveN++;
    else if (s === 'amber') amberN++;
    else lostN++;
  }
  if (statusEl) {
    const capPart = capsizeN ? ` · ${capsizeN} CAPSIZE` : '';
    const smoothPart = isMapSmoothed() ? ' · smoothed' : ' · raw GPS';
    statusEl.textContent =
      positions.length === 0
        ? 'No GPS positions in the selected time window.'
        : `${liveN} live · ${amberN} delayed · ${lostN} last known${smoothPart}${capPart}`;
    statusEl.classList.toggle('map-status--capsize', capsizeN > 0);
    statusEl.classList.toggle('map-status--smooth-live', isMapSmoothed());
  }

  setCapsizeUiActive(capsizeN > 0);

  followActiveDevicesOnMap(positions);
}

function mergeMapWithDeviceGps(devices, positions) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const p of positions || []) {
    if (p.latitude != null && p.longitude != null) {
      byId.set(p.deviceId, { ...p });
    }
  }
  for (const d of devices || []) {
    const gps = d.gps?.last;
    if (gps?.lat == null || gps?.lon == null) continue;
    const devAge = d.gps?.ageSec;
    if (devAge == null || !Number.isFinite(devAge)) continue;
    const prev = byId.get(d.deviceId);
    const fixAge = prev?.fixAgeSec ?? Number.POSITIVE_INFINITY;
    if (devAge >= fixAge) continue;
    byId.set(d.deviceId, {
      ...(prev || {}),
      deviceId: d.deviceId,
      athleteId: d.athleteId ?? prev?.athleteId ?? null,
      latitude: gps.lat,
      longitude: gps.lon,
      fixAgeSec: devAge,
      fixMs: Date.now() - devAge * 1000,
      accuracy: gps.acc ?? prev?.accuracy ?? null,
      lastSeenAgoSec: d.lastSeenAgoSec ?? prev?.lastSeenAgoSec ?? devAge,
      online: d.online ?? prev?.online ?? false,
      hr: prev?.hr ?? d.hr?.last?.bpm ?? null,
      strokeRate: prev?.strokeRate ?? d.rowing?.strokeRate ?? null,
      strokeRateValid: prev?.strokeRateValid ?? d.rowing?.strokeRateValid ?? false,
      capsize: prev?.capsize ?? d.rowing?.capsize ?? false,
      tiltDeg: prev?.tiltDeg ?? d.rowing?.tiltDeg ?? null,
      heartbeatRateHz: prev?.heartbeatRateHz ?? d.heartbeat?.rateHz ?? 0,
      heartbeatAgeSec: prev?.heartbeatAgeSec ?? d.heartbeat?.ageSec ?? null,
      batteryPct: prev?.batteryPct ?? d.battery?.pct ?? null,
      batteryAgeSec: prev?.batteryAgeSec ?? d.battery?.ageSec ?? null,
    });
  }
  return [...byId.values()];
}

/**
 * Build device grid rows: merge /api/devices with live map positions so cards
 * stay in sync with map markers (including map-only devices within staleSec).
 * @param {object[]} apiDevices
 * @param {object[]} mapPositions
 * @param {number} windowSec
 */
function buildDevicesForGrid(apiDevices, mapPositions, windowSec) {
  /** @type {Map<string, object>} */
  const mapById = new Map();
  for (const p of mapPositions || []) {
    if (p.latitude != null && p.longitude != null) mapById.set(p.deviceId, p);
  }

  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const d of apiDevices || []) {
    byId.set(d.deviceId, enrichDeviceWithMapPosition(d, mapById.get(d.deviceId)));
  }

  for (const p of mapPositions || []) {
    if (p.latitude == null || p.longitude == null) continue;
    if (byId.has(p.deviceId)) continue;
    byId.set(p.deviceId, mapPositionToDeviceCard(p, windowSec));
  }

  return [...byId.values()].sort(
    (a, b) => (a.lastSeenAgoSec ?? 9999) - (b.lastSeenAgoSec ?? 9999),
  );
}

/** @param {object} d @param {object|undefined} p */
function enrichDeviceWithMapPosition(d, p) {
  if (!p) return d;
  const { lat, lon } = displayLatLonForPosition(p);
  const fixAge = p.fixAgeSec;
  const gps = { ...(d.gps || {}) };
  if (fixAge != null || p.latitude != null) {
    gps.present = true;
    if (fixAge != null) gps.ageSec = fixAge;
    gps.last = {
      t: p.fixMs ?? (fixAge != null ? Date.now() - fixAge * 1000 : Date.now()),
      lat,
      lon,
      acc: p.accuracy ?? gps.last?.acc ?? null,
    };
  }
  const rowing = { ...(d.rowing || {}) };
  if (p.capsize) rowing.capsize = true;
  if (p.strokeRateValid && p.strokeRate != null) {
    rowing.strokeRate = p.strokeRate;
    rowing.strokeRateValid = true;
  }
  return { ...d, gps, rowing };
}

/** @param {object} p @param {number} windowSec */
function mapPositionToDeviceCard(p, windowSec) {
  const { lat, lon } = displayLatLonForPosition(p);
  const fixAge = p.fixAgeSec ?? null;
  return {
    deviceId: p.deviceId,
    athleteId: p.athleteId ?? null,
    sessionId: '',
    online: Boolean(p.online),
    lastSeenAgoSec: p.lastSeenAgoSec ?? fixAge ?? null,
    windowSec,
    totalSamples: 0,
    ingestRateHz: 0,
    gps: {
      present: true,
      rateHz: 0,
      count: 0,
      last: { lat, lon, acc: p.accuracy ?? null, t: p.fixMs ?? Date.now() },
      ageSec: fixAge,
    },
    motion: { present: false, rateHz: 0, count: 0 },
    hr: { present: false, rateHz: 0, count: 0 },
    heartbeat: { present: false, rateHz: 0, count: 0 },
    battery: {
      pct: p.batteryPct ?? null,
      ageSec: p.batteryAgeSec ?? null,
    },
    rowing: {
      strokeRate: p.strokeRate ?? null,
      strokeRateValid: Boolean(p.strokeRateValid),
      capsize: Boolean(p.capsize),
      tiltDeg: p.tiltDeg ?? null,
      calibrated: false,
    },
  };
}

async function fetchMapPositions() {
  const url = `${apiBase()}/api/map-positions?onlineSec=${ONLINE_SEC}&staleSec=${staleSec()}&predictMode=${encodeURIComponent(currentPredictMode())}`;
  const started = performance.now();
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Map ${res.status} ${text.slice(0, 80)}`);
  }
  const data = await res.json();
  lastMapDurationMs = Math.round(performance.now() - started);
  return {
    ...data,
    positions: Array.isArray(data.positions) ? data.positions : [],
  };
}

function renderHealthBar(data) {
  const health = data.health || {};
  const serverEl = $('#serverHealth');
  const gpsEl = $('#gpsHealth');
  const latencyEl = $('#latencyHealth');

  if (serverEl) {
    const lag = health.serverDataLagSec;
    const storage = data.storage || 'memory';
    if (health.status === 'degraded') {
      serverEl.textContent = `Server: degraded (${storage})`;
      serverEl.classList.add('hub-stats-item--danger');
    } else {
      serverEl.textContent =
        lag != null ? `Server: ${storage}, lag ${lag}s` : `Server: ${storage}`;
      serverEl.classList.remove('hub-stats-item--danger');
    }
  }

  if (gpsEl) {
    const delayed = health.delayedGpsDevices ?? 0;
    const avgAge = health.avgGpsAgeSec;
    gpsEl.textContent =
      avgAge != null
        ? `GPS health: avg ${avgAge}s, delayed ${delayed}`
        : 'GPS health: waiting…';
    gpsEl.classList.toggle('hub-stats-item--danger', delayed > 0);
  }

  if (latencyEl) {
    const pollMs = lastPollDurationMs != null ? `${lastPollDurationMs}ms` : '—';
    const mapMs = lastMapDurationMs != null ? `${lastMapDurationMs}ms` : '—';
    const ingest = health.avgIngestHz != null ? `${health.avgIngestHz}Hz` : '—';
    latencyEl.textContent = `Latency: api ${pollMs}, map ${mapMs}, ingest ${ingest}`;
  }

  const heartbeatEl = $('#heartbeatHealth');
  if (heartbeatEl) {
    const hbHz = health.avgHeartbeatHz;
    const hbAge = health.avgHeartbeatAgeSec;
    heartbeatEl.textContent =
      hbHz != null || hbAge != null
        ? `Heartbeat: ${hbHz != null ? `${hbHz} Hz avg` : '—'}${hbAge != null ? ` · ${hbAge}s ago avg` : ''}`
        : 'Heartbeat: —';
  }

  const batteryEl = $('#batteryHealth');
  if (batteryEl) {
    const avg = health.avgBatteryPct;
    const min = health.minBatteryPct;
    if (avg != null) {
      batteryEl.textContent =
        min != null && min !== avg
          ? `Battery: avg ${avg}% · min ${min}%`
          : `Battery: ${avg}%`;
      batteryEl.classList.toggle('hub-stats-item--danger', min != null && min <= 20);
    } else {
      batteryEl.textContent = 'Battery: —';
      batteryEl.classList.remove('hub-stats-item--danger');
    }
  }
}

function renderDevice(d) {
  const card = document.createElement('article');
  const rowing = d.rowing || {};
  const gpsState = rowing.capsize
    ? 'capsize'
    : gpsFixState(d.gps?.ageSec ?? d.lastSeenAgoSec, d.gps);
  const collapsed = isDeviceCollapsed(d);
  card.className = `device-card device-card--${gpsState}${collapsed ? ' device-card--collapsed' : ''}`;
  card.dataset.deviceId = d.deviceId;

  const gps = d.gps || {};
  const hr = d.hr || {};
  const motion = d.motion || {};
  const heartbeat = d.heartbeat || {};
  const battery = d.battery || {};

  const badgeClass = rowing.capsize
    ? 'badge-pill--capsize'
    : gpsState === 'live'
      ? 'badge-pill--live'
      : gpsState === 'amber'
        ? 'badge-pill--amber'
        : 'badge-pill--lost';
  const badgeLabel = rowing.capsize
    ? 'Capsize'
    : gpsState === 'live'
      ? 'GPS live'
      : gpsState === 'amber'
        ? 'GPS delayed'
        : 'Last known';

  const coords =
    gps.last?.lat != null
      ? `${gps.last.lat.toFixed(5)}, ${gps.last.lon.toFixed(5)}`
      : null;

  const regattaMsg =
    typeof window.dashboardGetRegattaMessage === 'function'
      ? window.dashboardGetRegattaMessage(d.deviceId)
      : null;

  card.innerHTML = `
    <div class="device-head">
      <button type="button" class="device-collapse-btn" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? `Expand ${esc(d.deviceId)}` : `Collapse ${esc(d.deviceId)}`}">
        <span class="device-collapse-icon" aria-hidden="true"></span>
      </button>
      <div class="device-head__main">
        <h2>${esc(d.deviceId)}</h2>
        <div class="sub">${d.athleteId ? esc(d.athleteId) : 'No athlete ID'} · session ${esc(d.sessionId.slice(0, 8))}…</div>
        <p class="device-summary">${esc(deviceSummaryLine(d))}</p>
      </div>
      <span class="badge-pill ${badgeClass}">${badgeLabel}</span>
    </div>
    <div class="device-card__body">
      <div class="sensors sensors--six">
        <div class="sensor ${gps.present ? 'present' : 'absent'}">
          <div class="name">GPS</div>
          <div class="rate">${gps.present ? fmtHz(gps.rateHz) : '—'}</div>
          <div class="detail">${gps.present ? `${gps.count} fixes / ${d.windowSec || 60}s` : 'No data'}</div>
        </div>
        <div class="sensor ${heartbeat.present ? 'present' : 'absent'}">
          <div class="name">Heartbeat</div>
          <div class="rate">${heartbeat.present ? fmtHz(heartbeat.rateHz) : '—'}</div>
          <div class="detail">${heartbeat.ageSec != null ? `Last ${fmtAgoSec(heartbeat.ageSec)}` : 'No ping'}</div>
        </div>
        <div class="sensor ${battery.pct != null ? 'present' : 'absent'} ${battery.pct != null && battery.pct <= 20 ? 'sensor--low-battery' : ''}">
          <div class="name">Battery</div>
          <div class="rate">${fmtBatteryPct(battery.pct)}</div>
          <div class="detail">${battery.ageSec != null ? `Reported ${fmtAgoSec(battery.ageSec)}` : 'Not reported'}</div>
        </div>
        <div class="sensor ${rowing.strokeRateValid ? 'present' : motion.present ? 'present' : 'absent'}">
          <div class="name">Stroke rate</div>
          <div class="rate">${rowing.strokeRateValid ? fmtSpm(rowing.strokeRate) : '—'}</div>
          <div class="detail">${strokeDetail(d)}</div>
        </div>
        <div class="sensor ${hr.present ? 'present' : 'absent'}">
          <div class="name">Heart rate</div>
          <div class="rate">${hr.present ? fmtHz(hr.rateHz) : '—'}</div>
          <div class="detail">${hr.last ? `${hr.last.bpm} bpm · ${hr.ageSec}s ago` : 'Not present'}</div>
        </div>
        <div class="sensor ${motion.present ? 'present' : 'absent'} ${rowing.capsize ? 'sensor--capsize' : ''}">
          <div class="name">${rowing.capsize ? 'Capsize' : 'Tilt'}</div>
          <div class="rate">${rowing.tiltDeg != null ? `${rowing.tiltDeg}°` : '—'}</div>
          <div class="detail">${rowing.capsize ? 'Boat tipped' : motion.present ? `${motion.count} samples` : 'Not present'}</div>
        </div>
      </div>
      <div class="meta-row">
        <span>Ingest <strong>${fmtHz(d.ingestRateHz)}</strong></span>
        <span>Total samples <strong>${d.totalSamples}</strong></span>
        <span>Last seen <strong>${d.lastSeenAgoSec}s ago</strong></span>
      </div>
      ${coords ? `<div class="coords">${coords}${gpsDisplayAge(gps) != null ? ` · GPS ${gpsDisplayAge(gps)}s ago${gps.ingestAgoSec != null && gps.ageSec != null && gps.ageSec - gps.ingestAgoSec > 20 ? ` (fix ${gps.ageSec}s on device)` : ''}` : ''}</div>` : ''}
      ${
        regattaMsg
          ? `<div class="regatta-device-msg" title="Active regatta control message"><span class="regatta-device-msg__label">Regatta</span> ${esc(regattaMsg.text)}</div>`
          : ''
      }
    </div>
  `;
  return card;
}

async function poll() {
  const pollStarted = performance.now();
  const status = $('#pollStatus');
  const grid = $('#devicesGrid');
  const windowSec = $('#windowSec')?.value || 60;

  try {
    const devicesUrl = `${apiBase()}/api/devices?windowSec=${encodeURIComponent(windowSec)}&onlineSec=${ONLINE_SEC}`;
    const [devicesRes, mapResult] = await Promise.allSettled([
      fetch(devicesUrl, { headers: headers() }),
      fetchMapPositions(),
    ]);

    if (devicesRes.status !== 'fulfilled') {
      throw devicesRes.reason;
    }
    const res = devicesRes.value;
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        throw new Error('401 Unauthorized — ingest token on this page must match INGEST_TOKEN in Vercel.');
      }
      throw new Error(`${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();

    if (mapResult.status === 'rejected') {
      const mapStatus = $('#mapStatus');
      if (mapStatus) {
        mapStatus.textContent = `Map error: ${mapResult.reason?.message || mapResult.reason}`;
      }
    }

    const mapPositions = mergeMapWithDeviceGps(
      data.devices,
      mapResult.status === 'fulfilled' ? mapResult.value.positions : [],
    );
    updateMap(mapPositions);

    const warnEl = $('#storageWarning');
    if (warnEl) {
      if (data.warning) {
        warnEl.hidden = false;
        warnEl.textContent = data.warning;
      } else {
        warnEl.hidden = true;
        warnEl.textContent = '';
      }
    }

    $('#activeCount').textContent = `Online: ${data.activeCount ?? 0}`;
    $('#deviceCount').textContent = `Devices: ${data.deviceCount ?? 0}`;
    updateRefreshRateLabel();
    lastPollDurationMs = Math.round(performance.now() - pollStarted);
    renderHealthBar(data);

    updateCapsizeBanner(data.devices);
    updateRowingSummary(data.devices);
    setCapsizeUiActive((data.devices || []).some((d) => d.rowing?.capsize));

    grid.innerHTML = '';
    const devicesForGrid = buildDevicesForGrid(
      data.devices,
      mapPositions,
      data.windowSec ?? Number(windowSec),
    );
    if (!devicesForGrid.length) {
      const hint = data.persisted
        ? 'No devices in the last window. Check the phone is recording and Device ID matches.'
        : 'No devices visible — add POSTGRES_URL on Vercel (Storage → Postgres), redeploy, then record again.';
      grid.innerHTML = `<p class="empty">${hint}</p>`;
    } else {
      for (const d of devicesForGrid) {
        d.windowSec = data.windowSec;
        grid.appendChild(renderDevice(d));
      }
    }

    if (typeof window.mergeHistoryDevices === 'function') {
      window.mergeHistoryDevices(
        devicesForGrid.map((d) => d.deviceId).filter(Boolean),
      );
    }

    if (window.dashboardMonitorCharts?.onPoll) {
      window.dashboardMonitorCharts.onPoll({ ...data, devices: devicesForGrid });
    }

    if (typeof window.dashboardOnDevicesPoll === 'function') {
      window.dashboardOnDevicesPoll(devicesForGrid);
    }

    const t = new Date(data.polledAt || Date.now()).toLocaleTimeString();
    status.textContent = `Updated ${t} · ${devicesForGrid.length} device(s)`;
    status.classList.remove('err');
  } catch (e) {
    lastPollDurationMs = Math.round(performance.now() - pollStarted);
    status.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
    status.classList.add('err');
  }
}

let timer = null;

function startPolling() {
  savePrefs();
  if (timer) clearInterval(timer);
  updateRefreshRateLabel();
  void poll();
  const ms = Number($('#pollMs')?.value || 2000);
  timer = setInterval(() => void poll(), ms);
}

function init() {
  const savedToken = localStorage.getItem(LS_TOKEN);
  const savedPoll = localStorage.getItem(LS_POLL);
  const savedStale = localStorage.getItem(LS_STALE);
  const savedMapPosition =
    localStorage.getItem(LS_MAP_POSITION) ||
    (localStorage.getItem(LS_LIVE_MAP) === '1' ? 'smoothed' : null);
  const savedPredictMode = localStorage.getItem(LS_PREDICT_MODE);
  if (savedToken && $('#token')) $('#token').value = savedToken;
  if (savedPredictMode && $('#predictMode')) $('#predictMode').value = savedPredictMode;
  if (savedMapPosition && $('#mapPositionMode')) {
    $('#mapPositionMode').value = savedMapPosition;
  } else if (savedPoll && $('#pollMs')) {
    $('#pollMs').value = savedPoll;
  }
  if (savedStale && $('#staleSec')) $('#staleSec').value = savedStale;

  applyMapPositionMode();

  initMap();

  if (typeof window.dashboardInitRegatta === 'function') {
    window.dashboardInitRegatta();
  }

  $('#devicesGrid')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.device-collapse-btn');
    if (!btn) return;
    const card = btn.closest('.device-card');
    const id = card?.dataset.deviceId;
    if (!id) return;
    const collapsed = !card.classList.contains('device-card--collapsed');
    setDeviceCollapsed(id, collapsed);
    applyDeviceCardCollapse(card, collapsed);
  });

  $('#devicesCollapseAllBtn')?.addEventListener('click', () => {
    document.querySelectorAll('.device-card').forEach((card) => {
      const id = card.dataset.deviceId;
      if (!id) return;
      setDeviceCollapsed(id, true);
      applyDeviceCardCollapse(card, true);
    });
  });

  $('#devicesExpandAllBtn')?.addEventListener('click', () => {
    document.querySelectorAll('.device-card').forEach((card) => {
      const id = card.dataset.deviceId;
      if (!id) return;
      setDeviceCollapsed(id, false);
      applyDeviceCardCollapse(card, false);
    });
  });

  $('#refreshBtn')?.addEventListener('click', () => void poll());
  $('#mapFollowBtn')?.addEventListener('click', () => {
    mapFollowFleet = !mapFollowFleet;
    saveMapFollowPref(mapFollowFleet);
    updateMapFollowButton();
    if (mapFollowFleet) followActiveDevicesOnMap(latestMapPositions);
  });
  $('#clearCapsizeBtn')?.addEventListener('click', () => void clearCapsizeAlert());
  $('#applyBtn')?.addEventListener('click', () => {
    startPolling();
    if (typeof window.reloadDashboardHistory === 'function') {
      void window.reloadDashboardHistory();
    }
    if (typeof window.reloadDashboardDataManage === 'function') {
      void window.reloadDashboardDataManage();
    }
  });
  $('#token')?.addEventListener('change', () => {
    savePrefs();
    if (typeof window.reloadDashboardHistory === 'function') {
      void window.reloadDashboardHistory();
    }
    if (typeof window.reloadDashboardDataManage === 'function') {
      void window.reloadDashboardDataManage();
    }
  });
  ['#pollMs', '#windowSec', '#staleSec', '#predictMode'].forEach((sel) => {
    $(sel)?.addEventListener('change', () => {
      savePrefs();
      updateRefreshRateLabel();
      if (sel === '#predictMode' && isMapSmoothed()) void poll();
    });
  });
  $('#mapPositionMode')?.addEventListener('change', () => {
    applyMapPositionMode();
    startPolling();
  });

  startPolling();

  if (typeof window.initDashboardHistory === 'function') {
    window.initDashboardHistory();
  }
  if (typeof window.initDashboardDataManage === 'function') {
    window.initDashboardDataManage();
  }
}

window.dashboardRefreshNow = poll;

init();
