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

  const SETUP_TABS = ['geofences', 'alerts', 'messages', 'settings', 'data', 'debug'];
  const LS_SETUP_TAB = 'rnz_dashboard_setup_tab';
  const SECTION_TO_TAB = {
    'capsize-emails': 'alerts',
    regatta: 'messages',
    geofences: 'geofences',
    'monitor-stats': 'debug',
    settings: 'settings',
    'data-manage': 'data',
  };

  function invalidateMap(map) {
    if (!map) return;
    setTimeout(() => map.invalidateSize(), 80);
    setTimeout(() => map.invalidateSize(), 320);
  }

  function invalidateFleetMap() {
    invalidateMap(window.dashboardFleetMap);
  }

  let setupMapViewSynced = false;

  function invalidateSetupMap() {
    const setup = window.dashboardSetupMap;
    if (!setup) return;
    const fleet = window.dashboardFleetMap;
    setTimeout(() => {
      setup.invalidateSize();
      if (!setupMapViewSynced && fleet) {
        setup.setView(fleet.getCenter(), fleet.getZoom(), { animate: false });
        setupMapViewSynced = true;
      }
    }, 80);
    setTimeout(() => setup.invalidateSize(), 320);
  }

  window.dashboardWorkMaps = function () {
    return [window.dashboardSetupMap, window.dashboardFleetMap].filter(Boolean);
  };

  window.dashboardEditMap = function () {
    const view = document.body.getAttribute('data-dashboard-view');
    if (view === 'setup' && window.dashboardSetupMap) return window.dashboardSetupMap;
    return window.dashboardFleetMap || window.dashboardSetupMap || null;
  };

  function currentSetupTab() {
    return document.body.getAttribute('data-setup-tab') || 'geofences';
  }

  function setSetupTab(tab, opts = {}) {
    const next = SETUP_TABS.includes(tab) ? tab : 'geofences';
    document.body.setAttribute('data-setup-tab', next);
    try {
      localStorage.setItem(LS_SETUP_TAB, next);
    } catch {
      /* ignore */
    }
    document.querySelectorAll('[data-setup-panel]').forEach((el) => {
      el.hidden = el.getAttribute('data-setup-panel') !== next;
    });
    document.querySelectorAll('.setup-tabs [data-setup-tab]').forEach((btn) => {
      const on = btn.getAttribute('data-setup-tab') === next;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (next === 'geofences') {
      invalidateSetupMap();
    }
    if (next === 'debug') {
      window.dispatchEvent(new Event('resize'));
    }
    if (!opts.skipHash && currentView() === 'setup') {
      const hash = `#setup/${next}`;
      if (location.hash !== hash) {
        window.history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
      }
    }
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
    if (id === 'map' && open) invalidateFleetMap();
  }

  function initSections() {
    const saved = loadSectionState();
    document.querySelectorAll('.dashboard-section[data-section-id]').forEach((section) => {
      if (section.classList.contains('setup-tab-panel')) {
        const body = section.querySelector('.dashboard-section__body');
        const toggle = section.querySelector('.dashboard-section__toggle');
        if (body) body.hidden = false;
        if (toggle) toggle.setAttribute('aria-expanded', 'true');
        section.classList.add('dashboard-section--open');
        return;
      }
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
        if (!section || section.classList.contains('setup-tab-panel')) return;
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
    invalidateFleetMap();
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
      invalidateFleetMap();
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

  function parseLocation() {
    const raw = (location.hash || '').replace(/^#/, '');
    if (raw === 'history') return { view: 'history' };
    if (raw === 'setup' || raw.startsWith('setup/')) {
      return { view: 'setup', tab: raw.split('/')[1] || '' };
    }
    return { view: 'live' };
  }

  function savedSetupTab() {
    try {
      return localStorage.getItem(LS_SETUP_TAB) || '';
    } catch {
      return '';
    }
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
      invalidateFleetMap();
      setTimeout(invalidateFleetMap, 200);
    }
    if (next === 'history') {
      const historySection = document.querySelector('.dashboard-section[data-section-id="history"]');
      if (historySection) setSectionOpen(historySection, true, false);
    }
    if (next === 'setup') {
      const tab = opts.tab || savedSetupTab() || 'geofences';
      setSetupTab(tab, { skipHash: true });
    }
    if (!opts.skipHash) {
      let hash = '';
      if (next === 'history') hash = '#history';
      if (next === 'setup') hash = `#setup/${currentSetupTab()}`;
      if (hash !== location.hash) {
        window.history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
      }
    }
  }

  window.dashboardInitSections = function () {
    initSections();
    initMapFullscreen();
    initViewNav();
    const loc = parseLocation();
    setDashboardView(loc.view, { skipHash: true, tab: loc.tab });
  };

  function openSectionById(id, scroll = true) {
    const view = VIEW_BY_SECTION[id] || 'setup';
    const tab = SECTION_TO_TAB[id];
    setDashboardView(view, { tab });
    const section = document.querySelector(`.dashboard-section[data-section-id="${id}"]`);
    if (!section) return;
    if (view === 'setup') return;
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
    document.querySelectorAll('.setup-tabs [data-setup-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setDashboardView('setup', { tab: btn.getAttribute('data-setup-tab') });
      });
    });
    window.addEventListener('hashchange', () => {
      const loc = parseLocation();
      setDashboardView(loc.view, { skipHash: true, tab: loc.tab });
    });
  }

  window.dashboardOpenSection = openSectionById;
  window.dashboardSetView = setDashboardView;
  window.dashboardCurrentView = currentView;
  window.dashboardSetSetupTab = setSetupTab;

  window.dashboardInvalidateMap = invalidateFleetMap;
})();
