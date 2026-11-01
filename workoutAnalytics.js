// Статистика отражает только признаки, доступные конкретному анализатору.
// Это не оценка здоровья, безопасности или риска травмы.
const ACTIVE_PHASES = Object.freeze({
  squat: ['DESCENDING', 'BOTTOM', 'ASCENDING'],
  bicepCurl: ['CURLING', 'PEAK', 'LOWERING'],
  lunge: ['LUNGING', 'BOTTOM', 'ASCENDING'],
  overheadPress: ['PRESSING', 'TOP', 'LOCKOUT', 'LOWERING'],
  deadlift: ['HINGING', 'BOTTOM', 'RISING'],
  jumpingJacks: ['OPENING', 'OPEN', 'CLOSING'],
  gluteBridge: ['LIFTING', 'PEAK', 'TOP', 'LOWERING'],
  pullup: ['PULLING', 'TOP', 'TURNAROUND', 'LOWERING']
});

const COACH_TIPS = Object.freeze({
  squat: {
    'Недостаточная глубина приседания': 'Опускайтесь подконтрольно в комфортной амплитуде. Для оценки глубины покажите камере таз, колени и стопы; программный ориентир — угол колена около 90°.',
    'Чрезмерный наклон корпуса': 'Проверьте ракурс сбоку и попробуйте сохранять устойчивое положение корпуса, не форсируя глубину.',
    'Колени смещаются внутрь': 'Следите, чтобы колени двигались по направлению стоп. Запишите подход спереди, чтобы проверить положение.',
    'Колено выходит за носок': 'Проверьте положение стопы и ракурс. Само по себе положение колена впереди носка не означает опасную технику.'
  },
  bicepCurl: {
    'Неполная амплитуда снизу': 'Начинайте подъём из комфортного выпрямленного положения руки; покажите локоть и кисть сбоку.',
    'Недожим сверху': 'Сгибайте руку подконтрольно, стремясь к комфортной верхней точке без раскачки.',
    'Локоть смещён относительно корпуса': 'Попробуйте удерживать плечо и локоть ближе к исходному положению и покажите таз в кадре.',
    'Раскачка корпусом назад': 'Уменьшите нагрузку при необходимости и выполняйте подъём без заметного отклонения корпуса назад.'
  },
  lunge: {
    'Переднее колено слишком далеко за носком': 'Проверьте положение стопы и ракурс съёмки. Положение колена впереди носка само по себе не доказывает опасную технику.',
    'Недостаточная глубина выпада': 'Опускайтесь подконтрольно в комфортной амплитуде; покажите обе ноги сбоку.',
    'Чрезмерный наклон корпуса вперёд': 'Следите за устойчивостью корпуса и снимайте движение сбоку.'
  },
  overheadPress: {
    'Неполное выпрямление рук': 'Выжимайте руки вверх подконтрольно в комфортной амплитуде и покажите обе кисти в верхней точке.',
    'Асимметрия рук': 'Поднимайте руки равномерно и проверьте, видны ли обе кисти и локти.',
    'Отклонение плеч назад относительно таза': 'Проверьте устойчивость корпуса на записи сбоку; при необходимости уменьшите нагрузку.'
  },
  deadlift: {
    'Чрезмерное сгибание колена': 'Проверьте исходное положение и сохраняйте комфортный сгиб коленей во время движения.',
    'Колено вне заданного диапазона': 'Проверьте исходное положение колена и настройте боковой ракурс камеры.',
    'Изменение угла колена': 'Попробуйте удерживать сгиб колена ближе к исходному, отводя таз назад.',
    'Начало движения с таза не подтверждено': 'Начните движение подконтрольно и снимайте строго сбоку, чтобы отведение таза было видно.',
    'Изменение положения головы': 'Следите за комфортным положением головы относительно корпуса. Изгиб позвоночника эта камера не оценивает.',
    'Заданный ориентир наклона не достигнут': 'Уточните ракурс сбоку и двигайтесь только в комфортной амплитуде; не нужно форсировать наклон.',
    'Наклон выше заданного ориентира': 'Проверьте амплитуду на записи сбоку и не форсируйте наклон.'
  },
  jumpingJacks: {
    'Неполный подъём рук': 'Поднимайте обе руки подконтрольно и покажите кисти над головой.',
    'Недостаточное разведение ног': 'Разводите ноги в комфортной амплитуде и оставьте стопы в кадре.',
    'Кисти не сведены над головой': 'Проверьте положение обеих кистей в верхней точке.',
    'Руки не достигли верхней позиции одновременно': 'Поднимайте обе руки одновременно и убедитесь, что они целиком видны.',
    'Несинхронность рук и ног': 'Попробуйте совместить подъём рук с разведением ног в спокойном темпе.',
    'Одновременная открытая позиция не подтверждена': 'Покажите тело спереди и достигайте открытого положения руками и ногами одновременно.'
  },
  gluteBridge: {
    'Недостаточный подъём таза': 'Поднимайте таз подконтрольно в комфортной амплитуде; для зачёта нужна подтверждённая верхняя фаза.',
    'Таз выше линии плечо–колено': 'Обратите внимание на высоту таза и двигайтесь подконтрольно. Изгиб поясницы камера не определяет.',
    'Слишком острый угол колена': 'Проверьте расположение стопы и угол колена в верхней точке.',
    'Слишком тупой угол колена': 'Проверьте расположение стопы и угол колена в верхней точке.'
  },
  pullup: {
    'Неполная амплитуда снизу': 'Начинайте и завершайте повтор из подтверждённого положения виса.',
    'Недотяг сверху': 'Покажите обе руки и лицо; верхняя фаза оценивается приблизительно относительно кистей.',
    'Асимметрия тяги': 'Тяните обеими руками равномерно и убедитесь, что плечи и локти видны спереди.'
  }
});

