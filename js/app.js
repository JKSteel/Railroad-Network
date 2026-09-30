// App: map, layers, controls and the animation loop. Train positions are worked out in a
// background thread (js/worker.js); this thread just draws them.

const state = {
    simTime: 0,                      // simulated seconds since the page opened
    rate: DEFAULT_RATE,
    playing: true,
    view: { ...DEFAULT_VIEW },       // { mode: 'country' | 'continent' | 'world', key, clip }
    lengthKm: [...DEFAULT_LENGTH_KM], // [shortest, longest] route with trains shown; null = no limit
    types: TRAIN_TYPES.map(t => t.id),  // train types shown (TRAIN_TYPES ids)
    frequency: FREQUENCIES[0].id,    // FREQUENCIES id
    layers: null,                    // layers panel: group id -> shown (set in main)
    lastKey: { country: DEFAULT_VIEW.key, continent: null },
};

let world = null;      // data/world.json: countries, continents, file index
let routeInfo = null;  // route names, lengths, frequency and speed, for tooltips and the card
let trainCount = 0;

const rgba = ([r, g, b, a = 255]) => `rgba(${r}, ${g}, ${b}, ${a / 255})`;


// ================================================================ view

// The view lives in the URL (#country=NZ, #continent=EU&full, #world, plus e.g. &len=10-500
// for route lengths, &types=hsr,urban for train types and &freq=even for the frequency), so
// reloading or sharing a link keeps it
function viewFromHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    const clip = !params.has('full');
    if (params.has('world')) return { mode: 'world', key: null, clip };
    for (const mode of ['country', 'continent']) {
        const key = params.get(mode);
        const known = mode === 'country' ? world.countries : world.continents;
        if (key && known[key]) return { mode, key, clip };
    }
    return world.countries[DEFAULT_VIEW.key] ? { ...DEFAULT_VIEW } : { mode: 'world', key: null, clip: true };
}

function lengthsFromHash() {
    const m = /^(\d*\.?\d*)-(\d*\.?\d*)$/.exec(new URLSearchParams(location.hash.slice(1)).get('len') || '');
    return m ? [m[1] ? Number(m[1]) : null, m[2] ? Number(m[2]) : null] : [...DEFAULT_LENGTH_KM];
}

function typesFromHash() {
    const types = new URLSearchParams(location.hash.slice(1)).get('types');
    const ids = TRAIN_TYPES.map(t => t.id);
    return types === null ? ids : types.split(',').filter(id => ids.includes(id));
}

function frequencyFromHash() {
    const freq = new URLSearchParams(location.hash.slice(1)).get('freq');
    return FREQUENCIES.some(f => f.id === freq) ? freq : FREQUENCIES[0].id;
}

function viewToHash({ mode, key, clip }, [lo, hi] = state.lengthKm, types = state.types) {
    const defaultLength = lo === DEFAULT_LENGTH_KM[0] && hi === DEFAULT_LENGTH_KM[1];
    return '#' + (mode === 'world' ? 'world' : `${mode}=${key}`) + (clip || mode === 'world' ? '' : '&full')
        + (defaultLength ? '' : `&len=${lo ?? ''}-${hi ?? ''}`)
        + (types.length === TRAIN_TYPES.length ? '' : `&types=${types.join(',')}`)
        + (state.frequency === FREQUENCIES[0].id ? '' : `&freq=${state.frequency}`);
}

// Route kinds of the shown train types, for the worker's filter
const shownKinds = () => TRAIN_TYPES.filter(t => state.types.includes(t.id)).flatMap(t => t.kinds);
const typeColor = t => SERVICES[t.kinds[0]].color;

function viewBbox({ mode, key }) {
    if (mode === 'country') return world.countries[key].bbox;
    if (mode === 'continent') return world.continents[key].bbox;
    return [-170, -50, 180, 70];
}


// ================================================================ map layers

// Layers panel: basemap groups (by the data layer each basemap style layer draws) and the
// extra track classes, each shown or hidden. Remembered in this browser only.
const LAYER_GROUPS = [
    { id: 'land', label: 'Land and water', section: 'Map' },
    { id: 'roads', label: 'Roads', section: 'Map' },
    { id: 'buildings', label: 'Buildings', section: 'Map' },
    { id: 'labels', label: 'Place names', section: 'Map' },
    { id: 'borders', label: 'Borders', section: 'Map' },
    { id: 'service', label: 'Sidings and yards', section: 'Track', trackClasses: ['service'] },
    { id: 'lifecycle', label: 'Construction and disused', section: 'Track', trackClasses: ['construction', 'disused'] },
];
const LAYERS_KEY = 'trainvis.layers';
let basemapLayers = [];  // [{id, group}] of the basemap's own style layers

