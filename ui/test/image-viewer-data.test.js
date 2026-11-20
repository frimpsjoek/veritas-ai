// @ts-check
// Spec 029 R12: the full-screen viewer's zoom and pan math.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampView, fitScale, fitView, panBy, percent, wheelFactor, zoomAt, MAX_SCALE, MIN_SCALE, STEP } from '../src/image-viewer-data.js';

const stage = { width: 1000, height: 800 };
const big = { width: 2000, height: 1000 };
const small = { width: 400, height: 300 };

test('fitScale: the whole picture in 90% of the stage; a small one is scaled up to fill it', () => {
  assert.ok(Math.abs(fitScale(big, stage) - 0.45) < 1e-9);
  assert.ok(Math.abs(fitScale(small, stage) - 2.25) < 1e-9, 'limited by the width: 0.9 x 1000 / 400');
  assert.equal(fitScale({ width: 0, height: 0 }, stage), 1, 'a picture not loaded yet');
  assert.deepEqual({ ...fitView(big, stage), scale: Math.round(fitView(big, stage).scale * 1e6) / 1e6 }, { scale: 0.45, x: 0, y: 0 });
});

test('zoomAt keeps the point under the pointer still', () => {
  const v = { scale: 1, x: 0, y: 0 };
  const at = { x: 200, y: -100 };
  const z = zoomAt(v, 2, at, big, stage);
  assert.equal(z.scale, 2);
  // the picture point under `at` before: (at - x) / scale = (200, -100); after: (at - x') / 2 must be the same
  assert.deepEqual([(at.x - z.x) / z.scale, (at.y - z.y) / z.scale], [200, -100]);
  assert.deepEqual(zoomAt(v, 2, null, big, stage), { scale: 2, x: 0, y: 0 }, 'no point: at the centre');
});

test('the scale stays within MIN_SCALE and MAX_SCALE', () => {
  assert.equal(zoomAt({ scale: 1, x: 0, y: 0 }, 1000, null, big, stage).scale, MAX_SCALE);
  assert.equal(zoomAt({ scale: 1, x: 0, y: 0 }, 1 / 1000, null, big, stage).scale, MIN_SCALE);
});

test('clampView and panBy: a picture smaller than the stage stays centred; a bigger one stops at its edges', () => {
  assert.deepEqual(panBy({ scale: 1, x: 0, y: 0 }, 300, 300, small, stage), { scale: 1, x: 0, y: 0 });
  // 2000 x 1000 at scale 1 in 1000 x 800: 500 px spare each side across, 100 up and down
  assert.deepEqual(panBy({ scale: 1, x: 0, y: 0 }, 900, -900, big, stage), { scale: 1, x: 500, y: -100 });
  assert.deepEqual(clampView({ scale: 1, x: -10, y: 50 }, big, stage), { scale: 1, x: -10, y: 50 });
});

test('wheelFactor: one notch is one STEP, up zooms in, small trackpad deltas zoom a little, a huge delta is capped', () => {
  assert.ok(Math.abs(wheelFactor(-100, 0) - STEP) < 1e-9);
  assert.ok(Math.abs(wheelFactor(100, 0) - 1 / STEP) < 1e-9);
  assert.ok(Math.abs(wheelFactor(-3, 1) - Math.pow(STEP, 0.99)) < 1e-9, 'lines: 33 px each');
  assert.ok(wheelFactor(-4, 0) > 1 && wheelFactor(-4, 0) < 1.01);
  assert.equal(wheelFactor(-10_000, 0), Math.pow(STEP, 3));
  assert.equal(percent(1.254), '125%');
});
