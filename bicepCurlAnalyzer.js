import { findAngle } from './geometry.js';

// Дополнительные WAITING и LOWERING позволяют не путать неполное движение
// с достижением целевой верхней точки PEAK.
export const BICEP_PHASE = Object.freeze({
  WAITING: 'WAITING',
  DOWN: 'DOWN',
  CURLING: 'CURLING',
  PEAK: 'PEAK',
  LOWERING: 'LOWERING'
});

export const BICEP_ERROR = Object.freeze({
  SHORT_BOTTOM: 'Неполная амплитуда снизу',
  SHORT_TOP: 'Недожим сверху',
  ELBOW_DRIFT: 'Локоть смещён относительно корпуса',
  BACK_SWAY: 'Раскачка корпусом назад'
});

const SIDES = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24 }
};
const MIN_CONFIDENCE = 0.5;
const DOWN_ANGLE = 155;
const SHORT_BOTTOM_ANGLE = 145;
const PEAK_ANGLE = 45;
const SHORT_TOP_ANGLE = 55;
const MAX_ELBOW_DRIFT = 25;
const MAX_BACK_SWAY = 10;
const REVERSAL = 3;
const MIN_CURL_TRAVEL = 10;
const MAX_MISSING_FRAMES = 10;
const EPSILON = 1e-6;
const DEGREES = 180 / Math.PI;

// X и Z MediaPipe нормированы по ширине, Y — по высоте видеокадра.
function framePoint(point, width, height) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1
      || (point.z !== undefined && !Number.isFinite(point.z))) return null;
  for (const value of [point.visibility, point.presence]) {
    if (value !== undefined && (!Number.isFinite(value) || value < MIN_CONFIDENCE)) return null;
  }
  const result = {
    x: point.x * width,
    y: point.y * height,
    confidence: Math.min(point.visibility ?? 1, point.presence ?? 1)
  };
  if (point.z !== undefined) result.z = point.z * width;
  return result;
}

// При полном Z используем 3D; при частично отсутствующей глубине — 2D,
// поскольку geometry.js не допускает смешивание размерностей в одном угле.
function angleBetween(a, b, c) {
  if (!a || !b || !c) return null;
  if ([a, b, c].every((point) => point.z !== undefined)) return findAngle(a, b, c);
  const flat = (point) => ({ x: point.x, y: point.y });
  return findAngle(flat(a), flat(b), flat(c));
}

function measureSide(landmarks, side, width, height) {
  const indices = SIDES[side];
  const get = (index) => framePoint(landmarks?.[index], width, height);
  const shoulder = get(indices.shoulder);
  const elbow = get(indices.elbow);
  const wrist = get(indices.wrist);
  if (!shoulder || !elbow || !wrist) return null;
  const elbowAngle = angleBetween(shoulder, elbow, wrist);
  if (elbowAngle === null) return null;
  const hip = get(indices.hip);
  const shoulderAngle = angleBetween(hip, shoulder, elbow);
  // Знак наклона определён в координатах входного кадра; Y растёт вниз.
  const torsoLean = hip && hip.y > shoulder.y
    ? Math.atan2(shoulder.x - hip.x, hip.y - shoulder.y) * DEGREES : null;
  return {
    side, shoulder, hip, elbowAngle, shoulderAngle, torsoLean,
    confidence: Math.min(shoulder.confidence, elbow.confidence, wrist.confidence, hip ? hip.confidence : 1)
  };
}

// Нос должен находиться с одной стороны от видимых ушей. Если видно только
// одно ухо, нужен также противоположный глаз: одно ухо и нос неоднозначны
// (например, человек стоит анфас и закрыл вторую сторону лица).
function inferFacing(landmarks, pose, width, height) {
  if (!pose.hip) return null;
  const nose = framePoint(landmarks?.[0], width, height);
  const ears = [7, 8].map((index) => ({ index, point: framePoint(landmarks?.[index], width, height) }))
    .filter(({ point }) => point);
  if (!nose || !ears.length) return null;
  const torsoLength = Math.hypot(pose.shoulder.x - pose.hip.x, pose.shoulder.y - pose.hip.y);
  if (!torsoLength) return null;
  const offsets = ears.map(({ point }) => nose.x - point.x);
  if (offsets.some((offset) => Math.abs(offset) < torsoLength * 0.04)) return null;
  const direction = Math.sign(offsets[0]);
  if (!offsets.every((offset) => Math.sign(offset) === direction)) return null;
  if (ears.length === 1) {
    const oppositeEye = framePoint(landmarks?.[ears[0].index === 7 ? 5 : 2], width, height);
    if (!oppositeEye) return null;
    const eyeOffset = nose.x - oppositeEye.x;
    if (Math.abs(eyeOffset) < torsoLength * 0.015 || Math.sign(eyeOffset) !== direction) return null;
  }
  return direction;
}

