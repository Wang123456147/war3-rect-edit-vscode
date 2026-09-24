import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseW3e } from '../formats/w3e';
import { parseW3r, writeW3r } from '../formats/w3r';
import { MapDocument } from '../map-document';
import { WarcraftResourceResolver } from '../resources/resource-resolver';
import { groupOffset, linkOffset, mirrorSigns } from '../shared/instance-links';
import type { LinkBox } from '../shared/instance-links';
import type { RegionFileData } from '../shared/model';
import { scrollTargetForRow } from '../shared/scroll-reveal';
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
verifyTerrainBoundaryFlagEncoding();
verifyInstanceLinkMath();
verifySidebarScrollReveal();

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
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  try {
    await fsPromises.mkdir(path.join(temporaryRoot, 'map'), { recursive: true });
    await fsPromises.mkdir(workspaceRoot, { recursive: true });
    await Promise.all([
      fsPromises.copyFile(w3ePath, path.join(temporaryRoot, 'map', 'war3map.w3e')),
      fsPromises.copyFile(w3rPath, path.join(temporaryRoot, 'map', 'war3map.w3r'))
    ]);

    const document = new MapDocument(temporaryRoot, 'gbk', undefined, workspaceRoot);
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
      await fsPromises.readFile(path.join(workspaceRoot, '.war3tool', 'war3map.w3r.before-war3-map-tools.bak')),
      w3rBuffer,
      'The first save must preserve an original W3R backup.'
    );
    await assert.rejects(
      () => fsPromises.access(path.join(temporaryRoot, '.war3tool')),
      'Map directories must not receive the plugin metadata directory.'
    );
    const reloaded = await document.load('');
    assert.deepEqual(reloaded.points, [testPoint]);

    await verifyInstanceSidecar(temporaryRoot, workspaceRoot, loaded.regionFile);

    const luaPath = await document.exportPointsLua([testPoint]);
    assert.equal(luaPath, path.join(workspaceRoot, '.war3tool', 'points.lua'));
    assert.equal(
      await fsPromises.readFile(luaPath, 'utf8'),
      'return {\n    center = { 0, -256.5 },\n}\n'
    );

    const customLuaDocument = new MapDocument(temporaryRoot, 'gbk', 'scripts/generated/map-points.lua', workspaceRoot);
    const customLuaPath = await customLuaDocument.exportPointsLua([testPoint]);
    assert.equal(customLuaPath, path.join(temporaryRoot, 'scripts', 'generated', 'map-points.lua'));
    assert.equal(
      await fsPromises.readFile(customLuaPath, 'utf8'),
      'return {\n    center = { 0, -256.5 },\n}\n'
    );

    const updatedLuaDocument = new MapDocument(temporaryRoot, 'gbk', undefined, workspaceRoot);
    updatedLuaDocument.setLuaExportPath('scripts/updated/map-points.lua');
    const updatedLuaPath = await updatedLuaDocument.exportPointsLua([testPoint]);
    assert.equal(
      updatedLuaPath,
      path.join(temporaryRoot, 'scripts', 'updated', 'map-points.lua'),
      'Changing the Lua destination after opening a map must affect the next export.'
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

/**
 * The instance sidecar has to stay a pure sidecar: it records which copy
 * belongs to which original, and nothing else. Positions stay where they
 * already live (points.json and the W3R), so this asserts the file never grows
 * an offset, a dangling reference, or an entry for a map that has no links.
 */
async function verifyInstanceSidecar(
  mapRoot: string,
  workspaceRoot: string,
  regionFile: RegionFileData
): Promise<void> {
  const toolDirectory = path.join(workspaceRoot, '.war3tool');
  const instancePath = path.join(toolDirectory, 'instances.json');
  const pointsPath = path.join(toolDirectory, 'points.json');
  const w3rPath = path.join(mapRoot, 'map', 'war3map.w3r');

  // The saves above carried no links, so the file must not exist at all.
  await assert.rejects(
    () => fsPromises.access(instancePath),
    'The instance sidecar must not exist while there are no links.'
  );

  const document = new MapDocument(mapRoot, 'gbk', undefined, workspaceRoot);
  await document.load('');
  const w3rBefore = await fsPromises.readFile(w3rPath);

  const source = { id: 'source-point', name: 'source', x: 0, y: 0 };
  const copy = { id: 'copy-point', name: 'copy', x: 256, y: 0 };
  const regionIndex = regionFile.regions[0]!.index;
  await document.save(regionFile, [source, copy], [
    { source: 'point:source-point', target: 'point:copy-point', axis: 'horizontal' },
    // Both ends missing: the entities were deleted outside the editor.
    { source: 'point:missing-point', target: 'point:ghost-point', axis: 'none' },
    // Self-reference and a second source claiming an already-claimed copy.
    { source: `region:${regionIndex}`, target: `region:${regionIndex}`, axis: 'vertical' },
    { source: 'point:missing-point', target: 'point:copy-point', axis: 'none' }
  ]);

  assert.deepEqual(
    JSON.parse(await fsPromises.readFile(instancePath, 'utf8')),
    {
      version: 1,
      links: [{ source: 'point:source-point', target: 'point:copy-point', axis: 'horizontal' }]
    },
    'instances.json must hold valid topology only: no offsets, dangling ends, self-links or duplicate copies.'
  );

  const pointFile = JSON.parse(await fsPromises.readFile(pointsPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(pointFile).sort(),
    ['points', 'version'],
    'points.json must not gain editor bookkeeping fields.'
  );
  assert.deepEqual(pointFile.points, [source, copy], 'points.json must stay a plain list of script points.');

  assert.deepEqual(
    await fsPromises.readFile(w3rPath),
    w3rBefore,
    'Writing the instance sidecar must not touch the W3R.'
  );

  const reloaded = await document.load('');
  assert.deepEqual(
    reloaded.instanceLinks,
    [{ source: 'point:source-point', target: 'point:copy-point', axis: 'horizontal' }],
    'Instance links must survive a reload.'
  );

  await document.save(regionFile, [source, copy], []);
  await assert.rejects(
    () => fsPromises.access(instancePath),
    'Removing every link must delete the sidecar instead of leaving an empty one.'
  );

  await fsPromises.writeFile(instancePath, '{ not json');
  await assert.rejects(
    () => document.load(''),
    /instances\.json/,
    'A malformed sidecar must be reported instead of silently discarding the links.'
  );
}

/**
 * `instances.json` stores topology only, so reloading has to recover the
 * offset that ties a copy to its original from the two entities' coordinates.
 * That recovery must be the exact inverse of how the paste places a group;
 * any disagreement shows up as the copy jumping the first time it is dragged
 * after reopening the map.
 *
 * The region case is the subtle one. A region is mapped corner by corner and
 * rebuilt with min/max, so on a mirrored axis the source's low corner lands on
 * the copy's HIGH corner — measuring from the same corner on both sides is off
 * by the region's width.
 */
function verifyInstanceLinkMath(): void {
  const axes = ['none', 'horizontal', 'vertical'] as const;
  const source: LinkBox = { min: { x: -128, y: -256 }, max: { x: 384, y: 512 } };
  const sourceCenter = {
    x: (source.min.x + source.max.x) / 2,
    y: (source.min.y + source.max.y) / 2
  };
  const dropCenter = { x: 768, y: 128 };

  for (const axis of axes) {
    const signs = mirrorSigns(axis);
    const pastedOffset = groupOffset(sourceCenter, dropCenter, axis);

    // Place the copy the way the paste preview does: project both corners, then
    // rebuild the rectangle, because mirroring swaps which corner is min/max.
    const first = {
      x: signs.x * source.min.x + pastedOffset.x,
      y: signs.y * source.min.y + pastedOffset.y
    };
    const second = {
      x: signs.x * source.max.x + pastedOffset.x,
      y: signs.y * source.max.y + pastedOffset.y
    };
    const copy: LinkBox = {
      min: { x: Math.min(first.x, second.x), y: Math.min(first.y, second.y) },
      max: { x: Math.max(first.x, second.x), y: Math.max(first.y, second.y) }
    };

    assert.equal(
      copy.max.x - copy.min.x,
      source.max.x - source.min.x,
      `${axis}: mirroring must preserve the region width.`
    );
    assert.equal(
      copy.max.y - copy.min.y,
      source.max.y - source.min.y,
      `${axis}: mirroring must preserve the region height.`
    );
    assert.deepEqual(
      linkOffset(source, copy, axis),
      pastedOffset,
      `${axis}: reloading a region link must recover the paste-time offset exactly.`
    );

    // The same must hold for a point, which is a degenerate box.
    const point = { x: 37, y: -21 };
    const pointBox: LinkBox = { min: { ...point }, max: { ...point } };
    const pointOffset = groupOffset(point, dropCenter, axis);
    const copyBox: LinkBox = {
      min: { x: signs.x * point.x + pointOffset.x, y: signs.y * point.y + pointOffset.y },
      max: { x: signs.x * point.x + pointOffset.x, y: signs.y * point.y + pointOffset.y }
    };
    assert.deepEqual(
      linkOffset(pointBox, copyBox, axis),
      pointOffset,
      `${axis}: reloading a point link must recover the paste-time offset exactly.`
    );

    if (axis !== 'none') {
      // Guard the trap above: on a mirrored axis the matching corner is the
      // opposite one, so a same-corner measurement silently disagrees.
      const sameCorner = {
        x: copy.min.x - signs.x * source.min.x,
        y: copy.min.y - signs.y * source.min.y
      };
      assert.notDeepEqual(
        sameCorner,
        pastedOffset,
        `${axis}: a same-corner offset must not be mistaken for the real one.`
      );
    }
  }
}

/**
 * The sidebar reveal only has to be right about one thing: never move a list
 * that already shows the row, and land fully inside the list when it must move.
 */
function verifySidebarScrollReveal(): void {
  const view = { viewHeight: 200, contentHeight: 1000, rowHeight: 30 };

  assert.equal(
    scrollTargetForRow({ ...view, rowTop: 100, scrollTop: 0 }),
    undefined,
    'A row already inside the viewport must not scroll the list.'
  );
  assert.equal(
    scrollTargetForRow({ ...view, rowTop: 0, scrollTop: 0 }),
    undefined,
    'A row flush with the top edge counts as visible.'
  );
  assert.equal(
    scrollTargetForRow({ ...view, rowTop: 170, scrollTop: 0 }),
    undefined,
    'A row flush with the bottom edge counts as visible.'
  );

  // Below the viewport: centred, and reachable without overshooting the ends.
  assert.equal(
    scrollTargetForRow({ ...view, rowTop: 400, scrollTop: 0 }),
    315,
    'A row below the fold must be centred.'
  );
  // Near the top: centring would go negative, so clamp to the start.
  assert.equal(
    scrollTargetForRow({ ...view, rowTop: 10, scrollTop: 300 }),
    0,
    'Revealing a row above the fold must clamp to the top.'
  );
  // Near the bottom: centring would run past the content, so clamp to the end.
  assert.equal(
    scrollTargetForRow({ ...view, rowTop: 960, scrollTop: 0 }),
    800,
    'Revealing the last row must clamp to the maximum scroll.'
  );

  // A list shorter than its viewport cannot scroll at all.
  assert.equal(
    scrollTargetForRow({ viewHeight: 200, contentHeight: 120, rowHeight: 30, rowTop: 190, scrollTop: 0 }),
    0,
    'A list with no overflow must stay at the top.'
  );
  // A row taller than the viewport can never be fully visible: centre what fits
  // rather than return something the list cannot reach.
  assert.equal(
    scrollTargetForRow({ viewHeight: 100, contentHeight: 1000, rowHeight: 240, rowTop: 500, scrollTop: 0 }),
    570,
    'A row taller than the list must centre its middle instead of looping.'
  );

  // Whatever the row, the result must put it fully inside the viewport whenever
  // the list is long enough to allow it. The sweep stops at the last row that
  // actually fits inside the content, which is the only case the list can show.
  const lastRowTop = view.contentHeight - view.rowHeight;
  for (let rowTop = 0; rowTop <= lastRowTop; rowTop += 20) {
    for (let scrollTop = 0; scrollTop <= 800; scrollTop += 40) {
      const target = scrollTargetForRow({ ...view, rowTop, scrollTop });
      if (target === undefined) {
        assert.ok(
          rowTop >= scrollTop && rowTop + view.rowHeight <= scrollTop + view.viewHeight,
          `row at ${rowTop} from ${scrollTop} must really be visible when nothing is returned.`
        );
        continue;
      }
      assert.ok(target >= 0 && target <= 800, `target ${target} must stay in range.`);
      assert.ok(
        rowTop >= target && rowTop + view.rowHeight <= target + view.viewHeight,
        `row at ${rowTop} must be fully visible at target ${target}.`
      );
    }
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

function verifyTerrainBoundaryFlagEncoding(): void {
  const layers = buildTerrainTextureLayers({
    columns: 1,
    rows: 1,
    corners: [
      [{ groundVariation: 0, boundary: true }, { groundVariation: 0, boundary: false }],
      [{ groundVariation: 0, boundary: true }, { groundVariation: 0, boundary: false }]
    ],
    isCliff: () => false,
    cornerTexture: () => 0,
    getVariation: () => 0
  });

  assert.deepEqual(
    [...layers.variations],
    [0x80, 0, 0x80, 0],
    'W3E boundary flags must be preserved in the four variation bytes used by the ground shader.'
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
