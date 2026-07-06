/**
 * Session history — map trace, HR/speed charts, capsize incidents.
 * Expects dashboard.js globals: apiBase(), headers(), $()
 */
(function () {
  const LS_HISTORY_DEVICE = 'rnz_history_device';

  let historyMap = null;
  let historyLayer = null;
  let historyMarkers = null;
  /** @type {Map<string, string>} deviceId → last ISO upload time */
  const deviceLastSeen = new Map();
  /** @type {Map<string, { firstSampleMs: number, lastSampleMs: number, sampleCount: number }>} */
  const deviceBounds = new Map();

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toDateInputValue(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function toTimeInputValue(ms) {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function rangeFromInputs() {
    const fd = document.getElementById('historyFromDate')?.value;
    const ft = document.getElementById('historyFromTime')?.value || '00:00';
    const td = document.getElementById('historyToDate')?.value;
    const tt = document.getElementById('historyToTime')?.value || '23:59';
    if (!fd || !td) return { from: null, to: null };
    const fromMs = new Date(`${fd}T${ft}`).getTime();
    const toMs = new Date(`${td}T${tt}`).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      return { from: null, to: null };
    }
    return {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    };
  }

  function setRangeInputs(fromMs, toMs) {
    const fromDate = document.getElementById('historyFromDate');
    const fromTime = document.getElementById('historyFromTime');
    const toDate = document.getElementById('historyToDate');
    const toTime = document.getElementById('historyToTime');
    if (fromDate) fromDate.value = toDateInputValue(fromMs);
    if (fromTime) fromTime.value = toTimeInputValue(fromMs);
    if (toDate) toDate.value = toDateInputValue(toMs);
    if (toTime) toTime.value = toTimeInputValue(toMs);
  }

  function applyPreset(preset) {
    const now = Date.now();
    let fromMs;
    let toMs = now;
    const d = new Date(now);

    if (preset === '1h') {
      fromMs = now - 60 * 60 * 1000;
    } else if (preset === '6h') {
      fromMs = now - 6 * 60 * 60 * 1000;
    } else if (preset === 'today') {
      d.setHours(0, 0, 0, 0);
      fromMs = d.getTime();
    } else if (preset === 'yesterday') {
      d.setHours(0, 0, 0, 0);
      toMs = d.getTime();
      d.setDate(d.getDate() - 1);
      fromMs = d.getTime();
    } else if (preset === '30d') {
      fromMs = now - 30 * 24 * 60 * 60 * 1000;
    } else if (preset === 'all') {
      const deviceId = document.getElementById('historyDeviceId')?.value?.trim();
      const bounds = deviceId ? deviceBounds.get(deviceId) : null;
      if (!bounds?.firstSampleMs || !bounds?.lastSampleMs) {
        setHistoryStatus(
          'Pick a device with stored samples first, or choose a session from the list.',
          true,
        );
        return;
      }
      fromMs = bounds.firstSampleMs;
      toMs = bounds.lastSampleMs + 60 * 1000;
    } else {
      return;
    }

    setRangeInputs(fromMs, toMs);
    document.querySelectorAll('.history-preset').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-preset') === preset);
    });
    const sessionSel = document.getElementById('historySessionId');
    if (sessionSel) sessionSel.value = '';
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleString();
  }

  function fmtPace(mps, deviceId) {
    const RS = window.RowingSpeed;
    if (RS) {
      return RS.formatPaceWithPrognostic(mps, deviceId, { suffix: true });
    }
    if (mps == null || mps <= 0.1) return '—';
    const secPer500 = 500 / mps;
    const m = Math.floor(secPer500 / 60);
    const s = Math.round(secPer500 % 60);
    return `${m}:${String(s).padStart(2, '0')}/500`;
  }

  function downsample(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    const step = Math.ceil(points.length / maxPoints);
    const out = [];
    for (let i = 0; i < points.length; i += step) out.push(points[i]);
    if (out[out.length - 1] !== points[points.length - 1]) {
      out.push(points[points.length - 1]);
    }
    return out;
  }

  function drawLineChart(canvas, series, opts) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 160;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 44, r: 12, t: 22, b: 28 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    const valid = series.filter((p) => p.y != null && Number.isFinite(p.y));
    if (valid.length < 2) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(opts.empty || 'No data', pad.l, h / 2);
      return;
    }

    const t0 = valid[0].t;
    const t1 = valid[valid.length - 1].t;
    const yMin = Math.min(...valid.map((p) => p.y));
    const yMax = Math.max(...valid.map((p) => p.y));
    const ySpan = yMax - yMin || 1;

    const xAt = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * plotW;
    const yAt = (y) => pad.t + plotH - ((y - yMin) / ySpan) * plotH;

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();
    }

    ctx.strokeStyle = opts.color || '#22d3ee';
    ctx.lineWidth = 2;
    ctx.beginPath();
    valid.forEach((p, i) => {
      const x = xAt(p.t);
      const y = yAt(p.y);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(opts.yLabel || '', 4, pad.t + 10);
    ctx.fillText(
      `${opts.formatY?.(yMin) ?? yMin.toFixed(1)}`,
      4,
      pad.t + plotH,
    );
    ctx.fillText(
      `${opts.formatY?.(yMax) ?? yMax.toFixed(1)}`,
      4,
      pad.t + 12,
    );
    ctx.fillText(new Date(t0).toLocaleTimeString(), pad.l, h - 6);
    ctx.fillText(new Date(t1).toLocaleTimeString(), pad.l + plotW - 56, h - 6);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(opts.title || '', pad.l, 14);
  }

  function destroyHistoryMap() {
    if (historyMap) {
      historyMap.remove();
      historyMap = null;
      historyLayer = null;
      historyMarkers = null;
    }
  }

  function initHistoryMap() {
    const el = document.getElementById('historyMap');
    if (!el || typeof L === 'undefined') return;
    if (historyMap) destroyHistoryMap();
    historyMap = L.map(el, { zoomControl: true }).setView([-37.9305, 175.5485], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(historyMap);
    historyLayer = L.layerGroup().addTo(historyMap);
    historyMarkers = L.layerGroup().addTo(historyMap);
  }

  function showHistoryResults() {
    const results = document.getElementById('historyResults');
    if (!results) return;
    results.hidden = false;
    results.setAttribute('aria-hidden', 'false');
    results.classList.add('history-results--visible');
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function hideHistoryResults() {
    const results = document.getElementById('historyResults');
    if (!results) return;
    results.hidden = true;
    results.setAttribute('aria-hidden', 'true');
    results.classList.remove('history-results--visible');
  }

  function renderHistoryMap(track, capsizeEvents) {
    const mapEl = document.getElementById('historyMap');
    if (!mapEl || typeof L === 'undefined') return;
    if (!historyMap || mapEl.offsetHeight < 10) {
      destroyHistoryMap();
      initHistoryMap();
    }
    if (!historyMap || !historyLayer) return;
    historyLayer.clearLayers();
    historyMarkers.clearLayers();

    const latlngs = track
      .filter((p) => p.lat != null && p.lon != null)
      .map((p) => [p.lat, p.lon]);

    if (latlngs.length >= 2) {
      const line = L.polyline(latlngs, {
        color: '#22d3ee',
        weight: 4,
        opacity: 0.85,
      });
      historyLayer.addLayer(line);
      historyMap.fitBounds(line.getBounds(), { padding: [32, 32], maxZoom: 16 });
    } else if (latlngs.length === 1) {
      historyMap.setView(latlngs[0], 15);
    }

    if (latlngs.length) {
      const start = L.circleMarker(latlngs[0], {
        radius: 7,
        color: '#22c55e',
        fillColor: '#22c55e',
        fillOpacity: 0.9,
        weight: 2,
      }).bindPopup('Start');
      const end = L.circleMarker(latlngs[latlngs.length - 1], {
        radius: 7,
        color: '#3b82f6',
        fillColor: '#3b82f6',
        fillOpacity: 0.9,
        weight: 2,
      }).bindPopup('End');
      historyLayer.addLayer(start);
      historyLayer.addLayer(end);
    }

    for (const ev of capsizeEvents) {
      const m = L.circleMarker([ev.lat, ev.lon], {
        radius: 12,
        color: '#ef4444',
        fillColor: '#f97316',
        fillOpacity: 0.95,
        weight: 3,
      }).bindPopup(
        `<strong>Capsize</strong><br>${fmtTime(ev.t)}${ev.tiltDeg != null ? `<br>Tilt ${ev.tiltDeg}°` : ''}`,
      );
      historyMarkers.addLayer(m);
    }

    setTimeout(() => {
      historyMap?.invalidateSize(true);
      if (latlngs.length >= 2) {
        const line = historyLayer?.getLayers()?.[0];
        if (line?.getBounds) {
          historyMap.fitBounds(line.getBounds(), { padding: [32, 32], maxZoom: 16 });
        }
      }
    }, 120);
  }

  function renderCharts(track) {
    const hrCanvas = document.getElementById('historyChartHr');
    const speedCanvas = document.getElementById('historyChartSpeed');
    const strokeCanvas = document.getElementById('historyChartStroke');

    const hrSeries = downsample(
      track.filter((p) => p.hr != null).map((p) => ({ t: p.t, y: p.hr })),
      1200,
    );
    const speedSeries = downsample(
      track.filter((p) => p.speed != null && p.speed >= 0).map((p) => ({ t: p.t, y: p.speed })),
      1200,
    );
    const strokeSeries = downsample(
      track.filter((p) => p.strokeRate != null && p.strokeRate > 0).map((p) => ({ t: p.t, y: p.strokeRate })),
      1200,
    );

    drawLineChart(hrCanvas, hrSeries, {
      title: 'Heart rate (bpm)',
      color: '#f472b6',
      yLabel: 'bpm',
      formatY: (v) => `${Math.round(v)}`,
      empty: 'No heart rate in this range',
    });
    drawLineChart(speedCanvas, speedSeries, {
      title: 'GPS pace (/500m)',
      color: '#38bdf8',
      yLabel: '/500m',
      formatY: (v) => {
        const RS = window.RowingSpeed;
        return RS ? RS.formatSplit500m(v) : String(v);
      },
      empty: 'No GPS speed in this range',
    });
    drawLineChart(strokeCanvas, strokeSeries, {
      title: 'Stroke rate (spm)',
      color: '#a78bfa',
      yLabel: 'spm',
      formatY: (v) => `${Math.round(v)}`,
      empty: 'No stroke rate in this range',
    });

    const strokeWrap = document.getElementById('historyChartStrokeWrap');
    if (strokeWrap) strokeWrap.hidden = strokeSeries.length < 2;
  }

  function renderCapsizeList(events, sampleCount) {
    const el = document.getElementById('historyCapsizeList');
    if (!el) return;
    if (!events.length) {
      el.innerHTML =
        sampleCount > 0
          ? '<p class="history-capsize-empty">Capsize samples in data but no GPS at event time.</p>'
          : '<p class="history-capsize-empty">No capsize events in this range.</p>';
      return;
    }
    el.innerHTML = `
      <h3 class="history-subtitle">Capsize incidents (${events.length})</h3>
      <ul class="history-capsize-ul">
        ${events
          .map(
            (ev) => `
          <li>
            <strong>${fmtTime(ev.t)}</strong>
            · ${ev.lat.toFixed(5)}, ${ev.lon.toFixed(5)}
            ${ev.tiltDeg != null ? ` · ${ev.tiltDeg}° tilt` : ''}
          </li>`,
          )
          .join('')}
      </ul>
      ${sampleCount > events.length ? `<p class="history-capsize-note">${sampleCount} capsize samples collapsed into ${events.length} incident(s).</p>` : ''}
    `;
  }

  function setHistoryStatus(msg, isErr) {
    const el = document.getElementById('historyStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', Boolean(isErr));
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: window.dashboardHeaders?.() || {} });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${text.slice(0, 120)}`);
    }
    return res.json();
  }

  function mergeDeviceIds(ids) {
    const sel = document.getElementById('historyDeviceId');
    if (!sel || !ids?.length) return;
    const seen = new Set([...sel.options].map((o) => o.value).filter(Boolean));
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      sel.appendChild(opt);
    }
  }

  function applyDeviceStoredRange(deviceId) {
    const bounds = deviceId ? deviceBounds.get(deviceId) : null;
    if (!bounds?.firstSampleMs || !bounds?.lastSampleMs) return false;
    setRangeInputs(bounds.firstSampleMs, bounds.lastSampleMs + 60 * 1000);
    return true;
  }

  function appendSessionOption(sel, s) {
    const startMs = new Date(s.started_at).getTime();
    const endMs = s.updated_at
      ? new Date(s.updated_at).getTime()
      : s.ended_at
        ? new Date(s.ended_at).getTime()
        : Date.now();
    const start = new Date(startMs).toLocaleString(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    });
    const mins = Math.max(1, Math.round((endMs - startMs) / 60000));
    const dev = s.unique_id ? `${s.unique_id} · ` : '';
    const label = `${dev}${start} · ${mins} min · ${s.sample_count ?? 0} samples`;
    const opt = document.createElement('option');
    opt.value = s.session_id;
    opt.textContent = label;
    opt.dataset.startedAt = s.started_at;
    opt.dataset.endedAt = new Date(endMs).toISOString();
    opt.dataset.deviceId = s.unique_id || '';
    sel.appendChild(opt);
  }

  async function loadDeviceOptions() {
    const sel = document.getElementById('historyDeviceId');
    if (!sel) return [];
    const seen = new Set();
    const opts = [];
    deviceBounds.clear();

    let data;
    try {
      data = await fetchJson(`${window.dashboardApiBase()}/api/history?list=devices`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sel.innerHTML = '<option value="">— could not load devices —</option>';
      throw new Error(
        `Device list failed (${msg}). Enter the ingest token in Monitor settings (below) if Vercel uses INGEST_TOKEN, then click Refresh lists.`,
      );
    }

    if (!data.persisted) {
      sel.innerHTML = '<option value="">— no database —</option>';
      throw new Error('Postgres not configured on server — add POSTGRES_URL on Vercel.');
    }

    for (const d of data.devices || []) {
      if (!d.uniqueId || seen.has(d.uniqueId)) continue;
      seen.add(d.uniqueId);
      if (d.lastUpdate) deviceLastSeen.set(d.uniqueId, d.lastUpdate);
      if (d.firstSampleMs != null && d.lastSampleMs != null) {
        deviceBounds.set(d.uniqueId, {
          firstSampleMs: Number(d.firstSampleMs),
          lastSampleMs: Number(d.lastSampleMs),
          sampleCount: Number(d.sampleCount) || 0,
        });
      }
      const cnt = d.sampleCount ? ` (${d.sampleCount} samples)` : '';
      opts.push({ id: d.uniqueId, label: `${d.uniqueId}${cnt}` });
    }

    const saved = localStorage.getItem(LS_HISTORY_DEVICE) || '';
    if (!opts.length) {
      sel.innerHTML = '<option value="">— no devices in database yet —</option>';
      return opts;
    }
    sel.innerHTML =
      '<option value="">— select device —</option>' +
      opts.map((o) => `<option value="${o.id}">${o.label}</option>`).join('');
    if (saved && seen.has(saved)) sel.value = saved;
    return opts;
  }

  async function reloadHistoryLists() {
    setHistoryStatus('Refreshing device and session lists…');
    try {
      await loadDeviceOptions();
      await loadRecentSessions();
      await smokeTestHistoryApi();
      const deviceId = document.getElementById('historyDeviceId')?.value?.trim();
      if (deviceId) applyDeviceStoredRange(deviceId);
    } catch (e) {
      setHistoryStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  window.reloadDashboardHistory = reloadHistoryLists;

  /** Recent sessions from DB (all devices) — available as soon as the page opens. */
  async function loadRecentSessions() {
    const sel = document.getElementById('historySessionId');
    if (!sel) return;
    sel.innerHTML = '<option value="">— pick a recorded session —</option>';

    try {
      const data = await fetchJson(`${window.dashboardApiBase()}/api/history?list=sessions`);
      for (const s of data.sessions || []) {
        appendSessionOption(sel, s);
      }
      if (!data.sessions?.length) {
        setHistoryStatus(
          'No sessions in database yet — record on a phone and wait for upload.',
          true,
        );
      }
    } catch (e) {
      setHistoryStatus(`Sessions: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  window.mergeHistoryDevices = mergeDeviceIds;

  async function loadSessionOptions() {
    const deviceId = document.getElementById('historyDeviceId')?.value?.trim();
    const sel = document.getElementById('historySessionId');
    if (!sel) return;

    if (!deviceId) {
      await loadRecentSessions();
      return;
    }

    sel.innerHTML = '<option value="">— pick a recorded session —</option>';
    try {
      const url = `${window.dashboardApiBase()}/api/history?list=sessions&uniqueId=${encodeURIComponent(deviceId)}`;
      const data = await fetchJson(url);
      for (const s of data.sessions || []) {
        appendSessionOption(sel, s);
      }
      if (!data.sessions?.length) {
        setHistoryStatus(`No sessions stored for ${deviceId}.`, true);
      } else {
        const bounds = deviceBounds.get(deviceId);
        const hint = bounds
          ? `Stored ${bounds.sampleCount} samples · ${fmtTime(bounds.firstSampleMs)} – ${fmtTime(bounds.lastSampleMs)}`
          : `${data.sessions.length} session(s) for ${deviceId}`;
        setHistoryStatus(`${hint} — pick a session or Load history.`);
      }
    } catch (e) {
      setHistoryStatus(`Sessions: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  async function loadHistory() {
    const deviceId = document.getElementById('historyDeviceId')?.value?.trim();
    const sessionId = document.getElementById('historySessionId')?.value?.trim();
    let url;
    if (sessionId) {
      url = `${window.dashboardApiBase()}/api/history?format=dashboard&sessionId=${encodeURIComponent(sessionId)}`;
    } else {
      if (!deviceId) {
        setHistoryStatus('Select a device or a session.', true);
        return;
      }
      const { from, to } = rangeFromInputs();
      if (!from || !to) {
        setHistoryStatus('Set from/to date and time, or pick a session.', true);
        return;
      }
      if (new Date(from).getTime() >= new Date(to).getTime()) {
        setHistoryStatus('"To" must be after "From".', true);
        return;
      }
      url = `${window.dashboardApiBase()}/api/history?format=dashboard&uniqueId=${encodeURIComponent(deviceId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      localStorage.setItem(LS_HISTORY_DEVICE, deviceId);
    }

    setHistoryStatus('Loading history…');
    hideHistoryResults();

    try {
      const data = await fetchJson(url);
      if (!data.track?.length) {
        const bounds = deviceId ? deviceBounds.get(deviceId) : null;
        let hint =
          'No samples in this date/time range (data is in the database — range may be too narrow).';
        if (bounds?.firstSampleMs) {
          hint += ` Stored for ${deviceId || data.uniqueId}: ${fmtTime(bounds.firstSampleMs)} – ${fmtTime(bounds.lastSampleMs)} — try All stored for device or pick a session.`;
        } else if (!sessionId) {
          hint += ' Pick a session from the list (recommended).';
        }
        setHistoryStatus(hint, true);
        return;
      }

      const maxSpd = Math.max(
        0,
        ...data.track.map((p) => (p.speed != null ? p.speed : 0)),
      );
      const hrPts = data.track.filter((p) => p.hr != null).length;
      const dsNote = data.downsampled
        ? ` (map/charts use ${data.track.length} of ${data.pointCount} points)`
        : '';
      const gpsNote =
        data.gpsCount === 0
          ? ' · no GPS in this session (map empty)'
          : '';
      setHistoryStatus(
        `Loaded — scroll down for map and charts. ${data.pointCount} samples · ${data.gpsCount} GPS · ${hrPts} HR · max ${fmtPace(maxSpd, data.uniqueId || deviceId)} · ${data.capsizeEvents?.length ?? 0} capsize${dsNote}${gpsNote}`,
      );

      const meta = document.getElementById('historyMeta');
      if (meta) {
        meta.textContent = `${data.uniqueId || deviceId}${data.sessionId ? ` · session ${data.sessionId.slice(0, 8)}…` : ''} · ${fmtTime(new Date(data.from).getTime())} – ${fmtTime(new Date(data.to).getTime())}`;
      }

      showHistoryResults();

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          renderHistoryMap(data.track, data.capsizeEvents || []);
          renderCharts(data.track);
          renderCapsizeList(data.capsizeEvents || [], data.capsizeSampleCount || 0);
        });
      });
    } catch (e) {
      setHistoryStatus(`History error: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  async function smokeTestHistoryApi() {
    try {
      const devices = await fetchJson(
        `${window.dashboardApiBase()}/api/history?list=devices`,
      );
      if (!devices.persisted) {
        setHistoryStatus('History needs Postgres on Vercel — not configured.', true);
        return;
      }
      const n = devices.devices?.length ?? 0;
      const totalSamples = (devices.devices || []).reduce(
        (sum, d) => sum + (Number(d.sampleCount) || 0),
        0,
      );
      setHistoryStatus(
        `History ready — ${n} device(s), ${totalSamples.toLocaleString()} stored samples (full database, not this browser). Pick a session above.`,
      );
    } catch (e) {
      setHistoryStatus(
        `History API check failed: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
    }
  }

  let historyInitDone = false;

  window.initDashboardHistory = function initDashboardHistory() {
    if (historyInitDone) return;
    historyInitDone = true;
    const now = Date.now();
    if (!document.getElementById('historyFromDate')?.value) {
      setRangeInputs(now - 30 * 24 * 60 * 60 * 1000, now);
    }

    void reloadHistoryLists();

    document.getElementById('historyRefreshListsBtn')?.addEventListener('click', () => {
      void reloadHistoryLists();
    });

    document.getElementById('historyDeviceId')?.addEventListener('change', () => {
      document.querySelectorAll('.history-preset').forEach((b) => b.classList.remove('is-active'));
      const deviceId = document.getElementById('historyDeviceId')?.value?.trim();
      if (deviceId) {
        applyDeviceStoredRange(deviceId);
        localStorage.setItem(LS_HISTORY_DEVICE, deviceId);
      }
      void loadSessionOptions();
    });

    document.querySelectorAll('.history-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyPreset(btn.getAttribute('data-preset'));
      });
    });

    document.getElementById('historyLoadBtn')?.addEventListener('click', () => void loadHistory());

    document.getElementById('historySessionId')?.addEventListener('change', () => {
      const sel = document.getElementById('historySessionId');
      const opt = sel?.selectedOptions?.[0];
      const sid = sel?.value;
      if (!sid || !opt) return;
      document.querySelectorAll('.history-preset').forEach((b) => b.classList.remove('is-active'));
      const dev = opt.dataset.deviceId;
      if (dev) {
        const devSel = document.getElementById('historyDeviceId');
        if (devSel) devSel.value = dev;
      }
      const started = opt.dataset.startedAt;
      const ended = opt.dataset.endedAt;
      if (started && ended) {
        setRangeInputs(new Date(started).getTime(), new Date(ended).getTime());
      }
      void loadHistory();
    });

    ['historyFromDate', 'historyFromTime', 'historyToDate', 'historyToTime'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => {
        document.querySelectorAll('.history-preset').forEach((b) => b.classList.remove('is-active'));
        const sessionSel = document.getElementById('historySessionId');
        if (sessionSel) sessionSel.value = '';
      });
    });
  };

  // Fallback: if dashboard.js ran before this file, initialize now.
  if (document.readyState !== 'loading') {
    window.initDashboardHistory?.();
  } else {
    document.addEventListener('DOMContentLoaded', () => window.initDashboardHistory?.(), {
      once: true,
    });
  }
})();



