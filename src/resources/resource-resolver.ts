import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { StreamingMpq } from './streaming-mpq';

const ARCHIVE_NAMES = ['War3Patch.mpq', 'War3xLocal.mpq', 'War3x.mpq', 'war3.mpq'];
const LOCAL_TEXTURE_EXTENSIONS = ['.blp', '.tga', '.dds'];

export class WarcraftResourceResolver {
  private readonly localResourceIndex: Promise<Map<string, string>>;
  private archivePromises: Array<Promise<StreamingMpq | undefined>> | undefined;

  public constructor(
    private readonly mapRoot: string,
    private readonly warcraftPath: string
  ) {
    this.localResourceIndex = indexLocalResources(mapRoot);
  }

  public async read(resourcePath: string): Promise<Buffer | undefined> {
    const normalized = normalizeResourcePath(resourcePath);
    if (normalized.length === 0) {
      return undefined;
    }

    const local = await readLocalResource(this.localResourceIndex, normalized);
    if (local !== undefined && isValidResource(normalized, local)) {
      return local;
    }

    const archives = await this.openArchives();
    for (const archive of archives) {
      if (archive === undefined) {
        continue;
      }
      try {
        const data = await archive.read(normalized);
        if (data !== undefined && isValidResource(normalized, data)) {
          return data;
        }
      } catch {
        // Patch entries can use compression modes unsupported by the JS decoder.
        // Falling through lets an older archive satisfy the same path.
      }
    }

    const variationFallback = normalized.replace(/\d+(?=\.mdx$)/i, '');
    if (variationFallback !== normalized) {
      return this.read(variationFallback);
    }
    return undefined;
  }

  public async close(): Promise<void> {
    const archives = this.archivePromises === undefined
      ? []
      : await Promise.all(this.archivePromises);
    await Promise.all(archives.map((archive) => archive?.close()));
  }

  private async openArchives(): Promise<Array<StreamingMpq | undefined>> {
    if (this.archivePromises === undefined) {
      this.archivePromises = this.warcraftPath.length === 0
        ? []
        : ARCHIVE_NAMES.map((name) => openOptionalArchive(path.join(this.warcraftPath, name)));
    }
    return Promise.all(this.archivePromises);
  }
}

function normalizeResourcePath(resourcePath: string): string {
  return resourcePath.replaceAll('/', '\\').replace(/^\\+/, '');
}

function isValidResource(resourcePath: string, data: Buffer): boolean {
  if (!resourcePath.toLowerCase().endsWith('.slk')) {
    return true;
  }
  return data.length >= 3 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x3b;
}

async function readLocalResource(
  indexPromise: Promise<Map<string, string>>,
  resourcePath: string
): Promise<Buffer | undefined> {
  const index = await indexPromise;
  for (const candidate of localResourceCandidates(resourcePath)) {
    const filename = index.get(candidate.replaceAll('\\', '/').toLowerCase());
    if (filename !== undefined) {
      return fs.readFile(filename);
    }
  }
  return undefined;
}

async function indexLocalResources(mapRoot: string): Promise<Map<string, string>> {
  const root = path.resolve(mapRoot, 'resource');
  const index = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) {
        return;
      }
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filename);
      } else if (entry.isFile()) {
        const relative = path.relative(root, filename).replaceAll('\\', '/').toLowerCase();
        index.set(relative, filename);
      }
    }));
  };
  await visit(root);
  return index;
}

function localResourceCandidates(resourcePath: string): string[] {
  const normalized = normalizeResourcePath(resourcePath);
  const extension = path.extname(normalized).toLowerCase();
  if (!LOCAL_TEXTURE_EXTENSIONS.includes(extension)) {
    return [normalized];
  }
  const stem = normalized.slice(0, -extension.length);
  return [
    normalized,
    ...LOCAL_TEXTURE_EXTENSIONS
      .filter((candidateExtension) => candidateExtension !== extension)
      .map((candidateExtension) => `${stem}${candidateExtension}`)
  ];
}

async function openOptionalArchive(filename: string): Promise<StreamingMpq | undefined> {
  try {
    return await StreamingMpq.open(filename);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
