import topowrkr from './Topology.worker.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_READY_TIMEOUT_MS = 5000;
const DEFAULT_HEAVY_PHASE_TIMEOUT_MS = 120000;
const DEFAULT_HYDRO_UPDATE_TIMEOUT_MS = 30000;
const DEBUG_LOGGING_DEFAULT = true;

function nextIdFactory() {
  let nextId = 1;
  return () => nextId++;
}

function summarizeTopology(topology) {
  if (!topology) return null;
  return {
    vertices: topology.positionsGrid ? topology.positionsGrid.length >> 1 : 0,
    triangles: topology.indices ? Math.floor(topology.indices.length / 3) : 0,
    analysisWidth: topology.analysis?.width ?? 0,
    analysisHeight: topology.analysis?.height ?? 0,
  };
}

function summarizeHydroView(hydroView) {
  if (!hydroView) return null;
  return {
    activeVertexCount: hydroView.activeVertexCount ?? 0,
    activeEdgeCount: hydroView.activeEdgeCount ?? 0,
    segmentCount: hydroView.segments ? hydroView.segments.length >> 2 : 0,
    floodplainSeedCount: hydroView.floodplainResult?.seedVertices ? hydroView.floodplainResult.seedVertices.length : 0,
  };
}

function summarizePayload(type, payload) {
  if (!payload) return null;

  if (type === 'setRaster') {
    return {
      width: payload.width ?? 0,
      height: payload.height ?? 0,
      valueCount: payload.values ? payload.values.length : 0,
      maskCount: payload.mask ? payload.mask.length : 0,
    };
  }

  if (type === 'buildGuide') {
    return {
      hasBuildOptions: !!payload.buildOptions,
      hasRiverOptions: !!payload.riverOptions,
      hasGuideOptions: !!payload.guideOptions,
    };
  }

  if (type === 'buildFinal') {
    return {
      hasBuildOptions: !!payload.buildOptions,
      guidePointCount: payload.guidePoints ? payload.guidePoints.length >> 1 : 0,
      reuseCachedTopology: !!payload.reuseCachedTopology,
      minRiverWeight: payload.minRiverWeight ?? null,
    };
  }

  if (type === 'updateDerived') {
    return {
      minRiverWeight: payload.minRiverWeight ?? null,
    };
  }

  return null;
}

