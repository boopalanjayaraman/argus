import { describe, it, expect } from 'vitest';
import { parsePly, samplePoints, VIEWER_POINT_CAP } from './pointcloud';

function binaryPly(points: [number, number, number, number, number, number][]): ArrayBuffer {
  const header = [
    'ply', 'format binary_little_endian 1.0', `element vertex ${points.length}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue',
    'property uchar scanner_id', 'property uchar intensity', 'end_header', ''
  ].join('\n');
  const head = new TextEncoder().encode(header);
  const body = new DataView(new ArrayBuffer(points.length * 17));
  points.forEach((pt, i) => {
    const o = i * 17;
    body.setFloat32(o, pt[0], true); body.setFloat32(o + 4, pt[1], true); body.setFloat32(o + 8, pt[2], true);
    body.setUint8(o + 12, pt[3]); body.setUint8(o + 13, pt[4]); body.setUint8(o + 14, pt[5]);
    body.setUint8(o + 15, 1); body.setUint8(o + 16, 200);
  });
  const out = new Uint8Array(head.length + body.byteLength);
  out.set(head); out.set(new Uint8Array(body.buffer), head.length);
  return out.buffer;
}

describe('parsePly', () => {
  it('reads binary_little_endian x/y/z + RGB, skipping extra props', () => {
    const cloud = parsePly(binaryPly([[1, 2, 3, 255, 0, 0], [-4.5, 0.25, 100, 0, 128, 255]]));
    expect(cloud.count).toBe(2);
    expect(Array.from(cloud.positions)).toEqual([1, 2, 3, -4.5, 0.25, 100]);
    expect(Array.from(cloud.colors!)).toEqual([255, 0, 0, 0, 128, 255]);
  });

  it('reads ascii PLY', () => {
    const text = ['ply', 'format ascii 1.0', 'element vertex 2',
      'property float x', 'property float y', 'property float z',
      'property uchar red', 'property uchar green', 'property uchar blue',
      'end_header', '0 1 2 10 20 30', '3 4 5 40 50 60', ''].join('\n');
    const cloud = parsePly(new TextEncoder().encode(text).buffer as ArrayBuffer);
    expect(cloud.count).toBe(2);
    expect(Array.from(cloud.positions)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Array.from(cloud.colors!)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('throws on a malformed header', () => {
    expect(() => parsePly(new TextEncoder().encode('not a ply').buffer as ArrayBuffer)).toThrow();
  });
});

describe('samplePoints', () => {
  it('keeps every point under the cap', () => {
    expect(samplePoints(100, VIEWER_POINT_CAP)).toEqual({ stride: 1, rendered: 100 });
  });
  it('samples deterministically over the cap', () => {
    const a = samplePoints(800_000, 300_000);
    expect(a.rendered).toBeLessThanOrEqual(300_000);
    expect(a).toEqual(samplePoints(800_000, 300_000));
  });
});

describe('truncated chunk', () => {
  it('renders the points actually present when the header overstates the count', () => {
    const full = binaryPly([[1, 2, 3, 9, 9, 9], [4, 5, 6, 8, 8, 8], [7, 8, 9, 7, 7, 7]]);
    const cut = full.slice(0, full.byteLength - 17); // last point missing
    const cloud = parsePly(cut);
    expect(cloud.count).toBe(2);
    expect(Array.from(cloud.positions.slice(0, 6))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('mergeClouds', () => {
  it('drops non-finite and absurd outlier points', async () => {
    const { mergeClouds } = await import('./pointcloud');
    const cloud = { positions: new Float32Array([0, 0, 0, NaN, 1, 1, 1e9, 0, 0, 5, 5, 5]), colors: new Uint8Array(12).fill(7), count: 4 };
    const merged = mergeClouds([cloud as any]);
    expect(merged.count).toBe(2);
  });
});
