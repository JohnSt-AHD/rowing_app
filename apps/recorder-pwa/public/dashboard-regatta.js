/**
 * Regatta control — send HUD messages to devices during active sessions.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  /** @type {Map<string, { id: number, text: string, createdAt?: string }>} */
  const activeByDevice = new Map();
  let knownDeviceIds = [];
  let lastPollRefreshAt = 0;

  const ALL_DEVICES_VALUE = '__all__';
  const HELP_ON_WAY_TEXT = 'Help is on the way — stay with the boat.';

  async function postRegattaMessage(payload) {
    const res = await fetch(`${apiBase()}/api/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Send failed');
    }
    return data;
  }

  /**
   * Send preset help message to capsized device(s). Used by capsize alert bar.
   * @param {string[]} deviceIds
   * @returns {Promise<{ count: number, deviceIds: string[] }>}
   */
  window.dashboardSendHelpOnWay = async function (deviceIds) {
    const ids = [...new Set((deviceIds || []).map((id) => String(id ?? '').trim()).filter(Boolean))];
    if (!ids.length) {
      throw new Error('No capsized devices to message.');
    }
    const payload =
      ids.length === 1
        ? { deviceId: ids[0], text: HELP_ON_WAY_TEXT }
        : { allDevices: true, deviceIds: ids, text: HELP_ON_WAY_TEXT };
    const data = await postRegattaMessage(payload);
    await loadActiveMessages();
    return {
      count: Number(data.count) || ids.length,
      deviceIds: ids,
    };
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

  function setStatus(msg, isError) {
    const el = $('#regattaStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('poll-line--warn', !!isError);
  }

  function renderActiveList() {
    const el = $('#regattaActiveList');
    if (!el) return;
    const items = [...activeByDevice.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (!items.length) {
      el.innerHTML = '<p class="poll-line">No active messages.</p>';
      return;
    }
    el.innerHTML = items
      .map(
        ([deviceId, msg]) => `
      <div class="regatta-active-item" data-device-id="${esc(deviceId)}">
        <div class="regatta-active-item__main">
          <strong>${esc(deviceId)}</strong>
          <span class="regatta-active-item__text">${esc(msg.text)}</span>
        </div>
        <button type="button" class="hub-btn hub-btn--ghost regatta-clear-one-btn" data-device-id="${esc(deviceId)}">Clear</button>
      </div>`,
      )
      .join('');
    el.querySelectorAll('.regatta-clear-one-btn').forEach((btn) => {
      btn.addEventListener('click', () => void clearMessage(btn.getAttribute('data-device-id')));
    });
  }

  async function loadActiveMessages() {
    const res = await fetch(`${apiBase()}/api/messages`, { headers: headers() });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (res.status === 401) {
        throw new Error('401 — enter ingest token above to send messages.');
      }
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    activeByDevice.clear();
    for (const msg of data.messages || []) {
      if (msg?.deviceId && msg?.text) {
        activeByDevice.set(String(msg.deviceId), msg);
      }
    }
    renderActiveList();
    return data;
  }

  function updateDeviceSelect(deviceIds) {
    const sel = $('#regattaDeviceId');
    if (!sel) return;
    const prev = sel.value;
    const ids = [...new Set((deviceIds || []).filter(Boolean))].sort();
    knownDeviceIds = ids;
    const allLabel =
      ids.length === 1 ? 'All devices (1)' : `All devices (${ids.length})`;
    sel.innerHTML =
      `<option value="">— select device —</option>` +
      (ids.length
        ? `<option value="${ALL_DEVICES_VALUE}">${esc(allLabel)}</option>`
        : '') +
      ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
    if (prev && (prev === ALL_DEVICES_VALUE || ids.includes(prev))) sel.value = prev;
    updateSendButtonLabel();
  }

  function updateSendButtonLabel() {
    const btn = $('#regattaSendBtn');
    const sel = $('#regattaDeviceId');
    if (!btn || !sel) return;
    if (sel.value === ALL_DEVICES_VALUE) {
      btn.textContent =
        knownDeviceIds.length === 1
          ? 'Send to all devices (1)'
          : `Send to all devices (${knownDeviceIds.length})`;
      return;
    }
    btn.textContent = 'Send to device HUD';
  }

  async function sendMessage(ev) {
    ev.preventDefault();
    const deviceId = $('#regattaDeviceId')?.value?.trim();
    const text = $('#regattaText')?.value?.trim();
    const sendToAll = deviceId === ALL_DEVICES_VALUE;

    if (!deviceId) {
      setStatus('Select a device or all devices.', true);
      return;
    }
    if (!text) {
      setStatus('Enter a message.', true);
      return;
    }
    if (sendToAll && !knownDeviceIds.length) {
      setStatus('No devices in the current list — wait for the device poll or pick one device.', true);
      return;
    }
    if (sendToAll && knownDeviceIds.length > 1) {
      const ok = confirm(`Send this message to all ${knownDeviceIds.length} devices?`);
      if (!ok) return;
    }

    setStatus(sendToAll ? `Sending to ${knownDeviceIds.length} device(s)…` : 'Sending…');
    const payload = sendToAll
      ? { allDevices: true, deviceIds: knownDeviceIds, text }
      : { deviceId, text };
    await postRegattaMessage(payload);
    $('#regattaText').value = '';
    await loadActiveMessages();
    if (sendToAll) {
      const count = knownDeviceIds.length;
      setStatus(`Message sent to ${count} device(s). Appears on each HUD within ~15s.`);
      return;
    }
    setStatus(`Message sent to ${deviceId}. Appears on device HUD within ~15s.`);
  }

  async function clearMessage(deviceId) {
    const id = String(deviceId ?? '').trim();
    if (!id) return;
    if (!confirm(`Clear active message for ${id}?`)) return;
    setStatus('Clearing…');
    const res = await fetch(`${apiBase()}/api/messages?deviceId=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headers(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'Clear failed', true);
      return;
    }
    await loadActiveMessages();
    setStatus(`Message cleared for ${id}.`);
  }

  function bind() {
    $('#regattaForm')?.addEventListener('submit', (ev) => {
      void sendMessage(ev).catch((e) => setStatus(String(e.message || e), true));
    });
    $('#regattaDeviceId')?.addEventListener('change', updateSendButtonLabel);
    $('#regattaRefreshBtn')?.addEventListener('click', () => {
      void loadActiveMessages()
        .then((data) => {
          if (data.persisted) setStatus(`${activeByDevice.size} active message(s).`);
          else setStatus('Postgres required — set POSTGRES_URL on Vercel.', true);
        })
        .catch((e) => setStatus(String(e.message || e), true));
    });
  }

  window.dashboardInitRegatta = function () {
    bind();
    void loadActiveMessages().catch((e) => setStatus(String(e.message || e), true));
  };

  window.dashboardOnDevicesPoll = function (devices) {
    updateDeviceSelect((devices || []).map((d) => d.deviceId));
    const now = Date.now();
    if (now - lastPollRefreshAt < 12_000) return;
    lastPollRefreshAt = now;
    void loadActiveMessages().catch(() => {});
  };

  window.dashboardGetRegattaMessage = function (deviceId) {
    return activeByDevice.get(String(deviceId)) || null;
  };

  window.dashboardRefreshRegattaMessages = function () {
    void loadActiveMessages().catch(() => {});
  };
})();
