import { findAngle } from './geometry.js';

// Это оценка 2D-проекции, а не измерение положения перекладины или подбородка.
export const PULLUP_PHASE = Object.freeze({
  WAITING: 'WAITING',
  HANG: 'HANG',
  PULLING: 'PULLING',
  TOP: 'TOP',
  TURNAROUND: 'TURNAROUND',
  LOWERING: 'LOWERING'
});

export const PULLUP_ERROR = Object.freeze({
  SHORT_BOTTOM: 'Неполная амплитуда снизу',
  SHORT_TOP: 'Недотяг сверху',
  ASYMMETRY: 'Асимметрия тяги'
});

const SIDES = {
  left: { shoulder: 11, elbow: 13, wrist: 15 },
  right: { shoulder: 12, elbow: 14, wrist: 16 }
};
const MIN_CONFIDENCE = 0.5;
const HANG_ANGLE = 160;
const SHORT_BOTTOM_ANGLE = 145;
const MIN_FRONT_SPAN_RATIO = 0.35;
const START_RISE_RATIO = 0.05;
const BASELINE_BAND_RATIO = 0.01;
const MIN_RISE_RATIO = 0.15;
const MIN_ELBOW_TRAVEL = 10;
const REVERSAL_RATIO = 0.06;
const RETURN_RATIO = 0.08;
const SETTLE_RATIO = 0.015;
const PLATEAU_FRAMES = 6;
const PLATEAU_RANGE_RATIO = 0.025;
const SPEED_WINDOW_MS = 200;
const MAX_SPEED_WINDOW_MS = 1000;
const ASYMMETRY_SPEED_RATIO = 0.8;
const EPSILON = 1e-6;

// Нормированные X и Y выражены в разных масштабах: перед измерением углов
// переводим их в пиксели исходного видео. Глубину Z намеренно не используем.
function framePoint(point, width, height) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  for (const value of [point.visibility, point.presence]) {
    if (value !== undefined && (!Number.isFinite(value) || value < MIN_CONFIDENCE)) return null;
  }
  return { x: point.x * width, y: point.y * height };
}

function measurePose(landmarks, width, height) {
  const arms = {};
  for (const [side, indices] of Object.entries(SIDES)) {
    const shoulder = framePoint(landmarks?.[indices.shoulder], width, height);
    const elbow = framePoint(landmarks?.[indices.elbow], width, height);
    const wrist = framePoint(landmarks?.[indices.wrist], width, height);
    if (!shoulder || !elbow || !wrist) {
      return { error: 'Покажите плечи, локти и запястья обеих рук.' };
    }
    const angle = findAngle(shoulder, elbow, wrist);
    const upperLength = Math.hypot(shoulder.x - elbow.x, shoulder.y - elbow.y);
    if (angle === null || upperLength <= EPSILON) {
      return { error: 'Не удаётся измерить руки: покажите суставы раздельно.' };
    }
    arms[side] = { shoulder, elbow, wrist, angle, upperLength };
  }

  const shoulderWidth = Math.abs(arms.left.shoulder.x - arms.right.shoulder.x);
  const upperLength = (arms.left.upperLength + arms.right.upperLength) / 2;
  if (shoulderWidth <= EPSILON || shoulderWidth < upperLength * MIN_FRONT_SPAN_RATIO - EPSILON) {
    return { error: 'Покажите оба плеча спереди или сзади; узкий боковой ракурс не подходит.' };
  }

  // Горизонтальная перекладина предполагается, но не обнаруживается моделью.
  const wristY = (arms.left.wrist.y + arms.right.wrist.y) / 2;
  const leftHeight = wristY - arms.left.shoulder.y;
  const rightHeight = wristY - arms.right.shoulder.y;
  const hang = Object.values(arms).every((arm) => arm.angle > HANG_ANGLE + EPSILON
    && arm.wrist.y < arm.shoulder.y - EPSILON);
  return {
    arms, shoulderWidth, wristY, leftHeight, rightHeight,
    height: (leftHeight + rightHeight) / 2,
    angles: { left: arms.left.angle, right: arms.right.angle },
    hang
  };
}

function externalChin(options, height) {
  if (options === undefined || options === null) return null;
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Третий аргумент update должен быть объектом с chinY.');
  }
  const { chinY } = options;
  if (chinY === undefined || chinY === null) return null;
  if (!Number.isFinite(chinY) || chinY < 0 || chinY > 1) {
    throw new RangeError('chinY должен быть нормированной координатой от 0 до 1.');
  }
  return chinY * height;
}

