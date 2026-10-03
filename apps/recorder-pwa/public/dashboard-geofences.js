/**
 * Dashboard geofence zone management (Leaflet circles + polygons + /api/geofences).
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  let pickMode = false;
  let drawPolygonMode = false;
  let polygonDraft = [];
  let polygonReady = false;
  let geofences = [];
  let editGeofenceMode = false;
  /** @type {string|number|null} */
  let editingId = null;
  const layersByMap = new WeakMap();
  const clickBound = new WeakSet();

  const GEOFENCE_STYLE = {
    color: '#f59e0b',
    fillColor: '#f59e0b',
    fillOpacity: 0.12,
    weight: 2,
    dashArray: '6 4',
  };

  const HAZARD_STYLE = {
    color: '#dc2626',
    fillColor: '#ef4444',
    fillOpacity: 0.2,
    weight: 3,
    dashArray: '2 6',
  };

  const LAKE_SHORE_STYLE = {
    color: '#94a3b8',
    fillOpacity: 0,
    weight: 2,
    dashArray: '4 3',
  };

  const LAKE_MASK_OUTER = [
    [-85, -180],
    [-85, 180],
    [85, 180],
    [85, -180],
  ];

  function kindOf(g) {
    const k = String(g?.kind || 'boat_park').toLowerCase();
    if (k === 'hazard') return 'hazard';
    if (k === 'lake' || k === 'water') return 'lake';
    return 'boat_park';
  }

  function styleForGeofence(g) {
    return kindOf(g) === 'hazard' ? HAZARD_STYLE : GEOFENCE_STYLE;
  }

  function isHazard(g) {
    return kindOf(g) === 'hazard';
  }

  function isLake(g) {
    return kindOf(g) === 'lake';
  }

  function circleToRing(lat, lon, radiusM, steps = 72) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusM > 0)) return [];
    const ring = [];
    const metersPerDegLat = 111320;
    const metersPerDegLon = Math.max(1e-6, 111320 * Math.cos((lat * Math.PI) / 180));
    const dLat = radiusM / metersPerDegLat;
    const dLon = radiusM / metersPerDegLon;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      ring.push([lat + dLat * Math.sin(a), lon + dLon * Math.cos(a)]);
    }
    return ring;
  }

  function lakeHoleRing(g) {
    if (g.shapeType === 'polygon' && Array.isArray(g.polygonCoords) && g.polygonCoords.length >= 3) {
      return g.polygonCoords.map((pt) => [Number(pt[0]), Number(pt[1])]);
    }
    return circleToRing(Number(g.centerLat), Number(g.centerLon), Number(g.radiusM));
  }

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

  function workMaps() {
    if (typeof window.dashboardWorkMaps === 'function') return window.dashboardWorkMaps();
    return [window.dashboardSetupMap, window.dashboardFleetMap].filter(Boolean);
  }

  function getMap() {
    if (typeof window.dashboardEditMap === 'function') return window.dashboardEditMap();
    return window.dashboardSetupMap || window.dashboardFleetMap || null;
  }

  function layersFor(map) {
    if (!map || typeof L === 'undefined') return null;
    let layers = layersByMap.get(map);
    if (!layers) {
      layers = {
        geofence: L.layerGroup().addTo(map),
        draft: L.layerGroup().addTo(map),
        edit: L.layerGroup().addTo(map),
      };
      layersByMap.set(map, layers);
    }
    return layers;
  }

  function setMapsCursor(cursor) {
    for (const map of workMaps()) {
      map.getContainer().style.cursor = cursor || '';
    }
  }

  function bindMapClicks() {
    for (const map of workMaps()) {
      if (clickBound.has(map)) continue;
      clickBound.add(map);
      map.on('click', onMapClick);
    }
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
    const kind = kindOf(g);
    const kindLabel =
      kind === 'hazard' ? 'Hazard zone' : kind === 'lake' ? 'Lake boundary' : 'Boat park';
    const suppressLabel =
      kind === 'lake'
        ? g.suppressRecording
          ? 'paused outside'
          : 'record outside on'
        : g.suppressRecording
          ? 'paused'
          : 'on';
    const stopLabel =
      kind === 'lake'
        ? g.autoStopOnEnter
          ? 'stop outside'
          : 'stop off'
        : g.autoStopOnEnter
          ? 'stop'
          : 'stop off';
    const startLabel =
      kind === 'lake'
        ? g.autoStartOnExit
          ? 'start inside'
          : 'start off'
        : g.autoStartOnExit
          ? 'start'
          : 'start off';
    return `<strong>${esc(g.name)}</strong><br>${kindLabel} · ${shape}<br>Every ${g.economyIntervalSec ?? g.economyGpsIntervalSec ?? 30}s · capsize ${g.disableCapsize ? 'off' : 'on'} · record ${suppressLabel} · auto ${stopLabel} / ${startLabel}`;
  }

  function drawGeofences() {
    if (typeof L === 'undefined') return;
    for (const map of workMaps()) {
      const layers = layersFor(map);
      if (!layers) continue;
      layers.geofence.clearLayers();
      layers.edit.clearLayers();
      for (const g of geofences) {
        if (!g.enabled) continue;
        if (isLake(g)) {
          const hole = lakeHoleRing(g);
          if (hole.length < 3) continue;
          const mask = L.polygon([LAKE_MASK_OUTER, hole], {
            color: '#475569',
            fillColor: '#1e293b',
            fillOpacity: 0.45,
            stroke: false,
            interactive: false,
          });
          layers.geofence.addLayer(mask);
          const shore = L.polygon(hole, LAKE_SHORE_STYLE);
          shore.bindPopup(popupHtml(g));
          layers.geofence.addLayer(shore);
          if (editGeofenceMode) attachGeofenceEditHandles(g, layers.edit);
          continue;
        }
        const style = styleForGeofence(g);
        let layer;
        if (g.shapeType === 'polygon' && Array.isArray(g.polygonCoords) && g.polygonCoords.length >= 3) {
          layer = L.polygon(
            g.polygonCoords.map((pt) => [pt[0], pt[1]]),
            style,
          );
        } else {
          layer = L.circle([g.centerLat, g.centerLon], {
            radius: g.radiusM,
            ...style,
          });
        }
        layer.bindPopup(popupHtml(g));
        layers.geofence.addLayer(layer);
        if (editGeofenceMode) attachGeofenceEditHandles(g, layers.edit);
      }
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

  function attachGeofenceEditHandles(g, editLayer) {
    if (!editLayer) return;

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
          .addTo(editLayer);
      });
      return;
    }

    L.marker([g.centerLat, g.centerLon], { draggable: true, icon: handleIcon })
      .on('dragend', (e) => {
        const { lat, lng } = e.target.getLatLng();
        void saveGeofenceGeometry(g.id, { centerLat: lat, centerLon: lng });
      })
      .addTo(editLayer);

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
      .addTo(editLayer);
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
    if (!on) {
      for (const map of workMaps()) layersFor(map)?.edit.clearLayers();
    }
    drawGeofences();
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
    if (typeof L === 'undefined') return;
    for (const map of workMaps()) {
      const layers = layersFor(map);
      if (!layers) continue;
      layers.draft.clearLayers();
      if (!polygonDraft.length) continue;

      const latLngs = polygonDraft.map((p) => [p.lat, p.lon]);
      if (polygonDraft.length >= 2) {
        L.polyline(latLngs, {
          color: '#f59e0b',
          weight: 2,
          dashArray: '4 6',
        }).addTo(layers.draft);
      }
      if (polygonDraft.length >= 3) {
        L.polygon(latLngs, {
          color: '#f59e0b',
          fillColor: '#f59e0b',
          fillOpacity: 0.08,
          weight: 2,
        }).addTo(layers.draft);
      }
      for (const p of polygonDraft) {
        L.circleMarker([p.lat, p.lon], {
          radius: 5,
          color: '#f59e0b',
          fillColor: '#fff',
          fillOpacity: 1,
          weight: 2,
        }).addTo(layers.draft);
      }
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
    updateDraftLayer();
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
    if (map && !drawPolygonMode) setMapsCursor(on ? 'crosshair' : '');
  }

  function setDrawPolygonMode(on) {
    if (on) setPickMode(false);
    drawPolygonMode = on;
    if (!on && polygonDraft.length >= 3) polygonReady = true;
    setMapsCursor(on ? 'crosshair' : '');
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
        '<p class="poll-line">No geofence zones yet. Add a circle below or draw a polygon on the map.</p>';
      return;
    }
    el.innerHTML = geofences
      .map((g) => {
        const editing = String(editingId) === String(g.id);
        return `
      <div class="geofence-item${isHazard(g) ? ' geofence-item--hazard' : ''}${isLake(g) ? ' geofence-item--lake' : ''}${editing ? ' geofence-item--editing' : ''}" data-id="${g.id}">
        <div class="geofence-item__main">
          <strong>${esc(g.name)}</strong>
          <span class="geofence-item__meta">${isHazard(g) ? 'Hazard' : isLake(g) ? 'Lake' : 'Boat park'} · ${esc(shapeSummary(g))}</span>
          <span class="geofence-item__meta">Economy: every ${g.economyIntervalSec ?? g.economyGpsIntervalSec ?? 30}s · capsize ${g.disableCapsize ? 'off' : 'on'} · record ${g.suppressRecording ? 'paused' : 'on'} · dwell ${g.sessionDwellSec ?? 45}s · auto-stop ${g.autoStopOnEnter ? 'on' : 'off'} · auto-start ${g.autoStartOnExit ? 'on' : 'off'} · notify ${g.notifyOnEnter ? 'on' : 'off'}${g.notifyOnEnter && g.entryNotifyMessage ? ` · “${esc(g.entryNotifyMessage)}”` : ''}</span>
        </div>
        <div class="geofence-item__actions">
          <button type="button" class="hub-btn hub-btn--ghost geofence-edit-btn" data-id="${g.id}">${editing ? 'Editing…' : 'Edit'}</button>
          <button type="button" class="hub-btn hub-btn--danger geofence-delete-btn" data-id="${g.id}">Delete</button>
        </div>
      </div>`;
      })
      .join('');
    el.querySelectorAll('.geofence-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => void deleteGeofence(btn.getAttribute('data-id')));
    });
    el.querySelectorAll('.geofence-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => beginEdit(btn.getAttribute('data-id')));
    });
  }

  function syncFormModeUi() {
    const editing = editingId != null && String(editingId) !== '';
    const title = $('#geofenceFormTitle');
    const hint = $('#geofenceFormHint');
    const submit = $('#geofenceSubmitBtn');
    const cancel = $('#geofenceCancelEditBtn');
    const idInput = $('#geofenceEditId');
    if (idInput) idInput.value = editing ? String(editingId) : '';
    if (title) title.textContent = editing ? 'Edit zone' : 'Add zone';
    if (hint && !editing) {
      hint.textContent = 'Create a boat-park, lake boundary, or hazard zone.';
    } else if (hint && editing) {
      hint.textContent = 'Update the selected zone, then Save changes.';
    }
    if (submit) submit.textContent = editing ? 'Save changes' : 'Add zone';
    if (cancel) cancel.hidden = !editing;
    $('#geofenceForm')?.classList.toggle('geofence-form--editing', editing);
  }

  function resetFormDefaults() {
    $('#geofenceForm')?.reset();
    if ($('#geofenceIntervalSec')) $('#geofenceIntervalSec').value = '30';
    if ($('#geofenceDwellSec')) $('#geofenceDwellSec').value = '45';
    if ($('#geofenceRadius')) $('#geofenceRadius').value = '150';
    if ($('#geofenceDisableCapsize')) $('#geofenceDisableCapsize').checked = true;
    if ($('#geofenceSuppressRecording')) $('#geofenceSuppressRecording').checked = false;
    if ($('#geofenceAutoStop')) $('#geofenceAutoStop').checked = false;
    if ($('#geofenceAutoStart')) $('#geofenceAutoStart').checked = false;
    if ($('#geofenceNotifyEnter')) $('#geofenceNotifyEnter').checked = false;
    if ($('#geofenceNotifyMessage')) $('#geofenceNotifyMessage').value = '';
    if ($('#geofenceKind')) $('#geofenceKind').value = 'boat_park';
    if ($('#geofenceShapeType')) $('#geofenceShapeType').value = 'circle';
    clearPolygonDraft();
    updateShapeFields();
    onKindChange({ applyDefaults: false });
  }

  function cancelEdit() {
    editingId = null;
    resetFormDefaults();
    syncFormModeUi();
    renderList();
    setStatus('Edit cancelled.');
  }

  function beginEdit(id) {
    if (!id) return;
    const g = geofences.find((x) => String(x.id) === String(id));
    if (!g) {
      setStatus('Zone not found.', true);
      return;
    }
    editingId = g.id;
    if ($('#geofenceName')) $('#geofenceName').value = g.name || '';
    if ($('#geofenceKind')) $('#geofenceKind').value = kindOf(g);
    onKindChange({ applyDefaults: false });
    if ($('#geofenceIntervalSec')) {
      $('#geofenceIntervalSec').value = String(g.economyIntervalSec ?? g.economyGpsIntervalSec ?? 30);
    }
    if ($('#geofenceDwellSec')) $('#geofenceDwellSec').value = String(g.sessionDwellSec ?? 45);
    if ($('#geofenceDisableCapsize')) $('#geofenceDisableCapsize').checked = g.disableCapsize !== false;
    if ($('#geofenceSuppressRecording')) {
      $('#geofenceSuppressRecording').checked = g.suppressRecording === true;
    }
    if ($('#geofenceAutoStop')) $('#geofenceAutoStop').checked = g.autoStopOnEnter === true;
    if ($('#geofenceAutoStart')) $('#geofenceAutoStart').checked = g.autoStartOnExit === true;
    if ($('#geofenceNotifyEnter')) $('#geofenceNotifyEnter').checked = g.notifyOnEnter === true;
    if ($('#geofenceNotifyMessage')) {
      $('#geofenceNotifyMessage').value = g.entryNotifyMessage || '';
    }

    const isPoly =
      g.shapeType === 'polygon' && Array.isArray(g.polygonCoords) && g.polygonCoords.length >= 3;
    if ($('#geofenceShapeType')) $('#geofenceShapeType').value = isPoly ? 'polygon' : 'circle';
    if (isPoly) {
      polygonDraft = g.polygonCoords.map((pt) => ({ lat: Number(pt[0]), lon: Number(pt[1]) }));
      polygonReady = true;
      setDrawPolygonMode(false);
      updateDraftLayer();
      updateDrawButtons();
      if ($('#geofenceLat')) $('#geofenceLat').value = '';
      if ($('#geofenceLon')) $('#geofenceLon').value = '';
      if ($('#geofenceRadius')) $('#geofenceRadius').value = '150';
    } else {
      clearPolygonDraft();
      if ($('#geofenceLat')) $('#geofenceLat').value = String(g.centerLat ?? '');
      if ($('#geofenceLon')) $('#geofenceLon').value = String(g.centerLon ?? '');
      if ($('#geofenceRadius')) $('#geofenceRadius').value = String(g.radiusM ?? 150);
    }
    updateShapeFields();
    syncFormModeUi();
    renderList();
    setStatus(`Editing “${g.name}”. Change fields and click Save changes.`);
    $('#geofenceForm')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('#geofenceName')?.focus();
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
    if (String(editingId) === String(id)) {
      editingId = null;
      resetFormDefaults();
      syncFormModeUi();
    }
    await loadGeofences();
  }

  function buildPayloadFromForm() {
    const name = $('#geofenceName')?.value?.trim();
    const shapeType = currentShapeType();
    const economyIntervalSec = Number($('#geofenceIntervalSec')?.value) || 30;
    const sessionDwellSec = Number($('#geofenceDwellSec')?.value) || 45;
    const disableCapsize = $('#geofenceDisableCapsize')?.checked !== false;
    const suppressRecording = $('#geofenceSuppressRecording')?.checked === true;
    const autoStopOnEnter = $('#geofenceAutoStop')?.checked === true;
    const autoStartOnExit = $('#geofenceAutoStart')?.checked === true;
    const notifyOnEnter = $('#geofenceNotifyEnter')?.checked === true;
    const entryNotifyMessage = $('#geofenceNotifyMessage')?.value?.trim() || '';
    const kindRaw = $('#geofenceKind')?.value;
    const kind =
      kindRaw === 'hazard' ? 'hazard' : kindRaw === 'lake' ? 'lake' : 'boat_park';

    if (!name) {
      setStatus('Name is required.', true);
      return null;
    }

    let payload = {
      name,
      kind,
      shapeType,
      economyIntervalSec,
      sessionDwellSec,
      disableCapsize,
      suppressRecording,
      autoStopOnEnter,
      autoStartOnExit,
      notifyOnEnter: kind === 'hazard' ? notifyOnEnter || true : notifyOnEnter,
      entryNotifyMessage,
    };

    if (shapeType === 'polygon') {
      if (!polygonReady || polygonDraft.length < 3) {
        setStatus('Draw a polygon on the map with at least 3 points, then Finish polygon.', true);
        return null;
      }
      payload.polygonCoords = polygonDraft.map((p) => [p.lat, p.lon]);
    } else {
      const centerLat = Number($('#geofenceLat')?.value);
      const centerLon = Number($('#geofenceLon')?.value);
      const radiusM = Number($('#geofenceRadius')?.value);
      if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
        setStatus('Latitude and longitude are required.', true);
        return null;
      }
      if (!Number.isFinite(radiusM) || radiusM <= 0) {
        setStatus('Radius must be a positive number (metres).', true);
        return null;
      }
      payload = { ...payload, centerLat, centerLon, radiusM };
    }
    return payload;
  }

  async function saveGeofence(ev) {
    ev.preventDefault();
    const payload = buildPayloadFromForm();
    if (!payload) return;

    const editing = editingId != null && String(editingId) !== '';
    setStatus(editing ? 'Saving changes…' : 'Saving…');
    const url = editing
      ? `${apiBase()}/api/geofences?id=${encodeURIComponent(String(editingId))}`
      : `${apiBase()}/api/geofences`;
    const res = await fetch(url, {
      method: editing ? 'PATCH' : 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setStatus(data.error || 'Save failed', true);
      return;
    }
    editingId = null;
    resetFormDefaults();
    syncFormModeUi();
    await loadGeofences();
    setStatus(editing ? 'Zone updated.' : 'Zone added.');
  }

  function onKindChange(opts = {}) {
    const applyDefaults = opts.applyDefaults !== false;
    const kind = $('#geofenceKind')?.value || 'boat_park';
    const hint = $('#geofenceBehaviourHint');
    const legend = $('#geofenceBehaviourLegend');
    const formHint = $('#geofenceFormHint');

    if (kind === 'lake') {
      if (legend) legend.textContent = 'Outside-lake behaviour';
      if (hint) {
        hint.textContent =
          'Lake boundary: apply these while OUTSIDE the polygon. Inside the lake, map colours stay normal and recording runs fully.';
      }
      if (formHint) {
        formHint.textContent =
          'Draw the lake shoreline. Outside is greyed on the map; leave suppress + auto-stop on to stop tracking if a phone leaves the lake.';
      }
      const shape = $('#geofenceShapeType');
      if (shape && applyDefaults) {
        shape.value = 'polygon';
        updateShapeFields();
      }
      if (applyDefaults) {
        if ($('#geofenceSuppressRecording')) $('#geofenceSuppressRecording').checked = true;
        if ($('#geofenceAutoStop')) $('#geofenceAutoStop').checked = true;
        if ($('#geofenceAutoStart')) $('#geofenceAutoStart').checked = true;
        if ($('#geofenceDisableCapsize')) $('#geofenceDisableCapsize').checked = false;
        if ($('#geofenceName') && !$('#geofenceName').value.trim()) {
          $('#geofenceName').placeholder = 'Lake Karapiro';
        }
      }
      if ($('#geofenceDisableCapsizeLabel')) {
        $('#geofenceDisableCapsizeLabel').textContent = 'Disable capsize outside lake';
      }
      if ($('#geofenceSuppressLabel')) {
        $('#geofenceSuppressLabel').textContent = 'Suppress recording outside lake';
      }
      if ($('#geofenceAutoStopLabel')) {
        $('#geofenceAutoStopLabel').textContent = 'Auto-stop session when outside';
      }
      if ($('#geofenceAutoStartLabel')) {
        $('#geofenceAutoStartLabel').textContent = 'Auto-start when entering lake (standby)';
      }
      return;
    }

    if (legend) legend.textContent = 'In-zone behaviour';
    if (hint) hint.textContent = 'Boat park: apply these while inside the zone.';
    if (formHint) formHint.textContent = 'Create a boat-park, lake boundary, or hazard zone.';
    if ($('#geofenceDisableCapsizeLabel')) {
      $('#geofenceDisableCapsizeLabel').textContent = 'Disable capsize in zone';
    }
    if ($('#geofenceSuppressLabel')) {
      $('#geofenceSuppressLabel').textContent = 'Suppress recording in zone';
    }
    if ($('#geofenceAutoStopLabel')) {
      $('#geofenceAutoStopLabel').textContent = 'Auto-stop session on enter';
    }
    if ($('#geofenceAutoStartLabel')) {
      $('#geofenceAutoStartLabel').textContent = 'Auto-start on exit (standby)';
    }

    if (kind !== 'hazard') return;
    const notify = $('#geofenceNotifyEnter');
    if (notify && applyDefaults && !notify.checked) notify.checked = true;
    const msg = $('#geofenceNotifyMessage');
    const name = $('#geofenceName')?.value?.trim();
    if (msg && !msg.value.trim() && name) {
      msg.placeholder = `Please check course, ${name} ahead`;
    }
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
    setStatus(`Polygon ready (${polygonDraft.length} points). Enter a name and click ${editingId != null ? 'Save changes' : 'Add zone'}.`);
  }

  function undoPolygonPoint() {
    if (!polygonDraft.length) return;
    polygonDraft.pop();
    polygonReady = false;
    updateDraftLayer();
    updateDrawButtons();
  }

  function bind() {
    $('#geofenceForm')?.addEventListener('submit', (ev) => void saveGeofence(ev));
    $('#geofenceCancelEditBtn')?.addEventListener('click', cancelEdit);
    $('#geofenceKind')?.addEventListener('change', onKindChange);
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

    bindMapClicks();
    updateShapeFields();
    updateDrawButtons();
    syncFormModeUi();
  }

  window.dashboardInitGeofences = function () {
    bind();
    void loadGeofences().catch((e) => setStatus(String(e.message || e), true));
  };

  window.dashboardRefreshGeofences = function () {
    void loadGeofences().catch(() => {});
  };
})();
