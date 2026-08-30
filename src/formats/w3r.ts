import iconv from 'iconv-lite';
import { BinaryReader, BinaryWriter } from './binary';
import type { RegionData, RegionFileData } from '../shared/model';

const MAX_REGION_COUNT = 100_000;

export function parseW3r(buffer: Buffer, encoding: string): RegionFileData {
  const reader = new BinaryReader(buffer);
  const version = reader.readInt32();
  const regionCount = reader.readInt32();
  if (!Number.isInteger(regionCount) || regionCount < 0 || regionCount > MAX_REGION_COUNT) {
    throw new Error(`Invalid W3R region count: ${regionCount}.`);
  }

  const regions: RegionData[] = [];
  for (let position = 0; position < regionCount; position += 1) {
    const left = reader.readFloat32();
    const bottom = reader.readFloat32();
    const right = reader.readFloat32();
    const top = reader.readFloat32();
    const nameBytes = reader.readCStringBytes();
    const region: RegionData = {
      left,
      bottom,
      right,
      top,
      name: '',
      index: 0,
      weatherId: '',
      ambientSound: '',
      color: { r: 255, g: 128, b: 128, a: 255 }
    };

    region.name = decodeText(nameBytes, encoding);
    region.originalName = region.name;
    region.originalNameBytes = nameBytes.toString('base64');
    region.index = reader.readInt32();
    region.weatherId = reader.readBytes(4).toString('latin1');
    const soundBytes = reader.readCStringBytes();
    region.ambientSound = decodeText(soundBytes, encoding);
    region.originalAmbientSound = region.ambientSound;
    region.originalAmbientSoundBytes = soundBytes.toString('base64');
    region.color = {
      r: reader.readUInt8(),
      g: reader.readUInt8(),
      b: reader.readUInt8(),
      a: reader.readUInt8()
    };
    regions.push(region);
  }

  if (reader.offset !== reader.buffer.length) {
    throw new Error(`Unexpected ${reader.buffer.length - reader.offset} trailing bytes in W3R.`);
  }

  return { version, regions };
}

export function writeW3r(data: RegionFileData, encoding: string): Buffer {
  if (!Number.isInteger(data.version)) {
    throw new Error(`Invalid W3R version: ${data.version}.`);
  }
  if (data.regions.length > MAX_REGION_COUNT) {
    throw new Error(`Too many W3R regions: ${data.regions.length}.`);
  }

  const writer = new BinaryWriter();
  writer.writeInt32(data.version);
  writer.writeInt32(data.regions.length);

  for (const region of data.regions) {
    const normalized = normalizeRegion(region);
    writer.writeFloat32(normalized.left);
    writer.writeFloat32(normalized.bottom);
    writer.writeFloat32(normalized.right);
    writer.writeFloat32(normalized.top);
    writer.writeCString(encodePreservingOriginal(
      normalized.name,
      normalized.originalName,
      normalized.originalNameBytes,
      encoding
    ));
    writer.writeInt32(normalized.index);
    writer.writeBytes(rawcodeBytes(normalized.weatherId));
    writer.writeCString(encodePreservingOriginal(
      normalized.ambientSound,
      normalized.originalAmbientSound,
      normalized.originalAmbientSoundBytes,
      encoding
    ));
    writer.writeUInt8(normalized.color.r);
    writer.writeUInt8(normalized.color.g);
    writer.writeUInt8(normalized.color.b);
    writer.writeUInt8(normalized.color.a);
  }

  return writer.toBuffer();
}

function normalizeRegion(region: RegionData): RegionData {
  for (const [label, value] of Object.entries({
    left: region.left,
    bottom: region.bottom,
    right: region.right,
    top: region.top
  })) {
    if (!Number.isFinite(value)) {
      throw new Error(`Region ${region.name} has invalid ${label}: ${value}.`);
    }
  }
  if (!Number.isInteger(region.index) || region.index < 0 || region.index > 0x7fffffff) {
    throw new Error(`Region ${region.name} has invalid index: ${region.index}.`);
  }
  if (region.name.includes('\0') || region.ambientSound.includes('\0')) {
    throw new Error(`Region ${region.name} contains a NUL character.`);
  }

  const color = {
    r: byteValue(region.color.r),
    g: byteValue(region.color.g),
    b: byteValue(region.color.b),
    a: byteValue(region.color.a)
  };
  return {
    ...region,
    left: Math.min(region.left, region.right),
    bottom: Math.min(region.bottom, region.top),
    right: Math.max(region.left, region.right),
    top: Math.max(region.bottom, region.top),
    color
  };
}

function byteValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 255;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

function decodeText(value: Buffer, encoding: string): string {
  return iconv.decode(value, encoding);
}

function encodePreservingOriginal(
  value: string,
  originalValue: string | undefined,
  originalBytes: string | undefined,
  encoding: string
): Buffer {
  if (originalBytes !== undefined && originalValue === value) {
    return Buffer.from(originalBytes, 'base64');
  }
  return iconv.encode(value, encoding);
}

function rawcodeBytes(value: string): Buffer {
  const source = Buffer.from(value, 'latin1');
  const result = Buffer.alloc(4);
  source.copy(result, 0, 0, Math.min(source.length, 4));
  return result;
}
