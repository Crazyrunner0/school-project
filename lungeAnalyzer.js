import { findAngle } from './geometry.js';

export const LUNGE_PHASE = Object.freeze({
  WAITING: 'WAITING',
  STANDING: 'STANDING',
  LUNGING: 'LUNGING',
  BOTTOM: 'BOTTOM',
  ASCENDING: 'ASCENDING'
});

export const LUNGE_ERROR = Object.freeze({
  KNEE_PAST_TOE: 'Переднее колено слишком далеко за носком',
  SHALLOW: 'Недостаточная глубина выпада',
  BACK_LEAN: 'Чрезмерный наклон корпуса вперёд'
});

const SIDES = {
  left: { shoulder: 11, hip: 23, knee: 25, ankle: 27, toe: 31 },
  right: { shoulder: 12, hip: 24, knee: 26, ankle: 28, toe: 32 }
};
const CONFIDENCE = 0.5;
const STANDING_ANGLE = 160;
const FRONT_BENDING_ANGLE = 155;
const MIN_LUNGE_ANGLE = 150;
const MIN_TRAVEL = 10;
const SHALLOW_ANGLE = 105;
const TARGET_FRONT_MIN = 85;
const TARGET_FRONT_MAX = 95;
const TARGET_REAR_MIN = 80;
const TARGET_REAR_MAX = 100;
const TARGET_TORSO_LEAN = 15;
const MAX_FORWARD_LEAN = 20;
const MIN_STANCE_RATIO = 0.15;
const KNEE_TOE_TOLERANCE = 0.05;
const REVERSAL = 3;
const PLATEAU_FRAMES = 6;
const PLATEAU_RANGE = 1.5;
const MAX_MISSING_FRAMES = 10;
const EPSILON = 1e-6;
const DEGREES = 180 / Math.PI;

// X и Z нормированы MediaPipe по ширине кадра, Y — по высоте.
function framePoint(point, width, height) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1
      || (point.z !== undefined && !Number.isFinite(point.z))) return null;
  for (const value of [point.visibility, point.presence]) {
    if (value !== undefined && (!Number.isFinite(value) || value < CONFIDENCE)) return null;
  }
  const result = {
    x: point.x * width,
    y: point.y * height,
    confidence: Math.min(point.visibility ?? 1, point.presence ?? 1)
  };
  if (point.z !== undefined) result.z = point.z * width;
  return result;
}

function angleBetween(a, b, c) {
  if (!a || !b || !c) return null;
  if ([a, b, c].every((point) => point.z !== undefined)) return findAngle(a, b, c);
  const flat = (point) => ({ x: point.x, y: point.y });
  return findAngle(flat(a), flat(b), flat(c));
}

function measureLeg(landmarks, name, width, height) {
  const indices = SIDES[name];
  const get = (key) => framePoint(landmarks?.[indices[key]], width, height);
  const hip = get('hip');
  const knee = get('knee');
  const ankle = get('ankle');
  const angle = angleBetween(hip, knee, ankle);
  if (angle === null) return null;
  const length = Math.hypot(hip.x - knee.x, hip.y - knee.y)
    + Math.hypot(knee.x - ankle.x, knee.y - ankle.y);
  if (length <= EPSILON) return null;
  return { name, hip, knee, ankle, toe: get('toe'), shoulder: get('shoulder'), angle, length };
}

// При автоматическом выборе направление берётся по проекции стопы на кадр.
// Противоречивые или слишком короткие проекции считаются неопределёнными.
function inferFacing(legs) {
  const directions = [];
  for (const leg of Object.values(legs)) {
    if (!leg.toe) continue;
    const dx = leg.toe.x - leg.ankle.x;
    const footLength = Math.hypot(dx, leg.toe.y - leg.ankle.y);
    if (footLength <= EPSILON || Math.abs(dx) < footLength * 0.35
        || Math.abs(dx) < leg.length * 0.025) continue;
    directions.push(Math.sign(dx));
  }
  return directions.length && directions.every((value) => value === directions[0])
    ? directions[0] : null;
}

