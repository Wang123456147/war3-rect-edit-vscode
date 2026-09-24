import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import War3MapDoo from 'mdx-m3-viewer/dist/cjs/parsers/w3x/doo/file';
import { parseW3e } from './formats/w3e';
import { parseW3r, writeW3r } from './formats/w3r';
import type {
  InstanceFileData,
  InstanceLinkData,
  InstanceMirrorAxis,
  MapDocumentData,
  PointFileData,
  RegionFileData,
  ScriptPoint
} from './shared/model';

const W3E_RELATIVE_PATH = path.join('map', 'war3map.w3e');
const W3R_RELATIVE_PATH = path.join('map', 'war3map.w3r');
const DOODAD_RELATIVE_PATH = path.join('map', 'war3map.doo');
const UNIT_RELATIVE_PATH = path.join('map', 'war3mapUnits.doo');
const DOODAD_INI_RELATIVE_PATH = path.join('table', 'doodad.ini');
const TOOL_DIRECTORY = '.war3tool';
const POINTS_FILENAME = 'points.json';
const INSTANCES_FILENAME = 'instances.json';
const POINTS_LUA_FILENAME = 'points.lua';
const W3R_BACKUP_FILENAME = 'war3map.w3r.before-war3-map-tools.bak';
export const DEFAULT_LUA_EXPORT_PATH = `${TOOL_DIRECTORY}/${POINTS_LUA_FILENAME}`;

export class MapDocument {
  private w3rHash = '';
  private configuredLuaExportPath: string;
  private readonly workspaceRoot: string;

  public constructor(
    public readonly root: string,
    private readonly encoding: string,
    configuredLuaExportPath = DEFAULT_LUA_EXPORT_PATH,
    workspaceRoot = root
  ) {
    this.configuredLuaExportPath = configuredLuaExportPath;
    this.workspaceRoot = workspaceRoot;
  }

  /** Update the destination without recreating the loaded map document. */
  public setLuaExportPath(configuredPath: string): void {
    this.configuredLuaExportPath = configuredPath;
  }

  public static async isMapRoot(candidate: string): Promise<boolean> {
    return Promise.all([
      fileExists(path.join(candidate, W3E_RELATIVE_PATH)),
      fileExists(path.join(candidate, W3R_RELATIVE_PATH))
    ]).then(([hasW3e, hasW3r]) => hasW3e && hasW3r);
  }

  public async load(warcraftPath: string): Promise<MapDocumentData> {
    const [w3eBuffer, w3rBuffer, points, doodadBuffer, unitBuffer, doodadIni] = await Promise.all([
      fs.readFile(this.w3ePath),
      fs.readFile(this.w3rPath),
      this.readPoints(),
      readOptionalFile(path.join(this.root, DOODAD_RELATIVE_PATH)),
      readOptionalFile(path.join(this.root, UNIT_RELATIVE_PATH)),
      readOptionalText(path.join(this.root, DOODAD_INI_RELATIVE_PATH))
    ]);
    this.w3rHash = hashBuffer(w3rBuffer);
    const regionFile = parseW3r(w3rBuffer, this.encoding);
    return {
      mapRoot: this.root,
      terrain: parseW3e(w3eBuffer),
      regionFile,
      points,
      instanceLinks: await this.readInstanceLinks(points, regionFile),
      warcraftPath,
      mapFiles: [
        { name: 'war3map.w3e', base64: w3eBuffer.toString('base64') },
        ...(doodadBuffer === undefined ? [] : [{ name: 'war3map.doo', base64: doodadBuffer.toString('base64') }]),
        ...(unitBuffer === undefined ? [] : [{ name: 'war3mapUnits.doo', base64: unitBuffer.toString('base64') }])
      ],
      doodadPlacementCount: countDoodadPlacements(doodadBuffer),
      doodadIni
    };
  }

