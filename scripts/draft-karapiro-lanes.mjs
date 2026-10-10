/**
 * Draft Lake Karāpiro traffic lanes from OSM water polygon (Nominatim).
 * Walks a path-following centreline (~15 km), then builds:
 *   - up lane (right when going up)
 *   - ~20 m centre no-go
 *   - down lane (right when going down)
 *
 * Usage: node scripts/draft-karapiro-lanes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const nominatimPath = path.join(root, 'apps/recorder-pwa/public/karapiro-nominatim.json');
const configPath = path.join(root, 'apps/recorder-pwa/public/karapiro-lane-config.json');
const outDir = path.join(root, 'apps/recorder-pwa/public');

const NO_GO_HALF_M = 10;
const STEP_M = 60;
const R_EARTH = 6371000;

const defaultConfig = {
  targetSpanKm: 22,
  excludeZones: [
    {
      name: 'Far-east inlet',
      minLat: -37.9468,
      maxLat: -37.9422,
      minLon: 175.6585,
      maxLon: 175.68,
    },
  ],
  turnaround: {
    name: 'Weather buoy (turnaround)',
    lat: -37.9268,
    lon: 175.5438,
    radiusM: 40,
  },
};

function loadConfig() {
  try {
    return { ...defaultConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch {
    return defaultConfig;
  }
}

function toRad(d) {
  return (d * Math.PI) / 180;
}
function toDeg(r) {
  return (r * 180) / Math.PI;
}

function destPoint(lat, lon, bearingDeg, distM) {
  const br = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const δ = distM / R_EARTH;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(br),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(br) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return [toDeg(φ2), toDeg(λ2)];
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function distM(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

function toLocal(lat, lon, oLat, oLon) {
  const x = toRad(lon - oLon) * Math.cos(toRad(oLat)) * R_EARTH;
  const y = toRad(lat - oLat) * R_EARTH;
  return [x, y];
}
function fromLocal(x, y, oLat, oLon) {
  const lat = oLat + toDeg(y / R_EARTH);
  const lon = oLon + toDeg(x / (R_EARTH * Math.cos(toRad(oLat))));
  return [lat, lon];
}

function pointInRing(lat, lon, ringLonLat) {
  let inside = false;
  for (let i = 0, j = ringLonLat.length - 1; i < ringLonLat.length; j = i++) {
    const [xi, yi] = ringLonLat[i];
    const [xj, yj] = ringLonLat[j];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lat, lon, ringsLonLat) {
  if (!pointInRing(lat, lon, ringsLonLat[0])) return false;
  for (let r = 1; r < ringsLonLat.length; r++) {
    if (pointInRing(lat, lon, ringsLonLat[r])) return false;
  }
  return true;
}

function inExcludeZone(lat, lon, zones) {
  if (!Array.isArray(zones)) return false;
  for (const z of zones) {
    if (
      lat >= z.minLat &&
      lat <= z.maxLat &&
      lon >= z.minLon &&
      lon <= z.maxLon
    ) {
      return true;
    }
  }
  return false;
}

/** Navigable water for lanes: OSM lake minus excluded inlet box(es). */
function inNavWater(lat, lon, ringsLonLat, excludeZones) {
  if (inExcludeZone(lat, lon, excludeZones)) return false;
  return pointInPolygon(lat, lon, ringsLonLat);
}

/**
 * Clip ring so vertices inside exclude zones are pulled to the west edge of the zone.
 * Enough to hide the far-east inlet spur from the displayed water outline.
 */
function clipRingExcludeZones(ringLonLat, zones) {
  if (!zones?.length) return ringLonLat;
  const out = [];
  for (const [lon, lat] of ringLonLat) {
    let lo = lon;
    let la = lat;
    for (const z of zones) {
      if (la >= z.minLat && la <= z.maxLat && lo >= z.minLon && lo <= z.maxLon) {
        lo = z.minLon;
      }
    }
    out.push([lo, la]);
  }
  return out;
}

function segmentIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const den = (ax - bx) * (cy - dy) - (ay - by) * (cx - dx);
  if (Math.abs(den) < 1e-12) return null;
  const t = ((ax - cx) * (cy - dy) - (ay - cy) * (cx - dx)) / den;
  const u = -((ax - bx) * (ay - cy) - (ay - by) * (ax - cx)) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [ax + t * (bx - ax), ay + t * (by - ay)];
}

