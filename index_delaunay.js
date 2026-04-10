import BuildCoordinator from './BuildCoordinator.js';
import HeightfieldTINBuilder from './HeightfieldTINBuilder.ts';
import RiverNetworkBuilder from './RiverNetworkBuilder.ts';
import FloodplainClassifier from './FloodplainClassifier.ts';
import { loadImageElement } from './RasterUtils.js';

const DEFAULT_MIN_HEIGHT = 0;
const DEFAULT_MAX_HEIGHT = 1;
const DEFAULT_MIN_SPACING = 10;
const DEFAULT_MAX_SPACING = 96;
const DEFAULT_WETNESS_BINS = 21;
const DEFAULT_CHANNEL_THRESHOLD = 4096;
const DEFAULT_CANDIDATE_STRIDE = 1;
const DEFAULT_RELAX_ITERATIONS = 0;
const DEFAULT_MIN_RIVER_WEIGHT = 6;
const DEFAULT_EDGE_ALPHA = 0.8;
const DEFAULT_POINT_ALPHA = 0.8;
const DEFAULT_POINT_RADIUS = 1.3;
const DEFAULT_EXECUTION_MODE = 'single-thread';

const DEBUG_LOGGING = true;

function debugLog(...args) {
  if (!DEBUG_LOGGING) return;
  console.log('[TIN UI]', ...args);
}

function formatErrorForLog(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

let sourceFileName = '';
let sourceImage = null;
let sourceObjectUrl = '';
let cachedNormalizedRaster = null;
let cachedScaledRaster = null;
let cachedScaledMinHeight = NaN;
let cachedScaledMaxHeight = NaN;
let uploadedRasterKey = '';
let sourceRasterVersion = 0;
let topology = null;
let hydroView = null;
let floodplainResult = null;
let riverSegments = new Float32Array(0);
let guidePointCount = 0;
let passCount = 0;
let lastBuildMs = 0;
let lastPhaseTimings = null;
let currentFloodplainOptions = null;
let isBuilding = false;
let hydroUpdateToken = 0;
let singleThreadRiverBuilder = null;
let singleThreadRiverResult = null;
let singleThreadFloodplainClassifier = null;

function createBuildCoordinator() {
  return new BuildCoordinator({
    onstatus: (message) => updateStatus(message),
    debugLogging: DEBUG_LOGGING,
  });
}

let buildCoordinator = null;

function ensureBuildCoordinator() {
  if (!buildCoordinator) {
    buildCoordinator = createBuildCoordinator();
  }
  return buildCoordinator;
}

function getExecutionMode() {
  return executionLabel.input.value;
}

function isSingleThreadMode() {
  return getExecutionMode() === 'single-thread';
}

const root = document.createElement('div');
root.style.boxSizing = 'border-box';
root.style.padding = '16px';
root.style.fontFamily = 'system-ui, sans-serif';
root.style.color = '#e8e8e8';
root.style.background = '#111';
root.style.minHeight = '100vh';

const heading = document.createElement('h2');
heading.textContent = 'DEM Raster to Adaptive TIN';
heading.style.margin = '0 0 12px 0';
heading.style.fontWeight = '600';

const controls = document.createElement('div');
controls.style.display = 'flex';
controls.style.flexWrap = 'wrap';
controls.style.alignItems = 'center';
controls.style.gap = '8px';
controls.style.marginBottom = '14px';

const fileLabel = document.createElement('label');
fileLabel.textContent = 'DEM PNG';
fileLabel.style.display = 'inline-flex';
fileLabel.style.alignItems = 'center';
fileLabel.style.gap = '8px';

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.png,image/png';
fileInput.style.padding = '6px 8px';
fileInput.style.border = '1px solid #444';
fileInput.style.borderRadius = '6px';
fileInput.style.background = '#1a1a1a';
fileInput.style.color = '#e8e8e8';
fileLabel.appendChild(fileInput);

const minHeightLabel = makeNumberLabel('Min height', DEFAULT_MIN_HEIGHT, '88px');
const maxHeightLabel = makeNumberLabel('Max height', DEFAULT_MAX_HEIGHT, '88px');
const minSpacingLabel = makeNumberLabel('Min spacing', DEFAULT_MIN_SPACING, '88px', { min: 1, step: 1 });
const maxSpacingLabel = makeNumberLabel('Max spacing', DEFAULT_MAX_SPACING, '88px', { min: 1, step: 1 });
const wetnessBinsLabel = makeNumberLabel('Wetness bins', DEFAULT_WETNESS_BINS, '88px', { min: 4, step: 1 });
const channelThresholdLabel = makeNumberLabel('Channel threshold', DEFAULT_CHANNEL_THRESHOLD, '96px', { min: 1, step: 1 });
const candidateStrideLabel = makeNumberLabel('Candidate stride', DEFAULT_CANDIDATE_STRIDE, '96px', { min: 1, step: 1 });
const relaxIterationsLabel = makeNumberLabel('Relax iters', DEFAULT_RELAX_ITERATIONS, '88px', { min: 0, step: 1 });
const minRiverWeightLabel = makeNumberLabel('Min river weight', DEFAULT_MIN_RIVER_WEIGHT, '104px', { min: 0, step: 1 });

const modeLabel = document.createElement('label');
modeLabel.textContent = 'Mode';
modeLabel.style.display = 'inline-flex';
modeLabel.style.alignItems = 'center';
modeLabel.style.gap = '8px';

const modeSelect = document.createElement('select');
modeSelect.style.padding = '6px 8px';
modeSelect.style.border = '1px solid #444';
modeSelect.style.borderRadius = '6px';
modeSelect.style.background = '#1a1a1a';
modeSelect.style.color = '#e8e8e8';
for (const value of ['traditional', 'hydrographic', 'hydrological', 'hybrid']) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = value;
  if (value === 'hybrid') option.selected = true;
  modeSelect.appendChild(option);
}
modeLabel.appendChild(modeSelect);

