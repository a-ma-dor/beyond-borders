/* build v2: no basemap, crisp countries, labels, arrows+minis fixed */
window.bb = {
  ready: false,
  flows: [],
  factors: {},
  _mapData: null,
  map: null,
  dump() {
    return {
      mapType: this._mapData?.type || null,
      features: this._mapData?.features?.length || 0,
      flows: this.flows.length,
      factors: Object.keys(this.factors).length
    };
  }
};

// Demographic minis: always render all four categories
const getActiveFactors = () => ['women', 'children', 'men', 'elderly'];

const getBoxMode = () =>
  (document.querySelector('input[name=boxmode]:checked')?.value === 'side'
    ? 'side'
    : 'stack');

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = res;
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

function safe(fn, tag) {
  try { return fn(); }
  catch (e) { console.error(tag || '[safe]', e); }
}

async function ensureLibs() {
  if (!window.L) throw new Error('Leaflet missing');
  if (!window.d3) {
    await loadScript('https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js');
  }
  if (!window.d3) throw new Error('d3 failed');
  if (!window.topojson) {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js');
    } catch (_) {}
  }
}

const formatCount = v =>
  !Number.isFinite(v) ? '—' : d3.format(',.0f')(Math.round(v));

const comparePins = [];
let selectedCountries = new Set();
let countryNames = Object.create(null);
let flows = [];
let factors = {};
let totals = {};
let totalScale = null;
let countryFeatures = new Map();
let selectionLayer = null;
let initialSelectionDone = false;
let renderCompare = () => {};
let flowEngine = null;
let compareSort = { key: 'total_refugees', dir: 'desc' };
let refitForViewport = () => {};
let uiScale = 1;

const DEFAULT_BASE_VIEWPORT = { width: 1440, height: 900 };
const BASE_VIEWPORT = (() => {
  const fallback = { ...DEFAULT_BASE_VIEWPORT };
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = JSON.parse(localStorage.getItem('bb:baseViewport') || '{}');
    if (Number.isFinite(stored.width) && Number.isFinite(stored.height)) {
      return stored;
    }
  } catch (_) {}
  const width = Math.max(320, window.innerWidth || fallback.width);
  const height = Math.max(480, window.innerHeight || fallback.height);
  const base = { width, height };
  try { localStorage.setItem('bb:baseViewport', JSON.stringify(base)); } catch (_) {}
  return base;
})();
const computeUiScale = () => {
  // Ignoriamo BASE_VIEWPORT hardcoded. Usiamo una logica responsive pura.
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Se lo schermo è piccolo (es. laptop 13"), non vogliamo scalare troppo in basso
  // altrimenti il testo diventa illeggibile.
  let scale = 1;

  if (vw < 1200) scale = 0.85; // Laptop piccoli
  if (vw < 800)  scale = 0.75; // Tablet
  if (vw > 1600) scale = 1.1;  // Monitor grandi
  if (vw > 2000) scale = 1.3;  // Monitor 4k

  // Protezione contro schermi molto bassi (es. ultrawide)
  if (vh < 700 && scale > 0.85) scale = 0.85;

  return scale;
};
const applyUiScale = () => {
  uiScale = computeUiScale();
  document.documentElement.style.setProperty('--ui-scale', uiScale.toFixed(3));
};

function showDetail(html, opts = {}) {
  const { skipRefit = false } = opts;
  const panel = document.getElementById('detailPanel');
  const body  = document.getElementById('detail-body');
  if (!panel || !body) return;
  if (html != null) body.innerHTML = html;
  panel.style.display = 'block';
  requestAnimationFrame(() => panel.classList.add('open'));
  const arrowBtn = document.getElementById('detailToggleArrow');
  if (arrowBtn) {
    arrowBtn.textContent = '→';
    arrowBtn.style.display = 'inline-flex';
  }
  const toggleBtn = document.getElementById('detailToggle');
  if (toggleBtn) toggleBtn.style.display = 'none';
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
  document.body.classList.add('panel-open');
  if (!skipRefit) refitForViewport?.();
}

function hideDetail() {
  const force = arguments.length ? !!arguments[0] : false;
  const opts = arguments.length > 1 ? arguments[1] || {} : {};
  const skipRefit = !!opts.skipRefit;
  if (!force && selectedCountries.size >= 2) return;
  const panel = document.getElementById('detailPanel');
  if (panel) {
    panel.classList.remove('open');
    setTimeout(() => { panel.style.display = 'none'; }, 350);
    const arrowBtn = document.getElementById('detailToggleArrow');
    if (arrowBtn) {
      arrowBtn.textContent = '←';
      arrowBtn.style.display = 'inline-flex';
    }
    const toggleBtn = document.getElementById('detailToggle');
    if (toggleBtn) {
      toggleBtn.style.display = 'flex';
      toggleBtn.setAttribute('aria-expanded', 'false');
    }
    document.body.classList.remove('panel-open');
    updateCompareToggle();
    if (!skipRefit) refitForViewport?.();
  }
}

function updateCompareToggle() {
  const wrap = document.querySelector('.detail-toggle-wrap');
  if (wrap) wrap.style.display = 'none';
}

  function redrawSelectionOutline() {
    selectionLayer.clearLayers();
    if (!selectedCountries.size) return;
    selectedCountries.forEach(id => {
      const feat = countryFeatures.get(id);
      if (!feat) return;
      L.geoJSON(feat, {
        pane: 'selection',
        style: {
          color: '#ffffff',
          weight: 2,
          opacity: 1,
          fill: false,
          lineJoin: 'round',
          lineCap: 'round'
        },
        interactive: false
      }).addTo(selectionLayer);
    });
    selectionLayer.eachLayer(l => l.bringToFront?.());
  }

(async function boot() {
  try { await ensureLibs(); }
  catch (e) {
    console.error('[boot] libs', e);
    window.bb.ready = true;
    return;
  }
  applyUiScale();

  // Map (no basemap)
  // Allow extra room east so the map can be panned under the open compare panel
  const EUROPE_BOUNDS = L.latLngBounds([32, -20], [72, 70]);
  const computePadding = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const isMobile = w < 800;

    // Se lo schermo è stretto, riduciamo drasticamente i margini "riservati"
    const panelOpen = document.body.classList.contains('panel-open');
    const panelEl = document.getElementById('detailPanel');
    
    // Su schermi piccoli, il pannello potrebbe coprire la mappa, non forziamo il padding
    let panelW = (panelOpen && panelEl && !isMobile) ? panelEl.offsetWidth || 0 : 0;
    
    // Riduciamo il padding destro
    const rightPad = Math.max(20, panelW + (panelOpen ? 20 : 10));

    // Gestione altezza (legend e actions)
    const actionsH = document.getElementById('country-actions')?.offsetHeight || 0;
    const legendEl = document.getElementById('demoLegend');
    const legendH = legendEl?.classList?.contains('show') ? legendEl.offsetHeight : 0;
    
    // Su schermi piccoli, usiamo meno spazio in basso
    const bottomPad = isMobile ? 40 : Math.max(50, actionsH + legendH + 40);

    return {
      topLeft: [20, 20], // Meno spazio sprecato in alto a sinistra
      bottomRight: [rightPad, bottomPad]
    };
  };
  const MIN_COMFORT_ZOOM = 3;
  refitForViewport = (animate = false) => {
    const pads = computePadding();
    map.fitBounds(EUROPE_BOUNDS, {
      paddingTopLeft: L.point(pads.topLeft[0], pads.topLeft[1]),
      paddingBottomRight: L.point(pads.bottomRight[0], pads.bottomRight[1]),
      animate
    });
    const desired = Math.min(MIN_COMFORT_ZOOM, map.getMaxZoom());
    if (map.getZoom() < desired) {
      map.setView(map.getCenter(), desired, { animate });
    }
  };
  const responsiveMinZoom = window.innerWidth < 1000 ? 2.5 : 3.5;
  const map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    minZoom: responsiveMinZoom,
    maxZoom: 7.5,
    zoomSnap: 0.25,
    zoomDelta: 0.25,
    wheelPxPerZoomLevel: 45,
    wheelDebounceTime: 0,
    zoomAnimation: true,
    fadeAnimation: true,
    markerZoomAnimation: true,
    zoomAnimationThreshold: 12,
    maxBounds: EUROPE_BOUNDS,
    maxBoundsViscosity: 1.0
  });
  window.bb.map = map;
  map.fitBounds(EUROPE_BOUNDS, { animate: false });
  map.setView([52, 20], MIN_COMFORT_ZOOM, { animate: false });
  refitForViewport(false);

  // Panes (z-order)
  map.createPane('countries'); map.getPane('countries').style.zIndex = 420;
  map.createPane('labels');    map.getPane('labels').style.zIndex   = 460; // labels above borders
  map.createPane('arrows');    map.getPane('arrows').style.zIndex   = 440;
  map.createPane('selection'); map.getPane('selection').style.zIndex= 450;
  map.createPane('minis');     map.getPane('minis').style.zIndex    = 470; // minis above borders/selection/labels
  const arrowsGroup = L.layerGroup({ pane: 'arrows' }).addTo(map);
  const labelLayer  = L.layerGroup({ pane: 'labels' }).addTo(map);
  selectionLayer = L.layerGroup({ pane: 'selection' }).addTo(map);
  let countryLayer  = null;
  const countryLabels = new Map();

  // Country picker state
  let countryPickerBuilt = false;
  let countryIds = [];
  countryNames = Object.create(null);
  countryFeatures = new Map();

  // D3 overlay for minis — never steal clicks
  const svgMini = L.svg({ pane: 'minis', padding: 0.5, interactive: true }).addTo(map);
  const miniRoot = d3
    .select(svgMini._rootGroup || svgMini._container.querySelector('svg'))
    .append('g')
    .attr('class', 'mini-root leaflet-zoom-animated')
    .style('pointer-events', 'visiblePainted');
