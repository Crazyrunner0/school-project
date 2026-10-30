import { findAngle, findVerticalAngle } from './geometry.js';

const SIDES = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 }
};
const MIN_CONFIDENCE = 0.5;
const MIN_BODY_ANGLE = 165;
const MAX_BODY_ANGLE = 185;
const SAG_LIMIT = 160;
const MAX_SHOULDER_DEVIATION = 20;
const MIN_HORIZONTAL_RATIO = 0.5;
const MIN_SHOULDER_SPAN_RATIO = 0.04;
const MIN_SUPPORT_SEPARATION_RATIO = 0.35;
const MAX_SUPPORT_DISTANCE_RATIO = 0.65;
const MAX_FOOT_DISTANCE_RATIO = 0.24;
const MAX_FLOOR_SLOPE = 0.35;
const MAX_FLOOR_EXTRAPOLATION_RATIO = 0.15;
const FLOOR_CLEARANCE_RATIO = 0.1;
const EPSILON = 1e-6;

// X и Z MediaPipe нормированы по ширине кадра, Y — по высоте.
// Отсутствие или некорректность Z не мешает 2D-проверкам, но останавливает таймер.
function framePoint(point, width, height) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  for (const value of [point.visibility, point.presence]) {
    if (value !== undefined && (!Number.isFinite(value) || value < MIN_CONFIDENCE)) return null;
  }
  const result = { x: point.x * width, y: point.y * height };
  if (Number.isFinite(point.z)) result.z = point.z * width;
  return result;
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function readPoints(landmarks, width, height) {
  const points = {};
  for (const [side, indices] of Object.entries(SIDES)) {
    points[side] = {};
    for (const [name, index] of Object.entries(indices)) {
      points[side][name] = framePoint(landmarks?.[index], width, height);
    }
  }
  return points;
}

// Пол приближённо задаётся видимой опорой нижней руки и точкой стопы.
// Это не доказывает контакт с полом: при сомнительной проекции таймер на паузе.
function estimateFloor(points, supportSide, shoulder, hip, ankle, bodyLength) {
  if (!supportSide) return null;
  const support = points[supportSide];
  const armPoints = [support.elbow, support.wrist].filter(Boolean);
  const footPoints = [];
  for (const side of ['left', 'right']) {
    const leg = points[side];
    for (const foot of [leg.ankle, leg.heel, leg.toe]) {
      if (foot && leg.ankle && distance(foot, leg.ankle) <= bodyLength * MAX_FOOT_DISTANCE_RATIO) {
        footPoints.push(foot);
      }
    }
  }

  const candidates = [];
  for (const arm of armPoints) {
    if (distance(arm, support.shoulder) > bodyLength * MAX_SUPPORT_DISTANCE_RATIO) continue;
    for (const foot of footPoints) {
      const dx = foot.x - arm.x;
      const dy = foot.y - arm.y;
      if (Math.abs(dx) < bodyLength * MIN_SUPPORT_SEPARATION_RATIO
          || Math.abs(dy / dx) > MAX_FLOOR_SLOPE) continue;
      const length = Math.hypot(dx, dy);
      // tangent направлен вправо по предполагаемому полу, normal — вниз.
      const sign = Math.sign(dx);
      const tangent = { x: sign * dx / length, y: sign * dy / length };
      const along = (point) => (point.x - arm.x) * tangent.x + (point.y - arm.y) * tangent.y;
      const clearance = (point) => -((point.y - arm.y) * tangent.x - (point.x - arm.x) * tangent.y);
      const end = along(foot);
      const margin = bodyLength * MAX_FLOOR_EXTRAPOLATION_RATIO;
      const withinFloor = (point) => along(point) >= Math.min(0, end) - margin
        && along(point) <= Math.max(0, end) + margin;
      if (![shoulder, hip, ankle].every(withinFloor)) continue;

      // Сильно оказавшееся ниже предполагаемого пола колено указывает на
      // ненадёжную линию опор; отсутствие колена не заменяет проверку оси.
      const knees = [points.left.knee, points.right.knee].filter(Boolean);
      if (knees.some((knee) => clearance(knee) < -bodyLength * 0.08)) continue;
      const shoulderHeight = clearance(support.shoulder);
      const hipHeight = clearance(hip);
      const limit = bodyLength * FLOOR_CLEARANCE_RATIO;
      let onFloor = null;
      if (shoulderHeight <= limit && hipHeight <= limit) onFloor = true;
      else if (shoulderHeight > limit && hipHeight > limit) onFloor = false;
      candidates.push({ tangent, onFloor, score: arm.y + foot.y });
    }
  }
  // Предпочитаем наиболее низкие видимые точки опоры.
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

// findAngle ограничен 0–180°. Знак относительно оси и направления к стопам
// отличает таз ниже линии (<180°) от поднятого выше неё (>180°).
function directedBodyAngle(shoulder, hip, ankle, tangent) {
  const angle = findAngle(shoulder, hip, ankle);
  if (angle === null) return null;
  const dx = ankle.x - shoulder.x;
  const dy = ankle.y - shoulder.y;
  const span = Math.hypot(dx, dy);
  const horizontal = dx * tangent.x + dy * tangent.y;
  if (span <= EPSILON || Math.abs(horizontal) < span * MIN_HORIZONTAL_RATIO) return null;
  const cross = dx * (hip.y - shoulder.y) - dy * (hip.x - shoulder.x);
  return cross * Math.sign(horizontal) < 0 ? 360 - angle : angle;
}

// Поворачиваем оси по приблизительной линии пола. При отсутствии Z получается
// лишь проекция на изображение, не подтверждающая отсутствие скручивания в глубину.
function shoulderDeviation(a, b, tangent, hasDepth) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const point = {
    x: dx * tangent.x + dy * tangent.y,
    y: -dx * tangent.y + dy * tangent.x
  };
  const origin = { x: 0, y: 0 };
  if (hasDepth) {
    point.z = a.z - b.z;
    origin.z = 0;
  }
  return findVerticalAngle(point, origin);
}

