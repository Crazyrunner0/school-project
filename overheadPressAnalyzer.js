import { findAngle } from './geometry.js';

export const OVERHEAD_PHASE = Object.freeze({
  WAITING: 'WAITING',
  START: 'START',
  PRESSING: 'PRESSING',
  TOP: 'TOP',
  LOCKOUT: 'LOCKOUT',
  LOWERING: 'LOWERING'
});

export const OVERHEAD_ERROR = Object.freeze({
  SHORT_PRESS: 'Неполное выпрямление рук',
  ASYMMETRY: 'Асимметрия рук',
  BACK_LEAN: 'Отклонение плеч назад относительно таза'
});

const SIDES = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24 }
};
const CONFIDENCE = 0.5;
const START_MIN = 60;
const START_MAX = 80;
const LOCKOUT_ANGLE = 165;
const INCOMPLETE_ANGLE = 160;
const ASYMMETRY_ANGLE = 15;
const WRIST_HEIGHT_RATIO = 0.15;
const BACK_LEAN_CHANGE = 15;
const REVERSAL = 3;
const MIN_PRESS_TRAVEL = 10;
const MIN_WRIST_RISE_RATIO = 0.3;
const MIN_ELEVATION_RATIO = 0.15;
const LOCKOUT_HEIGHT_RATIO = 1;
const NOSE_CLEARANCE_RATIO = 0.2;
const REVERSAL_HEIGHT_RATIO = 0.04;
const TOP_BAND_RATIO = 0.05;
const PLATEAU_FRAMES = 6;
const PLATEAU_HEIGHT_RATIO = 0.025;
const MAX_MISSING_FRAMES = 10;
const EPSILON = 1e-6;
const DEGREES = 180 / Math.PI;

// X и Z нормированы MediaPipe по ширине кадра, а Y — по высоте.
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

function measureArm(landmarks, name, width, height) {
  const indices = SIDES[name];
  const get = (key) => framePoint(landmarks?.[indices[key]], width, height);
  const shoulder = get('shoulder');
  const elbow = get('elbow');
  const wrist = get('wrist');
  if (!shoulder || !elbow || !wrist) return null;
  const flat = (point) => ({ x: point.x, y: point.y });
  const planarAngle = findAngle(flat(shoulder), flat(elbow), flat(wrist));
  const hasDepth = [shoulder, elbow, wrist].every((point) => point.z !== undefined);
  const angle = hasDepth ? findAngle(shoulder, elbow, wrist) : planarAngle;
  if (angle === null) return null;
  const upperLength = Math.hypot(shoulder.x - elbow.x, shoulder.y - elbow.y);
  if (upperLength <= EPSILON) return null;
  return { name, shoulder, elbow, wrist, hip: get('hip'), angle, planarAngle, hasDepth, upperLength };
}

function measureTorsos(arms) {
  return Object.values(arms).map((arm) => {
    if (!arm.hip) return null;
    const dx = arm.shoulder.x - arm.hip.x;
    const dy = arm.hip.y - arm.shoulder.y;
    const length = Math.hypot(dx, dy);
    if (length <= EPSILON || dy <= 0) return null;
    return { side: arm.name, length, lean: Math.atan2(dx, dy) * DEGREES,
      confidence: Math.min(arm.shoulder.confidence, arm.hip.confidence) };
  }).filter(Boolean);
}

function inferView(arms, torsos) {
  if (torsos.length !== 2 || !arms.left.hip || !arms.right.hip) return 'unknown';
  const torsoLength = (torsos[0].length + torsos[1].length) / 2;
  const shoulderSpan = Math.abs(arms.left.shoulder.x - arms.right.shoulder.x);
  const hipSpan = Math.abs(arms.left.hip.x - arms.right.hip.x);
  const ratio = (shoulderSpan + hipSpan) / (2 * torsoLength);
  if (ratio <= 0.35) return 'side';
  if (ratio >= 0.7) return 'front';
  return 'unknown';
}