const executionLabel = document.createElement('label');
executionLabel.textContent = 'Execution';
executionLabel.style.display = 'inline-flex';
executionLabel.style.alignItems = 'center';
executionLabel.style.gap = '8px';

const executionSelect = document.createElement('select');
executionSelect.style.padding = '6px 8px';
executionSelect.style.border = '1px solid #444';
executionSelect.style.borderRadius = '6px';
executionSelect.style.background = '#1a1a1a';
executionSelect.style.color = '#e8e8e8';
for (const value of ['single-thread', 'multithread']) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = value;
  if (value === DEFAULT_EXECUTION_MODE) option.selected = true;
  executionSelect.appendChild(option);
}
executionLabel.input = executionSelect;
executionLabel.appendChild(executionSelect);

const guideRiversLabel = makeCheckboxLabel('Guide rivers into TIN', true);
const showRasterLabel = makeCheckboxLabel('Show raster', true);
const showEdgesLabel = makeCheckboxLabel('Show edges', true);
const showPointsLabel = makeCheckboxLabel('Show points', false);
const showChannelsLabel = makeCheckboxLabel('Show channels', true);
const showFloodplainLabel = makeCheckboxLabel('Show floodplain', false);
const showImportanceLabel = makeCheckboxLabel('Show importance', false);

const buildButton = makeButton('Build topology');
buildButton.disabled = true;
const clearButton = makeButton('Clear');

const statusLine = document.createElement('div');
statusLine.style.marginLeft = '12px';
statusLine.style.opacity = '0.9';
statusLine.style.fontSize = '14px';

controls.append(
  fileLabel,
  minHeightLabel,
  maxHeightLabel,
  modeLabel,
  executionLabel,
  minSpacingLabel,
  maxSpacingLabel,
  wetnessBinsLabel,
  channelThresholdLabel,
  candidateStrideLabel,
  relaxIterationsLabel,
  minRiverWeightLabel,
  guideRiversLabel,
  showRasterLabel,
  showEdgesLabel,
  showPointsLabel,
  showChannelsLabel,
  showFloodplainLabel,
  showImportanceLabel,
  buildButton,
  clearButton,
  statusLine,
);

const layout = document.createElement('div');
layout.style.display = 'grid';
layout.style.gridTemplateColumns = 'minmax(300px, 1fr) minmax(300px, 380px)';
layout.style.gap = '16px';
layout.style.alignItems = 'start';

const viewerPanel = document.createElement('div');
viewerPanel.style.background = '#181818';
viewerPanel.style.border = '1px solid #2d2d2d';
viewerPanel.style.borderRadius = '12px';
viewerPanel.style.padding = '12px';
viewerPanel.style.boxSizing = 'border-box';
viewerPanel.style.minWidth = '0';

const viewerTitle = document.createElement('div');
viewerTitle.textContent = 'Topology overlay';
viewerTitle.style.fontSize = '15px';
viewerTitle.style.fontWeight = '600';
viewerTitle.style.marginBottom = '8px';

const canvasWrap = document.createElement('div');
canvasWrap.style.width = '100%';
canvasWrap.style.overflow = 'auto';
canvasWrap.style.border = '1px solid #333';
canvasWrap.style.borderRadius = '10px';
canvasWrap.style.background = '#0d0d0d';

const canvas = document.createElement('canvas');
canvas.width = 960;
canvas.height = 640;
canvas.style.display = 'block';
canvas.style.maxWidth = '100%';
canvas.style.height = 'auto';
canvas.style.background = '#0d0d0d';
canvasWrap.appendChild(canvas);
viewerPanel.append(viewerTitle, canvasWrap);

const sidePanel = document.createElement('div');
sidePanel.style.background = '#181818';
sidePanel.style.border = '1px solid #2d2d2d';
sidePanel.style.borderRadius = '12px';
sidePanel.style.padding = '12px';
sidePanel.style.boxSizing = 'border-box';

const statsTitle = document.createElement('div');
statsTitle.textContent = 'Stats';
statsTitle.style.fontSize = '15px';
statsTitle.style.fontWeight = '600';
statsTitle.style.marginBottom = '8px';

const statsBlock = document.createElement('div');
statsBlock.style.whiteSpace = 'pre-line';
statsBlock.style.fontSize = '13px';
statsBlock.style.opacity = '0.95';
statsBlock.style.lineHeight = '1.45';
statsBlock.textContent = 'Load a DEM PNG to begin.';

sidePanel.append(statsTitle, statsBlock);
layout.append(viewerPanel, sidePanel);
root.append(heading, controls, layout);

document.body.style.margin = '0';
document.body.style.background = '#111';
document.body.appendChild(root);

window.addEventListener('error', (event) => {
  debugLog('window error', {
    message: event.message || null,
    filename: event.filename || null,
    lineno: event.lineno || null,
    colno: event.colno || null,
    error: formatErrorForLog(event.error),
  });
});