function basemapGroup(layer) {
    const src = layer['source-layer'];
    if (!src) return null;  // the background: always shown
    if (src === 'transportation' && layer.id.includes('rail')) return 'never';  // the basemap's railways - ours replace them
    if (src === 'boundary') return 'borders';
    if (['building', 'housenumber', 'poi'].includes(src)) return 'buildings';
    if (['transportation', 'transportation_name', 'aeroway'].includes(src)) return 'roads';
    if (layer.type === 'symbol') return 'labels';  // place, sea and river names
    return 'land';
}

function loadLayerSettings() {
    const shown = Object.fromEntries(LAYER_GROUPS.map(g => [g.id, true]));
    try { Object.assign(shown, JSON.parse(localStorage.getItem(LAYERS_KEY)) || {}); } catch { /* private window etc. */ }
    return shown;
}

const hiddenTrackClasses = () => LAYER_GROUPS.filter(g => g.trackClasses && !state.layers[g.id]).flatMap(g => g.trackClasses);

function applyBasemapLayers(map) {
    for (const { id, group } of basemapLayers) {
        const visible = group === null || (group !== 'never' && state.layers[group]);
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
}

function setupLayersPanel(map) {
    const button = document.getElementById('layers-button'), panel = document.getElementById('layers-panel');
    let section = null;
    for (const g of LAYER_GROUPS) {
        if (g.section !== section) {
            section = g.section;
            panel.insertAdjacentHTML('beforeend', `<b>${section}</b>`);
        }
        panel.insertAdjacentHTML('beforeend',
            `<label><input type="checkbox" id="layer-${g.id}" data-group="${g.id}" ${state.layers[g.id] ? 'checked' : ''}> ${g.label}</label>`);
    }
    panel.addEventListener('change', e => {
        const group = e.target.dataset.group;
        if (!group) return;
        state.layers[group] = e.target.checked;
        try { localStorage.setItem(LAYERS_KEY, JSON.stringify(state.layers)); } catch { /* not remembered */ }
        applyBasemapLayers(map);
        applyMapFilter(map, state.view);
    });
    const setOpen = open => { panel.hidden = !open; button.setAttribute('aria-expanded', open); };
    button.addEventListener('click', () => setOpen(panel.hidden));
    document.addEventListener('click', e => { if (!e.target.closest('#layers')) setOpen(false); });
}

// Line width by zoom, times a factor (a number, or an expression per track class)
const trackWidth = (factor = 1) => ['interpolate', ['linear'], ['zoom'],
    4, ['*', 0.8, factor], 10, ['*', 1.5, factor], 14, ['*', 2.5, factor]];
const TRACK_GROUPS = [  // each dashed track class needs a layer of its own (the dash can't vary per feature)
    Object.keys(STYLE.tracks).filter(k => !STYLE.tracks[k].dash),
    ...Object.keys(STYLE.tracks).filter(k => STYLE.tracks[k].dash).map(k => [k]),
];
let trackLayers = [];  // [{id, source, classes}]: the track map layers, one per tile file and group

async function addMapLayers(map) {
    if (!map.isStyleLoaded()) await new Promise(resolve => map.once('load', resolve));
    basemapLayers = map.getStyle().layers.map(l => ({ id: l.id, group: basemapGroup(l) }));
    applyBasemapLayers(map);
    const firstLabel = map.getStyle().layers.find(l => l.type === 'symbol');
    const lineLayout = { 'line-join': 'round', 'line-cap': 'round' };
    const byClass = (prop, fallback) => ['match', ['get', 'k'],
        ...Object.entries(STYLE.tracks).flatMap(([k, t]) => [k, prop(t)]), fallback];

    // Tracks: vector tiles read piecewise from PMTiles files (see pipeline/tiles.py), split
    // by track class to keep each file under 100 MB; listed bottom first
    trackLayers = [];
    for (const { file, classes: inFile } of world.tracks.files) {
        const source = 'tracks-' + file.replace('.pmtiles', '');
        map.addSource(source, {
            type: 'vector',
            url: 'pmtiles://' + new URL(DATA_DIR + file, location.href).href,
        });
        for (const group of TRACK_GROUPS) {
            const classes = group.filter(k => inFile.includes(k));
            if (classes.length) trackLayers.push({ id: `${source}-${classes.length > 1 ? 'lines' : classes[0]}`, source, classes });
        }
    }
    for (const { id, source, classes } of trackLayers) {
        const dash = STYLE.tracks[classes[0]].dash;
        map.addLayer({
            id,
            type: 'line',
            source,
            'source-layer': 'tracks',
            layout: dash ? { 'line-join': 'round' } : lineLayout,
            paint: {
                'line-color': byClass(t => rgba(t.color), rgba(STYLE.tracks.other.color)),
                'line-width': trackWidth(byClass(t => t.width || 1, 1)),
                ...(dash ? { 'line-dasharray': dash } : {}),
            },
        }, firstLabel && firstLabel.id);  // under place names
    }

    // Everything outside the selected area is dimmed, labels included
    map.addSource('countries', { type: 'geojson', data: DATA_DIR + 'countries.geojson' });
    map.addLayer({
        id: 'mask', type: 'fill', source: 'countries',
        paint: { 'fill-color': rgba([...STYLE.mask.slice(0, 3)]), 'fill-opacity': STYLE.mask[3] / 255, 'fill-antialias': false },
    });
    map.addLayer({
        id: 'outline', type: 'line', source: 'countries',
        paint: { 'line-color': rgba(STYLE.outline), 'line-width': 1 },
    });

    // Full-routes mode: the shown routes' track beyond the area (from the worker)
    map.addSource('outside', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'outside', type: 'line', source: 'outside', layout: lineLayout,
        paint: { 'line-color': rgba(STYLE.tracks.main.color), 'line-width': trackWidth() },
    });

    // The hovered or clicked train's route: a soft glow in its train colour here, under the
    // trains; the thin line on top is drawn with the trains (sceneLayers) so trails don't hide it
    map.addSource('highlight', { type: 'geojson', data: emptyGeoJSON() });
    const { glow } = STYLE.highlight;
    map.addLayer({
        id: 'highlight', type: 'line', source: 'highlight', layout: lineLayout,
        paint: { 'line-color': ['get', 'color'], 'line-opacity': glow.alpha / 255, 'line-width': trackWidth(glow.width), 'line-blur': 6 },
    });
}

