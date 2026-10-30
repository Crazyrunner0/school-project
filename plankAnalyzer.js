import { findAngle } from './geometry.js';

// Оцениваем одну наиболее надёжную сторону тела в боковой проекции.
const SIDES = [
  { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 },
  { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 }
];
const MIN_CONFIDENCE = 0.5;
const STRAIGHT_ANGLE = 165;
const SAG_LIMIT = 160;
const PIKE_LIMIT = 195;
const KNEE_LIMIT = 160;
const EPSILON = 1e-6;

// MediaPipe задаёт X относительно ширины кадра, а Y — относительно высоты.
// Для анализа в профиль используем 2D-проекцию, не смешивая её с Z.
function framePoint(point, width, height) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  for (const confidence of [point.visibility, point.presence]) {
    if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE)) return null;
  }
  return {
    x: point.x * width,
    y: point.y * height,
    confidence: Math.min(point.visibility ?? 1, point.presence ?? 1)
  };
}

function measureSide(landmarks, side, width, height) {
  const point = (name) => framePoint(landmarks?.[side[name]], width, height);
  const shoulder = point('shoulder');
  const hip = point('hip');
  const knee = point('knee');
  const ankle = point('ankle');
  if (!shoulder || !hip || !knee || !ankle) return null;

  const bodyAngle = findAngle(shoulder, hip, knee);
  const kneeAngle = findAngle(hip, knee, ankle);
  const length = Math.hypot(ankle.x - shoulder.x, ankle.y - shoulder.y);
  if (bodyAngle === null || kneeAngle === null || !Number.isFinite(length) || length === 0) return null;

  const bodyDx = knee.x - shoulder.x;
  const bodyDy = knee.y - shoulder.y;
  const bodySpan = Math.hypot(bodyDx, bodyDy);
  // Почти вертикальная стойка или неразличимый профиль — не планка.
  if (Math.abs(ankle.x - shoulder.x) < length * 0.5 || Math.abs(bodyDx) < bodySpan * 0.5) return null;

  // findAngle возвращает 0–180°. Знак отклонения таза от линии плечо–колено
  // позволяет отличить провисание (<180°) от поднятого таза (>180°).
  // Нормировка по направлению X сохраняет смысл при зеркалировании видео.
  const cross = bodyDx * (hip.y - shoulder.y) - bodyDy * (hip.x - shoulder.x);
  const isHipAboveLine = cross * Math.sign(bodyDx) < 0;
  const directedBodyAngle = isHipAboveLine ? 360 - bodyAngle : bodyAngle;

  const footPoints = [ankle, point('heel'), point('toe')].filter(Boolean);
  const foot = footPoints.reduce((lowest, candidate) => candidate.y > lowest.y ? candidate : lowest);
  // Запястье может быть опорой как на прямых руках, так и на локтях. Для локтя
  // допуск строже: при прямой руке он находится между плечом и полом.
  const arms = [
    { point: point('wrist'), maxHeightDifference: 0.2 },
    { point: point('elbow'), maxHeightDifference: 0.09 }
  ];
  const supports = arms.filter(({ point: arm, maxHeightDifference }) => arm
    && Math.abs(arm.y - foot.y) <= length * maxHeightDifference
    && Math.abs(arm.x - foot.x) >= length * 0.35
    && Math.abs((foot.y - arm.y) / (foot.x - arm.x)) <= 0.35)
    .map(({ point: arm }) => arm);
  const arm = supports.length
    ? supports.reduce((lowest, candidate) => candidate.y > lowest.y ? candidate : lowest)
    : null;

  let isOnFloor = null;
  if (arm) {
    // Прямая между опорами — приблизительная проекция пола. Оцениваем высоту
    // плеча и таза относительно неё, учитывая небольшой наклон камеры.
    const floorAt = (x) => arm.y + (foot.y - arm.y) * (x - arm.x) / (foot.x - arm.x);
    const tolerance = length * 0.12;
    isOnFloor = floorAt(shoulder.x) - shoulder.y <= tolerance
      && floorAt(hip.x) - hip.y <= tolerance;
  }

  return {
    bodyAngle,
    directedBodyAngle,
    kneeAngle,
    isOnFloor,
    confidence: Math.min(shoulder.confidence, hip.confidence, knee.confidence, ankle.confidence,
      foot.confidence, arm?.confidence ?? 1)
  };
}

export class PlankAnalyzer {
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

  // Передавайте реальные размеры видео: нормированные X и Y имеют разные масштабы.
  setFrameSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new TypeError('Размеры видеокадра должны быть положительными числами.');
    }
    if (Math.abs(this.frameWidth / this.frameHeight - width / height) > EPSILON) this.resetTracking();
    this.frameWidth = width;
    this.frameHeight = height;
  }

  // Вызывать при паузе, перемотке или смене источника: время удержания сохраняется.
  resetTracking() {
    this.previousFormCorrect = false;
  }

  // Новый подход начинается с нуля.
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

    const candidates = SIDES.map((side) => measureSide(landmarks, side, this.frameWidth, this.frameHeight))
      .filter(Boolean);
    if (!candidates.length) {
      this.resetTracking();
      return {
        activeHoldTime: this.activeHoldTime,
        isFormCorrect: false,
        feedbackMessage: 'Покажите тело сбоку: плечо, таз, колено и лодыжку.'
      };
    }

    // Предпочитаем сторону, на которой видны опоры; внутри группы — наиболее
    // надёжные landmarks. Смешивать суставы разных сторон нельзя.
    candidates.sort((a, b) => Number(b.isOnFloor !== null) - Number(a.isOnFloor !== null)
      || b.confidence - a.confidence);
    const pose = candidates[0];
    const notes = [];

    if (pose.isOnFloor === true) {
      notes.push('Поднимитесь с пола и примите положение планки.');
    } else {
      if (pose.directedBodyAngle < SAG_LIMIT - EPSILON) {
        notes.push('Поднимите таз, напрягите пресс!');
      } else if (pose.directedBodyAngle > PIKE_LIMIT + EPSILON) {
        notes.push('Опустите таз, держите прямую линию!');
      } else if (pose.bodyAngle < STRAIGHT_ANGLE - EPSILON) {
        notes.push('Выровняйте корпус и держите таз на одной линии с телом.');
      }
      if (pose.kneeAngle < KNEE_LIMIT - EPSILON) {
        notes.push('Выпрямите ноги в коленях!');
      } else if (pose.kneeAngle < STRAIGHT_ANGLE - EPSILON) {
        notes.push('Выпрямите ноги, чтобы удерживать прямую линию.');
      }
      if (pose.isOnFloor === null) {
        notes.push('Покажите локоть или запястье и опору стопы: положение относительно пола не видно.');
      }
    }

    const isFormCorrect = notes.length === 0;
    // Участок времени засчитывается только между двумя подтверждёнными кадрами.
    // Первый корректный кадр после потери позы или нарушения не включает паузу.
    // Большой перерыв между кадрами неизвестен, поэтому тоже не засчитывается.
    if (isFormCorrect && this.previousFormCorrect && deltaTime <= this.maxFrameGapSeconds) {
      this.activeHoldTime += deltaTime;
    }
    this.previousFormCorrect = isFormCorrect;

    return {
      activeHoldTime: this.activeHoldTime,
      isFormCorrect,
      feedbackMessage: isFormCorrect ? 'Держите корпус и ноги на одной линии.' : notes.join(' ')
    };
  }
}