/** Chaikin corner-cutting on [lat,lon][] open polyline (keeps endpoints). */
function chaikinSmooth(latLonPts, iterations = 3) {
  let pts = latLonPts.slice();
  for (let n = 0; n < iterations; n++) {
    if (pts.length < 3) break;
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [aLat, aLon] = pts[i];
      const [bLat, bLon] = pts[i + 1];
      next.push([0.75 * aLat + 0.25 * bLat, 0.75 * aLon + 0.25 * bLon]);
      next.push([0.25 * aLat + 0.75 * bLat, 0.25 * aLon + 0.75 * bLon]);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

/** Keep ~every Nth point (always keep ends). Caps edit-handle count. */
function downsample(latLonPts, maxPts) {
  if (latLonPts.length <= maxPts) return latLonPts;
  const out = [];
  const last = latLonPts.length - 1;
  for (let i = 0; i < maxPts; i++) {
    const idx = Math.round((i * last) / (maxPts - 1));
    out.push(latLonPts[idx]);
  }
  return out;
}

/** Moving-average smooth on [lat,lon][] (window odd). */
function movingAverageSmooth(latLonPts, window = 5) {
  const w = Math.max(3, window | 1);
  const half = (w - 1) >> 1;
  const out = [];
  for (let i = 0; i < latLonPts.length; i++) {
    let slat = 0;
    let slon = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= latLonPts.length) continue;
      slat += latLonPts[j][0];
      slon += latLonPts[j][1];
      n += 1;
    }
    out.push([slat / n, slon / n]);
  }
  // Keep endpoints exact so polygons still meet
  if (out.length) {
    out[0] = latLonPts[0];
    out[out.length - 1] = latLonPts[latLonPts.length - 1];
  }
  return out;
}

function simplifyRing(ring, tolM, oLat, oLon) {
  if (ring.length < 4) return ring;
  const pts = ring.map(([lon, lat]) => {
    const [x, y] = toLocal(lat, lon, oLat, oLon);
    return { lon, lat, x, y };
  });
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  function douglas(i0, i1) {
    let maxD = 0;
    let idx = -1;
    const a = pts[i0];
    const b = pts[i1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    for (let i = i0 + 1; i < i1; i++) {
      const p = pts[i];
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
      const qx = a.x + t * dx;
      const qy = a.y + t * dy;
      const d = Math.hypot(p.x - qx, p.y - qy);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolM && idx >= 0) {
      keep[idx] = true;
      douglas(i0, idx);
      douglas(idx, i1);
    }
  }
  douglas(0, pts.length - 1);
  const out = pts.filter((_, i) => keep[i]).map((p) => [p.lon, p.lat]);
  if (out.length < 4) return ring;
  const [fLon, fLat] = out[0];
  const [lLon, lLat] = out[out.length - 1];
  if (fLon !== lLon || fLat !== lLat) out.push([fLon, fLat]);
  return out;
}

function crossSection(lat, lon, bearing, rings, oLat, oLon, excludeZones) {
  const rightBrg = (bearing + 90) % 360;
  const leftBrg = (bearing + 270) % 360;
  const half = 700;
  const [latA, lonA] = destPoint(lat, lon, leftBrg, half);
  const [latB, lonB] = destPoint(lat, lon, rightBrg, half);
  const [ax, ay] = toLocal(latA, lonA, oLat, oLon);
  const [bx, by] = toLocal(latB, lonB, oLat, oLon);
  const [cx0, cy0] = toLocal(lat, lon, oLat, oLon);
  const px = bx - ax;
  const py = by - ay;
  const plen = Math.hypot(px, py) || 1;

  const hits = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];
      const [x1, y1] = toLocal(lat1, lon1, oLat, oLon);
      const [x2, y2] = toLocal(lat2, lon2, oLat, oLon);
      const hit = segmentIntersect(ax, ay, bx, by, x1, y1, x2, y2);
      if (!hit) continue;
      const t = ((hit[0] - ax) * px + (hit[1] - ay) * py) / (plen * plen);
      hits.push({ x: hit[0], y: hit[1], t, hole: r > 0 });
    }
  }
  hits.sort((u, v) => u.t - v.t);

  let best = null;
  for (let i = 0; i < hits.length - 1; i++) {
    const h0 = hits[i];
    const h1 = hits[i + 1];
    if (h0.hole || h1.hole) continue;
    const midX = (h0.x + h1.x) / 2;
    const midY = (h0.y + h1.y) / 2;
    const [mlat, mlon] = fromLocal(midX, midY, oLat, oLon);
    if (!inNavWater(mlat, mlon, rings, excludeZones)) continue;
    const width = Math.hypot(h1.x - h0.x, h1.y - h0.y);
    if (width < 25 || width > 1600) continue;
    const covers = h0.t <= 0.5 && h1.t >= 0.5;
    const distAxis = Math.hypot(midX - cx0, midY - cy0);
    if (
      !best ||
      (covers && !best.covers) ||
      (covers === best.covers && distAxis < best.distAxis)
    ) {
      best = { h0, h1, width, covers, midX, midY, distAxis };
    }
  }
  if (!best) return null;

  const [clat, clon] = fromLocal(best.midX, best.midY, oLat, oLon);
  // Right shore = toward rightBrg from centre
  const [rx, ry] = toLocal(
    destPoint(clat, clon, rightBrg, 1)[0],
    destPoint(clat, clon, rightBrg, 1)[1],
    oLat,
    oLon,
  );
  const rdirx = rx - best.midX;
  const rdiry = ry - best.midY;
  const d0 = (best.h0.x - best.midX) * rdirx + (best.h0.y - best.midY) * rdiry;
  const rightHit = d0 > 0 ? best.h0 : best.h1;
  const leftHit = d0 > 0 ? best.h1 : best.h0;
  const [rlat, rlon] = fromLocal(rightHit.x, rightHit.y, oLat, oLon);
  const [llat, llon] = fromLocal(leftHit.x, leftHit.y, oLat, oLon);
  return { clat, clon, rlat, rlon, llat, llon, width: best.width };
}

