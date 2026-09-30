// Route data (runs in the worker): reading the pipeline's binary files, and each route's
// current geometry - coarse everywhere, with full detail swapped in per cell when zoomed in.
// See pipeline/export.py for the file layout.

const DTYPES = { f4: Float32Array, f8: Float64Array, u1: Uint8Array, u2: Uint16Array, u4: Uint32Array, i4: Int32Array };

// Typed-array views straight onto the file's bytes - no parsing
function readBin(buffer) {
    if (new TextDecoder().decode(new Uint8Array(buffer, 0, 4)) !== 'TVB1') throw new Error('Not a TVB1 file');
    const headerLength = new DataView(buffer).getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength)));
    const arrays = {};
    for (const [name, { dtype, offset, length }] of Object.entries(header.arrays)) {
        arrays[name] = new DTYPES[dtype](buffer, 8 + headerLength + offset, length);
    }
    return { meta: header.meta, arrays };
}

// A worker resolves relative URLs against its own script (js/worker.js), not the page
const dataUrl = path => new URL(DATA_DIR + path, new URL('..', self.location.href)).href;

async function fetchBuffer(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    return response.arrayBuffer();
}


// ================================================================ routes

// Per route r: xy[r] = Float32Array [lon0, lat0, lon1, ...], dist[r] = distance along the
// route at each vertex (m). Both start as the coarse geometry.
class Routes {
    constructor({ meta, arrays: a }) {
        Object.assign(this, meta);  // names, namesEn, kinds, countries, continents
        this.n = a.kind.length;
        this.kind = a.kind;
        this.tph = a.tph;      // trains per hour each way
        this.kmh = a.kmh;      // average speed
        this.basis = a.basis;  // how tph was found (BASIS_LABELS in app.js)
        this.maxOut = a.maxOut || new Uint8Array(this.n);  // trains out at once each way (ferries); 0 = no limit
        this.bbox = a.bbox;
        this.spanStart = a.spanStart;
        this.spanEnd = a.spanEnd;
        this.spanCountry = a.spanCountry;
        this.spanContinent = a.spanContinent;

        this.coarseXY = [];
        this.coarseDist = [];
        this.length = new Float32Array(this.n);
        for (let r = 0; r < this.n; r++) {
            const s = a.vertexStart[r], e = a.vertexStart[r + 1];
            this.coarseXY.push(a.xy.subarray(2 * s, 2 * e));
            this.coarseDist.push(a.dist.subarray(s, e));
            this.length[r] = a.dist[e - 1];
        }
        this.xy = this.coarseXY.slice();
        this.dist = this.coarseDist.slice();
        this.pieces = new Map();  // route -> detailed pieces from loaded cells [{ cell, xy, dist }]
    }

    // Region spans along route r as [start, end, index] triples; key: 'country' or 'continent'
    *spans(r, key) {
        const index = key === 'country' ? this.spanCountry : this.spanContinent;
        for (let i = this.spanStart[r]; i < this.spanStart[r + 1]; i++) {
            yield [i === this.spanStart[r] ? 0 : this.spanEnd[i - 1], this.spanEnd[i], index[i]];
        }
    }

    addCell(cell, { arrays: a }) {
        const touched = new Set();
        for (let i = 0; i < a.route.length; i++) {
            const r = a.route[i], s = a.vertexStart[i], e = a.vertexStart[i + 1];
            if (!this.pieces.has(r)) this.pieces.set(r, []);
            this.pieces.get(r).push({ cell, xy: a.xy.subarray(2 * s, 2 * e), dist: a.dist.subarray(s, e) });
            touched.add(r);
        }
        touched.forEach(r => this.rebuild(r));
    }

    removeCell(cell, routeIds) {
        for (const r of routeIds) {
            const kept = (this.pieces.get(r) || []).filter(p => p.cell !== cell);
            if (kept.length) this.pieces.set(r, kept); else this.pieces.delete(r);
            this.rebuild(r);
        }
    }

