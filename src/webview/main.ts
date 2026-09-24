import MpqArchive from 'mdx-m3-viewer/dist/cjs/parsers/mpq/archive';
import TgaHandler from 'mdx-m3-viewer/dist/cjs/viewer/handlers/tga/handler';
import BaseWar3MapViewer from 'mdx-m3-viewer/dist/cjs/viewer/handlers/w3x/viewer';
import { DebugRenderMode } from 'mdx-m3-viewer/dist/cjs/viewer/viewer';
import { groundFragmentShader, groundVertexShader } from './ground-shaders';
import { buildTerrainTextureLayers } from './terrain-texture-layers';
import { groupOffset, linkOffset, mirrorSigns } from '../shared/instance-links';
import type { LinkBox, MirrorSigns } from '../shared/instance-links';
import { scrollTargetForRow } from '../shared/scroll-reveal';
import type {
  InstanceLinkData,
  InstanceMirrorAxis,
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
  selectedKeys: string[];
  instanceLinks: InstanceLink[];
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

type SnapAxis = 'x' | 'y';

interface DragPointPosition {
  id: string;
  x: number;
  y: number;
}

interface DragRegionPosition {
  index: number;
  left: number;
  bottom: number;
  right: number;
  top: number;
}

interface SnapAnchor {
  x: number;
  y: number;
  label: string;
}

interface SnapGuide {
  axis: SnapAxis;
  anchor: SnapAnchor;
  source: { x: number; y: number };
}

interface SnapCandidate {
  anchor: SnapAnchor;
  source: { x: number; y: number };
  distance: number;
}

interface DragState {
  type: 'pan' | 'rotate' | 'marquee' | 'newRegion' | 'moveRegion' | 'resizeRegion' | 'movePoint' | 'moveSelection';
  startScreen: { x: number; y: number };
  startWorld: { x: number; y: number };
  originalCenter?: { x: number; y: number };
  originalYaw?: number;
  originalElevation?: number;
  originalRegion?: Pick<RegionData, 'left' | 'bottom' | 'right' | 'top'>;
  regionHandle?: RegionHandle;
  regionIndex?: number;
  planeHeight?: number;
  selectedPoints?: DragPointPosition[];
  selectedRegions?: DragRegionPosition[];
  historyBefore?: EditorSnapshot;
}

interface ClipboardData {
  center: { x: number; y: number };
  points: ScriptPoint[];
  regions: RegionData[];
}

interface PastePreview {
  center: { x: number; y: number };
  points: ScriptPoint[];
  regions: RegionData[];
}

type PasteMode = 'instance' | 'normal';

/** `none` keeps the offset, `horizontal` flips X (左右), `vertical` flips Y (上下). */
type MirrorAxis = InstanceMirrorAxis;

interface PastePlacement {
  mode: PasteMode;
  mirror: MirrorAxis;
}

/**
 * Binds a pasted entity to the entity it was copied from. The relation is the
 * affine map `target = signs * source + offset`, so the two groups keep exactly
 * the layout they were pasted in: editing either side re-derives the other,
 * mirrored on `axis` when the copy was mirrored.
 */
interface InstanceLink {
  source: string;
  target: string;
  axis: MirrorAxis;
  offset: { x: number; y: number };
}

/**
 * A right click that landed on an instance-linked entity. It only becomes the
 * unlink menu if the button comes back up without dragging, so the right
 * button keeps panning and rotating the camera exactly as before.
 */
interface PendingContextMenu {
  key: string;
  screen: { x: number; y: number };
}

const CAMERA_FOV = 45;
const CAMERA_NEAR = 8;
const CAMERA_FAR = 300_000;
const REGION_OVERLAY_HEIGHT_OFFSET = 32;
const SNAP_SEARCH_RADIUS = 500;
const DEFAULT_SNAP_DISTANCE = 50;
/** How far the right button may travel before it counts as a camera drag. */
const CONTEXT_MENU_DRAG_SLOP = 4;
/** Duration of the scroll that brings the selected row into view. */
const SIDEBAR_SCROLL_DURATION = 500;

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
const regionSnapEnabledInput = requiredElement<HTMLInputElement>('regionSnapEnabledInput');
const regionSnapDistanceInput = requiredElement<HTMLInputElement>('regionSnapDistanceInput');
const pointSnapEnabledInput = requiredElement<HTMLInputElement>('pointSnapEnabledInput');
const pointSnapDistanceInput = requiredElement<HTMLInputElement>('pointSnapDistanceInput');
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
const pasteDialog = requiredElement<HTMLElement>('pasteDialog');
const pasteDialogHint = requiredElement<HTMLElement>('pasteDialogHint');
const pasteModeInstanceInput = requiredElement<HTMLInputElement>('pasteModeInstanceInput');
const pasteModeNormalInput = requiredElement<HTMLInputElement>('pasteModeNormalInput');
const pasteMirrorInput = requiredElement<HTMLInputElement>('pasteMirrorInput');
const pasteMirrorAxisInput = requiredElement<HTMLSelectElement>('pasteMirrorAxisInput');
const pasteCancelButton = requiredElement<HTMLButtonElement>('pasteCancelButton');
const pasteConfirmButton = requiredElement<HTMLButtonElement>('pasteConfirmButton');
const contextMenu = requiredElement<HTMLElement>('contextMenu');

let documentData: MapDocumentData | undefined;
let regionFile: RegionFileData = { version: 5, regions: [] };
let points: ScriptPoint[] = [];
let mode: Mode = 'select';
let activeTab: Tab = 'regions';
let selection: Selection | undefined;
let selectedKeys = new Set<string>();
let drag: DragState | undefined;
let snapGuides: SnapGuide[] = [];
let snapEnabled = true;
let snapDistance = DEFAULT_SNAP_DISTANCE;
let marquee: { startScreen: { x: number; y: number }; currentScreen: { x: number; y: number } } | undefined;
/** Key of the row the list has already revealed; a repeat never scrolls again. */
let sidebarRevealedKey: string | undefined;
let sidebarScrollFrame: number | undefined;
let clipboard: ClipboardData | undefined;
let pastePreview: PastePreview | undefined;
let activePastePlacement: PastePlacement | undefined;
let instanceLinks: InstanceLink[] = [];
let pendingContextMenu: PendingContextMenu | undefined;
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
  for (const input of [regionSnapEnabledInput, pointSnapEnabledInput]) {
    input.addEventListener('change', () => {
      snapEnabled = input.checked;
      updateSnapControls();
      renderOverlay();
    });
  }
  for (const input of [regionSnapDistanceInput, pointSnapDistanceInput]) {
    input.addEventListener('change', () => {
      snapDistance = clamp(Number(input.value) || DEFAULT_SNAP_DISTANCE, 1, 500);
      updateSnapControls();
      renderOverlay();
    });
  }
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
    if (isPasteDialogOpen()) {
      return;
    }
    if (event.key === 'Delete') {
      deleteSelection();
    } else if (event.key === 'Escape') {
      cancelDrag();
      cancelPastePreview();
      setMode('select');
    }
  });
  window.addEventListener('keydown', (event) => {
    if (isPasteDialogOpen()) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePasteDialog();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        confirmPasteDialog();
      }
      return;
    }
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
    if (modifier && !editingText && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      copySelection();
      return;
    }
    if (modifier && !editingText && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      pasteSelection();
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
  pasteMirrorInput.addEventListener('change', () => {
    updatePasteMirrorControls();
    if (pasteMirrorInput.checked) {
      pasteMirrorAxisInput.focus();
    }
  });
  pasteConfirmButton.addEventListener('click', () => confirmPasteDialog());
  pasteCancelButton.addEventListener('click', () => closePasteDialog());
  pasteDialog.addEventListener('mousedown', (event) => {
    // Clicking the backdrop (not the card) behaves like cancel.
    if (event.target === pasteDialog) {
      event.preventDefault();
      closePasteDialog();
    }
  });
  // A hand on the list always wins over the reveal animation. Only real gestures
  // land here — the animation writes `scrollTop` directly, which fires nothing.
  itemList.addEventListener('wheel', cancelSidebarScrollAnimation, { passive: true });
  itemList.addEventListener('pointerdown', cancelSidebarScrollAnimation);
  // The context menu closes on any press outside it, on Esc, and on a zoom.
  // Captured on `window` so a press anywhere — canvas, sidebar, toolbar — lands
  // here before the target can act on it.
  window.addEventListener('pointerdown', (event) => {
    if (contextMenu.hidden) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && contextMenu.contains(target)) {
      return;
    }
    closeContextMenu();
  }, true);
  window.addEventListener('wheel', () => closeContextMenu(), { capture: true, passive: true });
  window.addEventListener('keydown', (event) => {
    // Captured so an open menu swallows Esc before the canvas sees it.
    if (event.key !== 'Escape' || contextMenu.hidden) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeContextMenu();
  }, true);
  updateSnapControls();
}

