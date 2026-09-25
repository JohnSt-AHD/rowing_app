import type { CoachSettings } from '../lib/settings';
import { fetchLogbook, type LogbookDay } from '../lib/api';
import { bindInfoToggles } from '../lib/info-toggle';

const TZ = 'Pacific/Auckland';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function formatDistance(meters: number): string {
  const m = Number(meters) || 0;
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  return `${Math.round(m)} m`;
}

function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

function formatDayLabel(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!match) return dateStr;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const anchor = new Date(Date.UTC(y, mo - 1, d, 12));
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(anchor);
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

function renderSessions(day: LogbookDay): string {
  if (!day.sessions?.length) {
    return '<p class="coach-logbook-empty">No crew sessions for this day.</p>';
  }
  const rows = day.sessions
    .map((s) => {
      const capsize = s.capsize
        ? '<span class="coach-logbook-capsize-yes">Yes</span>'
        : '<span class="coach-logbook-capsize-no">No</span>';
      return (
        `<tr>` +
        `<td class="coach-logbook-crew">${esc(s.crew || s.uniqueId)}</td>` +
        `<td>${esc(formatTime(s.startedAt))}</td>` +
        `<td>${esc(formatTime(s.endedAt))}</td>` +
        `<td>${capsize}</td>` +
        `<td>${esc(formatDistance(s.distanceM))}</td>` +
        `</tr>`
      );
    })
    .join('');
  return (
    `<div class="coach-logbook-table-wrap">` +
    `<table class="coach-logbook-table">` +
    `<thead><tr><th>Crew</th><th>Start</th><th>Finish</th><th>Capsize</th><th>Distance</th></tr></thead>` +
    `<tbody>${rows}</tbody>` +
    `</table></div>`
  );
}

function renderDay(day: LogbookDay, open: boolean): string {
  return (
    `<details class="coach-logbook-day" data-logbook-day="${esc(day.date)}" ${open ? 'open' : ''}>` +
    `<summary class="coach-logbook-day__summary">` +
    `<span class="coach-logbook-day__date">${esc(formatDayLabel(day.date))}</span>` +
    `<span class="coach-logbook-day__stats">` +
    `<span><strong>${day.sessionCount}</strong> crews</span>` +
    `<span class="${day.capsizeCount ? 'is-warn' : ''}"><strong>${day.capsizeCount}</strong> capsizes</span>` +
    `<span><strong>${esc(formatDistance(day.distanceM))}</strong></span>` +
    `<span><strong>${esc(formatDuration(day.onWaterMs))}</strong> on water</span>` +
    `</span>` +
    `</summary>` +
    `<div class="coach-logbook-day__body">${renderSessions(day)}</div>` +
    `</details>`
  );
}

export class LogbookPanel {
  private root: HTMLElement | null = null;
  private days: LogbookDay[] = [];
  private loading = false;
  private loaded = false;

  constructor(
    private getSettings: () => CoachSettings,
    private onStatus: (msg: string, err?: boolean) => void,
  ) {}

  mount(el: HTMLElement) {
    this.root = el;
    this.renderShell();
    if (!this.loaded && !this.loading) void this.reload();
    else this.renderDays();
  }

  prepareForRender(_tab: string) {
    /* no-op — keep cached days across re-renders */
  }

  async onTabShown() {
    if (!this.loaded) await this.reload();
  }

  private renderShell() {
    if (!this.root) return;
    this.root.innerHTML =
      `<div class="coach-logbook">` +
      `<div class="coach-logbook-heading">` +
      `<div class="coach-logbook-title-row">` +
      `<h2 class="coach-logbook-title">Logbook</h2>` +
      `<button type="button" class="info-btn" data-info-toggle aria-label="About Logbook" aria-expanded="false">i</button>` +
      `</div>` +
      `<p class="coach-logbook-lead info-help" hidden>Daily sessions by crew — distance and capsizes (NZ calendar day).</p>` +
      `</div>` +
      `<div class="coach-logbook-toolbar">` +
      `<button type="button" class="coach-btn coach-btn--ghost" data-logbook-refresh>Refresh</button>` +
      `</div>` +
      `<p class="poll-line" data-logbook-status hidden></p>` +
      `<div class="coach-logbook-list" data-logbook-list></div>` +
      `</div>`;
    bindInfoToggles(this.root);
    this.root.querySelector('[data-logbook-refresh]')?.addEventListener('click', () => {
      void this.reload(true);
    });
  }

  private openDayKeys(): Set<string> {
    if (!this.root) return new Set();
    return new Set(
      [...this.root.querySelectorAll<HTMLDetailsElement>('details.coach-logbook-day[open]')].map(
        (el) => el.dataset.logbookDay ?? '',
      ).filter(Boolean),
    );
  }

  private renderDays() {
    const list = this.root?.querySelector('[data-logbook-list]');
    if (!list) return;
    const open = this.openDayKeys();
    if (!this.days.length) {
      list.innerHTML = this.loading
        ? '<p class="coach-logbook-empty">Loading…</p>'
        : '<p class="coach-logbook-empty">No logbook days yet.</p>';
      return;
    }
    list.innerHTML = this.days
      .map((day, i) => renderDay(day, open.has(day.date) || (open.size === 0 && i === 0)))
      .join('');
  }

  async reload(force = false) {
    if (this.loading) return;
    if (this.loaded && !force) {
      this.renderDays();
      return;
    }
    const settings = this.getSettings();
    if (!settings.apiBaseUrl) {
      this.onStatus('Set API URL in Settings first', true);
      return;
    }
    this.loading = true;
    const status = this.root?.querySelector('[data-logbook-status]') as HTMLElement | null;
    if (status) {
      status.hidden = false;
      status.textContent = 'Loading logbook…';
    }
    this.renderDays();
    try {
      const data = await fetchLogbook(settings, 45, TZ);
      this.days = Array.isArray(data.days) ? data.days : [];
      this.loaded = true;
      if (status) {
        status.textContent = this.days.length
          ? `${this.days.length} day${this.days.length === 1 ? '' : 's'}`
          : 'No sessions in lookback';
        status.hidden = false;
      }
      this.onStatus('Logbook updated');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (status) {
        status.textContent = msg;
        status.hidden = false;
      }
      this.onStatus(msg, true);
    } finally {
      this.loading = false;
      this.renderDays();
    }
  }
}