export default class BuildCoordinator {
  constructor(options = {}) {
    this.nextId = nextIdFactory();
    this.pending = new Map();
    this.requestTimeoutMs = Math.max(1000, Math.floor(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
    this.readyTimeoutMs = Math.max(1000, Math.floor(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS));
    this.heavyPhaseTimeoutMs = Math.max(this.requestTimeoutMs, Math.floor(options.heavyPhaseTimeoutMs ?? DEFAULT_HEAVY_PHASE_TIMEOUT_MS));
    this.hydroUpdateTimeoutMs = Math.max(this.requestTimeoutMs, Math.floor(options.hydroUpdateTimeoutMs ?? DEFAULT_HYDRO_UPDATE_TIMEOUT_MS));
    this.debugLogging = options.debugLogging ?? DEBUG_LOGGING_DEFAULT;
    this.onstatus = typeof options.onstatus === 'function' ? options.onstatus : null;
    this.topologyWorker = new Worker(topowrkr, { type: 'module', name: 'TopologyWorker' });
    this.#attachWorker(this.topologyWorker, 'Topology worker');
    this.#log('worker instance created', {
      topologyWorkerScript: String(topowrkr),
    });
    this.topologyReady = false;
    this.currentRaster = null;
    this.currentTopology = null;
    this.currentHydroView = null;
    this.#log('constructed', {
      requestTimeoutMs: this.requestTimeoutMs,
      readyTimeoutMs: this.readyTimeoutMs,
      heavyPhaseTimeoutMs: this.heavyPhaseTimeoutMs,
      hydroUpdateTimeoutMs: this.hydroUpdateTimeoutMs,
    });
  }

  dispose() {
    this.#log('dispose');
    this.#rejectAllPending(new Error('Build coordinator disposed.'));
    this.topologyWorker.terminate();
    this.currentRaster = null;
    this.currentTopology = null;
    this.currentHydroView = null;
    this.topologyReady = false;
  }

  async #ensureReady() {
    if (!this.topologyReady) {
      this.#status('Starting topology worker…');
      await this.#call(this.topologyWorker, 'ping', null, [], this.readyTimeoutMs);
      this.topologyReady = true;
      this.#log('topology worker ready');
    }
  }

  async setRaster(raster) {
    await this.#ensureReady();

    this.currentRaster = {
      width: raster.width,
      height: raster.height,
    };

    const payload = {
      width: raster.width,
      height: raster.height,
      values: raster.values,
      mask: raster.mask,
    };

    this.#log('setRaster begin', summarizePayload('setRaster', payload));
    this.#status('Uploading raster…');
    await this.#call(
      this.topologyWorker,
      'setRaster',
      payload,
      [payload.values.buffer, payload.mask.buffer],
    );
    this.#log('setRaster complete', { width: raster.width, height: raster.height });
  }

  async build(params) {
    if (!this.currentRaster) throw new Error('No raster has been set.');

    this.#log('build begin', {
      raster: {
        width: this.currentRaster.width,
        height: this.currentRaster.height,
      },
      guideEnabled: !!params.guideEnabled,
      minRiverWeight: params.minRiverWeight,
    });

    let guidePointCount = 0;
    let passCount = 1;
    let firstGuideActiveVertices = 0;
    const phaseTimings = {
      firstTopologyMs: 0,
      firstGuideMs: 0,
      secondTopologyMs: 0,
      finalHydroMs: 0,
    };

    if (!params.guideEnabled) {
      this.#status('Building topology…');
      const final = await this.#call(
        this.topologyWorker,
        'buildFinal',
        {
          buildOptions: params.topologyBuildOptions,
          guidePoints: null,
          reuseCachedTopology: false,
          riverOptions: params.riverOptions,
          floodplainOptions: params.floodplainOptions,
          minRiverWeight: params.minRiverWeight,
        },
        [],
        this.heavyPhaseTimeoutMs,
      );

      phaseTimings.firstTopologyMs = final.timings?.buildMs ?? 0;
      phaseTimings.finalHydroMs = final.timings?.deriveMs ?? 0;
      this.currentTopology = final.topology;
      this.currentHydroView = final.hydroView;
      this.#status('Build complete');
      this.#log('build complete', {
        topology: summarizeTopology(final.topology),
        hydroView: summarizeHydroView(final.hydroView),
        guidePointCount,
        passCount,
        phaseTimings,
      });

      return {
        topology: final.topology,
        hydroView: final.hydroView,
        guidePointCount,
        passCount,
        phaseTimings,
        buildMetrics: {
          firstGuideActiveVertices,
        },
      };
    }

    this.#status('Building topology pass 1…');
    const guide = await this.#call(
      this.topologyWorker,
      'buildGuide',
      {
        buildOptions: params.topologyBuildOptions,
        riverOptions: params.riverOptions,
        guideOptions: params.guideOptions,
      },
      [],
      this.heavyPhaseTimeoutMs,
    );
    this.#log('buildGuide complete', {
      firstVertexCount: guide.firstVertexCount || 0,
      firstTriangleCount: guide.firstTriangleCount || 0,
      activeVertexCount: guide.activeVertexCount || 0,
      guidePointCount: guide.guidePoints ? guide.guidePoints.length >> 1 : 0,
      timings: guide.timings,
    });

    guidePointCount = guide.guidePoints.length >> 1;
    firstGuideActiveVertices = guide.activeVertexCount || 0;
    phaseTimings.firstTopologyMs = guide.timings?.buildMs ?? 0;
    phaseTimings.firstGuideMs = guide.timings?.buildGuideMs ?? 0;

    const shouldRunSecondPass =
      guidePointCount >= Math.max(128, Math.floor((guide.firstVertexCount || 0) * 0.015)) &&
      guidePointCount >= Math.max(64, Math.floor((guide.activeVertexCount || 0) * 0.2));

    passCount = shouldRunSecondPass ? 2 : 1;

    this.#log('second pass decision', {
      shouldRunSecondPass,
      guideEnabled: !!params.guideEnabled,
      guidePointCount,
      firstVertexCount: guide.firstVertexCount || 0,
      firstGuideActiveVertices,
    });

    this.#status(shouldRunSecondPass ? 'Building topology pass 2…' : 'Deriving hydro overlays…');
    const final = await this.#call(
      this.topologyWorker,
      'buildFinal',
      {
        buildOptions: params.topologyBuildOptions,
        guidePoints: shouldRunSecondPass ? guide.guidePoints : null,
        reuseCachedTopology: !shouldRunSecondPass,
        riverOptions: params.riverOptions,
        floodplainOptions: params.floodplainOptions,
        minRiverWeight: params.minRiverWeight,
      },
      shouldRunSecondPass ? [guide.guidePoints.buffer] : [],
      this.heavyPhaseTimeoutMs,
    );

    phaseTimings.secondTopologyMs = shouldRunSecondPass ? (final.timings?.buildMs ?? 0) : 0;
    phaseTimings.finalHydroMs = final.timings?.deriveMs ?? 0;
    this.currentTopology = final.topology;
    this.currentHydroView = final.hydroView;
    this.#status('Build complete');
    this.#log('build complete', {
      topology: summarizeTopology(final.topology),
      hydroView: summarizeHydroView(final.hydroView),
      guidePointCount,
      passCount,
      phaseTimings,
    });

    return {
      topology: final.topology,
      hydroView: final.hydroView,
      guidePointCount,
      passCount,
      phaseTimings,
      buildMetrics: {
        firstGuideActiveVertices,
      },
    };
  }

  async updateHydroOnly({ minRiverWeight, floodplainOptions }) {
    await this.#ensureReady();
    this.#status('Updating hydro overlays…');
    this.#log('updateHydroOnly begin', { minRiverWeight });
    const hydroView = await this.#call(
      this.topologyWorker,
      'updateDerived',
      { minRiverWeight, floodplainOptions },
      [],
      this.hydroUpdateTimeoutMs,
    );
    this.currentHydroView = hydroView;
    this.#status('Hydro updated');
    this.#log('updateHydroOnly complete', summarizeHydroView(hydroView));
    return hydroView;
  }

  #attachWorker(worker, label) {
    worker.onmessage = (event) => this.#handleMessage(event, label);
    worker.onerror = (event) => {
      const message = event?.message
        ? `${label}: ${event.message}`
        : `${label} failed to load or crashed.`;
      this.#log('worker error', {
        label,
        message,
        filename: event?.filename || null,
        lineno: event?.lineno || null,
        colno: event?.colno || null,
      });
      this.#rejectPendingForWorker(worker, new Error(message));
    };
    worker.onmessageerror = (event) => {
      this.#log('worker messageerror', { label, event });
      this.#rejectPendingForWorker(worker, new Error(`${label}: message serialization failed.`));
    };
  }

  #status(message) {
    this.#log('status', message);
    if (this.onstatus) this.onstatus(message);
  }

  #handleMessage(event, label = 'Worker') {
    const data = event.data || {};
    const { id, ok, payload, error } = data;
    if (!this.pending.has(id)) {
      this.#log('received response for unknown request', { label, id, ok, error, dataKeys: data ? Object.keys(data) : null });
      return;
    }
    const entry = this.pending.get(id);
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const elapsedMs = performance.now() - entry.startedAt;
    if (ok) {
      this.#log('response ok', {
        label,
        id,
        type: entry.type,
        elapsedMs,
        payloadSummary: this.#summarizeResponse(entry.type, payload),
      });
      entry.resolve(payload);
    } else {
      this.#log('response error', {
        label,
        id,
        type: entry.type,
        elapsedMs,
        error,
      });
      entry.reject(new Error(error || 'Worker request failed.'));
    }
  }

  #rejectPendingForWorker(worker, error) {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.worker !== worker) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      this.#log('reject pending for worker', { id, type: entry.type, error: error.message });
      entry.reject(error);
    }
  }

  #rejectAllPending(error) {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      this.#log('reject all pending', { id, type: entry.type, error: error.message });
      entry.reject(error);
    }
  }

  #call(worker, type, payload, transferables = [], timeoutMs = this.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      const startedAt = performance.now();
      const workerLabel = 'Topology worker';
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        const elapsedMs = performance.now() - startedAt;
        const error = new Error(`Timed out waiting for worker response: ${type}`);
        this.#log('request timeout', {
          worker: workerLabel,
          id,
          type,
          timeoutMs,
          elapsedMs,
          payloadSummary: summarizePayload(type, payload),
          hint: type === 'ping' ? 'Worker module may still be starting, blocked on import, or failed before onmessage was installed.' : null,
        });
        reject(error);
      }, timeoutMs);

      this.pending.set(id, { worker, resolve, reject, timer, type, startedAt });
      this.#log('send request', {
        worker: workerLabel,
        id,
        type,
        timeoutMs,
        transferables: transferables.length,
        payloadSummary: summarizePayload(type, payload),
      });

      try {
        worker.postMessage({ id, type, payload }, transferables);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.#log('postMessage failed', {
          worker: workerLabel,
          id,
          type,
          error: error instanceof Error ? error.stack || error.message : String(error),
        });
        reject(error);
      }
    });
  }

  #summarizeResponse(type, payload) {
    if (!payload) return null;

    if (type === 'ping' || type === 'setRaster') {
      return payload;
    }

    if (type === 'buildGuide') {
      return {
        firstVertexCount: payload.firstVertexCount || 0,
        firstTriangleCount: payload.firstTriangleCount || 0,
        activeVertexCount: payload.activeVertexCount || 0,
        guidePointCount: payload.guidePoints ? payload.guidePoints.length >> 1 : 0,
        timings: payload.timings ?? null,
      };
    }

    if (type === 'buildFinal') {
      return {
        topology: summarizeTopology(payload.topology),
        hydroView: summarizeHydroView(payload.hydroView),
        timings: payload.timings ?? null,
      };
    }

    if (type === 'updateDerived') {
      return {
        hydroView: summarizeHydroView(payload),
        timings: payload.timings ?? null,
      };
    }

    return null;
  }

  #log(...args) {
    if (!this.debugLogging) return;
    console.log('[BuildCoordinator]', ...args);
  }
}
