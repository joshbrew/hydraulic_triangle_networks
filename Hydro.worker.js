import RiverNetworkBuilder from './RiverNetworkBuilder.ts';
import FloodplainClassifier from './FloodplainClassifier.ts';

const DEBUG_LOGGING = true;
const WORKER_NAME = 'Hydro worker';

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
  fn.call(console, WORKER_NAME === 'Topology worker' ? '[TopologyWorker]' : '[HydroWorker]', ...args);
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

function makeRiverBuilder(options) {
  cachedRiverBuilder = new RiverNetworkBuilder(options);
  log('river builder created');
  return cachedRiverBuilder;
}

function makeFloodplainClassifier(options) {
  cachedFloodplainClassifier = new FloodplainClassifier(options);
  log('floodplain classifier created');
  return cachedFloodplainClassifier;
}

function collectHydroTransferables(view) {
  const transferables = [];
  if (view.segments) transferables.push(view.segments.buffer);
  if (view.floodplainResult) {
    transferables.push(view.floodplainResult.vertexMask.buffer, view.floodplainResult.triangleMask.buffer, view.floodplainResult.seedVertices.buffer);
  }
  return transferables;
}

function deriveView(minRiverWeight, floodplainOptions) {
  if (!cachedTopology || !cachedRiverBuilder || !cachedRiverResult || !cachedFloodplainClassifier) {
    log('deriveView without cache', {
      hasTopology: !!cachedTopology,
      hasRiverBuilder: !!cachedRiverBuilder,
      hasRiverResult: !!cachedRiverResult,
      hasFloodplainClassifier: !!cachedFloodplainClassifier,
    });
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

  const view = {
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

  log('deriveView complete', {
    minRiverWeight,
    view: summarizeView(view),
    timings: view.timings,
  });

  return view;
}

log('module loaded', { href: typeof self.location !== 'undefined' ? self.location.href : null });

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
      self.postMessage({ id, ok: true, payload: { ok: true, worker: 'hydro' } });
      log('ping complete', { id, elapsedMs: performance.now() - startedAt });
      return;
    }

    if (type === 'buildGuide') {
      const topology = payload.topology;
      log('buildGuide begin', {
        id,
        topology: summarizeTopology(topology),
      });
      const riverBuilder = makeRiverBuilder(payload.riverOptions);
      const t0 = performance.now();
      const riverResult = riverBuilder.buildFromTopology(topology);
      const guidePoints = riverBuilder.buildGuidePoints(topology, riverResult, payload.guideOptions);
      const activeVertexCount = riverBuilder.collectActiveVertices(riverResult, payload.guideOptions.minWeight).length;
      log('buildGuide built', {
        id,
        river: summarizeRiverResult(riverResult),
        guidePointCount: guidePoints.length >> 1,
        activeVertexCount,
        buildGuideMs: performance.now() - t0,
      });
      self.postMessage({
        id,
        ok: true,
        payload: {
          guidePoints,
          activeVertexCount,
          timings: { buildGuideMs: performance.now() - t0 },
        },
      }, [guidePoints.buffer]);
      log('buildGuide complete', { id, elapsedMs: performance.now() - startedAt });
      return;
    }

    if (type === 'setTopologyAndDerive') {
      cachedTopology = payload.topology;
      log('setTopologyAndDerive begin', {
        id,
        topology: summarizeTopology(cachedTopology),
        minRiverWeight: payload.minRiverWeight,
      });
      cachedRiverBuilder = makeRiverBuilder(payload.riverOptions);
      cachedRiverResult = cachedRiverBuilder.buildFromTopology(cachedTopology);
      log('river result cached', {
        id,
        river: summarizeRiverResult(cachedRiverResult),
      });
      cachedFloodplainClassifier = makeFloodplainClassifier(payload.floodplainOptions);
      const view = deriveView(payload.minRiverWeight, payload.floodplainOptions);
      const transferables = collectHydroTransferables(view);
      self.postMessage({ id, ok: true, payload: view }, transferables);
      log('setTopologyAndDerive complete', {
        id,
        view: summarizeView(view),
        transferables: transferables.length,
        elapsedMs: performance.now() - startedAt,
      });
      return;
    }

    if (type === 'updateDerived') {
      log('updateDerived begin', {
        id,
        minRiverWeight: payload.minRiverWeight,
      });
      const view = deriveView(payload.minRiverWeight, payload.floodplainOptions);
      const transferables = collectHydroTransferables(view);
      self.postMessage({ id, ok: true, payload: view }, transferables);
      log('updateDerived complete', {
        id,
        view: summarizeView(view),
        transferables: transferables.length,
        elapsedMs: performance.now() - startedAt,
      });
      return;
    }

    throw new Error(`Unknown hydro worker message: ${type}`);
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