// Передняя стопа расположена дальше по направлению, куда обращены стопы.
// Слишком близкие лодыжки не позволяют надёжно определить ведущую ногу.
function inferFrontLeg(legs, direction) {
  if (direction === null) return null;
  const separation = (legs.left.ankle.x - legs.right.ankle.x) * direction;
  const averageLegLength = (legs.left.length + legs.right.length) / 2;
  const tolerance = averageLegLength * MIN_STANCE_RATIO;
  if (Math.abs(separation) <= tolerance + EPSILON) return null;
  return separation > 0 ? 'left' : 'right';
}

// Линия между носками — лишь приблизительная проекция пола. Она не доказывает
// контакт стоп с полом и не позволяет обнаружить удар коленом.
function rearKneeHeight(front, rear) {
  if (!front.toe || !rear.toe) return null;
  const dx = front.toe.x - rear.toe.x;
  if (Math.abs(dx) <= ((front.length + rear.length) / 2) * MIN_STANCE_RATIO + EPSILON) return null;
  const slope = (front.toe.y - rear.toe.y) / dx;
  const position = (rear.knee.x - rear.toe.x) / dx;
  if (Math.abs(slope) > 0.35 || position < -0.2 || position > 1.2) return null;
  const floorY = rear.toe.y + slope * (rear.knee.x - rear.toe.x);
  const height = (floorY - rear.knee.y) / rear.length;
  return height >= -0.15 ? height : null;
}

function torsoLean(legs, preferredSide) {
  const order = preferredSide ? [preferredSide, preferredSide === 'left' ? 'right' : 'left'] : ['left', 'right'];
  const candidates = order.map((side) => legs[side]).filter((leg) => leg.shoulder && leg.hip.y > leg.shoulder.y);
  if (!candidates.length) return null;
  // Предпочитаем плечо выбранной ноги, но не смешиваем его с тазом другой.
  const leg = candidates[0];
  return Math.atan2(leg.shoulder.x - leg.hip.x, leg.hip.y - leg.shoulder.y) * DEGREES;
}

function errorMessage(error) {
  if (error === LUNGE_ERROR.KNEE_PAST_TOE) return 'Не уводите колено слишком далеко вперёд.';
  if (error === LUNGE_ERROR.SHALLOW) return 'Опускайтесь ниже.';
  if (error === LUNGE_ERROR.BACK_LEAN) return 'Держите спину ровно.';
  return '';
}

export class LungeAnalyzer {
  constructor({ facingDirection = 'auto', videoWidth = 1, videoHeight = 1 } = {}) {
    this.repCount = 0;
    this.frameWidth = 1;
    this.frameHeight = 1;
    this.facingDirection = 'auto';
    this.resetTracking();
    this.setFacingDirection(facingDirection);
    this.setFrameSize(videoWidth, videoHeight);
  }

  // left/right задают направление в исходном кадре MediaPipe, не в зеркальном preview.
  setFacingDirection(direction) {
    if (!['auto', 'left', 'right'].includes(direction)) {
      throw new TypeError('Направление должно быть auto, left или right.');
    }
    if (this.facingDirection !== direction) {
      this.facingDirection = direction;
      this.resetTracking();
    }
  }

  setFrameSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new TypeError('Размеры видеокадра должны быть положительными числами.');
    }
    if (Math.abs(this.frameWidth / this.frameHeight - width / height) > EPSILON) this.resetTracking();
    this.frameWidth = width;
    this.frameHeight = height;
  }

  // Отменяет незавершённое движение, но сохраняет счётчик повторений.
  resetTracking() {
    this.currentPhase = LUNGE_PHASE.WAITING;
    this.activeSide = null;
    this.attemptDirection = null;
    this.standingAngles = null;
    this.startAngle = null;
    this.minimumAngle = null;
    this.bottomRearAngle = null;
    this.bottomRearHeight = null;
    this.localMinimum = null;
    this.returnMaximum = null;
    this.recentAngles = [];
    this.bottomConfirmed = false;
    this.repErrors = new Set();
    this.completedMessage = '';
    this.missingFrames = 0;
  }

  reset() {
    this.repCount = 0;
    this.resetTracking();
  }

  enterStanding(legs) {
    this.currentPhase = LUNGE_PHASE.STANDING;
    this.standingAngles = { left: legs.left.angle, right: legs.right.angle };
    this.activeSide = null;
    this.attemptDirection = null;
    this.startAngle = null;
    this.minimumAngle = null;
    this.bottomRearAngle = null;
    this.bottomRearHeight = null;
    this.localMinimum = null;
    this.returnMaximum = null;
    this.recentAngles = [];
    this.bottomConfirmed = false;
    this.repErrors = new Set();
  }

  startLunge() {
    this.currentPhase = LUNGE_PHASE.LUNGING;
    this.activeSide = null;
    this.attemptDirection = null;
    this.minimumAngle = null;
    this.bottomRearAngle = null;
    this.bottomRearHeight = null;
    this.localMinimum = null;
    this.returnMaximum = null;
    this.recentAngles = [];
    this.bottomConfirmed = false;
    this.repErrors = new Set();
    this.completedMessage = '';
  }

  recordBottom(frontAngle, rearAngle, rearHeight) {
    if (this.minimumAngle === null || frontAngle < this.minimumAngle - EPSILON) {
      this.minimumAngle = frontAngle;
      this.bottomRearAngle = rearAngle;
      this.bottomRearHeight = rearHeight;
    } else if (frontAngle <= this.minimumAngle + PLATEAU_RANGE + EPSILON) {
      // Небольшая погрешность landmarks около минимума не скрывает работу задней ноги.
      this.bottomRearAngle = rearAngle;
      this.bottomRearHeight = rearHeight;
    }
  }

  finishLunge(legs) {
    const result = {
      side: this.activeSide,
      direction: this.attemptDirection,
      minimumAngle: this.minimumAngle,
      bottomRearAngle: this.bottomRearAngle,
      bottomRearHeight: this.bottomRearHeight,
      errors: [...this.repErrors]
    };
    this.repCount += 1;
    this.enterStanding(legs);
    this.completedMessage = result.minimumAngle > SHALLOW_ANGLE + EPSILON
      ? 'Повтор засчитан. Опускайтесь ниже.' : 'Повтор засчитан.';
    return result;
  }

  // Нижняя точка подтверждается разворотом на 3° или коротким плато.
  advance(legs, front, direction) {
    const straight = legs.left.angle > STANDING_ANGLE + EPSILON
      && legs.right.angle > STANDING_ANGLE + EPSILON;
    if (this.currentPhase === LUNGE_PHASE.WAITING) {
      if (straight) this.enterStanding(legs);
      return null;
    }
    if (this.currentPhase === LUNGE_PHASE.STANDING) {
      if (straight) {
        this.standingAngles = { left: legs.left.angle, right: legs.right.angle };
        return null;
      }
      this.startLunge();
    }

    if (!this.activeSide) {
      if (straight) {
        this.enterStanding(legs);
        return null;
      }
      // Не фиксируем прежнюю ведущую ногу во время смены шага: ожидаем,
      // пока предполагаемая передняя нога действительно начнёт сгибаться.
      if (!front || direction === null || legs[front].angle > FRONT_BENDING_ANGLE + EPSILON) return null;
      this.activeSide = front;
      this.attemptDirection = direction;
      this.startAngle = this.standingAngles[front];
    } else if (front && front !== this.activeSide && !straight) {
      // Не объединяем движения разных ног в один повтор.
      this.resetTracking();
      return { cancelled: true };
    }

    const frontLeg = legs[this.activeSide];
    const rearLeg = legs[this.activeSide === 'left' ? 'right' : 'left'];
    const frontAngle = frontLeg.angle;
    this.recordBottom(frontAngle, rearLeg.angle, rearKneeHeight(frontLeg, rearLeg));

    if (this.currentPhase === LUNGE_PHASE.LUNGING) {
      this.localMinimum = this.localMinimum === null ? frontAngle : Math.min(this.localMinimum, frontAngle);
      this.recentAngles.push(frontAngle);
      if (this.recentAngles.length > PLATEAU_FRAMES) this.recentAngles.shift();
      const plateau = this.recentAngles.length === PLATEAU_FRAMES
        && Math.max(...this.recentAngles) - Math.min(...this.recentAngles) <= PLATEAU_RANGE;
      const enoughMovement = this.minimumAngle <= MIN_LUNGE_ANGLE + EPSILON
        && this.startAngle - this.minimumAngle >= MIN_TRAVEL - EPSILON;
      if (enoughMovement && (frontAngle >= this.localMinimum + REVERSAL - EPSILON || plateau)) {
        this.currentPhase = LUNGE_PHASE.BOTTOM;
        this.bottomConfirmed = true;
        if (straight) return this.finishLunge(legs);
      } else if (straight) {
        this.enterStanding(legs);
      }
      return null;
    }

    if (this.currentPhase === LUNGE_PHASE.BOTTOM) {
      if (frontAngle <= this.localMinimum - REVERSAL + EPSILON) {
        this.currentPhase = LUNGE_PHASE.LUNGING;
        this.localMinimum = frontAngle;
        this.recentAngles = [frontAngle];
        this.bottomConfirmed = false;
      } else if (straight) {
        return this.finishLunge(legs);
      } else if (frontAngle >= this.localMinimum + REVERSAL - EPSILON) {
        this.currentPhase = LUNGE_PHASE.ASCENDING;
        this.returnMaximum = frontAngle;
      }
      return null;
    }

    if (straight) return this.finishLunge(legs);
    this.returnMaximum = Math.max(this.returnMaximum, frontAngle);
    if (frontAngle < MIN_LUNGE_ANGLE && frontAngle <= this.returnMaximum - REVERSAL + EPSILON) {
      this.currentPhase = LUNGE_PHASE.LUNGING;
      this.localMinimum = frontAngle;
      this.recentAngles = [frontAngle];
      this.bottomConfirmed = false;
    }
    return null;
  }

  update(landmarks) {
    const legs = {
      left: measureLeg(landmarks, 'left', this.frameWidth, this.frameHeight),
      right: measureLeg(landmarks, 'right', this.frameWidth, this.frameHeight)
    };
    if (!legs.left || !legs.right) {
      this.missingFrames += 1;
      if (this.missingFrames >= MAX_MISSING_FRAMES) this.resetTracking();
      return { repCount: this.repCount, currentPhase: this.currentPhase, currentErrors: [],
        feedbackMessage: 'Покажите таз, оба колена и обе лодыжки.' };
    }
    this.missingFrames = 0;

    const direction = this.facingDirection === 'auto'
      ? inferFacing(legs) : this.facingDirection === 'right' ? 1 : -1;
    const front = inferFrontLeg(legs, direction);
    const completed = this.advance(legs, front, direction);
    if (completed?.cancelled) {
      return { repCount: this.repCount, currentPhase: this.currentPhase, currentErrors: [],
        feedbackMessage: 'Передняя нога сменилась. Вернитесь в исходную стойку.' };
    }

    const side = completed ? completed.side : this.activeSide;
    const attemptDirection = completed ? completed.direction : this.attemptDirection;
    const directionKnown = direction !== null && (attemptDirection === null || direction === attemptDirection);
    const frontLeg = side ? legs[side] : null;
    const lean = torsoLean(legs, side);
    const frameErrors = [];
    const kneeCheckAvailable = Boolean(frontLeg?.toe && directionKnown);
    if (kneeCheckAvailable && frontLeg.angle < STANDING_ANGLE
        && (frontLeg.knee.x - frontLeg.toe.x) * direction > frontLeg.length * KNEE_TOE_TOLERANCE + EPSILON) {
      frameErrors.push(LUNGE_ERROR.KNEE_PAST_TOE);
    }
    if (lean !== null && directionKnown && lean * direction > MAX_FORWARD_LEAN + EPSILON) {
      frameErrors.push(LUNGE_ERROR.BACK_LEAN);
    }
    if (this.activeSide) for (const error of frameErrors) this.repErrors.add(error);

    const minimumAngle = completed ? completed.minimumAngle : this.minimumAngle;
    const bottomRearAngle = completed ? completed.bottomRearAngle : this.bottomRearAngle;
    const bottomRearHeight = completed ? completed.bottomRearHeight : this.bottomRearHeight;
    const bottomKnown = Boolean(completed || this.bottomConfirmed);
    const currentErrors = [...new Set([...(completed ? completed.errors : this.repErrors), ...frameErrors])]
      .filter((error) => (error !== LUNGE_ERROR.KNEE_PAST_TOE || kneeCheckAvailable)
        && (error !== LUNGE_ERROR.BACK_LEAN || (directionKnown && lean !== null)));
    if (bottomKnown && minimumAngle > SHALLOW_ANGLE + EPSILON) currentErrors.push(LUNGE_ERROR.SHALLOW);

    const notes = [];
    if (completed) notes.push('Повтор засчитан.');
    for (const error of currentErrors) notes.push(errorMessage(error));
    if (lean === null) {
      notes.push('Покажите плечо и таз: проверка корпуса недоступна.');
    } else if (Math.abs(lean) > TARGET_TORSO_LEAN + EPSILON && !currentErrors.includes(LUNGE_ERROR.BACK_LEAN)) {
      notes.push('Держите корпус ближе к вертикали: ориентир — не более 15°.');
    }
    if (this.currentPhase === LUNGE_PHASE.LUNGING && !side) {
      notes.push('Сделайте шаг и покажите обе ноги сбоку, чтобы определить переднюю ногу.');
    } else if ((side || completed) && !directionKnown) {
      notes.push('Покажите направление стоп или задайте его для проверки техники.');
    } else if ((side || completed) && !kneeCheckAvailable) {
      notes.push('Покажите носок передней стопы для проверки положения колена.');
    }
    if (bottomKnown) {
      if (!currentErrors.includes(LUNGE_ERROR.SHALLOW)
          && (minimumAngle < TARGET_FRONT_MIN - EPSILON || minimumAngle > TARGET_FRONT_MAX + EPSILON)) {
        notes.push('Ориентир для переднего колена — 85–95°.');
      }
      if (bottomRearAngle !== null && (bottomRearAngle < TARGET_REAR_MIN - EPSILON || bottomRearAngle > TARGET_REAR_MAX + EPSILON)) {
        // Угол сам по себе не доказывает контакт колена с полом или его отсутствие.
        notes.push('Старайтесь согнуть заднее колено примерно до 90° и опускайтесь подконтрольно.');
      }
      if (bottomRearHeight === null) {
        notes.push('Уровень пола не определён: опускайте заднее колено без резкого касания.');
      } else if (bottomRearHeight > 0.2 + EPSILON) {
        notes.push('Заднее колено может быть высоко: проверьте расстояние до пола.');
      } else if (bottomRearHeight <= 0.03 + EPSILON) {
        notes.push('Сохраняйте небольшой зазор над предполагаемым полом и избегайте резкого касания.');
      }
    }
    if (!notes.length) {
      const labels = {
        WAITING: 'Встаньте прямо, выпрямив обе ноги.',
        STANDING: this.completedMessage || 'Встаньте прямо и начните выпад.',
        LUNGING: 'Опускайтесь подконтрольно.',
        BOTTOM: 'Нижняя точка достигнута. Плавно поднимайтесь.',
        ASCENDING: 'Поднимайтесь и выпрямляйте обе ноги.'
      };
      notes.push(labels[this.currentPhase]);
    }
    return { repCount: this.repCount, currentPhase: this.currentPhase, currentErrors, feedbackMessage: notes.join(' ') };
  }
}