// Для профиля нос должен быть по одну сторону от видимых ушей. При одном ухе
// дополнительно нужен противоположный глаз, иначе анфас может выглядеть как профиль.
function inferFacing(landmarks, torsoLength, width, height) {
  const nose = framePoint(landmarks?.[0], width, height);
  const ears = [7, 8].map((index) => ({ index, point: framePoint(landmarks?.[index], width, height) }))
    .filter(({ point }) => point);
  if (!nose || !ears.length || !torsoLength) return null;
  const offsets = ears.map(({ point }) => nose.x - point.x);
  if (offsets.some((offset) => Math.abs(offset) < torsoLength * 0.04)) return null;
  const direction = Math.sign(offsets[0]);
  if (!offsets.every((offset) => Math.sign(offset) === direction)) return null;
  if (ears.length === 1) {
    const eye = framePoint(landmarks?.[ears[0].index === 7 ? 5 : 2], width, height);
    if (!eye) return null;
    const offset = nose.x - eye.x;
    if (Math.abs(offset) < torsoLength * 0.015 || Math.sign(offset) !== direction) return null;
  }
  return direction;
}

function isStart(arms) {
  return Object.values(arms).every((arm) => {
    const height = arm.shoulder.y - arm.wrist.y;
    return arm.angle >= START_MIN - EPSILON && arm.angle <= START_MAX + EPSILON
      && height >= -arm.upperLength * 0.35 - EPSILON && height <= arm.upperLength * 0.8 + EPSILON;
  });
}

// Верх головы по плечу и локтю точно не известен. Высота над плечом —
// приблизительный ориентир; при видимом носе нужен и зазор над ним.
function isLockout(arms, nose) {
  return Object.values(arms).every((arm) => {
    const noseVisible = nose && nose.y < arm.shoulder.y
      && arm.shoulder.y - nose.y <= arm.upperLength * 1.5;
    return arm.angle > LOCKOUT_ANGLE + EPSILON
      && arm.shoulder.y - arm.wrist.y > arm.upperLength * LOCKOUT_HEIGHT_RATIO + EPSILON
      && (!noseVisible || nose.y - arm.wrist.y > arm.upperLength * NOSE_CLEARANCE_RATIO + EPSILON);
  });
}

function feedbackForError(error) {
  if (error === OVERHEAD_ERROR.SHORT_PRESS) return 'Полностью выпрямляйте обе руки над головой.';
  if (error === OVERHEAD_ERROR.ASYMMETRY) return 'Выжимайте вес равномерно обеими руками.';
  if (error === OVERHEAD_ERROR.BACK_LEAN) return 'Не прогибайте поясницу, зафиксируйте кор.';
  return '';
}

export class OverheadPressAnalyzer {
  constructor({ view = 'auto', facingDirection = 'auto', videoWidth = 1, videoHeight = 1 } = {}) {
    this.repCount = 0;
    this.view = 'auto';
    this.facingDirection = 'auto';
    this.frameWidth = 1;
    this.frameHeight = 1;
    this.resetTracking();
    this.setView(view);
    this.setFacingDirection(facingDirection);
    this.setFrameSize(videoWidth, videoHeight);
  }

  setView(view) {
    if (!['auto', 'front', 'side'].includes(view)) {
      throw new TypeError('Ракурс должен быть auto, front или side.');
    }
    if (view !== this.view) {
      this.view = view;
      this.resetTracking();
    }
  }

