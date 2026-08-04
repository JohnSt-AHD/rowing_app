/**
 * CrewSight Manager — capsize email recipient admin + test send.
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

  function setStatus(text, isError) {
    const el = document.getElementById('capsizeEmailStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', Boolean(isError));
  }

  function renderList(emails) {
    const list = document.getElementById('capsizeEmailList');
    const empty = document.getElementById('capsizeEmailListEmpty');
    if (!list) return;
    list.innerHTML = '';
    const items = Array.isArray(emails) ? emails : [];
    if (empty) empty.hidden = items.length > 0;
    for (const email of items) {
      const li = document.createElement('li');
      li.className = 'capsize-email-item';
      const addr = document.createElement('span');
      addr.className = 'capsize-email-address';
      addr.textContent = email;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'hub-btn hub-btn--ghost capsize-email-remove';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => void removeEmail(email));
      li.appendChild(addr);
      li.appendChild(removeBtn);
      list.appendChild(li);
    }
  }

  function updateMeta(cfg) {
    const meta = document.getElementById('capsizeEmailMeta');
    const note = document.getElementById('capsizeEmailStorageNote');
    if (meta) {
      const parts = [];
      if (cfg.ready) {
        parts.push(
          `Ready to send · ${cfg.recipients} recipient${cfg.recipients === 1 ? '' : 's'}`,
        );
      } else {
        if (!cfg.resend) parts.push('Set RESEND_API_KEY on Vercel');
        if (!cfg.from) parts.push('Set CAPSIZE_NOTIFY_FROM on Vercel');
        if (!cfg.recipients) parts.push('Add at least one recipient');
      }
      meta.textContent = parts.join(' · ') || '—';
    }
    if (note) {
      if (cfg.persisted) {
        note.textContent = 'Recipients are saved in the CrewSight database (org-scoped).';
      } else {
        note.textContent =
          'No database connected — recipient list is memory-only until POSTGRES_URL is set.';
      }
    }
  }

  async function refresh() {
    try {
      const res = await fetch(`${apiBase()}/api/capsize-alerts`, { headers: headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
      renderList(data.emails);
      updateMeta(data);
      const input = document.getElementById('capsizeEmailNew');
      if (input && !input.value && data.seedDefault && !(data.emails || []).length) {
        input.value = data.seedDefault;
      }
      return data;
    } catch (err) {
      setStatus(err.message || 'Could not load capsize email settings', true);
      return null;
    }
  }

  async function addEmail(ev) {
    ev?.preventDefault?.();
    const input = document.getElementById('capsizeEmailNew');
    const email = input?.value.trim() || '';
    if (!email) {
      setStatus('Enter an email address.', true);
      return;
    }
    setStatus('Adding email…');
    try {
      const res = await fetch(`${apiBase()}/api/capsize-alerts?action=add-email`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Add failed (${res.status})`);
      if (input) input.value = '';
      renderList(data.emails);
      await refresh();
      setStatus(`Added ${email}.`);
    } catch (err) {
      setStatus(err.message || 'Could not add email', true);
    }
  }

  async function removeEmail(email) {
    setStatus('Removing email…');
    try {
      const res = await fetch(`${apiBase()}/api/capsize-alerts?action=remove-email`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Remove failed (${res.status})`);
      renderList(data.emails);
      await refresh();
      setStatus(`Removed ${email}.`);
    } catch (err) {
      setStatus(err.message || 'Could not remove email', true);
    }
  }

  async function sendTest() {
    setStatus('Sending test email…');
    try {
      const res = await fetch(`${apiBase()}/api/capsize-alerts?action=test`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Test send failed (${res.status})`);
      const to = Array.isArray(data.to) ? data.to.join(', ') : '';
      setStatus(`Test email sent to ${to || 'recipients'}.`);
    } catch (err) {
      setStatus(err.message || 'Could not send test email', true);
    }
  }

  function bind() {
    const form = document.getElementById('capsizeEmailAddForm');
    if (!form || form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    form.addEventListener('submit', (ev) => void addEmail(ev));
    document
      .getElementById('capsizeEmailTestBtn')
      ?.addEventListener('click', () => void sendTest());
    document
      .getElementById('capsizeEmailRefreshBtn')
      ?.addEventListener('click', () => void refresh());

    // Refresh when section opens or token may be ready.
    const panel = document.getElementById('capsizeEmailPanel');
    if (panel) {
      const observer = new MutationObserver(() => {
        const body = document.getElementById('section-body-capsize-emails');
        if (body && !body.hidden) void refresh();
      });
      observer.observe(panel, { attributes: true, subtree: true, attributeFilter: ['hidden', 'class'] });
    }

    // Initial load once dashboard token is typically available.
    setTimeout(() => void refresh(), 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
