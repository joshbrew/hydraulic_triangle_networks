import Delaunator from './Delaunator_optim.ts';

export type HeightfieldTINMode = 'traditional' | 'hydrographic' | 'hydrological' | 'hybrid';

export type HeightfieldImageSource =
  | ImageBitmap
  | ImageData
  | HTMLCanvasElement
  | HTMLImageElement;

export interface HeightfieldRaster {
  width: number;
  height: number;
  values: Float32Array;
  mask?: Uint8Array | null;
}

export interface HeightfieldImageOptions {
  valueFromRGBA?: (r: number, g: number, b: number, a: number, index: number) => number;
  alphaMeansInvalid?: boolean;
  flipY?: boolean;
}

export interface HeightfieldTINOptions {
  mode?: HeightfieldTINMode;
  cellSize?: number;
  worldMinX?: number;
  worldMinY?: number;
  minSpacing?: number;
  maxSpacing?: number;
  borderSpacing?: number;
  wetnessBins?: number;
  channelThreshold?: number;
  floodplainChannelDistanceCells?: number;
  candidateStride?: number;
  maxPoints?: number;
  preserveBorder?: boolean;
  preserveChannels?: boolean;
  preserveMaskBoundary?: boolean;
  preserveInnerBorder?: boolean;
  slopeWeight?: number;
  curvatureWeight?: number;
  reliefWeight?: number;
  wetnessWeight?: number;
  channelWeight?: number;
  floodplainWeight?: number;
  relaxIterations?: number;
  forcedWorldPoints?: ArrayLike<number> | null;
}

export interface HeightfieldTINAnalysis {
  width: number;
  height: number;
  cellSize: number;
  heights: Float32Array;
  mask: Uint8Array;
  slopeTan: Float32Array;
  slopeDegrees: Float32Array;
  curvature: Float32Array;
  localRelief: Float32Array;
  flowReceiver: Int32Array;
  flowAccumulation: Float32Array;
  wetness: Float32Array;
  channels: Uint8Array;
  channelDistance: Float32Array;
  floodplain: Uint8Array;
  terrainPriority: Float32Array;
  hydroPriority: Float32Array;
  importance: Float32Array;
  spacing: Float32Array;
  validCellCount: number;
  totalArea: number;
  totalChannelLength: number;
  hillslopeLength: number;
}

export interface HeightfieldTINTopology {
  positions2D: Float32Array;
  positionsGrid: Float32Array;
  uvs: Float32Array;
  heights: Float32Array;
  indices: Uint32Array;
  halfedges: Int32Array;
  triangleCenters: Float32Array;
  triangleAreas: Float32Array;
  vertexNeighborOffsets: Uint32Array;
  vertexNeighbors: Uint32Array;
  vertexBoundaryMask: Uint8Array;
  vertexImportance: Float32Array;
  vertexWetness: Float32Array;
  analysis: HeightfieldTINAnalysis;
}

interface AcceptedPoint {
  x: number;
  y: number;
  gx: number;
  gy: number;
  radius: number;
  fixed: boolean;
}

const EPSILON = 1e-6;
const DEFAULT_BUCKET_COUNT = 256;
const LARGE_DISTANCE = 1e9;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, EPSILON), 0, 1);
  return t * t * (3 - 2 * t);
}

function quantizeRadius(radius: number, minRadius: number, maxRadius: number, bins = 16): number {
  if (bins <= 1 || maxRadius <= minRadius + EPSILON) return radius;
  const t = clamp((radius - minRadius) / Math.max(maxRadius - minRadius, EPSILON), 0, 1);
  const q = Math.round(t * (bins - 1)) / (bins - 1);
  return lerp(minRadius, maxRadius, q);
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function indexOfCell(x: number, y: number, width: number): number {
  return y * width + x;
}

function hashKey(x: number, y: number): string {
  return `${x},${y}`;
}

function makeFullMask(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  mask.fill(1);
  return mask;
}

function isBoundaryCell(mask: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  const i = indexOfCell(x, y, width);
  if (mask[i] === 0) return false;
  if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return true;

  const up = indexOfCell(x, y - 1, width);
  const down = indexOfCell(x, y + 1, width);
  const left = indexOfCell(x - 1, y, width);
  const right = indexOfCell(x + 1, y, width);

  return mask[up] === 0 || mask[down] === 0 || mask[left] === 0 || mask[right] === 0;
}

function scanMinMax(values: Float32Array, mask?: Uint8Array): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < values.length; i++) {
    if (mask && mask[i] === 0) continue;
    const v = values[i];
    if (!isFiniteNumber(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (!isFiniteNumber(min) || !isFiniteNumber(max)) {
    return { min: 0, max: 1 };
  }

  if (Math.abs(max - min) <= EPSILON) {
    return { min, max: min + 1 };
  }

  return { min, max };
}

function normalizeArray(values: Float32Array, mask?: Uint8Array): Float32Array {
  const out = new Float32Array(values.length);
  const { min, max } = scanMinMax(values, mask);
  const inv = 1 / Math.max(max - min, EPSILON);

  for (let i = 0; i < values.length; i++) {
    if (mask && mask[i] === 0) continue;
    out[i] = clamp((values[i] - min) * inv, 0, 1);
  }

  return out;
}

function normalizeAbsArray(values: Float32Array, mask?: Uint8Array): Float32Array {
  const absValues = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    absValues[i] = Math.abs(values[i]);
  }
  return normalizeArray(absValues, mask);
}

function bilinearSample(
  values: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const x0 = clamp(Math.floor(x), 0, width - 1);
  const y0 = clamp(Math.floor(y), 0, height - 1);
  const x1 = clamp(x0 + 1, 0, width - 1);
  const y1 = clamp(y0 + 1, 0, height - 1);

  const tx = clamp(x - x0, 0, 1);
  const ty = clamp(y - y0, 0, 1);

  const v00 = values[indexOfCell(x0, y0, width)];
  const v10 = values[indexOfCell(x1, y0, width)];
  const v01 = values[indexOfCell(x0, y1, width)];
  const v11 = values[indexOfCell(x1, y1, width)];

  const a = lerp(v00, v10, tx);
  const b = lerp(v01, v11, tx);
  return lerp(a, b, ty);
}

function nearestMaskSample(mask: Uint8Array, width: number, height: number, x: number, y: number): number {
  const gx = clamp(Math.round(x), 0, width - 1);
  const gy = clamp(Math.round(y), 0, height - 1);
  return mask[indexOfCell(gx, gy, width)];
}

function ensureImageReady(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
    return Promise.resolve();
  }

  if (typeof image.decode === 'function') {
    return image.decode().catch(() => {
      return new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Failed to decode image source.'));
      });
    });
  }

  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Failed to load image source.'));
  });
}

