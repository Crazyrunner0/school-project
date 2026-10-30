import { findAngle } from './geometry.js';

// Линия плечо–таз–колено не измеряет изгиб позвоночника или контакт с полом.
// Фазы и предупреждения — приблизительная оценка боковой проекции, не диагноз.
export const GLUTE_PHASE = Object.freeze({
  WAITING: 'WAITING',
  BOTTOM: 'BOTTOM',
  LIFTING: 'LIFTING',
  PEAK: 'PEAK',
  TOP: 'TOP',
  LOWERING: 'LOWERING'
});

export const GLUTE_ERROR = Object.freeze({
  SHORT_LIFT: 'Недостаточный подъём таза',
  HIP_HIGH: 'Таз выше линии плечо–колено',
  KNEE_CLOSE: 'Слишком острый угол колена',
  KNEE_FAR: 'Слишком тупой угол колена'
});

const SIDES = {
  left: { shoulder: 11, hip: 23, knee: 25, ankle: 27 },
  right: { shoulder: 12, hip: 24, knee: 26, ankle: 28 }
};
const MIN_CONFIDENCE = 0.5;
const BOTTOM_MIN = 100;
const BOTTOM_MAX = 120;
const PEAK_MIN = 170;
const PEAK_MAX = 195;
const SHORT_LIMIT = 160;
const KNEE_MIN = 70;
const KNEE_MAX = 110;
const MIN_HORIZONTAL_RATIO = 0.35;
const MAX_PROFILE_SPAN_RATIO = 0.4;
const START_RISE_RATIO = 0.03;
const MIN_RISE_RATIO = 0.1;
const REVERSAL_RATIO = 0.04;
const SETTLE_RATIO = 0.01;
const MIN_ANGLE_TRAVEL = 10;
const PLATEAU_FRAMES = 6;
const PLATEAU_RANGE_RATIO = 0.025;
const EPSILON = 1e-6;
const LIMITATION = 'Контакт с полом и изгиб поясницы по этим точкам не определяются.';

