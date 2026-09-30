// Settings: services, playback, styling. Everything tunable lives here.
// Loaded by both the page and the train worker (js/worker.js).

const DATA_DIR = 'data/';

// How each route kind (from pipeline/build_world.py) looks. How fast its trains run is per
// route, estimated by the pipeline (pipeline/services.py) - a steady flow, no timetable.
// How often: the pipeline's estimate per route, or (the "Even" frequency) every
// evenHeadwayMin minutes on every route of the kind, so even once-a-day trains show.
// trailMin (optional) overrides STYLE.trailLengthS; trails are also kept shorter than the
// gap between trains, or they merge. minZoom (optional): trains are only drawn from this
// zoom (they still count as running).
const SERVICES = {
    hsr: { label: 'High-speed', evenHeadwayMin: 30, trailMin: 10, color: [110, 205, 255] },
    mainline: { label: 'Mainline', evenHeadwayMin: 90, color: [255, 181, 58] },
    suburban: { label: 'Suburban', evenHeadwayMin: 30, color: [255, 181, 58] },
    freight: { label: 'Freight', evenHeadwayMin: 90, color: [185, 95, 255] },
    metro: { label: 'Metro / light rail', evenHeadwayMin: 8, trailMin: 4, color: [90, 222, 140], minZoom: 8 },
    tram: { label: 'Tram', evenHeadwayMin: 10, trailMin: 4, color: [90, 222, 140], minZoom: 8 },
};
const FREQUENCIES = [  // the frequency toggle; the first is the default
    { id: 'even', label: 'Even', title: 'The same on every route of a kind, so even once-a-day trains show' },
    { id: 'estimated', label: 'Estimated', title: 'Estimated per route from OpenStreetMap' },
];
const MAX_TRAIL_SHARE = 0.6;  // of the gap between trains

// Train types as the viewer groups them: one colour each, in the key and the type filter
const TRAIN_TYPES = [
    { id: 'hsr', label: 'High-speed', kinds: ['hsr'] },
    { id: 'main', label: 'Mainline & suburban', short: 'Mainline', kinds: ['mainline', 'suburban'] },
    { id: 'urban', label: 'Metro, light rail & tram', short: 'Metro/tram', kinds: ['metro', 'tram'] },
    { id: 'freight', label: 'Freight', kinds: ['freight'] },
];

const DEFAULT_VIEW = { mode: 'country', key: 'NZ', clip: true };
const DEFAULT_LENGTH_KM = [2, null];  // route length filter [shortest, longest]; null = no limit (routes start at 2 km)

// Playback: simulated seconds per real second. Train speeds are real; time is compressed.
const RATES = [
    { label: '1 min/s', value: 60 },
    { label: '5 min/s', value: 300 },
    { label: '15 min/s', value: 900 },
    { label: '1 h/s', value: 3600 },
];
const DEFAULT_RATE = 300;

// Route geometry: coarse (~250 m) everywhere, full detail loaded per 1-degree cell once
// zoomed in this far. Coarse is sub-pixel below it.
const DETAIL_MIN_ZOOM = 9;
const DETAIL_MAX_CELLS = 300;  // cached cells; the least recently seen are dropped beyond this

const STYLE = {
    basemap: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    // Tracks stay neutral grey so colour only ever means train type - tinted tracks
    // camouflaged trains of the same hue. Track types differ by brightness, width and dashes.
    // Keys are the track classes in the tiles (pipeline/build_world.py TRACK_MINZOOM, which
    // also sets the zoom each appears from); the key on the page lists them in this order.
    // width: relative to main lines.
    tracks: {
        main: { label: 'Railway line', color: [150, 160, 180, 150] },
        hsr: { label: 'High-speed line', color: [185, 190, 200, 170] },
        ferry: { label: 'Train ferry', color: [150, 160, 180, 150], width: 0.8, dash: [1, 2.5] },
        metro: { label: 'Metro / light rail', color: [150, 160, 180, 120], width: 0.8 },
        tram: { label: 'Tram', color: [150, 160, 180, 90], width: 0.6 },
        heritage: { label: 'Heritage (no trains)', color: [150, 160, 180, 60] },
        other: { label: 'Other track (no trains)', color: [150, 160, 180, 45], width: 0.7 },
        service: { label: 'Sidings and yards', color: [150, 160, 180, 40], width: 0.5 },
        construction: { label: 'Under construction', color: [150, 160, 180, 120], width: 0.8, dash: [2, 2] },
        disused: { label: 'Disused', color: [150, 160, 180, 35], width: 0.5 },
    },
    // The route of a hovered or clicked train: a glow in its train colour (width relative to
    // main lines) and a thin line on top, that colour mixed this much towards white
    highlight: { glow: { alpha: 90, width: 8 }, core: { widthPx: 2.5, whiten: 0.7 } },
    mask: [5, 6, 10, 150],              // dims everything outside the selected country/continent
    outline: [235, 95, 95, 90],         // the selected country's border: a faint red, unlike any train colour
    trailLengthS: 30 * 60,              // default trail = where the train was in the last 30 sim-minutes
    headCore: [255, 243, 205, 255],
    headGlowAlpha: 70,
};