export function coachTip(exerciseId, error) {
  return COACH_TIPS[exerciseId]?.[error]
    ?? 'Пересмотрите указанную фазу движения и положение камеры. При боли остановитесь и обратитесь к специалисту.';
}

export function scoreCategory(percent) {
  if (!Number.isFinite(percent)) return { level: 'unknown', label: 'Недостаточно данных' };
  if (percent >= 85) return { level: 'excellent', label: 'Отличная форма' };
  if (percent >= 60) return { level: 'attention', label: 'Требует внимания' };
  return { level: 'low', label: 'Много замечаний' };
}

function reliable(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y)
    && (point.z === undefined || Number.isFinite(point.z))
    && (point.visibility === undefined || (Number.isFinite(point.visibility) && point.visibility >= 0.5))
    && (point.presence === undefined || (Number.isFinite(point.presence) && point.presence >= 0.5));
}

// При краткой потере ключевых точек некоторые автоматы продолжают попытку.
// Такой повтор без замечаний нельзя считать подтверждённо «чистым».
function hasMovementPoints(id, points, analyzer) {
  if (!Array.isArray(points)) return false;
  const has = (...indices) => indices.every((index) => reliable(points[index]));
  const side = (left, right) => analyzer?.activeSide === 'left' ? has(...left)
    : analyzer?.activeSide === 'right' ? has(...right) : has(...left) || has(...right);
  switch (id) {
    case 'squat': return side([11, 23, 25, 27], [12, 24, 26, 28]);
    case 'bicepCurl': return side([11, 13, 15, 23], [12, 14, 16, 24]);
    case 'lunge': return has(23, 24, 25, 26, 27, 28) && (has(11, 23) || has(12, 24));
    case 'overheadPress': return has(11, 12, 13, 14, 15, 16) && (reliable(points[23]) || reliable(points[24]));
    case 'deadlift': return side([7, 11, 23, 25, 27], [8, 12, 24, 26, 28]);
    case 'jumpingJacks': return has(11, 12, 13, 14, 15, 16, 23, 24, 27, 28)
      && (reliable(points[2]) || reliable(points[5]));
    case 'gluteBridge': return side([11, 23, 25, 27], [12, 24, 26, 28]);
    case 'pullup': return has(11, 12, 13, 14, 15, 16)
      && (reliable(points[0]) || reliable(points[9]) || reliable(points[10]));
    default: return false;
  }
}

