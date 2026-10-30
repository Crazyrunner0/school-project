import { findAngle } from './geometry.js';

// Боковая 2D-проекция не измеряет изгиб позвоночника и не подтверждает
// безопасность упражнения. Ухо позволяет оценить только положение головы.
export const DEADLIFT_PHASE = Object.freeze({
  WAITING: 'WAITING',
  START: 'START',
  HINGING: 'HINGING',
  BOTTOM: 'BOTTOM',
  RISING: 'RISING'
});

export const DEADLIFT_ERROR = Object.freeze({
  KNEE_BEND: 'Чрезмерное сгибание колена',
  KNEE_RANGE: 'Колено вне заданного диапазона',
  KNEE_MOVEMENT: 'Изменение угла колена',
  HIP_INITIATION: 'Начало движения с таза не подтверждено',
  HEAD_POSITION: 'Изменение положения головы',
  SHALLOW: 'Заданный ориентир наклона не достигнут',
  DEEP: 'Наклон выше заданного ориентира'
});

const SIDES = {
  left: { ear: 7, shoulder: 11, hip: 23, knee: 25, ankle: 27 },
  right: { ear: 8, shoulder: 12, hip: 24, knee: 26, ankle: 28 }
};
const MIN_CONFIDENCE = 0.5;
const START_KNEE_MIN = 150;
const START_KNEE_MAX = 165;
const KNEE_BEND_LIMIT = 130;
const MAX_KNEE_CHANGE = 5;
const START_TORSO_MIN = -10;
const START_TORSO_MAX = 20;
const TARGET_TORSO_MIN = 60;
const TARGET_TORSO_MAX = 80;
const MAX_HEAD_CHANGE = 20;
const HIP_START_RATIO = 0.04;
const HIP_RETURN_RATIO = 0.04;
const HIP_REVERSAL_RATIO = 0.02;
const MOTION_TRIGGER = 5;
const MIN_TORSO_TRAVEL = 10;
const REVERSAL = 3;
const PLATEAU_FRAMES = 6;
const PLATEAU_RANGE = 1.5;
const EPSILON = 1e-6;
const DEGREES = 180 / Math.PI;
const SPINE_NOTE = 'Округление позвоночника по этим точкам не определяется.';

// X и Y нормированы по разным размерам кадра. Z не используется: все
// проверки выполняются в приближённой сагиттальной проекции сбоку.
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

function measureSide(landmarks, name, width, height) {
  const get = (key) => framePoint(landmarks?.[SIDES[name][key]], width, height);
  const shoulder = get('shoulder');
  const hip = get('hip');
  const knee = get('knee');
  const ankle = get('ankle');
  if (!hip || !knee || !ankle) return null;
  const kneeAngle = findAngle(hip, knee, ankle);
  const torsoLength = shoulder ? distance(shoulder, hip) : 0;
  const legLength = distance(hip, knee) + distance(knee, ankle);
  if (kneeAngle === null || legLength <= EPSILON) return null;
  let ear = get('ear');
  if (!shoulder || torsoLength <= EPSILON || (ear && distance(ear, shoulder) < torsoLength * 0.03)) ear = null;
  return {
    name, shoulder, hip, knee, ankle, ear, kneeAngle, torsoLength, legLength,
    confidence: Math.min(shoulder?.confidence ?? 1, hip.confidence, knee.confidence, ankle.confidence,
      ear?.confidence ?? 1)
  };
}

// При видимости обеих сторон отбраковываем явно неподходящий ракурс. Если
// дальняя сторона закрыта, строгий профиль остаётся условием съёмки, а не фактом.
function looksNonSide(landmarks, pose, width, height) {
  const spans = [];
  for (const key of ['shoulder', 'hip']) {
    const a = framePoint(landmarks?.[SIDES.left[key]], width, height);
    const b = framePoint(landmarks?.[SIDES.right[key]], width, height);
    if (a && b) spans.push(distance(a, b));
  }
  if (!spans.length) return false;
  const ratio = spans.reduce((sum, span) => sum + span, 0) / spans.length / pose.torsoLength;
  return ratio > (spans.length === 2 ? 0.35 : 0.45) + EPSILON;
}