function main() {
  const cfg = loadConfig();
  const TARGET_SPAN_M = (cfg.targetSpanKm || 22) * 1000;
  const excludeZones = cfg.excludeZones || defaultConfig.excludeZones;
  const buoy = cfg.turnaround || defaultConfig.turnaround;

  /** Seed at weather buoy (north turnaround); walk upstream/SE then south. */
  const SEED = {
    lat: buoy.lat,
    lon: buoy.lon,
    bearing: 125,
  };
  const FOCUS = {
    minLat: -38.12,
    maxLat: -37.91,
    minLon: 175.53,
    maxLon: 175.675,
  };

  const raw = JSON.parse(fs.readFileSync(nominatimPath, 'utf8'));
  const feature = raw[0];
  if (!feature?.geojson) throw new Error('No geojson in nominatim response');
  const geo = feature.geojson;
  if (geo.type !== 'Polygon') throw new Error(`Expected Polygon, got ${geo.type}`);
  const rings = geo.coordinates;

  const oLat = SEED.lat;
  const oLon = SEED.lon;

  // Nudge seed onto water if buoy geofence centre is slightly off the OSM shore
  let seedLat = SEED.lat;
  let seedLon = SEED.lon;
  if (!inNavWater(seedLat, seedLon, rings, excludeZones)) {
    let found = null;
    for (let r = 20; r <= 120 && !found; r += 20) {
      for (let brg = 0; brg < 360; brg += 30) {
        const [la, lo] = destPoint(SEED.lat, SEED.lon, brg, r);
        if (inNavWater(la, lo, rings, excludeZones)) {
          found = [la, lo];
          break;
        }
      }
    }
    if (!found) throw new Error('Seed/buoy is not near navigable water');
    seedLat = found[0];
    seedLon = found[1];
  }

  let bearing = SEED.bearing;
  let lat = seedLat;
  let lon = seedLon;
  const run = [];

  // First cross-section at seed (north turnaround)
  let first = crossSection(lat, lon, bearing, rings, oLat, oLon, excludeZones);
  if (!first) throw new Error('No cross-section at seed');
  run.push(first);
  lat = first.clat;
  lon = first.clon;

  let travelled = 0;
  const startLat = lat;
  const startLon = lon;

  for (let guard = 0; guard < 600 && travelled < TARGET_SPAN_M; guard++) {
    if (
      lat < FOCUS.minLat ||
      lat > FOCUS.maxLat ||
      lon < FOCUS.minLon ||
      lon > FOCUS.maxLon
    ) {
      break;
    }

    let next = null;
    let usedBrg = bearing;
    for (const delta of [0, -12, 12, -24, 24, -36, 36, -48, 48]) {
      const brg = (bearing + delta + 360) % 360;
      const probe = destPoint(lat, lon, brg, STEP_M);
      if (inExcludeZone(probe[0], probe[1], excludeZones)) continue;
      const cs = crossSection(probe[0], probe[1], brg, rings, oLat, oLon, excludeZones);
      if (!cs) continue;
      if (inExcludeZone(cs.clat, cs.clon, excludeZones)) continue;
      const stepDist = distM(lat, lon, cs.clat, cs.clon);
      if (stepDist < STEP_M * 0.35 || stepDist > STEP_M * 2.2) continue;
      // Skip steps that reverse toward the start (loop guard)
      const progNow = distM(startLat, startLon, lat, lon);
      const progNext = distM(startLat, startLon, cs.clat, cs.clon);
      if (run.length > 8 && progNext + 40 < progNow) continue;
      next = cs;
      usedBrg = brg;
      break;
    }
    if (!next) break;

    const brgActual = bearingDeg(lat, lon, next.clat, next.clon);
    bearing = (usedBrg * 0.35 + brgActual * 0.65 + 360) % 360;
    travelled += distM(lat, lon, next.clat, next.clon);
    lat = next.clat;
    lon = next.clon;
    run.push(next);
  }

  // Continue further south (~+7 km). Search a small south/SE grid so narrow
  // shore gaps do not stop the walk.
  let extBearing = 170;
  while (travelled < TARGET_SPAN_M && run.length < 500) {
    /** @type {null | {clat:number,clon:number,rlat:number,rlon:number,llat:number,llon:number,width:number}} */
    let next = null;
    let bestScore = Infinity;
    for (const dist of [80, 120, 180, 250, 350]) {
      for (const brg of [150, 160, 170, 180, 190, 200, 140, 210, 130, 220]) {
        const probe = destPoint(lat, lon, brg, dist);
        if (probe[0] < FOCUS.minLat || probe[0] >= lat) continue;
        if (inExcludeZone(probe[0], probe[1], excludeZones)) continue;
        if (!inNavWater(probe[0], probe[1], rings, excludeZones)) continue;
        const cs = crossSection(probe[0], probe[1], brg, rings, oLat, oLon, excludeZones);
        if (!cs || inExcludeZone(cs.clat, cs.clon, excludeZones)) continue;
        if (cs.clat >= lat) continue;
        const stepDist = distM(lat, lon, cs.clat, cs.clon);
        if (stepDist < 40 || stepDist > 420) continue;
        // Prefer closer, more-south steps
        const score = stepDist + (lat - cs.clat) * -80000;
        if (score < bestScore) {
          bestScore = score;
          next = cs;
          extBearing = brg;
        }
      }
      if (next && dist <= 180) break;
    }
    if (!next) break;
    travelled += distM(lat, lon, next.clat, next.clon);
    lat = next.clat;
    lon = next.clon;
    run.push(next);
  }

  if (run.length < 8) {
    throw new Error(`Centreline too short (${run.length} samples)`);
  }

  // Smooth centreline lightly, then downsample so the map stays editable
  // (Geoman creates a handle per vertex — thousands will freeze the tab).
  const MAX_EDIT_PTS = 120;
  const rawCenter = run.map((s) => [s.clat, s.clon]);
  const centerline = downsample(
    chaikinSmooth(movingAverageSmooth(rawCenter, 5), 1),
    MAX_EDIT_PTS,
  );
  const rightEdge = downsample(
    movingAverageSmooth(
      run.map((s) => [s.rlat, s.rlon]),
      5,
    ),
    MAX_EDIT_PTS,
  );
  const leftEdge = downsample(
    movingAverageSmooth(
      run.map((s) => [s.llat, s.llon]),
      5,
    ),
    MAX_EDIT_PTS,
  );

  // Snap northern end of centreline to the weather buoy so no-go meets it
  const buoyR = buoy.radiusM || 40;
  if (centerline.length >= 2) {
    centerline[0] = [buoy.lat, buoy.lon];
  }

  // Rebuild ±10 m no-go from smoothed centre (same point count as centreline)
  const noGoLeft = [];
  const noGoRight = [];
  for (let i = 0; i < centerline.length; i++) {
    const [clat, clon] = centerline[i];
    const t = centerline.length === 1 ? 0 : i / (centerline.length - 1);
    const ri = Math.min(rightEdge.length - 1, Math.round(t * (rightEdge.length - 1)));
    const li = Math.min(leftEdge.length - 1, Math.round(t * (leftEdge.length - 1)));
    const [rlat, rlon] = rightEdge[ri];
    const [llat, llon] = leftEdge[li];
    let leftBrg;
    let rightBrg;
    if (i === 0 && centerline.length > 1) {
      const brg = bearingDeg(clat, clon, centerline[1][0], centerline[1][1]);
      leftBrg = (brg + 270) % 360;
      rightBrg = (brg + 90) % 360;
    } else if (i > 0 && i < centerline.length - 1) {
      const brg = bearingDeg(
        centerline[i - 1][0],
        centerline[i - 1][1],
        centerline[i + 1][0],
        centerline[i + 1][1],
      );
      leftBrg = (brg + 270) % 360;
      rightBrg = (brg + 90) % 360;
    } else {
      leftBrg = bearingDeg(clat, clon, llat, llon);
      rightBrg = bearingDeg(clat, clon, rlat, rlon);
    }
    // At the buoy, flare no-go to the buoy radius so the strip meets the turnaround
    const half = i === 0 ? Math.max(NO_GO_HALF_M, buoyR) : NO_GO_HALF_M;
    noGoLeft.push(destPoint(clat, clon, leftBrg, half));
    noGoRight.push(destPoint(clat, clon, rightBrg, half));
  }

  // Up lane = right side when looking along walk direction (seed→end)
  const upPoly = [
    ...noGoRight.map(([la, lo]) => [lo, la]),
    ...rightEdge
      .slice()
      .reverse()
      .map(([la, lo]) => [lo, la]),
  ];
  upPoly.push(upPoly[0]);

  const downPoly = [
    ...leftEdge.map(([la, lo]) => [lo, la]),
    ...noGoLeft
      .slice()
      .reverse()
      .map(([la, lo]) => [lo, la]),
  ];
  downPoly.push(downPoly[0]);

  // North cap: arc around the weather buoy connecting right→left (meets turnaround zone)
  const northBrg = bearingDeg(buoy.lat, buoy.lon, centerline[1][0], centerline[1][1]);
  const rightBrg0 = (northBrg + 90) % 360;
  const leftBrg0 = (northBrg + 270) % 360;
  const buoyCap = [];
  // Sweep the northern semicircle (away from the lane) from right to left
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    // from rightBrg0 going the long way around north to leftBrg0
    let span = (leftBrg0 - rightBrg0 + 360) % 360;
    // take the exterior (north) arc: the one that does NOT point down-lane
    const midBrg = (rightBrg0 + span / 2) % 360;
    let turnFromLane = Math.abs(midBrg - northBrg);
    if (turnFromLane > 180) turnFromLane = 360 - turnFromLane;
    if (turnFromLane < 90) {
      // mid is toward the lane — use the other way around
      span = span - 360; // negative sweep
    }
    const brg = (rightBrg0 + span * t + 360) % 360;
    const [ala, alo] = destPoint(buoy.lat, buoy.lon, brg, buoyR);
    buoyCap.push([alo, ala]);
  }

  const noGoPoly = [
    ...noGoLeft.map(([la, lo]) => [lo, la]),
    ...noGoRight
      .slice()
      .reverse()
      .map(([la, lo]) => [lo, la]),
    ...buoyCap,
  ];
  noGoPoly.push(noGoPoly[0]);

  // Navigable water for display: OSM outline with far-east inlet pulled closed
  const clippedOuter = clipRingExcludeZones(rings[0], excludeZones);
  const waterSimplified = [
    simplifyRing(clippedOuter, 35, oLat, oLon),
    ...rings.slice(1).map((ring) => simplifyRing(ring, 50, oLat, oLon)),
  ];

  const firstPt = centerline[0];
  const lastPt = centerline[centerline.length - 1];
  // Walk starts at weather buoy (north) and goes up-lake toward the south/east headwaters.
  const upBearing = bearingDeg(firstPt[0], firstPt[1], lastPt[0], lastPt[1]);
  const downBearing = (upBearing + 180) % 360;
  const spanKm = travelled / 1000;

  const buoyCircle = [];
  for (let i = 0; i <= 48; i++) {
    const [bla, blo] = destPoint(buoy.lat, buoy.lon, (i * 360) / 48, buoyR);
    buoyCircle.push([blo, bla]);
  }

  const fc = {
    type: 'FeatureCollection',
    properties: {
      title: 'Lake Karāpiro draft traffic lanes',
      note: 'DRAFT — keep-right rotation. East inlet clipped. North turnaround = weather buoy. Direction selects the correct lane; after turning at the buoy or south end, the expected lane flips.',
      noGoWidthM: NO_GO_HALF_M * 2,
      spanKm: Math.round(spanKm * 10) / 10,
      upBearingDeg: Math.round(upBearing),
      downBearingDeg: Math.round(downBearing),
      excludeZones,
      turnaround: { lat: buoy.lat, lon: buoy.lon, radiusM: buoyR, name: buoy.name },
      source: feature.display_name,
      generatedAt: new Date().toISOString(),
    },
    features: [
      {
        type: 'Feature',
        properties: {
          id: 'water',
          kind: 'lake',
          name: 'Water (OSM, east inlet clipped)',
          style: 'water',
        },
        geometry: { type: 'Polygon', coordinates: waterSimplified },
      },
      {
        type: 'Feature',
        properties: {
          id: 'turnaround',
          kind: 'turnaround',
          name: buoy.name || 'Weather buoy (turnaround)',
          style: 'buoy',
          radiusM: buoyR,
        },
        geometry: { type: 'Polygon', coordinates: [buoyCircle] },
      },
      {
        type: 'Feature',
        properties: {
          id: 'turnaround_point',
          kind: 'turnaround',
          name: buoy.name || 'Weather buoy',
          style: 'buoyMarker',
        },
        geometry: { type: 'Point', coordinates: [buoy.lon, buoy.lat] },
      },
      {
        type: 'Feature',
        properties: {
          id: 'lane_up',
          kind: 'lane_up',
          name: 'Up lane (right when going up)',
          style: 'up',
        },
        geometry: { type: 'Polygon', coordinates: [upPoly] },
      },
      {
        type: 'Feature',
        properties: {
          id: 'lane_down',
          kind: 'lane_down',
          name: 'Down lane (right when going down)',
          style: 'down',
        },
        geometry: { type: 'Polygon', coordinates: [downPoly] },
      },
      {
        type: 'Feature',
        properties: {
          id: 'no_go',
          kind: 'hazard',
          name: 'No-go / safety zone (~20 m)',
          style: 'nogo',
        },
        geometry: { type: 'Polygon', coordinates: [noGoPoly] },
      },
      {
        type: 'Feature',
        properties: {
          id: 'centerline',
          kind: 'centerline',
          name: 'Approx. lake centre',
          style: 'center',
        },
        geometry: {
          type: 'LineString',
          coordinates: centerline.map(([la, lo]) => [lo, la]),
        },
      },
    ],
  };

  const geoPath = path.join(outDir, 'karapiro-lanes-draft.geojson');
  fs.writeFileSync(geoPath, JSON.stringify(fc));
  console.log('Wrote', geoPath);
  console.log(
    `span≈${fc.properties.spanKm} km · samples=${centerline.length} · upBearing=${fc.properties.upBearingDeg}° · no-go=${fc.properties.noGoWidthM}m`,
  );
}

main();
