/**
 * Dashboard geofence zone management (Leaflet circles + polygons + /api/geofences).
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  let geofenceLayer = null;
  let draftLayer = null;
  let pickMode = false;
  let drawPolygonMode = false;
  let polygonDraft = [];
  let polygonReady = false;
  let geofences = [];
  let editGeofenceMode = false;
  let geofenceEditLayer = null;

  const GEOFENCE_STYLE = {
    color: '#f59e0b',
    fillColor: '#f59e0b',
    fillOpacity: 0.12,
    weight: 2,
    dashArray: '6 4',
  };

  function headers() {
    if (typeof window.dashboardHeaders === 'function') return window.dashboardHeaders();
    return { Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  function apiBase() {
    if (typeof window.dashboardApiBase === 'function') return window.dashboardApiBase();
    return window.location.origin;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(msg, isError) {
    const el = $('#geofenceStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('poll-line--warn', !!isError);
  }

  function getMap() {
    return window.dashboardFleetMap || null;
  }

  function currentShapeType() {
    return $('#geofenceShapeType')?.value === 'polygon' ? 'polygon' : 'circle';
  }

  function shapeSummary(g) {
    if (g.shapeType === 'polygon' && Array.isArray(g.polygonCoords) && g.polygonCoords.length >= 3) {
      return `Polygon · ${g.polygonCoords.length} points`;
    }
    return `${g.centerLat.toFixed(5)}, ${g.centerLon.toFixed(5)} · ${Math.round(g.radiusM)} m`;
  }

  function popupHtml(g) {
    const shape =
      g.shapeType === 'polygon' && g.polygonCoords?.length >= 3
        ? `Polygon · ${g.polygonCoords.length} points`
        : `${Math.round(g.radiusM)} m radius`;
    return `<strong>${esc(g.name)}</strong><br>Geofence zone · ${shape}<br>Every ${g.economyIntervalSec ?? g.economyGpsIntervalSec ?? 30}s · capsize ${g.disableCapsize ? 'off' : 'on'} · record ${g.suppressRecording ? 'paused' : 'on'} · auto ${g.autoStopOnEnter ? 'stop' : 'stop off'} / ${g.autoStartOnExit ? 'start' : 'start off'}`;
  }

  function drawGeofences() {
    const map = getMap();
    if (!map || typeof L === 'undefined') return;
    if (!geofenceLayer) {
      geofenceLayer = L.layerGroup().addTo(map);
    }
    geofenceLayer.clearLayers();
    geofenceEditLayer?.clearLayers();
    for (const g of geofences) {
      if (!g.enabled) continue;
      let layer;
      if (g.shapeType === 'polygon' && Array.isArray(g.polygonCoords) && g.polygonCoords.length >= 3) {
        layer = L.polygon(
          g.polygonCoords.map((pt) => [pt[0], pt[1]]),
          GEOFENCE_STYLE,
        );
      } else {
        layer = L.circle([g.centerLat, g.centerLon], {
          radius: g.radiusM,
          ...GEOFENCE_STYLE,
        });
      }
      layer.bindPopup(popupHtml(g));
      geofenceLayer.addLayer(layer);
      if (editGeofenceMode) attachGeofenceEditHandles(g);
    }
  }

  async function saveGeofenceGeometry(id, payload) {
    setStatus('Saving geofence…');
    const res = await fetch(`${apiBase()}/api/geofences?id=${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'Save failed', true);
      return;
    }
    await loadGeofences();
  }

  function attachGeofenceEditHandles(g) {
    const map = getMap();
    if (!map) return;
    if (!geofenceEditLayer) geofenceEditLayer = L.layerGroup().addTo(map);

    const handleIcon = L.divIcon({
      className: 'geofence-edit-handle',
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });

    if (g.shapeType === 'polygon' && g.polygonCoords?.length >= 3) {
      g.polygonCoords.forEach((pt, idx) => {
        L.marker([pt[0], pt[1]], { draggable: true, icon: handleIcon })
          .on('dragend', (e) => {
            const { lat, lng } = e.target.getLatLng();
            const next = g.polygonCoords.map((p, i) =>
              i === idx ? [lat, lng] : [p[0], p[1]],
            );
            void saveGeofenceGeometry(g.id, { polygonCoords: next });
          })
          .addTo(geofenceEditLayer);
      });
      return;
    }

    L.marker([g.centerLat, g.centerLon], { draggable: true, icon: handleIcon })
      .on('dragend', (e) => {
        const { lat, lng } = e.target.getLatLng();
        void saveGeofenceGeometry(g.id, { centerLat: lat, centerLon: lng });
      })
      .addTo(geofenceEditLayer);

    const edge = destinationPoint(g.centerLat, g.centerLon, g.radiusM, 90);
    L.marker(edge, { draggable: true, icon: handleIcon })
      .on('dragend', (e) => {
        const { lat, lng } = e.target.getLatLng();
        const r = haversineM(g.centerLat, g.centerLon, lat, lng);
        void saveGeofenceGeometry(g.id, {
          centerLat: g.centerLat,
          centerLon: g.centerLon,
          radiusM: Math.max(20, Math.round(r)),
        });
      })
      .addTo(geofenceEditLayer);
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function destinationPoint(lat, lon, distM, bearingDeg) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const δ = distM / R;
    const θ = toRad(bearingDeg);
    const φ1 = toRad(lat);
    const λ1 = toRad(lon);
    const φ2 = Math.asin(
      Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
    );
    const λ2 =
      λ1 +
      Math.atan2(
        Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
        Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
      );
    return [toDeg(φ2), toDeg(λ2)];
  }

  function setEditGeofenceMode(on) {
    editGeofenceMode = on;
    const btn = $('#geofenceEditToggle');
    if (btn) {
      btn.textContent = on ? 'Editing zones (drag points)' : 'Edit zones on map';
      btn.classList.toggle('hub-btn--primary', on);
    }
    if (!on) geofenceEditLayer?.clearLayers();
    drawGeofences();
  }

  function ensureDraftLayer() {
    const map = getMap();
    if (!map || typeof L === 'undefined') return null;
    if (!draftLayer) {
      draftLayer = L.layerGroup().addTo(map);
    }
    return draftLayer;
  }

  function updateDrawStatus() {
    const el = $('#geofenceDrawStatus');
    if (!el) return;
    if (drawPolygonMode) {
      el.textContent = `Drawing… ${polygonDraft.length} point(s). Click the map to add corners, then Finish polygon.`;
      return;
    }
    if (polygonReady && polygonDraft.length >= 3) {
      el.textContent = `Polygon ready (${polygonDraft.length} points). Enter a name and click Add zone.`;
      return;
    }
    el.textContent = polygonDraft.length
      ? `${polygonDraft.length} point(s) — finish the polygon or keep drawing.`
      : 'No polygon drawn yet.';
  }

  function updateDraftLayer() {
    const layer = ensureDraftLayer();
    if (!layer) return;
    layer.clearLayers();
    if (!polygonDraft.length) return;

    const latLngs = polygonDraft.map((p) => [p.lat, p.lon]);
    if (polygonDraft.length >= 2) {
      L.polyline(latLngs, {
        color: '#f59e0b',
        weight: 2,
        dashArray: '4 6',
      }).addTo(layer);
    }
    if (polygonDraft.length >= 3) {
      L.polygon(latLngs, {
        color: '#f59e0b',
        fillColor: '#f59e0b',
        fillOpacity: 0.08,
        weight: 2,
      }).addTo(layer);
    }
    for (const p of polygonDraft) {
      L.circleMarker([p.lat, p.lon], {
        radius: 5,
        color: '#f59e0b',
        fillColor: '#fff',
        fillOpacity: 1,
        weight: 2,
      }).addTo(layer);
    }
  }

  function updateDrawButtons() {
    const drawing = drawPolygonMode;
    const hasPoints = polygonDraft.length > 0;
    const canFinish = polygonDraft.length >= 3;
    $('#geofenceFinishDrawBtn')?.toggleAttribute('disabled', !drawing || !canFinish);
    $('#geofenceUndoPointBtn')?.toggleAttribute('disabled', !drawing || !hasPoints);
    $('#geofenceClearDrawBtn')?.toggleAttribute('disabled', !hasPoints);
    const drawBtn = $('#geofenceDrawBtn');
    if (drawBtn) {
      drawBtn.textContent = drawing ? 'Drawing… click map' : 'Draw on map';
      drawBtn.classList.toggle('hub-btn--primary', drawing);
    }
    updateDrawStatus();
  }

  function clearPolygonDraft() {
    polygonDraft = [];
    polygonReady = false;
    draftLayer?.clearLayers();
    updateDrawButtons();
  }

  function setPickMode(on) {
    if (on && drawPolygonMode) setDrawPolygonMode(false);
    pickMode = on;
    const btn = $('#geofencePickBtn');
    if (btn) {
      btn.textContent = on ? 'Click map to set centre…' : 'Pick centre on map';
      btn.classList.toggle('hub-btn--primary', on);
    }
    const map = getMap();
    if (map && !drawPolygonMode) map.getContainer().style.cursor = on ? 'crosshair' : '';
  }

  function setDrawPolygonMode(on) {
    if (on) setPickMode(false);
    drawPolygonMode = on;
    if (!on && polygonDraft.length >= 3) polygonReady = true;
    const map = getMap();
    if (map) map.getContainer().style.cursor = on ? 'crosshair' : '';
    updateDrawButtons();
    updateDraftLayer();
  }

  function updateShapeFields() {
    const isPolygon = currentShapeType() === 'polygon';
    const circleFields = $('#geofenceCircleFields');
    const polygonFields = $('#geofencePolygonFields');
    if (circleFields) circleFields.hidden = isPolygon;
    if (polygonFields) polygonFields.hidden = !isPolygon;
    if (isPolygon) {
      setPickMode(false);
    } else {
      setDrawPolygonMode(false);
      clearPolygonDraft();
    }
  }

  async function loadGeofences() {
    const res = await fetch(`${apiBase()}/api/geofences`, { headers: headers() });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    if (!data.persisted) {
      setStatus('Postgres required — set POSTGRES_URL on Vercel to store geofences.', true);
    }
    geofences = data.geofences || [];
    renderList();
    drawGeofences();
    if (data.persisted) setStatus(`${geofences.length} geofence(s) loaded.`);
  }

  function renderList() {
    const el = $('#geofenceList');
    if (!el) return;
    if (!geofences.length) {
      el.innerHTML =
        '<p class="poll-line">No geofence zones yet. Add a circle below or draw a polygon on the fleet map.</p>';
      return;
    }
    el.innerHTML = geofences
      .map(
        (g) => `
      <div class="geofence-item" data-id="${g.id}">
        <div class="geofence-item__main">
          <strong>${esc(g.name)}</strong>
          <span class="geofence-item__meta">${esc(shapeSummary(g))}</span>
          <span class="geofence-item__meta">Economy: every ${g.economyIntervalSec ?? g.economyGpsIntervalSec ?? 30}s · capsize ${g.disableCapsize ? 'off' : 'on'} · record ${g.suppressRecording ? 'paused' : 'on'} · dwell ${g.sessionDwellSec ?? 45}s · auto-stop ${g.autoStopOnEnter ? 'on' : 'off'} · auto-start ${g.autoStartOnExit ? 'on' : 'off'}</span>
        </div>
        <button type="button" class="hub-btn hub-btn--danger geofence-delete-btn" data-id="${g.id}">Delete</button>
      </div>`,
      )
      .join('');
    el.querySelectorAll('.geofence-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => void deleteGeofence(btn.getAttribute('data-id')));
    });
  }

  async function deleteGeofence(id) {
    if (!id || !confirm('Delete this geofence zone?')) return;
    setStatus('Deleting…');
    const res = await fetch(`${apiBase()}/api/geofences?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headers(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'Delete failed', true);
      return;
    }
    await loadGeofences();
  }

  async function createGeofence(ev) {
    ev.preventDefault();
    const name = $('#geofenceName')?.value?.trim();
    const shapeType = currentShapeType();
    const economyIntervalSec = Number($('#geofenceIntervalSec')?.value) || 30;
    const sessionDwellSec = Number($('#geofenceDwellSec')?.value) || 45;
    const disableCapsize = $('#geofenceDisableCapsize')?.checked !== false;
    const suppressRecording = $('#geofenceSuppressRecording')?.checked === true;
    const autoStopOnEnter = $('#geofenceAutoStop')?.checked === true;
    const autoStartOnExit = $('#geofenceAutoStart')?.checked === true;

    if (!name) {
      setStatus('Name is required.', true);
      return;
    }

    let payload = {
      name,
      kind: 'boat_park',
      shapeType,
      economyIntervalSec,
      sessionDwellSec,
      disableCapsize,
      suppressRecording,
      autoStopOnEnter,
      autoStartOnExit,
    };

    if (shapeType === 'polygon') {
      if (!polygonReady || polygonDraft.length < 3) {
        setStatus('Draw a polygon on the map with at least 3 points, then Finish polygon.', true);
        return;
      }
      payload.polygonCoords = polygonDraft.map((p) => [p.lat, p.lon]);
    } else {
      const centerLat = Number($('#geofenceLat')?.value);
      const centerLon = Number($('#geofenceLon')?.value);
      const radiusM = Number($('#geofenceRadius')?.value);
      if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
        setStatus('Latitude and longitude are required.', true);
        return;
      }
      if (!Number.isFinite(radiusM) || radiusM <= 0) {
        setStatus('Radius must be a positive number (metres).', true);
        return;
      }
      payload = { ...payload, centerLat, centerLon, radiusM };
    }

    setStatus('Saving…');
    const res = await fetch(`${apiBase()}/api/geofences`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'Save failed', true);
      return;
    }
    $('#geofenceForm')?.reset();
    if ($('#geofenceIntervalSec')) $('#geofenceIntervalSec').value = '30';
    if ($('#geofenceDwellSec')) $('#geofenceDwellSec').value = '45';
    if ($('#geofenceDisableCapsize')) $('#geofenceDisableCapsize').checked = true;
    if ($('#geofenceSuppressRecording')) $('#geofenceSuppressRecording').checked = false;
    if ($('#geofenceAutoStop')) $('#geofenceAutoStop').checked = false;
    if ($('#geofenceAutoStart')) $('#geofenceAutoStart').checked = false;
    if ($('#geofenceShapeType')) $('#geofenceShapeType').value = 'circle';
    clearPolygonDraft();
    updateShapeFields();
    await loadGeofences();
  }

  function onMapClick(e) {
    if (drawPolygonMode) {
      polygonDraft.push({ lat: e.latlng.lat, lon: e.latlng.lng });
      polygonReady = false;
      updateDraftLayer();
      updateDrawButtons();
      return;
    }
    if (!pickMode) return;
    const lat = e.latlng.lat;
    const lon = e.latlng.lng;
    const latEl = $('#geofenceLat');
    const lonEl = $('#geofenceLon');
    if (latEl) latEl.value = lat.toFixed(6);
    if (lonEl) lonEl.value = lon.toFixed(6);
    setPickMode(false);
    setStatus(`Centre set to ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  }

  function useMapCentre() {
    const map = getMap();
    if (!map) return;
    const c = map.getCenter();
    const latEl = $('#geofenceLat');
    const lonEl = $('#geofenceLon');
    if (latEl) latEl.value = c.lat.toFixed(6);
    if (lonEl) lonEl.value = c.lng.toFixed(6);
    setStatus(`Centre set to map view ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`);
  }

  function finishPolygonDraw() {
    if (polygonDraft.length < 3) {
      setStatus('Need at least 3 points to finish the polygon.', true);
      return;
    }
    setDrawPolygonMode(false);
    polygonReady = true;
    updateDrawButtons();
    setStatus(`Polygon ready (${polygonDraft.length} points). Enter a name and click Add zone.`);
  }

  function undoPolygonPoint() {
    if (!polygonDraft.length) return;
    polygonDraft.pop();
    polygonReady = false;
    updateDraftLayer();
    updateDrawButtons();
  }

  function bind() {
    $('#geofenceForm')?.addEventListener('submit', createGeofence);
    $('#geofenceShapeType')?.addEventListener('change', updateShapeFields);
    $('#geofencePickBtn')?.addEventListener('click', () => setPickMode(!pickMode));
    $('#geofenceMapCentreBtn')?.addEventListener('click', useMapCentre);
    $('#geofenceDrawBtn')?.addEventListener('click', () => setDrawPolygonMode(!drawPolygonMode));
    $('#geofenceFinishDrawBtn')?.addEventListener('click', finishPolygonDraw);
    $('#geofenceUndoPointBtn')?.addEventListener('click', undoPolygonPoint);
    $('#geofenceClearDrawBtn')?.addEventListener('click', () => {
      clearPolygonDraft();
      setDrawPolygonMode(false);
    });
    $('#geofenceRefreshBtn')?.addEventListener('click', () =>
      void loadGeofences().catch((e) => setStatus(String(e.message || e), true)),
    );
    $('#geofenceEditToggle')?.addEventListener('click', () => setEditGeofenceMode(!editGeofenceMode));

    const map = getMap();
    if (map) map.on('click', onMapClick);
    updateShapeFields();
    updateDrawButtons();
  }

  window.dashboardInitGeofences = function () {
    bind();
    void loadGeofences().catch((e) => setStatus(String(e.message || e), true));
  };

  window.dashboardRefreshGeofences = function () {
    void loadGeofences().catch(() => {});
  };
})();
