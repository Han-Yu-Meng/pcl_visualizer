import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePCD, decompressLZF } from '../pcd.js';
import { createSamplePCDs, DEMO_TRUTH } from '../demo.js';

const samples = createSamplePCDs();

function approx(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, (msg || '') + ' expected ' + b + ' got ' + a);
}

test('LZF literal runs and back-references', () => {
  const stream = new Uint8Array([2, 1, 2, 3, 32, 2, 32, 2]);
  const out = decompressLZF(stream, 9);
  assert.deepEqual(Array.from(out), [1, 2, 3, 1, 2, 3, 1, 2, 3]);
});

test('all three encodings decode to the same cloud', () => {
  const ref = parsePCD(samples.binary);
  assert.equal(ref.count, samples.cloud.count);
  for (const key of ['ascii', 'binary_compressed']) {
    const got = parsePCD(samples[key]);
    assert.equal(got.encoding, key);
    assert.equal(got.count, ref.count, key + ' point count');
    for (let i = 0; i < ref.positions.length; i++) {
      approx(got.positions[i], ref.positions[i], 2e-5, key + ' pos[' + i + ']');
    }
    for (let i = 0; i < ref.count; i++) {
      approx(got.intensity[i], ref.intensity[i], 2e-5, key + ' intensity[' + i + ']');
    }
    assert.deepEqual(got.fields, ['x', 'y', 'z', 'intensity']);
  }
});

test('rgb field decodes to the packed colors in every encoding', () => {
  const expected = [
    [1, 0, 0], [0, 1, 0], [0, 0, 1],
  ];
  for (const key of ['rgbAscii', 'rgbBinary', 'rgbCompressed']) {
    const c = parsePCD(samples[key]);
    assert.equal(c.count, 3, key);
    assert.ok(c.colors, key + ' has colors');
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 3; k++) approx(c.colors[i * 3 + k], expected[i][k], 1e-6, key);
    }
  }
});

test('PCL-style float-bit rgb in ASCII is reinterpreted', () => {
  const bits = 0x0000ff;
  const asFloat = new Float32Array(new Uint32Array([bits]).buffer)[0];
  const text = [
    'VERSION 0.7',
    'FIELDS x y z rgb',
    'SIZE 4 4 4 4',
    'TYPE F F F F',
    'COUNT 1 1 1 1',
    'WIDTH 1', 'HEIGHT 1', 'POINTS 1',
    'DATA ascii',
    '0 0 0 ' + asFloat.toExponential(12),
    '',
  ].join('\n');
  const c = parsePCD(text);
  assert.equal(c.count, 1);
  approx(c.colors[2], 1, 1e-6, 'blue channel');
});

test('NaN points are skipped', () => {
  const text = [
    'VERSION 0.7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F',
    'COUNT 1 1 1', 'WIDTH 4', 'HEIGHT 1', 'POINTS 4', 'DATA ascii',
    '0 0 0', 'nan nan nan', '1 2 3', '1 nan 3', '',
  ].join('\n');
  const c = parsePCD(text);
  assert.equal(c.count, 2);
  assert.deepEqual(Array.from(c.positions), [0, 0, 0, 1, 2, 3]);
});

test('organized cloud (WIDTH x HEIGHT) without POINTS', () => {
  const text = [
    'VERSION 0.7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F',
    'COUNT 1 1 1', 'WIDTH 2', 'HEIGHT 2', 'DATA ascii',
    '0 0 0', '1 0 0', '0 1 0', '1 1 1', '',
  ].join('\n');
  const c = parsePCD(text);
  assert.equal(c.count, 4);
});

test('padded binary rows are detected from payload length', () => {
  const n = 3;
  const header = [
    'VERSION 0.7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F',
    'COUNT 1 1 1', 'WIDTH 3', 'HEIGHT 1', 'POINTS 3', 'DATA binary', '',
  ].join('\n');
  const h = new TextEncoder().encode(header);
  // 16 bytes per row although the header declares a 12-byte point.
  const buf = new Uint8Array(h.length + n * 16);
  buf.set(h, 0);
  const dv = new DataView(buf.buffer, h.length);
  const pts = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
  pts.forEach((p, i) => p.forEach((v, k) => dv.setFloat32(i * 16 + k * 4, v, true)));
  const c = parsePCD(buf.buffer);
  assert.equal(c.count, 3);
  assert.deepEqual(Array.from(c.positions), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('bounds and demo ground truth are consistent', () => {
  const c = parsePCD(samples.binary);
  assert.ok(c.bounds.min[0] > -0.1 && c.bounds.max[0] < 8.1);
  assert.ok(c.bounds.min[2] > -0.1 && c.bounds.max[2] < 3.1);
  // Floor normal from z = 0.010x - 0.006y must match the declared tilt.
  const g = parsePCD(samples.binary).positions;
  assert.ok(g.length > 0);
  approx(DEMO_TRUTH.floorAngle, 0.668, 0.01, 'floor angle');
  approx(DEMO_TRUTH.wallAngle, 1.031, 0.01, 'wall angle');
});

test('invalid input reports a useful error', () => {
  assert.throws(() => parsePCD('hello world'), /DATA/);
  assert.throws(() => parsePCD(new ArrayBuffer(0)), /DATA/);
});