function feedbackForErrors(errors) {
  if (errors.includes(BICEP_ERROR.BACK_SWAY)) return 'Не раскачивайте корпус назад.';
  if (errors.includes(BICEP_ERROR.ELBOW_DRIFT)) return 'Держите локоть у корпуса.';
  if (errors.includes(BICEP_ERROR.SHORT_BOTTOM)) return 'Полностью разгибайте руку внизу.';
  if (errors.includes(BICEP_ERROR.SHORT_TOP)) return 'Поднимайте предплечье выше.';
  return '';
}

export class BicepCurlAnalyzer {
  constructor({ side = 'auto', facingDirection = 'auto', videoWidth = 1, videoHeight = 1 } = {}) {
    this.repCount = 0;
    this.side = 'auto';
    this.facingDirection = 'auto';
    this.frameWidth = 1;
    this.frameHeight = 1;
    this.resetTracking();
    this.setSide(side);
    this.setFacingDirection(facingDirection);
    this.setFrameSize(videoWidth, videoHeight);
  }

  setSide(side) {
    if (!['auto', 'left', 'right'].includes(side)) {
      throw new TypeError('Рука должна быть auto, left или right.');
    }
    if (this.side !== side) {
      this.side = side;
      this.resetTracking();
    }
  }

  // left/right — направление лица в координатах исходного кадра MediaPipe,
  // а не обязательно зеркально отображаемого preview.
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

  // При смене источника или длительной потере позы отменяем незавершённое
  // движение, сохраняя уже засчитанные повторы.
  resetTracking() {
    this.currentPhase = BICEP_PHASE.WAITING;
    this.activeSide = this.side === 'auto' ? null : this.side;
    this.missingFrames = 0;
    this.bottomMaximum = null;
    this.bottomLean = null;
    this.bottomFacing = null;
    this.minimumAngle = null;
    this.returnMaximum = null;
    this.returnLean = null;
    this.returnFacing = null;
    this.startAngle = null;
    this.referenceLean = null;
    this.referenceFacing = null;
    this.reachedTarget = false;
    this.repErrors = new Set();
    this.completedMessage = '';
  }

  reset() {
    this.repCount = 0;
    this.resetTracking();
  }

  startCurl(startAngle, lean, facing, angle) {
    this.currentPhase = BICEP_PHASE.CURLING;
    this.startAngle = startAngle;
    this.minimumAngle = angle;
    this.returnMaximum = null;
    this.referenceLean = lean;
    this.referenceFacing = facing;
    this.reachedTarget = false;
    this.repErrors = new Set();
    this.completedMessage = '';
    if (startAngle < SHORT_BOTTOM_ANGLE - EPSILON) this.repErrors.add(BICEP_ERROR.SHORT_BOTTOM);
    if (angle <= PEAK_ANGLE + EPSILON) {
      this.currentPhase = BICEP_PHASE.PEAK;
      this.reachedTarget = true;
    }
  }

  finishAttempt(angle, lean, facing) {
    const errors = [...this.repErrors];
    const counted = this.startAngle - this.minimumAngle >= MIN_CURL_TRAVEL - EPSILON;
    const reachedTarget = this.reachedTarget;
    if (counted) this.repCount += 1;
    this.currentPhase = BICEP_PHASE.DOWN;
    this.bottomMaximum = angle;
    this.bottomLean = lean;
    this.bottomFacing = facing;
    this.minimumAngle = null;
    this.returnMaximum = null;
    this.referenceLean = null;
    this.referenceFacing = null;
    this.startAngle = null;
    this.repErrors = new Set();
    this.completedMessage = counted
      ? `Повтор засчитан.${reachedTarget ? '' : ' Старайтесь согнуть руку до целевой верхней точки.'}`
      : 'Поднимайте предплечье с большей амплитудой.';
    return { errors, counted, reachedTarget };
  }

