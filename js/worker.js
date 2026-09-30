// Train worker: a background thread that owns the route data and works out every train's
// position, so the page's main thread only draws. It talks to js/app.js by messages:
//
//   in:  filter {view, lengthKm, kinds}  which country/continent/world, clip or full routes, route lengths and kinds
//        camera {bounds, zoom}          after the map moves: load detail
//        frame  {t, bounds, zoom}       build the trains at simulated time t
//        highlight {route}              route to highlight (or null); resent as detail loads
//        frequency {frequency}          a FREQUENCIES id (config.js)
//   out: ready  {names, namesEn, lengths, kind, kinds, tph, kmh, basis}
//        scene  {...typed arrays}       heads and trails, handed over without copying
//        outside {xy, starts}           full-routes track outside the area
//        path   {route, xy, countries}  the highlighted route's geometry and countries, in order
//        error  {message}

importScripts('config.js', 'util.js', 'data.js', 'trains.js');

let routes, schedules, cells, filter, highlight = null;
const scene = new Scene();

const ready = (async () => {
    const world = JSON.parse(new TextDecoder().decode(await fetchBuffer(dataUrl('world.json'))));
    routes = new Routes(readBin(await fetchBuffer(dataUrl(world.routes))));
    schedules = buildSchedules(routes);
    cells = new DetailCells(routes, world.detail, debounce(() => { sendOutside(); sendPath(); }, 250));
    filter = makeFilter(routes, { mode: 'world' });
    const { names, namesEn, length: lengths, kind, kinds, tph, kmh, basis } = routes;
    postMessage({ type: 'ready', names, namesEn, lengths, kind, kinds, tph, kmh, basis });
})();

function debounce(fn, ms) {
    let timer;
    return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
}

function sendOutside() {
    const { xy, starts } = outsideTrack(routes, filter.clip ? { intervals: null } : filter);
    postMessage({ type: 'outside', xy, starts }, [xy.buffer, starts.buffer]);
}

function sendPath() {
    if (highlight === null) return;
    const xy = routePath(routes, highlight);
    const countries = [...new Set(Array.from(routes.spans(highlight, 'country'), ([, , i]) => routes.countries[i]))];
    postMessage({ type: 'path', route: highlight, xy, countries }, [xy.buffer]);
}

function sendScene(msg) {
    buildScene(scene, routes, schedules, filter, msg.t, {
        bounds: msg.bounds,
        zoom: msg.zoom,
        maxTrailPoints: msg.zoom < 3 ? 3 : msg.zoom < 5 ? 6 : msg.zoom < 7 ? 12 : msg.zoom < 9 ? 40 : 1000,
    });
    const out = { type: 'scene', count: scene.count };
    for (const [name, buffer] of Object.entries(scene)) {
        if (buffer instanceof GrowableArray) out[name] = buffer.copy();
    }
    postMessage(out, Object.values(out).filter(v => v.buffer).map(v => v.buffer));
}

onmessage = async ({ data: msg }) => {
    try {
        await ready;
        if (msg.type === 'filter') {
            filter = makeFilter(routes, msg.view, msg.lengthKm, msg.kinds);
            sendOutside();
        } else if (msg.type === 'camera') {
            cells.update(msg.bounds, msg.zoom);
        } else if (msg.type === 'frame') {
            sendScene(msg);
        } else if (msg.type === 'frequency') {
            schedules = buildSchedules(routes, msg.frequency);
        } else if (msg.type === 'highlight') {
            highlight = msg.route;
            sendPath();
        }
    } catch (err) {
        console.error(err);
        postMessage({ type: 'error', message: err.message });
    }
};