window.addEventListener('unhandledrejection', (event) => {
  debugLog('unhandled rejection', {
    reason: formatErrorForLog(event.reason),
  });
});

window.addEventListener('beforeunload', () => {
  if (buildCoordinator) buildCoordinator.dispose();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  void loadSourceImage(file);
});

buildButton.addEventListener('click', () => {
  void buildTopology();
});

clearButton.addEventListener('click', clearAll);
showRasterLabel.input.addEventListener('change', drawScene);
showEdgesLabel.input.addEventListener('change', drawScene);
showPointsLabel.input.addEventListener('change', drawScene);
showChannelsLabel.input.addEventListener('change', drawScene);
showFloodplainLabel.input.addEventListener('change', drawScene);
showImportanceLabel.input.addEventListener('change', drawScene);
executionLabel.input.addEventListener('change', handleExecutionModeChange);
minRiverWeightLabel.input.addEventListener('input', updateHydroDerived);

updateStatus();
drawEmpty();

function makeButton(text) {
  const button = document.createElement('button');
  button.textContent = text;
  button.style.padding = '8px 12px';
  button.style.border = '1px solid #444';
  button.style.borderRadius = '8px';
  button.style.background = '#1f1f1f';
  button.style.color = '#f0f0f0';
  button.style.cursor = 'pointer';
  button.addEventListener('mouseenter', () => {
    button.style.background = '#2a2a2a';
  });
  button.addEventListener('mouseleave', () => {
    button.style.background = '#1f1f1f';
  });
  return button;
}

function makeNumberLabel(text, value, width = '80px', opts = {}) {
  const label = document.createElement('label');
  label.textContent = text;
  label.style.display = 'inline-flex';
  label.style.alignItems = 'center';
  label.style.gap = '8px';

  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(value);
  input.min = String(opts.min ?? -1000000000);
  input.max = String(opts.max ?? 1000000000);
  input.step = String(opts.step ?? 0.01);
  input.style.width = width;
  input.style.padding = '6px 8px';
  input.style.border = '1px solid #444';
  input.style.borderRadius = '6px';
  input.style.background = '#1a1a1a';
  input.style.color = '#e8e8e8';

  label.input = input;
  label.appendChild(input);
  return label;
}

function makeCheckboxLabel(text, checked) {
  const label = document.createElement('label');
  label.style.display = 'inline-flex';
  label.style.alignItems = 'center';
  label.style.gap = '6px';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;

  const span = document.createElement('span');
  span.textContent = text;

  label.input = input;
  label.append(input, span);
  return label;
}

function readNumber(label, fallback) {
  const value = Number(label.input.value);
  return Number.isFinite(value) ? value : fallback;
}

function defaultChannelThresholdForImage(width, height) {
  return Math.max(1024, Math.floor(width * height * 0.0025));
}

function defaultMaxSpacingForImage(width, height) {
  const edge = Math.max(width, height);
  return Math.max(24, Math.min(128, Math.round(edge / 14)));
}

function defaultCandidateStrideForImage(width, height) {
  return width >= 1024 || height >= 1024 ? 2 : 1;
}

async function loadSourceImage(file) {
  debugLog('loadSourceImage begin', { name: file?.name || null, size: file?.size || 0 });
  clearHydroOnly();
  uploadedRasterKey = '';
  sourceRasterVersion++;
  sourceFileName = file.name;

  if (sourceObjectUrl) {
    URL.revokeObjectURL(sourceObjectUrl);
    sourceObjectUrl = '';
  }

  sourceObjectUrl = URL.createObjectURL(file);

  try {
    const image = await loadImageElement(sourceObjectUrl);
    sourceImage = image;
    cachedNormalizedRaster = await buildNormalizedRasterFromImage(image);

    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;

    maxSpacingLabel.input.value = String(defaultMaxSpacingForImage(canvas.width, canvas.height));
    channelThresholdLabel.input.value = String(defaultChannelThresholdForImage(canvas.width, canvas.height));
    candidateStrideLabel.input.value = String(defaultCandidateStrideForImage(canvas.width, canvas.height));

    buildButton.disabled = false;
    debugLog('loadSourceImage complete', { width: canvas.width, height: canvas.height, file: sourceFileName });
    updateStatus('PNG loaded');
    updateStats();
    drawScene();
  } catch (error) {
    debugLog('loadSourceImage error', formatErrorForLog(error));
    clearAll();
    updateStatus(error instanceof Error ? error.message : String(error));
  }
}

async function buildNormalizedRasterFromImage(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvasEl = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvasEl.getContext('2d');
  if (!ctx) throw new Error('Failed to acquire raster cache canvas context.');
  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const rgba = imageData.data;
  const values = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);

  for (let i = 0, j = 0; i < values.length; i++, j += 4) {
    values[i] = (rgba[j] + rgba[j + 1] + rgba[j + 2]) / (3 * 255);
    mask[i] = rgba[j + 3] === 0 ? 0 : 1;
  }

  cachedScaledRaster = null;
  cachedScaledMinHeight = NaN;
  cachedScaledMaxHeight = NaN;
  return { width, height, values, mask };
}

