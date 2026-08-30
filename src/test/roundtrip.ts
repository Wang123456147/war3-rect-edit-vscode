import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseW3e } from '../formats/w3e';
import { parseW3r, writeW3r } from '../formats/w3r';
import { MapDocument } from '../map-document';
import { WarcraftResourceResolver } from '../resources/resource-resolver';
import { buildTerrainTextureLayers } from '../webview/terrain-texture-layers';

const sampleRoot = process.env.WAR3_SAMPLE_MAP ?? path.resolve(process.cwd(), '..', 'shuaitu1.0');
const w3ePath = path.join(sampleRoot, 'map', 'war3map.w3e');
const w3rPath = path.join(sampleRoot, 'map', 'war3map.w3r');
const w3eBuffer = fs.readFileSync(w3ePath);
const w3rBuffer = fs.readFileSync(w3rPath);

const terrain = parseW3e(w3eBuffer);
assert.equal(terrain.version, 11);
assert.equal(terrain.width, 129);
assert.equal(terrain.height, 129);
assert.equal(terrain.heights.length, 129 * 129);
assert.equal(terrain.groundTextures.length, terrain.heights.length);
verifyW3eCliffByteLayout();
verifyNumericTerrainTextureLayerOrder();

const regionFile = parseW3r(w3rBuffer, 'gbk');
assert.equal(regionFile.version, 5);
assert.equal(regionFile.regions.length, 24);
assert.deepEqual(writeW3r(regionFile, 'gbk'), w3rBuffer, 'Unchanged W3R must round-trip byte-for-byte.');

const nextIndex = Math.max(...regionFile.regions.map((region) => region.index)) + 1;
const edited = structuredClone(regionFile);
edited.regions.push({
  left: -128,
  bottom: -256,
  right: 384,
  top: 512,
  name: '测试区域',
  index: nextIndex,
  weatherId: '\0\0\0\0',
  ambientSound: '',
  color: { r: 20, g: 160, b: 220, a: 255 }
});
const editedBuffer = writeW3r(edited, 'gbk');
const reparsed = parseW3r(editedBuffer, 'gbk');
assert.equal(reparsed.regions.length, 25);
assert.equal(reparsed.regions.at(-1)?.name, '测试区域');
assert.equal(reparsed.regions.at(-1)?.left, -128);
assert.equal(reparsed.regions.at(-1)?.top, 512);

