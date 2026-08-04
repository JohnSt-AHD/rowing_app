/**
 * Capsize alert emails via Resend (CrewSight Manager recipient list).
 */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function notifyFrom() {
  return (
    String(process.env.CAPSIZE_NOTIFY_FROM || '').trim() ||
    String(process.env.WARNING_NOTIFY_FROM || '').trim() ||
    ''
  );
}

function rowsafeMapUrl() {
  return (
    String(process.env.CAPSIZE_ROWSAFE_URL || '').trim() ||
    'https://traccar-overlay.vercel.app/rowsafe-map.html'
  );
}

function formatNzTime(ms) {
  const t = Number.isFinite(Number(ms)) ? Number(ms) : Date.now();
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(new Date(t));
}

function formatLatLon(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  return `${la.toFixed(6)}, ${lo.toFixed(6)}`;
}

function mapsUrl(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  return `https://www.google.com/maps?q=${encodeURIComponent(`${la},${lo}`)}`;
}

function mailConfigFlags(recipientCount) {
  const apiKey = Boolean(process.env.RESEND_API_KEY);
  const from = Boolean(notifyFrom());
  return {
    resend: apiKey,
    from,
    recipients: recipientCount,
    ready: apiKey && from && recipientCount > 0,
    fromAddress: notifyFrom() || null,
  };
}

function buildCapsizeEmailHtml({
  boat,
  lat,
  lon,
  eventMs,
  isTest = false,
}) {
  const when = formatNzTime(eventMs);
  const coords = formatLatLon(lat, lon);
  const gmaps = mapsUrl(lat, lon);
  const mapLink = rowsafeMapUrl();
  const intro = isTest
    ? 'This is a <strong>test</strong> Capsize alert email from CrewSight Manager.'
    : '<strong>Capsize alert</strong> — a CrewSight device reported a tip-over.';

  const locHtml = coords
    ? `<p><strong>Location:</strong> ${escapeHtml(coords)}${
        gmaps
          ? ` · <a href="${escapeHtml(gmaps)}">Open in Google Maps</a>`
          : ''
      }</p>`
    : '<p><strong>Location:</strong> Not available yet (GPS may still be catching up).</p>';

  return `<!DOCTYPE html><html><body style="font-family:Segoe UI,Roboto,sans-serif;color:#0f172a;line-height:1.45">
<p>${intro}</p>
<p><strong>Boat / device:</strong> ${escapeHtml(boat || 'Unknown')}</p>
<p><strong>Time (NZ):</strong> ${escapeHtml(when)}</p>
${locHtml}
<p style="color:#64748b;font-size:13px">Open the <a href="${escapeHtml(mapLink)}">RowSafe map</a> for live fleet detail.</p>
</body></html>`;
}

function buildCapsizeEmailSubject({ boat, isTest = false }) {
  const name = boat || 'Unknown device';
  return isTest
    ? `[TEST] CrewSight capsize alert — ${name}`
    : `CrewSight capsize alert — ${name}`;
}

/**
 * @param {{ to: string[], boat: string, lat?: number|null, lon?: number|null, eventMs?: number, isTest?: boolean }} opts
 */
async function sendCapsizeEmails(opts) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = notifyFrom();
  const to = Array.isArray(opts.to)
    ? [...new Set(opts.to.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))]
    : [];

  if (!apiKey || !from) {
    throw new Error(
      'RESEND_API_KEY and CAPSIZE_NOTIFY_FROM (or WARNING_NOTIFY_FROM) must be set in Vercel',
    );
  }
  if (!to.length) {
    throw new Error('Add at least one recipient email in Capsize email alerts');
  }

  const subject = buildCapsizeEmailSubject({
    boat: opts.boat,
    isTest: Boolean(opts.isTest),
  });
  const html = buildCapsizeEmailHtml({
    boat: opts.boat,
    lat: opts.lat,
    lon: opts.lon,
    eventMs: opts.eventMs,
    isTest: Boolean(opts.isTest),
  });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `Resend failed (${res.status})`);
  }
  return { sent: to.length, id: data.id, to, subject };
}

module.exports = {
  escapeHtml,
  notifyFrom,
  rowsafeMapUrl,
  formatNzTime,
  formatLatLon,
  mapsUrl,
  mailConfigFlags,
  buildCapsizeEmailHtml,
  buildCapsizeEmailSubject,
  sendCapsizeEmails,
};