function getScaledRaster(minHeight, maxHeight) {
  if (!cachedNormalizedRaster) {
    throw new Error('No cached raster is loaded.');
  }

  if (
    cachedScaledRaster &&
    cachedScaledMinHeight === minHeight &&
    cachedScaledMaxHeight === maxHeight
  ) {
    return cachedScaledRaster;
  }

  const srcValues = cachedNormalizedRaster.values;
  const values = new Float32Array(srcValues.length);
  const range = maxHeight - minHeight;
  for (let i = 0; i < srcValues.length; i++) {
    values[i] = minHeight + srcValues[i] * range;
  }

  cachedScaledRaster = {
    width: cachedNormalizedRaster.width,
    height: cachedNormalizedRaster.height,
    values,
    mask: new Uint8Array(cachedNormalizedRaster.mask),
  };
  cachedScaledMinHeight = minHeight;
  cachedScaledMaxHeight = maxHeight;
  return cachedScaledRaster;
}

function getTopologyBuildOptions(minSpacing, maxSpacing, wetnessBins, channelThreshold, candidateStride, relaxIterations) {
  return {
    mode: modeSelect.value,
    cellSize: 1,
    minSpacing,
    maxSpacing,
    borderSpacing: maxSpacing,
    wetnessBins,
    channelThreshold,
    candidateStride,
    relaxIterations,
    preserveBorder: true,
    preserveChannels: false,
    preserveMaskBoundary: true,
    preserveInnerBorder: true,
  };
}

function getRiverOptions(minHeight, maxHeight) {
  return {
    maxNeighborDistance: Number.POSITIVE_INFINITY,
    boundaryEpsilon: 0.5,
    minDrop: 1e-5,
    flatTolerance: 1e-4,
    sinkMaxRise: (maxHeight - minHeight) * 0.015,
    sinkClimbPenalty: 2.5,
  };
}

function getGuideOptions(minRiverWeight, minSpacing, maxSpacing) {
  return {
    minWeight: Math.max(1, minRiverWeight * 0.5),
    step: Math.max(minSpacing * 1.75, Math.min(maxSpacing * 0.6, minSpacing * 5)),
    maxPoints: Math.max(384, Math.min(16000, Math.floor((canvas.width * canvas.height) * 0.45))),
  };
}

function getFloodplainOptions(minHeight, maxHeight, minSpacing, maxSpacing) {
  return {
    maxRise: Math.max(0.03, (maxHeight - minHeight) * 0.05),
    maxClimbStep: Math.max(0.01, (maxHeight - minHeight) * 0.015),
    maxEdgeSlope: 0.75,
    maxWorldDistance: Math.max(minSpacing * 6, maxSpacing * 1.5),
    minTriangleFloodplainVerts: 2,
  };
}

async function buildTopology() {
  if (!sourceImage || isBuilding) return;
  debugLog('buildTopology begin', { file: sourceFileName || null, execution: getExecutionMode() });
  isBuilding = true;
  buildButton.disabled = true;

  try {
    const minHeight = readNumber(minHeightLabel, DEFAULT_MIN_HEIGHT);
    let maxHeight = readNumber(maxHeightLabel, DEFAULT_MAX_HEIGHT);
    const minSpacing = Math.max(1, Math.floor(readNumber(minSpacingLabel, DEFAULT_MIN_SPACING)));
    let maxSpacing = Math.max(1, Math.floor(readNumber(maxSpacingLabel, DEFAULT_MAX_SPACING)));
    const wetnessBins = Math.max(4, Math.floor(readNumber(wetnessBinsLabel, DEFAULT_WETNESS_BINS)));
    const channelThreshold = Math.max(1, Math.floor(readNumber(channelThresholdLabel, DEFAULT_CHANNEL_THRESHOLD)));
    const candidateStride = Math.max(1, Math.floor(readNumber(candidateStrideLabel, DEFAULT_CANDIDATE_STRIDE)));
    const relaxIterations = Math.max(0, Math.floor(readNumber(relaxIterationsLabel, DEFAULT_RELAX_ITERATIONS)));
    const minRiverWeight = Math.max(0, readNumber(minRiverWeightLabel, DEFAULT_MIN_RIVER_WEIGHT));

    if (maxHeight === minHeight) {
      maxHeight = minHeight + 1;
      maxHeightLabel.input.value = String(maxHeight);
    }

    if (maxSpacing < minSpacing) {
      maxSpacing = minSpacing;
      maxSpacingLabel.input.value = String(maxSpacing);
    }

    updateStatus('Building…');

    if (!cachedNormalizedRaster) {
      throw new Error('No cached raster is loaded.');
    }

    const topologyBuildOptions = getTopologyBuildOptions(
      minSpacing,
      maxSpacing,
      wetnessBins,
      channelThreshold,
      candidateStride,
      relaxIterations,
    );
    const riverOptions = getRiverOptions(minHeight, maxHeight);
    const guideOptions = getGuideOptions(minRiverWeight, minSpacing, maxSpacing);
    const floodplainOptions = getFloodplainOptions(minHeight, maxHeight, minSpacing, maxSpacing);
    const scaledRaster = getScaledRaster(minHeight, maxHeight);

    currentFloodplainOptions = floodplainOptions;

    debugLog('buildTopology options', {
      execution: getExecutionMode(),
      minHeight,
      maxHeight,
      minSpacing,
      maxSpacing,
      wetnessBins,
      channelThreshold,
      candidateStride,
      relaxIterations,
      minRiverWeight,
      guideEnabled: guideRiversLabel.input.checked,
      mode: modeSelect.value,
      rasterWidth: scaledRaster.width,
      rasterHeight: scaledRaster.height,
    });

    if (isSingleThreadMode()) {
      console.log('[TIN UI] execution path', 'single-thread');
      await buildTopologySingleThread({
        scaledRaster,
        topologyBuildOptions,
        riverOptions,
        guideOptions,
        floodplainOptions,
        minRiverWeight,
      });
    } else {
      console.log('[TIN UI] execution path', 'multithread');
      await buildTopologyMultithread({
        scaledRaster,
        minHeight,
        maxHeight,
        topologyBuildOptions,
        riverOptions,
        guideOptions,
        floodplainOptions,
        minRiverWeight,
      });
    }

    updateStatus('Done');
    updateStats();
    drawScene();
  } catch (error) {
    debugLog('buildTopology error', formatErrorForLog(error));
    topology = null;
    hydroView = null;
    floodplainResult = null;
    riverSegments = new Float32Array(0);
    guidePointCount = 0;
    passCount = 0;
    lastBuildMs = 0;
    lastPhaseTimings = null;
    currentFloodplainOptions = null;
    singleThreadRiverBuilder = null;
    singleThreadRiverResult = null;
    singleThreadFloodplainClassifier = null;
    updateStatus(error instanceof Error ? error.message : String(error));
    updateStats();
    drawScene();
  } finally {
    isBuilding = false;
    buildButton.disabled = !sourceImage;
    debugLog('buildTopology finally', { buildButtonDisabled: buildButton.disabled, hasSourceImage: !!sourceImage });
  }
}

