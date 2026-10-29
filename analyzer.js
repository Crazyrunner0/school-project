import { findAngle, findVerticalAngle } from './geometry.js';

// Эвристическая оценка по изображению; она не заменяет консультацию специалиста.

export const SQUAT_PHASE = Object.freeze({
  WAITING: 'WAITING',
  STANDING: 'STANDING',
  DESCENDING: 'DESCENDING',
  BOTTOM: 'BOTTOM',
  ASCENDING: 'ASCENDING'
});

export const SQUAT_ERROR = Object.freeze({
  SHALLOW: 'Недостаточная глубина приседания',
  BACK_LEAN: 'Чрезмерный наклон корпуса',
  KNEES_INWARD: 'Колени смещаются внутрь',
  KNEE_PAST_TOE: 'Колено выходит за носок'
});

const SIDES = [
  { shoulder: 11, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 },
  { shoulder: 12, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 }
];
const VISIBILITY = 0.5;
const STANDING_ANGLE = 160;
const DESCENDING_ANGLE = 140;
const DEPTH_ANGLE = 100;
const TARGET_DEPTH = 90;
const MAX_BACK_LEAN = 45;
const REVERSAL = 3;
const PLATEAU_FRAMES = 6;
const PLATEAU_RANGE = 1.5;
const MAX_MISSING_FRAMES = 10;
const EPSILON = 1e-6;

function isReliable(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y)
    && (point.z === undefined || Number.isFinite(point.z))
    && (point.visibility === undefined || (Number.isFinite(point.visibility) && point.visibility >= VISIBILITY))
    && (point.presence === undefined || (Number.isFinite(point.presence) && point.presence >= VISIBILITY));
}

function framePoint(point, width, height) {
  if (!isReliable(point)) return null;
  // X и Z масштабируются по ширине кадра, Y — по высоте, как в app.js.
  const result = { x: point.x * width, y: point.y * height };
  if (point.z !== undefined) result.z = point.z * width;
  return result;
}

function measureSide(landmarks, indices, width, height) {
  const shoulder = framePoint(landmarks?.[indices.shoulder], width, height);
  const hip = framePoint(landmarks?.[indices.hip], width, height);
  const knee = framePoint(landmarks?.[indices.knee], width, height);
  const ankle = framePoint(landmarks?.[indices.ankle], width, height);
  return {
    shoulder,
    hip,
    knee,
    ankle,
    heel: framePoint(landmarks?.[indices.heel], width, height),
    toe: framePoint(landmarks?.[indices.toe], width, height),
    kneeAngle: findAngle(hip, knee, ankle),
    backAngle: findVerticalAngle(shoulder, hip)
  };
}

// Ракурс приблизительно оценивается по ширине плеч/таза относительно длины корпуса.
// Промежуточный или плохо видимый ракурс не используется для проверки коленей.
function inferView([left, right]) {
  if (!left.shoulder || !right.shoulder || !left.hip || !right.hip) return 'unknown';
  const shoulderSpan = Math.abs(left.shoulder.x - right.shoulder.x);
  const hipSpan = Math.abs(left.hip.x - right.hip.x);
  const leftTorso = Math.hypot(left.shoulder.x - left.hip.x, left.shoulder.y - left.hip.y);
  const rightTorso = Math.hypot(right.shoulder.x - right.hip.x, right.shoulder.y - right.hip.y);
  const torsoLength = (leftTorso + rightTorso) / 2;
  if (torsoLength <= EPSILON) return 'unknown';

  const ratio = (shoulderSpan + hipSpan) / (2 * torsoLength);
  if (ratio >= 0.7) return 'front';
  if (ratio <= 0.35) return 'side';
  return 'unknown';
}

