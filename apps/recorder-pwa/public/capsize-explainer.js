/**
 * CrewSight capsize explainer — in-memory simulation only.
 * Does not call /api, ingest, tokens, or production. No network writes.
 */
(function () {
  const HELP_ON_WAY_TEXT = 'Help is on the way — stay with the boat.';
  const PHONE_TIPPED = '⚠ CAPSIZE — boat tipped. Check crew now.';
  const PHONE_FLEET_STICKY = 'Coaches still have a CAPSIZE alert.';
  const COACH_NAME = 'Coach Tom';
  const CREW_OK = 'Crew OK — false alarm';
  const REARM_MS = 60_000;

  /** Esri World Imagery export of Lake Karāpiro (same venue as dashboard MAP_CENTER). */
  const MAP = {
    src: '/assets/capsize-explainer/karapiro-map.jpg',
    width: 1920,
    height: 1080,
    minLon: 175.528,
    maxLon: 175.578,
    minLat: -37.946,
    maxLat: -37.914,
    posX: 0.42,
    posY: 0.5,
  };

  function pinPct(lat, lon) {
    return {
      x: ((lon - MAP.minLon) / (MAP.maxLon - MAP.minLon)) * 100,
      y: ((MAP.maxLat - lat) / (MAP.maxLat - MAP.minLat)) * 100,
    };
  }

  const BOAT_DEFS = {
    alex: { id: 'alex', name: 'M1x — Alex', short: 'Alex', lat: -37.9288, lon: 175.5462 },
    sam: { id: 'sam', name: 'W2x — Sam', short: 'Sam', lat: -37.9348, lon: 175.5615 },
  };

  const SCENARIOS = [
    {
      id: 'stay',
      label: '1. Real tip, stay inverted',
      hint: 'Boat stays inverted. Red sticky CAPSIZE on RowSafe and Manager; phone siren stays. Tap On the way or Crew is safe.',
      boats: ['alex'],
      run(sim) {
        sim.tip('alex', 'Boat tipped past horizontal (2.5s)');
      },
    },
    {
      id: 'right-no-ack',
      label: '2. Tip then right, no ack',
      hint: 'Phone siren stops when upright. HUD stays “Coaches still have a CAPSIZE alert” and fleet CAPSIZE stays sticky until On the way, Crew safe, I’m OK, or 12h.',
      boats: ['alex'],
      run(sim) {
        sim.tip('alex', 'Boat tipped past horizontal (2.5s)');
        sim.later(1600, () => sim.right('alex'));
      },
    },
    {
      id: 'right-on-way',
      label: '3. Tip then right, coach on the way',
      hint: 'Boat rights, then tap Manager Acknowledge. Fleet goes amber “Coach Tom is on the way”, help message is sent, 5s shout stops — not crew safe.',
      boats: ['alex'],
      run(sim) {
        sim.tip('alex', 'Boat tipped past horizontal (2.5s)');
        sim.later(1500, () => sim.right('alex'));
      },
    },
    {
      id: 'athlete-ok',
      label: '4. Athlete I’m OK / false alarm',
      hint: 'Same tip as a real capsize (dropped phone looks identical). Tap I’m OK on the phone — crew safe, logged “Crew OK — false alarm”.',
      boats: ['alex'],
      run(sim) {
        sim.tip('alex', 'Phone past horizontal — drop / dock / false alarm looks the same');
      },
    },
    {
      id: 'offline-reconnect',
      label: '5. Tip while offline, then reconnect',
      hint: 'Tip is queued on the phone. Fleet stays quiet until reconnect, then sticky CAPSIZE appears.',
      boats: ['alex'],
      run(sim) {
        sim.setOnline('alex', false, 'Phone went offline before the tip');
        sim.later(800, () => sim.tip('alex', 'Tip while offline — queued on the phone'));
        sim.later(2600, () => sim.reconnect('alex'));
      },
    },
    {
      id: 'radio-die',
      label: '6. Underwater / radio die during tip',
      hint: 'Fleet sticky stays after the radio dies. That is the point of the latch. Phone screen goes dark.',
      boats: ['alex'],
      run(sim) {
        sim.tip('alex', 'Boat tipped past horizontal (2.5s)');
        sim.later(1600, () => sim.radioDie('alex'));
      },
    },
    {
      id: 'ack-inverted',
      label: '7. Coach ack while still inverted',
      hint: 'Tap Manager Acknowledge while the boat is still inverted. Fleet goes on-the-way; phone siren stays until they right or tap I’m OK.',
      boats: ['alex'],
      run(sim) {
        sim.tip('alex', 'Boat tipped past horizontal (2.5s)');
      },
    },
    {
      id: 'multi',
      label: '8. Multiple boats (recall is per-boat)',
      hint: 'Two devices tip. Manager Acknowledge covers unacked boats; I’m OK and RowSafe Crew is safe are per-boat.',
      boats: ['alex', 'sam'],
      run(sim) {
        sim.tip('alex', 'M1x — Alex tipped');
        sim.later(900, () => sim.tip('sam', 'W2x — Sam tipped'));
      },
    },
    {
      id: 'expire',
      label: '9. 12h max-age',
      hint: 'Trigger a sticky tip, then Fast-forward 12h. Fleet expires silently. Phone follows local tilt.',
      boats: ['alex'],
      run(sim) {
        sim.tip('alex', 'Boat tipped past horizontal (2.5s)');
      },
    },
  ];

  const state = {
    boats: {},
    log: [],
    timers: [],
    landscape: false,
    scenarioId: 'stay',
    activeBoatIds: ['alex'],
    shout: false,
  };

  const $ = (id) => document.getElementById(id);

  function nzTime(ms = Date.now()) {
    return new Intl.DateTimeFormat('en-NZ', {
      timeZone: 'Pacific/Auckland',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function onTheWayLine(name) {
    const who = String(name || '').trim();
    return who ? `${who} is on the way` : 'A coach is on the way';
  }

  function blankBoat(id) {
    const def = BOAT_DEFS[id];
    return {
      id,
      name: def.name,
      short: def.short,
      lat: def.lat,
      lon: def.lon,
      ...pinPct(def.lat, def.lon),
      inverted: false,
      online: true,
      radioDead: false,
      fleetPhase: null,
      phoneLocal: false,
      helpMessage: null,
      holdUntilUpright: false,
      lastClearAt: 0,
      respondingBy: null,
      respondingSource: null,
      tippedAt: null,
      queuedTip: false,
      logStatus: null,
      logAckedBy: null,
    };
  }

  function later(ms, fn) {
    const id = setTimeout(() => {
      state.timers = state.timers.filter((t) => t !== id);
      fn();
    }, ms);
    state.timers.push(id);
  }

  function cancelTimers() {
    for (const id of state.timers) clearTimeout(id);
    state.timers = [];
  }

  function pushLog(text, kind) {
    state.log.unshift({ at: Date.now(), text, kind: kind || 'info' });
    renderLog();
  }

  function resetBoats(ids) {
    cancelTimers();
    state.activeBoatIds = ids.slice();
    state.boats = {};
    for (const id of ids) state.boats[id] = blankBoat(id);
    state.shout = false;
  }

  function boat(id) {
    return state.boats[id];
  }

  function boats() {
    return state.activeBoatIds.map((id) => state.boats[id]).filter(Boolean);
  }

  function updateShout() {
    state.shout = boats().some((b) => b.fleetPhase === 'active');
  }

  function raiseFleet(b, detail) {
    if (b.holdUntilUpright) {
      pushLog(`${b.name}: tip ignored — hold until upright after I’m OK`);
      return;
    }
    if (b.lastClearAt && Date.now() < b.lastClearAt + REARM_MS) {
      pushLog(`${b.name}: tip ignored — 60s re-arm cooldown`);
      return;
    }
    b.fleetPhase = 'active';
    b.tippedAt = Date.now();
    b.respondingBy = null;
    b.respondingSource = null;
    b.logStatus = 'active';
    b.logAckedBy = null;
    updateShout();
    pushLog(`CAPSIZE — ${b.name} on the lake. ${detail || 'Fleet sticky raised.'}`, 'tip');
  }

  function tip(id, detail) {
    const b = boat(id);
    if (!b || b.radioDead) return;
    b.inverted = true;
    b.phoneLocal = true;
    if (!b.online) {
      b.queuedTip = true;
      pushLog(`${b.name}: ${detail || 'Tip while offline — queued on the phone'}`, 'queue');
      render();
      return;
    }
    raiseFleet(b, detail);
    render();
  }

  function right(id) {
    const b = boat(id);
    if (!b) return;
    b.inverted = false;
    b.phoneLocal = false;
    if (b.holdUntilUpright) b.holdUntilUpright = false;
    pushLog(`${b.name}: boat upright — phone banner cleared. Fleet sticky unchanged.`, 'right');
    render();
  }

  function setOnline(id, online, detail) {
    const b = boat(id);
    if (!b) return;
    b.online = online;
    if (detail) pushLog(`${b.name}: ${detail}`);
    render();
  }

  function reconnect(id) {
    const b = boat(id);
    if (!b) return;
    b.online = true;
    b.radioDead = false;
    pushLog(`${b.name}: reconnected`, 'reconnect');
    if (b.queuedTip) {
      b.queuedTip = false;
      raiseFleet(b, 'Queued tip uploaded — fleet sticky');
    }
    render();
  }

  function radioDie(id) {
    const b = boat(id);
    if (!b) return;
    b.online = false;
    b.radioDead = true;
    b.phoneLocal = false;
    pushLog(`${b.name}: radio / phone died underwater — fleet sticky remains`, 'offline');
    render();
  }

  function onTheWay(id, by, source) {
    const targets = id
      ? [boat(id)].filter(Boolean)
      : boats().filter((b) => b.fleetPhase === 'active');
    if (!targets.length) return;
    for (const b of targets) {
      if (b.fleetPhase !== 'active' && b.fleetPhase !== 'responding') continue;
      if (b.fleetPhase === 'responding') continue;
      b.fleetPhase = 'responding';
      b.respondingBy = by;
      b.respondingSource = source;
      b.helpMessage = HELP_ON_WAY_TEXT;
      b.logStatus = 'responding';
      b.logAckedBy = by;
      const via = source === 'rowsafe' ? ' (RowSafe backup)' : ' (Manager)';
      pushLog(`${onTheWayLine(by)} to ${b.name}${via} — 5s shout stopped; not crew safe`, 'onway');
    }
    updateShout();
    render();
  }

  function crewSafe(id, by, source) {
    const b = boat(id);
    if (!b || !b.fleetPhase) return;
    const falseAlarm = source === 'athlete';
    b.fleetPhase = null;
    if (falseAlarm) {
      b.phoneLocal = false;
    }
    b.respondingBy = null;
    b.respondingSource = null;
    b.holdUntilUpright = falseAlarm && b.inverted;
    b.lastClearAt = Date.now();
    b.logStatus = 'cleared';
    b.logAckedBy = falseAlarm ? CREW_OK : by;
    const line = falseAlarm ? CREW_OK : `Crew safe · ${by}`;
    const via =
      source === 'athlete' ? ' (athlete phone)' : source === 'rowsafe' ? ' (RowSafe)' : ' (Manager)';
    pushLog(`${line} — ${b.name}${via}. Fleet sticky cleared.`, 'safe');
    updateShout();
    render();
  }

  function dismissHelp(id) {
    const b = boat(id);
    if (!b || !b.helpMessage) return;
    b.helpMessage = null;
    pushLog('Athlete dismissed help-on-the-way', 'dismiss');
    render();
  }

  function expire12h() {
    let n = 0;
    for (const b of boats()) {
      if (!b.fleetPhase) continue;
      b.fleetPhase = null;
      b.helpMessage = null;
      b.respondingBy = null;
      b.respondingSource = null;
      b.logStatus = 'cleared';
      b.logAckedBy = '12h max-age';
      n += 1;
      pushLog(`${b.name}: 12h max-age — fleet sticky expired (silent clear)`, 'expire');
    }
    if (!n) pushLog('No fleet sticky to expire');
    updateShout();
    render();
  }

  function coverRect(cw, ch, iw, ih, posX, posY) {
    const scale = Math.max(cw / iw, ch / ih);
    const width = iw * scale;
    const height = ih * scale;
    return {
      left: (cw - width) * posX,
      top: (ch - height) * posY,
      width,
      height,
    };
  }

  function layoutLakeMaps() {
    document.querySelectorAll('.lake-wrap').forEach((wrap) => {
      const img = wrap.querySelector('.lake-wrap__img');
      const stage = wrap.querySelector('.lake-wrap__stage');
      if (!img || !stage) return;
      const iw = img.naturalWidth || MAP.width;
      const ih = img.naturalHeight || MAP.height;
      const r = wrap.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const box = coverRect(r.width, r.height, iw, ih, MAP.posX, MAP.posY);
      stage.style.left = `${box.left}px`;
      stage.style.top = `${box.top}px`;
      stage.style.width = `${box.width}px`;
      stage.style.height = `${box.height}px`;
    });
  }

  function lakeHtml(activeN) {
    return `<div class="lake-wrap${activeN ? ' alerting' : ''}">
      <div class="lake-wrap__stage">
        <img class="lake-wrap__img" src="${MAP.src}" alt="Lake Karāpiro — simulation, not live boats" />
        ${boatMarkers()}
      </div>
      <p class="lake-wrap__caption">Lake Karāpiro · Simulation — not live boats</p>
    </div>`;
  }

  function boatMarkers() {
    return boats()
      .map((b) => {
        const cls = [
          'boat',
          b.fleetPhase === 'active' ? 'is-capsize' : '',
          b.fleetPhase === 'responding' ? 'is-responding' : '',
          !b.online || b.radioDead ? 'is-offline' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `<div class="${cls}" style="left:${b.x}%;top:${b.y}%">
          <div class="boat__dot"></div>
          <div class="boat__name">${esc(b.short)}${b.radioDead ? ' · dead' : !b.online ? ' · off' : ''}</div>
        </div>`;
      })
      .join('');
  }

  function dayLogItems() {
    const items = boats().filter((b) => b.logStatus);
    if (!items.length) return '<li>No capsizes today</li>';
    return items
      .map((b) => {
        const extra =
          b.logStatus === 'responding'
            ? onTheWayLine(b.logAckedBy)
            : b.logStatus === 'cleared'
              ? b.logAckedBy === CREW_OK
                ? CREW_OK
                : `Crew safe · ${b.logAckedBy}`
              : 'Active — not acknowledged';
        return `<li class="st-${esc(b.logStatus)}"><strong>${esc(b.name)}</strong><br>${esc(extra)}</li>`;
      })
      .join('');
  }

  function renderRowSafe() {
    const alerts = boats().filter((b) => b.fleetPhase);
    const activeN = alerts.filter((b) => b.fleetPhase === 'active').length;
    const list = alerts.length
      ? alerts
          .map((b) => {
            const responding = b.fleetPhase === 'responding';
            return `<div class="alert-card${responding ? ' alert-card--responding' : ''}">
              <strong>${esc(b.name)}</strong>
              <p>${esc(responding ? onTheWayLine(b.respondingBy) : 'CAPSIZE — check crew now')}</p>
              <div class="row">
                ${
                  responding
                    ? ''
                    : `<button type="button" class="ack-btn" data-ack="way" data-source="rowsafe" data-id="${b.id}">On the way</button>`
                }
                <button type="button" class="safe-btn" data-ack="safe" data-source="rowsafe" data-id="${b.id}">Crew is safe</button>
              </div>
            </div>`;
          })
          .join('')
      : '<p class="empty-note">No active capsize alarms.</p>';

    $('rowsafeView').innerHTML = `
      <div class="rs-head">
        <div>
          <h2>Live fleet map</h2>
          <p>Simulation — not live boats</p>
        </div>
        <span class="ex-sim-pill ex-sim-pill--sm">Simulation — not live boats</span>
      </div>
      <div class="rs-stats">
        <span class="${activeN ? 'is-alert' : ''}">Capsize: ${alerts.length}</span>
        <span>On water: ${boats().length}</span>
        ${state.shout ? '<span class="shout">Shouting every 5s</span>' : ''}
      </div>
      <div class="rs-body">
        <aside class="rs-side">
          <h3>Capsize alerts</h3>
          <p class="sub">On the way if a coach is responding. Crew is safe when the crew is OK.</p>
          ${list}
          <h3>Today’s capsize log</h3>
          <ul class="day-log">${dayLogItems()}</ul>
        </aside>
        ${lakeHtml(activeN)}
      </div>
    `;
  }

  function renderPhone(el, b) {
    if (!el || !b) {
      if (el) el.innerHTML = '';
      return;
    }
    if (b.radioDead) {
      el.innerHTML = `
        <div class="hud">
          <div class="hud__chrome"><span>${esc(b.short)}</span><span>REC</span></div>
          <div class="hud__dead">Signal lost · underwater<br>Fleet sticky stays on RowSafe / Manager.</div>
          <p class="empty-note">Simulation — not live boats</p>
        </div>`;
      return;
    }
    const showAlert = b.phoneLocal || Boolean(b.fleetPhase);
    const sticky = !b.phoneLocal && Boolean(b.fleetPhase);
    const alertText = b.phoneLocal ? PHONE_TIPPED : PHONE_FLEET_STICKY;
    el.innerHTML = `
      <div class="hud">
        <div class="hud__chrome">
          <span>12:04 · ${esc(b.short)}</span>
          <button type="button" class="hud__stop">Stop</button>
        </div>
        ${
          showAlert
            ? `<div class="hud__alert${sticky ? ' is-sticky' : ''}" role="alert">
                <p>${esc(alertText)}</p>
                <button type="button" class="ok-btn" data-ack="safe" data-source="athlete" data-id="${b.id}">I'm OK — recall alarm</button>
              </div>`
            : ''
        }
        ${
          b.helpMessage
            ? `<div class="hud__help" role="status" aria-live="polite">
                <span>Help on the way</span>
                <p>${esc(b.helpMessage)}</p>
                <button type="button" class="hud__help-dismiss" data-dismiss-help="${b.id}">Dismiss</button>
              </div>`
            : ''
        }
        <div class="hud__metrics">
          <div class="hud__metric"><b>1:52</b><span>500m</span></div>
          <div class="hud__metric"><b>28</b><span>spm</span></div>
          <div class="hud__metric"><b>${b.inverted ? 'TIP' : '4.3'}</b><span>${b.inverted ? 'tilt' : 'm/s'}</span></div>
        </div>
        <div class="hud__metric"><b>Karāpiro</b><span>${b.inverted ? 'Inverted · check crew' : 'On lake'}</span></div>
        <p class="empty-note">${b.online ? 'Recording · on the lake' : 'Offline — events queued'}${b.queuedTip ? ' · queued tip' : ''}</p>
        <p class="empty-note">Simulation — not live boats</p>
      </div>
    `;
  }

  function renderPhones() {
    const ids = state.activeBoatIds;
    const second = $('phoneBezelB');
    renderPhone($('phoneView'), boat(ids[0]));
    if (ids[1]) {
      second.hidden = false;
      renderPhone($('phoneViewB'), boat(ids[1]));
    } else {
      second.hidden = true;
      $('phoneViewB').innerHTML = '';
    }
    $('phoneStage').classList.toggle('is-landscape', state.landscape);
    $('phoneOrientBtn').textContent = state.landscape ? 'Landscape' : 'Portrait';
    $('phoneOrientBtn').setAttribute('aria-pressed', state.landscape ? 'true' : 'false');
  }

  function managerBannerText() {
    const caps = boats().filter((b) => b.fleetPhase);
    const active = caps.filter((b) => b.fleetPhase === 'active');
    const responding = caps.filter((b) => b.fleetPhase === 'responding');
    const parts = [];
    if (active.length) {
      parts.push(
        `${active.length} CAPSIZE: ${active.map((b) => b.short).join(', ')} — check crew now. Tap Acknowledge when you are on the way.`,
      );
    }
    if (responding.length) {
      const named = responding.map((b) => b.respondingBy).find(Boolean);
      parts.push(
        `${onTheWayLine(named)} to ${responding.map((b) => b.short).join(', ')}. Tap Crew safe when the crew is OK.`,
      );
    }
    return parts.join(' ');
  }

  function renderManager() {
    const caps = boats().filter((b) => b.fleetPhase);
    const activeN = caps.filter((b) => b.fleetPhase === 'active').length;
    const tickets = boats()
      .map((b) => {
        const cls =
          b.fleetPhase === 'active' ? ' is-capsize' : b.fleetPhase === 'responding' ? ' is-responding' : '';
        const line =
          b.fleetPhase === 'active'
            ? 'CAPSIZE'
            : b.fleetPhase === 'responding'
              ? onTheWayLine(b.respondingBy)
              : b.online
                ? 'On water'
                : 'Offline';
        return `<div class="ticket${cls}"><b>${esc(b.name)}</b>${esc(line)}</div>`;
      })
      .join('');

    $('managerView').innerHTML = `
      <div class="mgr-head">
        <div>
          <h2>CrewSight Manager</h2>
          <p>${esc(COACH_NAME)} · Monitoring · Simulation — not live boats</p>
        </div>
        <span class="ex-sim-pill ex-sim-pill--sm">Simulation — not live boats</span>
      </div>
      ${
        caps.length
          ? `<div class="mgr-banner${activeN === 0 ? ' is-responding' : ''}" role="alert">
              <span>${esc(managerBannerText())}</span>
              <div class="row">
                ${
                  activeN
                    ? `<button type="button" class="ack-btn" data-ack="way" data-source="manager">Acknowledge — on the way</button>`
                    : ''
                }
                <button type="button" class="safe-btn" data-ack="safe" data-source="manager">Crew is safe</button>
              </div>
            </div>`
          : ''
      }
      <div class="mgr-body">
        <aside class="mgr-side">
          <h3>On water</h3>
          ${tickets}
          <h3>Today’s capsize log</h3>
          <ul class="day-log">${dayLogItems()}</ul>
          ${state.shout ? '<p class="shout">Beep + “Capsize alert” every 5s</p>' : ''}
        </aside>
        ${lakeHtml(activeN)}
      </div>
    `;
  }

  function renderLog() {
    const el = $('eventLog');
    if (!state.log.length) {
      el.innerHTML = '<li class="ex-log--empty">Log is empty.</li>';
      return;
    }
    el.innerHTML = state.log
      .map((e) => `<li><time>${esc(nzTime(e.at))}</time><span>${esc(e.text)}</span></li>`)
      .join('');
  }

  function render() {
    renderRowSafe();
    renderPhones();
    renderManager();
    document.querySelectorAll('.lake-wrap__img').forEach((img) => {
      if (img.complete) layoutLakeMaps();
      else img.addEventListener('load', layoutLakeMaps, { once: true });
    });
    layoutLakeMaps();
  }

  function currentScenario() {
    return SCENARIOS.find((s) => s.id === state.scenarioId) || SCENARIOS[0];
  }

  function applyScenarioMeta() {
    const s = currentScenario();
    $('scenarioHint').textContent = s.hint;
    resetBoats(s.boats);
    render();
  }

  function trigger() {
    const s = currentScenario();
    resetBoats(s.boats);
    pushLog(`Scenario: ${s.label}`, 'scene');
    s.run({
      tip,
      right,
      later,
      setOnline,
      reconnect,
      radioDie,
    });
    render();
  }

  function handleAck(event) {
    const el = event.target instanceof Element ? event.target : event.target.parentElement;
    const dismissBtn = el && el.closest('[data-dismiss-help]');
    if (dismissBtn) {
      dismissHelp(dismissBtn.getAttribute('data-dismiss-help'));
      return;
    }
    const btn = el && el.closest('[data-ack]');
    if (!btn) return;
    const kind = btn.getAttribute('data-ack');
    const source = btn.getAttribute('data-source');
    const id = btn.getAttribute('data-id');
    if (kind === 'way') {
      const by = source === 'manager' ? COACH_NAME : 'RowSafe';
      onTheWay(id, by, source);
      return;
    }
    if (source === 'manager') {
      for (const b of boats().filter((x) => x.fleetPhase)) {
        crewSafe(b.id, COACH_NAME, 'manager');
      }
      return;
    }
    crewSafe(id, source === 'athlete' ? CREW_OK : 'RowSafe', source);
  }

  function fillSelect() {
    const sel = $('scenarioSelect');
    sel.innerHTML = SCENARIOS.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
    sel.value = state.scenarioId;
  }

  function bind() {
    fillSelect();
    $('scenarioSelect').addEventListener('change', () => {
      state.scenarioId = $('scenarioSelect').value;
      applyScenarioMeta();
    });
    $('triggerBtn').addEventListener('click', trigger);
    $('rightBtn').addEventListener('click', () => {
      for (const b of boats()) {
        if (b.inverted) right(b.id);
      }
    });
    $('fastForwardBtn').addEventListener('click', expire12h);
    $('resetBtn').addEventListener('click', () => {
      applyScenarioMeta();
      pushLog('Views reset — log kept');
    });
    $('clearLogBtn').addEventListener('click', () => {
      state.log = [];
      renderLog();
    });
    $('phoneOrientBtn').addEventListener('click', () => {
      state.landscape = !state.landscape;
      renderPhones();
    });
    document.addEventListener('click', handleAck);
    window.addEventListener('resize', layoutLakeMaps);
    applyScenarioMeta();
    renderLog();
  }

  bind();
})();
