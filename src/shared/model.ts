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

export interface MapBinaryFile {
  name: string;
  base64: string;
}

export interface MapDocumentData {
  mapRoot: string;
  terrain: TerrainData;
  regionFile: RegionFileData;
  points: ScriptPoint[];
  warcraftPath: string;
  mapFiles: MapBinaryFile[];
  doodadPlacementCount: number;
  doodadIni: string;
}