  // left/right относятся к входному кадру MediaPipe, не к зеркальному preview.
  setFacingDirection(direction) {
    if (!['auto', 'left', 'right'].includes(direction)) {
      throw new TypeError('Направление должно быть auto, left или right.');
    }
    if (direction !== this.facingDirection) {
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

  // Прервать незавершённый жим без потери уже засчитанных повторов.
  resetTracking() {
    this.currentPhase = OVERHEAD_PHASE.WAITING;
    this.missingFrames = 0;
    this.angleDimension = null;
    this.baselineAngles = null;
    this.baselineWrists = null;
    this.baselineScale = null;
    this.reference = null;
    this.initialProgress = null;
    this.maximumProgress = null;
    this.maximumHeight = null;
    this.topAngle = null;
    this.topAngleHeight = null;
    this.localMaximumHeight = null;
    this.localMinimumHeight = null;
    this.peakRise = null;
    this.peakAngles = null;
    this.peakElevation = null;
    this.recentHeights = [];
    this.reachedLockout = false;
    this.repErrors = new Set();
    this.completedMessage = '';
  }

  reset() {
    this.repCount = 0;
    this.resetTracking();
  }

  captureStart(arms, torsos, view, facing, fresh = false) {
    this.currentPhase = OVERHEAD_PHASE.START;
    if (fresh || !this.baselineAngles) {
      this.baselineAngles = { left: arms.left.angle, right: arms.right.angle };
      this.baselineWrists = { left: arms.left.wrist.y, right: arms.right.wrist.y };
    } else {
      for (const name of ['left', 'right']) {
        this.baselineAngles[name] = Math.min(this.baselineAngles[name], arms[name].angle);
        this.baselineWrists[name] = Math.max(this.baselineWrists[name], arms[name].wrist.y);
      }
    }
    this.baselineScale = (arms.left.upperLength + arms.right.upperLength) / 2;
    const bestTorso = [...torsos].sort((a, b) => b.confidence - a.confidence)[0] ?? null;
    this.reference = { view, facing, torso: bestTorso };
  }

  startPress() {
    this.currentPhase = OVERHEAD_PHASE.PRESSING;
    this.initialProgress = Math.min(this.baselineAngles.left, this.baselineAngles.right);
    this.maximumProgress = null;
    this.maximumHeight = null;
    this.topAngle = null;
    this.topAngleHeight = null;
    this.localMaximumHeight = null;
    this.localMinimumHeight = null;
    this.peakRise = { left: 0, right: 0 };
    this.peakAngles = { ...this.baselineAngles };
    this.peakElevation = { left: -Infinity, right: -Infinity };
    this.recentHeights = [];
    this.reachedLockout = false;
    this.repErrors = new Set();
    this.completedMessage = '';
  }

  // Оцениваем локти именно у верхней точки кистей, а не при случайном
  // разгибании рук в другом положении. Небольшое плато сглаживает шум.
  recordTop(height, angle) {
    const band = this.baselineScale * TOP_BAND_RATIO;
    if (this.maximumHeight === null || height > this.maximumHeight) {
      this.maximumHeight = height;
      if (this.topAngleHeight === null || this.topAngleHeight < height - band) {
        this.topAngle = angle;
        this.topAngleHeight = height;
      }
    }
    if (height >= this.maximumHeight - band && angle > this.topAngle) {
      this.topAngle = angle;
      this.topAngleHeight = height;
    }
  }

  finishPress(arms, torsos, view, facing) {
    const counted = this.maximumProgress - this.initialProgress >= MIN_PRESS_TRAVEL - EPSILON
      && Math.min(this.peakRise.left, this.peakRise.right) >= this.baselineScale * MIN_WRIST_RISE_RATIO - EPSILON
      && Math.min(this.peakElevation.left, this.peakElevation.right) >= this.baselineScale * MIN_ELEVATION_RATIO - EPSILON;
    const result = { counted, topAngle: this.topAngle,
      reachedLockout: this.reachedLockout, reference: this.reference, errors: [...this.repErrors] };
    if (counted) this.repCount += 1;
    this.captureStart(arms, torsos, view, facing, true);
    this.repErrors = new Set();
    let completionTip = '';
    if (result.topAngle < INCOMPLETE_ANGLE - EPSILON) {
      completionTip = ' Полностью выпрямляйте руки над головой.';
    } else if (!result.reachedLockout) {
      completionTip = result.topAngle > LOCKOUT_ANGLE + EPSILON
        ? ' Поднимите кисти выше, над головой.' : ' Старайтесь выпрямлять руки над головой.';
    }
    this.completedMessage = counted ? `Повтор засчитан.${completionTip}`
      : 'Выжимайте обе руки с большей амплитудой.';
    return result;
  }

  advance(arms, torsos, view, facing, nose) {
    const atStart = isStart(arms);
    if (this.currentPhase === OVERHEAD_PHASE.WAITING) {
      if (atStart) this.captureStart(arms, torsos, view, facing, true);
      return null;
    }
    if (this.currentPhase === OVERHEAD_PHASE.START) {
      const angleIncrease = Math.max(arms.left.angle - this.baselineAngles.left,
        arms.right.angle - this.baselineAngles.right);
      const heightIncrease = Math.max(this.baselineWrists.left - arms.left.wrist.y,
        this.baselineWrists.right - arms.right.wrist.y);
      if (angleIncrease >= REVERSAL - EPSILON || heightIncrease >= this.baselineScale * 0.06 - EPSILON) {
        this.startPress();
      } else if (atStart) {
        this.captureStart(arms, torsos, view, facing);
        return null;
      } else {
        this.resetTracking();
        return null;
      }
    }

    const progress = Math.min(arms.left.angle, arms.right.angle);
    const height = Math.min(arms.left.shoulder.y - arms.left.wrist.y,
      arms.right.shoulder.y - arms.right.wrist.y);
    const reversalHeight = this.baselineScale * REVERSAL_HEIGHT_RATIO;
    this.maximumProgress = this.maximumProgress === null ? progress : Math.max(this.maximumProgress, progress);
    this.recordTop(height, progress);
    for (const name of ['left', 'right']) {
      this.peakRise[name] = Math.max(this.peakRise[name], this.baselineWrists[name] - arms[name].wrist.y);
      this.peakAngles[name] = Math.max(this.peakAngles[name], arms[name].angle);
      this.peakElevation[name] = Math.max(this.peakElevation[name], arms[name].shoulder.y - arms[name].wrist.y);
    }

    if (isLockout(arms, nose)) {
      this.currentPhase = OVERHEAD_PHASE.LOCKOUT;
      this.reachedLockout = true;
      return null;
    }
    if (this.currentPhase === OVERHEAD_PHASE.LOCKOUT) {
      this.currentPhase = OVERHEAD_PHASE.LOWERING;
      this.localMinimumHeight = height;
    } else if (this.currentPhase === OVERHEAD_PHASE.PRESSING) {
      this.localMaximumHeight = this.localMaximumHeight === null ? height : Math.max(this.localMaximumHeight, height);
      this.recentHeights.push(height);
      if (this.recentHeights.length > PLATEAU_FRAMES) this.recentHeights.shift();
      const enoughMovement = this.maximumProgress - this.initialProgress >= MIN_PRESS_TRAVEL - EPSILON;
      const plateau = this.recentHeights.length === PLATEAU_FRAMES
        && Math.max(...this.recentHeights) - Math.min(...this.recentHeights)
          <= this.baselineScale * PLATEAU_HEIGHT_RATIO + EPSILON;
      if (enoughMovement && height <= this.localMaximumHeight - reversalHeight + EPSILON) {
        this.currentPhase = OVERHEAD_PHASE.LOWERING;
        this.localMinimumHeight = height;
      } else if (enoughMovement && plateau) {
        this.currentPhase = OVERHEAD_PHASE.TOP;
      }
    } else if (this.currentPhase === OVERHEAD_PHASE.TOP) {
      if (height >= this.localMaximumHeight + reversalHeight - EPSILON) {
        this.currentPhase = OVERHEAD_PHASE.PRESSING;
        this.localMaximumHeight = height;
        this.recentHeights = [height];
      } else if (height <= this.localMaximumHeight - reversalHeight + EPSILON) {
        this.currentPhase = OVERHEAD_PHASE.LOWERING;
        this.localMinimumHeight = height;
      }
    } else if (this.currentPhase === OVERHEAD_PHASE.LOWERING) {
      this.localMinimumHeight = Math.min(this.localMinimumHeight, height);
      if (!atStart && height >= this.localMinimumHeight + reversalHeight - EPSILON) {
        this.currentPhase = OVERHEAD_PHASE.PRESSING;
        this.localMaximumHeight = height;
        this.recentHeights = [height];
      }
    }

    const anArmReturned = ['left', 'right'].some((name) =>
      arms[name].angle <= this.peakAngles[name] - REVERSAL + EPSILON
      || this.baselineWrists[name] - arms[name].wrist.y <= this.peakRise[name] - reversalHeight + EPSILON);
    if (atStart && (this.reachedLockout || height <= this.maximumHeight - reversalHeight + EPSILON || anArmReturned)) {
      return this.finishPress(arms, torsos, view, facing);
    }
    return null;
  }

  update(landmarks) {
    const arms = {
      left: measureArm(landmarks, 'left', this.frameWidth, this.frameHeight),
      right: measureArm(landmarks, 'right', this.frameWidth, this.frameHeight)
    };
    // Для корректного сравнения обе руки должны измеряться в одинаковой
    // размерности: при недостатке Z у любой из них используем 2D для обеих.
    const dimension = arms.left && arms.right && arms.left.hasDepth && arms.right.hasDepth ? 3 : 2;
    if (arms.left && arms.right && dimension === 2) {
      for (const name of ['left', 'right']) {
        if (arms[name].planarAngle === null) arms[name] = null;
        else arms[name].angle = arms[name].planarAngle;
      }
    }
    if (!arms.left || !arms.right) {
      this.missingFrames += 1;
      if (this.missingFrames >= MAX_MISSING_FRAMES) this.resetTracking();
      return { repCount: this.repCount, currentPhase: this.currentPhase, currentErrors: [],
        feedbackMessage: 'Покажите плечи, локти и запястья обеих рук.' };
    }
    // Переход между 2D и 3D меняет значения углов: незавершённый жим
    // отменяется, чтобы не объединять несовместимые измерения.
    if (this.angleDimension !== null && this.angleDimension !== dimension) this.resetTracking();
    this.angleDimension = dimension;
    this.missingFrames = 0;
    const torsos = measureTorsos(arms);
    const torsoLength = torsos.length ? torsos.reduce((sum, torso) => sum + torso.length, 0) / torsos.length : null;
    const view = this.view === 'auto' ? inferView(arms, torsos) : this.view;
    const facing = this.facingDirection === 'auto'
      ? inferFacing(landmarks, torsoLength, this.frameWidth, this.frameHeight)
      : this.facingDirection === 'right' ? 1 : -1;
    const nose = framePoint(landmarks?.[0], this.frameWidth, this.frameHeight);
    const completed = this.advance(arms, torsos, view, facing, nose);
    const reference = completed ? completed.reference : this.reference;
    const active = [OVERHEAD_PHASE.PRESSING, OVERHEAD_PHASE.TOP,
      OVERHEAD_PHASE.LOCKOUT, OVERHEAD_PHASE.LOWERING].includes(this.currentPhase);
    const frameErrors = [];
    const angleDifference = Math.abs(arms.left.angle - arms.right.angle);
    const heightDifference = Math.abs(arms.left.wrist.y - arms.right.wrist.y);
    if (angleDifference > ASYMMETRY_ANGLE + EPSILON
        || (torsoLength !== null && heightDifference > torsoLength * WRIST_HEIGHT_RATIO + EPSILON)) {
      frameErrors.push(OVERHEAD_ERROR.ASYMMETRY);
    }

    const referenceTorso = reference?.torso;
    const currentTorso = referenceTorso ? torsos.find((torso) => torso.side === referenceTorso.side) : null;
    const backAvailable = view === 'side' && reference?.view === 'side' && referenceTorso && currentTorso
      && reference.facing !== null && facing === reference.facing;
    const lifting = this.currentPhase === OVERHEAD_PHASE.PRESSING || this.currentPhase === OVERHEAD_PHASE.LOCKOUT;
    if (lifting && backAvailable
        && (currentTorso.lean - referenceTorso.lean) * reference.facing < -BACK_LEAN_CHANGE - EPSILON) {
      frameErrors.push(OVERHEAD_ERROR.BACK_LEAN);
    }
    if (active) for (const error of frameErrors) this.repErrors.add(error);
    const currentErrors = [...new Set([...(completed ? completed.errors : this.repErrors), ...frameErrors])]
      .filter((error) => error !== OVERHEAD_ERROR.BACK_LEAN || backAvailable);
    const topAngle = completed ? completed.topAngle : this.topAngle;
    const reachedLockout = completed ? completed.reachedLockout : this.reachedLockout;
    const topKnown = completed ? completed.counted : this.currentPhase === OVERHEAD_PHASE.TOP
      || this.currentPhase === OVERHEAD_PHASE.LOWERING;
    if (topKnown && topAngle < INCOMPLETE_ANGLE - EPSILON) {
      currentErrors.push(OVERHEAD_ERROR.SHORT_PRESS);
    }

    const notes = [];
    if (completed?.counted) notes.push('Повтор засчитан.');
    for (const error of currentErrors) notes.push(feedbackForError(error));
    if (topKnown && !reachedLockout && topAngle >= INCOMPLETE_ANGLE - EPSILON) {
      notes.push(topAngle > LOCKOUT_ANGLE + EPSILON
        ? 'Поднимите кисти выше, над головой.' : 'Старайтесь полностью выпрямить руки над головой.');
    }
    if (!notes.length) {
      const labels = {
        WAITING: 'Согните руки до 60–80° и держите кисти у плеч или подбородка.',
        START: this.completedMessage || 'Поднимайте вес вверх обеими руками.',
        PRESSING: 'Выжимайте вес вверх подконтрольно.',
        TOP: 'Верхняя точка определена. Плавно опускайте вес.',
        LOCKOUT: 'Руки выпрямлены. Плавно опускайте вес.',
        LOWERING: 'Опускайте кисти к плечам и согните локти.'
      };
      notes.push(labels[this.currentPhase]);
    }
    if (torsoLength === null) {
      notes.push('Покажите таз: проверка высоты кистей недоступна.');
    }
    const observedAttempt = active || Boolean(completed);
    if (view === 'unknown') {
      notes.push('Ракурс не определён: для оценки корпуса расположите камеру сбоку.');
    } else if (view === 'front' && observedAttempt) {
      notes.push('Отклонение корпуса назад проверяется только при боковом ракурсе.');
    } else if (view === 'side' && observedAttempt && !backAvailable) {
      if (reference?.view !== 'side') {
        notes.push('Для оценки корпуса начните следующий жим в боковом ракурсе.');
      } else if (!referenceTorso || !currentTorso) {
        notes.push('Покажите плечо и таз в начале и во время жима для оценки корпуса.');
      } else if (reference.facing !== null && facing !== null && reference.facing !== facing) {
        notes.push('Направление изменилось: начните следующий жим лицом в ту же сторону.');
      } else {
        notes.push('Для оценки отклонения назад покажите лицо в начале и во время жима либо задайте направление.');
      }
    }
    return { repCount: this.repCount, currentPhase: this.currentPhase, currentErrors, feedbackMessage: notes.join(' ') };
  }
}