const emptyGeoJSON = () => ({ type: 'FeatureCollection', features: [] });

function applyMapFilter(map, { mode, key }) {
    if (!trackLayers.length) return;  // not added yet
    const show = (id, visible) => map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    const area = mode === 'world' ? null
        : mode === 'country' ? ['==', ['get', 'c'], key] : ['==', ['get', 'ct'], key];
    const hidden = hiddenTrackClasses();
    for (const { id, classes } of trackLayers) {
        const cls = ['in', ['get', 'k'], ['literal', classes.filter(k => !hidden.includes(k))]];
        map.setFilter(id, area ? ['all', area, cls] : cls);
    }
    if (mode === 'world') {
        show('mask', false);
        show('outline', false);
    } else if (mode === 'country') {
        map.setFilter('mask', ['!=', ['get', 'code'], key]);
        map.setFilter('outline', ['==', ['get', 'code'], key]);
        show('mask', true);
        show('outline', true);
    } else {
        map.setFilter('mask', ['!', ['in', key, ['get', 'continents']]]);  // continents is e.g. "AS,EU"
        show('mask', true);
        show('outline', false);
    }
}

function outsideGeoJSON({ xy, starts }) {
    const lines = [];
    for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1] : xy.length / 2;
        const line = [];
        for (let k = starts[i]; k < end; k++) line.push([xy[2 * k], xy[2 * k + 1]]);
        lines.push(line);
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
}

