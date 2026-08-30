import MpqArchive from 'mdx-m3-viewer/dist/cjs/parsers/mpq/archive';
import TgaHandler from 'mdx-m3-viewer/dist/cjs/viewer/handlers/tga/handler';
import BaseWar3MapViewer from 'mdx-m3-viewer/dist/cjs/viewer/handlers/w3x/viewer';
import { DebugRenderMode } from 'mdx-m3-viewer/dist/cjs/viewer/viewer';
import { groundFragmentShader, groundVertexShader } from './ground-shaders';
import { buildTerrainTextureLayers } from './terrain-texture-layers';
import type {
  MapDocumentData,
  RegionData,
  RegionFileData,
  ScriptPoint,
  TerrainData
} from '../shared/model';

declare function acquireVsCodeApi<T = unknown>(): {
  postMessage(message: unknown): void;
  setState(state: T): void;
  getState(): T | undefined;
};

type Mode = 'select' | 'region' | 'point';
type Tab = 'regions' | 'points';
type CameraView = '3d' | 'top';
type Selection = { kind: 'region'; index: number } | { kind: 'point'; id: string };
interface EditorSnapshot {
  regionFile: RegionFileData;
  points: ScriptPoint[];
  selection: Selection | undefined;
}
type RegionHandle =
  | 'northWest'
  | 'north'
  | 'northEast'
  | 'east'
  | 'southEast'
  | 'south'
  | 'southWest'
  | 'west'
  | 'center';

interface DragState {
  type: 'pan' | 'rotate' | 'newRegion' | 'moveRegion' | 'resizeRegion' | 'movePoint';
  startScreen: { x: number; y: number };
  startWorld: { x: number; y: number };
  originalCenter?: { x: number; y: number };
  originalYaw?: number;
  originalElevation?: number;
  originalRegion?: Pick<RegionData, 'left' | 'bottom' | 'right' | 'top'>;
  regionHandle?: RegionHandle;
  regionIndex?: number;
  planeHeight?: number;
  historyBefore?: EditorSnapshot;
}

const CAMERA_FOV = 45;
const CAMERA_NEAR = 8;
const CAMERA_FAR = 300_000;
const REGION_OVERLAY_HEIGHT_OFFSET = 32;

type War3Viewer = InstanceType<typeof BaseWar3MapViewer>;
const RESOURCE_URL_PREFIX = 'war3-resource:';

const vscode = acquireVsCodeApi();
const app = requiredElement<HTMLElement>('app');
const viewport = requiredElement<HTMLElement>('viewport');
const threeHost = requiredElement<HTMLElement>('threeHost');
const overlay = requiredElement<HTMLCanvasElement>('overlay');
const overlayContext = requiredContext(overlay);
const loading = requiredElement<HTMLElement>('loading');
const itemList = requiredElement<HTMLElement>('itemList');
const regionPanelHeader = requiredElement<HTMLElement>('regionPanelHeader');
const pointPanelHeader = requiredElement<HTMLElement>('pointPanelHeader');
const currentRegionName = requiredElement<HTMLElement>('currentRegionName');
const currentPointName = requiredElement<HTMLElement>('currentPointName');
const regionToolButton = requiredElement<HTMLButtonElement>('regionToolButton');
const pointToolButton = requiredElement<HTMLButtonElement>('pointToolButton');
const inspectorForm = requiredElement<HTMLFormElement>('inspectorForm');
const editorFields = requiredElement<HTMLElement>('editorFields');
const emptyInspector = requiredElement<HTMLElement>('emptyInspector');
const regionFields = requiredElement<HTMLElement>('regionFields');
const pointFields = requiredElement<HTMLElement>('pointFields');
const nameInput = requiredElement<HTMLInputElement>('nameInput');
const leftInput = requiredElement<HTMLInputElement>('leftInput');
const rightInput = requiredElement<HTMLInputElement>('rightInput');
const bottomInput = requiredElement<HTMLInputElement>('bottomInput');
const topInput = requiredElement<HTMLInputElement>('topInput');
const xInput = requiredElement<HTMLInputElement>('xInput');
const yInput = requiredElement<HTMLInputElement>('yInput');
const deleteButton = requiredElement<HTMLButtonElement>('deleteButton');
const saveButton = requiredElement<HTMLButtonElement>('saveButton');
const exportLuaButton = requiredElement<HTMLButtonElement>('exportLuaButton');
const fitButton = requiredElement<HTMLButtonElement>('fitButton');
const statusText = requiredElement<HTMLElement>('statusText');
const coordinateText = requiredElement<HTMLElement>('coordinateText');
const regionCount = requiredElement<HTMLElement>('regionCount');
const pointCount = requiredElement<HTMLElement>('pointCount');
const pointListCount = requiredElement<HTMLElement>('pointListCount');

let documentData: MapDocumentData | undefined;
let regionFile: RegionFileData = { version: 5, regions: [] };
let points: ScriptPoint[] = [];
let mode: Mode = 'select';
let activeTab: Tab = 'regions';
let selection: Selection | undefined;
let drag: DragState | undefined;
let previewRegion: RegionData | undefined;
let war3Viewer: War3Viewer | undefined;
let renderCanvas: HTMLCanvasElement | undefined;
let resourceBroker: ResourceBroker | undefined;
let terrainData: TerrainData | undefined;
let terrainBounds: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
let viewCenter = { x: 0, y: 0 };
let viewTargetZ = 0;
let viewDistance = 2_600;
let cameraYaw = 0;
let cameraElevation = degrees(45);
let cameraView: CameraView = '3d';
let cameraInitialized = false;
let revision = 0;
let savedRevision = 0;
const HISTORY_LIMIT = 10;
let undoHistory: EditorSnapshot[] = [];
let redoHistory: EditorSnapshot[] = [];

const nativeFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  if (!url.startsWith(RESOURCE_URL_PREFIX)) {
    return nativeFetch(input, init);
  }
  const resourcePath = decodeURIComponent(url.slice(RESOURCE_URL_PREFIX.length));
  return resourceBroker?.fetch(resourcePath) ?? Promise.resolve(new Response(null, { status: 404 }));
};
let savingRevision: number | undefined;
let saveTimer: number | undefined;
let resizeObserver: ResizeObserver | undefined;

setupEvents();
vscode.postMessage({ type: 'ready' });

