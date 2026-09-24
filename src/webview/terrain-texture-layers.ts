export interface TerrainTextureMap {
  columns: number;
  rows: number;
  corners: Array<Array<{ groundVariation: number; boundary?: number | boolean }>>;
  isCliff(column: number, row: number): boolean;
  cornerTexture(column: number, row: number): number;
  getVariation(groundTexture: number, variation: number): number;
}

export interface TerrainTextureLayers {
  textures: Uint8Array;
  variations: Uint8Array;
}

export function buildTerrainTextureLayers(map: TerrainTextureMap): TerrainTextureLayers {
  const textures = new Uint8Array(map.columns * map.rows * 4);
  const variations = new Uint8Array(map.columns * map.rows * 4);
  let instance = 0;

  for (let row = 0; row < map.rows; row += 1) {
    for (let column = 0; column < map.columns; column += 1) {
      if (!map.isCliff(column, row)) {
        writeTileTextureLayers(map, column, row, instance, textures, variations);
      }
      instance += 1;
    }
  }

  return { textures, variations };
}

function writeTileTextureLayers(
  map: TerrainTextureMap,
  column: number,
  row: number,
  instance: number,
  textureBuffer: Uint8Array,
  variationBuffer: Uint8Array
): void {
  const bottomLeftTexture = map.cornerTexture(column, row);
  const bottomRightTexture = map.cornerTexture(column + 1, row);
  const topLeftTexture = map.cornerTexture(column, row + 1);
  const topRightTexture = map.cornerTexture(column + 1, row + 1);
  const textures = Array.from(new Set([
    bottomLeftTexture,
    bottomRightTexture,
    topLeftTexture,
    topRightTexture
  ])).sort((left, right) => left - right);
  const baseTexture = textures.shift();

  if (baseTexture === undefined) {
    return;
  }

  const offset = instance * 4;
  textureBuffer[offset] = baseTexture + 1;
  variationBuffer[offset] = map.getVariation(
    baseTexture,
    map.corners[row]![column]!.groundVariation
  );

  for (let layer = 0; layer < textures.length; layer += 1) {
    const texture = textures[layer]!;
    let bitset = 0;

    if (bottomRightTexture === texture) {
      bitset |= 0b0001;
    }
    if (bottomLeftTexture === texture) {
      bitset |= 0b0010;
    }
    if (topRightTexture === texture) {
      bitset |= 0b0100;
    }
    if (topLeftTexture === texture) {
      bitset |= 0b1000;
    }

    textureBuffer[offset + 1 + layer] = texture + 1;
    variationBuffer[offset + 1 + layer] = bitset;
  }

  // The W3E boundary flag is stored per corner, while the renderer exposes
  // four variation bytes per terrain cell. Keep the normal variation in the
  // low seven bits and use the high bit of each byte for the matching corner.
  const boundaryMask = [
    isBoundaryCorner(map, column, row),
    isBoundaryCorner(map, column + 1, row),
    isBoundaryCorner(map, column, row + 1),
    isBoundaryCorner(map, column + 1, row + 1)
  ];
  for (let corner = 0; corner < boundaryMask.length; corner += 1) {
    if (boundaryMask[corner]) {
      variationBuffer[offset + corner] = variationBuffer[offset + corner]! | 0x80;
    }
  }
}

function isBoundaryCorner(map: TerrainTextureMap, column: number, row: number): boolean {
  const corner = map.corners[row]?.[column];
  return corner !== undefined && Number(corner.boundary ?? 0) !== 0;
}