// Trails and heads are passed to deck.gl as flat typed arrays ("binary attributes"),
// which it uploads to the GPU without touching each vertex in JavaScript. highlight:
// {xy, color} of the highlighted route, drawn over the trails and under the heads.
function sceneLayers(scene, highlight) {
    const heads = {
        length: scene.headRoute.length,
        headRoute: scene.headRoute,  // looked up by index for tooltips
        headDist: scene.headDist,
        attributes: {
            getPosition: { value: scene.headXY, size: 2 },
            getFillColor: { value: scene.headColor, size: 3, normalized: true },
        },
    };
    return [
        new deck.TripsLayer({
            id: 'trails',
            data: {
                length: scene.trailStarts.length,
                startIndices: scene.trailStarts,
                attributes: {
                    getPath: { value: scene.trailXY, size: 2 },
                    getTimestamps: { value: scene.trailTime, size: 1 },
                    getColor: { value: scene.trailColor, size: 3, normalized: true },
                },
            },
            _pathType: 'open',  // data is already flat - skip deck's path normalisation
            currentTime: 0,     // trail timestamps are fractions of each trail's length, -1..0
            trailLength: 1,
            fadeTrail: true,
            widthMinPixels: 2.5,
            capRounded: true,
            jointRounded: true,
        }),
        highlight && new deck.PathLayer({
            id: 'highlight',
            data: { length: 1, startIndices: [0], attributes: { getPath: { value: highlight.xy, size: 2 } } },
            _pathType: 'open',
            getColor: highlight.color,
            getWidth: STYLE.highlight.core.widthPx,
            widthUnits: 'pixels',
            capRounded: true,
            jointRounded: true,
        }),
        new deck.ScatterplotLayer({
            id: 'glow',
            data: heads,
            opacity: STYLE.headGlowAlpha / 255,
            // Sized in metres but clamped in pixels: small when zoomed out, full glow when in
            getRadius: 1500,
            radiusMinPixels: 1.5,
            radiusMaxPixels: 5,
        }),
        new deck.ScatterplotLayer({
            id: 'core',
            data: { ...heads, attributes: { getPosition: heads.attributes.getPosition } },
            getFillColor: STYLE.headCore,
            getRadius: 600,
            radiusMinPixels: 0.8,
            radiusMaxPixels: 2,
            pickable: true,
        }),
    ];
}

const serviceOf = r => SERVICES[routeInfo.kinds[routeInfo.kind[r]]];

// Route of the train under the pointer (from deck.gl's picking), or null
function pickedRoute({ layer, index }) {
    return layer && layer.id === 'core' && index >= 0 ? layer.props.data.headRoute[index] : null;
}

// Card for the clicked train's route, above the panel (hidden when route is null).
// countries arrive a moment later, with the route's geometry from the worker.
function renderCard(route, countries = null) {
    const el = id => document.getElementById(id);
    el('card').hidden = route === null;
    if (route === null) return;
    const s = serviceOf(route), name = routeInfo.names[route], nameEn = routeInfo.namesEn[route];
    el('card').style.setProperty('--card-color', `rgb(${s.color})`);
    el('card-name').textContent = name;
    el('card-name-en').textContent = nameEn && nameEn !== name ? nameEn : '';
    const through = countries ? countries.map(c => world.countries[c] ? world.countries[c].name : c).join(', ') : '';
    el('card-meta').textContent = [s.label, `${(routeInfo.lengths[route] / 1000).toFixed(0)} km`, through].filter(Boolean).join(' · ');
    el('card-service').textContent = `Trains ${formatFrequency(routeInfo.tph[route])} each way · ~${Math.round(routeInfo.kmh[route])} km/h average`;
    el('card-basis').textContent = routeInfo.kinds[routeInfo.kind[route]] === 'freight'
        ? 'Freight: no passenger services or stations found along it in OSM'
        : BASIS_LABELS[routeInfo.basis[route]];

    // Links and the Wikipedia article's image, where the route has them (data/links.json,
    // fetched the first time a card opens)
    el('card-links').replaceChildren();
    el('card-image-link').hidden = true;
    const current = () => el('card').dataset.route === String(route);  // the card hasn't moved on
    routeLinks().then(all => {
        const links = all[route];
        if (!links || !current()) return;
        if (links.wikipedia) {
            articleImage(links.wikipedia).then(image => {
                if (!image || !current()) return;
                el('card-image').src = image.src;
                el('card-image-link').href = image.page;
                el('card-image-link').hidden = false;
            });
        }
        el('card-links').replaceChildren(...Object.entries(LINK_LABELS).filter(([key]) => links[key]).map(([key, label]) => {
            const a = document.createElement('a');
            a.href = key === 'wikipedia' ? wikipediaUrl(links.wikipedia) : links[key];
            a.textContent = label;
            a.target = '_blank';
            a.rel = 'noopener';
            return a;
        }));
    });
    el('card').dataset.route = route;
}