async function rasterFromImage(
  source: HeightfieldImageSource,
  options: HeightfieldImageOptions = {},
): Promise<HeightfieldRaster> {
  const valueFromRGBA =
    options.valueFromRGBA ??
    ((r, g, b) => {
      return (r + g + b) / (3 * 255);
    });

  let width = 0;
  let height = 0;
  let imageData: ImageData;

  if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
    width = source.width;
    height = source.height;
    imageData = source;
  } else {
    if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
      await ensureImageReady(source);
      width = source.naturalWidth || source.width;
      height = source.naturalHeight || source.height;
    } else if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
      width = source.width;
      height = source.height;
    } else if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
      width = source.width;
      height = source.height;
    } else {
      throw new Error('Unsupported image source.');
    }

    let canvas: HTMLCanvasElement | OffscreenCanvas;
    let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;

    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(width, height);
      ctx = canvas.getContext('2d');
    } else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      ctx = canvas.getContext('2d');
    } else {
      throw new Error('No canvas implementation available for image rasterization.');
    }

    if (!ctx) {
      throw new Error('Failed to acquire a 2D canvas context.');
    }

    ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
    imageData = ctx.getImageData(0, 0, width, height);
  }

  const values = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  const rgba = imageData.data;
  const flipY = !!options.flipY;
  const alphaMeansInvalid = !!options.alphaMeansInvalid;

  for (let y = 0; y < height; y++) {
    const srcY = flipY ? height - 1 - y : y;

    for (let x = 0; x < width; x++) {
      const srcIndex = (srcY * width + x) * 4;
      const dstIndex = indexOfCell(x, y, width);
      const r = rgba[srcIndex];
      const g = rgba[srcIndex + 1];
      const b = rgba[srcIndex + 2];
      const a = rgba[srcIndex + 3];

      values[dstIndex] = valueFromRGBA(r, g, b, a, dstIndex);
      mask[dstIndex] = alphaMeansInvalid && a === 0 ? 0 : 1;
    }
  }

  return { width, height, values, mask };
}

export default class HeightfieldTINBuilder {
  readonly options: Required<HeightfieldTINOptions>;

  private width = 0;
  private height = 0;
  private heights: Float32Array | null = null;
  private mask: Uint8Array | null = null;

  private analysis: HeightfieldTINAnalysis | null = null;
  private topology: HeightfieldTINTopology | null = null;

  constructor(options: HeightfieldTINOptions = {}) {
    const cellSize = Math.max(options.cellSize ?? 1, EPSILON);
    const minSpacing = Math.max(options.minSpacing ?? cellSize, EPSILON);
    const maxSpacing = Math.max(options.maxSpacing ?? (cellSize * 16), minSpacing);

    this.options = {
      mode: options.mode ?? 'hybrid',
      cellSize,
      worldMinX: options.worldMinX ?? 0,
      worldMinY: options.worldMinY ?? 0,
      minSpacing,
      maxSpacing,
      borderSpacing: Math.max(options.borderSpacing ?? maxSpacing, EPSILON),
      wetnessBins: Math.max(4, Math.floor(options.wetnessBins ?? 21)),
      channelThreshold: Math.max(1, Math.floor(options.channelThreshold ?? 128)),
      floodplainChannelDistanceCells: Math.max(1, Math.floor(options.floodplainChannelDistanceCells ?? 6)),
      candidateStride: Math.max(1, Math.floor(options.candidateStride ?? 1)),
      maxPoints: Math.max(3, Math.floor(options.maxPoints ?? Number.MAX_SAFE_INTEGER)),
      preserveBorder: options.preserveBorder ?? true,
      preserveChannels: options.preserveChannels ?? true,
      preserveMaskBoundary: options.preserveMaskBoundary ?? true,
      preserveInnerBorder: options.preserveInnerBorder ?? true,
      slopeWeight: Math.max(0, options.slopeWeight ?? 0.35),
      curvatureWeight: Math.max(0, options.curvatureWeight ?? 0.15),
      reliefWeight: Math.max(0, options.reliefWeight ?? 0.2),
      wetnessWeight: Math.max(0, options.wetnessWeight ?? 0.4),
      channelWeight: Math.max(0, options.channelWeight ?? 0.2),
      floodplainWeight: Math.max(0, options.floodplainWeight ?? 0.25),
      relaxIterations: Math.max(0, Math.floor(options.relaxIterations ?? 0)),
      forcedWorldPoints: options.forcedWorldPoints ?? null,
    };
  }

  setRaster(raster: HeightfieldRaster): void {
    if (!raster || raster.width <= 0 || raster.height <= 0) {
      throw new Error('Raster must have positive width and height.');
    }
    if (!(raster.values instanceof Float32Array)) {
      throw new Error('Raster values must be a Float32Array.');
    }
    if (raster.values.length !== raster.width * raster.height) {
      throw new Error('Raster value count does not match width * height.');
    }

    const mask =
      raster.mask && raster.mask.length === raster.width * raster.height
        ? raster.mask instanceof Uint8Array
          ? raster.mask
          : new Uint8Array(raster.mask)
        : makeFullMask(raster.width, raster.height);

    this.width = raster.width;
    this.height = raster.height;
    this.heights = raster.values;
    this.mask = mask;
    this.invalidate();
  }

  async setImage(source: HeightfieldImageSource, options: HeightfieldImageOptions = {}): Promise<void> {
    const raster = await rasterFromImage(source, options);
    this.setRaster(raster);
  }

  setHeightValue(x: number, y: number, value: number): void {
    this.ensureRaster();
    const gx = clamp(Math.floor(x), 0, this.width - 1);
    const gy = clamp(Math.floor(y), 0, this.height - 1);
    const i = indexOfCell(gx, gy, this.width);
    this.heights![i] = value;
    this.analysis = null;
    this.topology = null;
  }

  async buildWithForcedWorldPoints(forcedWorldPoints: ArrayLike<number> | null): Promise<HeightfieldTINTopology> {
    this.ensureRaster();
    const analysis = this.analysis ?? this.buildAnalysis();
    const previousForced = this.options.forcedWorldPoints;
    try {
      this.options.forcedWorldPoints = forcedWorldPoints ?? previousForced ?? null;
      const topology = this.buildTopology(analysis);
      this.analysis = analysis;
      this.topology = topology;
      return topology;
    } finally {
      this.options.forcedWorldPoints = previousForced;
    }
  }

