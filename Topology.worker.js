import HeightfieldTINBuilder from './HeightfieldTINBuilder.ts';
import RiverNetworkBuilder from './RiverNetworkBuilder.ts';
import FloodplainClassifier from './FloodplainClassifier.ts';

const DEBUG_LOGGING = false;
const WORKER_NAME = 'Topology worker';

let cachedRaster = null;
let cachedBuilder = null;
let cachedBuildOptionsKey = '';
let cachedTopology = null;
let cachedRiverBuilder = null;
let cachedRiverResult = null;
let cachedFloodplainClassifier = null;

self.addEventListener('error', (event) => {
  logError('global error', {
    message: event?.message || 'Unknown worker error',
    filename: event?.filename || null,
    lineno: event?.lineno || null,
    colno: event?.colno || null,
  });
});

self.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason instanceof Error
    ? event.reason.stack || event.reason.message
    : String(event?.reason);
  logError('unhandled rejection', { reason });
});

function emitWorkerLog(level, ...args) {
  if (!DEBUG_LOGGING) return;
  const fn = typeof console[level] === 'function' ? console[level] : console.log;
  fn.call(console, '[TopologyWorker]', ...args);
}

function log(...args) {
  emitWorkerLog('log', ...args);
}

function logError(...args) {
  emitWorkerLog('error', ...args);
}

function summarizeTopology(topology) {
  if (!topology) return null;
  return {
    vertices: topology.positionsGrid ? topology.positionsGrid.length >> 1 : 0,
    triangles: topology.indices ? Math.floor(topology.indices.length / 3) : 0,
    width: topology.analysis?.width ?? 0,
    height: topology.analysis?.height ?? 0,
  };
}

function summarizeRiverResult(result) {
  if (!result) return null;
  return {
    edgeCount: result.edges ? result.edges.length : 0,
    minWeight: result.minWeight ?? 0,
    maxWeight: result.maxWeight ?? 0,
  };
}

function summarizeView(view) {
  if (!view) return null;
  return {
    segmentCount: view.segments ? view.segments.length >> 2 : 0,
    activeVertexCount: view.activeVertexCount ?? 0,
    activeEdgeCount: view.activeEdgeCount ?? 0,
    floodplainSeedCount: view.floodplainResult?.seedVertices ? view.floodplainResult.seedVertices.length : 0,
  };
}

function cloneTypedArray(array) {
  return new array.constructor(array);
}

function collectUiTopologyTransferables(topology) {
  return [
    topology.positionsGrid.buffer,
    topology.indices.buffer,
    topology.analysis.mask.buffer,
    topology.analysis.importance.buffer,
  ];
}

function collectHydroTransferables(view) {
  const transferables = [];
  if (view.segments) transferables.push(view.segments.buffer);
  if (view.floodplainResult) {
    transferables.push(
      view.floodplainResult.vertexMask.buffer,
      view.floodplainResult.triangleMask.buffer,
      view.floodplainResult.seedVertices.buffer,
    );
  }
  return transferables;
}

function buildOptionsKey(buildOptions) {
  return JSON.stringify(buildOptions);
}

function resetDerivedCaches() {
  cachedTopology = null;
  cachedRiverBuilder = null;
  cachedRiverResult = null;
  cachedFloodplainClassifier = null;
}

function makeRiverBuilder(options) {
  cachedRiverBuilder = new RiverNetworkBuilder(options);
  return cachedRiverBuilder;
}

function makeFloodplainClassifier(options) {
  cachedFloodplainClassifier = new FloodplainClassifier(options);
  return cachedFloodplainClassifier;
}

function scanRange(values, mask = null) {
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < values.length; i++) {
    if (mask && !mask[i]) continue;
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: null, max: null };
  }

  return { min, max };
}

function maxVertexDegree(offsets) {
  let max = 0;
  for (let i = 0; i + 1 < offsets.length; i++) {
    const degree = offsets[i + 1] - offsets[i];
    if (degree > max) max = degree;
  }
  return max;
}