// How the route's frequency was estimated (pipeline/services.py BASIS_*)
const BASIS_LABELS = [
    'Frequency guessed: no services mapped in OSM',
    'Frequency from the services mapped in OSM',
    'Frequency from interval tags in OSM',
];

// Trains per hour -> "~3 an hour", "every ~1.5 hours", "~2 a day". It's all trains along
// the route's track, including services that share it (pipeline/services.py)
function formatFrequency(tph) {
    if (tph >= 0.75) return `~${Math.round(tph)} an hour`;
    const hours = 1 / tph;
    if (hours <= 12) return `every ~${hours < 3 ? Math.round(hours * 2) / 2 : Math.round(hours)} hours`;
    return `~${Math.max(1, Math.round(24 * tph))} a day`;
}

const LINK_LABELS = { wikipedia: 'Wikipedia', website: 'Website', operator: 'Operator', network: 'Network' };

// "de:Gotthardbahn" -> https://de.wikipedia.org/wiki/Gotthardbahn
function wikipediaUrl(article) {
    const i = article.indexOf(':');
    return `https://${article.slice(0, i)}.wikipedia.org/wiki/${encodeURIComponent(article.slice(i + 1).replace(/ /g, '_'))}`;
}

// The lead image of a Wikipedia article ("de:Gotthardbahn"), from the Wikipedia API in the
// browser: {src, page} (page: the file's page, with its author and licence), or null
const articleImages = new Map();
function articleImage(article) {
    if (!articleImages.has(article)) {
        const i = article.indexOf(':'), lang = article.slice(0, i), title = article.slice(i + 1);
        const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
            action: 'query', prop: 'pageimages', piprop: 'thumbnail|name', pithumbsize: 640,
            titles: title, redirects: 1, format: 'json', origin: '*',  // origin=*: allow a page on another site to read it
        });
        articleImages.set(article, fetch(url).then(r => r.json()).then(data => {
            const page = Object.values(data.query?.pages || {})[0];
            if (!page?.thumbnail) return null;
            return { src: page.thumbnail.source, page: `https://${lang}.wikipedia.org/wiki/File:${encodeURIComponent(page.pageimage)}` };
        }).catch(() => null));
    }
    return articleImages.get(article);
}

let linksPromise = null;
function routeLinks() {
    if (!linksPromise) {
        linksPromise = world.links
            ? fetch(DATA_DIR + world.links).then(r => r.ok ? r.json() : {}).catch(() => ({}))
            : Promise.resolve({});
    }
    return linksPromise;
}

function tooltip({ layer, index }) {
    if (!layer || layer.id !== 'core' || index < 0 || !routeInfo) return null;
    const r = layer.props.data.headRoute[index];
    const name = routeInfo.names[r], nameEn = routeInfo.namesEn[r];
    const title = nameEn && nameEn !== name ? `${name}\n${nameEn}` : name;
    const km = layer.props.data.headDist[index] / 1000, total = routeInfo.lengths[r] / 1000;
    return {
        text: `${title}\n${serviceOf(r).label} · ${km.toFixed(0)} of ${total.toFixed(0)} km`,
        style: { background: 'rgba(18,20,26,0.9)', color: '#e8e6e1', font: '12px system-ui', borderRadius: '6px' },
    };
}

// The map repeats sideways, so after scrolling round, its bounds can be e.g. west 530°.
// Shift them so west is in [-180, 180); east = west + width can still pass 180 (the worker
// checks longitudes 360° on too). Null when the whole width of the world is on screen.
function wrappedBounds(w, s, e, n) {
    if (e - w >= 360) return null;
    const shift = mod(w + 180, 360) - 180 - w;
    return [w + shift, s, e + shift, n];
}

// Only trains near the screen are built; fewer trail points when zoomed out
function paddedBounds(map) {
    if (map.getZoom() < 3) return null;
    const b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.2, padY = (b.getNorth() - b.getSouth()) * 0.2;
    return wrappedBounds(b.getWest() - padX, b.getSouth() - padY, b.getEast() + padX, b.getNorth() + padY);
}


// ================================================================ controls