  // Возвращает снимок ошибок при завершении движения либо null.
  advance(angle, lean, facing) {
    if (this.currentPhase === BICEP_PHASE.WAITING || this.currentPhase === BICEP_PHASE.DOWN) {
      if (this.bottomMaximum === null || angle > this.bottomMaximum) {
        this.bottomMaximum = angle;
        this.bottomLean = lean;
        this.bottomFacing = facing;
      } else if (angle > DOWN_ANGLE + EPSILON) {
        // Опорные данные относятся к последнему видимому положению внизу.
        this.bottomLean = lean;
        this.bottomFacing = facing;
      }
      if (angle > DOWN_ANGLE + EPSILON) {
        this.currentPhase = BICEP_PHASE.DOWN;
      } else if (this.bottomMaximum - angle >= REVERSAL - EPSILON) {
        this.startCurl(this.bottomMaximum, this.bottomLean, this.bottomFacing, angle);
      } else {
        // До подтверждённого сгибания обновляем исходное положение тела.
        this.bottomLean = lean;
        this.bottomFacing = facing;
        // На границе 155° ещё не подтверждено сгибание, но это уже не DOWN.
        this.currentPhase = BICEP_PHASE.WAITING;
      }
      return null;
    }

    if (this.currentPhase === BICEP_PHASE.CURLING || this.currentPhase === BICEP_PHASE.PEAK) {
      const wasAtTarget = this.currentPhase === BICEP_PHASE.PEAK;
      this.minimumAngle = Math.min(this.minimumAngle, angle);
      if (angle <= PEAK_ANGLE + EPSILON) {
        this.currentPhase = BICEP_PHASE.PEAK;
        this.reachedTarget = true;
      }
      const reversed = angle >= this.minimumAngle + REVERSAL - EPSILON;
      // PEAK соответствует углу ≤45°; даже небольшой выход из него — LOWERING.
      if (reversed || (wasAtTarget && angle > PEAK_ANGLE + EPSILON)) {
        if (this.minimumAngle > SHORT_TOP_ANGLE + EPSILON) this.repErrors.add(BICEP_ERROR.SHORT_TOP);
        this.currentPhase = BICEP_PHASE.LOWERING;
        this.returnMaximum = angle;
        this.returnLean = lean;
        this.returnFacing = facing;
        if (angle > DOWN_ANGLE + EPSILON) return this.finishAttempt(angle, lean, facing);
      }
      return null;
    }

    if (angle > this.returnMaximum) {
      this.returnMaximum = angle;
      this.returnLean = lean;
      this.returnFacing = facing;
    }
    if (angle > DOWN_ANGLE + EPSILON) return this.finishAttempt(angle, lean, facing);
    if (angle <= this.returnMaximum - REVERSAL + EPSILON) {
      // Предыдущая попытка не дошла до DOWN. Новая начинается с реального
      // максимума разгибания, чтобы обнаружить короткую амплитуду снизу.
      this.startCurl(this.returnMaximum, this.returnLean, this.returnFacing, angle);
    } else {
      // Последнее положение перед возможным разворотом — база нового подъёма.
      this.returnLean = lean;
      this.returnFacing = facing;
      if (this.reachedTarget && angle <= PEAK_ANGLE + EPSILON) {
        // Небольшое колебание около 45° — продолжение той же верхней точки.
        this.minimumAngle = Math.min(this.minimumAngle, angle);
        this.currentPhase = BICEP_PHASE.PEAK;
      }
    }
    return null;
  }