async function buildTopologyMultithread({
  scaledRaster,
  minHeight,
  maxHeight,
  topologyBuildOptions,
  riverOptions,
  guideOptions,
  floodplainOptions,
  minRiverWeight,
}) {
  singleThreadRiverBuilder = null;
  singleThreadRiverResult = null;
  singleThreadFloodplainClassifier = null;

  const rasterUploadKey = `${sourceRasterVersion}:${scaledRaster.width}x${scaledRaster.height}:${minHeight}:${maxHeight}`;
  const coordinator = ensureBuildCoordinator();
  console.log('[TIN UI] multithread coordinator ready', !!coordinator);
  const t0 = performance.now();

  if (uploadedRasterKey !== rasterUploadKey) {
    console.log('[TIN UI] calling buildCoordinator.setRaster');
    debugLog('calling buildCoordinator.setRaster');
    await coordinator.setRaster(scaledRaster);
    uploadedRasterKey = rasterUploadKey;
    if (cachedScaledRaster === scaledRaster) {
      cachedScaledRaster = null;
      cachedScaledMinHeight = NaN;
      cachedScaledMaxHeight = NaN;
    }
    debugLog('buildCoordinator.setRaster complete');
  }

  console.log('[TIN UI] calling buildCoordinator.build');
  debugLog('calling buildCoordinator.build');
  const result = await coordinator.build({
    topologyBuildOptions,
    riverOptions,
    guideOptions,
    floodplainOptions,
    minRiverWeight,
    guideEnabled: guideRiversLabel.input.checked,
  });

  topology = result.topology;
  hydroView = result.hydroView;
  floodplainResult = result.hydroView.floodplainResult;
  riverSegments = result.hydroView.segments;
  guidePointCount = result.guidePointCount;
  passCount = result.passCount;
  lastPhaseTimings = result.phaseTimings;
  lastBuildMs = performance.now() - t0;

  debugLog('buildTopology multithread complete', {
    vertices: topology ? topology.positionsGrid.length >> 1 : 0,
    triangles: topology ? Math.floor(topology.indices.length / 3) : 0,
    passCount,
    guidePointCount,
    lastBuildMs,
    phaseTimings: lastPhaseTimings,
  });
}

async function buildTopologySingleThread({
  scaledRaster,
  topologyBuildOptions,
  riverOptions,
  guideOptions,
  floodplainOptions,
  minRiverWeight,
}) {
  uploadedRasterKey = '';
  const t0 = performance.now();
  const firstBuilder = new HeightfieldTINBuilder(topologyBuildOptions);
  firstBuilder.setRaster(scaledRaster);

  const buildStart = performance.now();
  const firstTopology = await firstBuilder.build();
  const firstTopologyMs = performance.now() - buildStart;

  singleThreadRiverBuilder = new RiverNetworkBuilder(riverOptions);

  const guideStart = performance.now();
  const firstRiver = singleThreadRiverBuilder.buildFromTopology(firstTopology);
  const guidePoints = guideRiversLabel.input.checked
    ? singleThreadRiverBuilder.buildGuidePoints(firstTopology, firstRiver, guideOptions)
    : new Float32Array(0);
  const firstGuideMs = performance.now() - guideStart;

  guidePointCount = guidePoints.length >> 1;
  const shouldRunSecondPass =
    guideRiversLabel.input.checked &&
    guidePointCount >= Math.max(128, Math.floor(firstTopology.heights.length * 0.05));

  let finalTopology = firstTopology;
  let secondTopologyMs = 0;
  passCount = shouldRunSecondPass ? 2 : 1;

  if (shouldRunSecondPass) {
    const secondStart = performance.now();
    finalTopology = await firstBuilder.buildWithForcedWorldPoints(guidePoints);
    secondTopologyMs = performance.now() - secondStart;
  }

  topology = finalTopology;
  singleThreadRiverResult = singleThreadRiverBuilder.buildFromTopology(topology);
  singleThreadFloodplainClassifier = new FloodplainClassifier(floodplainOptions);

  const deriveStart = performance.now();
  applySingleThreadDerived(minRiverWeight);
  const finalHydroMs = performance.now() - deriveStart;

  lastPhaseTimings = {
    firstTopologyMs,
    firstGuideMs,
    secondTopologyMs,
    finalHydroMs,
  };
  lastBuildMs = performance.now() - t0;

  debugLog('buildTopology single-thread complete', {
    vertices: topology ? topology.positionsGrid.length >> 1 : 0,
    triangles: topology ? Math.floor(topology.indices.length / 3) : 0,
    passCount,
    guidePointCount,
    lastBuildMs,
    phaseTimings: lastPhaseTimings,
  });
}