const miniTooltip = (() => {
  const el = document.createElement('div');
  el.className = 'mini-tooltip';
  el.style.position = 'fixed';
  el.style.pointerEvents = 'none';
  el.style.zIndex = '9999';
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
})();
const metricTooltip = (() => {
  const el = document.createElement('div');
  el.className = 'info-tooltip';
  el.style.position = 'fixed';
  el.style.pointerEvents = 'none';
  el.style.zIndex = '9999';
  el.style.display = 'none';
  document.body.appendChild(el);
  let activeBtn = null;
  let tooltipHover = false;
  el.addEventListener('mouseenter', () => { tooltipHover = true; });
  el.addEventListener('mouseleave', () => { tooltipHover = false; clearActive(); });
  const show = (html, rect) => {
    el.innerHTML = html;
    el.style.display = 'block';
    el.style.pointerEvents = 'auto';
    const padding = 10;
    const x = Math.min(window.innerWidth - 220, Math.max(padding, rect.left));
    const y = Math.max(padding, rect.bottom + 6);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };
  const hide = (force = false) => {
    if (!force && activeBtn) return;
    el.style.display = 'none';
    el.style.pointerEvents = 'none';
  };
  const setActive = (btn, html, rect) => {
    activeBtn?.classList?.remove('active');
    activeBtn = btn;
    activeBtn?.classList?.add('active');
    show(html, rect);
  };
  const clearActive = () => {
    activeBtn?.classList?.remove('active');
    activeBtn = null;
    hide(true);
  };
  const isActive = btn => activeBtn === btn;
  const hasActive = () => !!activeBtn;
  const isTooltipHovered = () => tooltipHover;
  return { el, show, hide, setActive, clearActive, isActive, hasActive, isTooltipHovered };
})();
let infoOutsideHooked = false;

  // Helpers / aliases
  const FLOW_KEYS = {
    dest_iso3: ['dest_iso3', 'iso3', 'ISO3', 'country_code', 'code'],
    lat:       ['lat', 'latitude'],
    lon:       ['lon', 'lng', 'longitude'],
    tot:       ['total_refugees', 'refugees', 'count', 'n']
  };
  const COLOR_KEYS = {
    kids:        ['pct_children', 'children_pct'],
    women_adult: ['pct_women_adult'],
    men_adult:   ['pct_men_adult'],
    old:         ['pct_elderly', 'elderly_pct']
  };

  const gf = (o, a, d = 0) => {
    for (const k of a) {
      const v = o?.[k];
      if (v !== '' && v != null && Number.isFinite(+v)) return +v;
    }
    return d;
  };

  const gs = (o, a) => {
    for (const k of a) {
      const v = o?.[k];
      if (v !== '' && v != null) return String(v);
    }
    return '';
  };

  const cleanKeys = obj => {
    const out = {};
    Object.entries(obj || {}).forEach(([k, v]) => { out[String(k).trim()] = v; });
    return out;
  };

  function blankFactor() {
    return {
      gdp_pc: NaN,
      unemployment: NaN,
      ua_perm_delta: NaN,
      ua_perm_per_refugee: NaN,
      alloc_pct_gdp: NaN,
      mipex: NaN,
      opinion: NaN,
      ua_pop_2021: NaN,
      women: NaN,
      children: NaN,
      men: NaN,
      elderly: NaN
    };
  }

  function ensureFactor(id) {
    if (!factors[id]) factors[id] = blankFactor();
    return factors[id];
  }

  const METRIC_INFO = {
    gdp_pc: {
      title: 'GDP per capita',
      desc: 'Latest GDP per capita (USD) for each country.',
      source: { label: 'eurostat/GDP_PC', href: 'https://ec.europa.eu/eurostat/databrowser/view/sdg_08_10/default/table?lang=en' }
    },
    unemployment: {
      title: 'Unemployment rate',
      desc: 'Most recent unemployment rate (share of labor force).',
      source: { label: 'eurostat/unemployment', href: 'https://ec.europa.eu/eurostat/databrowser/view/tps00203/default/table' }
    },
    alloc_pct_gdp: {
      title: 'Support for Ukraine (% GDP)',
      desc: 'Share of GDP spent on Ukraine support (2021).',
      source: { label: 'allocations per gdp', href: 'https://www.kielinstitut.de/publications/ukraine-support-tracker-data-6453/' }
    },
    mipex: {
      title: 'MIPEX score (0–100)',
      desc: 'Migrant Integration Policy Index score; higher means more inclusive policies.',
      source: { label: 'mipex.eu', href: 'https://www.mipex.eu/play/' }
    },
    opinion: {
      title: 'Public support for refugees',
      desc: 'Survey share of people who support welcoming refugees.',
      source: { label: 'eurostat/public opinion', href: 'https://europa.eu/eurobarometer/surveys/detail/3372' }
    },
    ua_pop_2021: {
      title: 'Pre-war Ukrainian population (2021)',
      desc: 'Registered Ukrainian citizens residing in the country before Russia’s full-scale invasion (2021).',
      source: { label: 'residence permits (Eurostat)', href: 'data/migr_resvalid__custom_19375420_linear_2_0.csv' }
    },
    total_refugees: {
      title: 'Total refugees',
      desc: 'Aggregated count of refugees hosted by destination country.',
      source: { label: 'eurostat.total_refugees', href: 'https://ec.europa.eu/eurostat/databrowser/view/migr_asytpsm__custom_19168926/default/table' }
    }
  };

  const iso = p =>
    String(
      p?.ISO_A3 ||
      p?.ADM0_A3 ||
      p?.iso_a3 ||
      p?.WB_A3 ||
      p?.ISO3 ||
      ''
    ).toUpperCase();

  const nm = p =>
    p?.NAME_EN ||
    p?.NAME_LONG ||
    p?.ADMIN ||
    p?.NAME ||
    p?.BRK_NAME ||
    iso(p) ||
    '—';

  // Only draw these countries
  // EU27 only (filter out non‑EU countries to avoid empty labels/data)
  const ALLOWED_ISO3 = new Set([
    'AUT','BEL','BGR','HRV','CYP','CZE','DEU','DNK','EST','ESP','FIN','FRA',
    'GRC','HUN','IRL','ITA','LTU','LUX','LVA','MLT','NLD','POL','PRT','ROU',
    'SVK','SVN','SWE'
  ]);

  const NAME_TO_ISO3 = {
    'austria':'AUT','belgium':'BEL','bulgaria':'BGR','croatia':'HRV','cyprus':'CYP',
    'czechia':'CZE','denmark':'DNK','estonia':'EST','finland':'FIN','france':'FRA',
    'germany':'DEU','greece':'GRC','hungary':'HUN','ireland':'IRL','italy':'ITA',
    'latvia':'LVA','lithuania':'LTU','luxembourg':'LUX','malta':'MLT',
    'netherlands':'NLD','poland':'POL','portugal':'PRT','romania':'ROU',
    'slovakia':'SVK','slovenia':'SVN','spain':'ESP','sweden':'SWE'
  };

  // Arrow origin (Ukraine-ish)
  const ARROW_ORIGIN = [49.0, 32.0];

  flows   = [];
  factors = {};
  let mapData = null;

  // Arrow destination lat/lon per ISO3
  const destLL = Object.create(null);

  // Minis / centroids location per ISO3
  const centroidLL = Object.create(null);

const isCountryVisible = id =>
  selectedCountries.size ? selectedCountries.has(id) : false;

