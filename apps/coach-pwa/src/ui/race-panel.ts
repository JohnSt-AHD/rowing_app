import L from 'leaflet';
import {
  fetchTimingLines,
  type MapPosition,
  type TimingLine,
} from '../lib/api';
import type { ParsedCourse } from '../lib/course-types';
import { drawPaceDistanceChart } from '../lib/course-chart';
import {
  formatClock,
  formatElapsed,
  formatSpeedDisplay,
} from '../lib/course-format';
import {
  avgSpeedInSegment,
  computeCourseStats,
  courseSegments,
  formatPaceCell,
  formatPrognosticForDevice,
} from '../lib/course-stats';
import {
  courseBounds,
  courseGroupsFromLines,
  crossingTimeForLine,
  effectiveAlong,
  markerLabelM,
  parseCourse,
} from '../lib/course-geo';
import { colorForDevice, CourseRaceEngine } from '../lib/course-race-engine';
import type { CoachSettings } from '../lib/settings';

const LS_COURSE = 'coach_race_course';
const LS_REVERSE = 'coach_race_reverse';
const LS_ROLLING = 'coach_race_rolling';

type StatusFn = (msg: string, err?: boolean) => void;

function esc(s: unknown) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

export class RacePanel {
  private root: HTMLElement | null = null;
  private engine = new CourseRaceEngine();
  private map: L.Map | null = null;
  private lineLayer: L.LayerGroup | null = null;
  private deviceLayer: L.LayerGroup | null = null;
  private deviceMarkers = new Map<string, L.Marker>();
  private orgSlug = '';
  private linesLoaded = false;
  private lastPositions: MapPosition[] = [];

  constructor(
    private getSettings: () => CoachSettings,
    private setStatus: StatusFn,
  ) {}

  static html = `
    <div class="race-panel">
      <div class="race-toolbar">
        <label class="race-field">
          <span class="race-field__label">Course</span>
          <select class="race-select" data-race-course aria-label="Timing course"></select>
        </label>
        <div class="race-toolbar__row">
          <label class="race-check"><input type="checkbox" data-race-reverse /> Reverse</label>
          <label class="race-check"><input type="checkbox" data-race-rolling checked /> Rolling start</label>
          <button type="button" class="coach-btn coach-btn--ghost" data-race-reset>Reset</button>
        </div>
      </div>
      <p class="race-meta" data-race-meta>Load timing lines using your ingest token.</p>
      <p class="poll-line" data-race-status>—</p>
      <div class="race-splits" data-race-splits></div>
      <div class="race-map-card">
        <h3 class="race-section-title">Course map</h3>
        <div class="race-map" data-race-map role="application" aria-label="Course map"></div>
      </div>
      <div class="race-chart-card">
        <h3 class="race-section-title">Pace vs distance</h3>
        <div class="race-chart-wrap">
          <canvas class="race-chart" data-race-chart height="160"></canvas>
        </div>
      </div>
    </div>`;

  prepareForRender(nextTab: string) {
    if (nextTab !== 'race') this.destroyMap();
  }

  mount(container: HTMLElement) {
    this.root = container;
    const needsDomSetup = !container.querySelector('.race-panel');
    if (needsDomSetup) {
      container.innerHTML = RacePanel.html;
      this.loadPrefs();
      this.bind();
      void this.reloadLines();
    }
  }

  onTabShown() {
    this.ensureMap();
    this.refreshView();
    setTimeout(() => this.map?.invalidateSize(), 150);
  }

  destroyMap() {
    this.deviceMarkers.clear();
    if (this.map) {
      this.map.remove();
      this.map = null;
      this.lineLayer = null;
      this.deviceLayer = null;
    }
  }

  processPositions(positions: MapPosition[], nowMs = Date.now()) {
    this.lastPositions = positions;
    if (!this.linesLoaded || !this.engine.selectedCourse) return;
    this.engine.processPoll(
      positions.map((p) => ({
        deviceId: p.deviceId,
        latitude: p.latitude,
        longitude: p.longitude,
        speed: p.speed,
        strokeRate: p.strokeRate,
        strokeRateValid: p.strokeRateValid,
        displayStrokeRate: p.displayStrokeRate,
        athleteId: p.athleteId,
        lastSeenAgoSec: p.lastSeenAgoSec,
        telemetryStale: p.telemetryStale,
        online: p.online,
      })),
      nowMs,
    );
    this.refreshView();
  }

