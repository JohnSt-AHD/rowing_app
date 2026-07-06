/**
 * Dashboard browser bundle — keep in sync with packages/rowing-pace/index.js
 */
(function (root) {
  const MIN_SPEED_MPS = 0.25;

  const WR_2K_SEC = {
    M1x: 383.6,
    W1x: 422.4,
    'M2-': 361.0,
    'W2-': 393.0,
    M2x: 353.0,
    W2x: 386.0,
    'M2+': 376.0,
    'W2+': 408.0,
    'M4-': 333.0,
    'W4-': 365.0,
    M4x: 330.0,
    W4x: 362.0,
    'M4+': 343.0,
    'W4+': 375.0,
    'M8+': 317.0,
    'W8+': 350.0,
    BM1x: 392.5,
    BW1x: 432.0,
    'BM2-': 371.0,
    'BW2-': 404.0,
    BM2x: 363.0,
    BW2x: 396.0,
    'BM2+': 387.0,
    'BW2+': 419.0,
    'BM4-': 343.0,
    'BW4-': 376.0,
    BM4x: 340.0,
    BW4x: 373.0,
    'BM4+': 353.0,
    'BW4+': 385.0,
    'BM8+': 327.0,
    'BW8+': 361.0,
    LM1x: 390.0,
    LW1x: 425.0,
    'LM2-': 370.0,
    'LW2-': 402.0,
    LM2x: 362.0,
    LW2x: 394.0,
    'LM2+': 385.0,
    'LW2+': 417.0,
    'LM4-': 340.0,
    'LW4-': 372.0,
    LM4x: 337.0,
    LW4x: 369.0,
    'LM4+': 350.0,
    'LW4+': 382.0,
    'LM8+': 324.0,
    'LW8+': 356.0,
  };

  const BOAT_CODE_RE =
    /(?:^|[^A-Z0-9])([BJL]?)([MW])([1248])([X+\-])(?=[^A-Z0-9]|$)/gi;

  function parseBoatClass() {
    for (let i = 0; i < arguments.length; i++) {
      const raw = arguments[i];
      if (raw == null || raw === '') continue;
      BOAT_CODE_RE.lastIndex = 0;
      const m = BOAT_CODE_RE.exec(String(raw));
      if (!m) continue;
      const prefix = (m[1] || '').toUpperCase();
      const gender = m[2].toUpperCase();
      const seats = m[3];
      let type = m[4];
      if (type === 'X' || type === 'x') type = 'x';
      else if (type === '+') type = '+';
      else type = '-';
      return prefix + gender + seats + type;
    }
    return null;
  }

  function reference2kSec(boatClass) {
    if (!boatClass) return null;
    return WR_2K_SEC[boatClass] ?? null;
  }

  function formatSplit500m(speedMps) {
    if (speedMps == null || !Number.isFinite(speedMps) || speedMps < MIN_SPEED_MPS) {
      return '—';
    }
    const sec = 500 / speedMps;
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(1);
    return m + ':' + s.padStart(4, '0');
  }

  function prognosticPercent(speedMps, boatClass) {
    const refSec = reference2kSec(boatClass);
    if (
      refSec == null ||
      speedMps == null ||
      !Number.isFinite(speedMps) ||
      speedMps < MIN_SPEED_MPS
    ) {
      return null;
    }
    return (refSec / (2000 / speedMps)) * 100;
  }

  function formatPrognostic(speedMps, boatClass) {
    const pct = prognosticPercent(speedMps, boatClass);
    if (pct == null) return null;
    return pct.toFixed(1) + '%';
  }

  function formatPaceWithPrognostic(speedMps) {
    let options = { suffix: false };
    const labelParts = [];
    for (let i = 1; i < arguments.length; i++) {
      const item = arguments[i];
      if (item != null && typeof item === 'object') {
        options = Object.assign(options, item);
      } else {
        labelParts.push(item);
      }
    }

    const split = formatSplit500m(speedMps);
    if (split === '—') return '—';
    const base = options.suffix ? split + '/500' : split;
    const boat = parseBoatClass.apply(null, labelParts);
    if (!boat) return base;
    const prog = formatPrognostic(speedMps, boat);
    return prog ? base + ' · ' + prog : base;
  }

  root.RowingSpeed = {
    MIN_SPEED_MPS,
    parseBoatClass,
    reference2kSec,
    formatSplit500m,
    prognosticPercent,
    formatPrognostic,
    formatPaceWithPrognostic,
  };
})(typeof window !== 'undefined' ? window : globalThis);
