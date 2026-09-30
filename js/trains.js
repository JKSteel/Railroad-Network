// Trains (runs in the worker): which trains are running at a moment, where they are, and
// the flat arrays deck.gl draws them from.
//
// No timetable: every route runs a steady flow of trains in both directions, at its own
// frequency and average speed (estimated by pipeline/services.py), around the clock.
// Because it's regular, the trains running at any moment are found arithmetically -
// nothing is stored per trip.


// ================================================================ schedules

// frequency: a FREQUENCIES id
function buildSchedules(routes, frequency = FREQUENCIES[0].id) {
    const schedules = [];
    for (let r = 0; r < routes.n; r++) {
        const service = SERVICES[routes.kinds[routes.kind[r]]];
        if (!service) { schedules.push(null); continue; }
        const speed = routes.kmh[r] / 3.6;  // m/s
        const duration = routes.length[r] / speed;
        let headway = frequency === 'even' ? service.evenHeadwayMin * 60 : 3600 / routes.tph[r];
        if (routes.maxOut[r]) headway = Math.max(headway, duration / routes.maxOut[r]);
        const trail = Math.min(service.trailMin ? service.trailMin * 60 : STYLE.trailLengthS, MAX_TRAIL_SHARE * headway);
        // Stagger routes (and the two directions) so trains don't all leave at once
        const phase = ((r * 0.618) % 1) * headway;
        schedules.push({
            speed, headway, trail, duration,
            base: [phase, phase + headway / 2],
            color: service.color,
            minZoom: service.minZoom || 0,
        });
    }
    return schedules;
}

// Calls visit(dir, age) for every trip on a route that's running or has a trail still
// fading at time t (simulated seconds). age = seconds since departure.
function forEachTrip(s, t, visit) {
    for (let dir = 0; dir < 2; dir++) {
        const first = Math.ceil((t - s.duration - s.trail - s.base[dir]) / s.headway);
        const last = Math.floor((t - s.base[dir]) / s.headway);
        for (let k = first; k <= last; k++) visit(dir, t - s.base[dir] - k * s.headway);
    }
}


// ================================================================ view filter

// Which routes the view shows, and (clip at border) the parts of each inside the area.
// intervals[r]: [start, end, start, end, ...] distances along route r inside the area.
// lengthKm: [shortest, longest] route to show (null = no limit); kinds: route kinds to show
// (null = all).
function makeFilter(routes, view, lengthKm = [null, null], kinds = null) {
    const lo = (lengthKm[0] ?? 0) * 1000, hi = (lengthKm[1] ?? Infinity) * 1000;
    const shownKind = routes.kinds.map(k => !kinds || kinds.includes(k));  // by kind index
    const long = r => routes.length[r] >= lo && routes.length[r] <= hi && shownKind[routes.kind[r]];
    if (view.mode === 'world') {
        return { active: Int32Array.from({ length: routes.n }, (_, r) => r).filter(long), intervals: null, clip: false };
    }

    const key = view.mode === 'country' ? 'country' : 'continent';
    const target = (key === 'country' ? routes.countries : routes.continents).indexOf(view.key);
    const active = [], intervals = [];
    for (let r = 0; r < routes.n; r++) {
        if (!long(r)) { intervals.push(null); continue; }
        const inside = [];
        for (const [a, b, index] of routes.spans(r, key)) {
            if (index !== target) continue;
            if (inside.length && inside[inside.length - 1] === a) inside[inside.length - 1] = b;
            else inside.push(a, b);
        }
        intervals.push(inside.length ? Float32Array.from(inside) : null);
        if (inside.length) active.push(r);
    }
    return { active: Int32Array.from(active), intervals, clip: view.clip };
}

function insideIntervals(iv, d) {
    for (let i = 0; i < iv.length; i += 2) if (d >= iv[i] && d <= iv[i + 1]) return true;
    return false;
}


// ================================================================ geometry

// Index of the segment containing distance d (binary search)
function segmentAt(dist, d) {
    let lo = 0, hi = dist.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (dist[mid] <= d) lo = mid; else hi = mid;
    }
    return lo;
}

// Write the point at distance d (on segment i) into out[k], out[k + 1]
function pointAt(xy, dist, d, i, out, k) {
    const f = Math.min(1, Math.max(0, (d - dist[i]) / (dist[i + 1] - dist[i] || 1)));
    out[k] = xy[2 * i] + f * (xy[2 * i + 2] - xy[2 * i]);
    out[k + 1] = xy[2 * i + 1] + f * (xy[2 * i + 3] - xy[2 * i + 1]);
}

