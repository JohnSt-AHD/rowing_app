import type { Map as LeafletMap, TileLayer } from 'leaflet';
import L from 'leaflet';

/**
 * Basemap for CrewSight maps.
 * Prefer Carto (OSM data) — official tile.openstreetmap.org often blocks
 * Android WebView user-agents, which shows as an empty dark map.
 */
export function addMapBasemap(map: LeafletMap): TileLayer {
  return L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    {
      maxZoom: 20,
      subdomains: 'abcd',
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    },
  ).addTo(map);
}

/** Leaflet often needs a deferred size sync after a hidden panel becomes visible. */
export function scheduleMapInvalidate(map: LeafletMap | null | undefined): void {
  if (!map) return;
  requestAnimationFrame(() => {
    map.invalidateSize({ animate: false });
    window.setTimeout(() => map.invalidateSize({ animate: false }), 80);
    window.setTimeout(() => map.invalidateSize({ animate: false }), 280);
  });
}