function setupEvents(): void {
  regionToolButton.addEventListener('click', toggleRegionTool);
  pointToolButton.addEventListener('click', togglePointTool);
  for (const button of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    button.addEventListener('click', () => setTab(button.dataset.tab as Tab));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('.view-button')) {
    button.addEventListener('click', () => setCameraView(button.dataset.view as CameraView));
  }

  fitButton.addEventListener('click', fitMap);
  saveButton.addEventListener('click', () => saveNow());
  exportLuaButton.addEventListener('click', () => {
    vscode.postMessage({ type: 'exportLua', points: structuredClone(points) });
    setStatus('正在生成点位 Lua...');
  });
  deleteButton.addEventListener('click', deleteSelection);
  inspectorForm.addEventListener('submit', (event) => event.preventDefault());
  nameInput.addEventListener('change', applyInspector);
  for (const input of [leftInput, rightInput, bottomInput, topInput, xInput, yInput]) {
    input.addEventListener('change', applyInspector);
  }

  overlay.tabIndex = 0;
  overlay.addEventListener('contextmenu', (event) => event.preventDefault());
  overlay.addEventListener('pointerdown', pointerDown);
  overlay.addEventListener('pointermove', pointerMove);
  overlay.addEventListener('pointerup', pointerUp);
  overlay.addEventListener('pointercancel', cancelDrag);
  overlay.addEventListener('wheel', wheel, { passive: false });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Delete') {
      deleteSelection();
    } else if (event.key === 'Escape') {
      cancelDrag();
      setMode('select');
    }
  });
  window.addEventListener('keydown', (event) => {
    const target = event.target;
    const editingText = target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && !editingText && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
      return;
    }
    if (modifier && !editingText && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (
      event.code !== 'Space' ||
      event.repeat ||
      editingText
    ) {
      return;
    }
    event.preventDefault();
    toggleRegionTool();
  });

  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as Record<string, unknown>;
    switch (message.type) {
      case 'load':
        void loadDocument(message.data as MapDocumentData);
        break;
      case 'resourceResult':
        resourceBroker?.resolve(
          Number(message.requestId),
          typeof message.base64 === 'string' ? message.base64 : undefined
        );
        break;
      case 'saved':
        handleSaved(Number(message.revision));
        break;
      case 'luaExported':
        setStatus(`点位 Lua 已生成：${String(message.output)}`);
        break;
      case 'error':
        savingRevision = undefined;
        saveButton.disabled = false;
        setStatus(String(message.message), true);
        break;
    }
  });
}

async function loadDocument(data: MapDocumentData): Promise<void> {
  documentData = data;
  regionFile = structuredClone(data.regionFile);
  points = structuredClone(data.points);
  revision = 0;
  savedRevision = 0;
  selection = undefined;
  undoHistory = [];
  redoHistory = [];
  loading.hidden = false;
  loading.textContent = '正在加载地形贴图和装饰物...';
  renderSidebar();
  renderInspector();
  const resourceNote = data.warcraftPath.length > 0 ? '魔兽目录已配置' : '未配置魔兽目录';
  setStatus(`${data.mapRoot} · ${data.terrain.width - 1}×${data.terrain.height - 1} · ${resourceNote} · 正在载入资源`);
  try {
    await createTerrain(data);
  } catch (error) {
    loading.textContent = '地形资源加载失败';
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function createTerrain(data: MapDocumentData): Promise<void> {
  const terrain = data.terrain;
  terrainData = terrain;
  threeHost.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Warcraft III 3D terrain');
  threeHost.appendChild(canvas);
  renderCanvas = canvas;
  resourceBroker = new ResourceBroker();

  const broker = resourceBroker;
  const viewer = new BaseWar3MapViewer(
    canvas,
    (source: unknown) => broker.toUrl(source),
    false
  );
  viewer.groundShader = viewer.webgl.createShader(groundVertexShader, groundFragmentShader);
  viewer.addHandler({
    ...TgaHandler,
    isValidSource(source: unknown): boolean {
      return TgaHandler.isValidSource(source) || hasLegacyTgaHeader(source);
    }
  });
  war3Viewer = viewer;
  viewer.audioEnabled = false;
  viewer.debugRenderMode = DebugRenderMode.Diffuse;
  viewer.on('error', (event: unknown) => console.warn(formatViewerError(event)));
  let renderPending = false;
  viewer.on('loadend', () => {
    if (renderPending || war3Viewer !== viewer) {
      return;
    }
    renderPending = true;
    window.requestAnimationFrame(() => {
      renderPending = false;
      if (war3Viewer === viewer) {
        updateCamera();
      }
    });
  });

  terrainBounds = {
    minX: terrain.offsetX,
    minY: terrain.offsetY,
    maxX: terrain.offsetX + (terrain.width - 1) * 128,
    maxY: terrain.offsetY + (terrain.height - 1) * 128
  };
  viewCenter = {
    x: (terrainBounds.minX + terrainBounds.maxX) / 2,
    y: (terrainBounds.minY + terrainBounds.maxY) / 2
  };
  viewTargetZ = terrainHeightAt(viewCenter.x, viewCenter.y);
  cameraInitialized = false;

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(viewport);
  resize();

  await once(viewer, 'loadedbasefiles');
  mergeDoodadData(viewer, data.doodadIni);
  viewer.loadMap(createMapArchive(data));
  resize();
  fitMap();
  await waitForTerrainReady(viewer);
  repairTerrainTextureLayers(viewer);
  updateCamera();
  if (war3Viewer === viewer) {
    loading.hidden = true;
    setStatus(
      `${data.mapRoot} · ${terrain.width - 1}×${terrain.height - 1} · ` +
      `3D 贴图地形 · 正在载入装饰物 ${data.doodadPlacementCount}`
    );
  }
  await viewer.whenAllLoaded();
  updateCamera();
  if (war3Viewer === viewer) {
    loading.hidden = true;
    setStatus(
      `${data.mapRoot} · ${terrain.width - 1}×${terrain.height - 1} · ` +
      `3D 贴图地形 · 装饰物摆放 ${data.doodadPlacementCount}`
    );
  }
}

function repairTerrainTextureLayers(viewer: War3Viewer): void {
  const map = viewer.map;
  if (map === null || map.textureBuffer === null || map.variationBuffer === null) {
    return;
  }

  const layers = buildTerrainTextureLayers(map);
  const gl = viewer.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, map.textureBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, layers.textures, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, map.variationBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, layers.variations, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}

function waitForTerrainReady(viewer: War3Viewer): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const check = () => {
      if (war3Viewer !== viewer || viewer.map?.terrainReady) {
        resolve();
      } else if (performance.now() - startedAt >= 30_000) {
        reject(new Error('地形贴图加载超时，请检查本地资源和魔兽目录。'));
      } else {
        window.setTimeout(check, 16);
      }
    };
    check();
  });
}

function formatViewerError(event: unknown): string {
  if (typeof event !== 'object' || event === null) {
    return `War3 renderer resource error: ${String(event)}`;
  }
  const value = event as Record<string, unknown>;
  const error = typeof value.error === 'string' ? value.error : 'Unknown renderer error';
  const resource = typeof value.fetchUrl === 'string' && value.fetchUrl.length > 0
    ? value.fetchUrl
    : typeof value.src === 'string'
      ? value.src
      : '';
  const reason = value.reason instanceof Error
    ? value.reason.message
    : typeof value.reason === 'string'
      ? value.reason
      : '';
  return [error, resource, reason].filter((part) => part.length > 0).join(' · ');
}

function resize(): void {
  const viewer = war3Viewer;
  const canvas = renderCanvas;
  if (viewer === undefined || canvas === undefined) {
    return;
  }
  const width = Math.max(1, viewport.clientWidth);
  const height = Math.max(1, viewport.clientHeight);
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  overlay.width = Math.round(width * pixelRatio);
  overlay.height = Math.round(height * pixelRatio);
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
  overlayContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  const scene = viewer.map?.worldScene;
  if (scene !== undefined) {
    scene.viewport[0] = 0;
    scene.viewport[1] = 0;
    scene.viewport[2] = canvas.width;
    scene.viewport[3] = canvas.height;
    scene.camera.perspective(degrees(CAMERA_FOV), canvas.width / canvas.height, CAMERA_NEAR, CAMERA_FAR);
  }
  updateCamera();
}