// Одного уха и носа недостаточно для надёжного направления: при одном ухе
// дополнительно нужен противоположный глаз; при двух — нос по одну сторону.
function inferFacing(landmarks, torsoLength, width, height) {
  const point = (index) => framePoint(landmarks?.[index], width, height);
  const nose = point(0);
  const ears = [7, 8].map((index) => ({ index, point: point(index) })).filter((item) => item.point);
  if (!nose || !ears.length) return null;
  const offsets = ears.map((item) => nose.x - item.point.x);
  if (offsets.some((offset) => Math.abs(offset) < torsoLength * 0.04)) return null;
  const direction = Math.sign(offsets[0]);
  if (!offsets.every((offset) => Math.sign(offset) === direction)) return null;
  if (ears.length === 1) {
    const oppositeEye = point(ears[0].index === 7 ? 5 : 2);
    if (!oppositeEye) return null;
    const offset = nose.x - oppositeEye.x;
    if (Math.abs(offset) < torsoLength * 0.015 || Math.sign(offset) !== direction) return null;
  }
  return direction;
}

function torsoAngle(pose, facing) {
  return Math.atan2((pose.shoulder.x - pose.hip.x) * facing, pose.hip.y - pose.shoulder.y) * DEGREES;
}

// Это угол головы относительно линии таз–плечо, не угол изгиба спины.
function headAngle(pose) {
  if (!pose.ear) return null;
  const tx = pose.shoulder.x - pose.hip.x;
  const ty = pose.shoulder.y - pose.hip.y;
  const hx = pose.ear.x - pose.shoulder.x;
  const hy = pose.ear.y - pose.shoulder.y;
  return Math.atan2(tx * hy - ty * hx, tx * hx + ty * hy) * DEGREES;
}