function setupControls(map, worker) {
    const el = id => document.getElementById(id);
    const playBtn = el('play'), place = el('place');

    const togglePlay = () => {
        state.playing = !state.playing;
        playBtn.textContent = state.playing ? '❚❚' : '▶';
    };
    playBtn.addEventListener('click', togglePlay);
    // Space toggles play. Cancelling keyup too stops a focused button (e.g. the last one
    // clicked) from also being "clicked" by the same key press.
    document.addEventListener('keydown', e => {
        if (e.code === 'Space' && e.target !== place) { e.preventDefault(); if (!e.repeat) togglePlay(); }
    });
    document.addEventListener('keyup', e => { if (e.code === 'Space' && e.target !== place) e.preventDefault(); });

    const ratesEl = el('rates');
    for (const rate of RATES) {
        const btn = document.createElement('button');
        btn.textContent = rate.label;
        btn.classList.toggle('active', rate.value === state.rate);
        btn.addEventListener('click', () => {
            state.rate = rate.value;
            ratesEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        });
        ratesEl.appendChild(btn);
    }

    // View: mode buttons, country/continent picker, clip toggle
    const setView = (view, { fit = true, animate = true } = {}) => {
        state.view = view;
        if (view.key) state.lastKey[view.mode] = view.key;
        history.replaceState(null, '', viewToHash(view));
        renderViewControls();
        applyMapFilter(map, view);
        worker.postMessage({ type: 'filter', view, lengthKm: state.lengthKm, kinds: shownKinds() });
        if (!fit) return;
        const [w, s, e, n] = viewBbox(view);
        map.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: 11, duration: animate ? 2000 : 0 });
    };

    // Switching mode keeps to the same part of the world: a country's continent, or the
    // last country picked (if it's in this continent), else the continent's biggest network
    const defaultKey = mode => {
        const { mode: current, key } = state.view;
        if (mode === 'continent') {
            return current === 'country' ? world.countries[key].continents[0]
                : state.lastKey.continent || Object.keys(world.continents)[0];
        }
        const countries = Object.entries(world.countries);
        const last = world.countries[state.lastKey.country];
        if (current !== 'continent' && last) return state.lastKey.country;
        if (last && last.continents.includes(key)) return state.lastKey.country;
        const candidates = countries.filter(([, c]) => current !== 'continent' || c.continents.includes(key));
        return candidates.sort((a, b) => b[1].routeKm - a[1].routeKm)[0][0];
    };

    el('modes').addEventListener('click', e => {
        const mode = e.target.dataset.mode;
        if (mode && mode !== state.view.mode) setView({ ...state.view, mode, key: mode === 'world' ? null : defaultKey(mode) });
    });
    place.addEventListener('change', () => setView({ ...state.view, key: place.value }));
    el('clipmode').addEventListener('click', e => {
        if (e.target.dataset.clip) setView({ ...state.view, clip: e.target.dataset.clip === '1' }, { fit: false });
    });

    // Route length: applied a moment after typing stops (an empty box = no limit)
    const lenMin = el('len-min'), lenMax = el('len-max');
    [lenMin.value, lenMax.value] = state.lengthKm.map(v => v ?? '');
    let lengthTimer;
    const onLength = () => {
        clearTimeout(lengthTimer);
        lengthTimer = setTimeout(() => {
            state.lengthKm = [lenMin, lenMax].map(input => input.value === '' || !(Number(input.value) >= 0) ? null : Number(input.value));
            setView(state.view, { fit: false });
        }, 300);
    };
    lenMin.addEventListener('input', onLength);
    lenMax.addEventListener('input', onLength);

    // Train types: one toggle per colour
    const typesEl = el('types');
    for (const t of TRAIN_TYPES) {
        const btn = document.createElement('button');
        btn.dataset.type = t.id;
        btn.title = t.label;
        btn.innerHTML = `<i style="background: rgb(${typeColor(t)})"></i>${t.short || t.label}`;
        typesEl.appendChild(btn);
    }
    const renderTypes = () => typesEl.querySelectorAll('button').forEach(b => {
        b.classList.toggle('active', state.types.includes(b.dataset.type));
        b.setAttribute('aria-pressed', state.types.includes(b.dataset.type));
    });
    typesEl.addEventListener('click', e => {
        const id = e.target.closest('button')?.dataset.type;
        if (!id) return;
        state.types = state.types.includes(id) ? state.types.filter(x => x !== id) : [...state.types, id];
        renderTypes();
        setView(state.view, { fit: false });
    });
    renderTypes();

    // Frequency: the pipeline's estimate per route, or even
    const freqEl = el('frequency');
    for (const f of FREQUENCIES) {
        const btn = document.createElement('button');
        btn.dataset.freq = f.id;
        btn.textContent = f.label;
        btn.title = f.title;
        freqEl.appendChild(btn);
    }
    const setFrequency = id => {
        state.frequency = id;
        freqEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.freq === id));
        worker.postMessage({ type: 'frequency', frequency: id });
    };
    freqEl.addEventListener('click', e => {
        if (!e.target.dataset.freq) return;
        setFrequency(e.target.dataset.freq);
        history.replaceState(null, '', viewToHash(state.view));
    });
    setFrequency(state.frequency);  // the view isn't read from the URL yet - leave it be

    function renderViewControls() {
        const { mode, key, clip } = state.view;
        el('modes').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        el('clipmode').querySelectorAll('button').forEach(b => b.classList.toggle('active', (b.dataset.clip === '1') === clip));
        el('picker').hidden = mode === 'world';
        if (mode === 'world') return;

        place.innerHTML = '';
        const byName = (a, b) => a[1].name.localeCompare(b[1].name);
        if (mode === 'continent') {
            for (const [code, c] of Object.entries(world.continents).sort(byName)) place.add(new Option(c.name, code));
        } else {
            // Countries with routes, grouped by continent (Russia and Turkey under both of theirs)
            for (const [cont, c] of Object.entries(world.continents).sort(byName)) {
                const group = document.createElement('optgroup');
                group.label = c.name;
                for (const [code, country] of Object.entries(world.countries).sort(byName)) {
                    if (country.continents.includes(cont) && (country.routeKm > 0 || code === key)) group.appendChild(new Option(country.name, code));
                }
                if (group.children.length) place.appendChild(group);
            }
        }
        place.value = key;
    }

    return {
        setView,
        update() {
            el('count').textContent = trainCount.toLocaleString();
        },
    };
}

