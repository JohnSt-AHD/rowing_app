import type { Map as LeafletMap, TileLayer } from 'leaflet';
import L from 'leaflet';

/**
 * Basemap for CrewSight maps.
 * Carto raster tiles now require an API key (show "API KEY REQUIRED").
 * Esri World Street Map is free for light app use and works in Android WebView.
 */
export function addMapBasemap(map: LeafletMap): TileLayer {
  return L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, OpenStreetMap',
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