function makeUiTopology(topology) {
  const analysis = topology.analysis;
  return {
    positionsGrid: cloneTypedArray(topology.positionsGrid),
    indices: cloneTypedArray(topology.indices),
    analysis: {
      mask: cloneTypedArray(analysis.mask),
      importance: cloneTypedArray(analysis.importance),
    },
    statsSummary: {
      validCellCount: analysis.validCellCount,
      hillslopeLength: analysis.hillslopeLength,
      wetnessRange: scanRange(analysis.wetness, analysis.mask),
      importanceRange: scanRange(analysis.importance, analysis.mask),
      spacingRange: scanRange(analysis.spacing, analysis.mask),
      triangleAreaRange: scanRange(topology.triangleAreas),
      maxVertexDegree: maxVertexDegree(topology.vertexNeighborOffsets),
    },
  };
}

async function ensureBuilder(buildOptions) {
  if (!cachedRaster) throw new Error('No raster in topology worker.');
  const key = buildOptionsKey(buildOptions);
  if (!cachedBuilder || cachedBuildOptionsKey !== key) {
    log('creating builder', {
      keyChanged: cachedBuildOptionsKey !== key,
      width: cachedRaster.width,
      height: cachedRaster.height,
    });
    cachedBuilder = new HeightfieldTINBuilder(buildOptions);
    cachedBuilder.setRaster(cachedRaster);
    cachedBuildOptionsKey = key;
    resetDerivedCaches();
  } else {
    log('reusing cached builder', {
      width: cachedRaster.width,
      height: cachedRaster.height,
    });
  }
  return cachedBuilder;
}

async function ensureFirstTopology(buildOptions) {
  const builder = await ensureBuilder(buildOptions);
  if (cachedTopology) {
    return {
      topology: cachedTopology,
      buildMs: 0,
      fromCache: true,
    };
  }
  const t0 = performance.now();
  const topology = await builder.build();
  const buildMs = performance.now() - t0;
  cachedTopology = topology;
  return {
    topology,
    buildMs,
    fromCache: false,
  };
}

function deriveHydroView(minRiverWeight, floodplainOptions) {
  if (!cachedTopology || !cachedRiverBuilder || !cachedRiverResult || !cachedFloodplainClassifier) {
    return {
      segments: new Float32Array(0),
      activeVertexCount: 0,
      activeEdgeCount: 0,
      riverStats: {
        totalEdgeCount: 0,
        minWeight: 0,
        maxWeight: 0,
      },
      floodplainResult: {
        vertexMask: new Uint8Array(0),
        triangleMask: new Uint8Array(0),
        seedVertices: new Uint32Array(0),
      },
      timings: { deriveMs: 0 },
    };
  }

  const t0 = performance.now();
  const artifacts = cachedRiverBuilder.buildActiveArtifacts(cachedTopology, cachedRiverResult, minRiverWeight);
  const classifier = floodplainOptions ? makeFloodplainClassifier(floodplainOptions) : cachedFloodplainClassifier;
  const floodplainResult = classifier.classify(cachedTopology, artifacts.activeVertices);

  return {
    segments: artifacts.segments,
    activeVertexCount: artifacts.activeVertices.length,
    activeEdgeCount: artifacts.activeEdges.length,
    riverStats: {
      totalEdgeCount: cachedRiverResult.edges.length,
      minWeight: cachedRiverResult.minWeight,
      maxWeight: cachedRiverResult.maxWeight,
    },
    floodplainResult,
    timings: { deriveMs: performance.now() - t0 },
  };
}

log('module loaded', { href: typeof self.location !== 'undefined' ? self.location.href : null, worker: WORKER_NAME });

