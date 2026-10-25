import { File, FileMode } from 'expo-file-system';

export interface PlyPoint {
  x: number;
  y: number;
  z: number;
}

export interface PlyPointCloud {
  vertexCount: number;
  points: PlyPoint[];
}

interface ScalarType {
  size: number;
  read: (view: DataView, offset: number, littleEndian: boolean) => number;
}

interface VertexProperty {
  name: string;
  offset: number;
  type: ScalarType;
}

interface PlyHeader {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  vertexCount: number;
  dataOffset: number;
  stride: number;
  properties: VertexProperty[];
}

const HEADER_LIMIT_BYTES = 64 * 1024;
const BINARY_CHUNK_BYTES = 1024 * 1024;
const ASCII_CHUNK_BYTES = 32 * 1024;
const MAX_PREVIEW_POINTS = 4_000;

const scalarTypes: Record<string, ScalarType> = {
  char: { size: 1, read: (view, offset) => view.getInt8(offset) },
  int8: { size: 1, read: (view, offset) => view.getInt8(offset) },
  uchar: { size: 1, read: (view, offset) => view.getUint8(offset) },
  uint8: { size: 1, read: (view, offset) => view.getUint8(offset) },
  short: { size: 2, read: (view, offset, little) => view.getInt16(offset, little) },
  int16: { size: 2, read: (view, offset, little) => view.getInt16(offset, little) },
  ushort: { size: 2, read: (view, offset, little) => view.getUint16(offset, little) },
  uint16: { size: 2, read: (view, offset, little) => view.getUint16(offset, little) },
  int: { size: 4, read: (view, offset, little) => view.getInt32(offset, little) },
  int32: { size: 4, read: (view, offset, little) => view.getInt32(offset, little) },
  uint: { size: 4, read: (view, offset, little) => view.getUint32(offset, little) },
  uint32: { size: 4, read: (view, offset, little) => view.getUint32(offset, little) },
  float: { size: 4, read: (view, offset, little) => view.getFloat32(offset, little) },
  float32: { size: 4, read: (view, offset, little) => view.getFloat32(offset, little) },
  double: { size: 8, read: (view, offset, little) => view.getFloat64(offset, little) },
  float64: { size: 8, read: (view, offset, little) => view.getFloat64(offset, little) },
};

function decodeAscii(bytes: Uint8Array): string {
  const decoded: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    decoded.push(
      String.fromCharCode(...bytes.subarray(offset, offset + 8_192)),
    );
  }
  return decoded.join('');
}

function parseHeader(text: string, dataOffset: number): PlyHeader {
  const headerEnd = text.indexOf('end_header');
  if (headerEnd < 0 || text.slice(0, headerEnd).split(/\r?\n/)[0]?.trim() !== 'ply') {
    throw new Error('Invalid PLY header');
  }

  let format: PlyHeader['format'] | null = null;
  let currentElement = '';
  let firstElement = '';
  let vertexCount = 0;
  let stride = 0;
  const properties: VertexProperty[] = [];

  for (const rawLine of text.slice(0, headerEnd).split(/\r?\n/).slice(1)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts[0] === 'format') {
      const candidate = parts[1];
      if (
        candidate === 'ascii' ||
        candidate === 'binary_little_endian' ||
        candidate === 'binary_big_endian'
      ) {
        format = candidate;
      }
    } else if (parts[0] === 'element') {
      currentElement = parts[1] ?? '';
      if (!firstElement) firstElement = currentElement;
      if (currentElement === 'vertex') {
        vertexCount = Number(parts[2]);
      }
    } else if (parts[0] === 'property' && currentElement === 'vertex') {
      if (parts[1] === 'list') {
        throw new Error('PLY vertex list properties cannot be previewed');
      }
      const type = scalarTypes[(parts[1] ?? '').toLowerCase()];
      const name = parts[2];
      if (!type || !name) {
        throw new Error('PLY vertex property is not supported');
      }
      properties.push({ name, offset: stride, type });
      stride += type.size;
    }
  }

  if (!format || !Number.isSafeInteger(vertexCount) || vertexCount < 1) {
    throw new Error('PLY format or vertex count is invalid');
  }
  if (firstElement !== 'vertex') {
    throw new Error('PLY vertex data must be the first element');
  }
  if (!properties.some((property) => property.name === 'x') ||
      !properties.some((property) => property.name === 'y') ||
      !properties.some((property) => property.name === 'z') ||
      stride < 1) {
    throw new Error('PLY file is missing 3D coordinates');
  }

  return { format, vertexCount, dataOffset, stride, properties };
}

function coordinateProperty(header: PlyHeader, axis: 'x' | 'y' | 'z') {
  const property = header.properties.find((entry) => entry.name === axis);
  if (!property) throw new Error('PLY file is missing 3D coordinates');
  return property;
}

function appendPoint(
  points: PlyPoint[],
  x: number,
  y: number,
  z: number,
): void {
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
    points.push({ x, y, z });
  }
}

function parseAsciiVertex(
  line: string,
  header: PlyHeader,
  points: PlyPoint[],
): void {
  const values = line.trim().split(/\s+/);
  const indexOf = (axis: 'x' | 'y' | 'z') =>
    header.properties.findIndex((property) => property.name === axis);
  appendPoint(
    points,
    Number(values[indexOf('x')]),
    Number(values[indexOf('y')]),
    Number(values[indexOf('z')]),
  );
}

