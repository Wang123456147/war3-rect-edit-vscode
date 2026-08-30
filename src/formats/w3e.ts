import { BinaryReader } from './binary';
import type { TerrainData } from '../shared/model';

const TILE_POINT_SIZE = 7;

export function parseW3e(buffer: Buffer): TerrainData {
  const reader = new BinaryReader(buffer);
  const magic = reader.readBytes(4).toString('ascii');
  if (magic !== 'W3E!') {
    throw new Error(`Invalid war3map.w3e signature: ${JSON.stringify(magic)}.`);
  }

  const version = reader.readInt32();
  const tileset = String.fromCharCode(reader.readUInt8());
  const customTileset = reader.readInt32();
  const groundTileCount = checkedCount(reader.readInt32(), 'ground tile');
  const groundTiles = readRawcodes(reader, groundTileCount);
  const cliffTileCount = checkedCount(reader.readInt32(), 'cliff tile');
  const cliffTiles = readRawcodes(reader, cliffTileCount);
  const width = checkedDimension(reader.readInt32(), 'width');
  const height = checkedDimension(reader.readInt32(), 'height');
  const offsetX = reader.readFloat32();
  const offsetY = reader.readFloat32();
  const vertexCount = width * height;

  if (reader.buffer.length - reader.offset !== vertexCount * TILE_POINT_SIZE) {
    throw new Error(
      `Unexpected W3E tile data length: expected ${vertexCount * TILE_POINT_SIZE}, ` +
      `got ${reader.buffer.length - reader.offset}.`
    );
  }

  const heights = new Array<number>(vertexCount);
  const waterHeights = new Array<number>(vertexCount);
  const flags = new Array<number>(vertexCount);
  const groundTextures = new Array<number>(vertexCount);
  const groundVariations = new Array<number>(vertexCount);
  const cliffTextures = new Array<number>(vertexCount);
  const cliffLevels = new Array<number>(vertexCount);

  for (let index = 0; index < vertexCount; index += 1) {
    const rawGroundHeight = reader.readUInt16();
    const rawWaterHeight = reader.readUInt16();
    const textureAndFlags = reader.readUInt8();
    const variation = reader.readUInt8();
    const cliff = reader.readUInt8();

    heights[index] = (rawGroundHeight - 8192) / 4;
    waterHeights[index] = ((rawWaterHeight & 0x3fff) - 8192) / 4;
    flags[index] = textureAndFlags & 0xf0;
    groundTextures[index] = textureAndFlags & 0x0f;
    groundVariations[index] = variation;
    cliffTextures[index] = cliff >>> 4;
    cliffLevels[index] = cliff & 0x0f;
  }

  return {
    version,
    tileset,
    customTileset,
    groundTiles,
    cliffTiles,
    width,
    height,
    offsetX,
    offsetY,
    heights,
    waterHeights,
    flags,
    groundTextures,
    groundVariations,
    cliffTextures,
    cliffLevels
  };
}

function readRawcodes(reader: BinaryReader, count: number): string[] {
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(reader.readBytes(4).toString('ascii'));
  }
  return values;
}

function checkedCount(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 256) {
    throw new Error(`Invalid ${label} count: ${value}.`);
  }
  return value;
}

function checkedDimension(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 2 || value > 2049) {
    throw new Error(`Invalid terrain ${label}: ${value}.`);
  }
  return value;
}