function angleDifference(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function isStartPose(kneeAngle, lean) {
  return kneeAngle >= START_KNEE_MIN - EPSILON && kneeAngle <= START_KNEE_MAX + EPSILON
    && lean >= START_TORSO_MIN - EPSILON && lean <= START_TORSO_MAX + EPSILON;
}

function errorMessage(error) {
  if (error === DEADLIFT_ERROR.KNEE_BEND) return 'Не сгибайте колени так сильно, отводите таз назад.';
  if (error === DEADLIFT_ERROR.KNEE_RANGE) return 'Угол колена вне заданного диапазона 150–165°.';
  if (error === DEADLIFT_ERROR.KNEE_MOVEMENT) return 'Старайтесь сохранять угол колена почти неизменным.';
  if (error === DEADLIFT_ERROR.HIP_INITIATION) return 'Начинайте движение с отведения таза назад; порядок начала не подтверждён.';
  if (error === DEADLIFT_ERROR.HEAD_POSITION) return 'Положение головы изменилось относительно корпуса; проверьте его.';
  if (error === DEADLIFT_ERROR.SHALLOW) {
    return 'Наклон меньше заданного ориентира 60°; используйте доступную амплитуду без боли.';
  }
  if (error === DEADLIFT_ERROR.DEEP) return 'Наклон корпуса превысил заданный ориентир 80°.';
  return '';
}

export class DeadliftAnalyzer {
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
    if (!['auto', 'left', 'right'].includes(side)) throw new TypeError('Сторона должна быть auto, left или right.');
    if (side !== this.side) {
      this.side = side;
      this.resetTracking();
    }
  }

  // Направление задаётся в исходном кадре MediaPipe, а не в зеркальном preview.
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

  // Прерывает незавершённый повтор, сохраняя уже засчитанные.
  resetTracking() {
    this.currentPhase = DEADLIFT_PHASE.WAITING;
    this.activeSide = null;
    this.reference = null;
    this.hipInitiation = 'unavailable';
    this.hipObserved = false;
    this.peakHipBack = null;
    this.peakLean = null;
    this.localMinimum = null;
    this.recentLeans = [];
    this.repErrors = new Set();
  }

  reset() {
    this.repCount = 0;
    this.resetTracking();
  }

  result(errors, notes, initiation = this.hipInitiation) {
    return {
      repCount: this.repCount,
      currentPhase: this.currentPhase,
      currentErrors: [...new Set(errors)],
      feedbackMessage: [...notes, SPINE_NOTE].filter(Boolean).join(' '),
      spineAssessment: 'unavailable',
      hipInitiation: initiation
    };
  }

  captureStart(pose, facing, lean, head) {
    this.currentPhase = DEADLIFT_PHASE.START;
    this.activeSide = pose.name;
    this.reference = {
      facing, knee: pose.kneeAngle, lean, head,
      hipRelativeToAnkle: (pose.hip.x - pose.ankle.x) * facing,
      legLength: pose.legLength
    };
    this.hipInitiation = 'pending';
    this.hipObserved = false;
    this.peakHipBack = null;
    this.peakLean = null;
    this.localMinimum = null;
    this.recentLeans = [];
    this.repErrors = new Set();
  }

  finishAttempt(pose, facing, lean, head, frameErrors) {
    const reference = this.reference;
    const counted = this.hipObserved && this.peakLean - reference.lean >= MIN_TORSO_TRAVEL - EPSILON;
    const errors = new Set([...this.repErrors, ...frameErrors]);
    if (counted && this.peakLean < TARGET_TORSO_MIN - EPSILON) errors.add(DEADLIFT_ERROR.SHALLOW);
    if (counted && this.peakLean > TARGET_TORSO_MAX + EPSILON) errors.add(DEADLIFT_ERROR.DEEP);
    const initiation = this.hipInitiation;
    if (counted) this.repCount += 1;
    this.resetTracking();
    if (isStartPose(pose.kneeAngle, lean)) this.captureStart(pose, facing, lean, head);
    return { counted, errors: [...errors], initiation };
  }

  update(landmarks) {
    const candidates = ['left', 'right']
      .filter((side) => this.side === 'auto' || side === this.side)
      .map((side) => measureSide(landmarks, side, this.frameWidth, this.frameHeight)).filter(Boolean);
    let pose;
    if (this.currentPhase !== DEADLIFT_PHASE.WAITING && this.activeSide) {
      pose = candidates.find((candidate) => candidate.name === this.activeSide);
    } else {
      candidates.sort((a, b) => Number(b.torsoLength > EPSILON) - Number(a.torsoLength > EPSILON)
        || Number(Boolean(b.ear)) - Number(Boolean(a.ear)) || b.confidence - a.confidence);
      pose = candidates[0];
    }
    if (!pose) {
      this.resetTracking();
      return this.result([], ['Покажите сбоку плечо, таз, колено и лодыжку одной стороны.']);
    }
    const kneeErrors = pose.kneeAngle < KNEE_BEND_LIMIT - EPSILON ? [DEADLIFT_ERROR.KNEE_BEND] : [];
    if (!pose.shoulder || pose.torsoLength <= EPSILON) {
      this.resetTracking();
      return this.result(kneeErrors, [...kneeErrors.map(errorMessage),
        'Покажите сбоку плечо выбранной стороны: незавершённый повтор отменён.']);
    }
    if (looksNonSide(landmarks, pose, this.frameWidth, this.frameHeight)) {
      this.resetTracking();
      return this.result([], ['Ракурс не похож на боковой: расположите камеру строго сбоку.']);
    }

    const facing = this.facingDirection === 'auto'
      ? inferFacing(landmarks, pose.torsoLength, this.frameWidth, this.frameHeight)
      : this.facingDirection === 'right' ? 1 : -1;
    const head = headAngle(pose);
    if (head === null || facing === null || (this.reference && facing !== this.reference.facing)) {
      const issue = head === null ? 'Покажите ухо выбранной стороны: незавершённый повтор отменён.'
        : facing === null ? 'Покажите лицо сбоку или задайте направление: незавершённый повтор отменён.'
          : 'Направление тела изменилось: незавершённый повтор отменён.';
      this.resetTracking();
      return this.result(kneeErrors, [...kneeErrors.map(errorMessage), issue]);
    }

    const lean = torsoAngle(pose, facing);
    if (this.currentPhase === DEADLIFT_PHASE.WAITING) {
      if (isStartPose(pose.kneeAngle, lean)) this.captureStart(pose, facing, lean, head);
      const notes = kneeErrors.map(errorMessage);
      if (!notes.length) notes.push(this.reference
        ? 'Отведите таз назад, сохраняя комфортный сгиб коленей.'
        : 'Примите исходную стойку: корпус почти вертикален, колено примерно 150–165°.');
      return this.result(kneeErrors, notes);
    }

    const reference = this.reference;
    const hipBack = reference.hipRelativeToAnkle - (pose.hip.x - pose.ankle.x) * facing;
    const hipThreshold = reference.legLength * HIP_START_RATIO;
    const leanChange = lean - reference.lean;
    const kneeBend = reference.knee - pose.kneeAngle;
    const frameErrors = [...kneeErrors];
    if (!kneeErrors.length && (pose.kneeAngle < START_KNEE_MIN - EPSILON
        || pose.kneeAngle > START_KNEE_MAX + EPSILON)) frameErrors.push(DEADLIFT_ERROR.KNEE_RANGE);
    if (Math.abs(pose.kneeAngle - reference.knee) > MAX_KNEE_CHANGE + EPSILON) {
      frameErrors.push(DEADLIFT_ERROR.KNEE_MOVEMENT);
    }
    if (angleDifference(head, reference.head) > MAX_HEAD_CHANGE + EPSILON) {
      frameErrors.push(DEADLIFT_ERROR.HEAD_POSITION);
    }
    if (lean > TARGET_TORSO_MAX + EPSILON) frameErrors.push(DEADLIFT_ERROR.DEEP);

    // Порядок виден лишь с точностью частоты кадров и порогов. Если таз и
    // наклон/колено пересекли пороги в одном кадре, начало остаётся неясным.
    if (!this.hipObserved) {
      const hipMoved = hipBack >= hipThreshold - EPSILON;
      const otherMoved = kneeBend > MAX_KNEE_CHANGE + EPSILON || leanChange > MOTION_TRIGGER + EPSILON;
      if (otherMoved && !hipMoved) this.hipInitiation = 'uncertain';
      else if (hipMoved) {
        if (this.hipInitiation !== 'uncertain') this.hipInitiation = otherMoved ? 'uncertain' : 'observed';
        this.hipObserved = true;
      } else if (this.currentPhase === DEADLIFT_PHASE.START) {
        this.hipInitiation = 'pending';
      }
    }
    if (this.hipInitiation === 'uncertain') frameErrors.push(DEADLIFT_ERROR.HIP_INITIATION);

    if (this.currentPhase === DEADLIFT_PHASE.START
        && (this.hipObserved || leanChange > MOTION_TRIGGER + EPSILON)) {
      this.currentPhase = DEADLIFT_PHASE.HINGING;
      this.peakLean = lean;
      this.localMinimum = null;
      this.recentLeans = [];
      this.repErrors = new Set();
    }

    let completed = null;
    if (this.currentPhase !== DEADLIFT_PHASE.START) {
      for (const error of frameErrors) this.repErrors.add(error);
      this.peakHipBack = this.peakHipBack === null ? hipBack : Math.max(this.peakHipBack, hipBack);
      this.peakLean = Math.max(this.peakLean, lean);
      if (this.currentPhase === DEADLIFT_PHASE.HINGING) {
        this.recentLeans.push(lean);
        if (this.recentLeans.length > PLATEAU_FRAMES) this.recentLeans.shift();
        const enoughMovement = this.peakLean - reference.lean >= MIN_TORSO_TRAVEL - EPSILON;
        const plateau = this.recentLeans.length === PLATEAU_FRAMES
          && Math.max(...this.recentLeans) - Math.min(...this.recentLeans) <= PLATEAU_RANGE + EPSILON;
        if (this.peakLean - lean >= REVERSAL - EPSILON) {
          this.currentPhase = DEADLIFT_PHASE.RISING;
          this.localMinimum = lean;
        } else if (enoughMovement && plateau) {
          this.currentPhase = DEADLIFT_PHASE.BOTTOM;
        }
      } else if (this.currentPhase === DEADLIFT_PHASE.BOTTOM) {
        if (this.peakLean - lean >= REVERSAL - EPSILON) {
          this.currentPhase = DEADLIFT_PHASE.RISING;
          this.localMinimum = lean;
        } else if (lean > this.peakLean - EPSILON && this.recentLeans.length
            && lean > Math.max(...this.recentLeans) + REVERSAL - EPSILON) {
          this.currentPhase = DEADLIFT_PHASE.HINGING;
          this.recentLeans = [lean];
        }
      } else if (this.currentPhase === DEADLIFT_PHASE.RISING) {
        this.localMinimum = Math.min(this.localMinimum, lean);
        if (lean >= this.localMinimum + REVERSAL - EPSILON) {
          this.currentPhase = DEADLIFT_PHASE.HINGING;
          this.recentLeans = [lean];
        }
      }
      // Неполная нижняя точка — подсказка текущего кадра: если затем
      // амплитуда увеличится, она не должна сохраняться как ошибка повтора.
      if ([DEADLIFT_PHASE.BOTTOM, DEADLIFT_PHASE.RISING].includes(this.currentPhase)
          && this.peakLean - reference.lean >= MIN_TORSO_TRAVEL - EPSILON
          && this.peakLean < TARGET_TORSO_MIN - EPSILON) frameErrors.push(DEADLIFT_ERROR.SHALLOW);
      // Гистерезис не завершает попытку в кадре, где таз только пересёк
      // стартовый порог, и допускает небольшой остаточный сдвиг при возврате.
      const hipReturned = !this.hipObserved
        || this.peakHipBack - hipBack >= reference.legLength * HIP_REVERSAL_RATIO - EPSILON;
      const returned = lean >= START_TORSO_MIN - EPSILON && lean <= START_TORSO_MAX + EPSILON
        && hipBack <= reference.legLength * HIP_RETURN_RATIO + EPSILON && hipReturned;
      if (returned && (this.currentPhase === DEADLIFT_PHASE.RISING || this.hipObserved)) {
        completed = this.finishAttempt(pose, facing, lean, head, frameErrors);
      }
    }

    const errors = completed ? completed.errors : frameErrors;
    const notes = [];
    if (completed) notes.push(completed.counted ? 'Повтор засчитан.' : 'Движение не засчитано: амплитуда или отведение таза не подтверждены.');
    for (const error of errors) notes.push(errorMessage(error));
    if (!notes.length) {
      const labels = {
        WAITING: 'Примите исходную стойку.',
        START: 'Отведите таз назад, сохраняя комфортный сгиб коленей.',
        HINGING: 'Продолжайте движение подконтрольно, не форсируя амплитуду.',
        BOTTOM: 'Плавно начните обратное движение.',
        RISING: 'Плавно вернитесь в стойку.'
      };
      notes.push(labels[this.currentPhase]);
    }
    return this.result(errors, notes, completed ? completed.initiation : this.hipInitiation);
  }
}