// X и Y MediaPipe нормированы по разным размерам видео. Используем только
// 2D-проекцию сбоку, без смешивания с оценкой глубины Z.
function framePoint(point, width, height) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  for (const value of [point.visibility, point.presence]) {
    if (value !== undefined && (!Number.isFinite(value) || value < MIN_CONFIDENCE)) return null;
  }
  return {
    x: point.x * width,
    y: point.y * height,
    confidence: Math.min(point.visibility ?? 1, point.presence ?? 1)
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function measureSide(landmarks, side, width, height) {
  const get = (key) => framePoint(landmarks?.[SIDES[side][key]], width, height);
  const shoulder = get('shoulder');
  const hip = get('hip');
  const knee = get('knee');
  const ankle = get('ankle');
  if (!shoulder || !hip || !knee || !ankle) return null;
  const hipAngle = findAngle(shoulder, hip, knee);
  const kneeAngle = findAngle(hip, knee, ankle);
  const torsoLength = distance(shoulder, hip);
  const dx = knee.x - shoulder.x;
  const dy = knee.y - shoulder.y;
  const span = Math.hypot(dx, dy);
  if (hipAngle === null || kneeAngle === null || torsoLength <= EPSILON || span <= EPSILON
      || Math.abs(dx) < span * MIN_HORIZONTAL_RATIO) return null;
  const projection = ((hip.x - shoulder.x) * dx + (hip.y - shoulder.y) * dy) / (span * span);
  if (projection < -0.2 || projection > 1.2) return null;

  // Обычный угол ограничен 180°. Если таз выше линии плечо–колено,
  // направленный угол равен 360° минус обычный. Знак не зависит от зеркала.
  const cross = dx * (hip.y - shoulder.y) - dy * (hip.x - shoulder.x);
  const directedAngle = cross * Math.sign(dx) < 0 ? 360 - hipAngle : hipAngle;
  return {
    side, shoulder, hip, knee, ankle, hipAngle: directedAngle, kneeAngle,
    hipHeight: shoulder.y - hip.y, torsoLength,
    confidence: Math.min(shoulder.confidence, hip.confidence, knee.confidence, ankle.confidence)
  };
}

// При видимости противоположных плеча и таза отбраковываем явно не боковой
// ракурс. Если другая сторона скрыта, строгость профиля проверяется оператором.
function looksNonSide(landmarks, pose, width, height) {
  const spans = [];
  for (const key of ['shoulder', 'hip']) {
    const left = framePoint(landmarks?.[SIDES.left[key]], width, height);
    const right = framePoint(landmarks?.[SIDES.right[key]], width, height);
    if (left && right) spans.push(distance(left, right));
  }
  if (!spans.length) return false;
  return spans.reduce((sum, span) => sum + span, 0) / spans.length
    > pose.torsoLength * MAX_PROFILE_SPAN_RATIO + EPSILON;
}

function isBottom(angle) {
  return angle >= BOTTOM_MIN - EPSILON && angle <= BOTTOM_MAX + EPSILON;
}

function isPeak(angle) {
  return angle >= PEAK_MIN - EPSILON && angle <= PEAK_MAX + EPSILON;
}

function kneeErrors(angle) {
  if (angle < KNEE_MIN - EPSILON) return [GLUTE_ERROR.KNEE_CLOSE];
  if (angle > KNEE_MAX + EPSILON) return [GLUTE_ERROR.KNEE_FAR];
  return [];
}

function errorMessage(error) {
  if (error === GLUTE_ERROR.SHORT_LIFT) return 'Поднимите таз выше, сожмите ягодицы.';
  if (error === GLUTE_ERROR.HIP_HIGH) return 'Таз слишком высоко относительно линии плечо–колено; немного опустите его.';
  if (error === GLUTE_ERROR.KNEE_CLOSE) return 'Угол колена меньше 70°; проверьте, не слишком ли близко стопы.';
  if (error === GLUTE_ERROR.KNEE_FAR) return 'Угол колена больше 110°; проверьте, не слишком ли далеко стопы.';
  return '';
}

export class GluteBridgeAnalyzer {
  constructor({ side = 'auto', videoWidth = 1, videoHeight = 1 } = {}) {
    this.repCount = 0;
    this.side = 'auto';
    this.frameWidth = 1;
    this.frameHeight = 1;
    this.resetTracking();
    this.setSide(side);
    this.setFrameSize(videoWidth, videoHeight);
  }

  setSide(side) {
    if (!['auto', 'left', 'right'].includes(side)) throw new TypeError('Сторона должна быть auto, left или right.');
    if (side !== this.side) {
      this.side = side;
      this.resetTracking();
    }
  }

  setFrameSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new TypeError('Размеры видеокадра должны быть положительными числами.');
    }
    // Эталон хранится в пикселях, поэтому сбрасываем попытку даже при
    // изменении разрешения с тем же соотношением сторон.
    if (this.frameWidth !== width || this.frameHeight !== height) this.resetTracking();
    this.frameWidth = width;
    this.frameHeight = height;
  }

  // Отменяет незавершённый подъём, сохраняя уже засчитанные повторы.
  resetTracking() {
    this.currentPhase = GLUTE_PHASE.WAITING;
    this.activeSide = null;
    this.reference = null;
    this.motion = null;
    this.maxHeight = null;
    this.top = null;
    this.recentHeights = [];
    this.plateauHeight = null;
    this.localMaximum = null;
    this.localMinimum = null;
    this.apexConfirmed = false;
    this.reachedPeak = false;
    this.highSeen = false;
  }

  reset() {
    this.repCount = 0;
    this.resetTracking();
  }

  result(errors, notes) {
    return {
      repCount: this.repCount,
      currentPhase: this.currentPhase,
      currentErrors: [...new Set(errors)],
      feedbackMessage: [...notes, LIMITATION].filter(Boolean).join(' '),
      floorContact: 'unavailable',
      spineAssessment: 'unavailable'
    };
  }

  captureBottom(pose, fresh = false) {
    this.currentPhase = GLUTE_PHASE.BOTTOM;
    this.activeSide = pose.side;
    if (fresh || !this.reference || pose.hipHeight < this.reference.height) {
      this.reference = { height: pose.hipHeight, angle: pose.hipAngle, scale: pose.torsoLength };
    }
  }

  startLift() {
    this.currentPhase = GLUTE_PHASE.LIFTING;
    this.motion = 'up';
    this.maxHeight = null;
    this.top = null;
    this.recentHeights = [];
    this.plateauHeight = null;
    this.localMaximum = null;
    this.localMinimum = null;
    this.apexConfirmed = false;
    this.reachedPeak = false;
    this.highSeen = false;
  }

  // Угол колена и угол таза берём из одного кадра максимальной высоты таза,
  // а не из независимых экстремумов разных кадров.
  recordTop(pose) {
    if (this.maxHeight === null || pose.hipHeight >= this.maxHeight - EPSILON) {
      if (this.maxHeight === null || pose.hipHeight > this.maxHeight) this.maxHeight = pose.hipHeight;
      this.top = { hipAngle: pose.hipAngle, kneeAngle: pose.kneeAngle };
    }
  }

  finishLift(pose) {
    const rise = this.maxHeight - this.reference.height;
    const enoughMovement = rise >= this.reference.scale * MIN_RISE_RATIO - EPSILON
      && this.top.hipAngle - this.reference.angle >= MIN_ANGLE_TRAVEL - EPSILON;
    // Засчитываем достигнутую фазу PEAK, даже если затем таз поднялся выше
    // её диапазона: превышение 195° остаётся отдельным предупреждением.
    const counted = enoughMovement && this.apexConfirmed && this.reachedPeak;
    const errors = [];
    if (enoughMovement && this.apexConfirmed && this.top.hipAngle < SHORT_LIMIT - EPSILON) {
      errors.push(GLUTE_ERROR.SHORT_LIFT);
    }
    if (this.highSeen || this.top.hipAngle > PEAK_MAX + EPSILON) errors.push(GLUTE_ERROR.HIP_HIGH);
    if (enoughMovement && this.apexConfirmed) errors.push(...kneeErrors(this.top.kneeAngle));
    if (counted) this.repCount += 1;
    const topAngle = this.top.hipAngle;
    this.resetTracking();
    this.captureBottom(pose, true);
    return { counted, enoughMovement, topAngle, errors };
  }

  update(landmarks) {
    const candidates = ['left', 'right'].filter((side) => this.side === 'auto' || side === this.side)
      .map((side) => measureSide(landmarks, side, this.frameWidth, this.frameHeight)).filter(Boolean);
    let pose;
    if (this.currentPhase !== GLUTE_PHASE.WAITING && this.activeSide) {
      pose = candidates.find((candidate) => candidate.side === this.activeSide);
    } else {
      candidates.sort((a, b) => b.confidence - a.confidence);
      pose = candidates[0];
    }
    if (!pose) {
      this.resetTracking();
      return this.result([], ['Покажите сбоку плечо, таз, колено и лодыжку одной стороны.']);
    }
    if (looksNonSide(landmarks, pose, this.frameWidth, this.frameHeight)) {
      this.resetTracking();
      return this.result([], ['Поверните камеру строго сбоку и покажите тело целиком.']);
    }
    const atBottom = isBottom(pose.hipAngle);
    const frameErrors = pose.hipAngle > PEAK_MAX + EPSILON ? [GLUTE_ERROR.HIP_HIGH] : [];
    if (this.currentPhase === GLUTE_PHASE.WAITING) {
      if (atBottom) this.captureBottom(pose, true);
      const notes = frameErrors.map(errorMessage);
      if (!notes.length) notes.push(atBottom
        ? 'Нижняя фаза определена по углу. Поднимайте таз подконтрольно.'
        : 'Примите нижнее положение: ориентир угла плечо–таз–колено — 100–120°.');
      return this.result(frameErrors, notes);
    }

    if (this.currentPhase === GLUTE_PHASE.BOTTOM) {
      const rise = pose.hipHeight - this.reference.height;
      if (rise >= this.reference.scale * START_RISE_RATIO - EPSILON) {
        this.startLift();
      } else if (atBottom) {
        this.captureBottom(pose);
        return this.result(frameErrors, ['Поднимайте таз подконтрольно.']);
      } else {
        this.resetTracking();
        return this.result(frameErrors, ['Вернитесь в нижнее положение, чтобы начать подъём.']);
      }
    }

    const reference = this.reference;
    const reversal = reference.scale * REVERSAL_RATIO;
    this.recordTop(pose);
    if (pose.hipAngle > PEAK_MAX + EPSILON) this.highSeen = true;
    const rise = this.maxHeight - reference.height;
    const enoughRise = rise >= reference.scale * MIN_RISE_RATIO - EPSILON;
    const enoughMovement = enoughRise && this.top.hipAngle - reference.angle >= MIN_ANGLE_TRAVEL - EPSILON;
    this.recentHeights.push(pose.hipHeight);
    if (this.recentHeights.length > PLATEAU_FRAMES) this.recentHeights.shift();
    const plateau = this.recentHeights.length === PLATEAU_FRAMES
      && Math.max(...this.recentHeights) - Math.min(...this.recentHeights)
        <= reference.scale * PLATEAU_RANGE_RATIO + EPSILON;

    if (this.motion === 'up') {
      this.localMaximum = this.localMaximum === null ? pose.hipHeight : Math.max(this.localMaximum, pose.hipHeight);
      if (pose.hipHeight <= this.localMaximum - reversal + EPSILON) {
        this.motion = 'down';
        this.localMinimum = pose.hipHeight;
        this.apexConfirmed = true;
      } else if (enoughRise && plateau) {
        this.motion = 'top';
        this.plateauHeight = this.localMaximum;
        this.apexConfirmed = true;
      }
    } else if (this.motion === 'top') {
      if (pose.hipHeight <= this.plateauHeight - reversal + EPSILON) {
        this.motion = 'down';
        this.localMinimum = pose.hipHeight;
      } else if (pose.hipHeight >= this.plateauHeight + reversal - EPSILON) {
        this.motion = 'up';
        this.localMaximum = pose.hipHeight;
        this.apexConfirmed = false;
        this.recentHeights = [pose.hipHeight];
      }
    } else if (this.motion === 'down') {
      this.localMinimum = Math.min(this.localMinimum, pose.hipHeight);
      if (!atBottom && pose.hipHeight >= this.localMinimum + reversal - EPSILON) {
        this.motion = 'up';
        this.localMaximum = pose.hipHeight;
        this.apexConfirmed = false;
        this.recentHeights = [pose.hipHeight];
      }
    }

    this.currentPhase = isPeak(pose.hipAngle) && enoughRise ? GLUTE_PHASE.PEAK
      : this.motion === 'down' ? GLUTE_PHASE.LOWERING
        : this.motion === 'top' ? GLUTE_PHASE.TOP : GLUTE_PHASE.LIFTING;
    if (this.currentPhase === GLUTE_PHASE.PEAK) this.reachedPeak = true;
    if (this.apexConfirmed && enoughMovement) {
      if (this.top.hipAngle < SHORT_LIMIT - EPSILON) frameErrors.push(GLUTE_ERROR.SHORT_LIFT);
      frameErrors.push(...kneeErrors(this.top.kneeAngle));
    } else if (this.currentPhase === GLUTE_PHASE.PEAK) {
      frameErrors.push(...kneeErrors(pose.kneeAngle));
    }

    // Малое начальное шевеление может быть меньше порога разворота; после
    // возврата к старту отменяем его, иначе состояние LIFTING застрянет.
    if (atBottom && !enoughRise
        && pose.hipHeight <= reference.height + reference.scale * SETTLE_RATIO + EPSILON) {
      this.resetTracking();
      this.captureBottom(pose, true);
      return this.result(frameErrors, ['Движение слишком мало для подтверждения подъёма.']);
    }

    // Нижняя фаза определяется только углом: возвращаться точно к исходной
    // высоте таза не требуется. Разворот от вершины всё же обязателен.
    const returned = atBottom && this.maxHeight - pose.hipHeight >= reversal - EPSILON;
    if (returned) {
      const completed = this.finishLift(pose);
      const notes = [completed.counted ? 'Повтор засчитан.' : 'Повтор не засчитан.'];
      for (const error of completed.errors) notes.push(errorMessage(error));
      if (!completed.counted && completed.enoughMovement && completed.topAngle >= SHORT_LIMIT - EPSILON
          && completed.topAngle < PEAK_MIN - EPSILON) {
        notes.push('Верхняя фаза не достигнута: ориентир — 170–195°.');
      } else if (!completed.enoughMovement) {
        notes.push('Движение слишком мало для подтверждения подъёма.');
      }
      return this.result(completed.errors, notes);
    }

    const notes = [...new Set(frameErrors)].map(errorMessage);
    if (!notes.length && this.apexConfirmed && enoughMovement && !this.reachedPeak
        && this.top.hipAngle >= SHORT_LIMIT - EPSILON && this.top.hipAngle <= PEAK_MAX + EPSILON) {
      notes.push('Верхняя фаза не достигнута: ориентир — 170–195°.');
    }
    if (!notes.length) {
      const labels = {
        LIFTING: 'Поднимайте таз подконтрольно.',
        PEAK: 'Верхняя фаза достигнута. Плавно опустите таз.',
        TOP: 'Верхняя точка определена. Плавно опустите таз.',
        LOWERING: 'Плавно вернитесь в нижнюю фазу.'
      };
      notes.push(labels[this.currentPhase]);
    }
    return this.result(frameErrors, notes);
  }
}