export class WorkoutAnalytics {
  constructor(exerciseId, mode, { squatShallow = 'Недостаточная глубина приседания' } = {}) {
    this.exerciseId = exerciseId;
    this.mode = mode;
    this.squatShallow = squatShallow;
    this.previousRepCount = 0;
    this.previousPhase = null;
    this.attempt = null;
    this.cleanReps = 0;
    this.flaggedReps = 0;
    this.unknownReps = 0;
    this.errorCounts = new Map();
    this.pullupAttemptSequence = 0;
    this.holdPreviousFrame = null;
    this.holdObservedFrames = 0;
    this.confirmedWallMs = 0;
  }

  // Источник/seek/размер кадра отменяют незавершённую попытку, но не результаты.
  cancelAttempt() {
    this.attempt = null;
    this.previousPhase = null;
    this.holdPreviousFrame = null;
  }

  observe(result, { landmarks = null, frame = null, epoch = 0, analyzer = null } = {}) {
    if (!result) return;
    if (this.mode === 'time') {
      this.observeHold(result, frame, epoch, analyzer);
      return;
    }
    this.observeRepetition(result, landmarks, analyzer);
  }

  observeHold(result, frame, epoch, analyzer) {
    if (!frame || frame.pausedPreview || !Number.isFinite(frame.wallTimeMs)
        || !Number.isFinite(result.activeHoldTime)) {
      this.holdPreviousFrame = null;
      return;
    }
    this.holdObservedFrames += 1;
    const previous = this.holdPreviousFrame;
    const maxGapMs = (analyzer?.maxFrameGapSeconds ?? 1) * 1000;
    const elapsed = previous ? frame.wallTimeMs - previous.wallTimeMs : 0;
    // Начисляем реальное время лишь там, где сам автомат подтвердил новый
    // интервал удержания; паузы, пропуски, seek и смена источника исключены.
    if (previous && previous.epoch === epoch && elapsed > 0 && elapsed <= maxGapMs
        && result.activeHoldTime > previous.activeHoldTime) {
      this.confirmedWallMs += elapsed;
    }
    this.holdPreviousFrame = { epoch, wallTimeMs: frame.wallTimeMs, activeHoldTime: result.activeHoldTime };
  }