function updateCamera(): void {
  const viewer = war3Viewer;
  const scene = viewer?.map?.worldScene;
  if (viewer === undefined || scene === undefined) {
    return;
  }
  const horizontalDistance = Math.cos(cameraElevation) * viewDistance;
  const location = new Float32Array([
    viewCenter.x + Math.sin(cameraYaw) * horizontalDistance,
    viewCenter.y - Math.cos(cameraYaw) * horizontalDistance,
    viewTargetZ + Math.sin(cameraElevation) * viewDistance
  ]);
  scene.camera.moveToAndFace(
    location,
    new Float32Array([viewCenter.x, viewCenter.y, viewTargetZ]),
    new Float32Array([0, 0, 1])
  );
  scene.camera.update();
  viewer.updateAndRender(0);
  renderOverlay();
}

function fitMap(): void {
  if (terrainBounds === undefined) {
    return;
  }
  viewCenter.x = (terrainBounds.minX + terrainBounds.maxX) / 2;
  viewCenter.y = (terrainBounds.minY + terrainBounds.maxY) / 2;
  if (!cameraInitialized) {
    viewDistance = cameraView === 'top' ? 12_000 : 2_600;
    cameraInitialized = true;
  }
  viewTargetZ = terrainHeightAt(viewCenter.x, viewCenter.y);
  updateCamera();
}

function renderOverlay(): void {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  overlayContext.clearRect(0, 0, width, height);

  for (const region of regionFile.regions) {
    drawRegion(region, selection?.kind === 'region' && selection.index === region.index, false);
  }
  if (previewRegion !== undefined) {
    drawRegion(previewRegion, true, true);
  }
  for (const point of points) {
    drawPoint(point, selection?.kind === 'point' && selection.id === point.id);
  }
}

function drawRegion(region: RegionData, selected: boolean, preview: boolean): void {
  const polygon = regionScreenPolygon(region);
  // A rectangle must have four valid projected corners. Connecting a partial
  // polygon can produce a long line when a corner is behind the camera.
  if (polygon.length !== 4) {
    return;
  }
  const color = preview ? '89, 196, 255' : `${region.color.r}, ${region.color.g}, ${region.color.b}`;
  overlayContext.fillStyle = `rgba(${color}, ${selected ? 0.24 : 0.12})`;
  overlayContext.strokeStyle = `rgba(${color}, ${selected ? 1 : 0.82})`;
  overlayContext.lineWidth = selected ? 2 : 1;
  overlayContext.lineJoin = 'round';
  overlayContext.setLineDash(preview ? [6, 4] : []);
  overlayContext.beginPath();
  overlayContext.moveTo(polygon[0]!.x, polygon[0]!.y);
  for (let index = 1; index < polygon.length; index += 1) {
    overlayContext.lineTo(polygon[index]!.x, polygon[index]!.y);
  }
  overlayContext.closePath();
  overlayContext.fill();
  overlayContext.stroke();
  overlayContext.setLineDash([]);
  if (selected && !preview && activeTab === 'regions' && mode === 'select') {
    drawRegionHandles(polygon, color);
  }
  const centerX = (region.left + region.right) / 2;
  const centerY = (region.bottom + region.top) / 2;
  const center = worldToScreen(
    centerX,
    centerY,
    terrainHeightAt(centerX, centerY) + REGION_OVERLAY_HEIGHT_OFFSET
  );
  if (center !== undefined) {
    overlayContext.font = '12px Segoe UI, sans-serif';
    overlayContext.fillStyle = selected ? '#ffffff' : '#e8e8e8';
    overlayContext.textAlign = 'center';
    overlayContext.textBaseline = 'middle';
    overlayContext.fillText(region.name, center.x, center.y, 180);
    overlayContext.textAlign = 'start';
  }
}

function drawRegionHandles(polygon: Array<{ x: number; y: number }>, color: string): void {
  if (polygon.length !== 4) {
    return;
  }
  overlayContext.save();
  overlayContext.strokeStyle = `rgba(${color}, 1)`;
  overlayContext.fillStyle = 'rgba(20, 24, 32, 0.92)';
  overlayContext.lineWidth = 5;
  overlayContext.lineCap = 'square';
  overlayContext.beginPath();
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index]!;
    const end = polygon[(index + 1) % polygon.length]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const insetX = dx / length * 12;
    const insetY = dy / length * 12;
    overlayContext.moveTo(start.x + insetX, start.y + insetY);
    overlayContext.lineTo(end.x - insetX, end.y - insetY);
  }
  overlayContext.stroke();
  overlayContext.lineWidth = 2;
  for (const point of polygon) {
    overlayContext.fillRect(point.x - 8, point.y - 8, 16, 16);
    overlayContext.strokeRect(point.x - 8, point.y - 8, 16, 16);
  }
  overlayContext.restore();
}

function drawPoint(point: ScriptPoint, selected: boolean): void {
  const screen = worldToScreen(
    point.x,
    point.y,
    terrainHeightAt(point.x, point.y) + 32
  );
  if (screen === undefined) {
    return;
  }
  overlayContext.beginPath();
  overlayContext.arc(screen.x, screen.y, selected ? 7 : 5, 0, Math.PI * 2);
  overlayContext.fillStyle = selected ? '#ffffff' : '#f0c94b';
  overlayContext.fill();
  overlayContext.strokeStyle = '#312d18';
  overlayContext.lineWidth = 2;
  overlayContext.stroke();
  overlayContext.font = '12px Segoe UI, sans-serif';
  overlayContext.textBaseline = 'middle';
  overlayContext.fillStyle = '#ffffff';
  overlayContext.fillText(point.name, screen.x + 10, screen.y);
}

