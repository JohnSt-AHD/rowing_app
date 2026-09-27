/**
 * CrewSight Manager — coaches and boats fleet setup (recorder APK dropdowns).
 */
(function () {
  const BOAT_CLASSES = [
    'M1x',
    'W1x',
    'M2x',
    'W2x',
    'M2-',
    'W2-',
    'M2+',
    'W2+',
    'M4x',
    'W4x',
    'M4-',
    'W4-',
    'M4+',
    'W4+',
    'M8+',
    'W8+',
  ];

  function apiBase() {
    if (typeof window.dashboardApiBase === 'function') return window.dashboardApiBase();
    return window.location.origin;
  }

  function headers() {
    if (typeof window.dashboardHeaders === 'function') return window.dashboardHeaders();
    return { Accept: 'application/json' };
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function formatClassShort(boatClass) {
    const m = /^([BJL]?)([MW])([1248])([X+\-])$/.exec(String(boatClass || '').trim());
    if (!m) return boatClass || '';
    let type = m[4];
    if (type === 'x') type = 'X';
    return `${m[3]}${type}`;
  }

  function setStatus(text, isError) {
    const el = document.getElementById('fleetSetupStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('poll-line--warn', Boolean(isError));
  }

  function fillBoatClassSelect(select) {
    if (!select) return;
    const current = select.value;
    select.innerHTML = BOAT_CLASSES.map((c) => `<option value="${esc(c)}">${esc(c)} (${esc(formatClassShort(c))})</option>`).join('');
    if (current) select.value = current;
  }

  function renderCoaches(coaches) {
    const list = document.getElementById('fleetCoachList');
    const empty = document.getElementById('fleetCoachListEmpty');
    if (!list) return;
    const items = Array.isArray(coaches) ? coaches : [];
    if (empty) empty.hidden = items.length > 0;
    list.innerHTML = items
      .map(
        (c) => `
      <li class="fleet-setup-item">
        <span>${esc(c.name)}</span>
        <button type="button" class="hub-btn hub-btn--ghost" data-remove-coach="${esc(c.id)}">Remove</button>
      </li>`,
      )
      .join('');
    list.querySelectorAll('[data-remove-coach]').forEach((btn) => {
      btn.addEventListener('click', () => void removeCoach(btn.getAttribute('data-remove-coach')));
    });
  }

  function renderBoats(boats) {
    const list = document.getElementById('fleetBoatList');
    const empty = document.getElementById('fleetBoatListEmpty');
    if (!list) return;
    const items = Array.isArray(boats) ? boats : [];
    if (empty) empty.hidden = items.length > 0;
    list.innerHTML = items
      .map(
        (b) => `
      <li class="fleet-setup-item">
        <span><strong>${esc(b.label || b.name)}</strong> <span class="fleet-setup-meta">${esc(b.boatClass)}</span></span>
        <button type="button" class="hub-btn hub-btn--ghost" data-remove-boat="${esc(b.id)}">Remove</button>
      </li>`,
      )
      .join('');
    list.querySelectorAll('[data-remove-boat]').forEach((btn) => {
      btn.addEventListener('click', () => void removeBoat(btn.getAttribute('data-remove-boat')));
    });
  }

  function updateMeta(data) {
    const note = document.getElementById('fleetSetupStorageNote');
    if (note) {
      note.textContent = data?.persisted
        ? 'Coaches and boats are saved in the CrewSight database. Recorder APK settings load these lists automatically.'
        : 'No database connected — showing default lists (memory-only). Add POSTGRES_URL on Vercel to save changes.';
    }
  }

  async function refresh() {
    try {
      const res = await fetch(`${apiBase()}/api/fleet-config`, { headers: headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
      renderCoaches(data.coaches);
      renderBoats(data.boats);
      updateMeta(data);
      return data;
    } catch (err) {
      setStatus(err.message || 'Could not load coaches and boats', true);
      return null;
    }
  }

  async function addCoach(ev) {
    ev?.preventDefault?.();
    const input = document.getElementById('fleetCoachName');
    const name = input?.value.trim() || '';
    if (!name) {
      setStatus('Enter a coach name.', true);
      return;
    }
    setStatus('Adding coach…');
    try {
      const res = await fetch(`${apiBase()}/api/fleet-config`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'coach', name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Add failed (${res.status})`);
      if (input) input.value = '';
      await refresh();
      setStatus(`Added coach ${name}.`);
    } catch (err) {
      setStatus(err.message || 'Could not add coach', true);
    }
  }

  async function removeCoach(id) {
    if (!id || !window.confirm('Remove this coach?')) return;
    setStatus('Removing coach…');
    try {
      const res = await fetch(`${apiBase()}/api/fleet-config?type=coach&id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: headers(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Remove failed (${res.status})`);
      await refresh();
      setStatus('Coach removed.');
    } catch (err) {
      setStatus(err.message || 'Could not remove coach', true);
    }
  }

  async function addBoat(ev) {
    ev?.preventDefault?.();
    const nameInput = document.getElementById('fleetBoatName');
    const classSelect = document.getElementById('fleetBoatClass');
    const name = nameInput?.value.trim() || '';
    const boatClass = classSelect?.value || '';
    if (!name) {
      setStatus('Enter a boat name.', true);
      return;
    }
    if (!boatClass) {
      setStatus('Select a boat class.', true);
      return;
    }
    setStatus('Adding boat…');
    try {
      const res = await fetch(`${apiBase()}/api/fleet-config`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'boat', name, boatClass }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Add failed (${res.status})`);
      if (nameInput) nameInput.value = '';
      await refresh();
      const label = data.boat?.label || `${name} - ${formatClassShort(boatClass)}`;
      setStatus(`Added boat ${label}.`);
    } catch (err) {
      setStatus(err.message || 'Could not add boat', true);
    }
  }

  async function removeBoat(id) {
    if (!id || !window.confirm('Remove this boat?')) return;
    setStatus('Removing boat…');
    try {
      const res = await fetch(`${apiBase()}/api/fleet-config?type=boat&id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: headers(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Remove failed (${res.status})`);
      await refresh();
      setStatus('Boat removed.');
    } catch (err) {
      setStatus(err.message || 'Could not remove boat', true);
    }
  }

  function init() {
    fillBoatClassSelect(document.getElementById('fleetBoatClass'));
    document.getElementById('fleetCoachAddForm')?.addEventListener('submit', addCoach);
    document.getElementById('fleetBoatAddForm')?.addEventListener('submit', addBoat);
    document.getElementById('fleetSetupRefreshBtn')?.addEventListener('click', () => void refresh());
    void refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