function applySingleThreadDerived(minRiverWeight) {
  if (!topology || !singleThreadRiverBuilder || !singleThreadRiverResult || !singleThreadFloodplainClassifier) {
    riverSegments = new Float32Array(0);
    floodplainResult = null;
    hydroView = null;
    return;
  }

  const activeMask = singleThreadRiverBuilder.collectActiveEdgeMask(singleThreadRiverResult, minRiverWeight);
  riverSegments = singleThreadRiverBuilder.buildSegmentsFromMask(topology, singleThreadRiverResult, activeMask);
  const seedVertices = singleThreadRiverBuilder.collectActiveVerticesFromMask(singleThreadRiverResult, activeMask);
  floodplainResult = singleThreadFloodplainClassifier.classify(topology, seedVertices);
  hydroView = {
    segments: riverSegments,
    activeVertexCount: seedVertices.length,
    activeEdgeCount: riverSegments.length >> 2,
    riverStats: {
      totalEdgeCount: singleThreadRiverResult.edges.length,
      minWeight: singleThreadRiverResult.minWeight,
      maxWeight: singleThreadRiverResult.maxWeight,
    },
    floodplainResult,
    timings: { deriveMs: 0 },
  };
}

async function updateHydroDerived() {
  if (isSingleThreadMode()) {
    if (!topology || !currentFloodplainOptions || isBuilding) {
      debugLog('updateHydroDerived skipped', {
        execution: 'single-thread',
        hasTopology: !!topology,
        hasFloodplainOptions: !!currentFloodplainOptions,
        isBuilding,
      });
      riverSegments = new Float32Array(0);
      floodplainResult = null;
      hydroView = null;
      updateStats();
      drawScene();
      return;
    }

    const minRiverWeight = Math.max(0, readNumber(minRiverWeightLabel, DEFAULT_MIN_RIVER_WEIGHT));
    applySingleThreadDerived(minRiverWeight);
    updateStats();
    drawScene();
    return;
  }

  if (!topology || !hydroView || !currentFloodplainOptions || isBuilding) {
    debugLog('updateHydroDerived skipped', {
      execution: 'multithread',
      hasTopology: !!topology,
      hasHydroView: !!hydroView,
      hasFloodplainOptions: !!currentFloodplainOptions,
      isBuilding,
    });
    riverSegments = new Float32Array(0);
    floodplainResult = null;
    updateStats();
    drawScene();
    return;
  }

  const requestToken = ++hydroUpdateToken;

  try {
    const minRiverWeight = Math.max(0, readNumber(minRiverWeightLabel, DEFAULT_MIN_RIVER_WEIGHT));
    debugLog('updateHydroDerived begin', { requestToken, minRiverWeight });
    const nextHydroView = await ensureBuildCoordinator().updateHydroOnly({
      minRiverWeight,
      floodplainOptions: currentFloodplainOptions,
    });

    if (requestToken !== hydroUpdateToken) return;

    hydroView = nextHydroView;
    riverSegments = nextHydroView.segments;
    floodplainResult = nextHydroView.floodplainResult;
    debugLog('updateHydroDerived complete', {
      requestToken,
      activeVertexCount: nextHydroView.activeVertexCount || 0,
      activeEdgeCount: nextHydroView.activeEdgeCount || 0,
      segmentCount: nextHydroView.segments ? nextHydroView.segments.length >> 2 : 0,
    });
    updateStats();
    drawScene();
  } catch (error) {
    if (requestToken !== hydroUpdateToken) return;
    debugLog('updateHydroDerived error', formatErrorForLog(error));
    updateStatus(error instanceof Error ? error.message : String(error));
  }
}

function clearHydroOnly() {
  hydroUpdateToken++;
  topology = null;
  hydroView = null;
  floodplainResult = null;
  riverSegments = new Float32Array(0);
  guidePointCount = 0;
  passCount = 0;
  lastBuildMs = 0;
  lastPhaseTimings = null;
  currentFloodplainOptions = null;
  singleThreadRiverBuilder = null;
  singleThreadRiverResult = null;
  singleThreadFloodplainClassifier = null;
}

function handleExecutionModeChange() {
  debugLog('execution mode changed', { execution: getExecutionMode() });
  clearHydroOnly();
  uploadedRasterKey = '';
  if (buildCoordinator) {
    buildCoordinator.dispose();
    buildCoordinator = null;
  }
  updateStatus('Execution mode changed');
  updateStats();
  drawScene();
}

function clearAll() {
  debugLog('clearAll');
  clearHydroOnly();

  if (buildCoordinator) {
    buildCoordinator.dispose();
    buildCoordinator = null;
  }

  if (sourceObjectUrl) {
    URL.revokeObjectURL(sourceObjectUrl);
    sourceObjectUrl = '';
  }

  sourceImage = null;
  cachedNormalizedRaster = null;
  cachedScaledRaster = null;
  uploadedRasterKey = '';
  sourceRasterVersion++;
  cachedScaledMinHeight = NaN;
  cachedScaledMaxHeight = NaN;
  sourceFileName = '';
  fileInput.value = '';
  buildButton.disabled = true;
  canvas.width = 960;
  canvas.height = 640;

  updateStatus();
  updateStats();
  drawEmpty();
}