  update(landmarks) {
    const candidates = (this.side === 'auto' ? ['left', 'right'] : [this.side])
      .map((side) => measureSide(landmarks, side, this.frameWidth, this.frameHeight))
      .filter(Boolean);
    let pose = this.activeSide ? candidates.find((candidate) => candidate.side === this.activeSide) : null;

    if (!pose && this.activeSide) {
      this.missingFrames += 1;
      if (this.missingFrames < MAX_MISSING_FRAMES) {
        return { repCount: this.repCount, currentPhase: this.currentPhase, currentErrors: [],
          feedbackMessage: 'Покажите плечо, локоть и запястье выбранной руки.' };
      }
      this.resetTracking();
    }
    if (!pose && !this.activeSide && candidates.length) {
      // Сначала предпочитаем сторону с видимым тазом, затем —
      // наибольшую минимальную уверенность опорных точек.
      candidates.sort((a, b) => Number(Boolean(b.hip)) - Number(Boolean(a.hip))
        || b.confidence - a.confidence);
      pose = candidates[0];
      this.activeSide = pose.side;
    }
    if (!pose) {
      return { repCount: this.repCount, currentPhase: this.currentPhase, currentErrors: [],
        feedbackMessage: 'Покажите плечо, локоть и запястье выбранной руки.' };
    }
    this.missingFrames = 0;

    const facing = this.facingDirection === 'auto'
      ? inferFacing(landmarks, pose, this.frameWidth, this.frameHeight)
      : this.facingDirection === 'right' ? 1 : -1;
    // advance() очищает опорное положение при завершении; снимок нужен,
    // чтобы не сообщать старую раскачку при смене ракурса на последнем кадре.
    const previousReferenceFacing = this.referenceFacing;
    const previousReferenceLean = this.referenceLean;
    const completed = this.advance(pose.elbowAngle, pose.torsoLean, facing);
    const inAttempt = [BICEP_PHASE.CURLING, BICEP_PHASE.PEAK, BICEP_PHASE.LOWERING].includes(this.currentPhase);
    const observedAttempt = inAttempt || completed !== null;
    const attemptFacing = completed ? previousReferenceFacing : this.referenceFacing;
    const attemptLean = completed ? previousReferenceLean : this.referenceLean;
    const frameErrors = [];
    if (pose.shoulderAngle !== null && pose.shoulderAngle > MAX_ELBOW_DRIFT + EPSILON) {
      frameErrors.push(BICEP_ERROR.ELBOW_DRIFT);
    }
    const lifting = this.currentPhase === BICEP_PHASE.CURLING || this.currentPhase === BICEP_PHASE.PEAK;
    const facingConfirmed = this.referenceFacing !== null && facing === this.referenceFacing;
    if (lifting && this.referenceLean !== null && pose.torsoLean !== null && facingConfirmed
        && (pose.torsoLean - this.referenceLean) * this.referenceFacing < -MAX_BACK_SWAY - EPSILON) {
      frameErrors.push(BICEP_ERROR.BACK_SWAY);
    }
    if (inAttempt) for (const error of frameErrors) this.repErrors.add(error);
    // Историческая ошибка не должна выглядеть как уверенное утверждение о
    // текущем кадре, если направление или положение корпуса сейчас неизвестно.
    const canReportBack = pose.torsoLean !== null && facing !== null
      && (!observedAttempt || attemptFacing === facing);
    const currentErrors = [...new Set([...(completed ? completed.errors : this.repErrors), ...frameErrors])]
      .filter((error) => error !== BICEP_ERROR.BACK_SWAY || canReportBack);

    let feedbackMessage = feedbackForErrors(currentErrors);
    if (completed && completed.counted) {
      const messages = feedbackMessage ? [feedbackMessage] : [];
      // Даже при более приоритетной ошибке не скрываем предупреждение об
      // амплитуде завершённого повтора.
      for (const error of [BICEP_ERROR.SHORT_BOTTOM, BICEP_ERROR.SHORT_TOP]) {
        const message = feedbackForErrors([error]);
        if (currentErrors.includes(error) && !messages.includes(message)) messages.push(message);
      }
      if (!completed.reachedTarget && !currentErrors.includes(BICEP_ERROR.SHORT_TOP)) {
        messages.push('Старайтесь согнуть руку до целевой верхней точки.');
      }
      feedbackMessage = ['Повтор засчитан.', ...messages].join(' ');
    } else if (!feedbackMessage && this.completedMessage && this.currentPhase === BICEP_PHASE.DOWN) {
      feedbackMessage = this.completedMessage;
    } else if (!feedbackMessage) {
      const labels = {
        WAITING: 'Выпрямите руку перед подъёмом.',
        DOWN: 'Начинайте сгибать руку.',
        CURLING: 'Сгибайте руку, не двигая корпусом.',
        PEAK: 'Верхняя точка достигнута. Плавно опускайте вес.',
        LOWERING: 'Плавно выпрямляйте руку.'
      };
      feedbackMessage = labels[this.currentPhase];
    }

    // Отсутствие данных — не ошибка техники, но его нельзя скрывать за советом.
    if (pose.shoulderAngle === null || pose.torsoLean === null) {
      feedbackMessage += ' Покажите плечо и таз: проверка корпуса и локтя недоступна.';
    } else {
      if (facing === null) {
        feedbackMessage += ' Покажите лицо сбоку или задайте направление для проверки раскачки.';
      } else if (observedAttempt && attemptFacing === null) {
        feedbackMessage += ' Направление в исходной стойке неизвестно: покажите лицо до следующего подъёма.';
      } else if (observedAttempt && attemptFacing !== facing) {
        feedbackMessage += ' Ракурс изменился: начните следующий подъём с видимым лицом сбоку.';
      }
      if (observedAttempt && attemptLean === null) {
        feedbackMessage += ' Покажите таз внизу движения для проверки раскачки корпуса.';
      }
    }
    return { repCount: this.repCount, currentPhase: this.currentPhase, currentErrors, feedbackMessage };
  }
}