    // Merge coarse vertices with the loaded detailed pieces, by distance along the route.
    // Coarse vertices are a subset of the detailed ones with identical distances, so any
    // mix of the two is still the same route.
    rebuild(r) {
        const pieces = this.pieces.get(r);
        if (!pieces) {
            this.xy[r] = this.coarseXY[r];
            this.dist[r] = this.coarseDist[r];
            return;
        }
        pieces.sort((p, q) => p.dist[0] - q.dist[0]);
        const cxy = this.coarseXY[r], cd = this.coarseDist[r];
        let size = cd.length;
        for (const p of pieces) size += p.dist.length;
        const xy = new Float32Array(2 * size), dist = new Float32Array(size);
        let n = 0, last = -Infinity, c = 0;
        const push = (d, x, y) => {
            if (d <= last) return;  // pieces overlap by a vertex at cell edges
            xy[2 * n] = x; xy[2 * n + 1] = y; dist[n++] = d; last = d;
        };
        for (const p of pieces) {
            const end = p.dist[p.dist.length - 1];
            for (; c < cd.length && cd[c] < p.dist[0]; c++) push(cd[c], cxy[2 * c], cxy[2 * c + 1]);
            for (let i = 0; i < p.dist.length; i++) push(p.dist[i], p.xy[2 * i], p.xy[2 * i + 1]);
            while (c < cd.length && cd[c] <= end) c++;
        }
        for (; c < cd.length; c++) push(cd[c], cxy[2 * c], cxy[2 * c + 1]);
        this.xy[r] = xy.subarray(0, 2 * n);
        this.dist[r] = dist.subarray(0, n);
    }
}


// ================================================================ detail cells

// Loads the detail cells on screen once zoomed in; forgets the least recently seen ones
// beyond DETAIL_MAX_CELLS.
class DetailCells {
    constructor(routes, { dir, cellDeg, cells }, onChange) {
        this.routes = routes;
        this.dir = dir;
        this.cellDeg = cellDeg;
        this.available = new Set(cells);
        this.onChange = onChange;
        this.loaded = new Map();  // cell -> { routeIds, seen }
        this.loading = new Set();
        this.clock = 0;
    }

    update(bounds, zoom) {
        if (zoom < DETAIL_MIN_ZOOM || !bounds) return;
        this.clock++;
        const [w, s, e, n] = bounds.map(v => Math.floor(v / this.cellDeg));
        const around = 360 / this.cellDeg;  // bounds can run past 180°: wrap cell columns back
        for (let x = w; x <= e; x++) {
            for (let y = s; y <= n; y++) {
                const cell = `${mod(x + around / 2, around) - around / 2}_${y}`;
                if (!this.available.has(cell)) continue;
                if (this.loaded.has(cell)) this.loaded.get(cell).seen = this.clock;
                else if (!this.loading.has(cell)) this.load(cell);
            }
        }
    }

    async load(cell) {
        this.loading.add(cell);
        try {
            const data = readBin(await fetchBuffer(dataUrl(`${this.dir}/${cell}.bin`)));
            this.routes.addCell(cell, data);
            this.loaded.set(cell, { routeIds: new Set(data.arrays.route), seen: this.clock });
            this.evict();
            this.onChange();
        } catch (err) {
            console.error(err);
        } finally {
            this.loading.delete(cell);
        }
    }

    evict() {
        if (this.loaded.size <= DETAIL_MAX_CELLS) return;
        const oldest = [...this.loaded].sort((a, b) => a[1].seen - b[1].seen);
        for (const [cell, { routeIds, seen }] of oldest.slice(0, this.loaded.size - DETAIL_MAX_CELLS)) {
            if (seen === this.clock) break;  // never drop what's on screen
            this.routes.removeCell(cell, routeIds);
            this.loaded.delete(cell);
        }
    }
}
