import { findAngle } from './geometry.js';

export const JACKS_PHASE = Object.freeze({
  WAITING: 'WAITING',
  CLOSED: 'CLOSED',
  OPENING: 'OPENING',
  OPEN: 'OPEN',
  CLOSING: 'CLOSING'
});

export const JACKS_ERROR = Object.freeze({
  LAZY_ARMS: 'Неполный подъём рук',
  NARROW_LEGS: 'Недостаточное разведение ног',
  HANDS_APART: 'Кисти не сведены над головой',
  ARMS_NOT_TOGETHER: 'Руки не достигли верхней позиции одновременно',
  ASYNCHRONY: 'Несинхронность рук и ног',
  OPEN_NOT_CONFIRMED: 'Одновременная открытая позиция не подтверждена'
});

const SIDES = {
  left: { eye: 2, shoulder: 11, elbow: 13, wrist: 15, hip: 23, ankle: 27 },
  right: { eye: 5, shoulder: 12, elbow: 14, wrist: 16, hip: 24, ankle: 28 }
};
const MIN_CONFIDENCE = 0.5;
const CLOSED_ARM_ANGLE = 30;
const OPEN_LEG_RATIO = 1.5;
const MAX_WRIST_SPAN_RATIO = 1;
const CLOSED_WRIST_MARGIN = 0.25;
const MIN_FRONT_SHOULDER_RATIO = 0.35;
const MIN_ATTEMPT_ARM_ANGLE = 60;
const MIN_ATTEMPT_LEG_DELTA = 0.25;
const ARM_REVERSAL = 10;
const LEG_REVERSAL = 0.15;
const MAX_SYNC_DELAY_MS = 300;
const EPSILON = 1e-6;

// X и Y MediaPipe нормированы по разным размерам кадра. Все измерения
// относятся к 2D-проекции; Z не используется для фронтального ракурса.
function framePoint(point, width, height) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  for (const value of [point.visibility, point.presence]) {
    if (value !== undefined && (!Number.isFinite(value) || value < MIN_CONFIDENCE)) return null;
  }
  return { x: point.x * width, y: point.y * height };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function measurePose(landmarks, width, height) {
  const points = {};
  for (const [side, indices] of Object.entries(SIDES)) {
    points[side] = {};
    for (const [key, index] of Object.entries(indices)) {
      points[side][key] = framePoint(landmarks?.[index], width, height);
    }
  }
  const arms = [points.left, points.right];
  if (!arms.every((side) => side.shoulder && side.elbow && side.wrist && side.hip && side.ankle)) {
    return { error: 'Покажите тело целиком спереди: плечи, локти, кисти, таз и лодыжки обеих сторон.' };
  }
  const shoulderWidth = Math.abs(points.left.shoulder.x - points.right.shoulder.x);
  const torsoLengths = arms.map((side) => distance(side.shoulder, side.hip));
  const torsoLength = (torsoLengths[0] + torsoLengths[1]) / 2;
  if (shoulderWidth <= EPSILON || torsoLength <= EPSILON
      || arms.some((side) => side.hip.y <= side.shoulder.y || side.ankle.y <= side.hip.y)) {
    return { error: 'Покажите стоящего человека целиком и повернитесь к камере.' };
  }
  // Эта проверка отбраковывает явно узкий профиль, но не доказывает ракурс анфас.
  if (shoulderWidth < torsoLength * MIN_FRONT_SHOULDER_RATIO - EPSILON) {
    return { error: 'Повернитесь лицом к камере: ширина плеч не видна достаточно отчётливо.' };
  }

  const shoulderY = (points.left.shoulder.y + points.right.shoulder.y) / 2;
  const eyes = arms.map((side) => side.eye).filter((eye) => eye && eye.y < shoulderY);
  if (!eyes.length) return { error: 'Покажите хотя бы один глаз: высота кистей не определена.' };
  // При видимости обоих глаз требуем кисти выше каждого; один глаз — лишь приближение.
  const eyeY = Math.min(...eyes.map((eye) => eye.y));
  const eyeReference = eyes.length === 2 ? 'both' : 'single';
  const angles = arms.map((side) => findAngle(side.hip, side.shoulder, side.wrist));
  const upperAngles = arms.map((side) => findAngle(side.hip, side.shoulder, side.elbow));
  if ([...angles, ...upperAngles].some((angle) => angle === null)) {
    return { error: 'Не удаётся определить положение рук: покажите плечи, локти, таз и кисти раздельно.' };
  }

  const feetRatio = Math.abs(points.left.ankle.x - points.right.ankle.x) / shoulderWidth;
  const armsClosed = arms.every((side, index) => angles[index] < CLOSED_ARM_ANGLE - EPSILON
    && upperAngles[index] < CLOSED_ARM_ANGLE - EPSILON
    && side.wrist.y >= side.hip.y - torsoLengths[index] * CLOSED_WRIST_MARGIN - EPSILON);
  const legsClosed = feetRatio < 1 - EPSILON;
  // Угол в локте сам по себе не имеет направления: проверяем, что запястье
  // выше локтя, локоть выше плеча, а запястье — выше уровня глаз.
  const armsUpIndividually = arms.map((side) => side.wrist.y < eyeY - EPSILON
    && side.wrist.y < side.elbow.y - EPSILON && side.elbow.y < side.shoulder.y - EPSILON);
  const armsUp = armsUpIndividually.every(Boolean);
  const wristsTogether = Math.abs(points.left.wrist.x - points.right.wrist.x)
    <= shoulderWidth * MAX_WRIST_SPAN_RATIO + EPSILON;
  const handsOpen = armsUp && wristsTogether;
  const legsOpen = feetRatio > OPEN_LEG_RATIO + EPSILON;
  return {
    closed: armsClosed && legsClosed,
    open: handsOpen && legsOpen,
    armsUp, armsUpIndividually, handsOpen, legsOpen, feetRatio,
    armAngle: Math.max(...angles), eyeReference
  };
}

