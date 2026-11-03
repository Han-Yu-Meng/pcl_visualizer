/**
 * pcd.js — dependency-free PCD (Point Cloud Data) reader.
 *
 * Supports:
 *   DATA ascii | binary | binary_compressed (LZF)
 *   unorganized (HEIGHT 1) and organized (HEIGHT > 1) clouds
 *   fields x, y, z and optional rgb / rgba / intensity
 *   TYPE F / D / I / U with SIZE 1, 2, 4, 8 and COUNT > 1
 *   little-endian binary payloads (what PCL and ROS write on x86)
 *
 * The reader returns plain typed arrays so it can be used without three.js.
 */

/** Decompress an LZF block. The input starts at the first LZF control byte. */
export function decompressLZF(input, outLength) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  const out = new Uint8Array(outLength);
  let i = 0;
  let o = 0;
  while (i < src.length && o < outLength) {
    const ctrl = src[i++];
    if (ctrl < 32) {
      const len = ctrl + 1;
      for (let j = 0; j < len && i < src.length && o < outLength; j++) {
        out[o++] = src[i++];
      }
    } else {
      let len = ctrl >> 5;
      let ref = o - ((ctrl & 0x1f) << 8) - 1;
      if (len === 7) len += src[i++];
      ref -= src[i++];
      len += 2;
      for (let j = 0; j < len && o < outLength; j++) {
        out[o++] = out[ref++];
      }
    }
  }
  return out;
}

const DEFAULT_SIZE = { F: 4, D: 8, I: 4, U: 4 };

function toBytes(input) {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('parsePCD expects an ArrayBuffer, Uint8Array or string');
}

function parseHeader(text, headerEnd) {
  const header = {};
  for (const raw of text.slice(0, headerEnd).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.search(/\s/);
    if (sp < 0) {
      header[line.toUpperCase()] = '';
    } else {
      header[line.slice(0, sp).toUpperCase()] = line.slice(sp + 1).trim();
    }
  }
  return header;
}

function tokenList(value, n, fallback) {
  if (!value) return new Array(n).fill(fallback);
  const parts = value.trim().split(/\s+/);
  return parts.length === n ? parts : new Array(n).fill(fallback);
}

function readNumber(dv, off, type, size) {
  switch (type) {
    case 'F': return size === 8 ? dv.getFloat64(off, true) : dv.getFloat32(off, true);
    case 'D': return dv.getFloat64(off, true);
    case 'I':
      if (size === 1) return dv.getInt8(off);
      if (size === 2) return dv.getInt16(off, true);
      if (size === 4) return dv.getInt32(off, true);
      return Number(dv.getBigInt64(off, true));
    case 'U':
      if (size === 1) return dv.getUint8(off);
      if (size === 2) return dv.getUint16(off, true);
      if (size === 4) return dv.getUint32(off, true);
      return Number(dv.getBigUint64(off, true));
    default: return dv.getFloat32(off, true);
  }
}

/** Reinterpret a float32 value as the packed 0x00RRGGBB integer PCL stores in rgb. */
function floatToPackedRGB(v) {
  return new Uint32Array(new Float32Array([v]).buffer)[0];
}

/**
 * Parse a PCD file.
 * Returns count, positions, optional colors/intensity, bounds and header info.
 */
