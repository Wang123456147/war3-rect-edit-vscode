export interface TerrainData {
  version: number;
  tileset: string;
  customTileset: number;
  groundTiles: string[];
  cliffTiles: string[];
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  heights: number[];
  waterHeights: number[];
  flags: number[];
  groundTextures: number[];
  groundVariations: number[];
  cliffTextures: number[];
  cliffLevels: number[];
}

export interface RegionColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface RegionData {
  left: number;
  bottom: number;
  right: number;
  top: number;
  name: string;
  index: number;
  weatherId: string;
  ambientSound: string;
  color: RegionColor;
  originalName?: string;
  originalNameBytes?: string;
  originalAmbientSound?: string;
  originalAmbientSoundBytes?: string;
}

export interface RegionFileData {
  version: number;
  regions: RegionData[];
}

export interface ScriptPoint {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface PointFileData {
  version: 1;
  points: ScriptPoint[];
}

/** `none` keeps the offset direction, the other two flip one world axis. */
export type InstanceMirrorAxis = 'none' | 'horizontal' | 'vertical';

/**
 * One instance link written to `instances.json`.
 *
 * Only the topology is persisted. The affine offset that ties the two entities
 * together is re-derived from their current coordinates on load, so
 * `points.json` and `war3map.w3r` stay the single source of truth for
 * positions and this file never has to be rewritten when something moves.
 * `source`/`target` use the same `point:<id>` / `region:<index>` keys the
 * editor holds in memory.
 */
export interface InstanceLinkData {
  source: string;
  target: string;
  axis: InstanceMirrorAxis;
}

export interface InstanceFileData {
  version: 1;
  links: InstanceLinkData[];
}

export interface MapBinaryFile {
  name: string;
  base64: string;
}

export interface MapDocumentData {
  mapRoot: string;
  terrain: TerrainData;
  regionFile: RegionFileData;
  points: ScriptPoint[];
  instanceLinks: InstanceLinkData[];
  warcraftPath: string;
  mapFiles: MapBinaryFile[];
  doodadPlacementCount: number;
  doodadIni: string;
}