// Polyline along a route between distances d0 < d1, appended to a GrowableArray.
// Returns the number of points added. Used for the "full routes" track outside the area.
function appendSlice(out, xy, dist, d0, d1) {
    const i0 = segmentAt(dist, d0), i1 = segmentAt(dist, d1);
    out.reserve(2 * (i1 - i0 + 2));
    pointAt(xy, dist, d0, i0, out.array, out.length);
    out.length += 2;
    for (let i = i0 + 1; i <= i1; i++) out.push2(xy[2 * i], xy[2 * i + 1]);
    pointAt(xy, dist, d1, i1, out.array, out.length);
    out.length += 2;
    return i1 - i0 + 2;
}


// ================================================================ scene
//
// Each frame, heads and trails are written into flat typed arrays that deck.gl uploads
// to the GPU directly. Building millions of small JS arrays per frame was the bottleneck.

// Growable typed array (like a preallocated numpy buffer that doubles when full)
class GrowableArray {
    constructor(Type, size = 1 << 16) { this.Type = Type; this.array = new Type(size); this.length = 0; }
    reserve(n) {
        if (this.length + n <= this.array.length) return;
        const bigger = new this.Type(Math.max(this.array.length * 2, this.length + n));
        bigger.set(this.array.subarray(0, this.length));
        this.array = bigger;
    }
    push1(a) { this.reserve(1); this.array[this.length++] = a; }
    push2(a, b) { this.reserve(2); this.array[this.length++] = a; this.array[this.length++] = b; }
    push3([a, b, c]) { this.reserve(3); this.array[this.length++] = a; this.array[this.length++] = b; this.array[this.length++] = c; }
    copy() { return this.array.slice(0, this.length); }  // a fresh buffer that can be handed to the page
}

class Scene {
    constructor() {
        this.headXY = new GrowableArray(Float32Array);
        this.headColor = new GrowableArray(Uint8Array);
        this.headRoute = new GrowableArray(Uint32Array);   // for tooltips
        this.headDist = new GrowableArray(Float32Array);   // distance travelled, m
        this.trailXY = new GrowableArray(Float32Array);
        this.trailTime = new GrowableArray(Float32Array);
        this.trailColor = new GrowableArray(Uint8Array);
        this.trailStarts = new GrowableArray(Uint32Array);
        this.count = 0;  // trains running in the view's area, including off-screen
    }
    reset() {
        for (const b of Object.values(this)) if (b instanceof GrowableArray) b.length = 0;
        this.count = 0;
    }
}

// Append a trail between trip distances s0 < s1 (distance travelled from the trip's origin)
// with at most maxPoints vertices. Timestamps are fractions of the trail's age (-1 = oldest
// end, 0 = now), so every trail fades over its own length.
// Runs for every train every frame, so it writes straight into the arrays (no per-vertex
// function calls or allocations).
function appendTrail(scene, xy, dist, L, dir, s0, s1, age, s, maxPoints, color) {
    const r0 = dir ? L - s0 : s0, r1 = dir ? L - s1 : s1;  // trip distance -> route distance
    const i0 = segmentAt(dist, r0), i1 = segmentAt(dist, r1);

    // Route vertices strictly between the tail and head, in travel direction
    const step = dir ? -1 : 1;
    const first = dir ? i0 : i0 + 1, last = dir ? i1 + 1 : i1;
    const inner = Math.max(0, (last - first) * step + 1);
    const stride = Math.max(1, Math.ceil(inner / Math.max(1, maxPoints - 2)));
    const n = Math.ceil(inner / stride) + 2;

    const { trailXY, trailTime, trailColor, trailStarts } = scene;
    trailStarts.push1(trailXY.length / 2);
    trailXY.reserve(2 * n);
    trailTime.reserve(n);
    trailColor.reserve(3 * n);
    const X = trailXY.array, T = trailTime.array, C = trailColor.array;
    let p = trailXY.length, t = trailTime.length, c = trailColor.length;
    const k = 1 / (s.speed * s.trail), a = age / s.trail;  // timestamp of trip distance d: d * k - a
    const cr = color[0], cg = color[1], cb = color[2];

    pointAt(xy, dist, r0, i0, X, p);
    p += 2;
    T[t++] = s0 * k - a;
    C[c++] = cr; C[c++] = cg; C[c++] = cb;
    for (let i = first, m = 0; m < inner; i += step * stride, m += stride) {
        X[p++] = xy[2 * i];
        X[p++] = xy[2 * i + 1];
        T[t++] = (dir ? L - dist[i] : dist[i]) * k - a;
        C[c++] = cr; C[c++] = cg; C[c++] = cb;
    }
    pointAt(xy, dist, r1, i1, X, p);
    p += 2;
    T[t++] = s1 * k - a;
    C[c++] = cr; C[c++] = cg; C[c++] = cb;

    trailXY.length = p;
    trailTime.length = t;
    trailColor.length = c;
}