export function parsePCD(input) {
  const bytes = toBytes(input);
  const scanLen = Math.min(bytes.length, 1 << 16);
  let head = '';
  for (let i = 0; i < scanLen; i++) head += String.fromCharCode(bytes[i]);

  // The header ends on the line DATA <encoding>. Header bytes are ASCII,
  // so character offsets equal byte offsets here.
  let m = /^[\s\S]*?^DATA[ \t]+(\S+)[ \t]*\r?\n/im.exec(head);
  if (!m) m = /^[\s\S]*?^DATA[ \t]+(\S+)[ \t]*$/im.exec(head);
  if (!m) throw new Error('不是有效的 PCD 文件：找不到 DATA 行');
  const encoding = m[1].toLowerCase();
  const headerEnd = m[0].length;

  const header = parseHeader(head, headerEnd);
  const fieldNames = (header.FIELDS || '').trim().split(/\s+/).filter(Boolean);
  if (!fieldNames.length) throw new Error('PCD 头缺少 FIELDS');
  const n = fieldNames.length;

  const sizeParts = (header.SIZE || '').trim().split(/\s+/).filter(Boolean);
  const typeParts = tokenList(header.TYPE, n, 'F').map((t) => t.toUpperCase());
  const countParts = tokenList(header.COUNT, n, '1').map(Number);
  const sizes = (sizeParts.length === n ? sizeParts : typeParts.map((t) => DEFAULT_SIZE[t] || 4)).map(Number);
  const counts = countParts.map((c) => (Number.isFinite(c) && c > 0 ? Math.floor(c) : 1));

  const width = Number(header.WIDTH) || 0;
  const height = Number(header.HEIGHT) || 1;
  const declared = Number(header.POINTS) || width * height;
  if (!Number.isFinite(declared) || declared <= 0) {
    throw new Error('PCD 头缺少有效的 POINTS / WIDTH');
  }

  // Field layout: byte offset within a point, and token index for ASCII rows.
  const field = {};
  let byteOff = 0;
  let tokenOff = 0;
  for (let f = 0; f < n; f++) {
    field[fieldNames[f]] = {
      index: f, offset: byteOff, token: tokenOff,
      size: sizes[f], type: typeParts[f], count: counts[f],
    };
    byteOff += sizes[f] * counts[f];
    tokenOff += counts[f];
  }
  for (const key of ['x', 'y', 'z']) {
    if (!field[key]) throw new Error('PCD 缺少 ' + key + ' 字段');
  }
  const stride = byteOff;
  const rgbField = field.rgb || field.rgba;
  const hasRGB = !!rgbField;
  const intensityField = field.intensity;

  const points = declared;
  const positions = new Float32Array(points * 3);
  const colors = hasRGB ? new Float32Array(points * 3) : null;
  const intensity = intensityField ? new Float32Array(points) : null;
  let kept = 0;

  const pushPoint = (x, y, z, r, g, b, iVal) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const at = kept * 3;
    positions[at] = x; positions[at + 1] = y; positions[at + 2] = z;
    if (colors) { colors[at] = r; colors[at + 1] = g; colors[at + 2] = b; }
    if (intensity) intensity[kept] = Number.isFinite(iVal) ? iVal : 0;
    kept++;
  };

  if (encoding === 'ascii') {
    const body = new TextDecoder().decode(bytes.subarray(headerEnd));
    for (const line of body.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      const tok = s.split(/\s+/);
      const x = parseFloat(tok[field.x.token]);
      const y = parseFloat(tok[field.y.token]);
      const z = parseFloat(tok[field.z.token]);
      let r = 1, g = 1, b = 1;
      if (rgbField) {
        const v = parseFloat(tok[rgbField.token]);
        // Some writers emit the packed integer directly; PCL emits the
        // float32 bit pattern, which is usually a very small number.
        const bits = Number.isFinite(v)
          ? (v > 1 ? Math.round(v) : floatToPackedRGB(v)) >>> 0
          : 0;
        r = ((bits >> 16) & 0xff) / 255;
        g = ((bits >> 8) & 0xff) / 255;
        b = (bits & 0xff) / 255;
      }
      const iVal = intensityField ? parseFloat(tok[intensityField.token]) : 0;
      pushPoint(x, y, z, r, g, b, iVal);
    }
  } else if (encoding === 'binary') {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Some PCL writers pad each row to the alignment of their point struct.
    // Detect that from the payload length so field offsets still stay valid.
    const available = bytes.byteLength - headerEnd;
    let rowSize = stride;
    if (available % points === 0 && available > points * stride) {
      const candidate = available / points;
      if (Number.isInteger(candidate) && candidate <= stride * 4) rowSize = candidate;
    }
    const base = headerEnd;
    for (let p = 0; p < points; p++) {
      const row = base + p * rowSize;
      if (row + stride > bytes.byteLength) break;
      const x = readNumber(dv, row + field.x.offset, field.x.type, field.x.size);
      const y = readNumber(dv, row + field.y.offset, field.y.type, field.y.size);
      const z = readNumber(dv, row + field.z.offset, field.z.type, field.z.size);
      let r = 1, g = 1, b = 1;
      if (rgbField) {
        const bits = rgbField.size === 4
          ? dv.getUint32(row + rgbField.offset, true)
          : readNumber(dv, row + rgbField.offset, rgbField.type, rgbField.size) >>> 0;
        r = ((bits >> 16) & 0xff) / 255;
        g = ((bits >> 8) & 0xff) / 255;
        b = (bits & 0xff) / 255;
      }
      const iVal = intensityField
        ? readNumber(dv, row + intensityField.offset, intensityField.type, intensityField.size)
        : 0;
      pushPoint(x, y, z, r, g, b, iVal);
    }
  } else if (encoding === 'binary_compressed') {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const compressedSize = dv.getUint32(headerEnd, true);
    const uncompressedSize = dv.getUint32(headerEnd + 4, true);
    const start = headerEnd + 8;
    if (start + compressedSize > bytes.byteLength) {
      throw new Error('binary_compressed 数据被截断');
    }
    const raw = decompressLZF(new Uint8Array(bytes.buffer, bytes.byteOffset + start, compressedSize), uncompressedSize);
    const soa = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    // PCL stores compressed clouds as a structure-of-arrays: every field's
    // values for all points are contiguous, in header field order.
    const fieldStart = (f) => points * f.offset;
    const readSoA = (f, p) => readNumber(soa, fieldStart(f) + p * f.size, f.type, f.size);
    const rgbStart = rgbField ? points * rgbField.offset : 0;
    for (let p = 0; p < points; p++) {
      const x = readSoA(field.x, p);
      const y = readSoA(field.y, p);
      const z = readSoA(field.z, p);
      let r = 1, g = 1, b = 1;
      if (rgbField) {
        const bits = rgbField.size === 4
          ? soa.getUint32(rgbStart + p * 4, true)
          : readSoA(rgbField, p) >>> 0;
        r = ((bits >> 16) & 0xff) / 255;
        g = ((bits >> 8) & 0xff) / 255;
        b = (bits & 0xff) / 255;
      }
      const iVal = intensityField ? readSoA(intensityField, p) : 0;
      pushPoint(x, y, z, r, g, b, iVal);
    }
  } else {
    throw new Error('不支持的 PCD 编码: ' + encoding);
  }

  const pos = positions.subarray(0, kept * 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < min[k]) min[k] = pos[i + k];
      if (pos[i + k] > max[k]) max[k] = pos[i + k];
    }
  }
  if (!kept) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 1;
  }
  return {
    count: kept,
    positions: pos.slice(),
    colors: colors ? colors.subarray(0, kept * 3).slice() : null,
    intensity: intensity ? intensity.subarray(0, kept).slice() : null,
    bounds: { min, max },
    fields: fieldNames,
    encoding,
    header,
  };
}
