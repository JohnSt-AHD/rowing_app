/**
 * Live monitor — GPS/upload debug chart (updates each poll).
 */
(function () {
  const MAX_POINTS = 450;
  const LS_DEVICE = 'rnz_monitor_chart_device';

  /** @type {{ t: number, online: number, ingestHz: number, gpsHz: number, fixClockAgeSec: number, uploadLagSec: number, displayFixAgeSec: number, fixClockLagSec: number, lastSeenAgoSec: number, inBoatPark: number, delayedGps: number, capsize: number, strokeSpm: number, heartbeatHz: number, batteryPct: number }[]} */
  const fleetHistory = [];
  /** @type {Map<string, typeof fleetHistory>} */
  const deviceHistory = new Map();

  let selectedDeviceId = '';

  /** Clip z-scores to ±Z_CLIP for the shared chart scale. */
  const Z_CLIP = 2.5;

  const SERIES = [
    {
      key: 'online',
      label: 'Online devices',
      labelDevice: 'Online',
      color: '#4ade80',
      pick: (p) => p.online,
      format: (v) => String(Math.round(v)),
    },
    {
      key: 'ingestHz',
      label: 'Ingest (Hz)',
      color: '#22d3ee',
      pick: (p) => p.ingestHz,
      format: (v) => v.toFixed(2),
    },
    {
      key: 'gpsHz',
      label: 'GPS (Hz)',
      color: '#38bdf8',
      pick: (p) => p.gpsHz,
      format: (v) => v.toFixed(2),
    },
    {
      key: 'fixClockAgeSec',
      label: 'Fix clock age (s)',
      labelDevice: 'Fix clock age (s)',
      color: '#fbbf24',
      pick: (p) => p.fixClockAgeSec,
      format: (v) => v.toFixed(1),
    },
    {
      key: 'uploadLagSec',
      label: 'Upload lag (s)',
      color: '#f97316',
      pick: (p) => p.uploadLagSec,
      format: (v) => v.toFixed(1),
    },
    {
      key: 'displayFixAgeSec',
      label: 'Display fix age (s)',
      labelDevice: 'Display fix age (s)',
      color: '#fcd34d',
      pick: (p) => p.displayFixAgeSec,
      format: (v) => v.toFixed(1),
    },
    {
      key: 'fixClockLagSec',
      label: 'Fix clock lag (s)',
      labelDevice: 'Fix clock lag (s)',
      color: '#fb923c',
      pick: (p) => p.fixClockLagSec,
      format: (v) => v.toFixed(1),
      hideWhenZero: true,
    },
    {
      key: 'lastSeenAgoSec',
      label: 'Last seen (s)',
      color: '#94a3b8',
      pick: (p) => p.lastSeenAgoSec,
      format: (v) => v.toFixed(0),
    },
    {
      key: 'inBoatPark',
      label: 'Boat park devices',
      labelDevice: 'Boat park',
      color: '#2dd4bf',
      pick: (p) => p.inBoatPark,
      format: (v) => String(Math.round(v)),
      hideWhenZero: true,
    },
    {
      key: 'delayedGps',
      label: 'Delayed GPS',
      labelDevice: 'GPS delayed',
      color: '#fb7185',
      pick: (p) => p.delayedGps,
      format: (v) => String(Math.round(v)),
      hideWhenZero: true,
    },
    {
      key: 'heartbeatHz',
      label: 'Heartbeat (Hz)',
      color: '#86efac',
      pick: (p) => p.heartbeatHz,
      format: (v) => v.toFixed(2),
      hideWhenZero: true,
    },
    {
      key: 'batteryPct',
      label: 'Battery (%)',
      color: '#fde047',
      pick: (p) => p.batteryPct,
      format: (v) => (v > 0 ? String(Math.round(v)) : '—'),
      hideWhenZero: true,
    },
    {
      key: 'strokeSpm',
      label: 'Stroke (spm)',
      color: '#a78bfa',
      pick: (p) => p.strokeSpm,
      format: (v) => (v > 0 ? String(Math.round(v)) : '—'),
      hideWhenZero: true,
    },
    {
      key: 'capsize',
      label: 'Capsize alerts',
      labelDevice: 'Capsize',
      color: '#ef4444',
      pick: (p) => p.capsize,
      format: (v) => String(Math.round(v)),
      hideWhenZero: true,
    },
  ];

  function $(sel) {
    return document.querySelector(sel);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function numOrNaN(value) {
    return Number.isFinite(value) ? value : NaN;
  }

  /** @param {object|undefined} gps */
  function gpsDebugFromGps(gps) {
    const g = gps || {};
    const displayFixAgeSec = g.displayAgeSec ?? g.ageSec;
    return {
      fixClockAgeSec: numOrNaN(g.gpsFixAgeSec),
      uploadLagSec: numOrNaN(g.uploadLagSec),
      displayFixAgeSec: numOrNaN(displayFixAgeSec),
      fixClockLagSec: numOrNaN(g.fixClockLagSec),
    };
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

  function seriesStandardStats(pts, pick) {
    const vals = pts.map(pick).filter((v) => Number.isFinite(v));
    if (!vals.length) return { mean: 0, std: 1 };
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (vals.length < 2) return { mean, std: 1 };
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance) || 1;
    return { mean, std };
  }

  function zScore(y, mean, std) {
    return (y - mean) / std;
  }

  /** Map z ∈ [-Z_CLIP, Z_CLIP] to 0–1 for plotting. */
  function zToPlotNorm(z) {
    const clipped = Math.max(-Z_CLIP, Math.min(Z_CLIP, z));
    return (clipped + Z_CLIP) / (2 * Z_CLIP);
  }

  function fleetPoint(data) {
    const health = data.health || {};
    return {
      t: data.polledAt || Date.now(),
      online: health.onlineDevices ?? data.activeCount ?? 0,
      ingestHz: health.avgIngestHz ?? 0,
      gpsHz: health.avgGpsHz ?? 0,
      fixClockAgeSec: health.avgGpsFixAgeSec ?? health.avgGpsAgeSec ?? 0,
      uploadLagSec: health.avgUploadLagSec ?? 0,
      displayFixAgeSec: health.avgGpsAgeSec ?? 0,
      fixClockLagSec: health.avgFixClockLagSec ?? 0,
      lastSeenAgoSec: health.avgLastSeenAgoSec ?? health.serverDataLagSec ?? 0,
      inBoatPark: health.devicesInBoatPark ?? 0,
      delayedGps: health.delayedGpsDevices ?? 0,
      capsize: health.capsizeDevices ?? 0,
      strokeSpm: health.avgStrokeSpm ?? 0,
      heartbeatHz: health.avgHeartbeatHz ?? 0,
      batteryPct: health.avgBatteryPct ?? 0,
    };
  }

  function devicePoint(d, t) {
    const gpsDebug = gpsDebugFromGps(d.gps);
    const displayFixAgeSec = gpsDebug.displayFixAgeSec;
    return {
      t,
      online: d.online ? 1 : 0,
      ingestHz: d.ingestRateHz ?? 0,
      gpsHz: d.gps?.rateHz ?? 0,
      fixClockAgeSec: gpsDebug.fixClockAgeSec,
      uploadLagSec: gpsDebug.uploadLagSec,
      displayFixAgeSec,
      fixClockLagSec: gpsDebug.fixClockLagSec,
      lastSeenAgoSec: d.lastSeenAgoSec ?? 0,
      inBoatPark: d.derived?.inBoatPark === true ? 1 : 0,
      delayedGps: Number.isFinite(displayFixAgeSec) && displayFixAgeSec > 30 ? 1 : 0,
      capsize: d.rowing?.capsize ? 1 : 0,
      strokeSpm: d.rowing?.strokeRate ?? 0,
      heartbeatHz: d.heartbeat?.rateHz ?? 0,
      batteryPct: d.battery?.pct ?? NaN,
    };
  }

  function activeHistory() {
    if (!selectedDeviceId) return fleetHistory;
    return deviceHistory.get(selectedDeviceId) || [];
  }

  function chartScopeLabel() {
    return selectedDeviceId ? selectedDeviceId : 'fleet average';
  }

  function seriesLabel(s) {
    return selectedDeviceId && s.labelDevice ? s.labelDevice : s.label;
  }

  function visibleSeries(pts) {
    const latest = pts[pts.length - 1];
    return SERIES.filter((s) => {
      if (!s.hideWhenZero || !latest) return true;
      const v = s.pick(latest);
      if (pts.length < 2) return v > 0;
      return pts.some((p) => s.pick(p) > 0);
    });
  }

  function drawCombinedChart(canvas, pts) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 110;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 12, r: 12, t: 28, b: 22 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const scope = chartScopeLabel();

    if (pts.length < 2) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px system-ui, sans-serif';
      const msg = selectedDeviceId
        ? `Collecting data for ${selectedDeviceId}…`
        : 'Collecting fleet data…';
      ctx.fillText(msg, pad.l, h / 2);
      return;
    }

    const active = visibleSeries(pts);
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const xAt = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * plotW;
    const yAt = (norm) => pad.t + plotH - norm * plotH;
    const yZero = yAt(zToPlotNorm(0));

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, yZero);
    ctx.lineTo(pad.l + plotW, yZero);
    ctx.stroke();
    ctx.setLineDash([]);

    const latest = pts[pts.length - 1];
    const legendEl = $('#monitorChartLegend');
    if (legendEl) {
      legendEl.innerHTML = active
        .map((s) => {
          const val = s.pick(latest);
          const { mean, std } = seriesStandardStats(pts, s.pick);
          const z = Number.isFinite(val) ? zScore(val, mean, std) : NaN;
          const zText = Number.isFinite(z) ? `z ${z >= 0 ? '+' : ''}${z.toFixed(1)}` : 'z —';
          return `<span class="monitor-legend-item"><span class="monitor-legend-swatch" style="background:${s.color}"></span>${seriesLabel(s)}: <strong>${s.format(val)}</strong> <span class="monitor-legend-range">(${zText}, window μ ${s.format(mean)})</span></span>`;
        })
        .join('');
    }

    for (const s of active) {
      const { mean, std } = seriesStandardStats(pts, s.pick);
      const linePts = pts
        .map((p) => {
          const y = s.pick(p);
          if (!Number.isFinite(y)) return null;
          return { t: p.t, norm: zToPlotNorm(zScore(y, mean, std)) };
        })
        .filter(Boolean);

      if (linePts.length < 2) continue;

      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      linePts.forEach((p, i) => {
        const x = xAt(p.t);
        const y = yAt(p.norm);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`−${Z_CLIP}σ`, pad.l, pad.t + plotH + 2);
    ctx.fillText(`+${Z_CLIP}σ`, pad.l, pad.t + 4);
    ctx.fillText('0', pad.l + 4, yZero + 4);
    ctx.fillText(new Date(t0).toLocaleTimeString(), pad.l, h - 6);
    ctx.fillText(new Date(t1).toLocaleTimeString(), pad.l + plotW - 56, h - 6);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`GPS & upload debug — ${scope} (standardised)`, pad.l, 16);
  }

  function renderStatsChart() {
    const pts = downsample(activeHistory(), MAX_POINTS);
    drawCombinedChart($('#monitorChartCombined'), pts);

    const hint = $('#monitorStatsHint');
    if (hint && pts.length >= 2) {
      const spanMin = Math.round((pts[pts.length - 1].t - pts[0].t) / 60000);
      hint.textContent = `${chartScopeLabel()} · last ${spanMin} min · ${pts.length} samples · fix clock age, upload lag, display age, boat-park economy; legend shows actual values`;
    } else if (hint) {
      hint.textContent = selectedDeviceId
        ? `Waiting for polls from ${selectedDeviceId}…`
        : 'Collecting fleet GPS/upload debug metrics from each refresh…';
    }
  }

  function trimHistory(arr) {
    while (arr.length > MAX_POINTS) arr.shift();
  }

  function updateDeviceSelect(devices) {
    const sel = $('#monitorChartDevice');
    if (!sel) return;
    const ids = [...new Set((devices || []).map((d) => d.deviceId).filter(Boolean))].sort();
    const prev = sel.value || selectedDeviceId;
    const options = ['<option value="">All devices (fleet average)</option>'];
    for (const id of ids) {
      options.push(`<option value="${esc(id)}">${esc(id)}</option>`);
    }
    sel.innerHTML = options.join('');
    if (prev && (prev === '' || ids.includes(prev))) {
      sel.value = prev;
    } else {
      sel.value = '';
    }
    selectedDeviceId = sel.value;
    try {
      localStorage.setItem(LS_DEVICE, selectedDeviceId);
    } catch {
      /* optional */
    }
  }

  function recordPollSnapshot(data) {
    const t = data.polledAt || Date.now();
    fleetHistory.push(fleetPoint(data));
    trimHistory(fleetHistory);

    for (const d of data.devices || []) {
      if (!d.deviceId) continue;
      let series = deviceHistory.get(d.deviceId);
      if (!series) {
        series = [];
        deviceHistory.set(d.deviceId, series);
      }
      series.push(devicePoint(d, t));
      trimHistory(series);
    }

    updateDeviceSelect(data.devices);
    renderStatsChart();
  }

  function onPoll(data) {
    recordPollSnapshot(data);
  }

  function init() {
    const sel = $('#monitorChartDevice');
    try {
      const saved = localStorage.getItem(LS_DEVICE);
      if (saved != null) selectedDeviceId = saved;
    } catch {
      /* optional */
    }
    if (sel) {
      sel.addEventListener('change', () => {
        selectedDeviceId = sel.value;
        try {
          localStorage.setItem(LS_DEVICE, selectedDeviceId);
        } catch {
          /* optional */
        }
        renderStatsChart();
      });
    }
    window.addEventListener('resize', renderStatsChart);
  }

  window.dashboardMonitorCharts = { onPoll, init };

  init();
})();