// Screen bounds can run past 180° east (see wrappedBounds in app.js), so longitudes are
// also tried 360° on
const lonsOverlap = (x0, x1, b) => !(x0 > b[2] || x1 < b[0]) || !(x0 + 360 > b[2] || x1 + 360 < b[0]);
const boxOverlaps = (box, i, b) => lonsOverlap(box[i], box[i + 2], b) && !(box[i + 1] > b[3] || box[i + 3] < b[1]);
const pointInside = (x, y, b) => lonsOverlap(x, x, b) && y >= b[1] && y <= b[3];

// Everything to draw at time t. Only routes and trains inside `bounds`
// ([w, s, e, n], or null for all) are drawn, and only services shown at this zoom; in clip
// mode, only the parts inside the area.
function buildScene(scene, routes, schedules, filter, t, { bounds, zoom, maxTrailPoints }) {
    scene.reset();
    const tmp = new Float32Array(2);
    const box = routes.bbox;

    for (const r of filter.active) {
        const s = schedules[r];
        if (!s) continue;
        const iv = filter.intervals ? filter.intervals[r] : null;
        const clip = filter.clip ? iv : null;
        const L = routes.length[r], xy = routes.xy[r], dist = routes.dist[r];
        const onScreen = zoom >= s.minZoom && (!bounds || boxOverlaps(box, 4 * r, bounds));

        forEachTrip(s, t, (dir, age) => {
            const running = age <= s.duration;
            const sHead = Math.min(age * s.speed, L);
            const dHead = dir ? L - sHead : sHead;
            // Count trains in the area: clip mode counts by where the train is, full routes
            // counts every train on a route that touches the area
            if (running && (!clip || insideIntervals(clip, dHead))) scene.count++;
            if (!onScreen) return;

            // Cull by the head's position (or its last position, for a fading trail)
            const i = segmentAt(dist, dHead);
            pointAt(xy, dist, dHead, i, tmp, 0);
            if (bounds && !pointInside(tmp[0], tmp[1], bounds)) return;

            const sTail = Math.max(0, (age - s.trail) * s.speed);
            if (sHead > sTail) {
                if (!clip) {
                    appendTrail(scene, xy, dist, L, dir, sTail, sHead, age, s, maxTrailPoints, s.color);
                } else {
                    // Only the parts of the trail inside the area
                    const lo = dir ? L - sHead : sTail, hi = dir ? L - sTail : sHead;
                    for (let k = 0; k < clip.length; k += 2) {
                        const a = Math.max(lo, clip[k]), b = Math.min(hi, clip[k + 1]);
                        if (b <= a) continue;
                        const [t0, t1] = dir ? [L - b, L - a] : [a, b];
                        appendTrail(scene, xy, dist, L, dir, t0, t1, age, s, maxTrailPoints, s.color);
                    }
                }
            }

            if (running && (!clip || insideIntervals(clip, dHead))) {
                scene.headXY.push2(tmp[0], tmp[1]);
                scene.headColor.push3(s.color);
                scene.headRoute.push1(r);
                scene.headDist.push1(sHead);
            }
        });
    }
    return scene;
}

// A route's whole current geometry (detailed where loaded), for highlighting it
function routePath(routes, r) {
    return routes.xy[r].slice();  // a copy the page can take over
}

// "Full routes" view: the track of shown routes outside the area, as flat paths
function outsideTrack(routes, filter) {
    const xy = new GrowableArray(Float32Array), starts = new GrowableArray(Uint32Array);
    if (!filter.intervals) return { xy: xy.copy(), starts: starts.copy() };
    for (const r of filter.active) {
        const iv = filter.intervals[r], L = routes.length[r];
        let from = 0;
        for (let k = 0; k <= iv.length; k += 2) {
            const to = k < iv.length ? iv[k] : L;
            if (to - from > 1) {
                starts.push1(xy.length / 2);
                appendSlice(xy, routes.xy[r], routes.dist[r], from, to);
            }
            from = iv[k + 1];
        }
    }
    return { xy: xy.copy(), starts: starts.copy() };
}
