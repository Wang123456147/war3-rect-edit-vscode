import * as fs from 'node:fs/promises';
import MpqArchive from 'mdx-m3-viewer/dist/cjs/parsers/mpq/archive';
import MpqFile from 'mdx-m3-viewer/dist/cjs/parsers/mpq/file';

const MPQ_MAGIC = 0x1a51504d;
const HEADER_SIZE = 32;
const HEADER_SCAN_SIZE = 1024 * 1024;

export class StreamingMpq {
  private readonly archive: MpqArchive;

  private constructor(
    private readonly handle: fs.FileHandle,
    private readonly headerOffset: number,
    archive: MpqArchive
  ) {
    this.archive = archive;
  }

  public static async open(filename: string): Promise<StreamingMpq> {
    const handle = await fs.open(filename, 'r');
    try {
      const headerOffset = await findHeader(handle);
      const header = await readExactly(handle, HEADER_SIZE, headerOffset);
      const formatVersionAndSectorSize = header.readUInt32LE(12);
      const hashTableOffset = header.readUInt32LE(16);
      const blockTableOffset = header.readUInt32LE(20);
      const hashTableEntries = header.readUInt32LE(24);
      const blockTableEntries = Math.min(header.readUInt32LE(28), hashTableEntries);

      if (hashTableEntries === 0 || hashTableEntries > 16_777_216) {
        throw new Error(`Invalid MPQ hash table size in ${filename}.`);
      }

      const archive = new MpqArchive();
      archive.headerOffset = headerOffset;
      archive.sectorSize = 512 * (1 << (formatVersionAndSectorSize >>> 16));
      const [hashBytes, blockBytes] = await Promise.all([
        readExactly(handle, hashTableEntries * 16, headerOffset + hashTableOffset),
        readExactly(handle, blockTableEntries * 16, headerOffset + blockTableOffset)
      ]);
      // mdx-m3-viewer creates Uint32Array views from byte 0 of the backing
      // ArrayBuffer. Node Buffers may be pooled with a non-zero byteOffset, so
      // give the decoder standalone arrays whose backing buffers start at 0.
      archive.hashTable.load(Uint8Array.from(hashBytes));
      archive.blockTable.load(Uint8Array.from(blockBytes));
      archive.readonly = true;
      return new StreamingMpq(handle, headerOffset, archive);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  public async read(filename: string): Promise<Buffer | undefined> {
    const normalized = filename.replaceAll('/', '\\');
    const hash = this.archive.hashTable.get(normalized);
    if (hash === null || hash.blockIndex >= this.archive.blockTable.entries.length) {
      return undefined;
    }

    const block = this.archive.blockTable.entries[hash.blockIndex];
    if (block === undefined || block.compressedSize === 0) {
      return undefined;
    }

    const rawBuffer = await readExactly(
      this.handle,
      block.compressedSize,
      this.headerOffset + block.offset
    );
    const file = new MpqFile(this.archive, hash, block, null, null);
    file.name = normalized;
    file.nameResolved = true;
    file.rawBuffer = Uint8Array.from(rawBuffer);
    return Buffer.from(file.bytes());
  }

  public async close(): Promise<void> {
    await this.handle.close();
  }
}

async function findHeader(handle: fs.FileHandle): Promise<number> {
  const stats = await handle.stat();
  const bytes = await readExactly(handle, Math.min(HEADER_SCAN_SIZE, stats.size), 0);
  for (let offset = 0; offset + 4 <= bytes.length; offset += 512) {
    if (bytes.readUInt32LE(offset) === MPQ_MAGIC) {
      return offset;
    }
  }
  throw new Error('MPQ header not found.');
}

async function readExactly(handle: fs.FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) {
      throw new Error(`Unexpected end of MPQ at offset ${position + offset}.`);
    }
    offset += result.bytesRead;
  }
  return buffer;
}