function measurePose(landmarks, width, height) {
  const points = readPoints(landmarks, width, height);
  if (!['left', 'right'].every((side) => points[side].shoulder && points[side].hip && points[side].ankle)) {
    return null;
  }
  const shoulder = midpoint(points.left.shoulder, points.right.shoulder);
  const hip = midpoint(points.left.hip, points.right.hip);
  const ankle = midpoint(points.left.ankle, points.right.ankle);
  const bodyLength = distance(shoulder, ankle);
  if (!Number.isFinite(bodyLength) || bodyLength <= EPSILON) return null;

  // В корректном фронтальном ракурсе опорное плечо — нижнее на изображении.
  // Если плечи почти совпали по высоте, определить опорную сторону нельзя.
  const shoulderDy = points.left.shoulder.y - points.right.shoulder.y;
  const supportSide = Math.abs(shoulderDy) > bodyLength * 0.01
    ? shoulderDy > 0 ? 'left' : 'right' : null;
  const floor = estimateFloor(points, supportSide, shoulder, hip, ankle, bodyLength);
  // Без опор используем горизонталь кадра только для предварительной подсказки;
  // безопасная форма в таком кадре не подтверждается.
  const tangent = floor?.tangent ?? { x: 1, y: 0 };
  const bodyAngle = directedBodyAngle(shoulder, hip, ankle, tangent);
  if (bodyAngle === null) return null;

  const leftShoulder = points.left.shoulder;
  const rightShoulder = points.right.shoulder;
  const hasDepth = leftShoulder.z !== undefined && rightShoulder.z !== undefined;
  const shoulderSpan = Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y,
    hasDepth ? leftShoulder.z - rightShoulder.z : 0);
  const reliableShoulders = shoulderSpan >= bodyLength * MIN_SHOULDER_SPAN_RATIO;
  const shoulderAngle = reliableShoulders
    ? shoulderDeviation(leftShoulder, rightShoulder, tangent, hasDepth) : null;
  return { bodyAngle, shoulderAngle, hasDepth, floor, supportSide };
}