// Key: train types (one colour each), then track styles
function renderLegend() {
    const trains = TRAIN_TYPES.map(t =>
        `<span><i class="dot" style="background: rgb(${typeColor(t)})"></i>${t.label}</span>`).join('');
    const tracks = Object.values(STYLE.tracks).map(t => {
        const [r, g, b, a] = t.color;
        const [on, off] = (t.dash || []).map(d => d * 2);  // map dashes are in line widths, ~2 px here
        const line = t.dash
            ? `background: repeating-linear-gradient(90deg, ${rgba(t.color)} 0 ${on}px, transparent ${on}px ${on + off}px)`
            : `background: ${rgba([r, g, b, Math.min(255, a * 1.4)])}`;  // a touch brighter than on the dark map
        return `<span><i class="line" style="${line}; height: ${Math.max(1, 3 * (t.width || 1))}px"></i>${t.label}</span>`;
    }).join('');
    document.getElementById('legend').innerHTML =
        `<details><summary>Key</summary><div class="key-group"><b>Trains</b>${trains}</div>` +
        `<div class="key-group"><b>Track</b>${tracks}</div>` +
        `<p>Metro, light rail and trams appear from zoom 8, sidings from zoom 11.</p></details>`;
}


// ================================================================ main

// Tell the local server (serve.py) when this page opens and closes, so it can stop itself
// once no pages are left. sendBeacon is used on close because browsers still deliver it
// while the page is being torn down. Pages restored from the back/forward cache check back in.
function checkInWithServer() {
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) return;  // only serve.py understands this
    const opened = () => fetch('/_opened', { method: 'POST' }).catch(() => {});
    opened();
    addEventListener('pagehide', () => navigator.sendBeacon('/_closed'));
    addEventListener('pageshow', e => { if (e.persisted) opened(); });
}