// Фронтальный вид: сравниваем X коленей с X лодыжек по направлению к центру стойки.
// Знак вычисляется по самой стойке, поэтому порядок сторон и зеркалирование X не меняют результат.
function kneesInwardSides([left, right]) {
  if (!left.ankle || !right.ankle || (!left.knee && !right.knee)) return null;
  const span = right.ankle.x - left.ankle.x;
  const stanceWidth = Math.abs(span);
  const shinLengths = [left, right]
    .filter((side) => side.knee && side.ankle)
    .map((side) => Math.hypot(side.knee.x - side.ankle.x, side.knee.y - side.ankle.y));
  const meanShin = shinLengths.reduce((sum, length) => sum + length, 0) / shinLengths.length;
  if (stanceWidth <= Math.max(EPSILON, meanShin * 0.08)) return null;

  const direction = Math.sign(span);
  const tolerance = stanceWidth * 0.1;
  return [
    Boolean(left.knee && (left.knee.x - left.ankle.x) * direction > tolerance),
    Boolean(right.knee && (right.ankle.x - right.knee.x) * direction > tolerance)
  ];
}

// Боковой вид: направление «вперёд» определяем по пятке и носку, а не по знаку X.
function kneePastToeSides(sides) {
  let checked = false;
  const flags = sides.map((side) => {
    if (!side.knee || !side.heel || !side.toe) return false;
    const footX = side.toe.x - side.heel.x;
    const footLength = Math.hypot(footX, side.toe.y - side.heel.y);
    // Почти вертикальная проекция стопы не позволяет надёжно определить её направление.
    if (footLength <= EPSILON || Math.abs(footX) < footLength * 0.35) return false;
    checked = true;
    return (side.knee.x - side.toe.x) * Math.sign(footX) > footLength * 0.05;
  });
  return checked ? flags : null;
}

// Для HUD сохраняем те же измерения и пороги, по которым получены currentErrors.
// Глубина относится к повтору целиком, поэтому выделяются обе доступные ноги.
function getHighlightedSegments(sides, errors, kneeFlags) {
  const segments = [];
  sides.forEach((side, index) => {
    const points = SIDES[index];
    if (kneeFlags?.[index]) {
      segments.push({ start: points.knee, end: points.ankle, level: 'warning' });
    }
    if (errors.includes(SQUAT_ERROR.SHALLOW) && side.kneeAngle !== null) {
      segments.push({ start: points.hip, end: points.knee, level: 'danger' });
      segments.push({ start: points.knee, end: points.ankle, level: 'danger' });
    }
    if (errors.includes(SQUAT_ERROR.BACK_LEAN)
      && side.backAngle !== null && side.backAngle > MAX_BACK_LEAN + EPSILON) {
      segments.push({ start: points.shoulder, end: points.hip, level: 'danger' });
    }
  });
  return segments;
}

export class SquatAnalyzer {
  constructor({ view = 'auto', videoWidth = 1, videoHeight = 1 } = {}) {
    this.repCount = 0;
    this.frameWidth = 1;
    this.frameHeight = 1;
    this.setView(view);
    this.resetTracking();
    this.setFrameSize(videoWidth, videoHeight);
  }

  setView(view) {
    if (!['auto', 'front', 'side'].includes(view)) {
      throw new TypeError('Ракурс должен быть auto, front или side.');
    }
    this.view = view;
  }

  setFrameSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new TypeError('Размеры видеокадра должны быть положительными числами.');
    }
    const previousRatio = this.frameWidth / this.frameHeight;
    if (Math.abs(previousRatio - width / height) > EPSILON) this.resetTracking();
    this.frameWidth = width;
    this.frameHeight = height;
  }

  // Используется при остановке/смене камеры: незавершённый повтор отменяется,
  // но уже засчитанные повторения сохраняются.
  resetTracking() {
    this.currentPhase = SQUAT_PHASE.WAITING;
    this.minimumKneeAngle = null;
    this.localMinimum = null;
    this.localMaximum = null;
    this.justFinishedShallow = false;
    this.recentAngles = [];
    this.reachedBottom = false;
    this.missingFrames = 0;
    this.completedMessage = '';
    this.highlightedSegments = [];
  }

  // Сегменты текущего кадра для визуализации, без изменения формата update().
  getHighlightedSegments() {
    return this.highlightedSegments;
  }

  reset() {
    this.repCount = 0;
    this.resetTracking();
  }

  startDescent(angle, newRep) {
    this.currentPhase = SQUAT_PHASE.DESCENDING;
    this.localMinimum = angle;
    this.localMaximum = null;
    this.minimumKneeAngle = newRep ? angle : Math.min(this.minimumKneeAngle, angle);
    this.recentAngles = [angle];
    this.reachedBottom = false;
    this.completedMessage = '';
  }

  finishRep() {
    this.repCount += 1;
    this.currentPhase = SQUAT_PHASE.STANDING;
    this.justFinishedShallow = this.minimumKneeAngle > DEPTH_ANGLE + EPSILON;
    this.completedMessage = this.justFinishedShallow
      ? 'Повтор засчитан. Глубина недостаточна: ориентир — около 90° в колене.'
      : 'Повтор засчитан. Можно начинать следующий.';
    this.minimumKneeAngle = null;
    this.localMinimum = null;
    this.localMaximum = null;
    this.recentAngles = [];
    this.reachedBottom = false;
  }

  advancePhase(angle) {
    this.justFinishedShallow = false;
    switch (this.currentPhase) {
      case SQUAT_PHASE.WAITING:
        // Сначала нужна исходная стойка: иначе подъём из кадра не станет ложным повтором.
        if (angle > STANDING_ANGLE + EPSILON) this.currentPhase = SQUAT_PHASE.STANDING;
        break;

      case SQUAT_PHASE.STANDING:
        if (angle < DESCENDING_ANGLE - EPSILON) this.startDescent(angle, true);
        break;

      case SQUAT_PHASE.DESCENDING: {
        this.localMinimum = Math.min(this.localMinimum, angle);
        this.minimumKneeAngle = Math.min(this.minimumKneeAngle, angle);
        this.recentAngles.push(angle);
        if (this.recentAngles.length > PLATEAU_FRAMES) this.recentAngles.shift();
        const plateau = this.recentAngles.length === PLATEAU_FRAMES
          && Math.max(...this.recentAngles) - Math.min(...this.recentAngles) <= PLATEAU_RANGE;
        // Минимум подтверждается разворотом движения или короткой паузой внизу.
        if (angle >= this.localMinimum + REVERSAL || plateau) {
          this.currentPhase = SQUAT_PHASE.BOTTOM;
          this.reachedBottom = true;
          // При пропущенных кадрах подъём мог сразу закончиться в стойке.
          if (angle > STANDING_ANGLE + EPSILON) this.finishRep();
        }
        break;
      }

      case SQUAT_PHASE.BOTTOM:
        if (angle < this.localMinimum - REVERSAL) {
          // После краткой паузы человек продолжил опускаться.
          this.startDescent(angle, false);
        } else {
          // Сохраняем минимум, на котором была подтверждена нижняя точка:
          // постепенное движение вниз тоже должно накопить порог разворота.
          this.minimumKneeAngle = Math.min(this.minimumKneeAngle, angle);
          if (angle > STANDING_ANGLE + EPSILON) {
            this.finishRep();
          } else if (angle >= this.localMinimum + REVERSAL) {
            this.currentPhase = SQUAT_PHASE.ASCENDING;
            this.localMaximum = angle;
          }
        }
        break;

      case SQUAT_PHASE.ASCENDING:
        if (angle > STANDING_ANGLE + EPSILON) {
          this.finishRep();
        } else {
          this.localMaximum = Math.max(this.localMaximum, angle);
          if (angle < DESCENDING_ANGLE && angle <= this.localMaximum - REVERSAL) {
            // Повтор не окончен: сравниваем с максимумом подъёма, а не с одним кадром.
            this.startDescent(angle, false);
          }
        }
        break;
    }
  }

  update(landmarks) {
    const sides = SIDES.map((side) => measureSide(landmarks, side, this.frameWidth, this.frameHeight));
    const kneeAngles = sides.map((side) => side.kneeAngle).filter((angle) => angle !== null);
    if (!kneeAngles.length) {
      this.highlightedSegments = [];
      this.missingFrames += 1;
      // Краткую потерю точки пережидаем, а длительную прерываем без ложного повтора.
      if (this.missingFrames >= MAX_MISSING_FRAMES) this.resetTracking();
      return {
        repCount: this.repCount,
        currentPhase: this.currentPhase,
        currentErrors: [],
        feedbackMessage: 'Покажите камере таз, колени и лодыжки.'
      };
    }

    this.missingFrames = 0;
    const kneeAngle = kneeAngles.reduce((sum, angle) => sum + angle, 0) / kneeAngles.length;
    this.advancePhase(kneeAngle);
    const view = this.view === 'auto' ? inferView(sides) : this.view;
    const errors = [];

    if (this.justFinishedShallow || (this.reachedBottom && this.minimumKneeAngle > DEPTH_ANGLE + EPSILON
      && (this.currentPhase === SQUAT_PHASE.BOTTOM || this.currentPhase === SQUAT_PHASE.ASCENDING))) {
      errors.push(SQUAT_ERROR.SHALLOW);
    }
    if (sides.some((side) => side.backAngle !== null && side.backAngle > MAX_BACK_LEAN + EPSILON)) {
      errors.push(SQUAT_ERROR.BACK_LEAN);
    }

    let kneeFlags = null;
    if (kneeAngle < 150 && this.currentPhase !== SQUAT_PHASE.WAITING) {
      if (view === 'front') {
        kneeFlags = kneesInwardSides(sides);
        if (kneeFlags?.some(Boolean)) errors.push(SQUAT_ERROR.KNEES_INWARD);
      } else if (view === 'side') {
        kneeFlags = kneePastToeSides(sides);
        if (kneeFlags?.some(Boolean)) errors.push(SQUAT_ERROR.KNEE_PAST_TOE);
      }
    }
    this.highlightedSegments = getHighlightedSegments(sides, errors, kneeFlags);

    let feedbackMessage;
    if (errors.includes(SQUAT_ERROR.BACK_LEAN)) {
      feedbackMessage = 'Проверьте наклон корпуса: ориентир — не более 45° к вертикали кадра.';
    } else if (errors.includes(SQUAT_ERROR.KNEES_INWARD)) {
      feedbackMessage = 'Не сводите колени внутрь: направляйте их к стопам.';
    } else if (errors.includes(SQUAT_ERROR.KNEE_PAST_TOE)) {
      feedbackMessage = 'Колено оказалось впереди носка: проверьте положение и ракурс.';
    } else if (errors.includes(SQUAT_ERROR.SHALLOW)) {
      feedbackMessage = this.justFinishedShallow
        ? this.completedMessage
        : 'Глубина недостаточна: ориентир — около 90° в колене.';
    } else if (this.currentPhase === SQUAT_PHASE.WAITING) {
      feedbackMessage = 'Встаньте прямо, чтобы начать отсчёт.';
    } else if (kneeAngle < 150 && view === 'unknown') {
      feedbackMessage = 'Ракурс не определён: выберите вид спереди или сбоку.';
    } else if (kneeAngle < 150 && kneeFlags === null) {
      feedbackMessage = view === 'front'
        ? 'Для проверки коленей покажите камере колени и лодыжки.'
        : 'Для проверки коленей покажите камере стопы и пятки.';
    } else if (this.currentPhase === SQUAT_PHASE.STANDING) {
      feedbackMessage = this.completedMessage || 'Встаньте прямо и начните приседание.';
    } else if (this.currentPhase === SQUAT_PHASE.DESCENDING) {
      feedbackMessage = 'Опускайтесь подконтрольно.';
    } else if (this.currentPhase === SQUAT_PHASE.BOTTOM) {
      feedbackMessage = this.minimumKneeAngle <= TARGET_DEPTH + EPSILON
        ? 'Достигнута целевая глубина. Поднимайтесь.'
        : 'Глубина близка к цели. Поднимайтесь.';
    } else {
      feedbackMessage = 'Выпрямляйтесь до исходного положения.';
    }

    return { repCount: this.repCount, currentPhase: this.currentPhase, currentErrors: errors, feedbackMessage };
  }
}
