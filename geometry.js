const DEGREES_PER_RADIAN = 180 / Math.PI;

// Координаты всех осей должны быть выражены в одном масштабе.
// Поддерживаются точки { x, y } или { x, y, z }; смешивать 2D и 3D нельзя.
function haveValidCoordinates(...points) {
  if (points.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return false;
  }

  const hasDepth = points[0].z !== undefined;
  return points.every((point) => (point.z !== undefined) === hasDepth
    && (!hasDepth || Number.isFinite(point.z)));
}

/**
 * Угол p1–p2–p3 в градусах, где p2 — вершина; результат от 0 до 180.
 * Для совпадающих точек или некорректных координат возвращает null.
 */
export function findAngle(p1, p2, p3) {
  if (!haveValidCoordinates(p1, p2, p3)) return null;

  const hasDepth = p1.z !== undefined;
  let ax = p1.x - p2.x;
  let ay = p1.y - p2.y;
  let az = hasDepth ? p1.z - p2.z : 0;
  let bx = p3.x - p2.x;
  let by = p3.y - p2.y;
  let bz = hasDepth ? p3.z - p2.z : 0;

  const aLength = Math.hypot(ax, ay, az);
  const bLength = Math.hypot(bx, by, bz);
  if (!aLength || !bLength || !Number.isFinite(aLength) || !Number.isFinite(bLength)) return null;

  // Нормализация сохраняет устойчивость вычислений при разных единицах измерения.
  ax /= aLength;
  ay /= aLength;
  az /= aLength;
  bx /= bLength;
  by /= bLength;
  bz /= bLength;

  const dot = ax * bx + ay * by + az * bz;
  const crossLength = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
  return Math.atan2(crossLength, dot) * DEGREES_PER_RADIAN;
}

/**
 * Меньший угол между отрезком p1–p2 и вертикальной осью Y: от 0 до 90°.
 * Порядок точек не влияет на результат. Для вырожденного отрезка возвращает null.
 */
export function findVerticalAngle(p1, p2) {
  if (!haveValidCoordinates(p1, p2)) return null;

  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  const dz = p1.z !== undefined ? p1.z - p2.z : 0;
  const horizontalLength = Math.hypot(dx, dz);
  if (!Number.isFinite(horizontalLength) || !Number.isFinite(dy)) return null;
  if (horizontalLength === 0 && dy === 0) return null;

  return Math.atan2(horizontalLength, Math.abs(dy)) * DEGREES_PER_RADIAN;
}