void Promise.all([verifyMapDocument(), verifyLocalResourcePriority(), verifyResourceResolution()]).then(() => {
  console.log(
    `Verified W3E ${terrain.width - 1}x${terrain.height - 1}, ` +
    `W3R ${regionFile.regions.length} regions, byte-perfect unchanged round-trip, ` +
    'safe persistence, Lua export and streamed Warcraft resources.'
  );
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function verifyMapDocument(): Promise<void> {
  const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'war3-map-tools-'));
  try {
    await fsPromises.mkdir(path.join(temporaryRoot, 'map'), { recursive: true });
    await Promise.all([
      fsPromises.copyFile(w3ePath, path.join(temporaryRoot, 'map', 'war3map.w3e')),
      fsPromises.copyFile(w3rPath, path.join(temporaryRoot, 'map', 'war3map.w3r'))
    ]);

    const document = new MapDocument(temporaryRoot, 'gbk');
    const loaded = await document.load('F:\\Warcraft III Frozen Throne');
    assert.deepEqual(loaded.mapFiles.map((file) => file.name), ['war3map.w3e']);
    assert.equal(loaded.doodadPlacementCount, 0);
    const testPoint = { id: 'point-1', name: 'center', x: 0, y: -256.5 };
    await document.save(loaded.regionFile, [testPoint]);

    assert.deepEqual(
      await fsPromises.readFile(path.join(temporaryRoot, 'map', 'war3map.w3r')),
      w3rBuffer,
      'Saving unchanged regions must leave W3R bytes unchanged.'
    );
    assert.deepEqual(
      await fsPromises.readFile(path.join(temporaryRoot, '.war3tool', 'war3map.w3r.before-war3-map-tools.bak')),
      w3rBuffer,
      'The first save must preserve an original W3R backup.'
    );
    const reloaded = await document.load('');
    assert.deepEqual(reloaded.points, [testPoint]);

    const luaPath = await document.exportPointsLua([testPoint]);
    assert.equal(
      await fsPromises.readFile(luaPath, 'utf8'),
      'return {\n    center = { 0, -256.5 },\n}\n'
    );

    const customLuaDocument = new MapDocument(temporaryRoot, 'gbk', 'scripts/generated/map-points.lua');
    const customLuaPath = await customLuaDocument.exportPointsLua([testPoint]);
    assert.equal(customLuaPath, path.join(temporaryRoot, 'scripts', 'generated', 'map-points.lua'));
    assert.equal(
      await fsPromises.readFile(customLuaPath, 'utf8'),
      'return {\n    center = { 0, -256.5 },\n}\n'
    );

    const externallyChanged = Buffer.from(w3rBuffer);
    externallyChanged[externallyChanged.length - 1] = externallyChanged.at(-1)! ^ 1;
    await fsPromises.writeFile(path.join(temporaryRoot, 'map', 'war3map.w3r'), externallyChanged);
    await assert.rejects(
      () => document.save(loaded.regionFile, [testPoint]),
      /已被其他程序修改/
    );
  } finally {
    await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyLocalResourcePriority(): Promise<void> {
  const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'war3-map-resources-'));
  const textureDirectory = path.join(temporaryRoot, 'resource', 'TerrainArt', 'Custom');
  await fsPromises.mkdir(textureDirectory, { recursive: true });
  const texture = Buffer.from('local-tga');
  await fsPromises.writeFile(path.join(textureDirectory, 'Ground.TGA'), texture);
  const resolver = new WarcraftResourceResolver(temporaryRoot, '');
  try {
    assert.deepEqual(
      await resolver.read('terrainart\\custom\\ground.blp'),
      texture,
      'A local texture must win with case-insensitive path and equivalent texture extension.'
    );
  } finally {
    await resolver.close();
    await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyW3eCliffByteLayout(): void {
  const headerSize = 37;
  const buffer = Buffer.alloc(headerSize + 4 * 7);
  let offset = 0;
  offset += buffer.write('W3E!', offset, 'ascii');
  buffer.writeInt32LE(11, offset); offset += 4;
  buffer.writeUInt8('L'.charCodeAt(0), offset); offset += 1;
  buffer.writeInt32LE(0, offset); offset += 4;
  buffer.writeInt32LE(0, offset); offset += 4;
  buffer.writeInt32LE(0, offset); offset += 4;
  buffer.writeInt32LE(2, offset); offset += 4;
  buffer.writeInt32LE(2, offset); offset += 4;
  buffer.writeFloatLE(0, offset); offset += 4;
  buffer.writeFloatLE(0, offset); offset += 4;
  for (let index = 0; index < 4; index += 1) {
    buffer.writeUInt16LE(8192, offset); offset += 2;
    buffer.writeUInt16LE(8192, offset); offset += 2;
    buffer.writeUInt8(0, offset); offset += 1;
    buffer.writeUInt8(0, offset); offset += 1;
    buffer.writeUInt8(0xa3, offset); offset += 1;
  }

  const parsed = parseW3e(buffer);
  assert.equal(parsed.cliffTextures[0], 0x0a, 'The high nibble stores the cliff texture index.');
  assert.equal(parsed.cliffLevels[0], 0x03, 'The low nibble stores the cliff layer height.');
}

function verifyNumericTerrainTextureLayerOrder(): void {
  const cornerTextures = [
    [15, 10],
    [9, 15]
  ];
  const layers = buildTerrainTextureLayers({
    columns: 1,
    rows: 1,
    corners: [
      [{ groundVariation: 7 }, { groundVariation: 0 }],
      [{ groundVariation: 0 }, { groundVariation: 0 }]
    ],
    isCliff: () => false,
    cornerTexture: (column, row) => cornerTextures[row]![column]!,
    getVariation: (texture, variation) => texture + variation
  });

  assert.deepEqual(
    [...layers.textures],
    [10, 11, 16, 0],
    'Terrain layers must be ordered numerically so texture slot 9 remains the base below 10 and 15.'
  );
  assert.deepEqual(
    [...layers.variations],
    [16, 1, 6, 0],
    'Overlay masks must continue to match the W3E corner layout after numeric sorting.'
  );
}

async function verifyResourceResolution(): Promise<void> {
  const warcraftPath = process.env.WAR3_INSTALL_PATH ?? 'F:\\Warcraft III Frozen Throne';
  try {
    await fsPromises.access(path.join(warcraftPath, 'war3.mpq'));
  } catch {
    return;
  }
  const resolver = new WarcraftResourceResolver(sampleRoot, warcraftPath);
  try {
    const baseFiles = [
      'TerrainArt\\Terrain.slk',
      'TerrainArt\\CliffTypes.slk',
      'TerrainArt\\Water.slk',
      'Doodads\\Doodads.slk',
      'Doodads\\DoodadMetaData.slk',
      'Units\\DestructableData.slk',
      'Units\\DestructableMetaData.slk',
      'Units\\UnitData.slk',
      'Units\\unitUI.slk',
      'Units\\ItemData.slk',
      'Units\\UnitMetaData.slk'
    ];
    const concurrentReads = await Promise.all(
      Array.from({ length: 3 }, () => baseFiles.map((resourcePath) => resolver.read(resourcePath))).flat()
    );
    for (const [index, data] of concurrentReads.entries()) {
      assert.equal(
        data?.subarray(0, 3).toString('ascii'),
        'ID;',
        `${baseFiles[index % baseFiles.length]} must decode as a valid SLK.`
      );
    }
    const localTexture = await resolver.read('TerrainArt\\LordaeronSummer\\Lords_Dirt.blp');
    const expectedTexture = await fsPromises.readFile(
      path.join(sampleRoot, 'resource', 'TerrainArt', 'LordaeronSummer', 'Lords_Dirt.blp')
    );
    assert.deepEqual(localTexture, expectedTexture, 'LNI resources must override Warcraft MPQs.');
  } finally {
    await resolver.close();
  }
}
