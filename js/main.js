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

const getActiveFactors = () =>
  Array.from(
    document.querySelectorAll('.controls input[type=checkbox][data-factor]:checked')
  ).map(e => e.value);

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
let initialSelectionDone = false;
let countryNames = Object.create(null);
let flows = [];
let factors = {};

function showDetail(html) {
  const panel = document.getElementById('detailPanel');
  const body  = document.getElementById('detail-body');
  if (!panel || !body) return;
  if (html != null) body.innerHTML = html;
  panel.classList.add('open');
  panel.style.display = 'block';
}

function hideDetail() {
  const panel = document.getElementById('detailPanel');
  if (panel) {
    panel.classList.remove('open');
    panel.style.display = 'none';
  }
}

(async function boot() {
  try { await ensureLibs(); }
  catch (e) {
    console.error('[boot] libs', e);
    window.bb.ready = true;
    return;
  }

  // Map (no basemap)
  const EUROPE_BOUNDS = L.latLngBounds([34, -10], [71.5, 45]);
  const map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    minZoom: 4,
    maxZoom: 8,
    maxBounds: EUROPE_BOUNDS,
    maxBoundsViscosity: 1.0
  });
  window.bb.map = map;
  map.fitBounds(EUROPE_BOUNDS, { animate: false });
  map.setView([52, 20], 5, { animate: false });

  // Panes (z-order)
  map.createPane('countries'); map.getPane('countries').style.zIndex = 420;
  map.createPane('labels');    map.getPane('labels').style.zIndex   = 430;
  map.createPane('arrows');    map.getPane('arrows').style.zIndex   = 440;
  map.createPane('minis');     map.getPane('minis').style.zIndex    = 450;

  const arrowsGroup = L.layerGroup({ pane: 'arrows' }).addTo(map);
  const labelLayer  = L.layerGroup({ pane: 'labels' }).addTo(map);
  let countryLayer  = null;
  const countryLabels = new Map();

  // Country picker state
  let countryPickerBuilt = false;
  let countryIds = [];
  countryNames = Object.create(null);
  let selectedCountries = new Set();

  // D3 overlay for minis — never steal clicks
  const svgMini = L.svg({ pane: 'minis', padding: 0.5 }).addTo(map);
  const miniRoot = d3
    .select(svgMini._rootGroup || svgMini._container.querySelector('svg'))
    .append('g')
    .attr('class', 'mini-root leaflet-zoom-hide')
    .style('pointer-events', 'none');

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

  // Scales
  const widthScale = d3.scaleSqrt().range([1, 12]);
  const arrowColor = d3.scaleSequential(d3.interpolatePlasma).domain([0, 1]).clamp(true);

  // Minis config
  // Minis config
const VARS = ['gdp_pc', 'unemployment', 'alloc_pct_gdp'];

const COLORS = { 
  gdp_pc: '#60a5fa',
  unemployment: '#fb923c',
  alloc_pct_gdp: '#eab308'
};

const STROKES = {
  gdp_pc: '#1e3a8a',
  unemployment: '#7c2d12',
  alloc_pct_gdp: '#854d0e'
};

const BOX_MIN = 6, BOX_MAX = 28;
let miniScale = {};

const XFORM = {
  gdp_pc: d => Math.log1p(Math.max(0, d)),
  unemployment: d => Math.log1p(Math.max(0, (d > 1 ? d / 100 : d) * 100)),
  alloc_pct_gdp: d => Math.log1p(Math.max(0, (d > 1 ? d / 100 : d) * 100)) // percent to fraction then scale
};