async function loadDocument(data: MapDocumentData): Promise<void> {
  documentData = data;
  regionFile = structuredClone(data.regionFile);
  points = structuredClone(data.points);
  revision = 0;
  savedRevision = 0;
  selection = undefined;
  selectedKeys.clear();
  pastePreview = undefined;
  activePastePlacement = undefined;
  instanceLinks = hydrateInstanceLinks(data.instanceLinks);
  pasteDialog.hidden = true;
  closeContextMenu();
  pendingContextMenu = undefined;
  marquee = undefined;
  cancelSidebarScrollAnimation();
  sidebarRevealedKey = undefined;
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

  const counterparts = collectLinkedKeys(selectedKeys);
  for (const region of regionFile.regions) {
    drawRegion(region, isEntitySelected('region', region.index), false);
  }
  if (previewRegion !== undefined) {
    drawRegion(previewRegion, true, true);
  }
  for (const point of points) {
    drawPoint(point, isEntitySelected('point', point.id));
  }
  if (pastePreview !== undefined) {
    for (const region of pastePreview.regions) {
      drawRegion(region, false, true);
    }
    for (const point of pastePreview.points) {
      drawPoint(point, false, true);
    }
  }
  drawInstanceMarkers(counterparts);
  drawSnapGuides();
  drawMarquee();
}

/** Rings the objects that an instance link ties to the current selection. */
function drawInstanceMarkers(counterparts: Set<string>): void {
  if (counterparts.size === 0) {
    return;
  }
  overlayContext.save();
  overlayContext.strokeStyle = 'rgba(110, 231, 213, 0.95)';
  overlayContext.lineWidth = 2;
  overlayContext.setLineDash([4, 3]);
  for (const region of regionFile.regions) {
    if (!counterparts.has(entityKey('region', region.index))) {
      continue;
    }
    const polygon = regionScreenPolygon(region);
    if (polygon.length !== 4) {
      continue;
    }
    overlayContext.beginPath();
    overlayContext.moveTo(polygon[0]!.x, polygon[0]!.y);
    for (let index = 1; index < polygon.length; index += 1) {
      overlayContext.lineTo(polygon[index]!.x, polygon[index]!.y);
    }
    overlayContext.closePath();
    overlayContext.stroke();
  }
  for (const point of points) {
    if (!counterparts.has(entityKey('point', point.id))) {
      continue;
    }
    const screen = worldToScreen(point.x, point.y, terrainHeightAt(point.x, point.y) + 32);
    if (screen === undefined) {
      continue;
    }
    overlayContext.beginPath();
    overlayContext.arc(screen.x, screen.y, 11, 0, Math.PI * 2);
    overlayContext.stroke();
  }
  overlayContext.restore();
}

function drawMarquee(): void {
  if (marquee === undefined) {
    return;
  }
  const left = Math.min(marquee.startScreen.x, marquee.currentScreen.x);
  const top = Math.min(marquee.startScreen.y, marquee.currentScreen.y);
  const width = Math.abs(marquee.currentScreen.x - marquee.startScreen.x);
  const height = Math.abs(marquee.currentScreen.y - marquee.startScreen.y);
  overlayContext.save();
  overlayContext.fillStyle = 'rgba(79, 156, 255, 0.12)';
  overlayContext.strokeStyle = 'rgba(110, 184, 255, 0.95)';
  overlayContext.lineWidth = 1;
  overlayContext.setLineDash([5, 4]);
  overlayContext.fillRect(left, top, width, height);
  overlayContext.strokeRect(left + 0.5, top + 0.5, width, height);
  overlayContext.restore();
}

function isEntitySelected(kind: 'region' | 'point', id: number | string): boolean {
  return selectedKeys.has(entityKey(kind, id));
}

function entityKey(kind: 'region' | 'point', id: number | string): string {
  return `${kind}:${String(id)}`;
}

function setSingleSelection(next: Selection): void {
  selection = next;
  selectedKeys = new Set([selectionKey(next)]);
}

function selectionKey(next: Selection): string {
  return next.kind === 'region'
    ? entityKey('region', next.index)
    : entityKey('point', next.id);
}

function toggleEntitySelection(kind: 'region' | 'point', id: number | string): void {
  const key = entityKey(kind, id);
  if (selectedKeys.has(key)) {
    selectedKeys.delete(key);
  } else {
    selectedKeys.add(key);
  }
  selection = firstSelectionForActiveTab();
}

function firstSelectionForActiveTab(): Selection | undefined {
  for (const key of selectedKeys) {
    const next = selectionFromKey(key);
    if (next !== undefined && next.kind === (activeTab === 'regions' ? 'region' : 'point')) {
      return next;
    }
  }
  return undefined;
}

function selectionFromKey(key: string): Selection | undefined {
  const separator = key.indexOf(':');
  if (separator <= 0) {
    return undefined;
  }
  const kind = key.slice(0, separator);
  const value = key.slice(separator + 1);
  if (kind === 'region') {
    const index = Number(value);
    return Number.isFinite(index) && findRegion(index) !== undefined
      ? { kind: 'region', index }
      : undefined;
  }
  return kind === 'point' && findPoint(value) !== undefined
    ? { kind: 'point', id: value }
    : undefined;
}

function captureSelectedPointPositions(): DragPointPosition[] {
  return [...selectedKeys]
    .map((key) => selectionFromKey(key))
    .filter((item): item is { kind: 'point'; id: string } => item?.kind === 'point')
    .map((item) => findPoint(item.id))
    .filter((point): point is ScriptPoint => point !== undefined)
    .map((point) => ({ id: point.id, x: point.x, y: point.y }));
}

function captureSelectedRegionPositions(): DragRegionPosition[] {
  return [...selectedKeys]
    .map((key) => selectionFromKey(key))
    .filter((item): item is { kind: 'region'; index: number } => item?.kind === 'region')
    .map((item) => findRegion(item.index))
    .filter((region): region is RegionData => region !== undefined)
    .map((region) => ({
      index: region.index,
      left: region.left,
      bottom: region.bottom,
      right: region.right,
      top: region.top
    }));
}

function updateMarqueeSelection(): void {
  if (marquee === undefined) {
    return;
  }
  const rect = screenRect(marquee.startScreen, marquee.currentScreen);
  const keys: string[] = [];
  if (activeTab === 'points') {
    for (const point of points) {
      const screen = worldToScreen(point.x, point.y, terrainHeightAt(point.x, point.y) + 32);
      if (screen !== undefined && pointInScreenRect(screen.x, screen.y, rect)) {
        keys.push(entityKey('point', point.id));
      }
    }
  } else {
    for (const region of regionFile.regions) {
      const polygon = regionScreenPolygon(region);
      if (polygon.length !== 4) {
        continue;
      }
      const bounds = screenBounds(polygon);
      if (bounds.left >= rect.left && bounds.right <= rect.right &&
          bounds.top >= rect.top && bounds.bottom <= rect.bottom) {
        keys.push(entityKey('region', region.index));
      }
    }
  }
  selectedKeys = new Set(keys);
  selection = firstSelectionForActiveTab();
}

function screenRect(start: { x: number; y: number }, end: { x: number; y: number }): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y)
  };
}

function pointInScreenRect(x: number, y: number, rect: ReturnType<typeof screenRect>): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function screenBounds(pointsToMeasure: Array<{ x: number; y: number }>): ReturnType<typeof screenRect> {
  const xs = pointsToMeasure.map((point) => point.x);
  const ys = pointsToMeasure.map((point) => point.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys)
  };
}

function copySelection(): void {
  const keys = selectedKeys.size > 0
    ? [...selectedKeys]
    : selection === undefined ? [] : [selectionKey(selection)];
  const copiedPoints = keys
    .map((key) => selectionFromKey(key))
    .filter((item): item is { kind: 'point'; id: string } => item?.kind === 'point')
    .map((item) => findPoint(item.id))
    .filter((point): point is ScriptPoint => point !== undefined);
  const copiedRegions = keys
    .map((key) => selectionFromKey(key))
    .filter((item): item is { kind: 'region'; index: number } => item?.kind === 'region')
    .map((item) => findRegion(item.index))
    .filter((region): region is RegionData => region !== undefined);
  if (copiedPoints.length === 0 && copiedRegions.length === 0) {
    setStatus('没有可复制的点或区域');
    return;
  }
  const bounds = selectionWorldBounds(copiedPoints, copiedRegions);
  clipboard = {
    center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
    points: structuredClone(copiedPoints),
    regions: structuredClone(copiedRegions)
  };
  setStatus(`已复制 ${copiedPoints.length + copiedRegions.length} 个对象`);
}

