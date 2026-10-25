import { File, FileMode } from 'expo-file-system';

export interface PlyPoint {
  x: number;
  y: number;
  z: number;
}

export interface PlyTriangle {
  a: PlyPoint;
  b: PlyPoint;
  c: PlyPoint;
}

export interface PlyPointCloud {
  vertexCount: number;
  points: PlyPoint[];
  faceCount: number;
  triangles: PlyTriangle[];
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
  faceCount: number;
  dataOffset: number;
  faceDataOffset: number | null;
  stride: number;
  properties: VertexProperty[];
  faceListCountType: ScalarType | null;
  faceVertexIndexType: ScalarType | null;
}

const HEADER_LIMIT_BYTES = 64 * 1024;
const BINARY_CHUNK_BYTES = 1024 * 1024;
const ASCII_CHUNK_BYTES = 32 * 1024;
const MAX_PREVIEW_POINTS = 4_000;
const MAX_PREVIEW_TRIANGLES = 650;

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
  let faceCount = 0;
  let stride = 0;
  const elementNames: string[] = [];
  const properties: VertexProperty[] = [];
  let faceListCountType: ScalarType | null = null;
  let faceVertexIndexType: ScalarType | null = null;

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
      elementNames.push(currentElement);
      if (!firstElement) firstElement = currentElement;
      if (currentElement === 'vertex') {
        vertexCount = Number(parts[2]);
      } else if (currentElement === 'face') {
        faceCount = Number(parts[2]);
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
    } else if (
      parts[0] === 'property' &&
      currentElement === 'face' &&
      parts[1] === 'list' &&
      (parts[4] === 'vertex_indices' || parts[4] === 'vertex_index')
    ) {
      faceListCountType = scalarTypes[(parts[2] ?? '').toLowerCase()] ?? null;
      faceVertexIndexType = scalarTypes[(parts[3] ?? '').toLowerCase()] ?? null;
    }
  }

  if (!format || !Number.isSafeInteger(vertexCount) || vertexCount < 1) {
    throw new Error('PLY format or vertex count is invalid');
  }
  if (!Number.isSafeInteger(faceCount) || faceCount < 0) {
    throw new Error('PLY face count is invalid');
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

  const faceDataOffset =
    format !== 'ascii' &&
    elementNames[0] === 'vertex' &&
    elementNames[1] === 'face'
      ? dataOffset + vertexCount * stride
      : null;

  return {
    format,
    vertexCount,
    faceCount,
    dataOffset,
    faceDataOffset,
    stride,
    properties,
    faceListCountType,
    faceVertexIndexType,
  };
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
  requiredVertexIndices: Set<number>,
): Promise<{ points: PlyPoint[]; indexedPoints: Map<number, PlyPoint> }> {
  const points: PlyPoint[] = [];
  const indexedPoints = new Map<number, PlyPoint>();
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
    for (let vertexIndex = firstVertex; vertexIndex < endVertex; vertexIndex += 1) {
      const isSample =
        vertexIndex % sampleStep === 0 ||
        vertexIndex === header.vertexCount - 1;
      const isRequired = requiredVertexIndices.has(vertexIndex);
      if (!isSample && !isRequired) continue;
      const recordOffset = (vertexIndex - firstVertex) * header.stride;
      const x = xProperty.type.read(
        view,
        recordOffset + xProperty.offset,
        littleEndian,
      );
      const y = yProperty.type.read(
        view,
        recordOffset + yProperty.offset,
        littleEndian,
      );
      const z = zProperty.type.read(
        view,
        recordOffset + zProperty.offset,
        littleEndian,
      );
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        continue;
      }
      const point = { x, y, z };
      if (isSample) points.push(point);
      if (isRequired) indexedPoints.set(vertexIndex, point);
    }

    firstVertex = endVertex;
    chunkIndex += 1;
    if (chunkIndex % 4 === 0) await yieldToUi();
  }

  return { points, indexedPoints };
}