const INVERTED_VARS = new Set(['unemployment']); // higher unemployment -> smaller box

  function buildMiniScales() {
    miniScale = {};
  for (const v of VARS) {
    const fn = XFORM[v];
    if (typeof fn !== 'function') continue;

    const vals = Object.values(factors)
        .map(r => fn(+r[v] || 0))
        .filter(Number.isFinite)
        .sort(d3.ascending);

      const loQ = d3.quantile(vals, 0.1) ?? d3.min(vals);
      const hiQ = d3.quantile(vals, 0.9) ?? d3.max(vals);
      const lo = loQ ?? 0;
      const hi = hiQ ?? 1;
      const dom = (lo === hi)
        ? [0, hi || 1]
        : [Math.max(0, lo), hi];

      miniScale[v] = d3.scaleSqrt()
        .domain(dom)
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
    safe(drawArrows, '[country-filter:arrows]');
    safe(drawMinis, '[country-filter:minis]');
  }

  function buildCountryPicker(options) {
    if (countryPickerBuilt) return;
    const list    = document.getElementById('countryPickerList');
    const search  = document.getElementById('countryPickerSearch');
    const matchEl = document.getElementById('countryPickerMatch');
    if (!list) return;

    countryPickerBuilt = true;
    const sorted = options
      .filter(d => d && d.id)
      .sort((a, b) => a.name.localeCompare(b.name));

    countryIds = sorted.map(d => d.id);
    selectedCountries = new Set(countryIds); // will be overridden by initial landing selection

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
      }
    });

    document.getElementById('countrySelectAll')?.addEventListener('click', () => {
      selectedCountries = new Set(countryIds);
      syncCountryCheckboxes();
      refreshVisibleCountries();
    });

    document.getElementById('countrySelectNone')?.addEventListener('click', () => {
      selectedCountries.clear();
      syncCountryCheckboxes();
      refreshVisibleCountries();
    });

    if (search) {
      const applyFilter = () => {
        const q = search.value.trim().toLowerCase();
        let visible = 0;
        list.querySelectorAll('label').forEach(label => {
          const match = !q || label.dataset.name?.includes(q);
          label.style.display = match ? '' : 'none';
          if (match) visible += 1;
        });
        if (matchEl) matchEl.textContent = q ? `${visible} match${visible === 1 ? '' : 'es'}` : '';
      };
      search.addEventListener('input', applyFilter);
      applyFilter();
    }

    updateCountrySummary();
  }

  try {
    const [mf, flowRaw, factorRows, summaryRows, unemploymentRows] = await Promise.all([
      d3.json('data/europe.geo.json')
        .catch(() => d3.json('data/europe.topo.json').catch(() => null)),
      d3.json('data/flows_ua_agg.json').catch(() => []),
      d3.csv('data/country_factors.csv', d3.autoType).catch(() => []),
      d3.csv('data/country_summary_clean.csv', d3.autoType).catch(() => []),
      d3.csv('data/unemployment_clean.csv', d3.autoType).catch(() => [])
    ]);

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
    })).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));

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

      factors[id] = {
        gdp_pc:              Number.isFinite(gdp) ? gdp : NaN,
        unemployment:        Number.isFinite(un) ? un  : NaN,
        ua_perm_delta:       Number.isFinite(dP)  ? dP  : NaN,
        ua_perm_per_refugee: Number.isFinite(rat) ? rat : NaN,
        alloc_pct_gdp:       NaN
      };
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
        if (!factors[iso]) {
          factors[iso] = {
            gdp_pc: NaN,
            unemployment: NaN,
            ua_perm_delta: NaN,
            ua_perm_per_refugee: NaN,
            alloc_pct_gdp: NaN
          };
        }
        factors[iso].alloc_pct_gdp = v;
      }
    }

    // Override unemployment from Eurostat annual file (latest year)
    if (Array.isArray(unemploymentRows)) {
      for (const r of unemploymentRows) {
        const id = String(r.dest_iso3 || '').toUpperCase();
        if (!id || !ALLOWED_ISO3.has(id)) continue;
        const val = +r.unemployment;
        if (!Number.isFinite(val)) continue;
        if (!factors[id]) {
          factors[id] = {
            gdp_pc: NaN,
            unemployment: NaN,
            ua_perm_delta: NaN,
            ua_perm_per_refugee: NaN,
            alloc_pct_gdp: NaN
          };
        }
        factors[id].unemployment = val; // already fraction
      }
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
      widthScale.domain(
        lo === hi
          ? [1, hi + 1]
          : [Math.max(1, lo), Math.max(1, hi)]
      );
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

      const pickerOptions = [];
      const seenOptions = new Set();

      countryLayer = L.geoJSON(geo, {
        pane: 'countries',
        style: () => ({
          color: '#334155',
          weight: 1.0,
          opacity: 0.95,
          fill: true,
          fillOpacity: 0.10,
          fillColor: '#e7edf4'
        }),
        interactive: true,
        smoothFactor: 2.0,
        tolerance: 2,
        bubblingMouseEvents: false,
        onEachFeature: (feat, layer) => {
          const props = feat?.properties || {};
          const id    = iso(props);
          if (!ALLOWED_ISO3.has(id)) return;

          const name  = nm(props);
          countryNames[id] = name;
          if (!seenOptions.has(id)) {
            seenOptions.add(id);
            pickerOptions.push({ id, name });
          }
          const polyCenter = layer.getBounds().getCenter();
          const hasFlow = !!destLL[id];

          // Base position for minis = arrow destination if we have it; else polygon center
          const base = hasFlow
            ? destLL[id]
            : [polyCenter.lat, polyCenter.lng];

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

          layer.on({
            mouseover: e => {
              e.target.setStyle({
                weight: 1.8,
                opacity: 1,
                fillOpacity: 0.16
              });
            },
            mouseout: e => {
              countryLayer.resetStyle(e.target);
            },
            click: () => {
              const f   = factors[id] || {};
              const ref = flows.find(x => x.dest_iso3 === id) || {};
              const permDelta = Number.isFinite(f.ua_perm_delta) ? f.ua_perm_delta : null;
              const permRatio = Number.isFinite(f.ua_perm_per_refugee) ? f.ua_perm_per_refugee : null;

              const permDeltaText = permDelta != null ? fmtNum(permDelta)        : '—';
              const permRatioText = permRatio != null ? permRatio.toFixed(3) : '—';

              // pin/unpin
              const idx = comparePins.indexOf(id);
              if (idx >= 0) comparePins.splice(idx, 1);
              else {
                comparePins.push(id);
                if (comparePins.length > 5) comparePins.shift();
              }
              renderCompare();
            }
          });
        }
      }).addTo(map);

    if (pickerOptions.length) {
      buildCountryPicker(pickerOptions);
      document.getElementById('countryPicker')?.setAttribute('open', 'open');
      if (!initialSelectionDone && countryIds.length) {
        const picks = countryIds.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(6, countryIds.length));
        selectedCountries = new Set(picks);
        syncCountryCheckboxes();
        refreshVisibleCountries();
        initialSelectionDone = true;
      }
    }
  }

    // Arrows
    function getArrowColorValue(d) {
      const sel = document.getElementById('arrowColorVar');
      const key = sel?.value || 'pct_children';
      const val = Number.isFinite(d[key]) ? d[key] : 0;
      return Math.max(0, Math.min(1, val));
    }

    function renderCompare() {
      const panel = document.getElementById('detailPanel');
      const body = document.getElementById('detail-body');
      if (!panel || !body) return;
      if (!comparePins.length) {
        body.innerHTML = 'Click countries to add them here.';
        hideDetail();
        return;
      }
      const rows = comparePins.map(id => {
        const name = countryNames[id] || id;
        const f = factors[id] || {};
        const ref = flows.find(x => x.dest_iso3 === id) || {};
        const arrowVal = getArrowColorValue(ref);
        return `
          <div class="compare-card">
            <h4>${name} (${id})</h4>
            <div class="compare-rows">
              <div class="compare-row"><span class="label">GDP pc</span><span>${fmtNum(f.gdp_pc)}</span></div>
              <div class="compare-row"><span class="label">Unemployment</span><span>${fmtPct(f.unemployment)}</span></div>
              <div class="compare-row"><span class="label">Allocations % GDP</span><span>${fmtPct(f.alloc_pct_gdp)}</span></div>
              <div class="compare-row"><span class="label">Total refugees</span><span>${formatCount(ref.total_refugees)}</span></div>
              <div class="compare-row"><span class="label">Arrow metric</span><span>${fmtPct(arrowVal)}</span></div>
              <div class="compare-row"><span class="label">Children %</span><span>${fmtPct(ref.pct_children)}</span></div>
              <div class="compare-row"><span class="label">Adult women %</span><span>${fmtPct(ref.pct_women_adult)}</span></div>
              <div class="compare-row"><span class="label">Adult men %</span><span>${fmtPct(ref.pct_men_adult)}</span></div>
              <div class="compare-row"><span class="label">Elderly %</span><span>${fmtPct(ref.pct_elderly)}</span></div>
            </div>
          </div>
        `;
      }).join('');
      body.innerHTML = `<div class="compare-list">${rows}</div>`;
      panel.classList.add('open');
      panel.style.display = 'block';
      panel.focus?.();
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

    function drawArrows() {
      const existing = [];
      arrowsGroup.eachLayer(l => {
        existing.push(l);
        const path = l._path;
        if (path) {
          path.style.transition = 'opacity 200ms ease';
          path.style.opacity = '0';
        }
      });
      if (existing.length) {
        setTimeout(() => existing.forEach(l => arrowsGroup.removeLayer(l)), 200);
      } else {
        arrowsGroup.clearLayers();
      }
      if (!flows.length) return;
      const origin = L.latLng(ARROW_ORIGIN[0], ARROW_ORIGIN[1]);
      for (const d of flows) {
        if (!isCountryVisible(d.dest_iso3)) continue;
        const dest = L.latLng(+d.lat, +d.lon);
        const ctrl = L.latLng(
          (origin.lat + dest.lat) / 2 + 6,
          (origin.lng + dest.lng) / 2
        );
        const layer = L.polyline(bez(origin, ctrl, dest, 40), {
          pane: 'arrows',
          color: arrowColor(getArrowColorValue(d)),
          weight: Math.max(1, widthScale(+d.total_refugees || 1)),
          opacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false,
          className: 'flow-arrow'
        }).addTo(arrowsGroup);
        const path = layer._path;
        if (path) {
          path.style.transition = 'opacity 250ms ease';
          path.style.opacity = '0';
          requestAnimationFrame(() => { path.style.opacity = '0.9'; });
        }
      }
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
          return { varName: v, s };
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
        .attr('rx', 2)
        .attr('ry', 2)
        .attr('stroke-width', 1)
        .style('opacity', 0);

      const rectsMerged = rectsEnter.merge(rects)
        .attr('fill',   s => COLORS[s.varName]   || '#9ca3af')
        .attr('stroke', s => STROKES[s.varName]  || '#374151');

      const applyPos = sel => sel
        .attr('x', function (s, i) {
          const w = BOX_MAX;
          if (mode === 'side') {
            return i * (w + 4);
          }
          return -w / 2;
        })
        .attr('y', function (s, i) {
          const d = this.parentNode.__data__;
          if (mode === 'side') {
            return BOX_MAX - s.s;
          }
          const total = d3.sum(d.sizes, e => e.s) + (d.sizes.length - 1) * 2;
          const top   = -total / 2 + d3.sum(d.sizes.slice(0, i), e => e.s) + i * 2;
          return top;
        })
        .attr('width', BOX_MAX)
        .attr('height', s => s.s);

      if (shouldTransition) {
        applyPos(rectsMerged.transition().duration(260).ease(d3.easeCubicInOut));
        rectsEnter.transition().duration(200).style('opacity', 1);
      } else {
        applyPos(rectsMerged);
        rectsMerged.style('opacity', 1);
      }

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

      const labelEl = document.getElementById('arrowColorVar');
      const label = labelEl?.selectedOptions?.[0]?.text || 'Children %';

      const W = 300, H = 180;
      const P = { t: 8, r: 16, b: 12, l: 16 };
      const gradH = 16;

      const svg = root
        .append('svg')
        .attr('class', 'legend')
        .attr('width', W)
        .attr('height', H);

      svg
        .append('text')
        .attr('x', P.l)
        .attr('y', P.t + 12)
        .attr('class', 'legend-title')
        .text(`Arrow color — ${label}`);
      svg
        .append('text')
        .attr('x', P.l)
        .attr('y', P.t + 26)
        .attr('class', 'legend-tick')
        .text('0% to 100% of chosen demographic');

      const defs = svg.append('defs');
      const grad = defs
        .append('linearGradient')
        .attr('id', 'arrowGrad')
        .attr('x1', '0%')
        .attr('x2', '100%');

      d3.range(0, 1.001, 0.05).forEach(t => {
        grad
          .append('stop')
          .attr('offset', `${Math.round(t * 100)}%`)
          .attr('stop-color', arrowColor(t));
      });

      const gradW = W - P.l - P.r;
      const g = svg
        .append('g')
        .attr('transform', `translate(${P.l},${P.t + 36})`);

      g.append('rect')
        .attr('width', gradW)
        .attr('height', gradH)
        .attr('fill', 'url(#arrowGrad)')
        .attr('stroke', '#ddd');

      const axis = d3.scaleLinear().domain([0, 100]).range([0, gradW]);
      const ticks = [0, 25, 50, 75, 100];
      const gt = g.append('g').attr('transform', `translate(0,${gradH})`);
      gt
        .selectAll('g.tick')
        .data(ticks)
        .enter()
        .append('g')
        .attr('class', 'tick')
        .attr('transform', d => `translate(${axis(d)},0)`)
        .each(function (d) {
          d3.select(this)
            .append('line')
            .attr('y1', 0)
            .attr('y2', 6)
            .attr('stroke', '#9ca3af');
          d3.select(this)
            .append('text')
            .attr('y', 18)
            .attr('text-anchor', 'middle')
            .attr('class', 'legend-tick')
            .text(`${d}%`);
        });

      const dom = widthScale.domain();
      const lo = dom[0];
      const hi = dom[1];
      const mid = (lo + hi) / 2;
      const samples = [lo, mid, hi].map(v => ({
        label: formatCount(v),
        w: Math.max(1, widthScale(v))
      }));

      const rows = svg
        .append('g')
        .attr('transform', `translate(${P.l},${P.t + 18 + gradH + 48})`);

      rows
        .selectAll('g.row')
        .data(samples)
        .enter()
        .append('g')
        .attr('class', 'row')
        .attr('transform', (_, i) => `translate(0,${i * 18})`)
        .each(function (d) {
          d3.select(this)
            .append('line')
            .attr('x1', 0)
            .attr('x2', 64)
            .attr('y1', 0)
            .attr('y2', 0)
            .attr('stroke', '#6b7280')
            .attr('stroke-linecap', 'round')
            .attr('stroke-width', d.w);
            d3.select(this)
              .append('text')
              .attr('x', 72)
              .attr('y', 4)
              .attr('class', 'legend-tick')
              .text(d.label);
        });
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
        .text('Country minis — factors');

      const labels = {
        gdp_pc: 'GDP per capita',
        unemployment: 'Unemployment',
        alloc_pct_gdp: 'Allocations incl EU (% GDP)'
      };

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

    // Initial draw
    safe(drawCountries, '[init:countries]');
    safe(drawArrows,    '[init:arrows]');
    safe(drawMinis,     '[init:minis]');
    safe(renderArrowLegend, '[legend:arrows]');
    safe(renderBoxLegend,   '[legend:boxes]');

    // Reposition minis on pan/zoom
    map.on('moveend zoomend', () => safe(drawMinis, '[event:minis]'));

    // UI
    document.querySelectorAll('.controls .factor-toggle, .controls select').forEach(el => {
      el.addEventListener('change', () => {
        buildMiniScales();
        safe(drawArrows, '[ui:arrows]');
        safe(drawMinis,  '[ui:minis]');
        safe(renderArrowLegend, '[ui:legend-arrows]');
        safe(renderBoxLegend,   '[ui:legend-boxes]');
      });
    });

    document.querySelectorAll('input[name=boxmode]').forEach(el => {
      el.addEventListener('change', () => {
        safe(drawMinis, '[ui:minis:boxmode]');
        safe(renderBoxLegend, '[ui:legend-boxes]');
      });
    });

    document.getElementById('resetBtn')?.addEventListener('click', () => {
      document
        .querySelectorAll('.controls .factor-toggle')
        .forEach(el => { el.checked = false; });
      const arrowSel = document.getElementById('arrowColorVar');
      if (arrowSel) arrowSel.value = 'pct_children';
      const radio = document.querySelector('input[name=boxmode][value="stack"]');
      if (radio) radio.checked = true;
      selectedCountries = new Set(countryIds);
      syncCountryCheckboxes();
      updateCountrySummary();
      buildMiniScales();
      safe(drawArrows, '[reset:arrows]');
      safe(drawMinis,  '[reset:minis]');
      safe(renderArrowLegend, '[reset:legend-arrows]');
      safe(renderBoxLegend,   '[reset:legend-boxes]');
      comparePins.length = 0;
      renderCompare();
      hideDetail();
    });

    const closeBtn = document.getElementById('detailClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        hideDetail();
      });
    }
    const clearBtn = document.getElementById('detailClear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        comparePins.length = 0;
        renderCompare();
      });
    }

  } catch (e) {
    console.error('[load error]', e);
  } finally {
    window.bb.ready = true;
    window.dispatchEvent(new Event('bb:ready'));
  }
})();