function pointerDown(event: PointerEvent): void {
  if (documentData === undefined) {
    return;
  }
  overlay.focus();
  overlay.setPointerCapture(event.pointerId);
  const screen = localScreen(event);
  const world = screenToWorld(screen.x, screen.y);

  if (event.button === 2) {
    event.preventDefault();
    if (event.ctrlKey) {
      if (cameraView === 'top') {
        cameraView = '3d';
        cameraElevation = degrees(48);
        updateViewButtons();
      }
      drag = {
        type: 'rotate',
        startScreen: screen,
        startWorld: world,
        originalYaw: cameraYaw,
        originalElevation: cameraElevation
      };
    } else {
      drag = {
        type: 'pan',
        startScreen: screen,
        startWorld: world,
        originalCenter: { x: viewCenter.x, y: viewCenter.y }
      };
    }
    return;
  }
  if (event.button !== 0) {
    return;
  }

  if (mode === 'region') {
    const region = createRegion(world.x, world.y, world.x, world.y);
    previewRegion = region;
    drag = { type: 'newRegion', startScreen: screen, startWorld: world };
    renderOverlay();
    return;
  }
  if (mode === 'point') {
    const before = captureSnapshot();
    const point: ScriptPoint = {
      id: crypto.randomUUID(),
      name: nextName('point', points.map((item) => item.name)),
      x: roundCoordinate(world.x),
      y: roundCoordinate(world.y)
    };
    points.push(point);
    selection = { kind: 'point', id: point.id };
    setTab('points');
    commitDocumentChange('已创建逻辑点', before);
    return;
  }

  const pointHit = activeTab === 'points' ? hitTestPoint(screen.x, screen.y) : undefined;
  if (pointHit !== undefined) {
    selection = pointHit;
    const point = findPoint(pointHit.id)!;
    const planeHeight = terrainHeightAt(point.x, point.y);
    drag = {
      type: 'movePoint',
      startScreen: screen,
      startWorld: screenToWorldAtHeight(screen.x, screen.y, planeHeight),
      originalCenter: { x: point.x, y: point.y },
      planeHeight,
      historyBefore: captureSnapshot()
    };
    setTab('points');
    return;
  }

  const regionHit = activeTab === 'regions' ? hitTestRegion(screen.x, screen.y) : undefined;
  if (regionHit !== undefined) {
    const region = regionHit.region;
    selection = { kind: 'region', index: region.index };
    const centerX = (region.left + region.right) / 2;
    const centerY = (region.bottom + region.top) / 2;
    // Region overlays are rendered on a small offset plane above the terrain.
    // Use that exact plane for pointer intersection so a dragged edge/corner
    // remains under the cursor at every camera angle.
    const planeHeight = regionRenderHeight(region);
    drag = {
      type: regionHit.handle === 'center' ? 'moveRegion' : 'resizeRegion',
      startScreen: screen,
      startWorld: screenToWorldAtHeight(screen.x, screen.y, planeHeight),
      originalRegion: { left: region.left, bottom: region.bottom, right: region.right, top: region.top },
      regionHandle: regionHit.handle,
      regionIndex: region.index,
      planeHeight,
      historyBefore: captureSnapshot()
    };
    setTab('regions');
  } else {
    selection = undefined;
    renderSidebar();
    renderInspector();
    renderOverlay();
  }
}

function pointerMove(event: PointerEvent): void {
  const screen = localScreen(event);
  const world = screenToWorld(screen.x, screen.y);
  coordinateText.textContent = `X ${roundCoordinate(world.x)}  Y ${roundCoordinate(world.y)}`;
  if (drag === undefined) {
    updatePointerCursor(screen.x, screen.y);
    return;
  }

  if (drag.type === 'pan' && drag.originalCenter !== undefined) {
    const scale = (2 * viewDistance * Math.tan(degrees(CAMERA_FOV / 2))) /
      Math.max(1, viewport.clientHeight);
    const right = { x: Math.cos(cameraYaw), y: Math.sin(cameraYaw) };
    const up = { x: -Math.sin(cameraYaw), y: Math.cos(cameraYaw) };
    const dx = screen.x - drag.startScreen.x;
    const dy = screen.y - drag.startScreen.y;
    viewCenter.x = drag.originalCenter.x - right.x * dx * scale + up.x * dy * scale;
    viewCenter.y = drag.originalCenter.y - right.y * dx * scale + up.y * dy * scale;
    viewTargetZ = terrainHeightAt(viewCenter.x, viewCenter.y);
    updateCamera();
  } else if (drag.type === 'rotate' && drag.originalYaw !== undefined && drag.originalElevation !== undefined) {
    cameraYaw = drag.originalYaw - (screen.x - drag.startScreen.x) * 0.006;
    cameraElevation = clamp(
      drag.originalElevation + (screen.y - drag.startScreen.y) * 0.005,
      degrees(18),
      degrees(86)
    );
    updateCamera();
  } else if (drag.type === 'newRegion' && previewRegion !== undefined) {
    previewRegion.left = Math.min(drag.startWorld.x, world.x);
    previewRegion.right = Math.max(drag.startWorld.x, world.x);
    previewRegion.bottom = Math.min(drag.startWorld.y, world.y);
    previewRegion.top = Math.max(drag.startWorld.y, world.y);
    renderOverlay();
  } else if (drag.type === 'movePoint' && drag.originalCenter !== undefined && selection?.kind === 'point') {
    const point = findPoint(selection.id);
    if (point !== undefined) {
      const moveWorld = screenToWorldAtHeight(screen.x, screen.y, drag.planeHeight ?? 0);
      point.x = roundCoordinate(drag.originalCenter.x + moveWorld.x - drag.startWorld.x);
      point.y = roundCoordinate(drag.originalCenter.y + moveWorld.y - drag.startWorld.y);
      renderInspector();
      renderOverlay();
    }
  } else if (drag.type === 'moveRegion' && drag.originalRegion !== undefined && selection?.kind === 'region') {
    const region = findRegion(selection.index);
    if (region !== undefined) {
      const moveWorld = screenToWorldAtHeight(screen.x, screen.y, drag.planeHeight ?? 0);
      const dx = moveWorld.x - drag.startWorld.x;
      const dy = moveWorld.y - drag.startWorld.y;
      region.left = roundCoordinate(drag.originalRegion.left + dx);
      region.right = roundCoordinate(drag.originalRegion.right + dx);
      region.bottom = roundCoordinate(drag.originalRegion.bottom + dy);
      region.top = roundCoordinate(drag.originalRegion.top + dy);
      clampRegionToTerrain(region);
      renderInspector();
      renderOverlay();
    }
  } else if (
    drag.type === 'resizeRegion' &&
    drag.originalRegion !== undefined &&
    drag.regionHandle !== undefined &&
    selection?.kind === 'region'
  ) {
    const region = findRegion(selection.index);
    if (region !== undefined) {
      const moveWorld = screenToWorldAtHeight(screen.x, screen.y, drag.planeHeight ?? 0);
      // Set the dragged edge/corner to the cursor's world intersection directly.
      // This avoids accumulated deltas and keeps the handle visually coincident
      // with the mouse instead of applying a sensitivity multiplier.
      resizeRegionToCursor(region, drag.originalRegion, drag.regionHandle, moveWorld);
      clampRegionToTerrain(region);
      renderInspector();
      renderOverlay();
    }
  }
}

function pointerUp(event: PointerEvent): void {
  if (drag === undefined) {
    return;
  }
  const completedDrag = drag;
  drag = undefined;
  if (overlay.hasPointerCapture(event.pointerId)) {
    overlay.releasePointerCapture(event.pointerId);
  }

  if (completedDrag.type === 'newRegion' && previewRegion !== undefined) {
    const width = previewRegion.right - previewRegion.left;
    const height = previewRegion.top - previewRegion.bottom;
    if (width >= 16 && height >= 16) {
      const before = captureSnapshot();
      regionFile.regions.push(previewRegion);
      selection = { kind: 'region', index: previewRegion.index };
      previewRegion = undefined;
      setTab('regions');
      commitDocumentChange('已创建区域', before);
    } else {
      previewRegion = undefined;
      renderOverlay();
      setStatus('区域太小，已取消创建', true);
    }
  } else if (
    completedDrag.type === 'movePoint' ||
    completedDrag.type === 'moveRegion' ||
    completedDrag.type === 'resizeRegion'
  ) {
    if (completedDrag.historyBefore !== undefined) {
      commitDocumentChange('位置已更新', completedDrag.historyBefore);
    }
  }
}