export class SidePlankAnalyzer {
  constructor({ videoWidth = 1, videoHeight = 1, maxFrameGapSeconds = 1 } = {}) {
    if (!Number.isFinite(maxFrameGapSeconds) || maxFrameGapSeconds <= 0) {
      throw new TypeError('maxFrameGapSeconds должен быть положительным числом секунд.');
    }
    this.maxFrameGapSeconds = maxFrameGapSeconds;
    this.activeHoldTime = 0;
    this.frameWidth = 1;
    this.frameHeight = 1;
    this.resetTracking();
    this.setFrameSize(videoWidth, videoHeight);
  }

  // Передавайте реальные размеры видео: X/Z и Y нормированы по-разному.
  setFrameSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new TypeError('Размеры видеокадра должны быть положительными числами.');
    }
    if (Math.abs(this.frameWidth / this.frameHeight - width / height) > EPSILON) this.resetTracking();
    this.frameWidth = width;
    this.frameHeight = height;
  }

  // Вызывайте при паузе, перемотке или смене источника. Время сохраняется.
  resetTracking() {
    this.previousFormCorrect = false;
    this.previousSupportSide = null;
  }

  reset() {
    this.activeHoldTime = 0;
    this.resetTracking();
  }

  // deltaTime — секунды между текущим и предыдущим обработанными кадрами.
  update(landmarks, deltaTime = 0) {
    if (!Number.isFinite(deltaTime) || deltaTime < 0) {
      this.resetTracking();
      throw new RangeError('deltaTime должен быть неотрицательным числом секунд.');
    }
    const pose = measurePose(landmarks, this.frameWidth, this.frameHeight);
    if (!pose) {
      this.resetTracking();
      return {
        activeHoldTime: this.activeHoldTime,
        isFormCorrect: false,
        feedbackMessage: 'Покажите боковую планку целиком: оба плеча, таз и обе лодыжки.'
      };
    }

    const notes = [];
    if (pose.bodyAngle < SAG_LIMIT - EPSILON) {
      notes.push('Поднимите бедра выше, держите ровную линию!');
    } else if (pose.bodyAngle < MIN_BODY_ANGLE - EPSILON) {
      notes.push('Выровняйте тело и немного поднимите бедра.');
    } else if (pose.bodyAngle > MAX_BODY_ANGLE + EPSILON) {
      notes.push('Немного опустите бедра, держите ровную линию.');
    }

    if (pose.shoulderAngle !== null && pose.shoulderAngle > MAX_SHOULDER_DEVIATION + EPSILON) {
      notes.push('Держите плечи перпендикулярно полу, не скручивайте корпус.');
    }
    if (!pose.hasDepth) {
      notes.push('Нет данных глубины обоих плеч: скручивание в глубину не оценить.');
    } else if (pose.shoulderAngle === null) {
      notes.push('Покажите оба плеча раздельно для оценки корпуса.');
    }

    if (!pose.supportSide) {
      notes.push('Не удаётся определить опорное плечо: покажите оба плеча раздельно.');
    } else if (!pose.floor) {
      notes.push('Покажите локоть или запястье опорной руки и стопы: положение относительно пола не видно.');
    } else if (pose.floor.onFloor === true) {
      notes.push('Поднимитесь с пола и примите положение боковой планки.');
    } else if (pose.floor.onFloor === null) {
      notes.push('Не удаётся подтвердить, что плечо и таз подняты над полом.');
    }

    const isFormCorrect = notes.length === 0;
    // Засчитываются только интервалы между двумя подтверждёнными кадрами
    // одной опорной стороны; длинный пропуск и восстановление не включаются.
    if (isFormCorrect && this.previousFormCorrect && this.previousSupportSide === pose.supportSide
        && deltaTime <= this.maxFrameGapSeconds) {
      this.activeHoldTime += deltaTime;
    }
    this.previousFormCorrect = isFormCorrect;
    this.previousSupportSide = isFormCorrect ? pose.supportSide : null;
    return {
      activeHoldTime: this.activeHoldTime,
      isFormCorrect,
      feedbackMessage: isFormCorrect ? 'Держите тело ровно, плечи — друг над другом.' : notes.join(' ')
    };
  }
}