const getCountryStyle = id => {
  const isSel = selectedCountries.has(id);
  const totalVal = Number.isFinite(totals[id]) ? totals[id] : 0;
  const isAllowed = ALLOWED_ISO3.has(id) || id === 'UKR';
  const hasData = totalVal > 0 || id === 'UKR';
  const GRAY_NON_EU = new Set(['GBR', 'SRB', 'BIH', 'ALB', 'MKD', 'MNE', 'XKX']);
  if (id === 'NOR' || id === 'CHE' || id === 'ISL') {
    return {
      color: isSel ? '#ffffff' : '#000000',
      weight: isSel ? 1.4 : 1.0,
      opacity: 1,
      fill: true,
      fillOpacity: 0.55,
      fillColor: '#9ca3af'
    };
  }
  if (GRAY_NON_EU.has(id)) {
    return {
      color: isSel ? '#ffffff' : '#000000',
      weight: isSel ? 1.4 : 1.0,
      opacity: 1,
      fill: true,
      fillOpacity: 0.55,
      fillColor: '#9ca3af'
    };
  }
  if (id === 'UKR') {
    return {
      color: isSel ? '#ffffff' : '#000000',
      weight: isSel ? 1.4 : 1.0,
      opacity: 1,
      fill: true,
      fillOpacity: 0.7,
      fillColor: 'url(#ukraine-flag)'
    };
  }
  if (!isAllowed) {
    return {
      color: isSel ? '#ffffff' : '#0f172a',
      weight: isSel ? 1.4 : 1.0,
      opacity: 1,
      fill: true,
      fillOpacity: 0.6,
      fillColor: '#374151'
    };
  }
  const fill = hasData && totalScale ? totalScale(totalVal) : '#9ca3af';
  return {
    color: isSel ? '#ffffff' : '#000000',
    weight: isSel ? 1.4 : 1.0,
    opacity: 1,
    fill: true,
    fillOpacity: 0.55,
    fillColor: fill
  };
};

  // Scales
  const widthScale = d3.scaleSqrt().range([1, 12]);
  const arrowColor = d3.scaleSequential(d3.interpolatePlasma).domain([0, 1]).clamp(true);
  const PEOPLE_PER_PARTICLE = 10000; // target people represented by one dot (denser for visibility)
  const DEMO_CATS = [
    { key: 'women',    color: '#ec4899' }, // vivid pink
    { key: 'children', color: '#22c55e' }, // bright green
    { key: 'men',      color: '#3b82f6' }, // bright blue
    { key: 'elderly',  color: '#f59e0b' }  // strong amber
  ];
  const DEMO_LABELS = {
    men: 'Men (18-64)',
    women: 'Women (18-64)',
    children: 'Children (<18)',
    elderly: 'Elderly (65+)'
  };
  const DEMO_NOTES = {
    men: 'Share of adult men among displaced people',
    women: 'Share of adult women among displaced people',
    children: 'Share of displaced children',
    elderly: 'Share of displaced elderly adults'
  };
  const ensureDemoLegendRoot = () => {
    let el = document.getElementById('demoLegend');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'demoLegend';
    el.className = 'compare-table-wrapper demo-legend';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Demographic bars legend');
    (document.getElementById('app') || document.body).appendChild(el);
    return el;
  };

  const positionDemoLegend = () => {
    const legend = document.getElementById('demoLegend');
    const actions = document.getElementById('country-actions');
    if (!legend || legend.style.display === 'none' || !actions) return;
    const rect = actions.getBoundingClientRect();
    const styles = window.getComputedStyle(actions);
    const gap = 10;
    const bottomPx = parseFloat(styles.bottom) || Math.max(0, window.innerHeight - rect.bottom);
    const leftPx = parseFloat(styles.left) || rect.left || 0;
    const width = Math.max(rect.width, 240);
    legend.style.left = `${leftPx}px`;
    legend.style.bottom = `${bottomPx + rect.height + gap}px`;
    legend.style.width = `${width}px`;
  };

  const renderDemoLegend = () => {
    const hasSelection = selectedCountries.size > 0;
    const legend = hasSelection ? ensureDemoLegendRoot() : document.getElementById('demoLegend');
    if (!legend) return;

    if (!hasSelection) {
      legend.classList.remove('show');
      legend.style.pointerEvents = 'none';
      setTimeout(() => {
        if (!legend.classList.contains('show')) {
          legend.style.display = 'none';
        }
      }, 260);
      return;
    }

    const rows = DEMO_CATS.map(cat => `
      <tr>
        <td><span class="legend-chip" style="background:${cat.color}"></span></td>
        <td>${DEMO_LABELS[cat.key] || cat.key}</td>
      </tr>
    `).join('');

    legend.innerHTML = `
      <div class="compare-legend-heading">
        Demographic bars composition
        <span class="compare-legend-sub">Each color shows that demographic group’s percentage of the country’s total refugees</span>
      </div>
      <table class="compare-table compare-legend-table">
        <thead>
          <tr>
            <th scope="col">Color</th>
            <th scope="col">Group</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    legend.style.display = 'block';
    legend.style.pointerEvents = 'none';
    positionDemoLegend();
    requestAnimationFrame(() => {
      legend.classList.add('show');
      legend.style.pointerEvents = 'auto';
    });
  };
  const seededRand = key => {
    const s = (key == null ? '' : String(key));
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return () => {
      h += 0x6d2b79f5;
      let t = Math.imul(h ^ h >>> 15, 1 | h);
      t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  };

  class FlowParticleEngine {
    constructor(map, paneName = 'arrows') {
      this.map = map;
      this.pane = map.getContainer();
      this.canvas = L.DomUtil.create('canvas', 'flow-canvas');
      this.ctx = this.canvas.getContext('2d');
      this.pane.appendChild(this.canvas);
      this.flows = [];
      this.particles = [];
      this.last = performance.now();
      this.running = false;
      this.dirty = true;
      this.maxParticles = 12000;
      this.fade = 0.06; // fade a bit quicker so tails vanish faster
      this.dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
      this._tick = this.step.bind(this);
      this.align = this.align.bind(this);
      this.map.on('move zoom zoomend', () => { this.dirty = true; this.align(); });
      this.map.on('resize', () => { this.dirty = true; this.resize(); });
      this.map.on('zoomend', () => { this.dirty = true; });
      this.resize();
    }

    resize() {
      const size = this.map.getSize();
      this.dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
      const targetW = Math.round(size.x * this.dpr);
      const targetH = Math.round(size.y * this.dpr);
      if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
        this.canvas.width = targetW;
        this.canvas.height = targetH;
        this.canvas.style.width = `${size.x}px`;
        this.canvas.style.height = `${size.y}px`;
      }
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.ctx.clearRect(0, 0, targetW / this.dpr, targetH / this.dpr);
      this.align();
      this.dirty = true;
    }

    align() {
      L.DomUtil.setPosition(this.canvas, L.point(0, 0));
    }

    pickCategory(distro) {
      const r = Math.random();
      let acc = 0;
      for (const d of distro) {
        acc += d.p;
        if (r <= acc) return d;
      }
      return distro[distro.length - 1] || { color: '#ffffff' };
    }

    clear(resetParticles = false) {
      const dpr = this.dpr || 1;
      this.ctx.globalCompositeOperation = 'source-over';
      this.ctx.globalAlpha = 1;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
      if (resetParticles) this.particles = [];
    }

    setFlows(flows) {
      const getId = f => f?.id || f?.dest_iso3 || f?.dest;
      const prevIds = new Set(this.flows.map(getId).filter(Boolean));
      const nextIds = new Set(flows.map(getId).filter(Boolean));
      const removedIds = new Set([...prevIds].filter(id => !nextIds.has(id)));

      if (removedIds.size) {
        this.particles.forEach(p => {
          const pid = getId(p.flow);
          if (pid && removedIds.has(pid)) {
            p.fading = true;
            p.fadeAlpha = 1;
          }
        });
      }

      this.flows = flows.map(f => ({
        ...f,
        spawnAcc: 0
      }));
      this.dirty = true;
      this.ensureRunning();
    }

    ensureRunning() {
      if (this.running) return;
      this.running = true;
      this.last = performance.now();
      requestAnimationFrame(this._tick);
    }

    reproject() {
      this.flows.forEach(f => {
        const pts = f.latlngs.map(ll => this.map.latLngToContainerPoint(ll));
        let len = 0;
        const acc = [0];
        for (let i = 1; i < pts.length; i++) {
          len += pts[i].distanceTo(pts[i - 1]);
          acc.push(len);
        }
        f.points = pts;
        f.acc = acc;
        f.len = len || 1;
      });
      this.dirty = false;
    }

    pointAt(f, u) {
      if (!f.points || f.points.length < 2) return null;
      const dist = u * f.len;
      const acc = f.acc;
      let idx = acc.findIndex(x => x >= dist);
      if (idx < 1) idx = 1;
      if (idx === -1) idx = acc.length - 1;
      const p0 = f.points[idx - 1];
      const p1 = f.points[idx];
      const span = acc[idx] - acc[idx - 1] || 1;
      const t = Math.min(1, Math.max(0, (dist - acc[idx - 1]) / span));
      return L.point(
        p0.x + (p1.x - p0.x) * t,
        p0.y + (p1.y - p0.y) * t
      );
    }

    spawn(dt) {
      for (const f of this.flows) {
        const intensity = Math.max(0.4, Math.min(1.0, f.intensity || 0.6));
        const rate = Math.max(0.05, f.spawnRate || 0); // dots per second, derived from people-per-particle
        f.spawnAcc += rate * dt;
        const spawnN = Math.min(6, Math.floor(f.spawnAcc));
        f.spawnAcc -= spawnN;

        const laneCount = 1; // single lane; straight path
        const laneSpacing = 0;

        for (let i = 0; i < spawnN; i++) {
          if (this.particles.length >= this.maxParticles) break;
          const laneIdx = Math.floor(Math.random() * laneCount);
          const laneOffset = (laneIdx - (laneCount - 1) / 2) * laneSpacing;
          const jitter = 0; // no wiggle
          const spreadWidth = (f.spread || 1) * 2.2; // continuous band
          const randOffset = 0; // no random offset; stays centered on lane
          const cat = this.pickCategory(f.distro);
          this.particles.push({
            flow: f,
            u: 0,
            speed: 1 / f.duration,
            jitter,
            laneOffset,
            randOffset,
            color: cat.color,
            fading: false,
            fadeAlpha: 1
          });
        }
      }
    }

    update(dt) {
      const alive = [];
      for (const p of this.particles) {
        const speedMult = p.fading ? 2.2 : 1;
        p.u += dt * p.speed * speedMult;
        if (p.fading) {
          p.fadeAlpha = (p.fadeAlpha ?? 1) - dt * 3.2;
          if ((p.fadeAlpha ?? 0) <= 0) continue;
        }
        if (p.u <= 1 || p.fading) alive.push(p);
      }
      this.particles = alive;
    }

    drawFrame() {
      const ctx = this.ctx;
      const dpr = this.dpr || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Clear frame to avoid lingering streaks
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      const r = 1.0;
      const tailDelay = 0.06;
      const tailLen = 22;

      for (const p of this.particles) {
        const f = p.flow;
        const fadeFactor = Math.max(0, Math.min(1, p.fadeAlpha ?? 1));
        const mainPt = this.pointAt(f, p.u);
        if (!mainPt) continue;

        const dir = this._dirForPoint(f, p.u, mainPt);
        const jitter = p.jitter;
        const perp = this._perpForFlow(f, mainPt);
        const offsetFactor = Math.sin(Math.PI * Math.max(0, Math.min(1, p.u))); // zero at ends, peak mid

        const drawCircle = (pt, radius, alpha) => {
          if (!pt) return;
          const spread = f.spread || 1;
          const baseOffset = (p.laneOffset || 0) + (p.randOffset || 0);
        const offset = (baseOffset + jitter) * offsetFactor;
          const x = pt.x + perp[0] * offset;
          const y = pt.y + perp[1] * offset;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fillStyle = p.color || f.color || '#ffffff';
          ctx.globalAlpha = alpha * fadeFactor;
          ctx.fill();
        };

        const drawSquare = (pt, size, alpha) => {
          if (!pt) return;
          const spread = f.spread || 1;
          const baseOffset = (p.laneOffset || 0) + (p.randOffset || 0);
          const offset = (baseOffset + jitter) * offsetFactor;
          const x = pt.x + perp[0] * offset;
          const y = pt.y + perp[1] * offset;
          const half = size / 2;
          ctx.beginPath();
          ctx.rect(x - half, y - half, size, size);
          ctx.fillStyle = p.color || f.color || '#ffffff';
          ctx.globalAlpha = alpha * fadeFactor;
          ctx.fill();
        };

        // tail with smooth fade
        const headColor = p.color || f.color || '#ffffff';
        if (p.u > tailDelay) {
          const tailEnd = L.point(mainPt.x - dir.x * tailLen, mainPt.y - dir.y * tailLen);
          const grad = ctx.createLinearGradient(tailEnd.x, tailEnd.y, mainPt.x, mainPt.y);
          grad.addColorStop(0, 'rgba(255,255,255,0)');
          grad.addColorStop(1, headColor);
          ctx.beginPath();
          ctx.moveTo(tailEnd.x, tailEnd.y);
          ctx.lineTo(mainPt.x, mainPt.y);
          ctx.strokeStyle = grad;
          ctx.globalAlpha = fadeFactor;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        // main dot as a square
        drawSquare(mainPt, r * 1.4, 0.95);
      }

      ctx.globalAlpha = 1;
      ctx.restore();
    }

    _perpForFlow(f, pt) {
      if (!f.points || f.points.length < 2) return [0, 0];
      // find nearest segment
      let bestIdx = 1;
      let bestDist = Infinity;
      for (let i = 1; i < f.points.length; i++) {
        const p0 = f.points[i - 1];
        const p1 = f.points[i];
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const proj = ((pt.x - p0.x) * dx + (pt.y - p0.y) * dy) / (dx*dx + dy*dy || 1);
        const clamped = Math.max(0, Math.min(1, proj));
        const cx = p0.x + dx * clamped;
        const cy = p0.y + dy * clamped;
        const d2 = (pt.x - cx) ** 2 + (pt.y - cy) ** 2;
        if (d2 < bestDist) {
          bestDist = d2;
          bestIdx = i;
        }
      }
      const p0 = f.points[bestIdx - 1];
      const p1 = f.points[bestIdx];
      const vx = p1.x - p0.x;
      const vy = p1.y - p0.y;
      const len = Math.hypot(vx, vy) || 1;
      return [-vy / len, vx / len];
    }

    _dirForPoint(f, u, pt) {
      if (!f.points || f.points.length < 2) return { x: 0, y: -1 };
      const dist = u * (f.len || 1);
      const acc = f.acc || [];
      let idx = acc.findIndex(x => x >= dist);
      if (idx < 1) idx = 1;
      if (idx === -1) idx = acc.length - 1;
      const p0 = f.points[idx - 1];
      const p1 = f.points[idx];
      let vx = p1.x - p0.x;
      let vy = p1.y - p0.y;
      if (vx === 0 && vy === 0 && f.points.length >= 2) {
        const first = f.points[0];
        const last = f.points[f.points.length - 1];
        vx = last.x - first.x;
        vy = last.y - first.y;
      }
      const len = Math.hypot(vx, vy) || 1;
      return { x: vx / len, y: vy / len };
    }

    step(now) {
      if (!this.running) return;
      const dt = Math.min(0.08, (now - this.last) / 1000);
      this.last = now;
      this.resize();
      if (this.dirty) this.reproject();
      this.spawn(dt);
      this.update(dt);
      this.drawFrame();
      requestAnimationFrame(this._tick);
    }
  }

  // Minis config
  // Minis config
const VARS = ['women', 'children', 'men', 'elderly']; // demographic minis

const COLORS = {
  women: '#ec4899',
  children: '#22c55e',
  men: '#3b82f6',
  elderly: '#f59e0b'
};

const STROKES = {
  women: '#9d174d',
  children: '#166534',
  men: '#1d4ed8',
  elderly: '#92400e'
};

const METRIC_COLORS = {
  gdp_pc: '#60a5fa',
  unemployment: '#fb923c',
  alloc_pct_gdp: '#eab308',
  mipex: '#8b5cf6',
  opinion: '#14b8a6',
  ua_pop_2021: '#a3e635'
};

function ensureUkraineGradient(renderer) {
  let svg = renderer?._container || renderer?._rootGroup?.ownerSVGElement;
  if (!svg) {
    // fallback: global defs
    svg = document.getElementById('flag-defs');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('id', 'flag-defs');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.position = 'absolute';
      svg.style.left = '-9999px';
      document.body.appendChild(svg);
    }
  }
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  let grad = defs.querySelector('#ukraine-flag');
  if (!grad) {
    grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    grad.setAttribute('id', 'ukraine-flag');
    grad.setAttribute('x1', '0%');
    grad.setAttribute('x2', '0%');
    grad.setAttribute('y1', '0%');
    grad.setAttribute('y2', '100%');
    const stops = [
      ['0%', '#0057b7'],
      ['50%', '#0057b7'],
      ['50%', '#ffd700'],
      ['100%', '#ffd700']
    ];
    stops.forEach(([offset, color]) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      s.setAttribute('offset', offset);
      s.setAttribute('stop-color', color);
      grad.appendChild(s);
    });
    defs.appendChild(grad);
  }
}

const BOX_MIN = 6, BOX_MAX = 24;
let miniScale = {};

const XFORM = {
  women: d => Math.max(0, d),
  children: d => Math.max(0, d),
  men: d => Math.max(0, d),
  elderly: d => Math.max(0, d)
};

const INVERTED_VARS = new Set(); // none for demographics

const resetCompareSort = () => {
  compareSort = { key: 'total_refugees', dir: 'desc' };
};

function syncCompareFromSelection(openPanel = false, resetSort = true) {
  comparePins.length = 0;
  selectedCountries.forEach(id => comparePins.push(id));
  if (resetSort) resetCompareSort();
  renderCompare(false, { resetSort: false });
}

  function buildMiniScales() {
    miniScale = {};
    for (const v of VARS) {
      miniScale[v] = d3.scaleLinear()
        .domain([0, 1]) // percentages 0–100%
        .range([BOX_MIN, BOX_MAX])
        .clamp(true);
    }
  }

  const fmtNum = v =>
    (v == null || isNaN(v)) ? '—' : d3.format(',')(Math.round(+v));

const fmtPct = v => {
  if (v == null || isNaN(v)) return '—';
  const x = +v > 1 ? +v / 100 : +v;
  return d3.format('.1%')(Math.max(0, Math.min(1, x)));
};

  function updateCountrySummary() {
    const summary = document.getElementById('countryPickerSummary');
    if (!summary || !countryIds.length) return;

    if (selectedCountries.size === 0) {
      summary.textContent = 'None';
      return;
    }
    if (selectedCountries.size === countryIds.length) {
      summary.textContent = 'All countries';
      return;
    }

    const names = countryIds
      .filter(id => selectedCountries.has(id))
      .map(id => countryNames[id])
      .filter(Boolean);

    const label = names.slice(0, 3).join(', ');
    const extra = selectedCountries.size - Math.min(3, names.length);
    summary.textContent = extra > 0 ? `${label} +${extra}` : label || 'None';
  }

  function syncCountryCheckboxes() {
    const list = document.getElementById('countryPickerList');
    if (!list) return;
    list.querySelectorAll('input[type=checkbox]').forEach(input => {
      input.checked = selectedCountries.has(input.value);
    });
  }

  function refreshVisibleCountries() {
    updateCountrySummary();
    if (countryLayer) countryLayer.setStyle(feat => getCountryStyle(iso(feat.properties)));
    safe(drawArrows, '[country-filter:arrows]');
    safe(drawMinis, '[country-filter:minis]');
    safe(redrawSelectionOutline, '[country-filter:outline]');
    safe(renderDemoLegend, '[country-filter:legend]');
    safe(enforceComparePanel, '[country-filter:compare]');
  }

  function buildCountryPicker(options) {
    if (countryPickerBuilt) return;
    const list    = document.getElementById('countryPickerList');
    countryPickerBuilt = true;
    const sorted = options
      .filter(d => d && d.id)
      .sort((a, b) => a.name.localeCompare(b.name));

    countryIds = sorted.map(d => d.id);
    selectedCountries = new Set(); // start with none selected

    if (list) {
      list.innerHTML = '';
      for (const { id, name } of sorted) {
        const label = document.createElement('label');
        label.dataset.name = name.toLowerCase();
        label.innerHTML =
          `<input type="checkbox" value="${id}"> ${name}`;
        list.appendChild(label);
      }
      list.addEventListener('change', e => {
        if (e.target?.matches('input[type=checkbox]')) {
          const val = e.target.value;
          if (e.target.checked) selectedCountries.add(val);
          else selectedCountries.delete(val);
          refreshVisibleCountries();
          syncCompareFromSelection(false, true);
          updateCompareToggle();
        }
      });
    }

    document.getElementById('countrySelectAll')?.addEventListener('click', () => {
      selectedCountries = new Set(countryIds);
      syncCountryCheckboxes();
      refreshVisibleCountries();
      syncCompareFromSelection(false, true);
      updateCompareToggle();
      enforceComparePanel();
    });

    document.getElementById('countrySelectNone')?.addEventListener('click', () => {
      selectedCountries.clear();
      syncCountryCheckboxes();
      refreshVisibleCountries();
      syncCompareFromSelection(false, true);
      updateCompareToggle();
      enforceComparePanel();
    });

    updateCountrySummary();
  }

  try {
  const [
    mf,
    flowRaw,
    factorRows,
    summaryRows,
    unemploymentRows,
    mipexRowsRaw,
    opinionRowsRaw,
    uaPopRowsRaw
  ] = await Promise.all([
    d3.json('data/europe.geo.json')
      .catch(() => d3.json('data/europe.topo.json').catch(() => null)),
    d3.json('data/flows_ua_agg.json').catch(() => []),
    d3.csv('data/country_factors.csv', d3.autoType).catch(() => []),
    d3.csv('data/country_summary_clean.csv', d3.autoType).catch(() => []),
    d3.csv('data/unemployment_clean.csv', d3.autoType).catch(() => []),
    d3.csv('data/mipex.CSV', d3.autoType).catch(() => []),
    d3.csv('data/publicopinion.csv', d3.autoType).catch(() => []),
    d3.csv('data/ua_population_2021_respermits.csv', d3.autoType).catch(() => [])
  ]);
  const mipexRows = Array.isArray(mipexRowsRaw) ? mipexRowsRaw.map(cleanKeys) : [];
  const opinionRows = Array.isArray(opinionRowsRaw) ? opinionRowsRaw.map(cleanKeys) : [];
  const uaPopRows = Array.isArray(uaPopRowsRaw) ? uaPopRowsRaw.map(cleanKeys) : [];

    mapData = mf;

    // Flows
    flows = (Array.isArray(flowRaw) ? flowRaw : []).map(r => ({
      dest_iso3: gs(r, FLOW_KEYS.dest_iso3).toUpperCase(),
      lat:       gf(r, FLOW_KEYS.lat),
      lon:       gf(r, FLOW_KEYS.lon),
      total_refugees: gf(r, FLOW_KEYS.tot),
      pct_children:     gf(r, COLOR_KEYS.kids),
      pct_elderly:      gf(r, COLOR_KEYS.old),
      pct_women_adult:  gf(r, COLOR_KEYS.women_adult),
      pct_men_adult:    gf(r, COLOR_KEYS.men_adult)
    })).map(r => {
      const bumpN = { DEU: 1.2, PRT: 1.2 };
      const b = bumpN[r.dest_iso3];
      if (b) {
        r.lat += b;
      }
      return r;
    }).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));

    // Build destLL from flows
    for (const d of flows) {
      if (d.dest_iso3 && Number.isFinite(d.lat) && Number.isFinite(d.lon)) {
        destLL[d.dest_iso3] = [d.lat, d.lon];
      }
    }

    // Country factors (GDP, aid, unemployment, permit metrics)
    factors = {};
    for (const r of factorRows) {
      const id = String(
        r.dest_iso3 ||
        r.iso3     ||
        r.ISO3     ||
        r.country_code ||
        r.code     ||
        ''
      ).toUpperCase();
      if (!id) continue;

      let un = +r.unemployment;
      if (un > 1) un /= 100;

      const gdp  = +r.gdp_pc;
      const dP   = +r.ua_perm_delta;
      const rat  = +r.ua_perm_per_refugee;

      const f = ensureFactor(id);
      f.gdp_pc              = Number.isFinite(gdp) ? gdp : NaN;
      f.unemployment        = Number.isFinite(un) ? un  : NaN;
      f.ua_perm_delta       = Number.isFinite(dP)  ? dP  : NaN;
      f.ua_perm_per_refugee = Number.isFinite(rat) ? rat : NaN;
    }

    // Merge allocations % GDP from country_summary_clean.csv
    if (Array.isArray(summaryRows)) {
      for (const row of summaryRows) {
        const name = String(row.Country || '').trim().toLowerCase();
        const iso = NAME_TO_ISO3[name];
        if (!iso) continue;
        const raw = +row['Allocations % GDP 2021'];
        if (!Number.isFinite(raw)) continue;
        const v = raw > 1 ? raw / 100 : raw / 100; // convert percent to share
        const f = ensureFactor(iso);
        f.alloc_pct_gdp = v;
      }
    }

    // Override unemployment from Eurostat annual file (latest year)
    if (Array.isArray(unemploymentRows)) {
      for (const r of unemploymentRows) {
        const id = String(r.dest_iso3 || '').toUpperCase();
        if (!id || !ALLOWED_ISO3.has(id)) continue;
        const val = +r.unemployment;
        if (!Number.isFinite(val)) continue;
        const f = ensureFactor(id);
        f.unemployment = val; // already fraction
      }
    }

    // MIPEX scores (0–100)
    if (Array.isArray(mipexRows)) {
    for (const r of mipexRows) {
      const id = String(r.dest_iso3 || r.iso3 || '').toUpperCase();
      if (!id || !ALLOWED_ISO3.has(id)) continue;
      const val = +r.mipex;
      if (!Number.isFinite(val)) continue;
        const f = ensureFactor(id);
        f.mipex = val;
      }
    }

    // Public opinion on welcoming refugees (%)
    if (Array.isArray(opinionRows)) {
      for (const r of opinionRows) {
        const id = String(r.dest_iso3 || r.iso3 || '').toUpperCase();
        if (!id || !ALLOWED_ISO3.has(id)) continue;
        const raw = +r.opinion;
        if (!Number.isFinite(raw)) continue;
        const f = ensureFactor(id);
        f.opinion = raw > 1 ? raw / 100 : raw;
      }
    }

    // Ukrainian resident population pre-invasion (2021)
    if (Array.isArray(uaPopRows)) {
      for (const r of uaPopRows) {
        const id = String(r.dest_iso3 || r.iso3 || '').toUpperCase();
        if (!id || !ALLOWED_ISO3.has(id)) continue;
        const raw = +r.ua_population_2021;
        if (!Number.isFinite(raw)) continue;
        const f = ensureFactor(id);
        f.ua_pop_2021 = raw;
      }
    }

    // Inject demographic percentages from flows into factors for minis
    for (const f of flows) {
      const id = f.dest_iso3;
      if (!id) continue;
      const rec = ensureFactor(id);
      const frac = v => {
        if (!Number.isFinite(v)) return NaN;
        return v > 1 ? v / 100 : v;
      };
      rec.women = frac(f.pct_women_adult);
      rec.men = frac(f.pct_men_adult);
      rec.children = frac(f.pct_children);
      rec.elderly = frac(f.pct_elderly);
    }

    window.bb.flows   = flows;
    window.bb.factors = factors;
    window.bb._mapData = mapData;

    if (flows.length) {
      const vals = flows
        .map(d => +d.total_refugees || 0)
        .filter(Number.isFinite);
      const lo = d3.min(vals) ?? 1;
      const hi = d3.max(vals) ?? 1;
      totals = flows.reduce((acc, d) => {
        acc[d.dest_iso3] = (acc[d.dest_iso3] || 0) + (+d.total_refugees || 0);
        return acc;
      }, {});
      // Ensure every allowed country has an entry (so all get a fill color)
      ALLOWED_ISO3.forEach(id => {
        if (!Object.prototype.hasOwnProperty.call(totals, id)) totals[id] = 0;
      });
      widthScale.domain(
        lo === hi
          ? [1, hi + 1]
          : [Math.max(1, lo), Math.max(1, hi)]
      );
      const tHi = 1_200_000;
      const colors = [
        '#fff7ed',
        '#f9c385ff',
        '#fb923c',
        '#f97316',
        '#ff4d00ff'
      ];
      const domainPoints = [10_000, 50_000, 100_000, 500_000, tHi];

      totalScale = d3.scaleLog()
        .domain(domainPoints)
        .range(colors)
        .interpolate(d3.interpolateRgb)
        .clamp(true);
    }
    buildMiniScales();

    // Countries + labels
  function drawCountries() {
    let geo = null;
    if (!mapData) return;
      if (mapData.type === 'FeatureCollection')      geo = mapData;
      else if (mapData.type === 'Feature')           geo = { type: 'FeatureCollection', features: [mapData] };
      else if (mapData.type === 'Topology') {
        if (!window.topojson || !topojson.feature) return;
        const objs = Object.values(mapData.objects || {});
        if (!objs.length) return;
        geo = topojson.feature(mapData, objs[0]);
      }

    if (countryLayer) map.removeLayer(countryLayer);
    labelLayer.clearLayers();
    countryLabels.clear();
    ensureUkraineGradient(map._renderer || countryLayer?._renderer);

      const pickerOptions = [];
      const seenOptions = new Set();

    countryLayer = L.geoJSON(geo, {
        pane: 'countries',
        style: feat => getCountryStyle(iso(feat?.properties || {})),
        interactive: true,
        smoothFactor: 2.0,
        tolerance: 2,
        bubblingMouseEvents: false,
        onEachFeature: (feat, layer) => {
        const props = feat?.properties || {};
        const id    = iso(props);
        if (!ALLOWED_ISO3.has(id)) return;
        countryFeatures.set(id, feat);

          const name  = nm(props);
          countryNames[id] = name;
          if (!seenOptions.has(id)) {
            seenOptions.add(id);
            pickerOptions.push({ id, name });
          }
          const polyCenter = layer.getBounds().getCenter();
          const hasFlow = !!destLL[id];

          // Base position for minis = arrow destination if we have it; else polygon center
          let base = hasFlow
            ? destLL[id]
            : [polyCenter.lat, polyCenter.lng];
          if (id === 'SWE') {
            base = [base[0], base[1] - 3.0]; // nudge Sweden minis left a bit more
          }
          if (id === 'PRT') {
            base = [base[0] - 0.8, base[1]]; // nudge Portugal minis down slightly
          }
          if (id === 'ESP') {
            base = [base[0] + 0.4, base[1] + 0.6]; // nudge Spain minis up/right slightly
          }

          // Minis live at base
          centroidLL[id] = [base[0], base[1]];

          // Label: at arrow destination; otherwise polygon center
          let labelLL;
          if (hasFlow) {
            labelLL = L.latLng(base[0], base[1]);
          } else {
            labelLL = polyCenter;
          }

          L.marker(labelLL, {
            pane: 'labels',
            interactive: false,
            icon: L.divIcon({
              className: 'country-label',
              html: `<span>${name}</span>`,
              iconSize: [0, 0]
            })
          }).addTo(labelLayer);
          const lastMarker = labelLayer.getLayers()[labelLayer.getLayers().length - 1];
          if (lastMarker) countryLabels.set(id, lastMarker);

          layer.bindTooltip(
            `<div><b>${name}</b></div><div><b>Total refugees:</b> ${formatCount(totals[id] || 0)}</div>`,
            {
              direction: 'auto',
              opacity: 0.95,
              className: 'arrow-tip',
              sticky: true,
              offset: [0, -6]
            }
          );

          layer.on({
            mouseover: e => {
              const base = getCountryStyle(id);
              const hoverFill = Math.max(0, (base.fillOpacity ?? 0) - 0.03);
              e.target.setStyle({
                color: base.color,
                weight: base.weight,
                opacity: base.opacity,
                fillOpacity: hoverFill
              });
            },
            mouseout: e => {
              countryLayer.resetStyle(e.target);
            },
            click: () => {
              const f   = factors[id] || {};
              const ref = flows.find(x => x.dest_iso3 === id) || {};
              if (selectedCountries.has(id)) selectedCountries.delete(id);
              else selectedCountries.add(id);
              syncCountryCheckboxes();
              refreshVisibleCountries();
              syncCompareFromSelection(false, true);
              updateCompareToggle();
              const permDelta = Number.isFinite(f.ua_perm_delta) ? f.ua_perm_delta : null;
              const permRatio = Number.isFinite(f.ua_perm_per_refugee) ? f.ua_perm_per_refugee : null;

              const permDeltaText = permDelta != null ? fmtNum(permDelta)        : '—';
              const permRatioText = permRatio != null ? permRatio.toFixed(3) : '—';
            }
          });
        }
      }).addTo(map);

    if (pickerOptions.length) {
      buildCountryPicker(pickerOptions);
      if (!initialSelectionDone && countryIds.length) {
        const picks = countryIds
          .slice()
          .sort(() => Math.random() - 0.5)
          .slice(0, Math.min(5, countryIds.length));
        selectedCountries = new Set(picks);
        syncCountryCheckboxes();
        refreshVisibleCountries();
        syncCompareFromSelection(false, true);
        initialSelectionDone = true;
      }
      updateCompareToggle();
    }
  }

    // Arrows
    function getArrowColorValue(d) {
      const sel = document.getElementById('arrowColorVar');
      const key = sel?.value || 'pct_children';
      const val = Number.isFinite(d[key]) ? d[key] : 0;
      return Math.max(0, Math.min(1, val));
    }

    const getArrowLabel = () =>
      document.getElementById('arrowColorVar')?.selectedOptions?.[0]?.text || 'Arrow metric';

    const metricColorFor = (key, val) => {
      if (key === 'arrow') return arrowColor(val || 0);
      return METRIC_COLORS[key] || '#94a3b8';
    };

    renderCompare = function renderCompare(openPanel = false, opts = {}) {
      const { resetSort = false } = opts;
      const panel = document.getElementById('detailPanel');
      const body = document.getElementById('detail-body');
      if (!panel || !body) return;
      const preserveScroll = panel.classList.contains('open');
      const prevScroll = preserveScroll ? panel.scrollTop : 0;
      // keep comparePins in sync with selectedCountries
      comparePins.length = 0;
      selectedCountries.forEach(id => comparePins.push(id));
      if (resetSort) resetCompareSort();
      if (!comparePins.length) {
        body.innerHTML = 'Click countries to add them to the comparison table.';
        hideDetail();
        return;
      }

      const rows = comparePins.map(id => {
        const name = countryNames[id] || id;
        const f = factors[id] || {};
        const ref = flows.find(x => x.dest_iso3 === id) || {};
        return { id, name, f, ref };
      });

      const getSortValue = (row, key) => {
        switch (key) {
          case 'country':       return row.name || row.id;
          case 'gdp_pc':        return row.f.gdp_pc;
          case 'unemployment':  return row.f.unemployment;
          case 'alloc_pct_gdp': return row.f.alloc_pct_gdp;
          case 'mipex':         return row.f.mipex;
          case 'opinion':       return row.f.opinion;
          case 'ua_pop_2021':   return row.f.ua_pop_2021;
          case 'total_refugees':return row.ref.total_refugees;
          default:              return row.name || row.id;
        }
      };

      const allowedSortKeys = new Set(['country', 'gdp_pc', 'unemployment', 'alloc_pct_gdp', 'mipex', 'opinion', 'ua_pop_2021', 'total_refugees']);
      if (!allowedSortKeys.has(compareSort.key)) {
        compareSort = { key: 'total_refugees', dir: 'desc' };
      }

      const sortDir = compareSort.dir === 'asc' ? 1 : -1;
      const sortedRows = rows.slice().sort((a, b) => {
        if (compareSort.key === 'country') {
          return (a.name || a.id).localeCompare(b.name || b.id) * sortDir;
        }
        const va = getSortValue(a, compareSort.key);
        const vb = getSortValue(b, compareSort.key);
        const na = Number.isFinite(+va) ? +va : -Infinity;
        const nb = Number.isFinite(+vb) ? +vb : -Infinity;
        if (na === nb) return (a.name || '').localeCompare(b.name || '') * sortDir;
        return na < nb ? -1 * sortDir : 1 * sortDir;
      });

      const columns = [
        {
          id: 'country',
          label: 'Country',
          align: 'left',
          render: row =>
            `<div class="compare-country">
              <div class="name">${row.name}</div>
              <div class="code">${row.id}</div>
            </div>`
        },
        {
          id: 'gdp_pc',
          label: 'GDP per capita',
          align: 'right',
          render: row => fmtNum(row.f.gdp_pc),
          color: metricColorFor('gdp_pc'),
          info: METRIC_INFO.gdp_pc
        },
        {
          id: 'unemployment',
          label: 'Unemployment rate',
          align: 'right',
          render: row => fmtPct(row.f.unemployment),
          color: metricColorFor('unemployment'),
          info: METRIC_INFO.unemployment
        },
        {
          id: 'alloc_pct_gdp',
          label: 'Support for Ukraine % GDP',
          align: 'right',
          render: row => fmtPct(row.f.alloc_pct_gdp),
          color: metricColorFor('alloc_pct_gdp'),
          info: METRIC_INFO.alloc_pct_gdp
        },
        {
          id: 'mipex',
          label: 'MIPEX score (0–100)',
          align: 'right',
          render: row => fmtNum(row.f.mipex),
          color: metricColorFor('mipex'),
          info: METRIC_INFO.mipex
        },
        {
          id: 'opinion',
          label: 'Public support for refugees',
          align: 'right',
          render: row => fmtPct(row.f.opinion),
          color: metricColorFor('opinion'),
          info: METRIC_INFO.opinion
        },
        {
          id: 'ua_pop_2021',
          label: 'Pre-war Ukrainian population (2021)',
          align: 'right',
          render: row => fmtNum(row.f.ua_pop_2021),
          color: metricColorFor('ua_pop_2021'),
          info: METRIC_INFO.ua_pop_2021
        },
        {
          id: 'total_refugees',
          label: 'Total refugees',
          align: 'right',
          render: row => formatCount(row.ref.total_refugees),
          color: '#cbd5e1',
          info: METRIC_INFO.total_refugees
        }
      ];

      const headerCells = columns.map(col => {
        const style = [];
        if (col.align) style.push(`text-align:${col.align}`);
        if (col.color) style.push(`color:${col.color}`);
        const isSortable = col.id !== 'country';
        const isActive = isSortable && compareSort.key === col.id;
        const indicator = isSortable
          ? `<span class="sort-indicator ${isActive ? 'active' : 'inactive'}">${isActive ? (compareSort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>`
          : '';
        const sortableClass = isSortable ? 'sortable' : '';
        const activeClass = isActive ? 'active-sort' : '';
        const ariaSort = isSortable
          ? (isActive ? (compareSort.dir === 'asc' ? 'ascending' : 'descending') : 'none')
          : 'none';
        const title = isSortable ? 'Click to sort' : '';
        const dataKeyAttr = isSortable ? `data-key="${col.id}"` : '';
        return `<th ${dataKeyAttr} class="${sortableClass} ${activeClass}" style="${style.join(';')}" aria-sort="${ariaSort}" title="${title}">${col.label}${indicator}</th>`;
      }).join('');

      const bodyRows = sortedRows.map(row => {
        const cells = columns.map(col => {
          if (col.id === 'country') {
            return `
              <td class="country-cell">
                <div class="compare-country">
                  <div class="name">${row.name}</div>
                </div>
                <button class="compare-remove" data-id="${row.id}" aria-label="Remove ${row.name}">×</button>
              </td>
            `;
          }
          const val = typeof col.render === 'function' ? col.render(row) : '';
          const style = [];
          const color = typeof col.getColor === 'function' ? col.getColor(row) : col.color;
          if (col.align) style.push(`text-align:${col.align}`);
          if (color) style.push(`color:${color}`);
          return `<td style="${style.join(';')}">${val}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
      }).join('');

      body.innerHTML = `
        <div class="compare-charts"></div>
        <div class="compare-table-wrapper">
          <div class="compare-hint">Click any metric header to sort</div>
          <table class="compare-table">
            <thead><tr>${headerCells}</tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
      `;
      const shouldOpen = openPanel || panel.classList.contains('open');
      if (shouldOpen) {
        panel.classList.add('open');
        panel.style.display = 'block';
        panel.focus?.();
      } else {
        panel.classList.remove('open');
        panel.style.display = 'none';
      }
      if (preserveScroll) {
        requestAnimationFrame(() => {
          panel.scrollTop = prevScroll;
        });
      }

      function renderCharts() {
        const rootEl = body.querySelector('.compare-charts');
        if (!rootEl || typeof d3 === 'undefined') return;
        const root = d3.select(rootEl);
        root.selectAll('*').remove();

        const metricCols = columns.filter(c => c.id !== 'country');
        metricCols.sort((a, b) => (a.id === 'total_refugees' ? -1 : b.id === 'total_refugees' ? 1 : 0));
        const formatVal = (col, row) => {
          switch (col.id) {
            case 'gdp_pc': return fmtNum(row.f.gdp_pc);
            case 'unemployment': return fmtPct(row.f.unemployment);
            case 'alloc_pct_gdp': return fmtPct(row.f.alloc_pct_gdp);
            case 'mipex': return fmtNum(row.f.mipex);
            case 'opinion': return fmtPct(row.f.opinion);
            case 'ua_pop_2021': return fmtNum(row.f.ua_pop_2021);
            case 'total_refugees': return formatCount(row.ref.total_refugees);
            default: return '';
          }
        };

        metricCols.forEach(col => {
          const values = sortedRows.map(row => ({
            row,
            name: row.name || row.id,
            id: row.id,
            val: getSortValue(row, col.id)
          })).filter(d => Number.isFinite(+d.val));

          if (!values.length) return;

          const card = root.append('div').attr('class', 'chart-card');
          const title = card.append('div')
            .attr('class', 'chart-title chart-title-row')
            .html(() => {
              const info = col.info
                ? `<button type="button" class="info-icon" data-key="${col.id}" aria-label="About ${col.label}" data-title="${col.info.title || col.label}" data-body="${col.info.desc || ''}" data-source-label="${col.info.source?.label || ''}" data-source-href="${col.info.source?.href || ''}">i</button>`
                : '';
              const sortLabel = (() => {
                if (col.id === 'alloc_pct_gdp') return 'Sort by support for Ukraine.';
                if (col.id === 'opinion') return 'Sort by public support';
                if (col.id === 'mipex') return 'Sort by MIPEX score';
                if (col.id === 'ua_pop_2021') return 'Sort by pre-war population';
                return `Sort by ${col.label}`;
              })();
              const sortBtn = col.id !== 'country'
                ? `<button type="button" class="chart-sort-btn" data-key="${col.id}">${sortLabel}</button>`
                : '';
              return `
                <span class="chart-title-text"><span class="chart-title-label">${col.label}</span>${info}</span>
                <span class="chart-title-actions">
                  ${sortBtn}
                </span>`;
            });

    const viewport = Math.max(320, window.innerWidth || 1200);
    const scale = Math.min(1.25, Math.max(0.88, viewport / 1400)) * uiScale;
          const barH = 12 * scale;
          const gap = 6 * scale;
          const marginBase = { t: 12, r: 36, b: 12, l: 60 };
          const margin = {
            t: marginBase.t * scale,
            r: marginBase.r * scale,
            b: marginBase.b * scale,
            l: Math.max(42 * scale, marginBase.l * scale * 0.9) // keep labels close to the bubble
          };
          const containerW = Math.max(320, Math.min((card.node()?.clientWidth || 400), 540));
          const usable = containerW * 0.86;
          const width = usable;
          const height = values.length * (barH + gap) + margin.t + margin.b - gap;

          const maxVal = d3.max(values, d => +d.val) || 1;
          const x = d3.scaleLinear()
            .domain([0, maxVal])
            .range([0, width - margin.l - margin.r]);

          const svg = card.append('svg')
            .attr('class', 'bar-chart')
            .attr('width', '100%')
            .attr('height', height)
            .attr('viewBox', `0 0 ${width} ${height}`);

          const g = svg.append('g').attr('transform', `translate(${margin.l},${margin.t})`);

          const colorFor = row =>
            (typeof col.getColor === 'function' ? col.getColor(row) : col.color) || '#38bdf8';

          g.selectAll('rect')
            .data(values)
            .enter()
            .append('rect')
            .attr('x', 0)
            .attr('y', (_, i) => i * (barH + gap))
            .attr('width', d => x(Math.max(0, +d.val)))
            .attr('height', barH)
            .attr('rx', 4)
            .attr('ry', 4)
            .attr('fill', d => colorFor(d.row));

          g.selectAll('text.name')
            .data(values)
            .enter()
            .append('text')
            .attr('class', 'bar-label')
            .attr('x', -6)
            .attr('y', (_, i) => i * (barH + gap) + barH * 0.7)
            .attr('text-anchor', 'end')
            .text(d => `${d.name}`);

          g.selectAll('text.val')
            .data(values)
            .enter()
            .append('text')
            .attr('class', 'bar-value')
            .attr('x', d => x(Math.max(0, +d.val)) + 4)
            .attr('y', (_, i) => i * (barH + gap) + barH * 0.7)
            .text(d => formatVal(col, d.row));
        });
      }

      renderCharts();

      body.querySelectorAll('.compare-table th.sortable').forEach(th => {
        th.addEventListener('click', () => {
          const key = th.dataset.key;
          if (!key || key === 'country') return;
          if (compareSort.key === key) {
            compareSort.dir = compareSort.dir === 'asc' ? 'desc' : 'asc';
          } else {
            compareSort = { key, dir: 'desc' };
          }
          renderCompare(panel.classList.contains('open'), { resetSort: false });
        });
      });

      const infoIcons = body.querySelectorAll('.info-icon');
      infoIcons.forEach(btn => {
        const showTip = (sticky = false) => {
          const title = btn.dataset.title || '';
          const desc = btn.dataset.body || '';
          const srcLabel = btn.dataset.sourceLabel || '';
          const srcHref = btn.dataset.sourceHref || '';
          const sourceHtml = srcHref
            ? `<div class="info-source">Source: <a href="${srcHref}" target="_blank" rel="noopener">${srcLabel || srcHref}</a></div>`
            : '';
          const html = `
            <div class="info-title">${title}</div>
            <div class="info-desc">${desc}</div>
            ${sourceHtml}
          `;
          const rect = btn.getBoundingClientRect();
          if (sticky) metricTooltip.setActive(btn, html, rect);
          else metricTooltip.show(html, rect);
        };
        const hideTip = () => metricTooltip.hide();
        btn.addEventListener('mouseenter', e => {
          e.stopPropagation();
          if (metricTooltip.isActive(btn)) return;
          showTip(false);
        });
        btn.addEventListener('mouseleave', () => {
          if (metricTooltip.isActive(btn) && metricTooltip.isTooltipHovered()) return;
          if (metricTooltip.isActive(btn)) metricTooltip.clearActive();
          hideTip();
        });
        btn.addEventListener('focus', () => {
          if (metricTooltip.isActive(btn)) return;
          showTip(false);
        });
        btn.addEventListener('blur', () => {
          if (metricTooltip.isActive(btn) && metricTooltip.isTooltipHovered()) return;
          if (metricTooltip.isActive(btn)) metricTooltip.clearActive();
          hideTip();
        });
        btn.addEventListener('click', e => {
          e.stopPropagation();
          if (metricTooltip.isActive(btn)) {
            metricTooltip.clearActive();
          } else {
            metricTooltip.clearActive();
            showTip(true);
          }
        });
      });

      const chartSortBtns = body.querySelectorAll('.chart-sort-btn');
      chartSortBtns.forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const key = btn.dataset.key;
          if (!key || key === 'country') return;
          if (compareSort.key === key) {
            compareSort.dir = compareSort.dir === 'asc' ? 'desc' : 'asc';
          } else {
            compareSort = { key, dir: 'desc' };
          }
          renderCompare(panel.classList.contains('open'), { resetSort: false });
        });
      });

      if (!infoOutsideHooked) {
        document.addEventListener('click', e => {
          if (!metricTooltip.hasActive()) return;
          const target = e.target;
          const insideTooltip = metricTooltip.el?.contains(target);
          const isIcon = target?.closest?.('.info-icon');
          if (!insideTooltip && !isIcon) metricTooltip.clearActive();
        });
        infoOutsideHooked = true;
      }
    }

    function bez(a, c, b, n = 40) {
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n, u = 1 - t;
        pts.push([
          u*u*a.lat + 2*u*t*c.lat + t*t*b.lat,
          u*u*a.lng + 2*u*t*c.lng + t*t*b.lng
        ]);
      }
      return pts;
    }

    function enforceComparePanel() {
      const needOpen = selectedCountries.size >= 2;
      if (needOpen) {
        safe(() => renderCompare(true, { resetSort: false }), '[enforce:compare-open]');
        showDetail(null, { skipRefit: true });
      } else {
        hideDetail(true, { skipRefit: true });
      }
    }

  function drawArrows() {
    arrowsGroup.clearLayers();
    if (!flows.length) {
      flowEngine?.setFlows([]);
      return;
      }
      if (!flowEngine) {
        flowEngine = new FlowParticleEngine(map, 'arrows');
    }
    const origin = L.latLng(ARROW_ORIGIN[0], ARROW_ORIGIN[1]);

    const jitterPath = (from, to) => [from, to]; // straight path, no wiggle

    const visibleFlows = flows.filter(d => isCountryVisible(d.dest_iso3));
    const flowData = [];
    visibleFlows.forEach(d => {
      const dest = L.latLng(+d.lat, +d.lon);
      const anchorLL = centroidLL[d.dest_iso3] ? L.latLng(centroidLL[d.dest_iso3][0], centroidLL[d.dest_iso3][1]) : dest;
      const samples = jitterPath(origin, anchorLL);
      const distKm = origin.distanceTo(dest) / 1000;
      const duration = Math.min(12, Math.max(5, distKm / 350)); // longer routes take a bit longer
      const intensity = Math.max(0.2, Math.min(1.2, (widthScale(+d.total_refugees || 1) || 1) / 10));
      const dots = Math.max(0, (+d.total_refugees || 0) / PEOPLE_PER_PARTICLE);
      const spawnRate = dots > 0 ? Math.min(40, Math.max(2, dots / duration)) : 0; // dots per second
      const demoRaw = {
        men:      +d.pct_men_adult,
        women:    +d.pct_women_adult,
        children: +d.pct_children,
        elderly:  +d.pct_elderly
      };
      let sumDemo = 0;
      DEMO_CATS.forEach(cat => { sumDemo += Math.max(0, demoRaw[cat.key] || 0); });
      const normDemo = DEMO_CATS.map(cat => {
        const v = Math.max(0, demoRaw[cat.key] || 0);
        return { key: cat.key, color: cat.color, p: sumDemo > 0 ? v / sumDemo : 1 / DEMO_CATS.length };
      });
      // ensure sum to 1
      const totalP = normDemo.reduce((a, b) => a + b.p, 0);
      normDemo.forEach(d => { d.p = d.p / (totalP || 1); });

      const labelMap = {
        men: 'Men',
        women: 'Women',
        children: 'Children',
        elderly: 'Elderly'
      };
      const compLines = normDemo.map(cat => {
        return `<span style="color:${cat.color}">${labelMap[cat.key] || cat.key}: ${fmtPct(cat.p)}</span>`;
      }).join('<br>');

      // split into per-category flows so particles target the matching bar
      const BAR_W = 10, BAR_GAP = 6;
      const totalW = VARS.length * BAR_W + (VARS.length - 1) * BAR_GAP;
      const anchorPt = map.latLngToLayerPoint(anchorLL);

      normDemo.forEach((cat) => {
        const pShare = cat.p;
        if (pShare <= 0) return;
        const idx = Math.max(0, VARS.indexOf(cat.key));
        const shiftX = -totalW / 2 + idx * (BAR_W + BAR_GAP) + BAR_W / 2;
        const barTarget = map.layerPointToLatLng(anchorPt.add([shiftX, 0]));
        const path = jitterPath(samples[0], barTarget);
        flowData.push({
          id: d.dest_iso3,
          latlngs: path,
          duration,
          intensity,
          spawnRate: (spawnRate * pShare),
          color: '#ffffff',
          distro: [{ color: '#ffffff', p: 1 }],
          spread: 1 + intensity * 2.8,
          total: d.total_refugees || 0,
          tooltip: `<div><b>${labelMap[cat.key] || cat.key}</b></div><div>${fmtPct(cat.p)}</div><div style="margin-top:6px;"><b>Total refugees:</b> ${formatCount(d.total_refugees)}</div>`
        });
      });
    });

      flowEngine.setFlows(flowData);

      // Lightweight tooltip hit areas showing total refugees
      // no flow hover tooltips
    }

    // Minis
  function project(lat, lon) {
    const p = map.latLngToLayerPoint([lat, lon]);
    return [p.x, p.y];
  }

  function drawMinis() {
    const active = getActiveFactors();
    const mode   = getBoxMode();
    const ids    = Object.keys(factors).filter(isCountryVisible);
    const shouldTransition = (mode !== drawMinis._lastMode);
    const zoom = map?.getZoom ? map.getZoom() : MIN_COMFORT_ZOOM;
    const baseZoom = map?.getMinZoom ? map.getMinZoom() : MIN_COMFORT_ZOOM;
    const zoomScale = map?.getZoomScale ? map.getZoomScale(zoom, baseZoom) : Math.pow(2, zoom - baseZoom);
    const baseFactor = window.innerWidth < 1200 ? 0.85 : 1.0; 
const zoomFactor = Math.max(0.8, Math.min(3.5, zoomScale * uiScale * baseFactor));

    // Only keep variables we actually know how to transform + have scales for
    const activeVars = active.filter(v =>
      typeof XFORM[v] === 'function' && miniScale[v]
    );

      if (!activeVars.length) {
        countryLabels.forEach(marker => {
          const el = marker.getElement && marker.getElement();
          if (el) el.style.opacity = '1';
        });
        miniRoot.selectAll('g.mini').remove();
        return;
      }

      const data = ids.map(id => {
        const ll = centroidLL[id];
        if (!ll) return null;
        const rec = factors[id] || {};

        const sizes = active.map(v => {
          const transform = XFORM[v] || (x => x);
          const x = transform(+rec[v] || 0);
          const scale = miniScale[v] || (x => BOX_MIN);
          let s = Math.max(BOX_MIN, Math.min(BOX_MAX, scale(x)));
          if (INVERTED_VARS.has(v)) {
            s = BOX_MIN + (BOX_MAX - s); // invert scale so higher value -> smaller box
          }
          const scaledMin = BOX_MIN * zoomFactor;
          const scaledMax = BOX_MAX * zoomFactor;
          s = Math.max(scaledMin, Math.min(scaledMax, s * zoomFactor));
          return { varName: v, s, value: +rec[v] || 0 };
        });

        return { id, ll, sizes };
      }).filter(Boolean);

      // Hide labels for countries with minis to reduce overlap
      countryLabels.forEach((marker, iso3) => {
        const el = marker.getElement && marker.getElement();
        if (!el) return;
        const hasMini = ids.includes(iso3);
        el.style.opacity = hasMini ? '0' : '1';
      });

      const groups = miniRoot.selectAll('g.mini').data(data, d => d.id);
      const enter  = groups.enter()
        .append('g')
        .attr('class', 'mini')
        .style('opacity', 0);

      const merged = groups.merge(enter)
        .attr('transform', d => {
          const [x, y] = project(d.ll[0], d.ll[1]);
          return `translate(${x},${y})`;
        });

      const rects = merged.selectAll('rect').data(d => d.sizes, s => s.varName);

      const rectsEnter = rects.enter()
        .append('rect')
        .attr('rx', 2.5)
        .attr('ry', 2.5)
        .attr('stroke-width', 1)
        .style('opacity', 0)
        .style('pointer-events', 'all')
        .attr('height', 0)
        .attr('y', 0);

      const rectsMerged = rectsEnter.merge(rects)
        .attr('fill',   s => COLORS[s.varName]   || '#9ca3af')
        .attr('stroke', s => STROKES[s.varName]  || '#374151');

      rectsEnter.append('title');
      const labelMap = { women: 'Women', children: 'Children', men: 'Men', elderly: 'Elderly' };
      rectsMerged.select('title').text(function (s) {
        const label = labelMap[s.varName] || s.varName;
        return `${label}: ${fmtPct(s.value)}`;
      });

      rectsMerged
        .on('mouseenter', function (event, s) {
          const label = labelMap[s.varName] || s.varName;
          miniTooltip.textContent = `${label}: ${fmtPct(s.value)}`;
          miniTooltip.style.display = 'block';
          miniTooltip.style.left = `${event.clientX + 8}px`;
          miniTooltip.style.top = `${event.clientY + 8}px`;
        })
        .on('mousemove', function (event) {
          miniTooltip.style.left = `${event.clientX + 8}px`;
          miniTooltip.style.top = `${event.clientY + 8}px`;
        })
        .on('mouseleave', function () {
          miniTooltip.style.display = 'none';
        });

      const widthScale = Math.max(0.9, Math.min(2.0, zoomFactor * uiScale));
      const baseW = 12 * widthScale;
      const baseGap = 7 * widthScale;

      const applyPos = sel => sel
        .attr('x', function (s, i) {
          const d = this.parentNode.__data__;
          const totalW = d.sizes.length * baseW + (d.sizes.length - 1) * baseGap;
          return -totalW / 2 + i * (baseW + baseGap);
        })
        .attr('y', s => -s.s)
        .attr('width', baseW)
        .attr('height', s => s.s);

      applyPos(rectsMerged);
      rectsMerged.style('opacity', 1);

      // Grow-in animation for newly entered bars
      rectsEnter
        .transition()
        .duration(260)
        .ease(d3.easeCubicOut)
        .style('opacity', 1)
        .attr('y', s => -s.s)
        .attr('height', s => s.s);

      rects.exit()
        .transition()
        .duration(180)
        .style('opacity', 0)
        .remove();

      merged.style('opacity', 1);
      groups.exit()
        .transition()
        .duration(180)
        .style('opacity', 0)
        .remove();
      drawMinis._lastMode = mode;
    }

    // Legends
    function renderArrowLegend() {
      const root = d3.select('#legend-arrows');
      root.selectAll('*').remove();
      if (!flows.length) return;

      const W = 240;
      const ROWH = 16;
      const H = 10 + DEMO_CATS.length * (ROWH + 8) + 6;
      const svg = root
        .append('svg')
        .attr('class', 'legend')
        .attr('width', W)
        .attr('height', H);

      svg
        .append('text')
        .attr('x', 12)
        .attr('y', 14)
        .attr('class', 'legend-title')
        .text('Particle color — demographic');

      const labels = DEMO_LABELS;

      const rows = svg
        .selectAll('.row')
        .data(DEMO_CATS)
        .enter()
        .append('g')
        .attr('class', 'row')
        .attr('transform', (_, i) => `translate(12,${22 + i * (ROWH + 8)})`);

      rows
        .append('rect')
        .attr('width', ROWH)
        .attr('height', ROWH)
        .attr('rx', 3)
        .attr('ry', 3)
        .attr('fill', d => d.color)
        .attr('stroke', '#111827');

      rows
        .append('text')
        .attr('x', ROWH + 8)
        .attr('y', ROWH - 4)
        .attr('class', 'legend-tick')
        .text(d => labels[d.key] || d.key);
    }

    function renderBoxLegend() {
      const root = d3.select('#legend-boxes');
      root.selectAll('*').remove();

      const active = getActiveFactors();
      if (!active.length) return;

      const W = 240;
      const ROWH = 16;
      const H = 10 + active.length * (ROWH + 8) + 6;
      const svg = root
        .append('svg')
        .attr('class', 'legend')
        .attr('width', W)
        .attr('height', H);

      svg
        .append('text')
        .attr('x', 12)
        .attr('y', 14)
        .attr('class', 'legend-title')
        .text('Country minis — demographics');

      const labels = DEMO_LABELS;

      const rows = svg
        .selectAll('.row')
        .data(active)
        .enter()
        .append('g')
        .attr('class', 'row')
        .attr('transform', (_, i) => `translate(12,${22 + i * (ROWH + 8)})`);

      rows
        .append('rect')
        .attr('width', ROWH)
        .attr('height', ROWH)
        .attr('rx', 3)
        .attr('ry', 3)
        .attr('fill', d => COLORS[d] || '#9ca3af')
        .attr('stroke', d => STROKES[d] || '#374151');

      rows
        .append('text')
        .attr('x', ROWH + 8)
        .attr('y', ROWH - 4)
        .attr('class', 'legend-tick')
        .text(d => labels[d] || d);
    }

    function renderTotalLegend() {
      const root = d3.select('#legend-total');
      root.selectAll('*').remove();
      if (!totalScale) return;

      // --- POSIZIONAMENTO (Manteniamo quello che ti piace) ---
      const rootEl = root.node();
      if (rootEl) {
        rootEl.style.position = 'absolute';
        rootEl.style.top = '20px';
        rootEl.style.right = '580px'; // Posizione "Sweet Spot" a sinistra del pannello
        rootEl.style.left = 'auto';         
        rootEl.style.transform = 'none';    
        rootEl.style.zIndex = '400';        
        rootEl.style.pointerEvents = 'none'; 
      }
      // -----------------------------------------------------

      const isCompact = uiScale < 1.0; 

      // 1. AUMENTO LARGHEZZA: Barra più lunga e leggibile
      const W = isCompact ? 260 : 340; 
      const H = isCompact ? 45 : 60; 
      
      // Margini laterali leggermente aumentati per far stare i numeri esterni (10k e 1.2M)
      const P = { 
        l: 20, r: 20, 
        t: isCompact ? 6 : 10, 
        b: isCompact ? 6 : 10 
      };
      
      const barH = isCompact ? 6 : 8; 
      const groupYOffset = isCompact ? 8 : 10; 
      const tickTextY = isCompact ? 16 : 20; 

      const gradId = 'totalGrad';
      // 2. RIPRISTINO DATI: Usiamo tutto il dominio della scala, non solo min/max
      const ticks = totalScale.domain(); // [10k, 50k, 100k, 500k, 1.2M]
      
      // Calcolo min e max per il gradiente
      const lo = ticks[0];
      const hi = ticks[ticks.length - 1];

      const svg = root
        .append('svg')
        .attr('class', 'legend')
        .attr('width', W)
        .attr('height', H)
        .style('overflow', 'visible'); 

      // Titolo
      svg
        .append('text')
        .attr('x', P.l)
        .attr('y', P.t + 4)
        .attr('class', 'legend-title')
        .style('fill', '#e2e8f0') 
        .style('font-size', isCompact ? '11px' : '12px')
        .style('font-family', 'sans-serif')
        .style('font-weight', '600')
        .style('text-shadow', '0 1px 3px rgba(0,0,0,0.8)') 
        .text('Total refugees per country');

      const defs = svg.append('defs');
      const grad = defs
        .append('linearGradient')
        .attr('id', gradId)
        .attr('x1', '0%')
        .attr('x2', '100%');

      const logSpan = Math.log(hi / lo);
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const v = lo * Math.exp(logSpan * t);
        grad
          .append('stop')
          .attr('offset', `${t * 100}%`)
          .attr('stop-color', totalScale(v));
      }

      const contentW = W - P.l - P.r;
      const g = svg
        .append('g')
        .attr('transform', `translate(${P.l},${P.t + groupYOffset})`);

      // La Barra Colorata
      g.append('rect')
        .attr('width', contentW)
        .attr('height', barH)
        .attr('rx', 2)
        .attr('stroke', 'rgba(255,255,255,0.2)') 
        .attr('stroke-width', '0.5')
        .attr('fill', `url(#${gradId})`);

      const axis = d3.scaleLog().domain([lo, hi]).range([0, contentW]);
      
      const fmtLegend = v => {
        if (v >= 1_000_000) return `${d3.format('.1f')(v / 1_000_000)}M`;
        if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
        return formatCount(v);
      };

      // Disegno Tacchette (Ticks)
      g
        .selectAll('g.tick')
        .data(ticks)
        .enter()
        .append('g')
        .attr('class', 'tick')
        .attr('transform', d => `translate(${axis(d)}, ${barH})`)
        .each(function (d) {
          // Lineetta verticale
          d3.select(this)
            .append('line')
            .attr('y1', 0)
            .attr('y2', isCompact ? 4 : 5)
            .attr('stroke', '#9ca3af');
          
          // Testo (Numeri)
          d3.select(this)
            .append('text')
            .attr('y', tickTextY)
            .attr('text-anchor', 'middle') // Centrato sotto la tacchetta
            .style('fill', '#94a3b8') 
            .style('font-family', 'sans-serif')
            .style('font-size', isCompact ? '9px' : '10px')
            .style('text-shadow', '0 1px 2px rgba(0,0,0,0.8)')
            .text(fmtLegend(d));
        });
    }

    // Initial draw
    safe(drawCountries, '[init:countries]');
    safe(drawArrows,    '[init:arrows]');
    safe(drawMinis,     '[init:minis]');
    safe(renderArrowLegend, '[legend:arrows]');
    safe(renderBoxLegend,   '[legend:boxes]');
    safe(renderTotalLegend, '[legend:total]');

    // Reposition minis on pan/zoom
  map.on('moveend zoomend', () => {
    safe(drawMinis, '[event:minis]');
    safe(redrawSelectionOutline, '[event:outline]');
  });
  map.on('zoomend', () => {
    if (flowEngine) flowEngine.dirty = true;
  });
  window.addEventListener('resize', () => {
    map.invalidateSize();
    refitForViewport(false);
    if (flowEngine) flowEngine.dirty = true;
    safe(positionDemoLegend, '[resize:legend]');
    applyUiScale();
    if (selectedCountries.size) {
      const isOpen = document.getElementById('detailPanel')?.classList.contains('open');
      safe(() => renderCompare(isOpen, { resetSort: false }), '[resize:compare]');
    }
  });

    // UI
    document.querySelectorAll('.controls .factor-toggle, .controls select').forEach(el => {
      el.addEventListener('change', () => {
        buildMiniScales();
        safe(drawArrows, '[ui:arrows]');
        safe(drawMinis,  '[ui:minis]');
        safe(renderArrowLegend, '[ui:legend-arrows]');
        safe(renderBoxLegend,   '[ui:legend-boxes]');
        safe(() => renderCompare(false), '[ui:compare]');
      });
    });

    document.querySelectorAll('input[name=boxmode]').forEach(el => {
      el.addEventListener('change', () => {
        safe(drawMinis, '[ui:minis:boxmode]');
        safe(renderBoxLegend, '[ui:legend-boxes]');
      });
    });

    const closeBtn = document.getElementById('detailClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        hideDetail();
      });
    }
    const toggleBtn = document.getElementById('detailToggle');
    const toggleArrow = document.getElementById('detailToggleArrow');
    const toggleWrap = document.querySelector('.detail-toggle-wrap');
    if (toggleBtn) toggleBtn.style.display = 'none';
    if (toggleArrow) toggleArrow.style.display = 'none';
    if (toggleWrap) toggleWrap.style.display = 'none';

    const updateToggleVisibility = () => {
      updateCompareToggle();
    };
    updateToggleVisibility();
    document.getElementById('detail-body')?.addEventListener('click', e => {
      const btn = e.target.closest('.compare-remove');
      if (btn) {
        const id = btn.dataset.id;
        if (id) {
          selectedCountries.delete(id);
          syncCountryCheckboxes();
          refreshVisibleCountries();
          syncCompareFromSelection(false, true);
          updateCompareToggle();
          enforceComparePanel();
        }
      }
    });
    const clearBtn = document.getElementById('detailClear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        selectedCountries.clear();
        comparePins.length = 0;
        syncCountryCheckboxes();
        refreshVisibleCountries();
        renderCompare(false);
        hideDetail();
        updateCompareToggle();
        enforceComparePanel();
      });
    }

  } catch (e) {
    console.error('[load error]', e);
  } finally {
    hideDetail();
    window.bb.ready = true;
    window.dispatchEvent(new Event('bb:ready'));
  }
})();