async function main() {
    checkInWithServer();
    const status = document.getElementById('status');
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const map = new maplibregl.Map({
        container: 'map',
        style: STYLE.basemap,
        center: [150, 0],
        zoom: 2,
        renderWorldCopies: true,  // scrolling sideways carries on round the world
        attributionControl: { compact: true },
    });
    // Hovering a train highlights its route; clicking pins it and shows its card (click
    // elsewhere, the card's × or Esc to clear)
    let hovered = null, pinned = null, shown = null, carded = null, worker = null;
    let lastCountries = { route: null, countries: null };  // from the worker's last path message
    const setHighlight = () => {
        if (pinned !== carded && routeInfo) {
            renderCard(carded = pinned, lastCountries.route === pinned ? lastCountries.countries : null);
        }
        const route = pinned ?? hovered;
        if (route === shown || !worker || !routeInfo) return;
        shown = route;
        worker.postMessage({ type: 'highlight', route });
        if (route === null) {
            highlight = null;
            if (map.getSource('highlight')) map.getSource('highlight').setData(emptyGeoJSON());
        }
    };
    let highlight = null;  // {xy, color} of the shown route, for sceneLayers
    const overlay = new deck.MapboxOverlay({
        interleaved: false, layers: [], getTooltip: tooltip,
        pickingRadius: 6,  // train heads are only a few pixels across
        onHover: info => { hovered = pickedRoute(info); setHighlight(); },
        onClick: info => { pinned = pickedRoute(info); setHighlight(); },
    });
    map.addControl(overlay);
    const unpin = () => { pinned = null; setHighlight(); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') unpin(); });
    document.getElementById('card-close').addEventListener('click', unpin);
    window.trainvis = { map, state, overlay };  // handy for poking at from the browser console
    state.layers = loadLayerSettings();
    setupLayersPanel(map);

    try {
        world = await (await fetch(DATA_DIR + 'world.json')).json();
    } catch (err) {
        status.textContent = location.protocol === 'file:'
            ? 'Open this through the local server: python serve.py'
            : 'No data yet - run: python pipeline/build_world.py';
        throw err;
    }

    worker = new Worker('js/worker.js');
    state.lengthKm = lengthsFromHash();
    state.types = typesFromHash();
    state.frequency = frequencyFromHash();
    const controls = setupControls(map, worker);
    renderLegend();

    let busy = false, failed = false, outside = null;
    status.textContent = 'Loading routes…';
    worker.onmessage = ({ data: msg }) => {
        if (msg.type === 'ready') {
            routeInfo = msg;
            status.textContent = '';
        } else if (msg.type === 'scene') {
            busy = false;
            trainCount = msg.count;
            overlay.setProps({ layers: sceneLayers(msg, highlight) });
        } else if (msg.type === 'outside') {
            outside = outsideGeoJSON(msg);
            if (map.getSource('outside')) map.getSource('outside').setData(outside);
        } else if (msg.type === 'path') {
            lastCountries = { route: msg.route, countries: msg.countries };
            if (msg.route === pinned) renderCard(pinned, msg.countries);
            if (msg.route !== shown || !map.getSource('highlight')) return;  // superseded
            const coordinates = [];
            for (let i = 0; i < msg.xy.length; i += 2) coordinates.push([msg.xy[i], msg.xy[i + 1]]);
            const color = serviceOf(msg.route).color, w = STYLE.highlight.core.whiten;
            highlight = { xy: msg.xy, color: color.map(c => Math.round(c + (255 - c) * w)) };
            map.getSource('highlight').setData({ type: 'Feature', properties: { color: rgba(color) }, geometry: { type: 'LineString', coordinates } });
        } else if (msg.type === 'error') {
            failed = true;
            status.textContent = `Couldn't load the trains: ${msg.message}`;
        }
    };

    const sendCamera = () => {
        const b = map.getBounds();
        worker.postMessage({
            type: 'camera', zoom: map.getZoom(),
            bounds: wrappedBounds(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()),
        });
    };
    map.on('moveend', sendCamera);

    controls.setView(viewFromHash(), { animate: false });

    addMapLayers(map).then(() => {
        applyMapFilter(map, state.view);
        if (outside) map.getSource('outside').setData(outside);
    });

    let last = performance.now();
    function frame(now) {
        const dt = Math.min((now - last) / 1000, 0.1);  // clamp so a background tab doesn't jump hours
        last = now;
        if (state.playing) state.simTime += dt * state.rate;
        controls.update();
        if (!busy && !failed) {
            busy = true;
            worker.postMessage({ type: 'frame', t: state.simTime, zoom: map.getZoom(), bounds: paddedBounds(map) });
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

main();