  getAnalysis(): HeightfieldTINAnalysis | null {
    return this.analysis;
  }

  getTopology(): HeightfieldTINTopology | null {
    return this.topology;
  }

  async build(): Promise<HeightfieldTINTopology> {
    this.ensureRaster();
    const analysis = this.buildAnalysis();
    const topology = this.buildTopology(analysis);
    this.analysis = analysis;
    this.topology = topology;
    return topology;
  }

  async rebuild(): Promise<HeightfieldTINTopology> {
    return this.build();
  }

  resampleVertexHeights(): Float32Array {
    this.ensureRaster();

    if (!this.topology) {
      throw new Error('Build topology before resampling heights.');
    }

    const heights = this.sampleVertexHeights(this.topology.positionsGrid);
    this.topology.heights = heights;
    return heights;
  }

  private invalidate(): void {
    this.analysis = null;
    this.topology = null;
  }

  private ensureRaster(): void {
    if (!this.heights || !this.mask || this.width <= 0 || this.height <= 0) {
      throw new Error('No heightfield raster is loaded.');
    }
  }

  private buildAnalysis(): HeightfieldTINAnalysis {
    const width = this.width;
    const height = this.height;
    const cellSize = this.options.cellSize;
    const heights = this.heights!;
    const mask = this.mask!;

    const slopeTan = this.computeSlopeTan(heights, width, height, cellSize, mask);
    const slopeDegrees = new Float32Array(width * height);
    for (let i = 0; i < slopeTan.length; i++) {
      slopeDegrees[i] = Math.atan(slopeTan[i]) * (180 / Math.PI);
    }

    const curvature = this.computeCurvature(heights, width, height, cellSize, mask);
    const localRelief = this.computeLocalRelief(heights, width, height, mask);
    const flowReceiver = this.computeFlowReceiver(heights, width, height, cellSize, mask);
    const flowAccumulation = this.computeFlowAccumulation(flowReceiver, width, height, mask);
    const wetness = this.computeWetness(flowAccumulation, slopeTan, width, height, cellSize, mask);
    const channels = this.extractChannels(flowAccumulation, width, height, mask);
    const channelDistance = this.computeChannelDistance(channels, width, height, mask);
    const floodplain = this.extractFloodplain(wetness, slopeTan, channelDistance, width, height, mask);
    const terrainPriority = this.computeTerrainPriority(slopeTan, curvature, localRelief, mask);
    const hydroPriority = this.computeHydroPriority(wetness, channels, channelDistance, floodplain, mask);

    let validCellCount = 0;
    let channelCellCount = 0;

    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) validCellCount++;
      if (channels[i]) channelCellCount++;
    }

    const totalArea = validCellCount * cellSize * cellSize;
    const totalChannelLength = channelCellCount * cellSize;
    const hillslopeLength =
      totalChannelLength > EPSILON
        ? totalArea / (2 * totalChannelLength)
        : this.options.maxSpacing;

    const importance = this.computeImportance(
      terrainPriority,
      hydroPriority,
      mask,
    );

    const spacing = this.computeSpacing(
      terrainPriority,
      hydroPriority,
      channels,
      floodplain,
      mask,
      hillslopeLength,
    );

    return {
      width,
      height,
      cellSize,
      heights,
      mask,
      slopeTan,
      slopeDegrees,
      curvature,
      localRelief,
      flowReceiver,
      flowAccumulation,
      wetness,
      channels,
      channelDistance,
      floodplain,
      terrainPriority,
      hydroPriority,
      importance,
      spacing,
      validCellCount,
      totalArea,
      totalChannelLength,
      hillslopeLength,
    };
  }

  private computeSlopeTan(
    heights: Float32Array,
    width: number,
    height: number,
    cellSize: number,
    mask: Uint8Array,
  ): Float32Array {
    const slope = new Float32Array(width * height);
    const inv2 = 1 / (2 * cellSize);

    for (let y = 0; y < height; y++) {
      const ym1 = y > 0 ? y - 1 : y;
      const yp1 = y < height - 1 ? y + 1 : y;

      for (let x = 0; x < width; x++) {
        const i = indexOfCell(x, y, width);
        if (!mask[i]) continue;

        const xm1 = x > 0 ? x - 1 : x;
        const xp1 = x < width - 1 ? x + 1 : x;

        const left = heights[indexOfCell(xm1, y, width)];
        const right = heights[indexOfCell(xp1, y, width)];
        const up = heights[indexOfCell(x, ym1, width)];
        const down = heights[indexOfCell(x, yp1, width)];

        const dzdx = (right - left) * inv2;
        const dzdy = (down - up) * inv2;
        slope[i] = Math.hypot(dzdx, dzdy);
      }
    }

    return slope;
  }

  private computeCurvature(
    heights: Float32Array,
    width: number,
    height: number,
    cellSize: number,
    mask: Uint8Array,
  ): Float32Array {
    const curvature = new Float32Array(width * height);
    const inv = 1 / (cellSize * cellSize);

    for (let y = 0; y < height; y++) {
      const ym1 = y > 0 ? y - 1 : y;
      const yp1 = y < height - 1 ? y + 1 : y;

      for (let x = 0; x < width; x++) {
        const i = indexOfCell(x, y, width);
        if (!mask[i]) continue;

        const xm1 = x > 0 ? x - 1 : x;
        const xp1 = x < width - 1 ? x + 1 : x;

        const c = heights[i];
        const left = heights[indexOfCell(xm1, y, width)];
        const right = heights[indexOfCell(xp1, y, width)];
        const up = heights[indexOfCell(x, ym1, width)];
        const down = heights[indexOfCell(x, yp1, width)];

        curvature[i] = (left + right + up + down - 4 * c) * inv;
      }
    }

    return curvature;
  }

  private computeLocalRelief(
    heights: Float32Array,
    width: number,
    height: number,
    mask: Uint8Array,
  ): Float32Array {
    const relief = new Float32Array(width * height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = indexOfCell(x, y, width);
        if (!mask[i]) continue;

        let localMin = Infinity;
        let localMax = -Infinity;

        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

            const ni = indexOfCell(nx, ny, width);
            if (!mask[ni]) continue;

            const z = heights[ni];
            if (z < localMin) localMin = z;
            if (z > localMax) localMax = z;
          }
        }

        relief[i] = localMax - localMin;
      }
    }

    return relief;
  }

  private computeFlowReceiver(
    heights: Float32Array,
    width: number,
    height: number,
    cellSize: number,
    mask: Uint8Array,
  ): Int32Array {
    const receiver = new Int32Array(width * height);
    receiver.fill(-1);

    const diag = Math.SQRT2 * cellSize;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = indexOfCell(x, y, width);
        if (!mask[i]) continue;

        const z = heights[i];
        let bestIndex = -1;
        let bestSlope = 0;

        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;

            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

            const ni = indexOfCell(nx, ny, width);
            if (!mask[ni]) continue;

            const dz = z - heights[ni];
            if (dz <= 0) continue;

            const dist = ox !== 0 && oy !== 0 ? diag : cellSize;
            const localSlope = dz / dist;

            if (localSlope > bestSlope) {
              bestSlope = localSlope;
              bestIndex = ni;
            }
          }
        }

        receiver[i] = bestIndex;
      }
    }

    return receiver;
  }

  private computeFlowAccumulation(
    receiver: Int32Array,
    width: number,
    height: number,
    mask: Uint8Array,
  ): Float32Array {
    const count = width * height;
    const indegree = new Int32Array(count);
    const accumulation = new Float32Array(count);
    const queue = new Int32Array(count);

    for (let i = 0; i < count; i++) {
      if (!mask[i]) continue;
      accumulation[i] = 1;
      const r = receiver[i];
      if (r >= 0) indegree[r]++;
    }

    let head = 0;
    let tail = 0;

    for (let i = 0; i < count; i++) {
      if (mask[i] && indegree[i] === 0) {
        queue[tail++] = i;
      }
    }

    while (head < tail) {
      const i = queue[head++];
      const r = receiver[i];

      if (r >= 0) {
        accumulation[r] += accumulation[i];
        indegree[r]--;
        if (indegree[r] === 0) {
          queue[tail++] = r;
        }
      }
    }

    return accumulation;
  }

  private computeWetness(
    accumulation: Float32Array,
    slopeTan: Float32Array,
    width: number,
    height: number,
    cellSize: number,
    mask: Uint8Array,
  ): Float32Array {
    const wetness = new Float32Array(width * height);

    for (let i = 0; i < wetness.length; i++) {
      if (!mask[i]) continue;

      const ai = accumulation[i] * cellSize;

      // For more hydrologic realism during erosion, replace this proxy with
      // a depression-treated specific catchment area pass and recompute it
      // after any surface update that materially changes drainage structure.
      wetness[i] = Math.log(Math.max(ai, EPSILON) / Math.max(slopeTan[i], EPSILON));
    }

    return wetness;
  }

  private extractChannels(
    accumulation: Float32Array,
    width: number,
    height: number,
    mask: Uint8Array,
  ): Uint8Array {
    const channels = new Uint8Array(width * height);
    const threshold = this.options.channelThreshold;

    for (let i = 0; i < channels.length; i++) {
      if (!mask[i]) continue;
      if (accumulation[i] >= threshold) {
        channels[i] = 1;
      }
    }

    return channels;
  }

  private computeChannelDistance(
    channels: Uint8Array,
    width: number,
    height: number,
    mask: Uint8Array,
  ): Float32Array {
    const distance = new Float32Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;

    for (let i = 0; i < distance.length; i++) {
      if (!mask[i]) {
        distance[i] = LARGE_DISTANCE;
        continue;
      }

      if (channels[i]) {
        distance[i] = 0;
        queue[tail++] = i;
      } else {
        distance[i] = LARGE_DISTANCE;
      }
    }

    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      const y = (i / width) | 0;
      const base = distance[i];

      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;

          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

          const ni = indexOfCell(nx, ny, width);
          if (!mask[ni]) continue;

          const step = ox !== 0 && oy !== 0 ? Math.SQRT2 : 1;
          const next = base + step;

          if (next < distance[ni]) {
            distance[ni] = next;
            queue[tail++] = ni;
          }
        }
      }
    }

    return distance;
  }

  private extractFloodplain(
    wetness: Float32Array,
    slopeTan: Float32Array,
    channelDistance: Float32Array,
    width: number,
    height: number,
    mask: Uint8Array,
  ): Uint8Array {
    const wetnessNorm = normalizeArray(wetness, mask);
    const slopeNorm = normalizeArray(slopeTan, mask);
    const floodplain = new Uint8Array(width * height);
    const maxDist = this.options.floodplainChannelDistanceCells;

    for (let i = 0; i < floodplain.length; i++) {
      if (!mask[i]) continue;

      const nearChannel = channelDistance[i] <= maxDist;
      const wetEnough = wetnessNorm[i] >= 0.58;
      const flatEnough = slopeNorm[i] <= 0.42;

      if (nearChannel && wetEnough && flatEnough) {
        floodplain[i] = 1;
      }
    }

    return floodplain;
  }

  private computeTerrainPriority(
    slopeTan: Float32Array,
    curvature: Float32Array,
    localRelief: Float32Array,
    mask: Uint8Array,
  ): Float32Array {
    // Terrain-first sampling priority. Real DEMs need strong preference for slope,
    // local relief, and break-of-slope complexity so rugged mountain terrain does
    // not get under-sampled relative to smoother convergent lowlands.
    // Recompute after any erosion step that changes the heightfield.
    const slopeNorm = normalizeArray(slopeTan, mask);
    const curvatureNorm = normalizeAbsArray(curvature, mask);
    const reliefNorm = normalizeArray(localRelief, mask);
    const out = new Float32Array(slopeTan.length);

    for (let i = 0; i < out.length; i++) {
      if (!mask[i]) continue;

      const ruggedness =
        slopeNorm[i] * 0.48 +
        reliefNorm[i] * 0.34 +
        curvatureNorm[i] * 0.18;

      const majorRelief = Math.max(slopeNorm[i], reliefNorm[i]);
      const sharpBreak = Math.max(curvatureNorm[i], (slopeNorm[i] + reliefNorm[i]) * 0.5);
      const terrain = Math.max(ruggedness, majorRelief * 0.97, sharpBreak * 0.9);

      out[i] = clamp(Math.pow(terrain, 0.7), 0, 1);
    }

    return normalizeArray(out, mask);
  }

  private computeHydroPriority(
    wetness: Float32Array,
    channels: Uint8Array,
    channelDistance: Float32Array,
    floodplain: Uint8Array,
    mask: Uint8Array,
  ): Float32Array {
    // Hydrology-driven sampling: adds resolution near channels/floodplains without starving rugged terrain.
    // For erosion, recompute flowReceiver/flowAccumulation/wetness first, then regenerate this field.
    const wetnessNorm = normalizeArray(wetness, mask);
    const out = new Float32Array(wetness.length);

    let distanceMax = 0;
    for (let i = 0; i < channelDistance.length; i++) {
      if (!mask[i]) continue;
      if (channelDistance[i] < LARGE_DISTANCE && channelDistance[i] > distanceMax) {
        distanceMax = channelDistance[i];
      }
    }

    for (let i = 0; i < out.length; i++) {
      if (!mask[i]) continue;

      const d = channelDistance[i] >= LARGE_DISTANCE ? distanceMax : channelDistance[i];
      const proximity = 1 - clamp(d / Math.max(distanceMax, 1), 0, 1);
      const hydro =
        wetnessNorm[i] * 0.46 +
        proximity * 0.18 +
        channels[i] * 0.22 +
        floodplain[i] * 0.14;

      out[i] = clamp(hydro, 0, 1);
    }

    return normalizeArray(out, mask);
  }

  private computeImportance(
    terrainPriority: Float32Array,
    hydroPriority: Float32Array,
    mask: Uint8Array,
  ): Float32Array {
    const out = new Float32Array(terrainPriority.length);
    const mode = this.options.mode;

    for (let i = 0; i < out.length; i++) {
      if (!mask[i]) continue;

      const terrain = terrainPriority[i];
      const hydro = hydroPriority[i];

      if (mode === 'traditional') {
        out[i] = terrain;
      } else if (mode === 'hydrological') {
        out[i] = Math.max(terrain * 0.8, hydro);
      } else if (mode === 'hydrographic') {
        out[i] = Math.max(terrain, hydro * 0.55) * 0.96 + Math.min(terrain, hydro) * 0.04;
      } else {
        out[i] = Math.max(terrain, hydro * 0.5) * 0.97 + Math.min(terrain, hydro) * 0.03;
      }

      out[i] = clamp(out[i], 0, 1);
    }

    return normalizeArray(out, mask);
  }

  private computeSpacing(
    terrainPriority: Float32Array,
    hydroPriority: Float32Array,
    channels: Uint8Array,
    floodplain: Uint8Array,
    mask: Uint8Array,
    hillslopeLength: number,
  ): Float32Array {
    const out = new Float32Array(terrainPriority.length);
    const cellSize = this.options.cellSize;
    const minSpacing = Math.max(this.options.minSpacing, cellSize);
    const maxSpacing = Math.max(
      minSpacing,
      Math.min(this.options.maxSpacing, Math.max(hillslopeLength, minSpacing)),
    );

    const mode = this.options.mode;

    for (let i = 0; i < out.length; i++) {
      if (!mask[i]) continue;

      const terrain = clamp(terrainPriority[i], 0, 1);
      const hydro = clamp(hydroPriority[i], 0, 1);

      const terrainT = smoothstep(0.08, 0.94, terrain);
      const terrainSpacing = lerp(maxSpacing, minSpacing, Math.pow(terrainT, 0.62));

      let spacing = terrainSpacing;

      if (mode === 'hydrological') {
        const hydroT = smoothstep(0.42, 0.97, hydro);
        const hydroSpacing = lerp(maxSpacing, minSpacing * 1.15, Math.pow(hydroT, 1.15));
        spacing = Math.min(terrainSpacing, hydroSpacing);
      } else {
        // Hydrology is additive only. It tightens spacing near connected channels
        // and floodplain support zones, but does not override rugged terrain as the
        // primary clustering signal.
        if (channels[i]) {
          const channelT = Math.max(0.82, smoothstep(0.45, 0.98, hydro));
          const channelSpacing = lerp(maxSpacing, minSpacing * 1.02, Math.pow(channelT, 1.05));
          spacing = Math.min(spacing, channelSpacing);
        } else if (floodplain[i]) {
          const floodT = Math.max(0.62, smoothstep(0.45, 0.95, hydro));
          const floodSpacing = lerp(maxSpacing, minSpacing * 1.28, Math.pow(floodT, 1.15));
          spacing = Math.min(spacing, floodSpacing);
        } else if (hydro >= 0.9 && terrain >= 0.35) {
          const hydroSpacing = lerp(maxSpacing, minSpacing * 1.6, Math.pow(hydro, 1.35));
          spacing = Math.min(spacing, hydroSpacing);
        }
      }

      if (terrain >= 0.82) {
        spacing = Math.min(spacing, lerp(maxSpacing, minSpacing, 0.92));
      } else if (terrain >= 0.68) {
        spacing = Math.min(spacing, lerp(maxSpacing, minSpacing, 0.8));
      } else if (terrain >= 0.52) {
        spacing = Math.min(spacing, lerp(maxSpacing, minSpacing, 0.64));
      }

      out[i] = clamp(spacing, minSpacing, maxSpacing);
    }

    return out;
  }

  private buildTopology(analysis: HeightfieldTINAnalysis): HeightfieldTINTopology {
    const accepted: AcceptedPoint[] = [];
    const acceptedMask = new Uint8Array(analysis.width * analysis.height);

    const hashCellSize = Math.max(
      analysis.cellSize,
      this.options.minSpacing * 0.5,
      this.options.maxSpacing * 0.25,
    );

    const minWorldX = this.options.worldMinX;
    const minWorldY = this.options.worldMinY;
    const maxWorldX = minWorldX + Math.max(0, analysis.width - 1) * analysis.cellSize;
    const maxWorldY = minWorldY + Math.max(0, analysis.height - 1) * analysis.cellSize;
    const bucketWidth = Math.max(1, Math.floor((maxWorldX - minWorldX) / hashCellSize) + 1);
    const bucketHeight = Math.max(1, Math.floor((maxWorldY - minWorldY) / hashCellSize) + 1);
    const spatial: number[][] = Array.from({ length: bucketWidth * bucketHeight }, () => []);

    const tryAccept = (
      gx: number,
      gy: number,
      radius: number,
      fixed: boolean,
    ): boolean => {
      if (gx < 0 || gy < 0 || gx >= analysis.width || gy >= analysis.height) return false;

      const cellIndex = indexOfCell(gx, gy, analysis.width);
      if (!analysis.mask[cellIndex]) return false;
      if (acceptedMask[cellIndex]) return false;

      const x = this.options.worldMinX + gx * analysis.cellSize;
      const y = this.options.worldMinY + gy * analysis.cellSize;
      const hx = clamp(Math.floor((x - minWorldX) / hashCellSize), 0, bucketWidth - 1);
      const hy = clamp(Math.floor((y - minWorldY) / hashCellSize), 0, bucketHeight - 1);
      const queryRadius = Math.max(radius, hashCellSize * 0.75);
      const ring = Math.max(1, Math.ceil(queryRadius / hashCellSize));
      const minHX = Math.max(0, hx - ring);
      const maxHX = Math.min(bucketWidth - 1, hx + ring);
      const minHY = Math.max(0, hy - ring);
      const maxHY = Math.min(bucketHeight - 1, hy + ring);

      for (let by = minHY; by <= maxHY; by++) {
        const rowBase = by * bucketWidth;
        for (let bx = minHX; bx <= maxHX; bx++) {
          const bucket = spatial[rowBase + bx];
          for (let i = 0; i < bucket.length; i++) {
            const other = accepted[bucket[i]];
            const dx = x - other.x;
            const dy = y - other.y;
            const minDist = Math.max(radius, other.radius);
            if (dx * dx + dy * dy < minDist * minDist) {
              return false;
            }
          }
        }
      }

      const pointIndex = accepted.length;
      accepted.push({ x, y, gx, gy, radius, fixed });
      acceptedMask[cellIndex] = 1;
      spatial[hy * bucketWidth + hx].push(pointIndex);
      return true;
    };

    this.emitForcedPoints(analysis, tryAccept);
    this.emitAdaptivePoints(analysis, tryAccept);

    if (accepted.length < 3) {
      throw new Error('Adaptive sampling retained fewer than 3 valid points.');
    }

    if (this.options.relaxIterations > 0) {
      this.relaxAcceptedPoints(accepted, analysis);
    }

    const pointCount = accepted.length;
    const positions2D = new Float32Array(pointCount * 2);
    const positionsGrid = new Float32Array(pointCount * 2);
    const uvs = new Float32Array(pointCount * 2);
    const vertexImportance = new Float32Array(pointCount);
    const vertexWetness = new Float32Array(pointCount);
    const vertexBoundaryMask = new Uint8Array(pointCount);

    for (let i = 0; i < pointCount; i++) {
      const p = accepted[i];
      const j = i * 2;

      positions2D[j] = p.x;
      positions2D[j + 1] = p.y;

      positionsGrid[j] = p.gx;
      positionsGrid[j + 1] = p.gy;

      uvs[j] = analysis.width > 1 ? p.gx / (analysis.width - 1) : 0;
      uvs[j + 1] = analysis.height > 1 ? p.gy / (analysis.height - 1) : 0;

      const gx = clamp(Math.round(p.gx), 0, analysis.width - 1);
      const gy = clamp(Math.round(p.gy), 0, analysis.height - 1);
      const cellIndex = indexOfCell(gx, gy, analysis.width);

      vertexImportance[i] = analysis.importance[cellIndex];
      vertexWetness[i] = analysis.wetness[cellIndex];
      vertexBoundaryMask[i] = isBoundaryCell(analysis.mask, analysis.width, analysis.height, gx, gy) ? 1 : 0;
    }

    const triangulationCoords = new Float64Array(pointCount * 2);
    for (let i = 0; i < positions2D.length; i++) {
      triangulationCoords[i] = positions2D[i];
    }

    const delaunay = new Delaunator(triangulationCoords);
    const filtered = this.filterTrianglesToMask(
      delaunay.triangles,
      positionsGrid,
      analysis,
    );

    const halfedges = this.buildHalfedges(filtered);
    const { centers, areas } = this.buildTriangleGeometry(filtered, positions2D);
    const { offsets, neighbors } = this.buildVertexAdjacency(filtered, pointCount);
    const heights = this.sampleVertexHeights(positionsGrid);

    return {
      positions2D,
      positionsGrid,
      uvs,
      heights,
      indices: filtered,
      halfedges,
      triangleCenters: centers,
      triangleAreas: areas,
      vertexNeighborOffsets: offsets,
      vertexNeighbors: neighbors,
      vertexBoundaryMask,
      vertexImportance,
      vertexWetness,
      analysis,
    };
  }

  private emitForcedPoints(
    analysis: HeightfieldTINAnalysis,
    tryAccept: (gx: number, gy: number, radius: number, fixed: boolean) => boolean,
  ): void {
    const minSpacing = Math.max(this.options.minSpacing, analysis.cellSize);
    const maxSpacing = Math.max(this.options.maxSpacing, minSpacing);
    const borderStepCells = Math.max(1, Math.round(this.options.borderSpacing / analysis.cellSize));
    const boundaryStepCells = Math.max(1, Math.round(maxSpacing / analysis.cellSize));
    const channelStepCells = Math.max(2, Math.round((minSpacing * 2.25) / analysis.cellSize));
    const innerRingOffset = Math.max(1, Math.round(maxSpacing / analysis.cellSize));

    const borderRadius = Math.max(maxSpacing * 0.5, analysis.cellSize);
    const boundaryRadius = Math.max(maxSpacing * 0.5, analysis.cellSize);
    const channelRadius = Math.max(minSpacing * 1.0, analysis.cellSize);
    const forcedPointRadius = Math.max(minSpacing * 0.35, analysis.cellSize * 0.5);

    if (this.options.preserveBorder) {
      for (let x = 0; x < analysis.width; x += borderStepCells) {
        tryAccept(x, 0, borderRadius, true);
        tryAccept(x, analysis.height - 1, borderRadius, true);
      }

      for (let y = 0; y < analysis.height; y += borderStepCells) {
        tryAccept(0, y, borderRadius, true);
        tryAccept(analysis.width - 1, y, borderRadius, true);
      }

      tryAccept(0, 0, borderRadius, true);
      tryAccept(analysis.width - 1, 0, borderRadius, true);
      tryAccept(0, analysis.height - 1, borderRadius, true);
      tryAccept(analysis.width - 1, analysis.height - 1, borderRadius, true);

      if (this.options.preserveInnerBorder && analysis.width > 2 && analysis.height > 2) {
        const left = clamp(innerRingOffset, 1, analysis.width - 2);
        const right = clamp(analysis.width - 1 - innerRingOffset, 1, analysis.width - 2);
        const top = clamp(innerRingOffset, 1, analysis.height - 2);
        const bottom = clamp(analysis.height - 1 - innerRingOffset, 1, analysis.height - 2);

        for (let x = left; x <= right; x += boundaryStepCells) {
          tryAccept(x, top, boundaryRadius, true);
          tryAccept(x, bottom, boundaryRadius, true);
        }

        for (let y = top; y <= bottom; y += boundaryStepCells) {
          tryAccept(left, y, boundaryRadius, true);
          tryAccept(right, y, boundaryRadius, true);
        }
      }
    }

    if (this.options.preserveMaskBoundary) {
      for (let y = 0; y < analysis.height; y++) {
        for (let x = 0; x < analysis.width; x++) {
          if (!isBoundaryCell(analysis.mask, analysis.width, analysis.height, x, y)) continue;

          const keep =
            x === 0 ||
            y === 0 ||
            x === analysis.width - 1 ||
            y === analysis.height - 1 ||
            x % boundaryStepCells === 0 ||
            y % boundaryStepCells === 0;

          if (keep) {
            tryAccept(x, y, boundaryRadius, true);
          }
        }
      }
    }

    if (this.options.preserveChannels) {
      for (let y = 0; y < analysis.height; y++) {
        for (let x = 0; x < analysis.width; x++) {
          const i = indexOfCell(x, y, analysis.width);
          if (!analysis.channels[i]) continue;

          const neighborCount = this.countMarkedNeighbors(
            analysis.channels,
            analysis.width,
            analysis.height,
            x,
            y,
          );

          const isEndpoint = neighborCount <= 1;
          const isJunction = neighborCount >= 3;
          const isSampledRun =
            (x % channelStepCells === 0 && y % channelStepCells === 0) ||
            ((x + y) % channelStepCells === 0 && neighborCount === 2);

          if (isEndpoint || isJunction || isSampledRun) {
            tryAccept(x, y, channelRadius, true);
          }
        }
      }
    }

    const forcedWorldPoints = this.options.forcedWorldPoints;
    if (forcedWorldPoints && forcedWorldPoints.length >= 2) {
      for (let i = 0; i + 1 < forcedWorldPoints.length; i += 2) {
        const x = Number(forcedWorldPoints[i]);
        const y = Number(forcedWorldPoints[i + 1]);

        if (!isFiniteNumber(x) || !isFiniteNumber(y)) continue;

        const gx = Math.round((x - this.options.worldMinX) / analysis.cellSize);
        const gy = Math.round((y - this.options.worldMinY) / analysis.cellSize);
        tryAccept(gx, gy, forcedPointRadius, true);
      }
    }
  }

  private countMarkedNeighbors(
    field: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
  ): number {
    let count = 0;

    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;

        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

        if (field[indexOfCell(nx, ny, width)] !== 0) {
          count++;
        }
      }
    }

    return count;
  }

  private emitAdaptivePoints(
    analysis: HeightfieldTINAnalysis,
    tryAccept: (gx: number, gy: number, radius: number, fixed: boolean) => boolean,
  ): void {
    const stride = this.options.candidateStride;
    const terrainBuckets: number[][] = Array.from({ length: DEFAULT_BUCKET_COUNT }, () => []);
    const hydroBuckets: number[][] = Array.from({ length: DEFAULT_BUCKET_COUNT }, () => []);
    const blendBuckets: number[][] = Array.from({ length: DEFAULT_BUCKET_COUNT }, () => []);

    for (let y = 0; y < analysis.height; y += stride) {
      for (let x = 0; x < analysis.width; x += stride) {
        const i = indexOfCell(x, y, analysis.width);
        if (!analysis.mask[i]) continue;

        const terrain = clamp(analysis.terrainPriority[i], 0, 1);
        const hydro = clamp(analysis.hydroPriority[i], 0, 1);
        const blend = clamp(Math.max(terrain, hydro * 0.45), 0, 1);

        const tb = clamp(Math.floor(Math.pow(terrain, 0.85) * (DEFAULT_BUCKET_COUNT - 1)), 0, DEFAULT_BUCKET_COUNT - 1);
        const hb = clamp(Math.floor(Math.pow(hydro, 1.55) * (DEFAULT_BUCKET_COUNT - 1)), 0, DEFAULT_BUCKET_COUNT - 1);
        const bb = clamp(Math.floor(Math.pow(blend, 0.95) * (DEFAULT_BUCKET_COUNT - 1)), 0, DEFAULT_BUCKET_COUNT - 1);

        terrainBuckets[tb].push(i);
        hydroBuckets[hb].push(i);
        blendBuckets[bb].push(i);
      }
    }

    const acceptedFlags = new Uint8Array(analysis.width * analysis.height);
    let acceptedCount = 0;

    const processBucketSet = (buckets: number[][], radiusScale: number, allowHydroBoost: boolean, hardLimit: number) => {
      for (let bucketIndex = DEFAULT_BUCKET_COUNT - 1; bucketIndex >= 0; bucketIndex--) {
        const bucket = buckets[bucketIndex];

        for (let k = 0; k < bucket.length; k++) {
          if (acceptedCount >= this.options.maxPoints || acceptedCount >= hardLimit) return;

          const i = bucket[k];
          if (acceptedFlags[i]) continue;

          const x = i % analysis.width;
          const y = (i / analysis.width) | 0;
          const spacing = analysis.spacing[i];
          const terrain = clamp(analysis.terrainPriority[i], 0, 1);
          const hydro = clamp(analysis.hydroPriority[i], 0, 1);

          let radius = Math.max(spacing * radiusScale, analysis.cellSize * 0.7);

          if (terrain >= 0.85) {
            radius *= 0.64;
          } else if (terrain >= 0.7) {
            radius *= 0.74;
          } else if (terrain >= 0.55) {
            radius *= 0.84;
          }

          if (allowHydroBoost && (analysis.channels[i] || analysis.floodplain[i])) {
            radius *= 0.95;
          }

          radius = quantizeRadius(
            radius,
            Math.max(analysis.cellSize * 0.7, this.options.minSpacing * 0.32),
            Math.max(this.options.minSpacing, this.options.maxSpacing * 0.62),
            16,
          );

          if (tryAccept(x, y, radius, false)) {
            acceptedFlags[i] = 1;
            acceptedCount++;
          }
        }
      }
    };

    const maxPoints = this.options.maxPoints;
    const terrainLimit = Math.floor(maxPoints * 0.82);
    const hydroLimit = Math.floor(maxPoints * 0.92);

    processBucketSet(terrainBuckets, 0.54, false, terrainLimit);
    processBucketSet(blendBuckets, 0.56, false, hydroLimit);
    processBucketSet(hydroBuckets, 0.6, true, maxPoints);
  }

  private relaxAcceptedPoints(accepted: AcceptedPoint[], analysis: HeightfieldTINAnalysis): void {
    if (accepted.length < 3) return;

    for (let iter = 0; iter < this.options.relaxIterations; iter++) {
      const positions = new Float64Array(accepted.length * 2);

      for (let i = 0; i < accepted.length; i++) {
        positions[i * 2] = accepted[i].x;
        positions[i * 2 + 1] = accepted[i].y;
      }

      const delaunay = new Delaunator(positions);
      const neighborSumsX = new Float64Array(accepted.length);
      const neighborSumsY = new Float64Array(accepted.length);
      const neighborCounts = new Uint32Array(accepted.length);

      for (let i = 0; i < delaunay.triangles.length; i += 3) {
        const a = delaunay.triangles[i];
        const b = delaunay.triangles[i + 1];
        const c = delaunay.triangles[i + 2];

        this.accumulateNeighbor(a, b, accepted, neighborSumsX, neighborSumsY, neighborCounts);
        this.accumulateNeighbor(a, c, accepted, neighborSumsX, neighborSumsY, neighborCounts);
        this.accumulateNeighbor(b, a, accepted, neighborSumsX, neighborSumsY, neighborCounts);
        this.accumulateNeighbor(b, c, accepted, neighborSumsX, neighborSumsY, neighborCounts);
        this.accumulateNeighbor(c, a, accepted, neighborSumsX, neighborSumsY, neighborCounts);
        this.accumulateNeighbor(c, b, accepted, neighborSumsX, neighborSumsY, neighborCounts);
      }

      for (let i = 0; i < accepted.length; i++) {
        if (accepted[i].fixed) continue;
        if (neighborCounts[i] === 0) continue;

        const targetX = neighborSumsX[i] / neighborCounts[i];
        const targetY = neighborSumsY[i] / neighborCounts[i];

        const gx = clamp(
          Math.round((targetX - this.options.worldMinX) / analysis.cellSize),
          0,
          analysis.width - 1,
        );
        const gy = clamp(
          Math.round((targetY - this.options.worldMinY) / analysis.cellSize),
          0,
          analysis.height - 1,
        );

        if (analysis.mask[indexOfCell(gx, gy, analysis.width)]) {
          accepted[i].gx = gx;
          accepted[i].gy = gy;
          accepted[i].x = this.options.worldMinX + gx * analysis.cellSize;
          accepted[i].y = this.options.worldMinY + gy * analysis.cellSize;
        }
      }
    }
  }

  private accumulateNeighbor(
    a: number,
    b: number,
    accepted: AcceptedPoint[],
    sumX: Float64Array,
    sumY: Float64Array,
    counts: Uint32Array,
  ): void {
    sumX[a] += accepted[b].x;
    sumY[a] += accepted[b].y;
    counts[a]++;
  }

  private filterTrianglesToMask(
    triangles: Uint32Array,
    positionsGrid: Float32Array,
    analysis: HeightfieldTINAnalysis,
  ): Uint32Array {
    const kept: number[] = [];

    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i];
      const b = triangles[i + 1];
      const c = triangles[i + 2];

      const a2 = a * 2;
      const b2 = b * 2;
      const c2 = c * 2;

      const cx = (positionsGrid[a2] + positionsGrid[b2] + positionsGrid[c2]) / 3;
      const cy = (positionsGrid[a2 + 1] + positionsGrid[b2 + 1] + positionsGrid[c2 + 1]) / 3;

      if (!nearestMaskSample(analysis.mask, analysis.width, analysis.height, cx, cy)) {
        continue;
      }

      kept.push(a, b, c);
    }

    return Uint32Array.from(kept);
  }

  private buildHalfedges(indices: Uint32Array): Int32Array {
    const halfedges = new Int32Array(indices.length);
    halfedges.fill(-1);

    const edgeMap = new Map<string, number>();

    for (let i = 0; i < indices.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = indices[i + e];
        const b = indices[i + ((e + 1) % 3)];
        const key = `${a}:${b}`;
        const rev = `${b}:${a}`;

        if (edgeMap.has(rev)) {
          const opposite = edgeMap.get(rev)!;
          halfedges[i + e] = opposite;
          halfedges[opposite] = i + e;
        } else {
          edgeMap.set(key, i + e);
        }
      }
    }

    return halfedges;
  }

  private buildTriangleGeometry(
    indices: Uint32Array,
    positions2D: Float32Array,
  ): { centers: Float32Array; areas: Float32Array } {
    const triCount = indices.length / 3;
    const centers = new Float32Array(triCount * 2);
    const areas = new Float32Array(triCount);

    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3] * 2;
      const i1 = indices[t * 3 + 1] * 2;
      const i2 = indices[t * 3 + 2] * 2;

      const ax = positions2D[i0];
      const ay = positions2D[i0 + 1];
      const bx = positions2D[i1];
      const by = positions2D[i1 + 1];
      const cx = positions2D[i2];
      const cy = positions2D[i2 + 1];

      centers[t * 2] = (ax + bx + cx) / 3;
      centers[t * 2 + 1] = (ay + by + cy) / 3;

      const twiceArea = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
      areas[t] = 0.5 * twiceArea;
    }

    return { centers, areas };
  }

  private buildVertexAdjacency(
    indices: Uint32Array,
    vertexCount: number,
  ): { offsets: Uint32Array; neighbors: Uint32Array } {
    const sets = Array.from({ length: vertexCount }, () => new Set<number>());

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i];
      const b = indices[i + 1];
      const c = indices[i + 2];

      sets[a].add(b);
      sets[a].add(c);
      sets[b].add(a);
      sets[b].add(c);
      sets[c].add(a);
      sets[c].add(b);
    }

    const offsets = new Uint32Array(vertexCount + 1);
    let total = 0;

    for (let i = 0; i < vertexCount; i++) {
      offsets[i] = total;
      total += sets[i].size;
    }
    offsets[vertexCount] = total;

    const neighbors = new Uint32Array(total);
    let write = 0;

    for (let i = 0; i < vertexCount; i++) {
      const list = Array.from(sets[i]);
      list.sort((a, b) => a - b);
      for (let j = 0; j < list.length; j++) {
        neighbors[write++] = list[j];
      }
    }

    return { offsets, neighbors };
  }

  private sampleVertexHeights(positionsGrid: Float32Array): Float32Array {
    const heights = new Float32Array(positionsGrid.length >> 1);

    for (let i = 0, j = 0; i < heights.length; i++, j += 2) {
      heights[i] = bilinearSample(
        this.heights!,
        this.width,
        this.height,
        positionsGrid[j],
        positionsGrid[j + 1],
      );
    }

    return heights;
  }

  // Call rebuild() after erosion or any other terrain edit that should change
  // the adaptive sampling. Call resampleVertexHeights() when the 2D topology
  // is intentionally kept fixed and only z values need refreshing.
}