function errorMessage(error) {
  if (error === JACKS_ERROR.LAZY_ARMS) return 'Поднимайте руки полностью над головой.';
  if (error === JACKS_ERROR.NARROW_LEGS) return 'Прыгайте шире.';
  if (error === JACKS_ERROR.HANDS_APART) return 'Сводите кисти над головой.';
  if (error === JACKS_ERROR.ARMS_NOT_TOGETHER) return 'Поднимайте обе руки одновременно над головой.';
  if (error === JACKS_ERROR.ASYNCHRONY) return 'Поднимайте руки и разводите ноги одновременно.';
  if (error === JACKS_ERROR.OPEN_NOT_CONFIRMED) return 'Одновременная открытая позиция не зафиксирована.';
  return '';
}

export class JumpingJacksAnalyzer {
  constructor({ videoWidth = 1, videoHeight = 1, maxFrameGapMs = 1000 } = {}) {
    if (!Number.isFinite(maxFrameGapMs) || maxFrameGapMs <= 0) {
      throw new TypeError('maxFrameGapMs должен быть положительным числом миллисекунд.');
    }
    this.maxFrameGapMs = maxFrameGapMs;
    this.frameWidth = 1;
    this.frameHeight = 1;
    this.repCount = 0;
    this.sessionStartMs = null;
    this.lastTimestampMs = null;
    this.resetTracking();
    this.setFrameSize(videoWidth, videoHeight);
  }

  setFrameSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new TypeError('Размеры видеокадра должны быть положительными числами.');
    }
    if (Math.abs(this.frameWidth / this.frameHeight - width / height) > EPSILON) this.resetTracking();
    this.frameWidth = width;
    this.frameHeight = height;
  }

  // Отменяет незавершённый цикл; счётчик и время с начала подхода сохраняются.
  resetTracking() {
    this.currentPhase = JACKS_PHASE.WAITING;
    this.closedFeetRatio = null;
    this.attempt = null;
    this.lastSyncDelayMs = null;
  }

  reset() {
    this.repCount = 0;
    this.sessionStartMs = null;
    this.lastTimestampMs = null;
    this.resetTracking();
  }

  // Средний темп за подход: учитываются и остановки с первого update().
  // Этот метод можно вызывать для HUD без обработки нового видеокадра.
  getCadence(timestampMs) {
    if (timestampMs === undefined) {
      timestampMs = performance.now();
      // При сниженной точности часов несколько кадров могут иметь одинаковое
      // время; update() уже скорректировал его до последней отметки.
      if (this.lastTimestampMs !== null) timestampMs = Math.max(timestampMs, this.lastTimestampMs);
    }
    if (!Number.isFinite(timestampMs) || timestampMs < 0
        || (this.lastTimestampMs !== null && timestampMs < this.lastTimestampMs)) {
      throw new RangeError('Время должно быть неотрицательным и не раньше последнего кадра.');
    }
    if (this.sessionStartMs === null || this.repCount === 0) return 0;
    const elapsed = timestampMs - this.sessionStartMs;
    return elapsed > 0 ? this.repCount * 60000 / elapsed : 0;
  }

  result(errors, notes, timestampMs, eyeReference, syncDelayMs = this.lastSyncDelayMs) {
    if (eyeReference === 'single') notes.push('Уровень глаз оценён по одному видимому глазу.');
    return {
      repCount: this.repCount,
      currentPhase: this.currentPhase,
      currentErrors: [...new Set(errors)],
      feedbackMessage: notes.join(' '),
      cadence: this.getCadence(timestampMs),
      synchronizationDelayMs: syncDelayMs,
      eyeReference
    };
  }

  startAttempt(pose) {
    this.attempt = {
      startFeetRatio: this.closedFeetRatio,
      maxFeetRatio: pose.feetRatio,
      maxArmAngle: pose.armAngle,
      armsUpSeen: false,
      armsUpIndividuallySeen: [false, false],
      usedSingleEye: false,
      handsOpenAt: null,
      legsOpenAt: null,
      openSeen: false
    };
    this.lastSyncDelayMs = null;
  }

  recordAttempt(pose, timestampMs) {
    const attempt = this.attempt;
    attempt.maxFeetRatio = Math.max(attempt.maxFeetRatio, pose.feetRatio);
    attempt.maxArmAngle = Math.max(attempt.maxArmAngle, pose.armAngle);
    attempt.armsUpSeen ||= pose.armsUp;
    pose.armsUpIndividually.forEach((raised, index) => { attempt.armsUpIndividuallySeen[index] ||= raised; });
    attempt.usedSingleEye ||= pose.eyeReference === 'single';
    if (pose.handsOpen && attempt.handsOpenAt === null) attempt.handsOpenAt = timestampMs;
    if (pose.legsOpen && attempt.legsOpenAt === null) attempt.legsOpenAt = timestampMs;
    if (pose.open) attempt.openSeen = true;
    return attempt.handsOpenAt !== null && attempt.legsOpenAt !== null
      ? Math.abs(attempt.handsOpenAt - attempt.legsOpenAt) : null;
  }

  attemptErrors(syncDelayMs, completed = false) {
    const attempt = this.attempt;
    const errors = [];
    if (syncDelayMs !== null && syncDelayMs > MAX_SYNC_DELAY_MS) errors.push(JACKS_ERROR.ASYNCHRONY);
    const meaningful = attempt.maxArmAngle >= MIN_ATTEMPT_ARM_ANGLE - EPSILON
      || attempt.maxFeetRatio - attempt.startFeetRatio >= MIN_ATTEMPT_LEG_DELTA - EPSILON;
    if (!attempt.openSeen && meaningful && (completed || this.currentPhase === JACKS_PHASE.CLOSING)) {
      if (!attempt.armsUpSeen) {
        errors.push(attempt.armsUpIndividuallySeen.every(Boolean)
          ? JACKS_ERROR.ARMS_NOT_TOGETHER : JACKS_ERROR.LAZY_ARMS);
      } else if (attempt.handsOpenAt === null) errors.push(JACKS_ERROR.HANDS_APART);
      if (attempt.legsOpenAt === null) errors.push(JACKS_ERROR.NARROW_LEGS);
      if (attempt.handsOpenAt !== null && attempt.legsOpenAt !== null) {
        errors.push(JACKS_ERROR.OPEN_NOT_CONFIRMED);
      }
    }
    return { errors, meaningful };
  }

  // timestampMs — строго возрастающее время в миллисекундах из одного источника,
  // например тот же performance.now(), что передаётся в MediaPipe.
  update(landmarks, timestampMs) {
    let now = timestampMs;
    if (now === undefined) {
      now = performance.now();
      if (this.lastTimestampMs !== null) now = Math.max(now, this.lastTimestampMs + 0.001);
    }
    if (!Number.isFinite(now) || now < 0 || (this.lastTimestampMs !== null && now <= this.lastTimestampMs)) {
      this.resetTracking();
      throw new RangeError('timestampMs должен быть неотрицательным и строго возрастать.');
    }
    if (this.lastTimestampMs !== null && now - this.lastTimestampMs > this.maxFrameGapMs) this.resetTracking();
    this.lastTimestampMs = now;
    if (this.sessionStartMs === null) this.sessionStartMs = now;

    const pose = measurePose(landmarks, this.frameWidth, this.frameHeight);
    if (pose.error) {
      this.resetTracking();
      return this.result([], [pose.error], now, 'unavailable', null);
    }
    if (this.currentPhase === JACKS_PHASE.WAITING) {
      if (pose.closed) {
        this.currentPhase = JACKS_PHASE.CLOSED;
        this.closedFeetRatio = pose.feetRatio;
      }
      const message = pose.closed ? 'Исходное положение найдено.' : 'Встаньте прямо: ноги вместе, руки вдоль тела.';
      return this.result([], [message], now, pose.eyeReference);
    }
    if (this.currentPhase === JACKS_PHASE.CLOSED && pose.closed) {
      this.closedFeetRatio = pose.feetRatio;
      return this.result([], ['Начинайте прыжок: одновременно разведите ноги и поднимите руки.'], now, pose.eyeReference);
    }
    if (this.currentPhase === JACKS_PHASE.CLOSED) {
      this.startAttempt(pose);
      this.currentPhase = JACKS_PHASE.OPENING;
    }

    const syncDelayMs = this.recordAttempt(pose, now);
    const cycleEyeReference = this.attempt.usedSingleEye ? 'single' : pose.eyeReference;
    if (pose.closed) {
      const counted = this.attempt.openSeen;
      const { errors, meaningful } = this.attemptErrors(syncDelayMs, true);
      if (counted) this.repCount += 1;
      this.currentPhase = JACKS_PHASE.CLOSED;
      this.closedFeetRatio = pose.feetRatio;
      this.lastSyncDelayMs = syncDelayMs;
      this.attempt = null;
      const notes = [];
      if (counted) notes.push('Повтор засчитан.');
      else if (meaningful) notes.push('Полный повтор не засчитан.');
      else notes.push('Вернитесь в исходное положение и начните движение.');
      for (const error of errors) notes.push(errorMessage(error));
      return this.result(errors, notes, now, cycleEyeReference, syncDelayMs);
    }

    if (pose.open) this.currentPhase = JACKS_PHASE.OPEN;
    else if (this.attempt.openSeen || this.attempt.maxArmAngle - pose.armAngle > ARM_REVERSAL + EPSILON
        || this.attempt.maxFeetRatio - pose.feetRatio > LEG_REVERSAL + EPSILON) {
      this.currentPhase = JACKS_PHASE.CLOSING;
    } else this.currentPhase = JACKS_PHASE.OPENING;
    const { errors } = this.attemptErrors(syncDelayMs);
    const notes = errors.map(errorMessage);
    if (!notes.length) {
      const labels = {
        OPENING: 'Разводите ноги и поднимайте руки.',
        OPEN: 'Открытая позиция достигнута. Вернитесь в исходное положение.',
        CLOSING: 'Сводите ноги и опускайте руки.'
      };
      notes.push(labels[this.currentPhase]);
    }
    return this.result(errors, notes, now, cycleEyeReference, syncDelayMs);
  }
}
