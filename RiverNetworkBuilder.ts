import type { HeightfieldTINTopology } from './HeightfieldTINBuilder.ts';

export interface RiverNetworkEdge {
  source: number;
  target: number;
  weight: number;
  length: number;
}

export interface RiverGuideOptions {
  minWeight: number;
  step: number;
  maxPoints?: number;
}

export interface RiverNetworkOptions {
  maxNeighborDistance?: number;
  boundaryEpsilon?: number;
  minDrop?: number;
  flatTolerance?: number;
  // Allows tiny uphill steps to breach mesh-induced pits so flow reaches an outlet.
  sinkMaxRise?: number;
  sinkClimbPenalty?: number;
}

export interface RiverNetworkResult {
  edges: RiverNetworkEdge[];
  downstream: Int32Array;
  edgeIndexBySource: Int32Array;
  vertexFlowWeight: Float32Array;
  upstreamCount: Uint32Array;
  boundaryMask: Uint8Array;
  maxWeight: number;
  minWeight: number;
}

const EPSILON = 1e-6;
const INF = 1e30;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function distance2D(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.hypot(dx, dy);
}

function sampleGridField(
  field: Float32Array | Int32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const gx = clamp(Math.round(x), 0, width - 1);
  const gy = clamp(Math.round(y), 0, height - 1);
  return field[gy * width + gx];
}

class MinHeap {
  ids: Int32Array;
  keys: Float64Array;
  size: number;

  constructor(capacity: number) {
    this.ids = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.size = 0;
  }

  push(id: number, key: number): void {
    let i = this.size++;
    this.ids[i] = id;
    this.keys[i] = key;

    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p];
      this.keys[i] = this.keys[p];
      i = p;
    }

    this.ids[i] = id;
    this.keys[i] = key;
  }

  pop(): { id: number; key: number } | null {
    if (this.size === 0) return null;

    const rootId = this.ids[0];
    const rootKey = this.keys[0];
    this.size--;

    if (this.size > 0) {
      const lastId = this.ids[this.size];
      const lastKey = this.keys[this.size];
      let i = 0;

      while (true) {
        let c = i * 2 + 1;
        if (c >= this.size) break;
        if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
        if (this.keys[c] >= lastKey) break;
        this.ids[i] = this.ids[c];
        this.keys[i] = this.keys[c];
        i = c;
      }

      this.ids[i] = lastId;
      this.keys[i] = lastKey;
    }

    return { id: rootId, key: rootKey };
  }
}

export default class RiverNetworkBuilder {
  readonly options: Required<RiverNetworkOptions>;

  constructor(options: RiverNetworkOptions = {}) {
    this.options = {
      maxNeighborDistance: Math.max(options.maxNeighborDistance ?? Number.POSITIVE_INFINITY, 0),
      boundaryEpsilon: Math.max(options.boundaryEpsilon ?? 0.5, 0),
      minDrop: Math.max(options.minDrop ?? 1e-5, 0),
      flatTolerance: Math.max(options.flatTolerance ?? 1e-4, 0),
      sinkMaxRise: Math.max(options.sinkMaxRise ?? 0.02, 0),
      sinkClimbPenalty: Math.max(options.sinkClimbPenalty ?? 2.5, 0),
    };
  }

  buildFromTopology(topology: HeightfieldTINTopology): RiverNetworkResult {
    const vertexCount = topology.heights.length;
    if (vertexCount === 0) {
      return {
        edges: [],
        downstream: new Int32Array(0),
        edgeIndexBySource: new Int32Array(0),
        vertexFlowWeight: new Float32Array(0),
        upstreamCount: new Uint32Array(0),
        boundaryMask: new Uint8Array(0),
        maxWeight: 0,
        minWeight: 0,
      };
    }

    const neighbors = this.buildNeighbors(topology);
    const boundaryMask = this.computeBoundaryMask(topology.positionsGrid, topology.vertexBoundaryMask);
    const downstream = this.chooseDownstream(topology, neighbors, boundaryMask);
    const { edges, edgeIndexBySource, vertexFlowWeight, upstreamCount, minWeight, maxWeight } =
      this.accumulateFlow(topology, downstream);

    return {
      edges,
      downstream,
      edgeIndexBySource,
      vertexFlowWeight,
      upstreamCount,
      boundaryMask,
      minWeight,
      maxWeight,
    };
  }

  buildSegments(
    topology: HeightfieldTINTopology,
    result: RiverNetworkResult,
    minWeight: number,
  ): Float32Array {
    const mask = this.collectActiveEdgeMask(result, minWeight);
    return this.buildSegmentsFromMask(topology, result, mask);
  }

