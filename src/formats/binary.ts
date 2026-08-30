export class BinaryReader {
  public offset = 0;

  public constructor(public readonly buffer: Buffer) {}

  public ensure(length: number): void {
    if (length < 0 || this.offset + length > this.buffer.length) {
      throw new Error(`Unexpected end of file at byte ${this.offset}.`);
    }
  }

  public readBytes(length: number): Buffer {
    this.ensure(length);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  public readUInt8(): number {
    this.ensure(1);
    return this.buffer[this.offset++]!;
  }

  public readUInt16(): number {
    this.ensure(2);
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  public readInt32(): number {
    this.ensure(4);
    const value = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  public readFloat32(): number {
    this.ensure(4);
    const value = this.buffer.readFloatLE(this.offset);
    this.offset += 4;
    return value;
  }

  public readCStringBytes(): Buffer {
    const end = this.buffer.indexOf(0, this.offset);
    if (end === -1) {
      throw new Error(`Unterminated string at byte ${this.offset}.`);
    }
    const value = this.buffer.subarray(this.offset, end);
    this.offset = end + 1;
    return value;
  }
}

export class BinaryWriter {
  private readonly chunks: Buffer[] = [];

  public writeBytes(value: Buffer): void {
    this.chunks.push(value);
  }

  public writeUInt8(value: number): void {
    const buffer = Buffer.allocUnsafe(1);
    buffer.writeUInt8(value);
    this.chunks.push(buffer);
  }

  public writeInt32(value: number): void {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeInt32LE(value);
    this.chunks.push(buffer);
  }

  public writeFloat32(value: number): void {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeFloatLE(value);
    this.chunks.push(buffer);
  }

  public writeCString(value: Buffer): void {
    this.chunks.push(value, Buffer.from([0]));
  }

  public toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
