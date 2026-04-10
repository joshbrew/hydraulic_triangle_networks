import type { HeightfieldTINTopology } from './HeightfieldTINBuilder.ts';

export interface FloodplainOptions {
  maxRise?: number;
  maxClimbStep?: number;
  maxEdgeSlope?: number;
  maxWorldDistance?: number;
  minTriangleFloodplainVerts?: number;
}

export interface FloodplainResult {
  vertexMask: Uint8Array;
  triangleMask: Uint8Array;
  seedVertices: Uint32Array;
}

const EPSILON = 1e-6;
const LARGE_VALUE = 1e30;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function distance2D(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.hypot(dx, dy);
}

export default class FloodplainClassifier {
  readonly options: Required<FloodplainOptions>;

  private bestDistance = new Float32Array(0);
  private channelRefHeight = new Float32Array(0);
  private channelCeiling = new Float32Array(0);
  private vertexMaskScratch = new Uint8Array(0);
  private triangleMaskScratch = new Uint8Array(0);
  private queue = new Int32Array(0);

  constructor(options: FloodplainOptions = {}) {
    this.options = {
      maxRise: Math.max(options.maxRise ?? 0.06, 0),
      maxClimbStep: Math.max(options.maxClimbStep ?? 0.02, 0),
      maxEdgeSlope: Math.max(options.maxEdgeSlope ?? 0.75, 0),
      maxWorldDistance: Math.max(options.maxWorldDistance ?? Number.POSITIVE_INFINITY, 0),
      minTriangleFloodplainVerts: clamp(Math.floor(options.minTriangleFloodplainVerts ?? 2), 1, 3),
    };
  }

  classify(topology: HeightfieldTINTopology, seedVerticesInput: ArrayLike<number>): FloodplainResult {
    const vertexCount = topology.heights.length;
    const triangleCount = topology.indices.length / 3;
    this.ensureScratch(vertexCount, triangleCount);

    const positions = topology.positions2D;
    const heights = topology.heights;
    const offsets = topology.vertexNeighborOffsets;
    const neighbors = topology.vertexNeighbors;
    const seedVertices = seedVerticesInput instanceof Uint32Array
      ? seedVerticesInput
      : Uint32Array.from(Array.from(seedVerticesInput as ArrayLike<number>));

    const vertexMask = this.vertexMaskScratch;
    const triangleMask = this.triangleMaskScratch;
    vertexMask.fill(0, 0, vertexCount);
    triangleMask.fill(0, 0, triangleCount);

    if (seedVertices.length === 0) {
      return {
        vertexMask: vertexMask.slice(0, vertexCount),
        triangleMask: triangleMask.slice(0, triangleCount),
        seedVertices,
      };
    }

    const bestDistance = this.bestDistance;
    const channelRefHeight = this.channelRefHeight;
    const channelCeiling = this.channelCeiling;

    for (let i = 0; i < vertexCount; i++) {
      bestDistance[i] = LARGE_VALUE;
      channelRefHeight[i] = LARGE_VALUE;
      channelCeiling[i] = LARGE_VALUE;
    }

    let head = 0;
    let tail = 0;

    for (let i = 0; i < seedVertices.length; i++) {
      const v = seedVertices[i];
      const refHeight = heights[v];
      vertexMask[v] = 1;
      bestDistance[v] = 0;
      channelRefHeight[v] = refHeight;
      channelCeiling[v] = refHeight + this.options.maxRise;
      this.queue[tail++] = v;
    }

    while (head < tail) {
      const vertex = this.queue[head++];
      const vx = positions[vertex * 2];
      const vy = positions[vertex * 2 + 1];
      const vh = heights[vertex];
      const activeDistance = bestDistance[vertex];
      const activeRefHeight = channelRefHeight[vertex];
      const activeCeiling = channelCeiling[vertex];

      for (let p = offsets[vertex]; p < offsets[vertex + 1]; p++) {
        const nbr = neighbors[p];
        const nx = positions[nbr * 2];
        const ny = positions[nbr * 2 + 1];
        const nh = heights[nbr];
        const edgeLen = Math.max(distance2D(vx, vy, nx, ny), EPSILON);
        const nextDistance = activeDistance + edgeLen;
        const localSlope = Math.abs(nh - vh) / edgeLen;
        const climb = nh - vh;

        if (nextDistance > this.options.maxWorldDistance + EPSILON) continue;
        if (nh > activeCeiling + EPSILON) continue;
        if (nh > activeRefHeight + this.options.maxRise + EPSILON) continue;
        if (climb > this.options.maxClimbStep + EPSILON) continue;
        if (localSlope > this.options.maxEdgeSlope + EPSILON) continue;

        const improvesDistance = nextDistance < bestDistance[nbr] - EPSILON;
        const improvesRef = activeRefHeight < channelRefHeight[nbr] - EPSILON;

        if (!vertexMask[nbr] || improvesDistance || improvesRef) {
          vertexMask[nbr] = 1;
          bestDistance[nbr] = Math.min(bestDistance[nbr], nextDistance);
          channelRefHeight[nbr] = Math.min(channelRefHeight[nbr], activeRefHeight);
          channelCeiling[nbr] = Math.min(channelCeiling[nbr], activeCeiling);
          this.queue[tail++] = nbr;
        }
      }
    }

    for (let triIndex = 0, t = 0; triIndex < triangleCount; triIndex++, t += 3) {
      const a = topology.indices[t];
      const b = topology.indices[t + 1];
      const c = topology.indices[t + 2];
      const count = vertexMask[a] + vertexMask[b] + vertexMask[c];
      if (count >= this.options.minTriangleFloodplainVerts) {
        triangleMask[triIndex] = 1;
      }
    }

    return {
      vertexMask: vertexMask.slice(0, vertexCount),
      triangleMask: triangleMask.slice(0, triangleCount),
      seedVertices,
    };
  }

  private ensureScratch(vertexCount: number, triangleCount: number): void {
    if (this.bestDistance.length < vertexCount) {
      this.bestDistance = new Float32Array(vertexCount);
      this.channelRefHeight = new Float32Array(vertexCount);
      this.channelCeiling = new Float32Array(vertexCount);
      this.vertexMaskScratch = new Uint8Array(vertexCount);
      this.queue = new Int32Array(vertexCount);
    }

    if (this.triangleMaskScratch.length < triangleCount) {
      this.triangleMaskScratch = new Uint8Array(triangleCount);
    }
  }
}