  buildSegmentsFromMask(
    topology: HeightfieldTINTopology,
    result: RiverNetworkResult,
    mask: Uint8Array,
  ): Float32Array {
    let activeCount = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) activeCount++;
    }

    const positions = topology.positionsGrid;
    const segments = new Float32Array(activeCount * 4);
    let write = 0;

    for (let i = 0; i < result.edges.length; i++) {
      if (!mask[i]) continue;
      const edge = result.edges[i];
      const a2 = edge.source * 2;
      const b2 = edge.target * 2;
      segments[write++] = positions[a2];
      segments[write++] = positions[a2 + 1];
      segments[write++] = positions[b2];
      segments[write++] = positions[b2 + 1];
    }

    return segments;
  }

  buildActiveArtifacts(
    topology: HeightfieldTINTopology,
    result: RiverNetworkResult,
    minWeight: number,
  ): {
    mask: Uint8Array;
    activeEdges: RiverNetworkEdge[];
    activeVertices: Uint32Array;
    segments: Float32Array;
  } {
    const mask = this.collectActiveEdgeMask(result, minWeight);
    const vertexActiveMask = new Uint8Array(result.vertexFlowWeight.length);
    let activeVertexCount = 0;
    let activeEdgeCount = 0;

    for (let i = 0; i < result.edges.length; i++) {
      if (!mask[i]) continue;
      activeEdgeCount++;
      const edge = result.edges[i];

      if (!vertexActiveMask[edge.source]) {
        vertexActiveMask[edge.source] = 1;
        activeVertexCount++;
      }

      if (!vertexActiveMask[edge.target]) {
        vertexActiveMask[edge.target] = 1;
        activeVertexCount++;
      }
    }

    const activeEdges: RiverNetworkEdge[] = new Array(activeEdgeCount);
    const segments = new Float32Array(activeEdgeCount * 4);
    const positions = topology.positionsGrid;

    let edgeWrite = 0;
    let segmentWrite = 0;

    for (let i = 0; i < result.edges.length; i++) {
      if (!mask[i]) continue;

      const edge = result.edges[i];
      activeEdges[edgeWrite++] = edge;

      const a2 = edge.source * 2;
      const b2 = edge.target * 2;
      segments[segmentWrite++] = positions[a2];
      segments[segmentWrite++] = positions[a2 + 1];
      segments[segmentWrite++] = positions[b2];
      segments[segmentWrite++] = positions[b2 + 1];
    }

    const activeVertices = new Uint32Array(activeVertexCount);
    let vertexWrite = 0;

    for (let i = 0; i < vertexActiveMask.length; i++) {
      if (vertexActiveMask[i]) {
        activeVertices[vertexWrite++] = i;
      }
    }

    return {
      mask,
      activeEdges,
      activeVertices,
      segments,
    };
  }

  collectActiveEdges(result: RiverNetworkResult, minWeight: number): RiverNetworkEdge[] {
    const mask = this.collectActiveEdgeMask(result, minWeight);
    const out: RiverNetworkEdge[] = [];
    for (let i = 0; i < result.edges.length; i++) {
      if (mask[i]) out.push(result.edges[i]);
    }
    return out;
  }

  collectActiveVertices(result: RiverNetworkResult, minWeight: number): Uint32Array {
    const mask = this.collectActiveEdgeMask(result, minWeight);
    return this.collectActiveVerticesFromMask(result, mask);
  }

  collectActiveVerticesFromMask(result: RiverNetworkResult, mask: Uint8Array): Uint32Array {
    const activeMask = new Uint8Array(result.vertexFlowWeight.length);
    let count = 0;

    for (let i = 0; i < result.edges.length; i++) {
      if (!mask[i]) continue;
      const edge = result.edges[i];
      if (!activeMask[edge.source]) {
        activeMask[edge.source] = 1;
        count++;
      }
      if (!activeMask[edge.target]) {
        activeMask[edge.target] = 1;
        count++;
      }
    }

    const out = new Uint32Array(count);
    let write = 0;
    for (let i = 0; i < activeMask.length; i++) {
      if (activeMask[i]) out[write++] = i;
    }
    return out;
  }

  buildGuidePoints(
    topology: HeightfieldTINTopology,
    result: RiverNetworkResult,
    options: RiverGuideOptions,
  ): Float32Array {
    const minWeight = Math.max(options.minWeight, 0);
    const step = Math.max(options.step, 0.5);
    const maxPoints = Math.max(0, Math.floor(options.maxPoints ?? 60000));
    const activeEdges = this.collectActiveEdges(result, minWeight);
    const positions = topology.positionsGrid;
    const points: number[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < positions.length; i += 2) {
      const x = positions[i];
      const y = positions[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    const qScale = 4;
    const quantWidth = Math.max(1, Math.floor((maxX - minX) * qScale) + 3);
    const seen = new Set<number>();

    const pushPoint = (x: number, y: number) => {
      const qx = Math.round((x - minX) * qScale);
      const qy = Math.round((y - minY) * qScale);
      const key = qy * quantWidth + qx;
      if (seen.has(key)) return;
      seen.add(key);
      points.push(x, y);
    };

    for (let i = 0; i < activeEdges.length; i++) {
      if ((points.length >> 1) >= maxPoints) break;
      const edge = activeEdges[i];
      const a2 = edge.source * 2;
      const b2 = edge.target * 2;
      const ax = positions[a2];
      const ay = positions[a2 + 1];
      const bx = positions[b2];
      const by = positions[b2 + 1];
      const len = Math.max(distance2D(ax, ay, bx, by), EPSILON);
      const steps = Math.max(1, Math.ceil(len / step));

      for (let s = 0; s <= steps; s++) {
        if ((points.length >> 1) >= maxPoints) break;
        const t = s / steps;
        pushPoint(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }

    return Float32Array.from(points);
  }

  private buildNeighbors(topology: HeightfieldTINTopology): Uint32Array[] {
    const vertexCount = topology.heights.length;
    const neighbors = Array.from({ length: vertexCount }, () => [] as number[]);
    const positions = topology.positions2D;
    const offsets = topology.vertexNeighborOffsets;
    const verts = topology.vertexNeighbors;
    const maxDistance = this.options.maxNeighborDistance;

    for (let i = 0; i < vertexCount; i++) {
      for (let p = offsets[i]; p < offsets[i + 1]; p++) {
        const j = verts[p];
        if (j === i) continue;

        const a2 = i * 2;
        const b2 = j * 2;
        const d = distance2D(
          positions[a2],
          positions[a2 + 1],
          positions[b2],
          positions[b2 + 1],
        );

        if (d <= maxDistance + EPSILON) {
          neighbors[i].push(j);
        }
      }
    }

    return neighbors.map((list) => Uint32Array.from(list));
  }

  private computeBoundaryMask(positionsGrid: Float32Array, provided: Uint8Array): Uint8Array {
    if (provided && provided.length === (positionsGrid.length >> 1)) {
      return new Uint8Array(provided);
    }

    const vertexCount = positionsGrid.length >> 1;
    const boundaryMask = new Uint8Array(vertexCount);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < positionsGrid.length; i += 2) {
      const x = positionsGrid[i];
      const y = positionsGrid[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    const eps = this.options.boundaryEpsilon;
    for (let i = 0; i < vertexCount; i++) {
      const x = positionsGrid[i * 2];
      const y = positionsGrid[i * 2 + 1];
      if (x <= minX + eps || x >= maxX - eps || y <= minY + eps || y >= maxY - eps) {
        boundaryMask[i] = 1;
      }
    }

    return boundaryMask;
  }

  private chooseDownstream(
    topology: HeightfieldTINTopology,
    neighbors: Uint32Array[],
    boundaryMask: Uint8Array,
  ): Int32Array {
    const vertexCount = topology.heights.length;
    const downstream = new Int32Array(vertexCount);
    downstream.fill(-1);

    const heights = topology.heights;
    const positions2D = topology.positions2D;
    const positionsGrid = topology.positionsGrid;
    const wetness = topology.vertexWetness;
    const analysis = topology.analysis;
    const width = analysis.width;
    const height = analysis.height;
    const flowAccumulation = analysis.flowAccumulation;
    const flowReceiver = analysis.flowReceiver;

    // Pass 1: local downhill/flat routing.
    for (let i = 0; i < vertexCount; i++) {
      const a2 = i * 2;
      const gx = positionsGrid[a2];
      const gy = positionsGrid[a2 + 1];
      const h = heights[i];
      const localAccum = sampleGridField(flowAccumulation, width, height, gx, gy);
      const receiverCell = sampleGridField(flowReceiver, width, height, gx, gy);
      const rx = receiverCell >= 0 ? receiverCell % width : -1;
      const ry = receiverCell >= 0 ? Math.floor(receiverCell / width) : -1;
      const rvx = rx >= 0 ? rx - gx : 0;
      const rvy = ry >= 0 ? ry - gy : 0;
      const rvLen = Math.hypot(rvx, rvy);

      let best = -1;
      let bestScore = -INF;

      for (let k = 0; k < neighbors[i].length; k++) {
        const j = neighbors[i][k];
        const j2 = j * 2;
        const nh = heights[j];
        const drop = h - nh;
        const downhill = drop > this.options.minDrop;
        const flat = nh <= h + this.options.flatTolerance && j > i;
        if (!downhill && !flat) continue;

        const dx = positions2D[j2] - positions2D[a2];
        const dy = positions2D[j2 + 1] - positions2D[a2 + 1];
        const dist = Math.max(Math.hypot(dx, dy), EPSILON);
        const jgx = positionsGrid[j2];
        const jgy = positionsGrid[j2 + 1];
        const nbrAccum = sampleGridField(flowAccumulation, width, height, jgx, jgy);

        let alignment = 0;
        if (rvLen > EPSILON) {
          alignment = (dx * rvx + dy * rvy) / (dist * rvLen);
        }

        const slopeTerm = downhill ? (drop / dist) * 6 : 0.05 / dist;
        const accumTerm = Math.log1p(Math.max(0, nbrAccum - localAccum)) * 0.12;
        const wetnessTerm = wetness[j] * 0.035;
        const alignTerm = Math.max(0, alignment) * 0.7;
        const boundaryTerm = boundaryMask[j] ? 0.08 : 0;
        const lowerTerm = downhill ? 0.08 : 0;
        const score = slopeTerm + accumTerm + wetnessTerm + alignTerm + boundaryTerm + lowerTerm;

        if (score > bestScore) {
          bestScore = score;
          best = j;
        }
      }

      downstream[i] = best;
    }

    // Pass 2: repair unresolved sinks with a least-cost escape path to a boundary outlet.
    const escape = this.computeEscapeDownstream(topology, neighbors, boundaryMask);
    for (let i = 0; i < vertexCount; i++) {
      if (downstream[i] < 0 && !boundaryMask[i]) {
        downstream[i] = escape[i];
      }
    }

    return downstream;
  }

  private computeEscapeDownstream(
    topology: HeightfieldTINTopology,
    neighbors: Uint32Array[],
    boundaryMask: Uint8Array,
  ): Int32Array {
    const vertexCount = topology.heights.length;
    const bestNext = new Int32Array(vertexCount);
    bestNext.fill(-1);

    const bestCost = new Float64Array(vertexCount);
    bestCost.fill(INF);

    const heights = topology.heights;
    const positions2D = topology.positions2D;
    const positionsGrid = topology.positionsGrid;
    const analysis = topology.analysis;
    const width = analysis.width;
    const height = analysis.height;
    const flowAccumulation = analysis.flowAccumulation;
    const flowReceiver = analysis.flowReceiver;
    const maxRise = Math.max(this.options.sinkMaxRise, this.options.flatTolerance * 64);
    const climbPenalty = this.options.sinkClimbPenalty;

    const heap = new MinHeap(vertexCount * 4 + 16);

    for (let i = 0; i < vertexCount; i++) {
      if (boundaryMask[i]) {
        bestCost[i] = 0;
        heap.push(i, 0);
      }
    }

    while (heap.size > 0) {
      const item = heap.pop();
      if (!item) break;
      const u = item.id;
      const costU = item.key;
      if (costU > bestCost[u] + EPSILON) continue;

      for (let p = 0; p < neighbors[u].length; p++) {
        const v = neighbors[u][p];
        const stepCost = this.transitionCost(v, u, topology, flowAccumulation, flowReceiver, width, height, maxRise, climbPenalty);
        if (!isFinite(stepCost)) continue;

        const candidate = costU + stepCost;
        if (candidate + EPSILON < bestCost[v]) {
          bestCost[v] = candidate;
          bestNext[v] = u;
          heap.push(v, candidate);
        }
      }
    }

    return bestNext;
  }

  private transitionCost(
    from: number,
    to: number,
    topology: HeightfieldTINTopology,
    flowAccumulation: Float32Array,
    flowReceiver: Int32Array,
    width: number,
    height: number,
    maxRise: number,
    climbPenalty: number,
  ): number {
    const heights = topology.heights;
    const positions2D = topology.positions2D;
    const positionsGrid = topology.positionsGrid;

    const a2 = from * 2;
    const b2 = to * 2;
    const ax = positions2D[a2];
    const ay = positions2D[a2 + 1];
    const bx = positions2D[b2];
    const by = positions2D[b2 + 1];
    const dist = Math.max(distance2D(ax, ay, bx, by), EPSILON);

    const h0 = heights[from];
    const h1 = heights[to];
    const climb = Math.max(0, h1 - h0);
    if (climb > maxRise + EPSILON) return INF;

    const gx = positionsGrid[a2];
    const gy = positionsGrid[a2 + 1];
    const localAccum = sampleGridField(flowAccumulation, width, height, gx, gy);
    const receiverCell = sampleGridField(flowReceiver, width, height, gx, gy);
    const rx = receiverCell >= 0 ? receiverCell % width : -1;
    const ry = receiverCell >= 0 ? Math.floor(receiverCell / width) : -1;
    const rvx = rx >= 0 ? rx - gx : 0;
    const rvy = ry >= 0 ? ry - gy : 0;
    const rvLen = Math.hypot(rvx, rvy);

    let alignment = 0;
    if (rvLen > EPSILON) {
      const dx = positionsGrid[b2] - gx;
      const dy = positionsGrid[b2 + 1] - gy;
      alignment = (dx * rvx + dy * rvy) / (Math.max(Math.hypot(dx, dy), EPSILON) * rvLen);
    }

    const jgx = positionsGrid[b2];
    const jgy = positionsGrid[b2 + 1];
    const nbrAccum = sampleGridField(flowAccumulation, width, height, jgx, jgy);
    const accumPenalty = nbrAccum + EPSILON >= localAccum ? 0 : 0.35 * (1 - nbrAccum / Math.max(localAccum, 1));
    const alignPenalty = rvLen > EPSILON ? 0.5 * (1 - Math.max(-0.25, alignment)) : 0.2;
    const risePenalty = climbPenalty * (climb / Math.max(dist, EPSILON));

    return dist * (1 + alignPenalty + accumPenalty) + risePenalty;
  }

  private accumulateFlow(
    topology: HeightfieldTINTopology,
    downstream: Int32Array,
  ): {
    edges: RiverNetworkEdge[];
    edgeIndexBySource: Int32Array;
    vertexFlowWeight: Float32Array;
    upstreamCount: Uint32Array;
    minWeight: number;
    maxWeight: number;
  } {
    const vertexCount = topology.heights.length;
    const vertexFlowWeight = new Float32Array(vertexCount);
    vertexFlowWeight.fill(1);

    const upstreamCount = new Uint32Array(vertexCount);
    const edgeIndexBySource = new Int32Array(vertexCount);
    edgeIndexBySource.fill(-1);

    const order = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) order[i] = i;
    const heights = topology.heights;
    const wetness = topology.vertexWetness;

    order.sort((a, b) => {
      const dz = heights[b] - heights[a];
      if (Math.abs(dz) > EPSILON) return dz;
      const dw = wetness[b] - wetness[a];
      if (Math.abs(dw) > EPSILON) return dw;
      return b - a;
    });

    for (let i = 0; i < order.length; i++) {
      const v = order[i];
      const d = downstream[v];
      if (d >= 0 && d !== v) {
        vertexFlowWeight[d] += vertexFlowWeight[v];
        upstreamCount[d]++;
      }
    }

    const edges: RiverNetworkEdge[] = [];
    const positions = topology.positions2D;
    let minWeight = Infinity;
    let maxWeight = 0;

    for (let v = 0; v < vertexCount; v++) {
      const d = downstream[v];
      if (d < 0 || d === v) continue;

      const a2 = v * 2;
      const b2 = d * 2;
      const dx = positions[b2] - positions[a2];
      const dy = positions[b2 + 1] - positions[a2 + 1];
      const length = Math.max(Math.hypot(dx, dy), EPSILON);
      const weight = vertexFlowWeight[v];

      const edge: RiverNetworkEdge = {
        source: v,
        target: d,
        weight,
        length,
      };

      edgeIndexBySource[v] = edges.length;
      edges.push(edge);
      if (weight < minWeight) minWeight = weight;
      if (weight > maxWeight) maxWeight = weight;
    }

    if (!isFinite(minWeight)) minWeight = 0;

    return {
      edges,
      edgeIndexBySource,
      vertexFlowWeight,
      upstreamCount,
      minWeight,
      maxWeight,
    };
  }

  collectActiveEdgeMask(result: RiverNetworkResult, minWeight: number): Uint8Array {
    const threshold = Math.max(minWeight, 0);
    const mask = new Uint8Array(result.edges.length);
    const vertexCount = result.vertexFlowWeight.length;

    for (let v = 0; v < vertexCount; v++) {
      if (result.vertexFlowWeight[v] + EPSILON < threshold) continue;

      let current = v;
      let steps = 0;
      while (current >= 0 && steps < vertexCount) {
        const edgeIndex = result.edgeIndexBySource[current];
        if (edgeIndex < 0) break;
        if (mask[edgeIndex]) break;
        mask[edgeIndex] = 1;
        current = result.downstream[current];
        steps++;
      }
    }

    return mask;
  }
}