// Источник фиксируется на время попытки: переключение с рта на нос, например,
// изменило бы высоту ориентира и могло бы создать ложный TOP.
function readHead(landmarks, width, height, chinY, requiredSource = null) {
  if ((!requiredSource || requiredSource === 'external') && chinY !== null) {
    return { source: 'external', kind: 'external', y: chinY };
  }
  if (requiredSource === 'external') return null;
  if (!requiredSource || requiredSource === 'mouth') {
    const mouth = [9, 10].map((index) => framePoint(landmarks?.[index], width, height)).filter(Boolean);
    if (mouth.length) {
      return { source: 'mouth', kind: mouth.length === 2 ? 'mouth' : 'mouth-single',
        y: mouth.reduce((sum, point) => sum + point.y, 0) / mouth.length };
    }
  }
  if (requiredSource === 'mouth') return null;
  if (!requiredSource || requiredSource === 'nose') {
    const nose = framePoint(landmarks?.[0], width, height);
    if (nose) return { source: 'nose', kind: 'nose', y: nose.y };
  }
  return null;
}

function errorMessage(error) {
  if (error === PULLUP_ERROR.SHORT_BOTTOM) return 'Опускайтесь до полного виса.';
  if (error === PULLUP_ERROR.SHORT_TOP) return 'Тянитесь выше, подбородок над турником.';
  if (error === PULLUP_ERROR.ASYMMETRY) return 'Тяните равномерно обеими руками.';
  return '';
}

function hasEnoughMovement(attempt) {
  const rise = attempt.maxHeight - attempt.startHeight;
  const elbowTravel = Math.min(...['left', 'right'].map((side) =>
    attempt.startAngles[side] - attempt.minAngles[side]));
  return rise >= attempt.scale * MIN_RISE_RATIO - EPSILON
    && elbowTravel >= MIN_ELBOW_TRAVEL - EPSILON;
}

function referenceNote(reference) {
  if (reference === 'external') return 'Координата подбородка передана извне; её точность не проверяется.';
  if (reference === 'mouth') return 'Положение подбородка приблизительно оценивается по точкам рта.';
  if (reference === 'mouth-single') return 'Положение подбородка приблизительно оценивается по одной точке рта.';
  if (reference === 'nose') return 'Верх оценивается по носу: положение подбородка не подтверждено.';
  return '';
}

// На границе двух попыток показываем итог прежней и сохраняем статус нового
// кадра; повторяющиеся предупреждения и пояснения не дублируются.
function combineResults(previous, current) {
  if (!previous) return current;
  const newErrors = current.currentErrors.filter((error) => !previous.currentErrors.includes(error));
  const notes = [previous.feedbackMessage, 'Начинается следующий подъём.', ...newErrors.map(errorMessage)];
  if (current.currentPhase === PULLUP_PHASE.TOP) notes.push('Ориентир головы выше уровня кистей.');
  if (current.headReference !== previous.headReference) notes.push(referenceNote(current.headReference));
  return { ...current, currentErrors: [...new Set([...previous.currentErrors, ...current.currentErrors])],
    feedbackMessage: notes.filter(Boolean).join(' ') };
}

export class PullUpAnalyzer {
  constructor({ videoWidth = 1, videoHeight = 1, maxFrameGapMs = 1000 } = {}) {
    if (!Number.isFinite(maxFrameGapMs) || maxFrameGapMs <= 0) {
      throw new TypeError('maxFrameGapMs должен быть положительным числом миллисекунд.');
    }
    this.repCount = 0;
    this.frameWidth = 1;
    this.frameHeight = 1;
    this.maxFrameGapMs = maxFrameGapMs;
    this.resetTracking();
    this.setFrameSize(videoWidth, videoHeight);
  }

  setFrameSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new TypeError('Размеры видеокадра должны быть положительными числами.');
    }
    // Эталон хранится в пикселях; сбрасываем его при любом изменении размеров.
    if (this.frameWidth !== width || this.frameHeight !== height) this.resetTracking();
    this.frameWidth = width;
    this.frameHeight = height;
  }

  // Отменяет только незавершённую попытку. После сброса допускается новый
  // источник монотонных временных отметок; счётчик сохраняется.
  resetTracking() {
    this.currentPhase = PULLUP_PHASE.WAITING;
    this.candidate = null;
    this.attempt = null;
    this.lastTimestampMs = null;
  }

  reset() {
    this.repCount = 0;
    this.resetTracking();
  }

  result(errors, notes, reference = 'unavailable') {
    return {
      repCount: this.repCount,
      currentPhase: this.currentPhase,
      currentErrors: [...new Set(errors)],
      feedbackMessage: [...notes, referenceNote(reference),
        'Уровень перекладины приблизительно оценивается по кистям.'].filter(Boolean).join(' '),
      headReference: reference,
      barReference: 'wrists'
    };
  }

  captureCandidate(pose, head, timestampMs, fresh = false) {
    const previous = this.candidate;
    if (fresh || !previous || pose.height < previous.height - EPSILON) {
      this.candidate = {
        height: pose.height, scale: pose.shoulderWidth, angles: { ...pose.angles },
        hang: pose.hang, source: head.source, reference: head.kind,
        sample: { timestampMs, left: pose.leftHeight, right: pose.rightHeight }
      };
    } else if (pose.height <= previous.height + previous.scale * BASELINE_BAND_RATIO + EPSILON) {
      // Углы берём в последнем наблюдаемом нижнем положении: когда человек
      // согнул локти до старта, давний полный вис не должен считаться стартом.
      previous.angles = { ...pose.angles };
      previous.hang = pose.hang;
      previous.source = head.source;
      previous.reference = head.kind;
      previous.sample = { timestampMs, left: pose.leftHeight, right: pose.rightHeight };
    }
    this.currentPhase = pose.hang ? PULLUP_PHASE.HANG : PULLUP_PHASE.WAITING;
  }

  startAttempt() {
    const base = this.candidate;
    const errors = new Set();
    if (Object.values(base.angles).some((angle) => angle < SHORT_BOTTOM_ANGLE - EPSILON)) {
      errors.add(PULLUP_ERROR.SHORT_BOTTOM);
    }
    this.attempt = {
      startHang: base.hang, startAngles: { ...base.angles }, startHeight: base.height,
      scale: base.scale, source: base.source, usedSingleMouth: base.reference === 'mouth-single',
      maxHeight: base.height, minAngles: { ...base.angles },
      reachedTop: false, motion: 'up', localMaximum: base.height, localMinimum: null,
      bottom: null, plateauHeight: null, peakConfirmed: false, recentHeights: [],
      speedSamples: [base.sample], errors
    };
    this.currentPhase = PULLUP_PHASE.PULLING;
  }

  recordSpeed(pose, timestampMs) {
    const attempt = this.attempt;
    const samples = attempt.speedSamples;
    samples.push({ timestampMs, left: pose.leftHeight, right: pose.rightHeight });
    const cutoff = timestampMs - SPEED_WINDOW_MS;
    // Сохраняем последний образец не позднее начала окна, чтобы ширина окна
    // была не меньше 200 мс независимо от частоты кадров.
    while (samples.length > 1 && samples[1].timestampMs <= cutoff) samples.shift();
    const first = samples[0];
    const elapsed = timestampMs - first.timestampMs;
    if (elapsed < SPEED_WINDOW_MS || elapsed > MAX_SPEED_WINDOW_MS) return;
    const seconds = elapsed / 1000;
    const leftSpeed = (pose.leftHeight - first.left) / (attempt.scale * seconds);
    const rightSpeed = (pose.rightHeight - first.right) / (attempt.scale * seconds);
    if (attempt.motion === 'up' && Math.max(leftSpeed, rightSpeed) > EPSILON
        && Math.abs(leftSpeed - rightSpeed) > ASYMMETRY_SPEED_RATIO + EPSILON) {
      attempt.errors.add(PULLUP_ERROR.ASYMMETRY);
    }
  }

  finishAttempt(pose, head, timestampMs, enoughMovement, candidateTimestampMs = timestampMs) {
    const attempt = this.attempt;
    const errors = [...attempt.errors];
    if (enoughMovement && attempt.peakConfirmed && !attempt.reachedTop) errors.push(PULLUP_ERROR.SHORT_TOP);
    const counted = enoughMovement && attempt.peakConfirmed && attempt.startHang
      && attempt.reachedTop && pose.hang;
    if (counted) this.repCount += 1;

    const notes = [counted ? 'Повтор засчитан.' : 'Повтор не засчитан.'];
    for (const error of errors) notes.push(errorMessage(error));
    if (!attempt.startHang && !errors.includes(PULLUP_ERROR.SHORT_BOTTOM)) {
      notes.push('В начале не был подтверждён полный вис: оба локтя должны быть больше 160°.');
    }
    if (!pose.hang) notes.push('В конце вернитесь в полный вис: оба локтя должны быть больше 160°.');
    if (!enoughMovement) notes.push('Движение слишком мало для подтверждения подтягивания.');
    const resultReference = attempt.usedSingleMouth ? 'mouth-single' : head.kind;

    this.resetTracking();
    this.lastTimestampMs = timestampMs;
    this.captureCandidate(pose, head, candidateTimestampMs, true);
    return this.result(errors, notes, resultReference);
  }

  // timestampMs — монотонные миллисекунды одного источника. chinY —
  // опциональная нормированная Y-координата от внешнего детектора.
  update(landmarks, timestampMs, options) {
    const chinY = externalChin(options, this.frameHeight);
    const explicitTimestamp = timestampMs !== undefined;
    if (!explicitTimestamp) {
      timestampMs = performance.now();
      if (this.lastTimestampMs !== null) timestampMs = Math.max(timestampMs, this.lastTimestampMs + 0.001);
    }
    if (!Number.isFinite(timestampMs) || timestampMs < 0
        || (this.lastTimestampMs !== null && timestampMs <= this.lastTimestampMs)) {
      throw new RangeError('Время кадра должно быть неотрицательным и строго возрастающим.');
    }
    if (this.lastTimestampMs !== null && timestampMs - this.lastTimestampMs > this.maxFrameGapMs) {
      this.resetTracking();
    }
    this.lastTimestampMs = timestampMs;

    const pose = measurePose(landmarks, this.frameWidth, this.frameHeight);
    if (pose.error) {
      this.resetTracking();
      return this.result([], [pose.error]);
    }
    const requiredSource = this.attempt?.source ?? null;
    let head = readHead(landmarks, this.frameWidth, this.frameHeight, chinY, requiredSource);
    if (!head) {
      this.resetTracking();
      return this.result([], [requiredSource
        ? 'Потерян исходный ориентир головы; незавершённая попытка отменена. Покажите рот или нос либо передайте chinY.'
        : 'Покажите рот или нос либо передайте координату подбородка chinY от внешнего детектора.']);
    }

    if (!this.attempt) {
      const startRise = this.candidate && pose.height - this.candidate.height
        >= this.candidate.scale * START_RISE_RATIO - EPSILON;
      // Начало уже в TOP не подтверждает подъём. Если нижняя позиция была
      // замечена ранее и подъём достаточен, текущий кадр может сразу быть TOP.
      if (!startRise && head.y < pose.wristY - EPSILON) {
        this.candidate = null;
        this.currentPhase = pose.hang ? PULLUP_PHASE.HANG : PULLUP_PHASE.WAITING;
        return this.result([], ['Начните ниже уровня кистей и опуститесь в полный вис.'], head.kind);
      }
      if (!startRise) {
        this.captureCandidate(pose, head, timestampMs);
        return this.result([], [pose.hang ? 'Фаза HANG по положению рук определена. Подтягивайтесь подконтрольно.'
          : 'Для полного повтора начните с виса: оба локтя больше 160°.'], head.kind);
      }
      this.startAttempt();
      // В текущем кадре источник может уже отличаться от исходного.
      head = readHead(landmarks, this.frameWidth, this.frameHeight, chinY, this.attempt.source);
      if (!head) {
        this.resetTracking();
        return this.result([], ['Ориентир головы изменился в начале движения; попытка отменена.']);
      }
    }

    let attempt = this.attempt;
    let reversal = attempt.scale * REVERSAL_RATIO;
    let previousResult = null;
    // Если из неполного нижнего положения начался новый подъём, сначала
    // завершаем прежнюю попытку без зачёта. Текущий кадр относится к новой
    // попытке и не может задним числом подтвердить верх предыдущей.
    if (attempt.motion === 'down' && attempt.bottom && !pose.hang
        && attempt.localMinimum <= attempt.startHeight + attempt.scale * RETURN_RATIO + EPSILON
        && pose.height >= attempt.localMinimum + reversal - EPSILON) {
      previousResult = this.finishAttempt(attempt.bottom.pose, attempt.bottom.head, timestampMs,
        hasEnoughMovement(attempt), attempt.bottom.timestampMs);
      this.startAttempt();
      attempt = this.attempt;
      reversal = attempt.scale * REVERSAL_RATIO;
    }
    attempt.usedSingleMouth ||= head.kind === 'mouth-single';
    attempt.maxHeight = Math.max(attempt.maxHeight, pose.height);
    for (const side of ['left', 'right']) {
      attempt.minAngles[side] = Math.min(attempt.minAngles[side], pose.angles[side]);
    }
    if (head.y < pose.wristY - EPSILON) attempt.reachedTop = true;
    const enoughMovement = hasEnoughMovement(attempt);
    attempt.recentHeights.push(pose.height);
    if (attempt.recentHeights.length > PLATEAU_FRAMES) attempt.recentHeights.shift();
    const plateau = attempt.recentHeights.length === PLATEAU_FRAMES
      && Math.max(...attempt.recentHeights) - Math.min(...attempt.recentHeights)
        <= attempt.scale * PLATEAU_RANGE_RATIO + EPSILON;

    if (attempt.motion === 'up') {
      attempt.localMaximum = Math.max(attempt.localMaximum, pose.height);
      if (pose.height <= attempt.localMaximum - reversal + EPSILON) {
        attempt.motion = 'down';
        attempt.localMinimum = pose.height;
        attempt.bottom = { pose, head, timestampMs };
        attempt.peakConfirmed = true;
      } else if (enoughMovement && plateau) {
        attempt.motion = 'plateau';
        attempt.plateauHeight = attempt.localMaximum;
        attempt.peakConfirmed = true;
      }
    } else if (attempt.motion === 'plateau') {
      if (pose.height <= attempt.plateauHeight - reversal + EPSILON) {
        attempt.motion = 'down';
        attempt.localMinimum = pose.height;
        attempt.bottom = { pose, head, timestampMs };
      } else if (pose.height >= attempt.plateauHeight + reversal - EPSILON) {
        attempt.motion = 'up';
        attempt.localMaximum = pose.height;
        attempt.peakConfirmed = false;
        attempt.recentHeights = [pose.height];
      }
    } else {
      if (pose.height < attempt.localMinimum - EPSILON) {
        attempt.localMinimum = pose.height;
        attempt.bottom = { pose, head, timestampMs };
      } else if (pose.height <= attempt.localMinimum + attempt.scale * BASELINE_BAND_RATIO + EPSILON) {
        attempt.bottom = { pose, head, timestampMs };
      }
      if (!pose.hang && pose.height >= attempt.localMinimum + reversal - EPSILON) {
        attempt.motion = 'up';
        attempt.localMaximum = pose.height;
        attempt.peakConfirmed = false;
        attempt.recentHeights = [pose.height];
      }
    }

    this.recordSpeed(pose, timestampMs);
    this.currentPhase = head.y < pose.wristY - EPSILON ? PULLUP_PHASE.TOP
      : attempt.motion === 'down' ? PULLUP_PHASE.LOWERING
        : attempt.motion === 'plateau' ? PULLUP_PHASE.TURNAROUND : PULLUP_PHASE.PULLING;
    const errors = [...attempt.errors];
    if (enoughMovement && attempt.peakConfirmed && !attempt.reachedTop) errors.push(PULLUP_ERROR.SHORT_TOP);

    const hasDescended = attempt.maxHeight - pose.height >= reversal - EPSILON;
    if (hasDescended && pose.hang) {
      return combineResults(previousResult, this.finishAttempt(pose, head, timestampMs, enoughMovement));
    }
    // Начальное шевеление может быть меньше порога разворота. Не оставляем
    // автомат в PULLING, если человек уже вернулся к исходной высоте.
    if (!enoughMovement && pose.height <= attempt.startHeight + attempt.scale * SETTLE_RATIO + EPSILON) {
      this.resetTracking();
      this.lastTimestampMs = timestampMs;
      this.captureCandidate(pose, head, timestampMs, true);
      return combineResults(previousResult,
        this.result([], ['Движение слишком мало для подтверждения подтягивания.'], head.kind));
    }

    const notes = errors.map(errorMessage);
    if (attempt.motion === 'down' && pose.height <= attempt.startHeight + attempt.scale * RETURN_RATIO + EPSILON
        && !pose.hang) {
      notes.push('В конце вернитесь в полный вис: оба локтя должны быть больше 160°.');
    }
    if (!notes.length) {
      const labels = {
        PULLING: 'Подтягивайтесь вверх подконтрольно.',
        TOP: 'Ориентир головы выше уровня кистей. Плавно опускайтесь.',
        TURNAROUND: 'Верхняя точка определена. Плавно опускайтесь.',
        LOWERING: 'Опускайтесь до полного виса.'
      };
      notes.push(labels[this.currentPhase]);
    }
    return combineResults(previousResult,
      this.result(errors, notes, attempt.usedSingleMouth ? 'mouth-single' : head.kind));
  }
}
