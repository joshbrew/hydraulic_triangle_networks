const EPSILON = Math.pow(2, -52);
const EDGE_STACK = new Uint32Array(512);

function orient2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
    const acx = ax - cx;
    const acy = ay - cy;
    const bcx = bx - cx;
    const bcy = by - cy;
    return acy * bcx - acx * bcy;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}

function circumradius(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const ex = cx - ax;
    const ey = cy - ay;

    const bl = dx * dx + dy * dy;
    const cl = ex * ex + ey * ey;
    const determinant = dx * ey - dy * ex;

    if (determinant === 0) return Infinity;
    const factor = 0.5 / determinant;

    const x = (ey * bl - dy * cl) * factor;
    const y = (dx * cl - ex * bl) * factor;

    return x * x + y * y;
}

function hashKey(dx: number, dy: number, hashSize: number): number {
    const absSum = Math.abs(dx) + Math.abs(dy);
    if (absSum === 0) return 0;
    const p = dx / absSum;
    return (((dy > 0 ? 3 - p : 1 + p) * hashSize * 0.25) | 0) % hashSize;
}

function insertionSort(ids: Uint32Array, dists: Float64Array, left: number, right: number): void {
    for (let i = left + 1; i <= right; i++) {
        const id = ids[i];
        const d = dists[id];
        let j = i - 1;
        while (j >= left && dists[ids[j]] > d) {
            ids[j + 1] = ids[j];
            j--;
        }
        ids[j + 1] = id;
    }
}

function swap(arr: Uint32Array, i: number, j: number): void {
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
}

function quicksort(ids: Uint32Array, dists: Float64Array, left: number, right: number): void {
    if (right - left <= 20) {
        insertionSort(ids, dists, left, right);
        return;
    }

    const median = (left + right) >> 1;
    if (dists[ids[left]] > dists[ids[right]]) swap(ids, left, right);
    if (dists[ids[left]] > dists[ids[median]]) swap(ids, left, median);
    if (dists[ids[median]] > dists[ids[right]]) swap(ids, median, right);

    const pivot = ids[median];
    const pivotDist = dists[pivot];
    swap(ids, median, right);
    let partitionIndex = left;

    for (let i = left; i < right; i++) {
        if (dists[ids[i]] < pivotDist) {
            swap(ids, i, partitionIndex);
            partitionIndex++;
        }
    }
    swap(ids, partitionIndex, right);

    const leftSize = partitionIndex - left;
    const rightSize = right - partitionIndex;
    if (leftSize < rightSize) {
        quicksort(ids, dists, left, partitionIndex - 1);
        quicksort(ids, dists, partitionIndex + 1, right);
    } else {
        quicksort(ids, dists, partitionIndex + 1, right);
        quicksort(ids, dists, left, partitionIndex - 1);
    }
}

function defaultGetX(p: [number, number]): number {
    return p[0];
}

function defaultGetY(p: [number, number]): number {
    return p[1];
}

export default class Delaunator {
    coords: Float64Array;
    triangles!: Uint32Array;
    halfedges!: Int32Array;
    hull!: Uint32Array;
    pointCount: number;
    capacity: number;

    private _cx!: number;
    private _cy!: number;
    private _hullStart!: number;
    private _hullPrev!: Uint32Array;
    private _hullNext!: Uint32Array;
    private _hullTri!: Uint32Array;
    private _hullHash!: Int32Array;
    private _ids!: Uint32Array;
    private _dists!: Float64Array;
    private _triangles!: Uint32Array;
    private _halfedges!: Int32Array;
    private _hashSize!: number;
    private trianglesLen!: number;

    static from(
        points: Array<[number, number]>,
        getX = defaultGetX,
        getY = defaultGetY,
        capacity = points.length
    ): Delaunator {
        const n = points.length;
        if (capacity < n) {
            throw new RangeError(`capacity ${capacity} is smaller than point count ${n}`);
        }

        const coords = new Float64Array(capacity * 2);
        for (let i = 0, j = 0; i < n; i++, j += 2) {
            const p = points[i];
            coords[j] = getX(p);
            coords[j + 1] = getY(p);
        }
        return new Delaunator(coords, n);
    }

