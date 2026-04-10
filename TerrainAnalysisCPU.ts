export interface TerrainAnalysisInput {
  width: number;
  height: number;
  heights: Float32Array;
  cellSize?: number;
  reliefRadius?: number;
  slopeWeight?: number;
  curvatureWeight?: number;
  reliefWeight?: number;
}

export interface TerrainAnalysisResult {
  width: number;
  height: number;
  slope: Float32Array;
  curvature: Float32Array;
  relief: Float32Array;
  terrainPriority: Float32Array;
  elapsedMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function normalize(values: Float32Array): Float32Array {
  const out = new Float32Array(values.length);
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const denom = Math.max(max - min, 1e-12);
  for (let i = 0; i < values.length; i++) {
    out[i] = (values[i] - min) / denom;
  }

  return out;
}

export function analyzeTerrainCPU(input: TerrainAnalysisInput): TerrainAnalysisResult {
  const {
    width,
    height,
    heights,
    cellSize = 1,
    reliefRadius = 2,
    slopeWeight = 0.5,
    curvatureWeight = 0.2,
    reliefWeight = 0.3,
  } = input;

  const t0 = performance.now();
  const slope = new Float32Array(width * height);
  const curvature = new Float32Array(width * height);
  const relief = new Float32Array(width * height);

  const inv2 = 1 / (2 * cellSize);
  const invCell2 = 1 / (cellSize * cellSize);

  for (let y = 0; y < height; y++) {
    const ym1 = y > 0 ? y - 1 : y;
    const yp1 = y < height - 1 ? y + 1 : y;

    for (let x = 0; x < width; x++) {
      const xm1 = x > 0 ? x - 1 : x;
      const xp1 = x < width - 1 ? x + 1 : x;
      const i = y * width + x;

      const left = heights[y * width + xm1];
      const right = heights[y * width + xp1];
      const up = heights[ym1 * width + x];
      const down = heights[yp1 * width + x];
      const center = heights[i];

      const dzdx = (right - left) * inv2;
      const dzdy = (down - up) * inv2;
      slope[i] = Math.hypot(dzdx, dzdy);
      curvature[i] = Math.abs((left + right + up + down - 4 * center) * invCell2);

      let localMin = Infinity;
      let localMax = -Infinity;
      for (let oy = -reliefRadius; oy <= reliefRadius; oy++) {
        const ny = clamp(y + oy, 0, height - 1);
        for (let ox = -reliefRadius; ox <= reliefRadius; ox++) {
          const nx = clamp(x + ox, 0, width - 1);
          const z = heights[ny * width + nx];
          if (z < localMin) localMin = z;
          if (z > localMax) localMax = z;
        }
      }
      relief[i] = localMax - localMin;
    }
  }

  const slopeN = normalize(slope);
  const curvatureN = normalize(curvature);
  const reliefN = normalize(relief);
  const terrainPriority = new Float32Array(width * height);

  for (let i = 0; i < terrainPriority.length; i++) {
    terrainPriority[i] = Math.min(
      1,
      slopeN[i] * slopeWeight + curvatureN[i] * curvatureWeight + reliefN[i] * reliefWeight,
    );
  }

  return {
    width,
    height,
    slope,
    curvature,
    relief,
    terrainPriority,
    elapsedMs: performance.now() - t0,
  };
}
