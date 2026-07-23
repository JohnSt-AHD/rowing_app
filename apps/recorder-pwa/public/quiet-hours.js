/**
 * Overnight monitoring pause — 6pm–6am Pacific/Auckland.
 * Live polls stop; banner: "Monitoring paused overnight".
 */
(function (global) {
  const TIMEZONE = 'Pacific/Auckland';
  /** Inclusive start hour (24h): 18 = 6pm */
  const PAUSE_START_HOUR = 18;
  /** Exclusive end hour (24h): 6 = 6am */
  const PAUSE_END_HOUR = 6;
  const MESSAGE = 'Monitoring paused overnight';
  const CHECK_MS = 30000;

  function hourInTz(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-NZ', {
      timeZone: TIMEZONE,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    const raw = Number(parts.find((p) => p.type === 'hour')?.value);
    if (!Number.isFinite(raw)) return date.getHours();
    return raw === 24 ? 0 : raw;
  }

  function isQuietHours(date = new Date()) {
    const h = hourInTz(date);
    return h >= PAUSE_START_HOUR || h < PAUSE_END_HOUR;
  }

  /**
   * @param {(paused: boolean) => void} callback
   * @returns {() => void} unsubscribe
   */
  function onQuietHoursChange(callback) {
    if (typeof callback !== 'function') return () => {};
    let last = isQuietHours();
    callback(last);
    const id = setInterval(() => {
      const now = isQuietHours();
      if (now !== last) {
        last = now;
        callback(now);
      }
    }, CHECK_MS);
    return () => clearInterval(id);
  }

  /**
   * Show/hide a banner element. Creates one if id is missing and parent is set.
   * @param {string|HTMLElement|null} target
   * @param {{ parent?: HTMLElement|null, insertBefore?: HTMLElement|null }} [opts]
   */
  function setBannerVisible(target, paused, opts = {}) {
    let el =
      typeof target === 'string' ? document.getElementById(target) : target;
    if (!el && paused && opts.parent) {
      el = document.createElement('div');
      el.id = typeof target === 'string' ? target : 'quietHoursBanner';
      el.className = 'quiet-hours-banner';
      el.setAttribute('role', 'status');
      el.textContent = MESSAGE;
      if (opts.insertBefore && opts.insertBefore.parentNode === opts.parent) {
        opts.parent.insertBefore(el, opts.insertBefore);
      } else {
        opts.parent.prepend(el);
      }
    }
    if (!el) return null;
    el.hidden = !paused;
    el.setAttribute('aria-hidden', paused ? 'false' : 'true');
    if (paused) el.textContent = MESSAGE;
    return el;
  }

  global.CrewSightQuietHours = {
    TIMEZONE,
    PAUSE_START_HOUR,
    PAUSE_END_HOUR,
    MESSAGE,
    isQuietHours,
    onQuietHoursChange,
    setBannerVisible,
  };
})(typeof window !== 'undefined' ? window : globalThis);