async function yieldToUi(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function readAsciiPoints(
  handle: ReturnType<File['open']>,
  header: PlyHeader,
  sampleStep: number,
  isCancelled: () => boolean,
): Promise<PlyPoint[]> {
  const points: PlyPoint[] = [];
  let pending = '';
  let vertexIndex = 0;
  let chunkIndex = 0;

  while (vertexIndex < header.vertexCount) {
    if (isCancelled()) throw new Error('PLY preview cancelled');
    const bytes = handle.readBytes(ASCII_CHUNK_BYTES);
    if (bytes.length === 0) break;
    pending += decodeAscii(bytes);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';

    for (const line of lines) {
      if (vertexIndex >= header.vertexCount) break;
      if (!line.trim()) continue;
      if (vertexIndex % sampleStep === 0 || vertexIndex === header.vertexCount - 1) {
        parseAsciiVertex(line, header, points);
      }
      vertexIndex += 1;
    }

    chunkIndex += 1;
    if (chunkIndex % 4 === 0) await yieldToUi();
  }

  if (vertexIndex < header.vertexCount && pending.trim()) {
    if (vertexIndex % sampleStep === 0 || vertexIndex === header.vertexCount - 1) {
      parseAsciiVertex(pending, header, points);
    }
    vertexIndex += 1;
  }
  if (vertexIndex !== header.vertexCount) {
    throw new Error('PLY vertex data is incomplete');
  }
  return points;
}

async function readBinaryPoints(
  handle: ReturnType<File['open']>,
  header: PlyHeader,
  sampleStep: number,
  littleEndian: boolean,
  isCancelled: () => boolean,
): Promise<PlyPoint[]> {
  const points: PlyPoint[] = [];
  const xProperty = coordinateProperty(header, 'x');
  const yProperty = coordinateProperty(header, 'y');
  const zProperty = coordinateProperty(header, 'z');
  const recordsPerChunk = Math.max(
    1,
    Math.floor(BINARY_CHUNK_BYTES / header.stride),
  );
  let firstVertex = 0;
  let chunkIndex = 0;

  while (firstVertex < header.vertexCount) {
    if (isCancelled()) throw new Error('PLY preview cancelled');
    const recordCount = Math.min(
      recordsPerChunk,
      header.vertexCount - firstVertex,
    );
    const expectedBytes = recordCount * header.stride;
    const bytes = handle.readBytes(expectedBytes);
    if (bytes.length !== expectedBytes) {
      throw new Error('PLY vertex data is incomplete');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const endVertex = firstVertex + recordCount;
    let vertexIndex = Math.ceil(firstVertex / sampleStep) * sampleStep;
    while (vertexIndex < endVertex) {
      const recordOffset = (vertexIndex - firstVertex) * header.stride;
      appendPoint(
        points,
        xProperty.type.read(view, recordOffset + xProperty.offset, littleEndian),
        yProperty.type.read(view, recordOffset + yProperty.offset, littleEndian),
        zProperty.type.read(view, recordOffset + zProperty.offset, littleEndian),
      );
      vertexIndex += sampleStep;
    }
    if (
      endVertex === header.vertexCount &&
      (header.vertexCount - 1) % sampleStep !== 0
    ) {
      const recordOffset = (recordCount - 1) * header.stride;
      appendPoint(
        points,
        xProperty.type.read(view, recordOffset + xProperty.offset, littleEndian),
        yProperty.type.read(view, recordOffset + yProperty.offset, littleEndian),
        zProperty.type.read(view, recordOffset + zProperty.offset, littleEndian),
      );
    }

    firstVertex = endVertex;
    chunkIndex += 1;
    if (chunkIndex % 4 === 0) await yieldToUi();
  }

  return points;
}

export async function loadPlyPointCloud(
  uri: string,
  isCancelled: () => boolean = () => false,
): Promise<PlyPointCloud> {
  const file = new File(uri);
  const fileSize = file.size;
  if (!file.exists || fileSize < 16) {
    throw new Error('PLY file is missing or empty');
  }

  const handle = file.open(FileMode.ReadOnly);
  try {
    const headerBytes = handle.readBytes(
      Math.min(HEADER_LIMIT_BYTES, fileSize),
    );
    const headerText = decodeAscii(headerBytes);
    const endMarker = headerText.indexOf('end_header');
    const newlineAfterHeader =
      endMarker < 0 ? -1 : headerText.indexOf('\n', endMarker);
    if (newlineAfterHeader < 0) {
      throw new Error('PLY header is missing or too large');
    }

    const dataOffset = newlineAfterHeader + 1;
    const header = parseHeader(headerText, dataOffset);
    if (header.format !== 'ascii') {
      const requiredBytes = header.dataOffset + header.vertexCount * header.stride;
      if (requiredBytes > fileSize) {
        throw new Error('PLY vertex data is incomplete');
      }
    }
    handle.offset = header.dataOffset;

    const sampleStep = Math.max(
      1,
      Math.ceil(header.vertexCount / MAX_PREVIEW_POINTS),
    );
    const points =
      header.format === 'ascii'
        ? await readAsciiPoints(handle, header, sampleStep, isCancelled)
        : await readBinaryPoints(
            handle,
            header,
            sampleStep,
            header.format === 'binary_little_endian',
            isCancelled,
          );

    if (points.length < 3) {
      throw new Error('PLY file contains too few valid points');
    }
    return { vertexCount: header.vertexCount, points };
  } finally {
    handle.close();
  }
}