function cancelDrag(): void {
  const cancelledDrag = drag;
  drag = undefined;
  previewRegion = undefined;
  if (cancelledDrag?.historyBefore !== undefined &&
      !snapshotsEqual(cancelledDrag.historyBefore, captureSnapshot())) {
    restoreSnapshot(cancelledDrag.historyBefore);
  }
  renderOverlay();
}

function wheel(event: WheelEvent): void {
  event.preventDefault();
  if (war3Viewer?.map === null || war3Viewer === undefined) {
    return;
  }
  const screen = localScreen(event);
  const before = screenToWorld(screen.x, screen.y);
  viewDistance = clamp(viewDistance * Math.exp(event.deltaY * 0.0012), 320, 160_000);
  updateCamera();
  const after = screenToWorld(screen.x, screen.y);
  viewCenter.x += before.x - after.x;
  viewCenter.y += before.y - after.y;
  viewTargetZ = terrainHeightAt(viewCenter.x, viewCenter.y);
  updateCamera();
}

function hitTestPoint(screenX: number, screenY: number): Extract<Selection, { kind: 'point' }> | undefined {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    const screen = worldToScreen(
      point.x,
      point.y,
      terrainHeightAt(point.x, point.y) + 32
    );
    if (screen !== undefined && Math.hypot(screen.x - screenX, screen.y - screenY) <= 10) {
      return { kind: 'point', id: point.id };
    }
  }
  return undefined;
}

function hitTestRegion(
  screenX: number,
  screenY: number
): { region: RegionData; handle: RegionHandle } | undefined {
  if (selection?.kind === 'region') {
    const selectedRegion = findRegion(selection.index);
    if (selectedRegion !== undefined) {
      const handle = regionHandleAt(screenX, screenY, selectedRegion);
      if (handle !== undefined) {
        return { region: selectedRegion, handle };
      }
    }
  }
  for (let index = regionFile.regions.length - 1; index >= 0; index -= 1) {
    const region = regionFile.regions[index]!;
    if (selection?.kind === 'region' && region.index === selection.index) {
      continue;
    }
    const handle = regionHandleAt(screenX, screenY, region);
    if (handle !== undefined) {
      return { region, handle };
    }
  }
  return undefined;
}

function regionHandleAt(screenX: number, screenY: number, region: RegionData): RegionHandle | undefined {
  const polygon = regionScreenPolygon(region);
  if (polygon.length !== 4) {
    return undefined;
  }
  const [southWest, southEast, northEast, northWest] = polygon as [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number }
  ];
  const corners: Array<[RegionHandle, { x: number; y: number }]> = [
    ['southWest', southWest],
    ['southEast', southEast],
    ['northEast', northEast],
    ['northWest', northWest]
  ];
  for (const [handle, point] of corners) {
    if (Math.abs(screenX - point.x) <= 10 && Math.abs(screenY - point.y) <= 10) {
      return handle;
    }
  }
  const edges: Array<[RegionHandle, { x: number; y: number }, { x: number; y: number }]> = [
    ['south', southWest, southEast],
    ['east', southEast, northEast],
    ['north', northEast, northWest],
    ['west', northWest, southWest]
  ];
  for (const [handle, start, end] of edges) {
    if (distanceToSegment(screenX, screenY, start, end) <= 8) {
      return handle;
    }
  }
  return pointInPolygon(screenX, screenY, polygon) ? 'center' : undefined;
}