function selectionWorldBounds(copiedPoints: ScriptPoint[], copiedRegions: RegionData[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const xs = copiedPoints.map((point) => point.x);
  const ys = copiedPoints.map((point) => point.y);
  for (const region of copiedRegions) {
    xs.push(region.left, region.right);
    ys.push(region.bottom, region.top);
  }
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function pasteSelection(): void {
  if (clipboard === undefined) {
    setStatus('剪贴板中没有点或区域');
    return;
  }
  if (isPasteDialogOpen()) {
    return;
  }
  const count = clipboard.points.length + clipboard.regions.length;
  if (count > 1) {
    openPasteDialog(count);
    return;
  }
  // A lone object has no internal layout to mirror or link, so keep the
  // original one-key paste flow untouched.
  startPastePlacement({ mode: 'normal', mirror: 'none' });
}

function startPastePlacement(placement: PastePlacement): void {
  if (clipboard === undefined) {
    return;
  }
  cancelDrag();
  activePastePlacement = placement;
  pastePreview = createPastePreview(clipboard.center);
  selection = undefined;
  selectedKeys.clear();
  marquee = undefined;
  const modeText = placement.mode === 'instance' ? '实例' : '普通';
  const mirrorText = placement.mirror === 'none'
    ? ''
    : ` · 镜像${placement.mirror === 'horizontal' ? '左右' : '上下'}`;
  setStatus(`粘贴预览（${modeText}${mirrorText}）：移动鼠标后单击放置，Esc 取消`);
  renderSidebar();
  renderInspector();
  renderOverlay();
}

function openPasteDialog(count: number): void {
  pasteDialogHint.textContent = `将粘贴 ${count} 个对象`;
  pasteModeInstanceInput.checked = true;
  pasteModeNormalInput.checked = false;
  pasteMirrorInput.checked = false;
  pasteMirrorAxisInput.value = 'horizontal';
  updatePasteMirrorControls();
  pasteDialog.hidden = false;
  pasteModeInstanceInput.focus();
}

function isPasteDialogOpen(): boolean {
  return !pasteDialog.hidden;
}

function closePasteDialog(): void {
  if (!isPasteDialogOpen()) {
    return;
  }
  pasteDialog.hidden = true;
  overlay.focus();
}

function confirmPasteDialog(): void {
  if (!isPasteDialogOpen()) {
    return;
  }
  const placement: PastePlacement = {
    mode: pasteModeNormalInput.checked ? 'normal' : 'instance',
    mirror: pasteMirrorInput.checked
      ? pasteMirrorAxisInput.value === 'vertical' ? 'vertical' : 'horizontal'
      : 'none'
  };
  closePasteDialog();
  startPastePlacement(placement);
}

function updatePasteMirrorControls(): void {
  pasteMirrorAxisInput.disabled = !pasteMirrorInput.checked;
}

function createPastePreview(center: { x: number; y: number }): PastePreview {
  const source = clipboard!;
  const signs = mirrorSigns(activePastePlacement?.mirror ?? 'none');
  const mapPoint = (x: number, y: number): { x: number; y: number } => ({
    x: center.x + (x - source.center.x) * signs.x,
    y: center.y + (y - source.center.y) * signs.y
  });
  return {
    center: { ...center },
    points: source.points.map((point) => {
      const mapped = mapPoint(point.x, point.y);
      return { ...point, id: `preview-${point.id}`, x: mapped.x, y: mapped.y };
    }),
    regions: source.regions.map((region) => {
      // Mirroring swaps which corner ends up min/max, so rebuild the rectangle
      // from the projected corners instead of shifting edges independently.
      const first = mapPoint(region.left, region.bottom);
      const second = mapPoint(region.right, region.top);
      return {
        ...structuredClone(region),
        left: Math.min(first.x, second.x),
        right: Math.max(first.x, second.x),
        bottom: Math.min(first.y, second.y),
        top: Math.max(first.y, second.y),
        index: -1
      };
    })
  };
}

function updatePastePreview(center: { x: number; y: number }): void {
  if (pastePreview === undefined || clipboard === undefined) {
    return;
  }
  pastePreview = createPastePreview(center);
}

function placePaste(): void {
  if (pastePreview === undefined || clipboard === undefined) {
    return;
  }
  const placement: PastePlacement = activePastePlacement ?? { mode: 'normal', mirror: 'none' };
  const before = captureSnapshot();
  const usedPointNames = points.map((point) => point.name);
  const pastedPoints = pastePreview.points.map((point) => {
    const name = usedPointNames.includes(point.name) ? nextName(point.name, usedPointNames) : point.name;
    usedPointNames.push(name);
    return { ...point, id: crypto.randomUUID(), name };
  });
  const usedRegionNames = regionFile.regions.map((region) => region.name);
  let nextIndex = Math.max(-1, ...regionFile.regions.map((region) => region.index)) + 1;
  const pastedRegions = pastePreview.regions.map((region) => {
    const name = usedRegionNames.includes(region.name) ? nextName(region.name, usedRegionNames) : region.name;
    usedRegionNames.push(name);
    return { ...region, index: nextIndex++, name };
  });
  points.push(...pastedPoints);
  regionFile.regions.push(...pastedRegions);
  let linkCount = 0;
  if (placement.mode === 'instance') {
    // The preview keeps the clipboard order, so position N of the pasted group
    // is the copy of position N of the source group. Every pair shares the same
    // affine map, so one offset describes the whole link set — and because the
    // map is affine, that single offset is exactly what `linkOffset` recovers
    // from the two groups' coordinates on the next load.
    const source = clipboard;
    const offset = groupOffset(source.center, pastePreview.center, placement.mirror);
    source.points.forEach((origin, position) => {
      const pasted = pastedPoints[position];
      if (pasted === undefined) {
        return;
      }
      instanceLinks.push({
        source: entityKey('point', origin.id),
        target: entityKey('point', pasted.id),
        axis: placement.mirror,
        offset
      });
      linkCount += 1;
    });
    source.regions.forEach((origin, position) => {
      const pasted = pastedRegions[position];
      if (pasted === undefined) {
        return;
      }
      instanceLinks.push({
        source: entityKey('region', origin.index),
        target: entityKey('region', pasted.index),
        axis: placement.mirror,
        offset
      });
      linkCount += 1;
    });
  }
  selectedKeys = new Set([
    ...pastedPoints.map((point) => entityKey('point', point.id)),
    ...pastedRegions.map((region) => entityKey('region', region.index))
  ]);
  selection = pastedPoints.length > 0
    ? { kind: 'point', id: pastedPoints[0]!.id }
    : pastedRegions.length > 0
      ? { kind: 'region', index: pastedRegions[0]!.index }
      : undefined;
  pastePreview = undefined;
  activePastePlacement = undefined;
  commitDocumentChange(
    linkCount > 0
      ? `已实例粘贴对象（${linkCount} 组联动）`
      : '已粘贴对象',
    before
  );
}

/**
 * Rebuilds the in-memory links from the instances sidecar.
 *
 * The affine offset is deliberately not stored, so it is derived here from
 * where the two entities currently sit. That keeps the file free of duplicated
 * positions and means an external edit to points.json or the W3R redefines the
 * pair instead of being silently overwritten on the next drag.
 */
function hydrateInstanceLinks(stored: InstanceLinkData[] | undefined): InstanceLink[] {
  const links: InstanceLink[] = [];
  for (const entry of stored ?? []) {
    const anchor = linkAnchor(entry.source);
    const counterpart = linkAnchor(entry.target);
    if (anchor === undefined || counterpart === undefined) {
      continue;
    }
    links.push({
      source: entry.source,
      target: entry.target,
      axis: entry.axis,
      offset: linkOffset(anchor, counterpart, entry.axis)
    });
  }
  return links;
}

/**
 * The two opposite corners a link is anchored on. A point is a single
 * coordinate so both corners coincide; a region contributes its normalised
 * (left, bottom) and (right, top) corners.
 */
function linkAnchor(key: string): LinkBox | undefined {
  const item = selectionFromKey(key);
  if (item === undefined) {
    return undefined;
  }
  if (item.kind === 'point') {
    const point = findPoint(item.id);
    if (point === undefined) {
      return undefined;
    }
    const at = { x: point.x, y: point.y };
    return { min: at, max: at };
  }
  const region = findRegion(item.index);
  if (region === undefined) {
    return undefined;
  }
  return {
    min: { x: region.left, y: region.bottom },
    max: { x: region.right, y: region.top }
  };
}

/**
 * The entity under the cursor, but only when an instance link actually touches
 * it. Anything else returns undefined and leaves the right button as a plain
 * camera drag, so unlinked objects never grow a menu they cannot use.
 */
function linkedEntityAt(screen: { x: number; y: number }): PendingContextMenu | undefined {
  if (instanceLinks.length === 0) {
    return undefined;
  }
  const key = entityKeyAt(screen);
  if (key === undefined || !isLinkedEntity(key)) {
    return undefined;
  }
  return { key, screen };
}

function entityKeyAt(screen: { x: number; y: number }): string | undefined {
  const point = activeTab === 'points' ? hitTestPoint(screen.x, screen.y) : undefined;
  if (point !== undefined) {
    return entityKey('point', point.id);
  }
  const region = hitTestRegion(screen.x, screen.y);
  return region === undefined ? undefined : entityKey('region', region.region.index);
}

function isLinkedEntity(key: string): boolean {
  return instanceLinks.some((link) => link.source === key || link.target === key);
}

/** The subset of `keys` that at least one instance link touches. */
function linkedKeysWithin(keys: Iterable<string>): Set<string> {
  const linked = new Set<string>();
  for (const key of keys) {
    if (isLinkedEntity(key)) {
      linked.add(key);
    }
  }
  return linked;
}

/**
 * Opens the unlink menu for the entity that was right-clicked. It always acts
 * on the current selection, so right-clicking a linked entity outside the
 * selection first selects it, while right-clicking one inside a multi-selection
 * unlinks the whole selection at once.
 */
function openContextMenu(key: string, clientX: number, clientY: number): void {
  if (!selectedKeys.has(key)) {
    const next = selectionFromKey(key);
    if (next !== undefined) {
      setSingleSelection(next);
      renderSidebar();
      renderInspector();
      renderOverlay();
    }
  }
  const affected = linkedKeysWithin(selectedKeys);
  if (affected.size === 0) {
    return;
  }
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'context-menu-item';
  item.setAttribute('role', 'menuitem');
  item.textContent = affected.size > 1
    ? `解除实例关联（${affected.size} 个对象）`
    : '解除实例关联';
  item.addEventListener('click', () => {
    closeContextMenu();
    unlinkEntities(affected);
  });
  contextMenu.replaceChildren(item);
  contextMenu.hidden = false;
  positionContextMenu(clientX, clientY);
}

function positionContextMenu(clientX: number, clientY: number): void {
  const margin = 4;
  const left = clamp(clientX, margin, window.innerWidth - contextMenu.offsetWidth - margin);
  const top = clamp(clientY, margin, window.innerHeight - contextMenu.offsetHeight - margin);
  contextMenu.style.left = `${Math.round(left)}px`;
  contextMenu.style.top = `${Math.round(top)}px`;
}

function closeContextMenu(): void {
  if (contextMenu.hidden) {
    return;
  }
  contextMenu.hidden = true;
  contextMenu.replaceChildren();
}

/**
 * Breaks every link that touches `keys`. The entities themselves stay exactly
 * where they are — only the relation goes away, which is also why this is a
 * plain undoable document change.
 */
function unlinkEntities(keys: Set<string>): void {
  const before = captureSnapshot();
  const remaining = instanceLinks.filter(
    (link) => !keys.has(link.source) && !keys.has(link.target)
  );
  const removed = instanceLinks.length - remaining.length;
  if (removed === 0) {
    return;
  }
  instanceLinks = remaining;
  commitDocumentChange(
    removed > 1 ? `已解除 ${removed} 组实例关联` : '已解除实例关联',
    before
  );
}

/** Drops the derived offset so only the topology reaches disk. */
function serializeInstanceLinks(): InstanceLinkData[] {
  return instanceLinks.map((link) => ({
    source: link.source,
    target: link.target,
    axis: link.axis
  }));
}

/**
 * Re-derives every entity that an instance link ties to `changedKeys`, walking
 * outward so a copy of a copy also follows. Entities that were edited directly
 * are seeded as already visited, so a group that is dragged as a whole is never
 * fought over by its own links.
 */
function propagateInstanceLinks(changedKeys: Iterable<string>): void {
  const direct = [...changedKeys];
  if (direct.length === 0 || instanceLinks.length === 0) {
    return;
  }
  const visited = new Set(direct);
  const queue = [...direct];
  while (queue.length > 0) {
    const key = queue.shift()!;
    for (const link of instanceLinks) {
      const forward = link.source === key;
      if (!forward && link.target !== key) {
        continue;
      }
      const neighbour = forward ? link.target : link.source;
      if (visited.has(neighbour)) {
        continue;
      }
      visited.add(neighbour);
      if (applyLinkTransform(link, forward, neighbour)) {
        queue.push(neighbour);
      }
    }
  }
}

/** Writes one side of an instance link onto the other. Returns false when stale. */
function applyLinkTransform(link: InstanceLink, forward: boolean, neighbourKey: string): boolean {
  const sourceKey = forward ? link.source : link.target;
  const source = selectionFromKey(sourceKey);
  const neighbour = selectionFromKey(neighbourKey);
  if (source === undefined || neighbour === undefined) {
    return false;
  }
  const signs = mirrorSigns(link.axis);
  const mapX = forward
    ? (value: number): number => signs.x * value + link.offset.x
    : (value: number): number => signs.x * (value - link.offset.x);
  const mapY = forward
    ? (value: number): number => signs.y * value + link.offset.y
    : (value: number): number => signs.y * (value - link.offset.y);

  if (source.kind === 'point' && neighbour.kind === 'point') {
    const from = findPoint(source.id);
    const to = findPoint(neighbour.id);
    if (from === undefined || to === undefined) {
      return false;
    }
    to.x = roundCoordinate(mapX(from.x));
    to.y = roundCoordinate(mapY(from.y));
    return true;
  }
  if (source.kind === 'region' && neighbour.kind === 'region') {
    const from = findRegion(source.index);
    const to = findRegion(neighbour.index);
    if (from === undefined || to === undefined) {
      return false;
    }
    // Reflect both corners and rebuild the extents: mirroring swaps which
    // corner is min/max, so left/right and bottom/top cannot be shifted alone.
    const first = { x: mapX(from.left), y: mapY(from.bottom) };
    const second = { x: mapX(from.right), y: mapY(from.top) };
    to.left = roundCoordinate(Math.min(first.x, second.x));
    to.right = roundCoordinate(Math.max(first.x, second.x));
    to.bottom = roundCoordinate(Math.min(first.y, second.y));
    to.top = roundCoordinate(Math.max(first.y, second.y));
    clampRegionToTerrain(to);
    return true;
  }
  return false;
}

/** Entity keys tied to `seedKeys` through instance links, seed keys excluded. */
function collectLinkedKeys(seedKeys: Iterable<string>): Set<string> {
  const result = new Set<string>();
  if (instanceLinks.length === 0) {
    return result;
  }
  const visited = new Set(seedKeys);
  if (visited.size === 0) {
    return result;
  }
  const queue = [...visited];
  while (queue.length > 0) {
    const key = queue.shift()!;
    for (const link of instanceLinks) {
      const neighbour = link.source === key
        ? link.target
        : link.target === key
          ? link.source
          : undefined;
      if (neighbour === undefined || visited.has(neighbour)) {
        continue;
      }
      visited.add(neighbour);
      result.add(neighbour);
      queue.push(neighbour);
    }
  }
  return result;
}

/**
 * Snap targets to ignore while dragging: the entities that are being written to
 * this frame. Linked copies are derived from the dragged objects, so treating
 * them as anchors would feed the drag back into itself.
 */
function movingSnapTargets(directKeys: string[]): { pointIds: Set<string>; regionIndexes: Set<number> } {
  const pointIds = new Set<string>();
  const regionIndexes = new Set<number>();
  const keys = new Set(directKeys);
  for (const key of collectLinkedKeys(keys)) {
    keys.add(key);
  }
  for (const key of keys) {
    const item = selectionFromKey(key);
    if (item === undefined) {
      continue;
    }
    if (item.kind === 'point') {
      pointIds.add(item.id);
    } else {
      regionIndexes.add(item.index);
    }
  }
  return { pointIds, regionIndexes };
}

function cancelPastePreview(): void {
  if (pastePreview === undefined) {
    return;
  }
  pastePreview = undefined;
  activePastePlacement = undefined;
  setStatus('已取消粘贴');
  renderOverlay();
}

function drawSnapGuides(): void {
  if (snapGuides.length === 0) {
    return;
  }

  overlayContext.save();
  overlayContext.font = '12px Segoe UI, sans-serif';
  overlayContext.textBaseline = 'middle';
  overlayContext.lineWidth = 1;
  for (const guide of snapGuides) {
    const sourceScreen = worldToScreen(
      guide.source.x,
      guide.source.y,
      terrainHeightAt(guide.source.x, guide.source.y) + REGION_OVERLAY_HEIGHT_OFFSET
    );
    const anchorScreen = worldToScreen(
      guide.anchor.x,
      guide.anchor.y,
      terrainHeightAt(guide.anchor.x, guide.anchor.y) + REGION_OVERLAY_HEIGHT_OFFSET
    );
    if (sourceScreen === undefined || anchorScreen === undefined) {
      continue;
    }

    const color = guide.axis === 'x' ? '#63d5ff' : '#ffbb61';
    overlayContext.strokeStyle = color;
    overlayContext.fillStyle = color;
    overlayContext.setLineDash([6, 4]);
    overlayContext.beginPath();
    overlayContext.moveTo(sourceScreen.x, sourceScreen.y);
    overlayContext.lineTo(anchorScreen.x, anchorScreen.y);
    overlayContext.stroke();

    overlayContext.setLineDash([]);
    drawRulerTicks(sourceScreen, anchorScreen, color);

    // The useful measurement is the gap between the aligned objects, not the
    // small pre-snap error. X alignment measures the Y gap and vice versa.
    const gap = guide.axis === 'x'
      ? Math.abs(guide.source.y - guide.anchor.y)
      : Math.abs(guide.source.x - guide.anchor.x);
    const label = `${gap.toFixed(0)}码`;
    const labelX = (sourceScreen.x + anchorScreen.x) / 2;
    const labelY = (sourceScreen.y + anchorScreen.y) / 2 - (guide.axis === 'x' ? 10 : 18);
    drawGuideLabel(label, labelX, labelY, color);
    overlayContext.lineWidth = 1;
  }
  overlayContext.restore();
}

function drawRulerTicks(
  start: { x: number; y: number },
  end: { x: number; y: number },
  color: string
): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 2) {
    return;
  }
  const normalX = -dy / length * 4;
  const normalY = dx / length * 4;
  overlayContext.strokeStyle = color;
  overlayContext.beginPath();
  overlayContext.moveTo(start.x - normalX, start.y - normalY);
  overlayContext.lineTo(start.x + normalX, start.y + normalY);
  overlayContext.moveTo(end.x - normalX, end.y - normalY);
  overlayContext.lineTo(end.x + normalX, end.y + normalY);
  overlayContext.stroke();
}

