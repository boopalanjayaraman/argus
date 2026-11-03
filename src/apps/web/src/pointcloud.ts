// PLY parsing + sampling for the evidence viewer (PRD-09).
// Supports ascii and binary_little_endian PLY with float x/y/z and
// optional uchar red/green/blue; unknown properties are skipped by stride.

export const VIEWER_POINT_CAP = 300_000;

export interface PointCloud {
  positions: Float32Array;
  colors: Uint8Array | null;
  count: number;
}

const TYPE_SIZE: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8
};

interface Prop { name: string; type: string; size: number }

export function parsePly(buffer: ArrayBuffer): PointCloud {
  const bytes = new Uint8Array(buffer);
  const headEnd = findHeaderEnd(bytes);
  if (headEnd < 0) throw new Error('Malformed PLY: no end_header');
  const header = new TextDecoder().decode(bytes.subarray(0, headEnd));
  const lines = header.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines[0] !== 'ply') throw new Error('Malformed PLY: missing ply magic');
  const format = lines.find(l => l.startsWith('format '))?.split(/\s+/)[1];
  let count = 0;
  const props: Prop[] = [];
  let inVertex = false;
  for (const line of lines) {
    if (line.startsWith('element ')) {
      inVertex = line.split(/\s+/)[1] === 'vertex';
      if (inVertex) count = parseInt(line.split(/\s+/)[2], 10);
      continue;
    }
    if (inVertex && line.startsWith('property ')) {
      const [, type, name] = line.split(/\s+/);
      if (!(type in TYPE_SIZE)) throw new Error(`Unsupported PLY property type: ${type}`);
      props.push({ name, type, size: TYPE_SIZE[type] });
    }
  }
  if (!count || !props.some(p => p.name === 'x')) throw new Error('Malformed PLY: no vertex x/y/z');

  const positions = new Float32Array(count * 3);
  const hasColor = ['red', 'green', 'blue'].every(n => props.some(p => p.name === n));
  const colors = hasColor ? new Uint8Array(count * 3) : null;

  if (format === 'ascii') {
    const rows = new TextDecoder().decode(bytes.subarray(headEnd)).trim().split('\n');
    const idx: Record<string, number> = {};
    props.forEach((p, i) => { idx[p.name] = i; });
    for (let i = 0; i < count; i++) {
      const v = rows[i].trim().split(/\s+/).map(Number);
      positions[i * 3] = v[idx.x]; positions[i * 3 + 1] = v[idx.y]; positions[i * 3 + 2] = v[idx.z];
      if (colors) { colors[i * 3] = v[idx.red]; colors[i * 3 + 1] = v[idx.green]; colors[i * 3 + 2] = v[idx.blue]; }
    }
    return { positions, colors, count };
  }
  if (format !== 'binary_little_endian') throw new Error(`Unsupported PLY format: ${format}`);

  const stride = props.reduce((s, p) => s + p.size, 0);
  // A chunk header can declare more vertices than the file carries
  // (truncated stream); render what is actually present.
  const readable = Math.floor((buffer.byteLength - headEnd) / stride);
  if (readable < count) count = readable;
  const offsets: Record<string, number> = {};
  let off = 0;
  for (const p of props) { offsets[p.name] = off; off += p.size; }
  const view = new DataView(buffer, headEnd);
  const read = (base: number, p: Prop): number => {
    const o = base + offsets[p.name];
    if (p.type.startsWith('float') || p.type === 'double') return p.size === 8 ? view.getFloat64(o, true) : view.getFloat32(o, true);
    if (p.type.includes('char')) return view.getUint8(o);
    if (p.size === 2) return view.getUint16(o, true);
    return view.getUint32(o, true);
  };
  const byName: Record<string, Prop> = {};
  props.forEach(p => { byName[p.name] = p; });
  for (let i = 0; i < count; i++) {
    const base = i * stride;
    positions[i * 3] = read(base, byName.x);
    positions[i * 3 + 1] = read(base, byName.y);
    positions[i * 3 + 2] = read(base, byName.z);
    if (colors) {
      colors[i * 3] = read(base, byName.red);
      colors[i * 3 + 1] = read(base, byName.green);
      colors[i * 3 + 2] = read(base, byName.blue);
    }
  }
  return { positions, colors, count };
}

function findHeaderEnd(bytes: Uint8Array): number {
  const marker = new TextEncoder().encode('end_header');
  outer: for (let i = 0; i + marker.length <= bytes.length; i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer;
    let end = i + marker.length;
    if (bytes[end] === 13) end++;
    if (bytes[end] === 10) end++;
    return end;
  }
  return -1;
}

/** Deterministic stride sampling: rendered = ceil(total / stride) ≤ cap. */
export function samplePoints(total: number, cap: number): { stride: number; rendered: number } {
  if (total <= cap) return { stride: 1, rendered: total };
  const stride = Math.ceil(total / cap);
  return { stride, rendered: Math.ceil(total / stride) };
}

/** Merge parsed clouds into one sampled geometry (bounding box centered). */
export function mergeClouds(clouds: PointCloud[], cap = VIEWER_POINT_CAP): PointCloud {
  const total = clouds.reduce((s, c) => s + c.count, 0);
  const { stride, rendered } = samplePoints(total, cap);
  const positions = new Float32Array(rendered * 3);
  const colors = new Uint8Array(rendered * 3);
  let out = 0;
  let seen = 0;
  for (const cloud of clouds) {
    for (let i = 0; i < cloud.count; i++, seen++) {
      const px = cloud.positions[i * 3], py = cloud.positions[i * 3 + 1], pz = cloud.positions[i * 3 + 2];
      // Drop non-finite / absurd outliers (>1 km in mm) so one bad chunk
      // cannot poison the merged bounding box.
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz) || Math.abs(px) > 1e6 || Math.abs(py) > 1e6 || Math.abs(pz) > 1e6) continue;
      if (seen % stride !== 0) continue;
      positions[out * 3] = cloud.positions[i * 3];
      positions[out * 3 + 1] = cloud.positions[i * 3 + 1];
      positions[out * 3 + 2] = cloud.positions[i * 3 + 2];
      if (cloud.colors) {
        colors[out * 3] = cloud.colors[i * 3];
        colors[out * 3 + 1] = cloud.colors[i * 3 + 1];
        colors[out * 3 + 2] = cloud.colors[i * 3 + 2];
      } else { colors[out * 3] = colors[out * 3 + 1] = colors[out * 3 + 2] = 180; }
      out++;
    }
  }
  return { positions: positions.subarray(0, out * 3), colors, count: out };
}