function drawEmpty() {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillText('Load a DEM PNG to view the adaptive topology.', 24, 36);
}

function drawScene() {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!sourceImage) {
    drawEmpty();
    return;
  }

  if (showRasterLabel.input.checked) {
    ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (!topology) return;

  if (showImportanceLabel.input.checked) {
    drawImportanceOverlay(ctx, topology.analysis.importance, topology.analysis.mask);
  }

  if (showFloodplainLabel.input.checked && floodplainResult) {
    drawFloodplainTriangles(ctx, topology, floodplainResult.triangleMask);
  }

  if (showEdgesLabel.input.checked) {
    drawEdges(ctx, topology.positionsGrid, topology.indices);
  }

  if (showChannelsLabel.input.checked && riverSegments.length > 0) {
    drawRiverSegments(ctx, riverSegments);
  }

  if (showPointsLabel.input.checked) {
    drawPoints(ctx, topology.positionsGrid);
  }
}

function drawImportanceOverlay(ctx, values, mask) {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rgba = imageData.data;

  for (let i = 0; i < values.length; i++) {
    if (mask && !mask[i]) continue;

    const v = Math.max(0, Math.min(1, values[i]));
    const r = Math.round(255 * v);
    const g = Math.round(180 * (1 - v));
    const b = Math.round(255 * (1 - v));
    const a = Math.round(90 * (0.2 + 0.8 * v));

    blendPixelInto(rgba, i * 4, r, g, b, a);
  }

  ctx.putImageData(imageData, 0, 0);
}

function drawFloodplainTriangles(ctx, topology, triangleMask) {
  const indices = topology.indices;
  const positions = topology.positionsGrid;
  ctx.fillStyle = 'rgba(255, 180, 80, 0.18)';

  for (let t = 0; t < triangleMask.length; t++) {
    if (!triangleMask[t]) continue;
    const i = t * 3;
    const a = indices[i] * 2;
    const b = indices[i + 1] * 2;
    const c = indices[i + 2] * 2;

    ctx.beginPath();
    ctx.moveTo(positions[a], positions[a + 1]);
    ctx.lineTo(positions[b], positions[b + 1]);
    ctx.lineTo(positions[c], positions[c + 1]);
    ctx.closePath();
    ctx.fill();
  }
}

function drawRiverSegments(ctx, segments) {
  ctx.strokeStyle = 'rgba(120, 240, 255, 0.95)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  for (let i = 0; i < segments.length; i += 4) {
    ctx.moveTo(segments[i], segments[i + 1]);
    ctx.lineTo(segments[i + 2], segments[i + 3]);
  }

  ctx.stroke();
}

function drawEdges(ctx, positionsGrid, indices) {
  const seen = new Set();
  ctx.strokeStyle = `rgba(121, 192, 255, ${DEFAULT_EDGE_ALPHA})`;
  ctx.lineWidth = 1;

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    drawEdgeOnce(ctx, positionsGrid, seen, a, b);
    drawEdgeOnce(ctx, positionsGrid, seen, b, c);
    drawEdgeOnce(ctx, positionsGrid, seen, c, a);
  }
}

function drawEdgeOnce(ctx, positionsGrid, seen, ia, ib) {
  if (ia === ib || ia < 0 || ib < 0) return;

  const a = ia < ib ? ia : ib;
  const b = ia < ib ? ib : ia;
  const key = `${a}:${b}`;
  if (seen.has(key)) return;
  seen.add(key);

  const a2 = a * 2;
  const b2 = b * 2;

  ctx.beginPath();
  ctx.moveTo(positionsGrid[a2], positionsGrid[a2 + 1]);
  ctx.lineTo(positionsGrid[b2], positionsGrid[b2 + 1]);
  ctx.stroke();
}