function drawGuideLabel(label: string, x: number, y: number, color: string): void {
  const metrics = overlayContext.measureText(label);
  const safeX = clamp(x, metrics.width / 2 + 4, Math.max(metrics.width / 2 + 4, viewport.clientWidth - metrics.width / 2 - 4));
  const safeY = clamp(y, 4, Math.max(4, viewport.clientHeight - 4));
  overlayContext.save();
  overlayContext.shadowColor = 'rgba(0, 0, 0, 0.95)';
  overlayContext.shadowBlur = 3;
  overlayContext.shadowOffsetX = 1;
  overlayContext.shadowOffsetY = 1;
  overlayContext.fillStyle = color;
  overlayContext.textAlign = 'center';
  overlayContext.fillText(label, safeX, safeY);
  overlayContext.restore();
}

function drawRegion(region: RegionData, selected: boolean, preview: boolean): void {
  const polygon = regionScreenPolygon(region);
  // A rectangle must have four valid projected corners. Connecting a partial
  // polygon can produce a long line when a corner is behind the camera.
  if (polygon.length !== 4) {
    return;
  }
  overlayContext.save();
  if (preview) {
    overlayContext.globalAlpha = 0.42;
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
  overlayContext.restore();
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

function drawPoint(point: ScriptPoint, selected: boolean, preview = false): void {
  const screen = worldToScreen(
    point.x,
    point.y,
    terrainHeightAt(point.x, point.y) + 32
  );
  if (screen === undefined) {
    return;
  }
  overlayContext.save();
  if (preview) {
    overlayContext.globalAlpha = 0.42;
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
  overlayContext.restore();
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
    // The right button belongs to the camera and nothing else: a floating paste
    // preview is cancelled with Esc only, so right-drag keeps panning while a
    // preview is up. Separately, a right click that lands on an instance-linked
    // entity queues the unlink menu, which opens only when the button comes back
    // up without dragging (see pointerUp).
    pendingContextMenu = pastePreview === undefined ? linkedEntityAt(screen) : undefined;
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
    snapGuides = [];
    return;
  }
  if (event.button !== 0) {
    return;
  }
  if (pastePreview !== undefined) {
    updatePastePreview(world);
    placePaste();
    return;
  }

  if (mode === 'region') {
    snapGuides = [];
    const region = createRegion(world.x, world.y, world.x, world.y);
    previewRegion = region;
    drag = { type: 'newRegion', startScreen: screen, startWorld: world };
    renderOverlay();
    return;
  }
  if (mode === 'point') {
    snapGuides = [];
    const before = captureSnapshot();
    const point: ScriptPoint = {
      id: crypto.randomUUID(),
      name: nextName('point', points.map((item) => item.name)),
      x: roundCoordinate(world.x),
      y: roundCoordinate(world.y)
    };
    points.push(point);
    setSingleSelection({ kind: 'point', id: point.id });
    setTab('points');
    commitDocumentChange('已创建逻辑点', before);
    return;
  }

  const pointHit = activeTab === 'points' ? hitTestPoint(screen.x, screen.y) : undefined;
  if (pointHit !== undefined) {
    snapGuides = [];
    if (event.shiftKey) {
      toggleEntitySelection('point', pointHit.id);
      renderSidebar();
      renderInspector();
      renderOverlay();
      return;
    }
    const preserveSelection = selectedKeys.has(entityKey('point', pointHit.id)) && selectedKeys.size > 1;
    if (preserveSelection) {
      selection = pointHit;
    } else {
      setSingleSelection(pointHit);
    }
    const point = findPoint(pointHit.id)!;
    const planeHeight = terrainHeightAt(point.x, point.y);
    const selectedPoints = preserveSelection ? captureSelectedPointPositions() : [];
    const selectedRegions = preserveSelection ? captureSelectedRegionPositions() : [];
    drag = selectedPoints.length + selectedRegions.length > 1
      ? {
          type: 'moveSelection',
          startScreen: screen,
          startWorld: screenToWorldAtHeight(screen.x, screen.y, planeHeight),
          planeHeight,
          selectedPoints,
          selectedRegions,
          historyBefore: captureSnapshot()
        }
      : {
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
    snapGuides = [];
    const region = regionHit.region;
    const regionSelection: Selection = { kind: 'region', index: region.index };
    if (event.shiftKey) {
      toggleEntitySelection('region', region.index);
      renderSidebar();
      renderInspector();
      renderOverlay();
      return;
    }
    const preserveSelection = selectedKeys.has(entityKey('region', region.index)) && selectedKeys.size > 1;
    if (preserveSelection) {
      selection = regionSelection;
    } else {
      setSingleSelection(regionSelection);
    }
    const centerX = (region.left + region.right) / 2;
    const centerY = (region.bottom + region.top) / 2;
    // Region overlays are rendered on a small offset plane above the terrain.
    // Use that exact plane for pointer intersection so a dragged edge/corner
    // remains under the cursor at every camera angle.
    const planeHeight = regionRenderHeight(region);
    const selectedPoints = preserveSelection ? captureSelectedPointPositions() : [];
    const selectedRegions = preserveSelection ? captureSelectedRegionPositions() : [];
    drag = regionHit.handle === 'center' && selectedPoints.length + selectedRegions.length > 1
      ? {
          type: 'moveSelection',
          startScreen: screen,
          startWorld: screenToWorldAtHeight(screen.x, screen.y, planeHeight),
          planeHeight,
          selectedPoints,
          selectedRegions,
          historyBefore: captureSnapshot()
        }
      : {
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
  } else if (mode === 'select') {
    snapGuides = [];
    selection = undefined;
    selectedKeys.clear();
    marquee = { startScreen: screen, currentScreen: screen };
    drag = { type: 'marquee', startScreen: screen, startWorld: world };
    renderSidebar();
    renderInspector();
    renderOverlay();
  }
}

function pointerMove(event: PointerEvent): void {
  const screen = localScreen(event);
  const world = screenToWorld(screen.x, screen.y);
  coordinateText.textContent = `X ${roundCoordinate(world.x)}  Y ${roundCoordinate(world.y)}`;
  if (pendingContextMenu !== undefined && Math.hypot(
    screen.x - pendingContextMenu.screen.x,
    screen.y - pendingContextMenu.screen.y
  ) > CONTEXT_MENU_DRAG_SLOP) {
    // The camera is moving, so this right press was a drag, not a menu click.
    pendingContextMenu = undefined;
  }
  if (pastePreview !== undefined && drag === undefined) {
    updatePastePreview(world);
    renderOverlay();
    return;
  }
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
  } else if (drag.type === 'marquee' && marquee !== undefined) {
    marquee.currentScreen = screen;
    updateMarqueeSelection();
    renderSidebar();
    renderInspector();
    renderOverlay();
  } else if (drag.type === 'newRegion' && previewRegion !== undefined) {
    previewRegion.left = Math.min(drag.startWorld.x, world.x);
    previewRegion.right = Math.max(drag.startWorld.x, world.x);
    previewRegion.bottom = Math.min(drag.startWorld.y, world.y);
    previewRegion.top = Math.max(drag.startWorld.y, world.y);
    renderOverlay();
  } else if (
    drag.type === 'moveSelection' &&
    drag.selectedPoints !== undefined &&
    drag.selectedRegions !== undefined
  ) {
    const moveWorld = screenToWorldAtHeight(screen.x, screen.y, drag.planeHeight ?? 0);
    const rawDx = moveWorld.x - drag.startWorld.x;
    const rawDy = moveWorld.y - drag.startWorld.y;
    const draggedKeys = [
      ...drag.selectedPoints.map((point) => entityKey('point', point.id)),
      ...drag.selectedRegions.map((region) => entityKey('region', region.index))
    ];
    const snapped = snapSelectionTranslation(
      drag.selectedPoints,
      drag.selectedRegions,
      rawDx,
      rawDy,
      movingSnapTargets(draggedKeys)
    );
    for (const original of drag.selectedPoints) {
      const point = findPoint(original.id);
      if (point !== undefined) {
        point.x = roundCoordinate(original.x + snapped.dx);
        point.y = roundCoordinate(original.y + snapped.dy);
      }
    }
    for (const original of drag.selectedRegions) {
      const region = findRegion(original.index);
      if (region !== undefined) {
        region.left = roundCoordinate(original.left + snapped.dx);
        region.right = roundCoordinate(original.right + snapped.dx);
        region.bottom = roundCoordinate(original.bottom + snapped.dy);
        region.top = roundCoordinate(original.top + snapped.dy);
        clampRegionToTerrain(region);
      }
    }
    snapGuides = snapped.guides;
    propagateInstanceLinks(draggedKeys);
    renderInspector();
    renderOverlay();
  } else if (drag.type === 'movePoint' && drag.originalCenter !== undefined && selection?.kind === 'point') {
    const point = findPoint(selection.id);
    if (point !== undefined) {
      const moveWorld = screenToWorldAtHeight(screen.x, screen.y, drag.planeHeight ?? 0);
      const rawPosition = {
        x: drag.originalCenter.x + moveWorld.x - drag.startWorld.x,
        y: drag.originalCenter.y + moveWorld.y - drag.startWorld.y
      };
      const snapped = snapPointPosition(
        rawPosition,
        point.id,
        movingSnapTargets([entityKey('point', point.id)])
      );
      point.x = snapped.x;
      point.y = snapped.y;
      snapGuides = snapped.guides;
      propagateInstanceLinks([entityKey('point', point.id)]);
      coordinateText.textContent =
        `X ${roundCoordinate(point.x)}  Y ${roundCoordinate(point.y)}` +
        (snapGuides.length === 0 ? '' : `  · ${snapGuides.map((guide) => guide.axis.toUpperCase()).join('/') } 对齐`);
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
      const draggedRegionKey = entityKey('region', selection.index);
      snapGuides = snapRegionTranslation(
        region,
        selection.index,
        movingSnapTargets([draggedRegionKey])
      );
      propagateInstanceLinks([draggedRegionKey]);
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
      snapGuides = snapRegionResize(region, drag.regionHandle, selection.index);
      propagateInstanceLinks([entityKey('region', selection.index)]);
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
  snapGuides = [];
  const pendingMenu = pendingContextMenu;
  pendingContextMenu = undefined;
  if (completedDrag.type === 'marquee') {
    marquee = undefined;
    revealSelectionInSidebar();
    renderOverlay();
    return;
  }
  renderOverlay();
  if (overlay.hasPointerCapture(event.pointerId)) {
    overlay.releasePointerCapture(event.pointerId);
  }
  if (pendingMenu !== undefined && completedDrag.type === 'pan') {
    openContextMenu(pendingMenu.key, event.clientX, event.clientY);
  }

  if (completedDrag.type === 'newRegion' && previewRegion !== undefined) {
    const width = previewRegion.right - previewRegion.left;
    const height = previewRegion.top - previewRegion.bottom;
    if (width >= 16 && height >= 16) {
      const before = captureSnapshot();
      regionFile.regions.push(previewRegion);
      setSingleSelection({ kind: 'region', index: previewRegion.index });
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
    completedDrag.type === 'resizeRegion' ||
    completedDrag.type === 'moveSelection'
  ) {
    if (completedDrag.historyBefore !== undefined) {
      commitDocumentChange('位置已更新', completedDrag.historyBefore);
    }
  }
}

function cancelDrag(): void {
  const cancelledDrag = drag;
  drag = undefined;
  pendingContextMenu = undefined;
  previewRegion = undefined;
  marquee = undefined;
  snapGuides = [];
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

function snapPointPosition(
  raw: { x: number; y: number },
  draggedPointId: string,
  excluded?: { pointIds: Set<string>; regionIndexes: Set<number> }
): { x: number; y: number; guides: SnapGuide[] } {
  if (!snapEnabled) {
    return { x: roundCoordinate(raw.x), y: roundCoordinate(raw.y), guides: [] };
  }
  const pointIds = new Set(excluded?.pointIds ?? []);
  pointIds.add(draggedPointId);
  const nearby = buildSnapCandidates([raw], collectSnapAnchors({
    pointIds,
    regionIndexes: excluded?.regionIndexes
  }));

  const xCandidate = nearestSnapCandidate(nearby, (candidate) => Math.abs(candidate.anchor.x - raw.x));
  const yCandidate = nearestSnapCandidate(nearby, (candidate) => Math.abs(candidate.anchor.y - raw.y));
  const guides: SnapGuide[] = [];
  let x = raw.x;
  let y = raw.y;

  if (xCandidate !== undefined) {
    const delta = raw.x - xCandidate.anchor.x;
    if (Math.abs(delta) <= snapDistance) {
      x = xCandidate.anchor.x;
      guides.push({ axis: 'x', anchor: xCandidate.anchor, source: { x, y } });
    }
  }
  if (yCandidate !== undefined) {
    const delta = raw.y - yCandidate.anchor.y;
    if (Math.abs(delta) <= snapDistance) {
      y = yCandidate.anchor.y;
      guides.push({ axis: 'y', anchor: yCandidate.anchor, source: { x, y } });
    }
  }

  for (const guide of guides) {
    guide.source = { x, y };
  }
  return {
    x: roundCoordinate(x),
    y: roundCoordinate(y),
    guides
  };
}

function collectSnapAnchors(options: {
  pointId?: string;
  regionIndex?: number;
  pointIds?: Set<string>;
  regionIndexes?: Set<number>;
} = {}): SnapAnchor[] {
  const anchors: SnapAnchor[] = points
    .filter((point) => point.id !== options.pointId && !options.pointIds?.has(point.id))
    .map((point) => ({ x: point.x, y: point.y, label: point.name }));
  for (const region of regionFile.regions) {
    if (region.index === options.regionIndex || options.regionIndexes?.has(region.index)) {
      continue;
    }
    anchors.push(
      { x: region.left, y: region.bottom, label: `${region.name} 左下` },
      { x: region.right, y: region.bottom, label: `${region.name} 右下` },
      { x: region.right, y: region.top, label: `${region.name} 右上` },
      { x: region.left, y: region.top, label: `${region.name} 左上` }
    );
  }
  return anchors;
}

function snapSelectionTranslation(
  selectedPoints: DragPointPosition[],
  selectedRegions: DragRegionPosition[],
  rawDx: number,
  rawDy: number,
  excluded?: { pointIds: Set<string>; regionIndexes: Set<number> }
): { dx: number; dy: number; guides: SnapGuide[] } {
  if (!snapEnabled) {
    return { dx: rawDx, dy: rawDy, guides: [] };
  }

  const sources = [
    ...selectedPoints.map((point) => ({ x: point.x + rawDx, y: point.y + rawDy })),
    ...selectedRegions.flatMap((region) => regionCornerCoordinates({
      left: region.left + rawDx,
      bottom: region.bottom + rawDy,
      right: region.right + rawDx,
      top: region.top + rawDy
    }))
  ];
  const pointIds = new Set([...selectedPoints.map((point) => point.id), ...excluded?.pointIds ?? []]);
  const regionIndexes = new Set([
    ...selectedRegions.map((region) => region.index),
    ...excluded?.regionIndexes ?? []
  ]);
  const candidates = buildSnapCandidates(
    sources,
    collectSnapAnchors({ pointIds, regionIndexes })
  );
  const xCandidate = nearestSnapCandidate(candidates, (candidate) =>
    Math.abs(candidate.anchor.x - candidate.source.x)
  );
  const yCandidate = nearestSnapCandidate(candidates, (candidate) =>
    Math.abs(candidate.anchor.y - candidate.source.y)
  );
  const xShift = xCandidate === undefined ? 0 : xCandidate.anchor.x - xCandidate.source.x;
  const yShift = yCandidate === undefined ? 0 : yCandidate.anchor.y - yCandidate.source.y;
  const dx = rawDx + xShift;
  const dy = rawDy + yShift;
  return {
    dx,
    dy,
    guides: [
      ...(xCandidate === undefined ? [] : [{
        axis: 'x' as const,
        anchor: xCandidate.anchor,
        source: { x: xCandidate.source.x + xShift, y: xCandidate.source.y + dy - rawDy }
      }]),
      ...(yCandidate === undefined ? [] : [{
        axis: 'y' as const,
        anchor: yCandidate.anchor,
        source: { x: yCandidate.source.x + dx - rawDx, y: yCandidate.source.y + yShift }
      }])
    ]
  };
}

function buildSnapCandidates(sources: Array<{ x: number; y: number }>, anchors: SnapAnchor[]): SnapCandidate[] {
  return sources.flatMap((source) => anchors.map((anchor) => ({
    anchor,
    source,
    distance: Math.hypot(anchor.x - source.x, anchor.y - source.y)
  }))).filter((candidate) => candidate.distance <= SNAP_SEARCH_RADIUS);
}

function nearestSnapCandidate(
  candidates: SnapCandidate[],
  axisDistance: (candidate: SnapCandidate) => number
): SnapCandidate | undefined {
  return candidates
    .filter((candidate) => axisDistance(candidate) <= snapDistance)
    .sort((left, right) => {
      const axisDelta = axisDistance(left) - axisDistance(right);
      return axisDelta !== 0 ? axisDelta : left.distance - right.distance;
    })[0];
}

function snapRegionTranslation(
  region: RegionData,
  excludedRegionIndex: number,
  excluded?: { pointIds: Set<string>; regionIndexes: Set<number> }
): SnapGuide[] {
  if (!snapEnabled) {
    return [];
  }
  const sources = regionCornerCoordinates(region);
  const regionIndexes = new Set(excluded?.regionIndexes ?? []);
  regionIndexes.add(excludedRegionIndex);
  const candidates = buildSnapCandidates(sources, collectSnapAnchors({
    regionIndexes,
    pointIds: excluded?.pointIds
  }));
  const xCandidate = nearestSnapCandidate(candidates, (candidate) => Math.abs(candidate.anchor.x - candidate.source.x));
  const yCandidate = nearestSnapCandidate(candidates, (candidate) => Math.abs(candidate.anchor.y - candidate.source.y));
  const xShift = xCandidate === undefined ? 0 : xCandidate.anchor.x - xCandidate.source.x;
  const yShift = yCandidate === undefined ? 0 : yCandidate.anchor.y - yCandidate.source.y;
  if (xCandidate !== undefined) {
    region.left += xShift;
    region.right += xShift;
  }
  if (yCandidate !== undefined) {
    region.bottom += yShift;
    region.top += yShift;
  }
  clampRegionToTerrain(region);
  return [
    ...(xCandidate === undefined ? [] : [{
      axis: 'x' as const,
      anchor: xCandidate.anchor,
      source: { x: xCandidate.source.x + xShift, y: xCandidate.source.y + yShift }
    }]),
    ...(yCandidate === undefined ? [] : [{
      axis: 'y' as const,
      anchor: yCandidate.anchor,
      source: { x: yCandidate.source.x + xShift, y: yCandidate.source.y + yShift }
    }])
  ];
}

function snapRegionResize(region: RegionData, handle: RegionHandle, excludedRegionIndex: number): SnapGuide[] {
  if (!snapEnabled) {
    return [];
  }
  const sources = regionSnapSources(region, handle);
  const candidates = buildSnapCandidates(sources, collectSnapAnchors({ regionIndex: excludedRegionIndex }));
  const xCandidate = regionHandleAffectsAxis(handle, 'x')
    ? nearestSnapCandidate(candidates, (candidate) => Math.abs(candidate.anchor.x - candidate.source.x))
    : undefined;
  const yCandidate = regionHandleAffectsAxis(handle, 'y')
    ? nearestSnapCandidate(candidates, (candidate) => Math.abs(candidate.anchor.y - candidate.source.y))
    : undefined;
  const xShift = xCandidate === undefined ? 0 : xCandidate.anchor.x - xCandidate.source.x;
  const yShift = yCandidate === undefined ? 0 : yCandidate.anchor.y - yCandidate.source.y;
  if (xCandidate !== undefined) {
    if (handle.includes('West') || handle === 'west') {
      region.left = Math.min(region.right - 16, region.left + xShift);
    } else {
      region.right = Math.max(region.left + 16, region.right + xShift);
    }
  }
  if (yCandidate !== undefined) {
    if (handle.startsWith('south')) {
      region.bottom = Math.min(region.top - 16, region.bottom + yShift);
    } else {
      region.top = Math.max(region.bottom + 16, region.top + yShift);
    }
  }
  clampRegionToTerrain(region);
  return [
    ...(xCandidate === undefined ? [] : [{
      axis: 'x' as const,
      anchor: xCandidate.anchor,
      source: {
        x: xCandidate.source.x + xShift,
        y: xCandidate.source.y + (regionHandleAffectsAxis(handle, 'y') ? yShift : 0)
      }
    }]),
    ...(yCandidate === undefined ? [] : [{
      axis: 'y' as const,
      anchor: yCandidate.anchor,
      source: {
        x: yCandidate.source.x + (regionHandleAffectsAxis(handle, 'x') ? xShift : 0),
        y: yCandidate.source.y + yShift
      }
    }])
  ];
}

function regionCornerCoordinates(region: Pick<RegionData, 'left' | 'bottom' | 'right' | 'top'>): Array<{ x: number; y: number }> {
  return [
    { x: region.left, y: region.bottom },
    { x: region.right, y: region.bottom },
    { x: region.right, y: region.top },
    { x: region.left, y: region.top }
  ];
}

function regionSnapSources(
  region: Pick<RegionData, 'left' | 'bottom' | 'right' | 'top'>,
  handle: RegionHandle
): Array<{ x: number; y: number }> {
  const corners = regionCornerCoordinates(region);
  const southWest = corners[0]!;
  const southEast = corners[1]!;
  const northEast = corners[2]!;
  const northWest = corners[3]!;
  switch (handle) {
    case 'northWest': return [northWest];
    case 'north': return [northEast, northWest];
    case 'northEast': return [northEast];
    case 'east': return [southEast, northEast];
    case 'southEast': return [southEast];
    case 'south': return [southWest, southEast];
    case 'southWest': return [southWest];
    case 'west': return [northWest, southWest];
    default: return [];
  }
}

function regionHandleAffectsAxis(handle: RegionHandle, axis: SnapAxis): boolean {
  return axis === 'x'
    ? handle.includes('West') || handle.includes('East') || handle === 'west' || handle === 'east'
    : handle.includes('north') || handle.includes('south');
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
    propagateInstanceLinks([entityKey('region', region.index)]);
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
    propagateInstanceLinks([entityKey('point', point.id)]);
  }
  commitDocumentChange('属性已更新', before);
}

function deleteSelection(): void {
  const keys = selectedKeys.size > 0
    ? [...selectedKeys]
    : selection === undefined ? [] : [selectionKey(selection)];
  if (keys.length === 0) {
    return;
  }
  const before = captureSnapshot();
  const regionsToDelete = new Set(keys
    .map((key) => selectionFromKey(key))
    .filter((item): item is { kind: 'region'; index: number } => item?.kind === 'region')
    .map((item) => item.index));
  const pointsToDelete = new Set(keys
    .map((key) => selectionFromKey(key))
    .filter((item): item is { kind: 'point'; id: string } => item?.kind === 'point')
    .map((item) => item.id));
  regionFile.regions = regionFile.regions.filter((region) => !regionsToDelete.has(region.index));
  points = points.filter((point) => !pointsToDelete.has(point.id));
  const removedKeys = new Set(keys);
  instanceLinks = instanceLinks.filter(
    (link) => !removedKeys.has(link.source) && !removedKeys.has(link.target)
  );
  selection = undefined;
  selectedKeys.clear();
  commitDocumentChange('已删除', before);
}

function captureSnapshot(): EditorSnapshot {
  return {
    regionFile: structuredClone(regionFile),
    points: structuredClone(points),
    selection: structuredClone(selection),
    selectedKeys: [...selectedKeys],
    instanceLinks: structuredClone(instanceLinks)
  };
}

function restoreSnapshot(snapshot: EditorSnapshot): void {
  regionFile = structuredClone(snapshot.regionFile);
  points = structuredClone(snapshot.points);
  selection = structuredClone(snapshot.selection);
  selectedKeys = new Set(snapshot.selectedKeys);
  instanceLinks = structuredClone(snapshot.instanceLinks);
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
    points: structuredClone(points),
    instanceLinks: serializeInstanceLinks()
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
    setStatus(instanceLinks.length > 0
      ? `已保存 war3map.w3r、点位和 ${instanceLinks.length} 组实例关联`
      : '已保存 war3map.w3r 和点位');
  }
}

function setMode(nextMode: Mode): void {
  cancelPastePreview();
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

function updateSnapControls(): void {
  for (const input of [regionSnapEnabledInput, pointSnapEnabledInput]) {
    input.checked = snapEnabled;
  }
  for (const input of [regionSnapDistanceInput, pointSnapDistanceInput]) {
    input.value = String(snapDistance);
  }
}

function setTab(tab: Tab): void {
  const switched = tab !== activeTab;
  activeTab = tab;
  if (
    (tab === 'regions' && selection?.kind === 'point') ||
    (tab === 'points' && selection?.kind === 'region')
  ) {
    selection = firstSelectionForActiveTab();
  }
  if (tab === 'regions' && mode === 'point') {
    setMode('select');
  } else if (tab === 'points' && mode === 'region') {
    setMode('select');
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  if (switched) {
    // An explicit tab switch is the one case that goes back to the top; selecting
    // an object keeps the list where the user left it.
    cancelSidebarScrollAnimation();
    itemList.scrollTop = 0;
    // Claim the current selection so the render below cannot scroll straight back
    // off the top again.
    sidebarRevealedKey = selection === undefined ? undefined : selectionKey(selection);
  }
  renderSidebar();
  renderInspector();
}

interface SidebarItem {
  key: string;
  name: string;
  detail: string;
  selected: boolean;
}

function renderSidebar(): void {
  regionCount.textContent = String(regionFile.regions.length);
  pointCount.textContent = String(points.length);
  pointListCount.textContent = String(points.length);
  regionPanelHeader.hidden = activeTab !== 'regions';
  pointPanelHeader.hidden = activeTab !== 'points';

  const items: SidebarItem[] = activeTab === 'regions'
    ? regionFile.regions.map((region) => ({
        key: entityKey('region', region.index),
        name: region.name,
        detail: '',
        selected: isEntitySelected('region', region.index)
      }))
    : points.map((point) => ({
        key: entityKey('point', point.id),
        name: point.name,
        detail: `${roundCoordinate(point.x)}, ${roundCoordinate(point.y)}`,
        selected: isEntitySelected('point', point.id)
      }));

  // Rows are keyed and reused instead of being rebuilt: emptying the list drops
  // the scroller, so every selection change used to snap the list back to the
  // top (and steal focus from the row being clicked).
  const reusable = new Map<string, HTMLButtonElement>();
  for (const row of itemList.querySelectorAll<HTMLButtonElement>('.item-row')) {
    const key = row.dataset.key;
    if (key !== undefined && !reusable.has(key)) {
      reusable.set(key, row);
    }
  }

  const claimed = new Set<HTMLButtonElement>();
  items.forEach((item, position) => {
    const row = reusable.get(item.key) ?? createItemRow();
    claimed.add(row);
    updateItemRow(row, item);
    if (itemList.children[position] !== row) {
      itemList.insertBefore(row, itemList.children[position] ?? null);
    }
  });

  // Anything unclaimed is a deleted object or a row left over from the other tab.
  for (const row of itemList.querySelectorAll<HTMLButtonElement>('.item-row')) {
    if (!claimed.has(row)) {
      row.remove();
    }
  }

  syncSidebarReveal();
}

/** Rows resolve their target from `data-key` at click time so a reused row can never act on stale data. */
function createItemRow(): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'item-row';
  const label = document.createElement('span');
  const detail = document.createElement('small');
  button.append(label, detail);
  button.addEventListener('click', () => {
    const key = button.dataset.key;
    const next = key === undefined ? undefined : selectionFromKey(key);
    if (next === undefined) {
      return;
    }
    setSingleSelection(next);
    renderSidebar();
    renderInspector();
    renderOverlay();
  });
  return button;
}

function updateItemRow(row: HTMLButtonElement, item: SidebarItem): void {
  row.dataset.key = item.key;
  row.classList.toggle('selected', item.selected);
  const label = row.firstElementChild as HTMLElement;
  const detail = row.lastElementChild as HTMLElement;
  if (label.textContent !== item.name) {
    label.textContent = item.name;
  }
  if (detail.textContent !== item.detail) {
    detail.textContent = item.detail;
  }
  detail.hidden = item.detail.length === 0;
}

/**
 * Brings the selected row into view. Called after every list render, but only a
 * change of the selected key actually scrolls — otherwise a drag that re-renders
 * the list each frame would keep restarting the animation.
 */
function syncSidebarReveal(): void {
  if (drag?.type === 'marquee') {
    // The selection is still being swept; scrolling now would run the list out
    // from under the marquee. `pointerUp` reveals the final selection instead.
    return;
  }
  revealSelectionInSidebar();
}

function revealSelectionInSidebar(): void {
  const key = selection === undefined ? undefined : selectionKey(selection);
  if (key === undefined) {
    sidebarRevealedKey = undefined;
    return;
  }
  if (key === sidebarRevealedKey) {
    return;
  }
  sidebarRevealedKey = key;
  const row = itemList.querySelector<HTMLButtonElement>(`.item-row[data-key="${key}"]`);
  if (row !== null) {
    scrollSidebarRowIntoView(row);
  }
}

function scrollSidebarRowIntoView(row: HTMLElement): void {
  const rowBox = row.getBoundingClientRect();
  const listBox = itemList.getBoundingClientRect();
  // Both boxes are viewport-relative, so this converts to a content offset and
  // stays correct whatever the row's offsetParent happens to be.
  const target = scrollTargetForRow({
    rowTop: itemList.scrollTop + (rowBox.top - listBox.top),
    rowHeight: rowBox.height,
    scrollTop: itemList.scrollTop,
    viewHeight: itemList.clientHeight,
    contentHeight: itemList.scrollHeight
  });
  if (target !== undefined) {
    animateSidebarScroll(target);
  }
}

function animateSidebarScroll(target: number): void {
  cancelSidebarScrollAnimation();
  const from = itemList.scrollTop;
  const delta = target - from;
  if (Math.abs(delta) < 0.5) {
    return;
  }
  const startedAt = performance.now();
  const step = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / SIDEBAR_SCROLL_DURATION);
    itemList.scrollTop = from + delta * easeInOutCubic(progress);
    sidebarScrollFrame = progress < 1 ? window.requestAnimationFrame(step) : undefined;
  };
  sidebarScrollFrame = window.requestAnimationFrame(step);
}

/** A hand on the list always wins over the animation. */
function cancelSidebarScrollAnimation(): void {
  if (sidebarScrollFrame !== undefined) {
    window.cancelAnimationFrame(sidebarScrollFrame);
    sidebarScrollFrame = undefined;
  }
}

function easeInOutCubic(progress: number): number {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
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