self.onmessage = async (event) => {
  const data = event && typeof event.data === 'object' && event.data !== null ? event.data : null;
  const id = data?.id;
  const type = data?.type;
  const payload = data?.payload;
  const startedAt = performance.now();

  if (typeof type !== 'string') {
    log('ignoring non-request message', {
      dataType: typeof event?.data,
      hasData: !!data,
      keys: data ? Object.keys(data) : null,
    });
    return;
  }

  log('message received', { id, type });

  try {
    if (type === 'ping') {
      self.postMessage({ id, ok: true, payload: { ok: true, worker: 'topology' } });
      log('ping complete', { id, elapsedMs: performance.now() - startedAt });
      return;
    }

    if (type === 'setRaster') {
      cachedRaster = {
        width: payload.width,
        height: payload.height,
        values: payload.values,
        mask: payload.mask,
      };
      cachedBuilder = null;
      cachedBuildOptionsKey = '';
      resetDerivedCaches();
      self.postMessage({ id, ok: true, payload: { ok: true } });
      return;
    }

    if (type === 'buildGuide') {
      const first = await ensureFirstTopology(payload.buildOptions);
      const topology = first.topology;
      const riverBuilder = makeRiverBuilder(payload.riverOptions);
      const t0 = performance.now();
      const riverResult = riverBuilder.buildFromTopology(topology);
      cachedRiverResult = riverResult;
      const guidePoints = riverBuilder.buildGuidePoints(topology, riverResult, payload.guideOptions);
      const activeVertexCount = riverBuilder.collectActiveVertices(riverResult, payload.guideOptions.minWeight).length;
      const buildGuideMs = performance.now() - t0;
      self.postMessage({
        id,
        ok: true,
        payload: {
          firstVertexCount: topology.positionsGrid.length >> 1,
          firstTriangleCount: Math.floor(topology.indices.length / 3),
          activeVertexCount,
          guidePoints,
          timings: {
            buildMs: first.buildMs,
            buildGuideMs,
          },
        },
      }, [guidePoints.buffer]);
      return;
    }

    if (type === 'buildFinal') {
      const builder = await ensureBuilder(payload.buildOptions);
      let topology = null;
      let buildMs = 0;

      if (payload.reuseCachedTopology && cachedTopology) {
        topology = cachedTopology;
      } else if (payload.guidePoints && payload.guidePoints.length >= 2) {
        const t0 = performance.now();
        topology = await builder.buildWithForcedWorldPoints(payload.guidePoints);
        buildMs = performance.now() - t0;
        cachedTopology = topology;
        cachedRiverResult = null;
      } else {
        const first = await ensureFirstTopology(payload.buildOptions);
        topology = first.topology;
        buildMs = first.buildMs;
      }

      let riverResult = cachedRiverResult;
      if (!riverResult) {
        const riverBuilder = makeRiverBuilder(payload.riverOptions);
        riverResult = riverBuilder.buildFromTopology(topology);
        cachedRiverResult = riverResult;
      } else if (!cachedRiverBuilder) {
        makeRiverBuilder(payload.riverOptions);
      }

      cachedFloodplainClassifier = makeFloodplainClassifier(payload.floodplainOptions);
      const hydroView = deriveHydroView(payload.minRiverWeight, payload.floodplainOptions);
      const uiTopology = makeUiTopology(topology);
      const transferables = collectUiTopologyTransferables(uiTopology).concat(collectHydroTransferables(hydroView));

      self.postMessage({
        id,
        ok: true,
        payload: {
          topology: uiTopology,
          hydroView,
          timings: {
            buildMs,
            deriveMs: hydroView.timings.deriveMs,
          },
        },
      }, transferables);

      cachedBuilder = null;
      cachedBuildOptionsKey = '';
      log('buildFinal complete', {
        id,
        topology: summarizeTopology(topology),
        river: summarizeRiverResult(riverResult),
        hydroView: summarizeView(hydroView),
        timings: { buildMs, deriveMs: hydroView.timings.deriveMs },
        elapsedMs: performance.now() - startedAt,
      });
      return;
    }

    if (type === 'updateDerived') {
      const hydroView = deriveHydroView(payload.minRiverWeight, payload.floodplainOptions);
      const transferables = collectHydroTransferables(hydroView);
      self.postMessage({ id, ok: true, payload: hydroView }, transferables);
      return;
    }

    throw new Error(`Unknown topology worker message: ${type}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : null;
    logError('error', {
      id,
      type,
      message,
      stack,
      elapsedMs: performance.now() - startedAt,
    });
    self.postMessage({ id, ok: false, error: stack ? `${message}\n${stack}` : message });
  }
};

export default self;
