import type { CoachSettings } from '../lib/settings';
import { bindInfoToggles } from '../lib/info-toggle';
import {
  assignWorkout,
  clearAssignment,
  fetchAssignment,
  syncWorkoutLibrary,
  uploadWorkoutLibrary,
} from '../lib/workout-api';
import {
  defaultStartClock,
  deleteSavedWorkout,
  formatClock,
  formatNzClock,
  formatRemainDistance,
  loadActiveWorkout,
  loadWorkoutLibrary,
  normalizeWorkout,
  nzClockToUtcMs,
  upsertSavedWorkout,
  workoutSummary,
  type SavedWorkout,
  type WorkoutAssignment,
  type WorkoutPieceResult,
  type WorkoutProgress,
} from '../lib/workouts';

export type WorkoutBoat = {
  deviceId: string;
  name: string;
  athleteId?: string | null;
  coach?: string | null;
  boatClass?: string | null;
  onWater: boolean;
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function phaseLabel(phase: string): string {
  if (phase === 'countdown') return 'Countdown';
  if (phase === 'waiting') return 'Waiting';
  if (phase === 'work') return 'Work';
  if (phase === 'rest') return 'Rest';
  if (phase === 'done') return 'Done';
  return phase || '—';
}

function splitToSec(text: string): number | null {
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(String(text || '').trim());
  if (!m) return null;
  const sec = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(sec) ? sec : null;
}

function pieceWorkLine(p: WorkoutPieceResult): string {
  const time = formatClock(p.workSec);
  const dist = formatRemainDistance(p.workM);
  if (p.workM >= 50 && p.workSec >= 1) return `${time} · ${dist}`;
  if (p.workM >= 50) return dist;
  return time;
}

export class WorkoutPanel {
  private root: HTMLElement | null = null;
  private draft: SavedWorkout = loadActiveWorkout();
  private startClock = defaultStartClock();
  private boats: WorkoutBoat[] = [];
  private selectedIds = new Set<string>();
  private selectionTouched = false;
  private assignment: WorkoutAssignment | null = null;
  private view: 'setup' | 'live' = 'setup';
  private viewTouched = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private getSettings: () => CoachSettings,
    private onStatus: (msg: string, err?: boolean) => void,
  ) {}

  mount(el: HTMLElement) {
    const reuse = this.root === el && el.querySelector('[data-wo-root]');
    this.root = el;
    if (!reuse) {
      this.renderShell();
      this.bind();
    }
    this.syncForm();
    this.refreshBoats();
    this.refreshMonitor();
    this.refreshClock();
    this.startTimers();
    void this.reloadAssignment();
  }

  prepareForRender(_tab: string) {
    /* keep draft + selection across app re-renders */
  }

  onTabShown() {
    this.startTimers();
    void syncWorkoutLibrary(this.getSettings()).then(() => this.fillRecall());
    void this.reloadAssignment();
  }

  setBoats(boats: WorkoutBoat[]) {
    this.boats = boats;
    if (!this.selectionTouched) this.applyDefaultSelection();
    this.refreshBoats();
    this.refreshMonitor();
  }

  private coachName(): string {
    return this.getSettings().coachName.trim() || 'Coach';
  }

  private applyDefaultSelection() {
    const mine = this.coachName().toLowerCase();
    const mineIds = this.boats
      .filter((b) => String(b.coach || '').trim().toLowerCase() === mine)
      .map((b) => b.deviceId);
    if (mineIds.length) {
      this.selectedIds = new Set(mineIds);
      return;
    }
    this.selectedIds = new Set(this.boats.filter((b) => b.onWater).map((b) => b.deviceId));
  }

  private startTimers() {
    this.stopTimers();
    this.clockTimer = setInterval(() => this.refreshClock(), 1000);
    this.pollTimer = setInterval(() => {
      if (!this.root?.isConnected) {
        this.stopTimers();
        return;
      }
      void this.reloadAssignment();
    }, 2000);
  }

  private stopTimers() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.pollTimer = null;
    this.clockTimer = null;
  }

  private renderShell() {
    if (!this.root) return;
    this.root.innerHTML = `
      <div class="coach-workout" data-wo-root>
        <div class="coach-logbook-heading">
          <div class="coach-logbook-title-row">
            <h2 class="coach-logbook-title">Workout</h2>
            <button type="button" class="info-btn" data-info-toggle aria-label="About Workout" aria-expanded="false">i</button>
          </div>
          <p class="coach-logbook-lead info-help" hidden>
            Setup: compose a piece and send it with a shared New Zealand start time.
            Live: watch each boat through the current piece and compare completed piece results.
          </p>
        </div>
        <div class="coach-workout__toolbar">
          <div class="coach-scope-toggle" role="group" aria-label="Workout view">
            <button type="button" class="coach-scope-toggle__btn" data-wo-view="setup">Setup</button>
            <button type="button" class="coach-scope-toggle__btn" data-wo-view="live">Live</button>
          </div>
          <p class="coach-workout__clock">NZ now <strong data-wo-nz-now>—</strong></p>
        </div>
        <p class="poll-line" data-wo-status hidden></p>

        <div data-wo-panel="setup">
        <section class="coach-workout__card">
          <h3 class="coach-workout__h">Compose</h3>
          <label class="coach-workout__field">Saved
            <select data-wo-recall></select>
          </label>
          <label class="coach-workout__field">Name
            <input data-wo-name maxlength="40" />
          </label>
          <fieldset class="coach-workout__fieldset">
            <legend>Type</legend>
            <label><input type="radio" name="wo-kind" value="single" data-wo-kind /> Piece</label>
            <label><input type="radio" name="wo-kind" value="interval" data-wo-kind /> Intervals</label>
          </fieldset>
          <fieldset class="coach-workout__fieldset" data-wo-single>
            <legend>Piece</legend>
            <label><input type="radio" name="wo-unit" value="time" data-wo-unit /> Time (min)</label>
            <label><input type="radio" name="wo-unit" value="distance" data-wo-unit /> Distance (m)</label>
            <label class="coach-workout__field">Target <input data-wo-target type="number" min="1" step="1" /></label>
          </fieldset>
          <fieldset class="coach-workout__fieldset" data-wo-interval>
            <legend>Intervals</legend>
            <label><input type="radio" name="wo-work-unit" value="time" data-wo-work-unit /> Work time (min)</label>
            <label><input type="radio" name="wo-work-unit" value="distance" data-wo-work-unit /> Work distance (m)</label>
            <label class="coach-workout__field">Work <input data-wo-work type="number" min="1" step="0.1" /></label>
            <label class="coach-workout__field">Rest (s) <input data-wo-rest type="number" min="0" step="1" /></label>
            <label class="coach-workout__field">Repeats <input data-wo-repeats type="number" min="1" max="40" /></label>
          </fieldset>
          <div class="coach-workout__actions">
            <button type="button" class="coach-btn coach-btn--ghost" data-wo-save>Save</button>
            <button type="button" class="coach-btn coach-btn--ghost" data-wo-upload>Upload library</button>
            <button type="button" class="coach-btn coach-btn--ghost" data-wo-delete>Delete</button>
          </div>
        </section>

        <section class="coach-workout__card">
          <h3 class="coach-workout__h">Start time (NZ)</h3>
          <p class="coach-workout__hint">Same wall-clock on every phone. Default is two minutes from now.</p>
          <div class="coach-workout__clock-row">
            <input data-wo-start-clock type="text" inputmode="numeric" placeholder="HH:MM:SS" maxlength="8" />
            <button type="button" class="coach-btn coach-btn--ghost" data-wo-clock-plus>Now + 2 min</button>
          </div>
        </section>

        <section class="coach-workout__card">
          <h3 class="coach-workout__h">Send to boats</h3>
          <div class="coach-workout__select-row">
            <button type="button" class="coach-btn coach-btn--ghost" data-wo-sel="mine">My crews</button>
            <button type="button" class="coach-btn coach-btn--ghost" data-wo-sel="water">On water</button>
            <button type="button" class="coach-btn coach-btn--ghost" data-wo-sel="all">All</button>
            <button type="button" class="coach-btn coach-btn--ghost" data-wo-sel="none">None</button>
          </div>
          <ul class="coach-workout__boats" data-wo-boats></ul>
          <div class="coach-workout__actions">
            <button type="button" class="coach-btn coach-btn--primary" data-wo-send>Send workout</button>
            <button type="button" class="coach-btn coach-btn--ghost" data-wo-clear>Clear</button>
          </div>
        </section>
        </div>

        <div data-wo-panel="live" hidden>
        <section class="coach-workout__card coach-workout__card--live">
          <h3 class="coach-workout__h">Now</h3>
          <p class="coach-workout__live-meta" data-wo-live-meta>No workout sent yet.</p>
          <div class="coach-workout__live" data-wo-live></div>
        </section>
        <section class="coach-workout__card">
          <h3 class="coach-workout__h">Completed pieces</h3>
          <p class="coach-workout__hint">Each finished work interval across boats. Fastest /500 m on a piece is highlighted.</p>
          <div class="coach-workout__results" data-wo-results></div>
        </section>
        <div class="coach-workout__actions">
          <button type="button" class="coach-btn coach-btn--ghost" data-wo-clear-live>Clear workout</button>
        </div>
        </div>
      </div>
    `;
    bindInfoToggles(this.root);
    this.applyView();
  }

  private bind() {
    if (!this.root) return;
    this.root.querySelector('[data-wo-recall]')?.addEventListener('change', (ev) => {
      const id = (ev.target as HTMLSelectElement).value;
      const next = loadWorkoutLibrary().find((w) => w.id === id);
      if (!next) return;
      this.draft = { ...next, startMode: 'clock' };
      this.syncForm();
    });
    this.root.querySelectorAll('[data-wo-kind]').forEach((el) => {
      el.addEventListener('change', () => {
        this.readForm();
        this.toggleKind();
      });
    });
    this.root.querySelector('[data-wo-save]')?.addEventListener('click', () => this.onSave());
    this.root.querySelector('[data-wo-upload]')?.addEventListener('click', () => void this.onUpload());
    this.root.querySelector('[data-wo-delete]')?.addEventListener('click', () => this.onDelete());
    this.root.querySelector('[data-wo-clock-plus]')?.addEventListener('click', () => {
      this.startClock = defaultStartClock();
      const input = this.root?.querySelector('[data-wo-start-clock]') as HTMLInputElement | null;
      if (input) input.value = this.startClock;
    });
    this.root.querySelectorAll('[data-wo-sel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = (btn as HTMLElement).dataset.woSel;
        this.selectionTouched = true;
        const mine = this.coachName().toLowerCase();
        if (mode === 'none') this.selectedIds.clear();
        else if (mode === 'all') this.selectedIds = new Set(this.boats.map((b) => b.deviceId));
        else if (mode === 'water') {
          this.selectedIds = new Set(this.boats.filter((b) => b.onWater).map((b) => b.deviceId));
        } else {
          this.selectedIds = new Set(
            this.boats
              .filter((b) => String(b.coach || '').trim().toLowerCase() === mine)
              .map((b) => b.deviceId),
          );
        }
        this.refreshBoats();
      });
    });
    this.root.querySelector('[data-wo-send]')?.addEventListener('click', () => void this.onSend());
    this.root.querySelectorAll('[data-wo-clear], [data-wo-clear-live]').forEach((btn) => {
      btn.addEventListener('click', () => void this.onClear());
    });
    this.root.querySelectorAll('[data-wo-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = (btn as HTMLElement).dataset.woView === 'live' ? 'live' : 'setup';
        this.viewTouched = true;
        this.setView(next);
      });
    });
  }

  private setView(view: 'setup' | 'live') {
    this.view = view;
    this.applyView();
    if (view === 'live') this.refreshMonitor();
  }

  private applyView() {
    if (!this.root) return;
    this.root.querySelectorAll<HTMLElement>('[data-wo-panel]').forEach((el) => {
      el.hidden = el.dataset.woPanel !== this.view;
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-wo-view]').forEach((btn) => {
      const on = btn.dataset.woView === this.view;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  private fillRecall() {
    const sel = this.root?.querySelector('[data-wo-recall]') as HTMLSelectElement | null;
    if (!sel) return;
    const lib = loadWorkoutLibrary();
    sel.innerHTML = lib
      .map(
        (w) =>
          `<option value="${esc(w.id)}"${w.id === this.draft.id ? ' selected' : ''}>${esc(w.name)} · ${esc(workoutSummary(w))}</option>`,
      )
      .join('');
  }

  private syncForm() {
    if (!this.root) return;
    this.fillRecall();
    const name = this.root.querySelector('[data-wo-name]') as HTMLInputElement | null;
    if (name) name.value = this.draft.name;
    this.root.querySelectorAll<HTMLInputElement>('[data-wo-kind]').forEach((el) => {
      el.checked = el.value === this.draft.kind;
    });
    this.root.querySelectorAll<HTMLInputElement>('[data-wo-unit]').forEach((el) => {
      el.checked = el.value === this.draft.unit;
    });
    this.root.querySelectorAll<HTMLInputElement>('[data-wo-work-unit]').forEach((el) => {
      el.checked = el.value === this.draft.workUnit;
    });
    const target = this.root.querySelector('[data-wo-target]') as HTMLInputElement | null;
    if (target) {
      target.value = String(
        this.draft.unit === 'time' ? Math.round(this.draft.target / 60) || 1 : this.draft.target,
      );
    }
    const work = this.root.querySelector('[data-wo-work]') as HTMLInputElement | null;
    if (work) {
      work.value = String(
        this.draft.workUnit === 'time'
          ? this.draft.workValue / 60
          : this.draft.workValue,
      );
    }
    const rest = this.root.querySelector('[data-wo-rest]') as HTMLInputElement | null;
    if (rest) rest.value = String(this.draft.restSec);
    const repeats = this.root.querySelector('[data-wo-repeats]') as HTMLInputElement | null;
    if (repeats) repeats.value = String(this.draft.repeats);
    const clock = this.root.querySelector('[data-wo-start-clock]') as HTMLInputElement | null;
    if (clock) clock.value = this.startClock;
    this.toggleKind();
  }

  private toggleKind() {
    const kind =
      (this.root?.querySelector('[data-wo-kind]:checked') as HTMLInputElement | null)?.value ||
      this.draft.kind;
    const single = this.root?.querySelector('[data-wo-single]') as HTMLElement | null;
    const interval = this.root?.querySelector('[data-wo-interval]') as HTMLElement | null;
    if (single) single.hidden = kind === 'interval';
    if (interval) interval.hidden = kind !== 'interval';
  }

  private readForm(): SavedWorkout | null {
    if (!this.root) return null;
    const kind =
      (this.root.querySelector('[data-wo-kind]:checked') as HTMLInputElement | null)?.value ===
      'interval'
        ? 'interval'
        : 'single';
    const unit =
      (this.root.querySelector('[data-wo-unit]:checked') as HTMLInputElement | null)?.value ===
      'distance'
        ? 'distance'
        : 'time';
    const workUnit =
      (this.root.querySelector('[data-wo-work-unit]:checked') as HTMLInputElement | null)?.value ===
      'distance'
        ? 'distance'
        : 'time';
    const name = (this.root.querySelector('[data-wo-name]') as HTMLInputElement | null)?.value || '';
    const targetRaw = Number(
      (this.root.querySelector('[data-wo-target]') as HTMLInputElement | null)?.value,
    );
    const workRaw = Number(
      (this.root.querySelector('[data-wo-work]') as HTMLInputElement | null)?.value,
    );
    const restSec = Number(
      (this.root.querySelector('[data-wo-rest]') as HTMLInputElement | null)?.value,
    );
    const repeats = Number(
      (this.root.querySelector('[data-wo-repeats]') as HTMLInputElement | null)?.value,
    );
    const clock =
      (this.root.querySelector('[data-wo-start-clock]') as HTMLInputElement | null)?.value ||
      this.startClock;
    this.startClock = clock.trim() || defaultStartClock();
    const next = normalizeWorkout({
      ...this.draft,
      name,
      kind,
      unit,
      target: unit === 'time' ? targetRaw * 60 : targetRaw,
      workUnit,
      workValue: workUnit === 'time' ? workRaw * 60 : workRaw,
      restSec,
      repeats,
      startMode: 'clock',
    });
    if (next) this.draft = next;
    return next;
  }

  private setLine(msg: string, err = false) {
    const el = this.root?.querySelector('[data-wo-status]') as HTMLElement | null;
    if (el) {
      el.hidden = !msg;
      el.textContent = msg;
      el.classList.toggle('is-error', err);
    }
    if (msg) this.onStatus(msg, err);
  }

  private onSave() {
    const w = this.readForm();
    if (!w) return;
    upsertSavedWorkout(w);
    this.fillRecall();
    this.setLine(`Saved ${w.name}`);
  }

  private async onUpload() {
    const w = this.readForm();
    if (w) upsertSavedWorkout(w);
    try {
      await uploadWorkoutLibrary(this.getSettings(), loadWorkoutLibrary());
      this.fillRecall();
      this.setLine('Library uploaded');
    } catch (e) {
      this.setLine(e instanceof Error ? e.message : String(e), true);
    }
  }

  private onDelete() {
    const id = this.draft.id;
    const next = deleteSavedWorkout(id);
    this.draft = next[0] || loadActiveWorkout();
    this.syncForm();
    this.setLine('Deleted from this tablet');
  }

  private async onSend() {
    if (this.busy) return;
    const w = this.readForm();
    if (!w) return;
    const deviceIds = [...this.selectedIds];
    if (!deviceIds.length) {
      this.setLine('Select at least one boat', true);
      return;
    }
    const startAtMs = nzClockToUtcMs(this.startClock);
    this.busy = true;
    try {
      upsertSavedWorkout(w);
      this.assignment = await assignWorkout(this.getSettings(), {
        workout: { ...w, startMode: 'clock' },
        deviceIds,
        startClock: this.startClock,
        startAtMs,
        coachName: this.coachName(),
      });
      this.viewTouched = true;
      this.setView('live');
      this.setLine(
        `Sent ${w.name} to ${deviceIds.length} boat${deviceIds.length === 1 ? '' : 's'} · start ${this.startClock} NZ`,
      );
    } catch (e) {
      this.setLine(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.busy = false;
    }
  }

  private async onClear() {
    try {
      await clearAssignment(this.getSettings());
      this.assignment = null;
      this.refreshMonitor();
      this.setLine('Workout cleared');
    } catch (e) {
      this.setLine(e instanceof Error ? e.message : String(e), true);
    }
  }

  private async reloadAssignment() {
    try {
      const next = await fetchAssignment(this.getSettings());
      this.assignment = next;
      if (!this.viewTouched && next) this.setView('live');
      else this.refreshMonitor();
    } catch {
      /* keep last */
    }
  }

  private refreshClock() {
    const el = this.root?.querySelector('[data-wo-nz-now]');
    if (el) el.textContent = formatNzClock();
  }

  private refreshBoats() {
    const list = this.root?.querySelector('[data-wo-boats]');
    if (!list) return;
    if (!this.boats.length) {
      list.innerHTML = '<li class="coach-workout__empty">No athlete boats on this token yet.</li>';
      return;
    }
    list.innerHTML = this.boats
      .map((b) => {
        const checked = this.selectedIds.has(b.deviceId) ? 'checked' : '';
        const water = b.onWater ? 'On water' : 'Ashore';
        const who = [b.athleteId, b.coach ? `coach ${b.coach}` : '']
          .filter(Boolean)
          .join(' · ');
        return (
          `<li>` +
          `<label class="coach-workout__boat">` +
          `<input type="checkbox" data-wo-boat="${esc(b.deviceId)}" ${checked} />` +
          `<span>` +
          `<strong>${esc(b.name || b.deviceId)}</strong>` +
          `<small>${esc(who || b.boatClass || 'Boat')} · ${water}</small>` +
          `</span>` +
          `</label>` +
          `</li>`
        );
      })
      .join('');
    list.querySelectorAll<HTMLInputElement>('[data-wo-boat]').forEach((box) => {
      box.addEventListener('change', () => {
        this.selectionTouched = true;
        const id = box.dataset.woBoat || '';
        if (!id) return;
        if (box.checked) this.selectedIds.add(id);
        else this.selectedIds.delete(id);
      });
    });
  }

  private progressFor(id: string): WorkoutProgress | null {
    return this.assignment?.progress?.[id] || null;
  }

  private refreshMonitor() {
    const meta = this.root?.querySelector('[data-wo-live-meta]');
    const live = this.root?.querySelector('[data-wo-live]');
    if (!meta || !live) return;
    const asg = this.assignment;
    if (!asg) {
      meta.textContent = 'No workout sent yet.';
      live.innerHTML =
        '<p class="coach-workout__empty">Send a workout from Setup to watch boats here.</p>';
      this.refreshResults([]);
      return;
    }
    const ids = asg.deviceIds.length
      ? asg.deviceIds
      : Object.keys(asg.progress || {});
    const remain = Math.max(0, Math.round((asg.startAtMs - Date.now()) / 1000));
    const startLine =
      remain > 0
        ? `starts in ${esc(asg.startClock || formatNzClock(asg.startAtMs))} (${remain}s)`
        : `started ${esc(asg.startClock || '')} NZ`;
    meta.textContent = `${asg.workout.name} · ${workoutSummary(asg.workout)} · ${startLine} · ${asg.coachName}`;
    live.innerHTML = ids
      .map((id) => {
        const boat = this.boats.find((b) => b.deviceId === id);
        const p = this.progressFor(id);
        const title = boat?.name || p?.name || id;
        const phase = phaseLabel(p?.phase || (Date.now() < asg.startAtMs ? 'countdown' : 'work'));
        const remainText = p?.remainText || (Date.now() < asg.startAtMs ? '—' : 'Waiting…');
        const remainLabel = p?.remainLabel || 'Time to go';
        const interval = p?.intervalText || workoutSummary(asg.workout);
        const stale =
          p && Date.now() - p.updatedAt > 12_000 ? '<em class="coach-workout__stale">stale</em>' : '';
        return (
          `<article class="coach-workout__boat-card" data-phase="${esc(p?.phase || '')}">` +
          `<header>` +
          `<strong>${esc(title)}</strong>` +
          `<span class="coach-workout__phase">${esc(phase)}</span>` +
          `</header>` +
          `<p class="coach-workout__interval">${esc(interval)} ${stale}</p>` +
          `<p class="coach-workout__remain"><span>${esc(remainText)}</span><small>${esc(remainLabel)}</small></p>` +
          `<dl>` +
          `<div><dt>Speed</dt><dd>${esc(p?.liveSplit || '—')} <small>${esc(p?.liveProg || '')}</small></dd></div>` +
          `<div><dt>Piece avg</dt><dd>${esc(p?.avgSplit || '—')} <small>${esc(p?.avgProg || '')}</small></dd></div>` +
          `<div><dt>HR</dt><dd>${esc(p?.hrText || '—')}</dd></div>` +
          `</dl>` +
          `</article>`
        );
      })
      .join('');
    this.refreshResults(ids);
  }

  private refreshResults(ids: string[]) {
    const host = this.root?.querySelector('[data-wo-results]');
    if (!host) return;
    const asg = this.assignment;
    if (!asg || !ids.length) {
      host.innerHTML = '<p class="coach-workout__empty">No completed pieces yet.</p>';
      return;
    }
    const rows = Math.max(0, ...ids.map((id) => this.progressFor(id)?.pieces?.length || 0));
    if (rows <= 0) {
      host.innerHTML = '<p class="coach-workout__empty">No completed pieces yet — they appear here as each work interval finishes.</p>';
      return;
    }
    const labels = ids.map((id) => {
      const boat = this.boats.find((b) => b.deviceId === id);
      return boat?.name || this.progressFor(id)?.name || id;
    });
    const head =
      `<thead><tr><th scope="col">Piece</th>` +
      labels.map((name) => `<th scope="col">${esc(name)}</th>`).join('') +
      `</tr></thead>`;
    const body = Array.from({ length: rows }, (_, i) => {
      const index = i + 1;
      const cells = ids.map((id) => {
        const piece = (this.progressFor(id)?.pieces || []).find((p) => p.index === index);
        return { id, piece };
      });
      let best = Infinity;
      for (const cell of cells) {
        const sec = cell.piece ? splitToSec(cell.piece.avgSplit) : null;
        if (sec != null && sec < best) best = sec;
      }
      const tds = cells
        .map(({ piece }) => {
          if (!piece) return '<td class="coach-workout__cell--empty">—</td>';
          const sec = splitToSec(piece.avgSplit);
          const bestCls = sec != null && sec === best ? ' is-best' : '';
          return (
            `<td class="coach-workout__cell${bestCls}">` +
            `<strong>${esc(piece.avgSplit)}</strong>` +
            `<small>${esc(piece.avgProg)} · ${esc(piece.hrText)}</small>` +
            `<small>${esc(pieceWorkLine(piece))}</small>` +
            `</td>`
          );
        })
        .join('');
      const label = asg.workout.kind === 'interval' ? `Work ${index}` : 'Piece';
      return `<tr><th scope="row">${esc(label)}</th>${tds}</tr>`;
    }).join('');
    host.innerHTML = `<div class="coach-workout__table-wrap"><table class="coach-workout__table">${head}<tbody>${body}</tbody></table></div>`;
  }
}