function distanceToSegment(
  x: number,
  y: number,
  start: { x: number; y: number },
  end: { x: number; y: number }
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(x - start.x, y - start.y);
  }
  const t = clamp(((x - start.x) * dx + (y - start.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(x - (start.x + dx * t), y - (start.y + dy * t));
}

function resizeRegionToCursor(
  region: RegionData,
  original: Pick<RegionData, 'left' | 'bottom' | 'right' | 'top'>,
  handle: RegionHandle,
  cursor: { x: number; y: number }
): void {
  const minimumSize = 16;
  region.left = original.left;
  region.right = original.right;
  region.bottom = original.bottom;
  region.top = original.top;
  if (handle.includes('West') || handle === 'west') {
    region.left = Math.min(original.right - minimumSize, cursor.x);
  }
  if (handle.includes('East') || handle === 'east') {
    region.right = Math.max(original.left + minimumSize, cursor.x);
  }
  if (handle.startsWith('south')) {
    region.bottom = Math.min(original.top - minimumSize, cursor.y);
  }
  if (handle.startsWith('north')) {
    region.top = Math.max(original.bottom + minimumSize, cursor.y);
  }
  region.left = roundCoordinate(region.left);
  region.right = roundCoordinate(region.right);
  region.bottom = roundCoordinate(region.bottom);
  region.top = roundCoordinate(region.top);
}

function clampRegionToTerrain(region: RegionData): void {
  if (terrainBounds === undefined) {
    return;
  }
  const minX = terrainBounds.minX;
  const maxX = terrainBounds.maxX;
  const minY = terrainBounds.minY;
  const maxY = terrainBounds.maxY;
  const width = Math.max(16, Math.min(region.right - region.left, maxX - minX));
  const height = Math.max(16, Math.min(region.top - region.bottom, maxY - minY));
  region.left = clamp(region.left, minX, maxX - width);
  region.right = region.left + width;
  region.bottom = clamp(region.bottom, minY, maxY - height);
  region.top = region.bottom + height;
  region.left = roundCoordinate(region.left);
  region.right = roundCoordinate(region.right);
  region.bottom = roundCoordinate(region.bottom);
  region.top = roundCoordinate(region.top);
}

function updatePointerCursor(screenX: number, screenY: number): void {
  if (mode === 'region') {
    overlay.style.cursor = 'crosshair';
    return;
  }
  if (mode === 'point') {
    overlay.style.cursor = 'copy';
    return;
  }
  if (activeTab === 'points' && hitTestPoint(screenX, screenY) !== undefined) {
    overlay.style.cursor = 'move';
    return;
  }
  if (activeTab !== 'regions') {
    overlay.style.cursor = 'default';
    return;
  }
  const hit = hitTestRegion(screenX, screenY);
  const cursors: Record<RegionHandle, string> = {
    northWest: 'nwse-resize',
    north: 'ns-resize',
    northEast: 'nesw-resize',
    east: 'ew-resize',
    southEast: 'nwse-resize',
    south: 'ns-resize',
    southWest: 'nesw-resize',
    west: 'ew-resize',
    center: 'move'
  };
  overlay.style.cursor = hit === undefined ? 'default' : cursors[hit.handle];
}

function applyInspector(): void {
  const before = captureSnapshot();
  if (selection?.kind === 'region') {
    const region = findRegion(selection.index);
    if (region === undefined) {
      return;
    }
    region.name = nameInput.value.trim() || region.name;
    region.left = numberInput(leftInput, region.left);
    region.right = numberInput(rightInput, region.right);
    region.bottom = numberInput(bottomInput, region.bottom);
    region.top = numberInput(topInput, region.top);
    if (region.left > region.right) {
      [region.left, region.right] = [region.right, region.left];
    }
    if (region.bottom > region.top) {
      [region.bottom, region.top] = [region.top, region.bottom];
    }
  } else if (selection?.kind === 'point') {
    const point = findPoint(selection.id);
    if (point === undefined) {
      return;
    }
    const nextPointName = nameInput.value.trim();
    if (nextPointName.length === 0 || points.some((item) => item.id !== point.id && item.name === nextPointName)) {
      nameInput.value = point.name;
      setStatus('点名称不能为空或重复', true);
      return;
    }
    point.name = nextPointName;
    point.x = numberInput(xInput, point.x);
    point.y = numberInput(yInput, point.y);
  }
  commitDocumentChange('属性已更新', before);
}

function deleteSelection(): void {
  const selected = selection;
  if (selected === undefined) {
    return;
  }
  const before = captureSnapshot();
  if (selected.kind === 'region') {
    regionFile.regions = regionFile.regions.filter((region) => region.index !== selected.index);
  } else {
    points = points.filter((point) => point.id !== selected.id);
  }
  selection = undefined;
  commitDocumentChange('已删除', before);
}

function captureSnapshot(): EditorSnapshot {
  return {
    regionFile: structuredClone(regionFile),
    points: structuredClone(points),
    selection: structuredClone(selection)
  };
}

function restoreSnapshot(snapshot: EditorSnapshot): void {
  regionFile = structuredClone(snapshot.regionFile);
  points = structuredClone(snapshot.points);
  selection = structuredClone(snapshot.selection);
  previewRegion = undefined;
  renderSidebar();
  renderInspector();
  renderOverlay();
}

function snapshotsEqual(left: EditorSnapshot, right: EditorSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commitDocumentChange(message: string, before: EditorSnapshot): void {
  const after = captureSnapshot();
  if (snapshotsEqual(before, after)) {
    return;
  }
  undoHistory.push(before);
  if (undoHistory.length > HISTORY_LIMIT) {
    undoHistory.shift();
  }
  redoHistory = [];
  changed(message);
}

function undo(): void {
  if (drag !== undefined) {
    cancelDrag();
  }
  const previous = undoHistory.pop();
  if (previous === undefined) {
    setStatus('没有可撤销的操作');
    return;
  }
  redoHistory.push(captureSnapshot());
  if (redoHistory.length > HISTORY_LIMIT) {
    redoHistory.shift();
  }
  restoreSnapshot(previous);
  changed('已撤销');
}

function redo(): void {
  if (drag !== undefined) {
    cancelDrag();
  }
  const next = redoHistory.pop();
  if (next === undefined) {
    setStatus('没有可前进的操作');
    return;
  }
  undoHistory.push(captureSnapshot());
  if (undoHistory.length > HISTORY_LIMIT) {
    undoHistory.shift();
  }
  restoreSnapshot(next);
  changed('已前进');
}

function changed(message: string): void {
  revision += 1;
  setStatus(`${message} · 未保存`);
  renderSidebar();
  renderInspector();
  renderOverlay();
  scheduleSave();
}

function scheduleSave(): void {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => saveNow(), 650);
}

function saveNow(): void {
  if (documentData === undefined || revision === savedRevision || savingRevision !== undefined) {
    return;
  }
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  savingRevision = revision;
  saveButton.disabled = true;
  setStatus('正在保存 war3map.w3r 和点位...');
  vscode.postMessage({
    type: 'save',
    revision: savingRevision,
    regionFile: structuredClone(regionFile),
    points: structuredClone(points)
  });
}

function handleSaved(completedRevision: number): void {
  savedRevision = Math.max(savedRevision, completedRevision);
  savingRevision = undefined;
  saveButton.disabled = false;
  if (revision > savedRevision) {
    setStatus('已有新修改，继续保存...');
    scheduleSave();
  } else {
    setStatus('已保存 war3map.w3r 和点位');
  }
}

function setMode(nextMode: Mode): void {
  mode = nextMode;
  cancelDrag();
  regionToolButton.classList.toggle('active', nextMode === 'region');
  regionToolButton.setAttribute('aria-pressed', String(nextMode === 'region'));
  pointToolButton.classList.toggle('active', nextMode === 'point');
  pointToolButton.setAttribute('aria-pressed', String(nextMode === 'point'));
  overlay.style.cursor = nextMode === 'region' ? 'crosshair' : nextMode === 'point' ? 'copy' : 'default';
  renderOverlay();
}

function toggleRegionTool(): void {
  if (activeTab !== 'regions') {
    return;
  }
  setMode(mode === 'region' ? 'select' : 'region');
  setStatus(mode === 'region' ? '新建矩形区域：拖拽两个对角' : '区域编辑模式');
}

function togglePointTool(): void {
  if (activeTab !== 'points') {
    return;
  }
  setMode(mode === 'point' ? 'select' : 'point');
  setStatus(mode === 'point' ? '新建逻辑点：点击地面放置' : '点编辑模式');
}

function setCameraView(nextView: CameraView): void {
  cameraView = nextView;
  cameraElevation = nextView === 'top' ? degrees(89.5) : degrees(45);
  updateViewButtons();
  fitMap();
}

function updateViewButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('.view-button')) {
    button.classList.toggle('active', button.dataset.view === cameraView);
  }
}

