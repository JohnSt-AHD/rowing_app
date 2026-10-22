/**
 * Shared NZ-day capsize log on the device monitor (same API as Manager / RowSafe).
 */
(function () {
  function apiBase() {
    if (typeof window.dashboardApiBase === 'function') return window.dashboardApiBase();
    return '';
  }

  function headers() {
    if (typeof window.dashboardHeaders === 'function') return window.dashboardHeaders();
    return { Accept: 'application/json' };
  }

  function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatNzTime(ms) {
    return new Intl.DateTimeFormat('en-NZ', {
      timeZone: 'Pacific/Auckland',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  }

  function formatAckLine(e) {
    if (e.status === 'acknowledged') {
      const when = e.ackedAt ? formatNzTime(e.ackedAt) : '';
      const who = e.ackedBy || (e.ackSource === 'rowsafe' ? 'RowSafe' : 'CrewSight Manager');
      const via =
        e.ackSource === 'rowsafe'
          ? ' (RowSafe)'
          : e.ackSource === 'manager'
            ? ' (Manager)'
            : '';
      return `Acknowledged ${when} by ${who}${via}`.replace(/\s+/g, ' ').trim();
    }
    if (e.status === 'cleared') {
      return `Cleared ${e.ackedAt ? formatNzTime(e.ackedAt) : ''} · ${e.ackedBy || 'RowSafe or another Manager'}`
        .replace(/\s+/g, ' ')
        .trim();
    }
    return 'Active — not acknowledged';
  }

  function deviceLatLon(d) {
    const gps = d?.gps || d?.position || {};
    const lat = Number(gps.lat ?? gps.latitude ?? d?.lat ?? d?.latitude);
    const lon = Number(gps.lon ?? gps.longitude ?? d?.lon ?? d?.longitude);
    return {
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
    };
  }

  function mergeLiveCapsizes(events, devices) {
    const out = Array.isArray(events) ? events.slice() : [];
    for (const d of devices || []) {
      if (!d?.rowing?.capsize || !d.deviceId) continue;
      if (out.some((e) => e.deviceId === d.deviceId && e.status === 'active')) continue;
      const loc = deviceLatLon(d);
      out.unshift({
        id: `live-${d.deviceId}`,
        deviceId: d.deviceId,
        name: d.deviceId,
        lat: loc.lat,
        lon: loc.lon,
        startedAt: Date.now(),
        status: 'active',
      });
    }
    return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  function renderList(events) {
    const list = document.getElementById('capsizeDayLog');
    if (!list) return;
    if (!events.length) {
      list.innerHTML = '<li class="dash-capsize-log__empty">No capsizes today</li>';
      return;
    }
    list.innerHTML = events
      .map((e) => {
        const loc =
          e.lat != null && e.lon != null
            ? `${Number(e.lat).toFixed(4)}, ${Number(e.lon).toFixed(4)}`
            : 'No GPS';
        return (
          `<li class="dash-capsize-log__item dash-capsize-log__item--${escapeHtml(e.status)}">` +
          `<strong>${escapeHtml(e.name || e.deviceId)}</strong>` +
          `<span>${escapeHtml(formatNzTime(e.startedAt))} · ${escapeHtml(loc)}</span>` +
          `<span>${escapeHtml(formatAckLine(e))}</span>` +
          `</li>`
        );
      })
      .join('');
  }

  let lastDevices = [];
  let inFlight = false;

  async function refresh(devices) {
    if (Array.isArray(devices)) lastDevices = devices;
    const list = document.getElementById('capsizeDayLog');
    if (!list || inFlight) return;
    inFlight = true;
    try {
      const res = await fetch(`${apiBase()}/api/capsize-day-log`, { headers: headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Capsize log ${res.status}`);
      const events = Array.isArray(data.events) ? data.events : [];
      renderList(mergeLiveCapsizes(events, lastDevices));
    } catch {
      renderList(mergeLiveCapsizes([], lastDevices));
    } finally {
      inFlight = false;
    }
  }

  window.dashboardRefreshCapsizeDayLog = refresh;

  function init() {
    renderList([]);
    void refresh([]);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