  observeRepetition(result, landmarks, analyzer) {
    if (!Number.isSafeInteger(result.repCount) || result.repCount < 0) return;
    if (result.repCount < this.previousRepCount) this.cancelAttempt();
    const increase = Math.max(0, result.repCount - this.previousRepCount);
    const active = (ACTIVE_PHASES[this.exerciseId] ?? []).includes(result.currentPhase);

    // Сгибание из неполного нижнего положения начинает новую попытку,
    // поэтому потерянные данные предыдущей не переносятся на неё.
    if (this.exerciseId === 'bicepCurl' && this.previousPhase === 'LOWERING'
        && result.currentPhase === 'CURLING' && !increase) this.attempt = null;
    if (active && !this.attempt) this.attempt = { missing: false, errors: new Set() };
    const attempt = this.attempt;
    if (attempt && (active || increase)) {
      if (!hasMovementPoints(this.exerciseId, landmarks, analyzer)) attempt.missing = true;
      if (this.exerciseId === 'squat') {
        // В приседаниях ошибки кадра не накапливаются автоматом. Временный
        // недосед может исчезнуть при более глубоком продолжении, поэтому его
        // учитываем только в кадре завершения повтора.
        for (const error of result.currentErrors ?? []) {
          if (error !== this.squatShallow || increase) attempt.errors.add(error);
        }
      }
    }

    let outcome = null;
    const pullupEvent = this.exerciseId === 'pullup' ? analyzer?.summaryAttempt : null;
    if (pullupEvent && pullupEvent.sequence > this.pullupAttemptSequence) {
      this.pullupAttemptSequence = pullupEvent.sequence;
      outcome = { counted: pullupEvent.counted, errors: pullupEvent.errors };
    } else if (increase) {
      outcome = { counted: true, errors: this.exerciseId === 'squat'
        ? [...(attempt?.errors ?? []), ...(result.currentErrors ?? [])] : result.currentErrors };
    } else if (attempt && !active && result.currentPhase !== 'WAITING') {
      // Незасчитанная, но завершённая попытка может содержать полезные
      // замечания; они идут в разбор, но не в знаменатель оценки повторов.
      outcome = { counted: false, errors: this.exerciseId === 'squat'
        ? [...attempt.errors, ...(result.currentErrors ?? [])] : result.currentErrors };
    }

    if (outcome) {
      const errorsKnown = Array.isArray(outcome.errors);
      const errors = errorsKnown ? [...new Set(outcome.errors.filter((value) => typeof value === 'string' && value))] : [];
      for (const error of errors) this.errorCounts.set(error, (this.errorCounts.get(error) ?? 0) + 1);
      if (outcome.counted && increase) {
        if (errors.length) this.flaggedReps += 1;
        else if (!errorsKnown || !attempt || attempt.missing) this.unknownReps += 1;
        else this.cleanReps += 1;
        // Один кадр не содержит разбора нескольких повторов: остальные неизвестны.
        this.unknownReps += Math.max(0, increase - 1);
      } else if (increase) {
        this.unknownReps += increase;
      }
      this.attempt = active ? { missing: !hasMovementPoints(this.exerciseId, landmarks, analyzer), errors: new Set() } : null;
    } else if (increase) {
      this.unknownReps += increase;
      this.attempt = null;
    } else if (!active && this.attempt) {
      // Потеря позы и отменённые попытки не порождают «чистый» повтор.
      this.attempt = null;
    }
    this.previousPhase = result.currentPhase;
    this.previousRepCount = result.repCount;
  }

  snapshot(durationMs, repCount = null) {
    const elapsedMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    const errors = Object.freeze([...this.errorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => Object.freeze({ name, count, advice: coachTip(this.exerciseId, name) })));
    if (this.mode === 'time') {
      const confirmedWallMs = Math.min(this.confirmedWallMs, elapsedMs);
      const holdRatioPercent = this.holdObservedFrames && elapsedMs > 0
        ? Math.round(confirmedWallMs / elapsedMs * 1000) / 10 : null;
      return Object.freeze({ cleanReps: null, flaggedReps: null, unknownReps: null,
        assessedReps: 0, scorePercent: null, errors, confirmedWallMs, holdRatioPercent });
    }
    const tracked = this.cleanReps + this.flaggedReps + this.unknownReps;
    const missing = Number.isSafeInteger(repCount) ? Math.max(0, repCount - tracked) : 0;
    const assessedReps = this.cleanReps + this.flaggedReps;
    // Округление вниз до десятых не переносит 84,95% в зелёный диапазон,
    // а 59,95% — в жёлтый: категории соответствуют исходной доле.
    const scorePercent = assessedReps ? Math.floor(this.cleanReps / assessedReps * 1000 + 1e-10) / 10 : null;
    return Object.freeze({ cleanReps: this.cleanReps, flaggedReps: this.flaggedReps,
      unknownReps: this.unknownReps + missing, assessedReps, scorePercent, errors,
      confirmedWallMs: null, holdRatioPercent: null });
  }
}