function setTab(tab: Tab): void {
  activeTab = tab;
  if (
    (tab === 'regions' && selection?.kind === 'point') ||
    (tab === 'points' && selection?.kind === 'region')
  ) {
    selection = undefined;
  }
  if (tab === 'regions' && mode === 'point') {
    setMode('select');
  } else if (tab === 'points' && mode === 'region') {
    setMode('select');
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  renderSidebar();
  renderInspector();
}

function renderSidebar(): void {
  regionCount.textContent = String(regionFile.regions.length);
  pointCount.textContent = String(points.length);
  pointListCount.textContent = String(points.length);
  regionPanelHeader.hidden = activeTab !== 'regions';
  pointPanelHeader.hidden = activeTab !== 'points';
  itemList.replaceChildren();
  const items = activeTab === 'regions'
    ? regionFile.regions.map((region) => ({ id: String(region.index), name: region.name, detail: '' }))
    : points.map((point) => ({ id: point.id, name: point.name, detail: `${roundCoordinate(point.x)}, ${roundCoordinate(point.y)}` }));

  for (const item of items) {
    const button = document.createElement('button');
    button.className = 'item-row';
    const selected = activeTab === 'regions'
      ? selection?.kind === 'region' && String(selection.index) === item.id
      : selection?.kind === 'point' && selection.id === item.id;
    button.classList.toggle('selected', selected);
    const label = document.createElement('span');
    label.textContent = item.name;
    const detail = document.createElement('small');
    detail.textContent = item.detail;
    button.append(label);
    if (item.detail.length > 0) {
      button.append(detail);
    }
    button.addEventListener('click', () => {
      selection = activeTab === 'regions'
        ? { kind: 'region', index: Number(item.id) }
        : { kind: 'point', id: item.id };
      renderSidebar();
      renderInspector();
      renderOverlay();
    });
    itemList.appendChild(button);
  }
}

function renderInspector(): void {
  const region = selection?.kind === 'region' ? findRegion(selection.index) : undefined;
  const point = selection?.kind === 'point' ? findPoint(selection.id) : undefined;
  const hasSelection = region !== undefined || point !== undefined;
  emptyInspector.hidden = hasSelection;
  editorFields.hidden = !hasSelection;
  regionFields.hidden = region === undefined;
  pointFields.hidden = point === undefined;
  if (region !== undefined) {
    currentRegionName.textContent = region.name;
    currentPointName.textContent = '没有';
    nameInput.value = region.name;
    leftInput.value = String(roundCoordinate(region.left));
    rightInput.value = String(roundCoordinate(region.right));
    bottomInput.value = String(roundCoordinate(region.bottom));
    topInput.value = String(roundCoordinate(region.top));
  } else if (point !== undefined) {
    currentRegionName.textContent = '没有';
    currentPointName.textContent = point.name;
    nameInput.value = point.name;
    xInput.value = String(roundCoordinate(point.x));
    yInput.value = String(roundCoordinate(point.y));
  } else {
    currentRegionName.textContent = '没有';
    currentPointName.textContent = '没有';
  }
}

function createRegion(left: number, bottom: number, right: number, top: number): RegionData {
  const nextIndex = Math.max(-1, ...regionFile.regions.map((region) => region.index)) + 1;
  return {
    left: roundCoordinate(left),
    bottom: roundCoordinate(bottom),
    right: roundCoordinate(right),
    top: roundCoordinate(top),
    name: nextName('Region', regionFile.regions.map((region) => region.name)),
    index: nextIndex,
    weatherId: '\0\0\0\0',
    ambientSound: '',
    color: regionColor(nextIndex)
  };
}

function regionColor(index: number): RegionData['color'] {
  const palette = [
    [255, 128, 128], [106, 196, 255], [139, 219, 124], [241, 196, 86],
    [198, 145, 232], [255, 157, 92], [100, 210, 190], [224, 119, 165]
  ];
  const color = palette[Math.abs(index) % palette.length]!;
  return { r: color[0]!, g: color[1]!, b: color[2]!, a: 255 };
}

function nextName(prefix: string, existing: string[]): string {
  const names = new Set(existing);
  let index = 1;
  while (names.has(`${prefix}_${index}`)) {
    index += 1;
  }
  return `${prefix}_${index}`;
}

function findRegion(index: number): RegionData | undefined {
  return regionFile.regions.find((region) => region.index === index);
}

function findPoint(id: string): ScriptPoint | undefined {
  return points.find((point) => point.id === id);
}

function terrainHeightAt(x: number, y: number): number {
  const terrain = terrainData;
  if (terrain === undefined) {
    return 0;
  }
  const gridX = clamp((x - terrain.offsetX) / 128, 0, terrain.width - 1);
  const gridY = clamp((y - terrain.offsetY) / 128, 0, terrain.height - 1);
  const column = Math.min(terrain.width - 2, Math.floor(gridX));
  const row = Math.min(terrain.height - 2, Math.floor(gridY));
  const fractionX = gridX - column;
  const fractionY = gridY - row;
  const bottomLeft = terrainCornerHeight(terrain, column, row);
  const bottomRight = terrainCornerHeight(terrain, column + 1, row);
  const topLeft = terrainCornerHeight(terrain, column, row + 1);
  const topRight = terrainCornerHeight(terrain, column + 1, row + 1);
  if (fractionX + fractionY < 1) {
    return bottomLeft + (bottomRight - bottomLeft) * fractionX + (topLeft - bottomLeft) * fractionY;
  }
  return topRight + (bottomRight - topRight) * (1 - fractionY) + (topLeft - topRight) * (1 - fractionX);
}

function regionRenderHeight(region: Pick<RegionData, 'left' | 'bottom' | 'right' | 'top'>): number {
  // Keep the selected region on the same interaction plane for the duration
  // of a drag. Recomputing its terrain height after every edge movement would
  // move the rendered handle away from the cursor on sloped terrain.
  if (
    drag !== undefined &&
    drag.planeHeight !== undefined &&
    drag.regionIndex !== undefined &&
    selection?.kind === 'region' &&
    selection.index === drag.regionIndex
  ) {
    return drag.planeHeight;
  }
  const centerX = (region.left + region.right) / 2;
  const centerY = (region.bottom + region.top) / 2;
  return terrainHeightAt(centerX, centerY) + REGION_OVERLAY_HEIGHT_OFFSET;
}

function terrainCornerHeight(terrain: TerrainData, column: number, row: number): number {
  const index = row * terrain.width + column;
  return terrain.heights[index]! + (terrain.cliffLevels[index]! - 2) * 128;
}

function regionScreenPolygon(region: RegionData): Array<{ x: number; y: number }> {
  const renderHeight = regionRenderHeight(region);
  const corners = [
    [region.left, region.bottom],
    [region.right, region.bottom],
    [region.right, region.top],
    [region.left, region.top]
  ] as const;
  return corners.flatMap(([x, y]) => {
    const screen = worldToScreen(x, y, renderHeight);
    return screen === undefined ? [] : [screen];
  });
}

function pointInPolygon(x: number, y: number, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index]!;
    const previousPoint = polygon[previous]!;
    const crosses = (currentPoint.y > y) !== (previousPoint.y > y) &&
      x < ((previousPoint.x - currentPoint.x) * (y - currentPoint.y)) /
        (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (crosses) {
      inside = !inside;
    }
  }
  return inside;
}

function worldToScreen(x: number, y: number, z: number): { x: number; y: number } | undefined {
  const scene = war3Viewer?.map?.worldScene;
  if (scene === undefined || renderCanvas === undefined) {
    return undefined;
  }
  // mdx-m3-viewer's projection helper returns screen coordinates even for
  // points behind the camera. Those coordinates can be enormous and cause
  // Canvas to connect a region edge across the entire viewport. Reject points
  // at or behind the near plane before drawing overlays.
  const cameraPoint = new Float32Array(3);
  scene.camera.worldToCamera(cameraPoint, new Float32Array([x, y, z]));
  const nearClip = Math.max(0.5, scene.camera.nearClipPlane || 0.5);
  const cameraZ = cameraPoint[2] ?? Number.NaN;
  if (!Number.isFinite(cameraZ) || cameraZ >= -nearClip * 0.5) {
    return undefined;
  }
  const output = new Float32Array(2);
  scene.camera.worldToScreen(output, new Float32Array([x, y, z]), scene.viewport);
  const pixelRatio = renderCanvas.width / Math.max(1, viewport.clientWidth);
  const result = {
    x: output[0]! / pixelRatio,
    y: viewport.clientHeight - output[1]! / pixelRatio
  };
  return Number.isFinite(result.x) && Number.isFinite(result.y) ? result : undefined;
}

function screenToWorld(x: number, y: number): { x: number; y: number } {
  const scene = war3Viewer?.map?.worldScene;
  if (scene === undefined || renderCanvas === undefined) {
    return { x: 0, y: 0 };
  }
  const pixelRatio = renderCanvas.width / Math.max(1, viewport.clientWidth);
  const ray = new Float32Array(6);
  scene.camera.screenToWorldRay(
    ray,
    // mdx-m3-viewer unproject() expects top-left screen coordinates. The
    // overlay pointer coordinates are already top-left, so do not flip Y.
    new Float32Array([x * pixelRatio, y * pixelRatio, 0]),
    scene.viewport
  );
  const directionX = ray[3]! - ray[0]!;
  const directionY = ray[4]! - ray[1]!;
  const directionZ = ray[5]! - ray[2]!;
  let worldX = ray[0]!;
  let worldY = ray[1]!;
  let targetHeight = viewTargetZ;
  for (let iteration = 0; iteration < 7; iteration += 1) {
    const t = directionZ === 0 ? 0 : (targetHeight - ray[2]!) / directionZ;
    worldX = ray[0]! + directionX * t;
    worldY = ray[1]! + directionY * t;
    targetHeight = terrainHeightAt(worldX, worldY);
  }
  return { x: worldX, y: worldY };
}