  public async save(
    regionFile: RegionFileData,
    points: ScriptPoint[],
    instanceLinks: InstanceLinkData[] = []
  ): Promise<void> {
    validatePoints(points);
    const currentW3r = await fs.readFile(this.w3rPath);
    const currentHash = hashBuffer(currentW3r);
    if (this.w3rHash !== '' && currentHash !== this.w3rHash) {
      throw new Error('war3map.w3r 已被其他程序修改。请重新打开地形视图后再保存。');
    }

    const nextW3r = writeW3r(regionFile, this.encoding);
    // Re-parse before touching the map so a writer bug cannot create an unreadable file.
    parseW3r(nextW3r, this.encoding);

    await fs.mkdir(this.toolDirectory, { recursive: true });
    await createBackupOnce(this.w3rPath, path.join(this.toolDirectory, W3R_BACKUP_FILENAME));

    const temporaryPath = `${this.w3rPath}.war3-map-tools.tmp`;
    await fs.writeFile(temporaryPath, nextW3r);
    try {
      await fs.copyFile(temporaryPath, this.w3rPath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }

    const pointFile: PointFileData = { version: 1, points };
    await fs.writeFile(this.pointsPath, `${JSON.stringify(pointFile, null, 2)}\n`, 'utf8');
    // Instance links live in their own sidecar so points.json, points.lua and
    // war3map.w3r never carry editor bookkeeping. Written last because it is
    // derived data: a failure here must not leave the map half-saved. The
    // reader and the writer share one sanitizer, so what lands on disk can
    // never hold a dangling or ambiguous link, and an empty link set removes
    // the file instead of leaving `{"version":1,"links":[]}` behind.
    const links = sanitizeInstanceLinks(instanceLinks, points, regionFile);
    if (links.length === 0) {
      await fs.rm(this.instancePath, { force: true });
    } else {
      const instanceFile: InstanceFileData = { version: 1, links };
      await fs.writeFile(this.instancePath, `${JSON.stringify(instanceFile, null, 2)}\n`, 'utf8');
    }
    this.w3rHash = hashBuffer(nextW3r);
  }

  public async exportPointsLua(points: ScriptPoint[]): Promise<string> {
    validatePoints(points);
    await fs.mkdir(path.dirname(this.pointsLuaPath), { recursive: true });
    const lines = ['return {'];
    for (const point of points) {
      const key = luaKey(point.name);
      lines.push(`    ${key} = { ${formatNumber(point.x)}, ${formatNumber(point.y)} },`);
    }
    lines.push('}', '');
    await fs.writeFile(this.pointsLuaPath, lines.join('\n'), 'utf8');
    return this.pointsLuaPath;
  }

  public get w3ePath(): string {
    return path.join(this.root, W3E_RELATIVE_PATH);
  }

  public get w3rPath(): string {
    return path.join(this.root, W3R_RELATIVE_PATH);
  }

  public get pointsPath(): string {
    return path.join(this.toolDirectory, POINTS_FILENAME);
  }

  public get instancePath(): string {
    return path.join(this.toolDirectory, INSTANCES_FILENAME);
  }

  public get pointsLuaPath(): string {
    const configured = this.configuredLuaExportPath.trim();
    if (configured.length === 0 || isDefaultLuaExportPath(configured)) {
      return path.join(this.toolDirectory, POINTS_LUA_FILENAME);
    }
    return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(this.root, configured);
  }

  private get toolDirectory(): string {
    return path.join(this.workspaceRoot, TOOL_DIRECTORY);
  }

  private get legacyPointsPath(): string {
    return path.join(this.root, TOOL_DIRECTORY, POINTS_FILENAME);
  }

  private async readPoints(): Promise<ScriptPoint[]> {
    const candidates = [this.pointsPath];
    if (path.resolve(this.pointsPath).toLowerCase() !== path.resolve(this.legacyPointsPath).toLowerCase()) {
      candidates.push(this.legacyPointsPath);
    }
    for (const filename of candidates) {
      try {
        const text = await fs.readFile(filename, 'utf8');
        const data = JSON.parse(text) as Partial<PointFileData>;
        if (data.version !== 1 || !Array.isArray(data.points)) {
          throw new Error('Unsupported points.json schema.');
        }
        validatePoints(data.points);
        return data.points;
      } catch (error) {
        if (isMissingFile(error)) {
          continue;
        }
        throw error;
      }
    }
    return [];
  }

  /**
   * Reads the instance sidecar and drops anything that no longer resolves.
   * A missing file simply means "no links yet"; a malformed one is reported
   * instead of silently discarding the user's work.
   *
   * Positions are deliberately absent from the file, so links survive an
   * external program rewriting the W3R or points.json as long as the entities
   * themselves are still there. When one side is gone the link is stale and
   * gets pruned instead of resurrecting a deleted object.
   */
  private async readInstanceLinks(
    points: ScriptPoint[],
    regionFile: RegionFileData
  ): Promise<InstanceLinkData[]> {
    let text: string;
    try {
      text = await fs.readFile(this.instancePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }

    let data: Partial<InstanceFileData>;
    try {
      data = JSON.parse(text) as Partial<InstanceFileData>;
    } catch {
      throw new Error('instances.json 不是有效的 JSON，无法读取实例关联。');
    }
    if (data.version !== 1 || !Array.isArray(data.links)) {
      throw new Error('instances.json 格式不支持：需要 version 为 1，且 links 为数组。');
    }
    return sanitizeInstanceLinks(data.links, points, regionFile);
  }
}

function isDefaultLuaExportPath(configuredPath: string): boolean {
  return path.normalize(configuredPath).toLowerCase() === path.normalize(DEFAULT_LUA_EXPORT_PATH).toLowerCase();
}

function countDoodadPlacements(buffer: Buffer | undefined): number {
  if (buffer === undefined) {
    return 0;
  }
  const parser = new War3MapDoo();
  parser.load(buffer, 0);
  return parser.doodads.length + parser.terrainDoodads.length;
}

async function createBackupOnce(source: string, destination: string): Promise<void> {
  try {
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (!isExistingFile(error)) {
      throw error;
    }
  }
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalFile(filename: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(filename);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readOptionalText(filename: string): Promise<string> {
  const buffer = await readOptionalFile(filename);
  return buffer?.toString('utf8') ?? '';
}

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validatePoints(points: ScriptPoint[]): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const point of points) {
    if (typeof point.id !== 'string' || point.id.length === 0 || ids.has(point.id)) {
      throw new Error(`无效或重复的点 ID: ${point.id}`);
    }
    if (typeof point.name !== 'string' || point.name.trim().length === 0 || names.has(point.name)) {
      throw new Error(`无效或重复的点名称: ${point.name}`);
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error(`点 ${point.name} 的坐标无效。`);
    }
    ids.add(point.id);
    names.add(point.name);
  }
}

/** Narrows one raw JSON entry; anything malformed is skipped by the caller. */
function normalizeInstanceLink(value: unknown): InstanceLinkData | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const { source, target, axis } = record;
  if (typeof source !== 'string' || typeof target !== 'string') {
    return undefined;
  }
  // A hand-written entry with a missing or mistyped axis means "no mirroring".
  const mirror: InstanceMirrorAxis = axis === 'horizontal' || axis === 'vertical' ? axis : 'none';
  return { source, target, axis: mirror };
}

/**
 * Shared by the reader and the writer so both sides agree on what a link is:
 * well-shaped, not self-referential, still resolvable on both ends, and with at
 * most one source claiming any copy. Everything else is dropped, which is what
 * keeps stale links out of the file and out of memory alike.
 */
function sanitizeInstanceLinks(
  raw: readonly unknown[],
  points: ScriptPoint[],
  regionFile: RegionFileData
): InstanceLinkData[] {
  // `region:<index>` and `point:<id>` mirror the keys the editor uses.
  const known = new Set<string>([
    ...points.map((point) => `point:${point.id}`),
    ...regionFile.regions.map((region) => `region:${region.index}`)
  ]);
  const links: InstanceLinkData[] = [];
  const claimedTargets = new Set<string>();
  for (const entry of raw) {
    const link = normalizeInstanceLink(entry);
    if (link === undefined || link.source === link.target) {
      continue;
    }
    if (!known.has(link.source) || !known.has(link.target)) {
      continue;
    }
    // A copy answers to exactly one source; this also de-duplicates entries.
    if (claimedTargets.has(link.target)) {
      continue;
    }
    claimedTargets.add(link.target);
    links.push(link);
  }
  return links;
}

function luaKey(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return name;
  }
  return `[${JSON.stringify(name)}]`;
}

function formatNumber(value: number): string {
  if (Object.is(value, -0)) {
    return '0';
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isExistingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