function drawPoints(ctx, positionsGrid) {
  ctx.fillStyle = `rgba(255, 255, 255, ${DEFAULT_POINT_ALPHA})`;

  for (let i = 0; i < positionsGrid.length; i += 2) {
    ctx.beginPath();
    ctx.arc(positionsGrid[i], positionsGrid[i + 1], DEFAULT_POINT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }
}

function blendPixelInto(rgba, offset, r, g, b, a) {
  const srcA = Math.max(0, Math.min(255, a)) / 255;
  if (srcA <= 0) return;

  const invA = 1 - srcA;
  rgba[offset] = Math.round(r * srcA + rgba[offset] * invA);
  rgba[offset + 1] = Math.round(g * srcA + rgba[offset + 1] * invA);
  rgba[offset + 2] = Math.round(b * srcA + rgba[offset + 2] * invA);
  rgba[offset + 3] = 255;
}

function updateStatus(extra = '') {
  const parts = [];
  if (extra) parts.push(extra);
  parts.push(`execution: ${getExecutionMode()}`);
  parts.push(sourceImage ? `image: ${sourceFileName || 'loaded'}` : 'image: none');
  if (topology) {
    parts.push(`vertices: ${topology.positionsGrid.length / 2}`);
    parts.push(`triangles: ${topology.indices.length / 3}`);
  }
  statusLine.textContent = parts.join('  |  ');
  debugLog('status update', statusLine.textContent);
}

function updateStats() {
  if (!sourceImage) {
    statsBlock.textContent = 'Load a DEM PNG to begin.';
    return;
  }

  const width = sourceImage.naturalWidth || sourceImage.width;
  const height = sourceImage.naturalHeight || sourceImage.height;
  const minHeight = readNumber(minHeightLabel, DEFAULT_MIN_HEIGHT);
  const maxHeight = readNumber(maxHeightLabel, DEFAULT_MAX_HEIGHT);
  const lines = [
    `file: ${sourceFileName || '(loaded image)'}`,
    `image size: ${width} x ${height}`,
    `height range: ${minHeight} to ${maxHeight}`,
    `execution: ${getExecutionMode()}`,
    `mode: ${modeSelect.value}`,
    `min spacing: ${Math.max(1, Math.floor(readNumber(minSpacingLabel, DEFAULT_MIN_SPACING)))}`,
    `max spacing: ${Math.max(1, Math.floor(readNumber(maxSpacingLabel, DEFAULT_MAX_SPACING)))}`,
    `wetness bins: ${Math.max(4, Math.floor(readNumber(wetnessBinsLabel, DEFAULT_WETNESS_BINS)))}`,
    `channel threshold: ${Math.max(1, Math.floor(readNumber(channelThresholdLabel, DEFAULT_CHANNEL_THRESHOLD)))}`,
    `candidate stride: ${Math.max(1, Math.floor(readNumber(candidateStrideLabel, DEFAULT_CANDIDATE_STRIDE)))}`,
    `relax iterations: ${Math.max(0, Math.floor(readNumber(relaxIterationsLabel, DEFAULT_RELAX_ITERATIONS)))}`,
    `min river weight: ${Math.max(0, readNumber(minRiverWeightLabel, DEFAULT_MIN_RIVER_WEIGHT)).toFixed(2)}`,
    `guide rivers into TIN: ${guideRiversLabel.input.checked ? 'yes' : 'no'}`,
  ];

  if (topology && hydroView) {
    const analysis = topology.analysis;
    const statsSummary = topology.statsSummary || null;
    const validCellCount = statsSummary?.validCellCount ?? analysis.validCellCount ?? 0;
    const hillslopeLength = statsSummary?.hillslopeLength ?? analysis.hillslopeLength ?? 0;
    const vertexCount = topology.positionsGrid.length / 2;
    const triangleCount = topology.indices.length / 3;
    const reduction = validCellCount > 0 ? vertexCount / validCellCount : 0;
    const activeSegments = riverSegments.length / 4;
    const floodplainTriangles = floodplainResult ? countNonZero(floodplainResult.triangleMask) : 0;
    const riverStats = hydroView.riverStats || { totalEdgeCount: 0, minWeight: 0, maxWeight: 0 };

    lines.push(
      '',
      `build time: ${lastBuildMs.toFixed(3)} ms`,
      `passes: ${passCount}`,
      `guide points: ${guidePointCount}`,
      `valid raster cells: ${validCellCount}`,
      `vertices: ${vertexCount}`,
      `triangles: ${triangleCount}`,
      `vertex/cell ratio: ${reduction.toFixed(4)}`,
      `hillslope length: ${hillslopeLength.toFixed(3)}`,
      `river edges: ${riverStats.totalEdgeCount}`,
      `active river segments: ${activeSegments}`,
      `max river weight: ${riverStats.maxWeight.toFixed(2)}`,
      `floodplain triangles: ${floodplainTriangles}`,
      `wetness range: ${statsSummary ? formatRangeSummary(statsSummary.wetnessRange) : formatMinMax(analysis.wetness, analysis.mask)}`,
      `importance range: ${statsSummary ? formatRangeSummary(statsSummary.importanceRange) : formatMinMax(analysis.importance, analysis.mask)}`,
      `spacing range: ${statsSummary ? formatRangeSummary(statsSummary.spacingRange) : formatMinMax(analysis.spacing, analysis.mask)}`,
      `triangle area range: ${statsSummary ? formatRangeSummary(statsSummary.triangleAreaRange) : formatMinMax(topology.triangleAreas)}`,
      `max vertex degree: ${statsSummary ? statsSummary.maxVertexDegree : maxVertexDegree(topology.vertexNeighborOffsets)}`,
    );

    if (lastPhaseTimings) {
      lines.push(
        `phase 1 topology: ${lastPhaseTimings.firstTopologyMs.toFixed(3)} ms`,
        `phase 1 guide: ${lastPhaseTimings.firstGuideMs.toFixed(3)} ms`,
        `phase 2 topology: ${lastPhaseTimings.secondTopologyMs.toFixed(3)} ms`,
        `final hydro: ${lastPhaseTimings.finalHydroMs.toFixed(3)} ms`,
      );
    }
  }

  statsBlock.textContent = lines.join('\n');
  updateStatus();
}

function countNonZero(values) {
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i]) count++;
  }
  return count;
}


function formatRangeSummary(range) {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
    return 'n/a';
  }
  return `${range.min.toFixed(4)} to ${range.max.toFixed(4)}`;
}

function formatMinMax(values, mask) {
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
    return 'n/a';
  }

  return `${min.toFixed(4)} to ${max.toFixed(4)}`;
}

function maxVertexDegree(offsets) {
  let max = 0;
  for (let i = 0; i + 1 < offsets.length; i++) {
    const degree = offsets[i + 1] - offsets[i];
    if (degree > max) max = degree;
  }
  return max;
}