    static withCapacity(capacity: number): Delaunator {
        return new Delaunator(capacity, 0);
    }

    constructor(coordsOrCapacity: Float64Array | number, pointCount?: number) {
        if (typeof coordsOrCapacity === 'number') {
            const capacity = Math.max(0, Math.floor(coordsOrCapacity));
            this.coords = new Float64Array(capacity * 2);
            this.capacity = capacity;
            this.pointCount = pointCount === undefined ? 0 : Math.max(0, Math.floor(pointCount));
            if (this.pointCount > this.capacity) {
                throw new RangeError(`pointCount ${this.pointCount} exceeds capacity ${this.capacity}`);
            }
        } else {
            this.coords = coordsOrCapacity;
            this.capacity = coordsOrCapacity.length >> 1;
            this.pointCount = pointCount === undefined ? this.capacity : Math.max(0, Math.floor(pointCount));
            if (this.pointCount > this.capacity) {
                throw new RangeError(`pointCount ${this.pointCount} exceeds capacity ${this.capacity}`);
            }
        }

        this._allocate(this.capacity);
        this.update();
    }

    get activeCoords(): Float64Array {
        return this.coords.subarray(0, this.pointCount << 1);
    }

    clear(): void {
        this.pointCount = 0;
        this.update();
    }

    reserve(minCapacity: number): void {
        const targetCapacity = Math.max(0, Math.floor(minCapacity));
        if (targetCapacity <= this.capacity) return;

        const nextCoords = new Float64Array(targetCapacity * 2);
        nextCoords.set(this.coords.subarray(0, this.pointCount << 1));
        this.coords = nextCoords;
        this.capacity = targetCapacity;
        this._allocate(targetCapacity);
    }

    ensureCapacity(minCapacity: number): void {
        const needed = Math.max(0, Math.floor(minCapacity));
        if (needed <= this.capacity) return;

        let next = this.capacity > 0 ? this.capacity : 1;
        while (next < needed) next *= 2;
        this.reserve(next);
    }

    setPointCount(pointCount: number): void {
        const count = Math.max(0, Math.floor(pointCount));
        this.ensureCapacity(count);
        this.pointCount = count;
    }

    setPoint(index: number, x: number, y: number): void {
        const i = Math.floor(index);
        if (i < 0) {
            throw new RangeError(`index ${index} must be >= 0`);
        }

        this.ensureCapacity(i + 1);

        const j = i << 1;
        this.coords[j] = x;
        this.coords[j + 1] = y;

        if (i >= this.pointCount) {
            this.pointCount = i + 1;
        }
    }

    setPointsFlat(source: ArrayLike<number>, pointCount = source.length >> 1): void {
        const count = Math.max(0, Math.floor(pointCount));
        this.setPointCount(count);
        const coordCount = count << 1;
        for (let i = 0; i < coordCount; i++) {
            this.coords[i] = source[i];
        }
    }