  private bind() {
    if (!this.root) return;
    this.root.querySelector('[data-race-course]')?.addEventListener('change', (ev) => {
      const v = (ev.target as HTMLSelectElement).value;
      this.engine.setCourseGroup(v);
      localStorage.setItem(LS_COURSE, v);
      this.engine.resetSession();
      this.refreshView();
    });
    this.root.querySelector('[data-race-reverse]')?.addEventListener('change', (ev) => {
      this.engine.courseReversed = (ev.target as HTMLInputElement).checked;
      localStorage.setItem(LS_REVERSE, this.engine.courseReversed ? '1' : '0');
      this.engine.resetSession();
      this.refreshView();
    });
    this.root.querySelector('[data-race-rolling]')?.addEventListener('change', (ev) => {
      this.engine.rollingStartEnabled = (ev.target as HTMLInputElement).checked;
      localStorage.setItem(LS_ROLLING, this.engine.rollingStartEnabled ? '1' : '0');
    });
    this.root.querySelector('[data-race-reset]')?.addEventListener('click', () => {
      this.engine.resetSession();
      this.refreshView();
      this.setRaceStatus('Race timing reset.');
    });
    this.root.querySelector('[data-race-splits]')?.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('[data-hide-device]') as HTMLElement | null;
      if (!btn) return;
      const id = btn.getAttribute('data-hide-device');
      if (!id) return;
      this.engine.hideDevice(id);
      this.refreshView();
    });
  }

  private loadPrefs() {
    try {
      this.engine.courseReversed = localStorage.getItem(LS_REVERSE) === '1';
      this.engine.rollingStartEnabled = localStorage.getItem(LS_ROLLING) !== '0';
      this.engine.selectedCourse = localStorage.getItem(LS_COURSE) || '';
    } catch {
      /* ignore */
    }
    const rev = this.root?.querySelector('[data-race-reverse]') as HTMLInputElement | null;
    const roll = this.root?.querySelector('[data-race-rolling]') as HTMLInputElement | null;
    if (rev) rev.checked = this.engine.courseReversed;
    if (roll) roll.checked = this.engine.rollingStartEnabled;
  }

  async reloadLines() {
    const settings = this.getSettings();
    if (!settings.ingestToken) {
      this.setRaceMeta('Set ingest token in Settings to load timing lines.');
      this.populateCourseSelect([]);
      return;
    }
    try {
      const data = await fetchTimingLines(settings);
      this.orgSlug = data.org ?? '';
      const lines = (data.lines ?? []) as TimingLine[];
      this.engine.setLines(lines);
      this.linesLoaded = true;
      const groups = courseGroupsFromLines(lines);
      this.pickDefaultCourse(groups);
      this.populateCourseSelect(groups);
      const persisted = data.persisted ? '' : ' (memory only — lines may be empty without Postgres)';
      this.setRaceMeta(
        groups.length
          ? `Org ${this.orgSlug || '—'} · ${groups.length} course(s) · ${lines.length} line(s)${persisted}`
          : `Org ${this.orgSlug || '—'} · no timing lines yet${persisted}`,
      );
      this.refreshView();
    } catch (e) {
      this.linesLoaded = false;
      this.setRaceMeta(
        e instanceof Error ? e.message : 'Failed to load timing lines',
        true,
      );
    }
  }

  private pickDefaultCourse(groups: string[]) {
    if (!groups.length) {
      this.engine.selectedCourse = '';
      return;
    }
    const saved = localStorage.getItem(LS_COURSE) || '';
    if (saved && groups.includes(saved)) {
      this.engine.selectedCourse = saved;
      return;
    }
    const withStart = groups.find((g) => {
      const c = parseCourse(this.engine.lines, g);
      return c?.start?.lineType === 'start';
    });
    this.engine.selectedCourse = withStart ?? groups[0];
    localStorage.setItem(LS_COURSE, this.engine.selectedCourse);
  }

  private populateCourseSelect(groups: string[]) {
    const sel = this.root?.querySelector('[data-race-course]') as HTMLSelectElement | null;
    if (!sel) return;
    sel.innerHTML = groups.length
      ? groups
          .map(
            (g) =>
              `<option value="${esc(g)}"${g === this.engine.selectedCourse ? ' selected' : ''}>${esc(g)}</option>`,
          )
          .join('')
      : '<option value="">No courses for this token</option>';
  }

  private setRaceMeta(msg: string, err = false) {
    const el = this.root?.querySelector('[data-race-meta]');
    if (el) {
      el.textContent = msg;
      el.classList.toggle('poll-line--warn', err);
    }
  }

  private setRaceStatus(msg: string, err = false) {
    const el = this.root?.querySelector('[data-race-status]');
    if (el) {
      el.textContent = msg;
      el.classList.toggle('err', err);
    }
  }

  private syncCourseSelect() {
    const sel = this.root?.querySelector('[data-race-course]') as HTMLSelectElement | null;
    if (!sel || !this.engine.selectedCourse) return;
    if (sel.value !== this.engine.selectedCourse) {
      sel.value = this.engine.selectedCourse;
    }
  }

  private refreshView() {
    this.syncCourseSelect();
    const course = this.engine.getCourse();
    if (!course) {
      this.renderSplits(null);
      this.setRaceStatus('Select a course with start/finish lines.');
      return;
    }
    this.ensureMap(course);
    this.updateMapDevices(course);
    this.renderSplits(course);
    const canvas = this.root?.querySelector('[data-race-chart]') as HTMLCanvasElement | null;
    if (canvas) drawPaceDistanceChart(canvas, this.engine, course);
    const n = this.engine.visibleDeviceIdsByProg().length;
    this.setRaceStatus(
      `${course.group} · ${Math.round(course.totalDist)} m · ${n} boat${n === 1 ? '' : 's'} on course` +
        (this.engine.courseReversed ? ' · reverse' : '') +
        (this.engine.rollingStartEnabled ? ' · rolling start' : ''),
    );
  }

  private renderSplits(course: ParsedCourse | null) {
    const el = this.root?.querySelector('[data-race-splits]');
    if (!el) return;
    if (!course) {
      el.innerHTML = '<p class="poll-line">No course selected.</p>';
      return;
    }
    const segments = courseSegments(course, this.engine.courseReversed);
    const deviceIds = this.engine.visibleDeviceIdsByProg(
      this.lastPositions.map((p) => p.deviceId),
    );
    if (!deviceIds.length) {
      el.innerHTML = '<p class="poll-line">Waiting for devices on course…</p>';
      return;
    }
    el.innerHTML = deviceIds
      .map((deviceId) => {
        const crossed = this.engine.getCrossings(deviceId);
        const live = this.engine.getLive(deviceId);
        const trace = this.engine.getTrace(deviceId);
        const stats = computeCourseStats(trace, course, deviceId, live?.athleteId);
        const finished = this.engine.hasFinishedCourse(deviceId, course);
        const pos = this.lastPositions.find((p) => p.deviceId === deviceId);
        const displayName =
          String(live?.athleteId ?? pos?.athleteId ?? deviceId).trim() || deviceId;
        const rolling = this.engine.getRollingStart(deviceId);
        const tStart = this.engine.getEffectiveStartMs(deviceId, course);
        const startLabel = tStart
          ? rolling?.confirmed
            ? `${formatClock(tStart)} ↺`
            : formatClock(tStart)
          : this.engine.usesRollingStartGate(deviceId, live?.athleteId)
            ? '↺ pending'
            : '—';
        const splitsHtml = segments
          .map((seg) => {
            const label = markerLabelM(seg.line, course, this.engine.courseReversed);
            const t = crossingTimeForLine(crossed, seg.line, course);
            if (t == null || tStart == null) {
              return `<div class="race-split-cell"><dt>${esc(label)}</dt><dd>—</dd></div>`;
            }
            const elapsed = formatElapsed(t - tStart);
            const segSpeed = avgSpeedInSegment(trace, seg.from, seg.to);
            const segProg = formatPrognosticForDevice(
              segSpeed,
              deviceId,
              live?.athleteId,
            );
            const val = segProg ? `${elapsed} · ${segProg}` : elapsed;
            return `<div class="race-split-cell"><dt>${esc(label)}</dt><dd>${esc(val)}</dd></div>`;
          })
          .join('');
        let pace: string;
        if (finished) {
          pace =
            stats.avgMps != null
              ? formatPaceCell(stats.avgMps, deviceId, live?.athleteId)
              : '—';
        } else if (live?.stale && live.lastSeenAgoSec != null) {
          pace = `Stale ${live.lastSeenAgoSec}s`;
        } else {
          pace = formatSpeedDisplay(live?.speedMps, deviceId, live?.athleteId);
        }
        let spm = '—';
        if (finished) {
          spm =
            stats.avgSpm != null && stats.avgSpm > 0
              ? `${Math.round(stats.avgSpm)} spm`
              : '—';
        } else if (!live?.stale && live?.strokeRate != null && live.strokeRate > 0) {
          spm = `${Math.round(live.strokeRate)} spm`;
        }
        return `<article class="race-boat-card">
          <header class="race-boat-card__head">
            <span class="race-boat-card__dot" style="background:${colorForDevice(deviceId)}"></span>
            <strong class="race-boat-card__name">${esc(displayName)}</strong>
            <button type="button" class="race-boat-card__hide" data-hide-device="${esc(deviceId)}">Hide</button>
          </header>
          <dl class="race-boat-card__stats">
            <div><dt>Start</dt><dd>${esc(startLabel)}</dd></div>
            <div><dt>Pace</dt><dd>${esc(pace)}</dd></div>
            <div><dt>Rate</dt><dd>${esc(spm)}</dd></div>
          </dl>
          <dl class="race-boat-card__splits">${splitsHtml}</dl>
        </article>`;
      })
      .join('');
  }

  private ensureMap(course?: ParsedCourse) {
    const el = this.root?.querySelector('[data-race-map]') as HTMLElement | null;
    if (!el || typeof L === 'undefined') return;
    const c = course ?? this.engine.getCourse();
    if (!c) return;

    if (!this.map) {
      this.map = L.map(el, { zoomControl: true, attributionControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap',
      }).addTo(this.map);
      this.lineLayer = L.layerGroup().addTo(this.map);
      this.deviceLayer = L.layerGroup().addTo(this.map);
    }

    this.lineLayer?.clearLayers();
    for (const line of c.lines) {
      const style =
        line.lineType === 'start'
          ? { color: '#22c55e', weight: 3 }
          : line.lineType === 'finish'
            ? { color: '#ef4444', weight: 3 }
            : { color: '#3b82f6', weight: 2, dashArray: '8 6' };
      const label =
        line.distanceM != null
          ? `${line.name} (${markerLabelM(line, c, this.engine.courseReversed)})`
          : line.name;
      L.polyline(
        [
          [line.lat1, line.lon1],
          [line.lat2, line.lon2],
        ],
        style,
      )
        .bindTooltip(label, { sticky: true })
        .addTo(this.lineLayer!);
    }

    const bounds = courseBounds(c);
    if (bounds.length) {
      this.map.fitBounds(bounds, { padding: [20, 20] });
    }
  }

  private updateMapDevices(course: ParsedCourse) {
    if (!this.map || !this.deviceLayer) return;
    const seen = new Set<string>();
    for (const p of this.lastPositions) {
      const id = p.deviceId;
      if (!id || this.engine.hiddenDevices.has(id)) continue;
      if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
      const along = effectiveAlong(
        p.latitude,
        p.longitude,
        course,
        this.engine.courseReversed,
      );
      if (along == null || along < -80 || along > course.totalDist + 120) continue;
      seen.add(id);
      const color = colorForDevice(id);
      let marker = this.deviceMarkers.get(id);
      const icon = L.divIcon({
        className: 'race-device-marker',
        html: `<span style="background:${color}"></span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      if (marker) {
        marker.setLatLng([p.latitude, p.longitude]);
        marker.setIcon(icon);
      } else {
        marker = L.marker([p.latitude, p.longitude], { icon }).bindTooltip(id, {
          direction: 'top',
          offset: [0, -8],
        });
        this.deviceLayer.addLayer(marker);
        this.deviceMarkers.set(id, marker);
      }
    }
    for (const [id, marker] of this.deviceMarkers) {
      if (!seen.has(id)) {
        this.deviceLayer.removeLayer(marker);
        this.deviceMarkers.delete(id);
      }
    }
  }
}