function screenToWorldAtHeight(x: number, y: number, height: number): { x: number; y: number } {
  const scene = war3Viewer?.map?.worldScene;
  if (scene === undefined || renderCanvas === undefined) {
    return { x: 0, y: 0 };
  }
  const pixelRatio = renderCanvas.width / Math.max(1, viewport.clientWidth);
  const ray = new Float32Array(6);
  scene.camera.screenToWorldRay(
    ray,
    new Float32Array([x * pixelRatio, y * pixelRatio, 0]),
    scene.viewport
  );
  const directionZ = ray[5]! - ray[2]!;
  if (Math.abs(directionZ) < 0.0001) {
    return { x: viewCenter.x, y: viewCenter.y };
  }
  const t = clamp((height - ray[2]!) / directionZ, -10_000, 10_000);
  return {
    x: ray[0]! + (ray[3]! - ray[0]!) * t,
    y: ray[1]! + (ray[4]! - ray[1]!) * t
  };
}

class ResourceBroker {
  private nextRequestId = 1;
  private readonly pending = new Map<number, (data: Uint8Array | undefined) => void>();
  private readonly byteCache = new Map<string, Promise<Uint8Array | undefined>>();

  public resolve(requestId: number, base64: string | undefined): void {
    const callback = this.pending.get(requestId);
    if (callback === undefined) {
      return;
    }
    this.pending.delete(requestId);
    callback(base64 === undefined ? undefined : decodeBase64(base64));
  }

  public toUrl(source: unknown): unknown {
    if (typeof source !== 'string') {
      return source;
    }
    return `${RESOURCE_URL_PREFIX}${encodeURIComponent(source.replaceAll('/', '\\'))}`;
  }

  public async fetch(resourcePath: string): Promise<Response> {
    const bytes = await this.request(resourcePath);
    if (bytes === undefined) {
      return new Response(null, { status: 404 });
    }
    return new Response(exactArrayBuffer(bytes), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  }

  private request(resourcePath: string): Promise<Uint8Array | undefined> {
    const key = normalizeResourcePath(resourcePath);
    let promise = this.byteCache.get(key);
    if (promise === undefined) {
      const requestId = this.nextRequestId;
      this.nextRequestId += 1;
      promise = new Promise((resolve) => this.pending.set(requestId, resolve));
      this.byteCache.set(key, promise);
      vscode.postMessage({ type: 'resource', requestId, path: resourcePath });
    }
    return promise;
  }
}

function createMapArchive(data: MapDocumentData): Uint8Array {
  const archive = new MpqArchive();
  archive.resizeHashtable(32);
  for (const file of data.mapFiles) {
    if (!archive.set(file.name, decodeBase64(file.base64))) {
      throw new Error(`无法创建内存地图文件：${file.name}`);
    }
  }
  const buffer = archive.save();
  if (buffer === null) {
    throw new Error('无法创建供 3D 渲染器读取的内存 W3X。');
  }
  return buffer;
}

function mergeDoodadData(viewer: War3Viewer, source: string): void {
  const sections = parseLniIni(source);
  const resolved = new Map<string, Map<string, string>>();

  const resolveRow = (id: string, stack = new Set<string>()): Map<string, string> => {
    const cached = resolved.get(id);
    if (cached !== undefined) {
      return cached;
    }
    if (stack.has(id)) {
      return new Map();
    }
    const nextStack = new Set(stack).add(id);
    const properties = sections.get(id);
    const parent = properties?.get('_parent');
    const values = new Map<string, string>();
    if (parent !== undefined && parent !== id) {
      for (const [key, value] of resolveRow(parent, nextStack)) {
        values.set(key, value);
      }
    } else {
      const baseRow = viewer.doodadsData.getRow(id);
      if (baseRow !== undefined) {
        for (const [key, value] of Object.entries(baseRow.map)) {
          if (value !== undefined) {
            values.set(key, value);
          }
        }
      }
    }
    if (properties !== undefined) {
      for (const [key, value] of properties) {
        if (key !== '_parent') {
          values.set(key, value);
        }
      }
    }
    const file = values.get('file');
    if (file !== undefined && /\.mdx$/i.test(file)) {
      values.set('file', file.slice(0, -4));
    }
    if (properties?.has('file') && !properties.has('numvar')) {
      values.set('numvar', '1');
    }
    resolved.set(id, values);
    return values;
  };

  const lines: string[] = [];
  for (const id of sections.keys()) {
    lines.push(`[${id}]`);
    for (const [key, value] of resolveRow(id)) {
      lines.push(`${key}=${value}`);
    }
  }
  if (lines.length > 0) {
    viewer.doodadsData.load(lines.join('\r\n'));
  }
}

function parseLniIni(source: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const rawLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('--') || line.startsWith(';') || line.startsWith('//')) {
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch !== null) {
      current = new Map();
      sections.set(sectionMatch[1]!, current);
      continue;
    }
    const propertyMatch = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (current !== undefined && propertyMatch !== null) {
      current.set(propertyMatch[1]!.trim().toLowerCase(), decodeLniValue(propertyMatch[2]!.trim()));
    }
  }
  return sections;
}

function decodeLniValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1).replaceAll('\\\\', '\\').replaceAll('\\"', '"');
    }
  }
  return value;
}

function once(viewer: War3Viewer, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      viewer.removeListener(event, loaded);
      reject(new Error('读取 Warcraft 基础地形数据超时，请检查插件设置中的魔兽目录。'));
    }, 30_000);
    const loaded = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    viewer.once(event, loaded);
  });
}

function normalizeResourcePath(resourcePath: string): string {
  return resourcePath.replaceAll('/', '\\').toLowerCase();
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function hasLegacyTgaHeader(source: unknown): boolean {
  const bytes = source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : source instanceof Uint8Array
      ? source
      : undefined;
  if (bytes === undefined || bytes.length < 18) {
    return false;
  }
  const imageType = bytes[2]!;
  const width = bytes[12]! | (bytes[13]! << 8);
  const height = bytes[14]! | (bytes[15]! << 8);
  const pixelDepth = bytes[16]!;
  return [1, 2, 3, 9, 10, 11].includes(imageType) &&
    width > 0 &&
    height > 0 &&
    [8, 16, 24, 32].includes(pixelDepth);
}

function localScreen(event: MouseEvent | PointerEvent | WheelEvent): { x: number; y: number } {
  const bounds = overlay.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function numberInput(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function setStatus(message: string, error = false): void {
  statusText.textContent = message;
  statusText.classList.toggle('error', error);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function degrees(value: number): number {
  return value * Math.PI / 180;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing element #${id}.`);
  }
  return element as T;
}

function requiredContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('Canvas 2D is unavailable.');
  }
  return context;
}

void app;
