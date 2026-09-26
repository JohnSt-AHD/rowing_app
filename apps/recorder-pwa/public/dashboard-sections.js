/**
 * Collapsible dashboard sections + fleet map fullscreen.
 */
(function () {
  const LS_SECTIONS = 'rnz_dashboard_sections';

  const $ = (sel) => document.querySelector(sel);

  function loadSectionState() {
    try {
      const raw = localStorage.getItem(LS_SECTIONS);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveSectionState(state) {
    localStorage.setItem(LS_SECTIONS, JSON.stringify(state));
  }

  function invalidateMap() {
    const map = window.dashboardFleetMap;
    if (!map) return;
    setTimeout(() => map.invalidateSize(), 80);
    setTimeout(() => map.invalidateSize(), 320);
  }

  function setSectionOpen(section, open, persist = true) {
    const id = section.dataset.sectionId;
    if (!id) return;
    const body = section.querySelector('.dashboard-section__body');
    const toggle = section.querySelector('.dashboard-section__toggle');
    section.classList.toggle('dashboard-section--open', open);
    if (body) body.hidden = !open;
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (persist) {
      const state = loadSectionState();
      state[id] = open;
      saveSectionState(state);
    }
    if (id === 'map' && open) invalidateMap();
  }

  function initSections() {
    const saved = loadSectionState();
    document.querySelectorAll('.dashboard-section[data-section-id]').forEach((section) => {
      const id = section.dataset.sectionId;
      const defaultOpen = section.dataset.defaultOpen === 'true';
      const open = Object.prototype.hasOwnProperty.call(saved, id)
        ? Boolean(saved[id])
        : defaultOpen;
      setSectionOpen(section, open, false);
    });

    document.querySelectorAll('.dashboard-section__toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const section = btn.closest('.dashboard-section');
        if (!section) return;
        const open = !section.classList.contains('dashboard-section--open');
        setSectionOpen(section, open);
      });
    });
  }

  function isMapFullscreen() {
    const stage = $('#mapStage');
    if (!stage) return false;
    return (
      document.fullscreenElement === stage ||
      stage.classList.contains('map-stage--fullscreen')
    );
  }

  function setMapFullscreen(on) {
    const stage = $('#mapStage');
    if (!stage) return;
    const bar = stage.querySelector('.map-fs-bar');
    if (on) {
      stage.classList.add('map-stage--fullscreen');
      if (bar) bar.removeAttribute('hidden');
      if (stage.requestFullscreen) {
        void stage.requestFullscreen().catch(() => {});
      }
    } else {
      stage.classList.remove('map-stage--fullscreen');
      if (bar) bar.setAttribute('hidden', '');
      if (document.fullscreenElement === stage) {
        void document.exitFullscreen().catch(() => {});
      }
    }
    invalidateMap();
  }

  function initMapFullscreen() {
    const stage = $('#mapStage');
    if (!stage) return;

    $('#mapFullscreenBtn')?.addEventListener('click', () => {
      setMapFullscreen(true);
    });
    $('#mapFullscreenExitBtn')?.addEventListener('click', () => {
      setMapFullscreen(false);
    });

    document.addEventListener('fullscreenchange', () => {
      if (!stage) return;
      if (document.fullscreenElement === stage) {
        stage.classList.add('map-stage--fullscreen');
        stage.querySelector('.map-fs-bar')?.removeAttribute('hidden');
      } else {
        stage.classList.remove('map-stage--fullscreen');
        stage.querySelector('.map-fs-bar')?.setAttribute('hidden', '');
      }
      invalidateMap();
    });
  }

  const VIEW_BY_SECTION = {
    map: 'live',
    devices: 'live',
    history: 'history',
    'capsize-emails': 'setup',
    regatta: 'setup',
    geofences: 'setup',
    'monitor-stats': 'setup',
    settings: 'setup',
    'data-manage': 'setup',
  };

  function currentView() {
    return document.body.getAttribute('data-dashboard-view') || 'live';
  }

  function setDashboardView(view, opts = {}) {
    const next = view === 'history' || view === 'setup' ? view : 'live';
    document.body.setAttribute('data-dashboard-view', next);
    document.querySelectorAll('.dashboard-view').forEach((el) => {
      const show =
        el.classList.contains(`dashboard-view--${next}`) ||
        (next === 'setup' && el.classList.contains('dashboard-view--setup'));
      el.hidden = !show;
    });
    document.querySelectorAll('.dashboard-view-nav [data-dashboard-view]').forEach((btn) => {
      if (btn === document.body) return;
      const on = btn.getAttribute('data-dashboard-view') === next;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (next === 'live') {
      const mapSection = document.querySelector('.dashboard-section[data-section-id="map"]');
      const devicesSection = document.querySelector('.dashboard-section[data-section-id="devices"]');
      if (mapSection) setSectionOpen(mapSection, true, false);
      if (devicesSection) setSectionOpen(devicesSection, true, false);
      invalidateMap();
      setTimeout(invalidateMap, 200);
    }
    if (next === 'history') {
      const historySection = document.querySelector('.dashboard-section[data-section-id="history"]');
      if (historySection) setSectionOpen(historySection, true, false);
    }
    if (!opts.skipHash) {
      const hash = next === 'live' ? '' : `#${next}`;
      if (hash !== location.hash) {
        window.history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
      }
    }
  }

  window.dashboardInitSections = function () {
    initSections();
    initMapFullscreen();
    initViewNav();
    const fromHash = (location.hash || '').replace('#', '');
    setDashboardView(fromHash === 'history' || fromHash === 'setup' ? fromHash : 'live', {
      skipHash: true,
    });
  };

  function openSectionById(id, scroll = true) {
    const view = VIEW_BY_SECTION[id] || 'setup';
    setDashboardView(view);
    const section = document.querySelector(`.dashboard-section[data-section-id="${id}"]`);
    if (!section) return;
    setSectionOpen(section, true);
    if (scroll && view !== 'live') {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function initViewNav() {
    document.querySelectorAll('.dashboard-view-nav [data-dashboard-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setDashboardView(btn.getAttribute('data-dashboard-view'));
      });
    });
    window.addEventListener('hashchange', () => {
      const fromHash = (location.hash || '').replace('#', '');
      if (fromHash === 'history' || fromHash === 'setup' || fromHash === 'live' || !fromHash) {
        setDashboardView(fromHash || 'live', { skipHash: true });
      }
    });
  }

  window.dashboardOpenSection = openSectionById;
  window.dashboardSetView = setDashboardView;
  window.dashboardCurrentView = currentView;

  window.dashboardInvalidateMap = invalidateMap;
})();
