/**
 * RNZ club admin on dashboard Settings (ADMIN_TOKEN).
 */
(function () {
  const SS_KEY = 'dashboard_admin_token';

  function apiBase() {
    if (typeof window.dashboardApiBase === 'function') return window.dashboardApiBase();
    return window.location.origin;
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function loadAdminToken() {
    try {
      return sessionStorage.getItem(SS_KEY)?.trim() || '';
    } catch {
      return '';
    }
  }

  function saveAdminToken(token) {
    try {
      const t = String(token || '').trim();
      if (t) sessionStorage.setItem(SS_KEY, t);
      else sessionStorage.removeItem(SS_KEY);
    } catch {
      /* ignore */
    }
  }

  function adminHeaders() {
    const h = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const token = loadAdminToken();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  function setStatus(text, isError) {
    const el = document.getElementById('clubAdminStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('poll-line--warn', Boolean(isError));
  }

  function formatCreated(raw) {
    if (!raw) return '—';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-NZ', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  function setUnlocked(unlocked) {
    const locked = document.getElementById('clubAdminLocked');
    const open = document.getElementById('clubAdminUnlocked');
    if (locked) locked.hidden = unlocked;
    if (open) open.hidden = !unlocked;
  }

  function showOneTimeToken(slug, token) {
    const box = document.getElementById('clubAdminTokenBox');
    const slugEl = document.getElementById('clubAdminTokenSlug');
    const input = document.getElementById('clubAdminOneTimeToken');
    if (slugEl) slugEl.textContent = slug;
    if (input) input.value = token;
    if (box) box.hidden = false;
  }

  function dismissOneTimeToken() {
    const box = document.getElementById('clubAdminTokenBox');
    const input = document.getElementById('clubAdminOneTimeToken');
    if (input) input.value = '';
    if (box) box.hidden = true;
  }

  function renderOrgs(orgs) {
    const body = document.getElementById('clubAdminTableBody');
    if (!body) return;
    const items = Array.isArray(orgs) ? orgs : [];
    if (!items.length) {
      body.innerHTML = '<tr><td colspan="4">No clubs yet.</td></tr>';
      return;
    }
    body.innerHTML = items
      .map(
        (o) => `
      <tr>
        <td><code>${esc(o.slug)}</code></td>
        <td>${esc(o.name)}</td>
        <td>${esc(formatCreated(o.createdAt))}</td>
        <td class="club-admin-actions">
          <button type="button" class="hub-btn hub-btn--ghost" data-rename-slug="${esc(o.slug)}">Rename</button>
          <button type="button" class="hub-btn hub-btn--ghost" data-rotate-slug="${esc(o.slug)}">Rotate token</button>
        </td>
      </tr>`,
      )
      .join('');
    body.querySelectorAll('[data-rename-slug]').forEach((btn) => {
      btn.addEventListener('click', () => void onRename(btn.getAttribute('data-rename-slug')));
    });
    body.querySelectorAll('[data-rotate-slug]').forEach((btn) => {
      btn.addEventListener('click', () => void onRotate(btn.getAttribute('data-rotate-slug')));
    });
  }

  async function refresh() {
    const token = loadAdminToken();
    if (!token) {
      setUnlocked(false);
      return;
    }
    setStatus('Loading clubs…');
    try {
      const res = await fetch(`${apiBase()}/api/admin-orgs`, {
        method: 'GET',
        headers: adminHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          saveAdminToken('');
          setUnlocked(false);
        }
        throw new Error(data.error || `Admin ${res.status}`);
      }
      setUnlocked(true);
      renderOrgs(data.orgs || []);
      setStatus(`${(data.orgs || []).length} club(s)`);
    } catch (err) {
      setStatus(err.message || 'Could not load clubs', true);
    }
  }

  async function unlock() {
    const input = document.getElementById('clubAdminToken');
    const token = input?.value.trim() || '';
    if (!token) {
      setStatus('Enter ADMIN_TOKEN', true);
      return;
    }
    saveAdminToken(token);
    if (input) input.value = '';
    await refresh();
  }

  function lock() {
    saveAdminToken('');
    dismissOneTimeToken();
    setUnlocked(false);
    renderOrgs([]);
    setStatus('Club admin locked');
  }

  async function onCreate(ev) {
    ev?.preventDefault?.();
    const slug = document.getElementById('clubAdminCreateSlug')?.value.trim() || '';
    const name = document.getElementById('clubAdminCreateName')?.value.trim() || '';
    if (!slug) {
      setStatus('Slug is required', true);
      return;
    }
    setStatus('Creating club…');
    try {
      const res = await fetch(`${apiBase()}/api/admin-orgs`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ slug, name: name || slug }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Create failed (${res.status})`);
      if (data.token && data.org?.slug) showOneTimeToken(data.org.slug, data.token);
      const slugInput = document.getElementById('clubAdminCreateSlug');
      const nameInput = document.getElementById('clubAdminCreateName');
      if (slugInput) slugInput.value = '';
      if (nameInput) nameInput.value = '';
      await refresh();
      setStatus(`Created club ${data.org?.slug || slug}`);
    } catch (err) {
      setStatus(err.message || 'Could not create club', true);
    }
  }

  async function onRename(slug) {
    if (!slug) return;
    const next = window.prompt(`New display name for ${slug}`, slug);
    if (next == null) return;
    const name = next.trim();
    if (!name) {
      setStatus('Name is required', true);
      return;
    }
    setStatus('Renaming…');
    try {
      const res = await fetch(`${apiBase()}/api/admin-orgs`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify({ slug, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Rename failed (${res.status})`);
      await refresh();
      setStatus(`Renamed ${slug}`);
    } catch (err) {
      setStatus(err.message || 'Could not rename', true);
    }
  }

  async function onRotate(slug) {
    if (!slug) return;
    const ok = window.confirm(
      `Rotate ingest token for "${slug}"?\n\nAll phones and Manager apps using the old token will stop working until updated.`,
    );
    if (!ok) return;
    setStatus('Rotating token…');
    try {
      const res = await fetch(`${apiBase()}/api/admin-orgs`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ action: 'rotate', slug }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Rotate failed (${res.status})`);
      if (data.token && data.org?.slug) showOneTimeToken(data.org.slug, data.token);
      await refresh();
      setStatus(`Rotated token for ${slug}`);
    } catch (err) {
      setStatus(err.message || 'Could not rotate token', true);
    }
  }

  function init() {
    if (!document.getElementById('clubAdminSettings')) return;
    document.getElementById('clubAdminUnlockBtn')?.addEventListener('click', () => void unlock());
    document.getElementById('clubAdminLockBtn')?.addEventListener('click', lock);
    document.getElementById('clubAdminRefreshBtn')?.addEventListener('click', () => void refresh());
    document.getElementById('clubAdminCreateForm')?.addEventListener('submit', (ev) => void onCreate(ev));
    document.getElementById('clubAdminCopyTokenBtn')?.addEventListener('click', () => {
      const input = document.getElementById('clubAdminOneTimeToken');
      if (!input?.value) return;
      void navigator.clipboard.writeText(input.value).then(
        () => setStatus('Token copied'),
        () => {
          input.select();
          setStatus('Select and copy the token manually');
        },
      );
    });
    document.getElementById('clubAdminDismissTokenBtn')?.addEventListener('click', dismissOneTimeToken);
    if (loadAdminToken()) void refresh();
    else setUnlocked(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
