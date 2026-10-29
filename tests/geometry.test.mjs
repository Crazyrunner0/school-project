import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Модуль браузерный; data: позволяет тестировать его без package.json и сборки.
const source = await readFile(new URL('../geometry.js', import.meta.url));
const { findAngle, findVerticalAngle } = await import(`data:text/javascript;base64,${source.toString('base64')}`);

function approximately(actual, expected, tolerance = 1e-9) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual - expected) < tolerance, `Ожидалось ${expected}°, получено ${actual}°`);
}

test('findAngle: прямой, развёрнутый, нулевой и острый углы в 2D', () => {
  const origin = { x: 0, y: 0 };
  approximately(findAngle({ x: 1, y: 0 }, origin, { x: 0, y: 1 }), 90);
  approximately(findAngle({ x: 1, y: 0 }, origin, { x: -1, y: 0 }), 180);
  approximately(findAngle({ x: 1, y: 0 }, origin, { x: 2, y: 0 }), 0);
  approximately(findAngle({ x: 1, y: 0 }, origin, { x: 1, y: 1 }), 45);
});

test('findAngle: учитывает глубину и отрицательные значения Z', () => {
  const origin = { x: 0, y: 0, z: 0 };
  approximately(findAngle({ x: 1, y: 0, z: 0 }, origin, { x: 0, y: 0, z: 1 }), 90);
  approximately(findAngle({ x: 1, y: 0, z: 1 }, origin, { x: 1, y: 0, z: -1 }), 90);
  approximately(findAngle({ x: 0, y: 0, z: -1 }, origin, { x: 0, y: 0, z: 1 }), 180);
});

test('findAngle: не вычисляет угол для нулевого вектора или некорректных точек', () => {
  const p = { x: 0, y: 0 };
  assert.equal(findAngle(p, p, { x: 1, y: 0 }), null);
  assert.equal(findAngle({ x: 1, y: 0 }, p, p), null);
  assert.equal(findAngle(null, p, p), null);
  assert.equal(findAngle({ x: NaN, y: 0 }, p, { x: 1, y: 0 }), null);
  assert.equal(findAngle({ x: 1, y: 0, z: Infinity }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }), null);
  assert.equal(findAngle({ x: 1, y: 0, z: 1 }, p, { x: 1, y: 1, z: 0 }), null);
});

test('findVerticalAngle: вертикаль, горизонталь и наклон не зависят от порядка точек', () => {
  const origin = { x: 0, y: 0 };
  approximately(findVerticalAngle(origin, { x: 0, y: 2 }), 0);
  approximately(findVerticalAngle(origin, { x: 0, y: -2 }), 0);
  approximately(findVerticalAngle(origin, { x: 2, y: 0 }), 90);
  approximately(findVerticalAngle(origin, { x: -1, y: 1 }), 45);
  approximately(findVerticalAngle({ x: -1, y: 1 }, origin), 45);
});

test('findVerticalAngle: учитывает глубину и отвергает вырожденные отрезки', () => {
  const origin = { x: 0, y: 0, z: 0 };
  approximately(findVerticalAngle(origin, { x: 0, y: 1, z: -1 }), 45);
  approximately(findVerticalAngle(origin, { x: 0, y: 0, z: 1 }), 90);
  assert.equal(findVerticalAngle(origin, origin), null);
  assert.equal(findVerticalAngle(origin, { x: 0, y: 1 }), null);
  assert.equal(findVerticalAngle(origin, { x: 0, y: 1, z: NaN }), null);
});

test('координаты кадра учитывают разные масштабы X и Y', () => {
  const width = 640;
  const height = 360;
  const hip = { x: 0.5 * width, y: 0.2 * height, z: 0 };
  const knee = { x: 0.5 * width, y: 0.5 * height, z: 0 };
  const ankle = { x: 0.65 * width, y: 0.65 * height, z: 0 };
  approximately(findAngle(hip, knee, ankle), 119.35775354279127);
});