async function readBinaryFaceIndices(
  handle: ReturnType<File['open']>,
  header: PlyHeader,
  littleEndian: boolean,
  isCancelled: () => boolean,
): Promise<Array<[number, number, number]>> {
  if (header.faceCount === 0 || header.faceDataOffset === null) return [];
  const countType = header.faceListCountType;
  const indexType = header.faceVertexIndexType;
  if (!countType || !indexType) {
    throw new Error('PLY faces do not contain supported vertex indices');
  }

  handle.offset = header.faceDataOffset;
  const sampleStep = Math.max(
    1,
    Math.ceil(header.faceCount / MAX_PREVIEW_TRIANGLES),
  );
  const triangles: Array<[number, number, number]> = [];
  let pending = new Uint8Array(0);
  let faceIndex = 0;
  let chunkIndex = 0;

  while (faceIndex < header.faceCount) {
    if (isCancelled()) throw new Error('PLY preview cancelled');
    const chunk = handle.readBytes(BINARY_CHUNK_BYTES);
    if (chunk.length === 0) {
      throw new Error('PLY face data is incomplete');
    }
    const bytes = new Uint8Array(pending.length + chunk.length);
    bytes.set(pending);
    bytes.set(chunk, pending.length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;

    while (faceIndex < header.faceCount) {
      if (offset + countType.size > bytes.length) break;
      const listLength = countType.read(view, offset, littleEndian);
      if (
        !Number.isSafeInteger(listLength) ||
        listLength < 3 ||
        listLength > 10_000
      ) {
        throw new Error('PLY face has an invalid vertex list');
      }
      const recordSize = countType.size + listLength * indexType.size;
      if (offset + recordSize > bytes.length) break;

      if (faceIndex % sampleStep === 0 && triangles.length < MAX_PREVIEW_TRIANGLES) {
        const firstIndex = indexType.read(
          view,
          offset + countType.size,
          littleEndian,
        );
        let previousIndex = indexType.read(
          view,
          offset + countType.size + indexType.size,
          littleEndian,
        );
        for (let listIndex = 2; listIndex < listLength; listIndex += 1) {
          const nextIndex = indexType.read(
            view,
            offset + countType.size + listIndex * indexType.size,
            littleEndian,
          );
          if (
            Number.isSafeInteger(firstIndex) &&
            Number.isSafeInteger(previousIndex) &&
            Number.isSafeInteger(nextIndex) &&
            firstIndex >= 0 &&
            previousIndex >= 0 &&
            nextIndex >= 0 &&
            firstIndex < header.vertexCount &&
            previousIndex < header.vertexCount &&
            nextIndex < header.vertexCount
          ) {
            triangles.push([firstIndex, previousIndex, nextIndex]);
          }
          previousIndex = nextIndex;
          if (triangles.length >= MAX_PREVIEW_TRIANGLES) break;
        }
      }

      offset += recordSize;
      faceIndex += 1;
    }

    pending = bytes.slice(offset);
    if (pending.length > BINARY_CHUNK_BYTES) {
      throw new Error('PLY face record is too large to preview');
    }
    chunkIndex += 1;
    if (chunkIndex % 4 === 0) await yieldToUi();
  }

  return triangles;
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
    const littleEndian = header.format === 'binary_little_endian';
    const faceIndices =
      header.format === 'ascii'
        ? []
        : await readBinaryFaceIndices(
            handle,
            header,
            littleEndian,
            isCancelled,
          );
    const requiredVertexIndices = new Set(faceIndices.flat());
    handle.offset = header.dataOffset;
    const { points, indexedPoints } =
      header.format === 'ascii'
        ? {
            points: await readAsciiPoints(
              handle,
              header,
              sampleStep,
              isCancelled,
            ),
            indexedPoints: new Map<number, PlyPoint>(),
          }
        : await readBinaryPoints(
            handle,
            header,
            sampleStep,
            littleEndian,
            isCancelled,
            requiredVertexIndices,
          );

    if (points.length < 3) {
      throw new Error('PLY file contains too few valid points');
    }
    const triangles = faceIndices
      .map(([a, b, c]) => {
        const pointA = indexedPoints.get(a);
        const pointB = indexedPoints.get(b);
        const pointC = indexedPoints.get(c);
        return pointA && pointB && pointC
          ? { a: pointA, b: pointB, c: pointC }
          : null;
      })
      .filter((triangle): triangle is PlyTriangle => triangle !== null);
    return {
      vertexCount: header.vertexCount,
      points,
      faceCount: header.faceCount,
      triangles,
    };
  } finally {
    handle.close();
  }
}