    update(pointCount = this.pointCount): void {
        this.setPointCount(pointCount);

        const coords = this.coords;
        const hullPrev = this._hullPrev;
        const hullNext = this._hullNext;
        const hullTri = this._hullTri;
        const hullHash = this._hullHash;
        const ids = this._ids;
        const dists = this._dists;
        const n = this.pointCount;

        if (n === 0) {
            this.hull = new Uint32Array(0);
            this.trianglesLen = 0;
            this.triangles = this._triangles.subarray(0, 0);
            this.halfedges = this._halfedges.subarray(0, 0);
            return;
        }

        if (n < 3) {
            const hull = new Uint32Array(n);
            for (let i = 0; i < n; i++) hull[i] = i;
            this.hull = hull;
            this.trianglesLen = 0;
            this.triangles = this._triangles.subarray(0, 0);
            this.halfedges = this._halfedges.subarray(0, 0);
            return;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (let i = 0, j = 0; i < n; i++, j += 2) {
            const x = coords[j];
            const y = coords[j + 1];

            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;

            ids[i] = i;
        }

        const centerX = (minX + maxX) * 0.5;
        const centerY = (minY + maxY) * 0.5;

        let i0 = 0;
        let minDist = Infinity;
        for (let i = 0, j = 0; i < n; i++, j += 2) {
            const dx = centerX - coords[j];
            const dy = centerY - coords[j + 1];
            const d = dx * dx + dy * dy;
            if (d < minDist) {
                i0 = i;
                minDist = d;
            }
        }

        const i0c = i0 << 1;
        const i0x = coords[i0c];
        const i0y = coords[i0c + 1];

        let i1 = -1;
        minDist = Infinity;
        for (let i = 0, j = 0; i < n; i++, j += 2) {
            if (i === i0) continue;
            const dx = i0x - coords[j];
            const dy = i0y - coords[j + 1];
            const d = dx * dx + dy * dy;
            if (d > 0 && d < minDist) {
                i1 = i;
                minDist = d;
            }
        }

        if (i1 === -1) {
            this.hull = new Uint32Array([i0]);
            this.trianglesLen = 0;
            this.triangles = this._triangles.subarray(0, 0);
            this.halfedges = this._halfedges.subarray(0, 0);
            return;
        }

        let i1c = i1 << 1;
        let i1x = coords[i1c];
        let i1y = coords[i1c + 1];

        let i2 = -1;
        let minRadius = Infinity;
        for (let i = 0, j = 0; i < n; i++, j += 2) {
            if (i === i0 || i === i1) continue;
            const r = circumradius(i0x, i0y, i1x, i1y, coords[j], coords[j + 1]);
            if (r < minRadius) {
                i2 = i;
                minRadius = r;
            }
        }

        if (i2 === -1 || minRadius === Infinity) {
            const baseX = coords[0];
            const baseY = coords[1];
            for (let i = 0, j = 0; i < n; i++, j += 2) {
                dists[i] = (coords[j] - baseX) || (coords[j + 1] - baseY);
            }
            quicksort(ids, dists, 0, n - 1);

            const hull = new Uint32Array(n);
            let j = 0;
            let d0 = -Infinity;
            for (let i = 0; i < n; i++) {
                const id = ids[i];
                const d = dists[id];
                if (d > d0) {
                    hull[j++] = id;
                    d0 = d;
                }
            }
            this.hull = hull.subarray(0, j);
            this.trianglesLen = 0;
            this.triangles = this._triangles.subarray(0, 0);
            this.halfedges = this._halfedges.subarray(0, 0);
            return;
        }

        let i2c = i2 << 1;
        let i2x = coords[i2c];
        let i2y = coords[i2c + 1];

        if (orient2d(i0x, i0y, i1x, i1y, i2x, i2y) < 0) {
            const tempI = i1;
            i1 = i2;
            i2 = tempI;

            const tempX = i1x;
            i1x = i2x;
            i2x = tempX;

            const tempY = i1y;
            i1y = i2y;
            i2y = tempY;

            i1c = i1 << 1;
            i2c = i2 << 1;
        }

        const dx = i1x - i0x;
        const dy = i1y - i0y;
        const ex = i2x - i0x;
        const ey = i2y - i0y;
        const bl = dx * dx + dy * dy;
        const cl = ex * ex + ey * ey;
        const determinant = dx * ey - dy * ex;
        const factor = 0.5 / determinant;
        const cx = i0x + (ey * bl - dy * cl) * factor;
        const cy = i0y + (dx * cl - ex * bl) * factor;

        this._cx = cx;
        this._cy = cy;

        for (let i = 0, j = 0; i < n; i++, j += 2) {
            const ddx = coords[j] - cx;
            const ddy = coords[j + 1] - cy;
            dists[i] = ddx * ddx + ddy * ddy;
        }

        quicksort(ids, dists, 0, n - 1);

        this._hullStart = i0;
        let hullSize = 3;

        hullNext[i0] = i1;
        hullPrev[i2] = i1;
        hullNext[i1] = i2;
        hullPrev[i0] = i2;
        hullNext[i2] = i0;
        hullPrev[i1] = i0;

        hullTri[i0] = 0;
        hullTri[i1] = 1;
        hullTri[i2] = 2;

        hullHash.fill(-1);
        const hashSize = this._hashSize;
        hullHash[hashKey(i0x - cx, i0y - cy, hashSize)] = i0;
        hullHash[hashKey(i1x - cx, i1y - cy, hashSize)] = i1;
        hullHash[hashKey(i2x - cx, i2y - cy, hashSize)] = i2;

        this.trianglesLen = 0;
        this._addTriangle(i0, i1, i2, -1, -1, -1);

        let xp = 0;
        let yp = 0;

        for (let k = 0; k < n; k++) {
            const i = ids[k];
            const ic = i << 1;
            const x = coords[ic];
            const y = coords[ic + 1];

            if (k > 0 && Math.abs(x - xp) <= EPSILON && Math.abs(y - yp) <= EPSILON) continue;
            xp = x;
            yp = y;

            if (i === i0 || i === i1 || i === i2) continue;

            let start = -1;
            let key = hashKey(x - cx, y - cy, hashSize);
            for (let j = 0; j < hashSize; j++) {
                start = hullHash[key];
                if (start !== -1 && start !== hullNext[start]) break;
                key++;
                if (key === hashSize) key = 0;
            }
            if (start === -1) continue;

            start = hullPrev[start];
            let e = start;
            let q = 0;

            while (true) {
                q = hullNext[e];
                const ec = e << 1;
                const qc = q << 1;
                const qx = coords[qc];
                const qy = coords[qc + 1];
                if (((y - qy) * (coords[ec] - qx) - (x - qx) * (coords[ec + 1] - qy)) < 0) break;
                e = q;
                if (e === start) {
                    e = -1;
                    break;
                }
            }
            if (e === -1) continue;

            let t = this._addTriangle(e, i, hullNext[e], -1, -1, hullTri[e]);
            hullTri[i] = this._legalize(t + 2);
            hullTri[e] = t;
            hullSize++;

            let next = hullNext[e];
            while (true) {
                q = hullNext[next];
                const nc = next << 1;
                const qc = q << 1;
                const qx = coords[qc];
                const qy = coords[qc + 1];
                if (((y - qy) * (coords[nc] - qx) - (x - qx) * (coords[nc + 1] - qy)) >= 0) break;
                t = this._addTriangle(next, i, q, hullTri[i], -1, hullTri[next]);
                hullTri[i] = this._legalize(t + 2);
                hullNext[next] = next;
                hullSize--;
                next = q;
            }

            if (e === start) {
                while (true) {
                    q = hullPrev[e];
                    const qc = q << 1;
                    const ec = e << 1;
                    const ex = coords[ec];
                    const ey = coords[ec + 1];
                    if (((y - ey) * (coords[qc] - ex) - (x - ex) * (coords[qc + 1] - ey)) >= 0) break;
                    t = this._addTriangle(q, i, e, -1, hullTri[e], hullTri[q]);
                    this._legalize(t + 2);
                    hullTri[q] = t;
                    hullNext[e] = e;
                    hullSize--;
                    e = q;
                }
            }

            this._hullStart = hullPrev[i] = e;
            hullNext[e] = hullPrev[next] = i;
            hullNext[i] = next;

            hullHash[hashKey(x - cx, y - cy, hashSize)] = i;
            const ec = e << 1;
            hullHash[hashKey(coords[ec] - cx, coords[ec + 1] - cy, hashSize)] = e;
        }

        const hull = new Uint32Array(hullSize);
        for (let i = 0, e = this._hullStart; i < hullSize; i++) {
            hull[i] = e;
            e = hullNext[e];
        }

        this.hull = hull;
        this.triangles = this._triangles.subarray(0, this.trianglesLen);
        this.halfedges = this._halfedges.subarray(0, this.trianglesLen);
    }

    private _allocate(capacity: number): void {
        const hashSize = Math.max(1, Math.ceil(Math.sqrt(capacity)));
        this._hashSize = hashSize;
        this._hullPrev = new Uint32Array(capacity);
        this._hullNext = new Uint32Array(capacity);
        this._hullTri = new Uint32Array(capacity);
        this._hullHash = new Int32Array(hashSize);

        this._ids = new Uint32Array(capacity);
        this._dists = new Float64Array(capacity);

        const maxTriangles = Math.max(2 * capacity - 5, 0);
        this._triangles = new Uint32Array(maxTriangles * 3);
        this._halfedges = new Int32Array(maxTriangles * 3);
        this.trianglesLen = 0;
    }

    private _legalize(a: number): number {
        const triangles = this._triangles;
        const halfedges = this._halfedges;
        const coords = this.coords;
        const hullStart = this._hullStart;
        const hullTri = this._hullTri;
        const hullPrev = this._hullPrev;

        let stackLen = 0;
        let ar = 0;

        while (true) {
            const b = halfedges[a];

            if (b === -1) {
                if (stackLen === 0) break;
                a = EDGE_STACK[--stackLen];
                continue;
            }

            const a0 = a - (a % 3);
            const aLocal = a - a0;
            ar = aLocal === 0 ? a0 + 2 : a - 1;
            const al = aLocal === 2 ? a0 : a + 1;

            const b0 = b - (b % 3);
            const bLocal = b - b0;
            const bl = bLocal === 0 ? b0 + 2 : b - 1;
            const br = bLocal === 2 ? b0 : b + 1;

            const p0 = triangles[ar];
            const pr = triangles[a];
            const pl = triangles[al];
            const p1 = triangles[bl];

            const p0c = p0 << 1;
            const prc = pr << 1;
            const plc = pl << 1;
            const p1c = p1 << 1;

            const ax = coords[p0c];
            const ay = coords[p0c + 1];
            const bx = coords[prc];
            const by = coords[prc + 1];
            const cx = coords[plc];
            const cy = coords[plc + 1];
            const px = coords[p1c];
            const py = coords[p1c + 1];

            const dx = ax - px;
            const dy = ay - py;
            const ex = bx - px;
            const ey = by - py;
            const fx = cx - px;
            const fy = cy - py;

            const ap = dx * dx + dy * dy;
            const bp = ex * ex + ey * ey;
            const cp = fx * fx + fy * fy;

            const illegal = dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) < 0;

            if (illegal) {
                triangles[a] = p1;
                triangles[b] = p0;

                const hbl = halfedges[bl];
                if (hbl === -1) {
                    let e = hullStart;
                    do {
                        if (hullTri[e] === bl) {
                            hullTri[e] = a;
                            break;
                        }
                        e = hullPrev[e];
                    } while (e !== hullStart);
                }

                halfedges[a] = hbl;
                if (hbl !== -1) halfedges[hbl] = a;

                const har = halfedges[ar];
                halfedges[b] = har;
                if (har !== -1) halfedges[har] = b;

                halfedges[ar] = bl;
                halfedges[bl] = ar;

                if (stackLen < EDGE_STACK.length) EDGE_STACK[stackLen++] = br;
            } else {
                if (stackLen === 0) break;
                a = EDGE_STACK[--stackLen];
            }
        }

        return ar;
    }

    private _addTriangle(i0: number, i1: number, i2: number, a: number, b: number, c: number): number {
        const t = this.trianglesLen;
        const triangles = this._triangles;
        const halfedges = this._halfedges;

        triangles[t] = i0;
        triangles[t + 1] = i1;
        triangles[t + 2] = i2;

        halfedges[t] = a;
        if (a !== -1) halfedges[a] = t;

        halfedges[t + 1] = b;
        if (b !== -1) halfedges[b] = t + 1;

        halfedges[t + 2] = c;
        if (c !== -1) halfedges[c] = t + 2;

        this.trianglesLen = t + 3;
        return t;
    }
}
