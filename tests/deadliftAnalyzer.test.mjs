import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Проверяем браузерный ES-модуль без package.json и сборки.
const geometrySource = await readFile(new URL('../geometry.js', import.meta.url));
const geometryUrl = `data:text/javascript;base64,${geometrySource.toString('base64')}`;
const source = (await readFile(new URL('../deadliftAnalyzer.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`);
const { DeadliftAnalyzer, DEADLIFT_PHASE: PHASE, DEADLIFT_ERROR: ERROR } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Синтетическая сагиттальная проекция: сначала геометрия в пикселях,
// затем нормировка MediaPipe. Вектора головы и корпуса можно менять независимо.
function makePose({
  lean = 0, kneeAngle = 160, hipBack = 0, headChange = 0, side = 'left',
  face = true, earVisible = true, mirrored = false, width = 900, height = 800, confidence = 1
} = {}) {
  const pixels = new Map();
  const landmarks = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const index = side === 'left'
    ? { ear: 7, otherEar: 8, shoulder: 11, hip: 23, knee: 25, ankle: 27 }
    : { ear: 8, otherEar: 7, shoulder: 12, hip: 24, knee: 26, ankle: 28 };
  const rad = (degrees) => degrees * Math.PI / 180;
  const hip = { x: 430 - hipBack, y: 360 };
  const ankle = { x: 470, y: 700 };
  const dx = ankle.x - hip.x, dy = ankle.y - hip.y;
  const span = Math.hypot(dx, dy);
  const offset = span / 2 * Math.tan(rad(180 - kneeAngle) / 2);
  const knee = { x: (hip.x + ankle.x) / 2 + dy / span * offset,
    y: (hip.y + ankle.y) / 2 - dx / span * offset };
  const shoulder = { x: hip.x + 150 * Math.sin(rad(lean)), y: hip.y - 150 * Math.cos(rad(lean)) };
  const ear = { x: shoulder.x + 55 * Math.sin(rad(lean + headChange)),
    y: shoulder.y - 55 * Math.cos(rad(lean + headChange)) };
  for (const [id, point] of [[index.shoulder, shoulder], [index.hip, hip], [index.knee, knee], [index.ankle, ankle]]) {
    pixels.set(id, point);
  }
  if (earVisible) pixels.set(index.ear, ear);
  if (face) {
    pixels.set(index.otherEar, { x: ear.x + 3, y: ear.y + 2 });
    pixels.set(0, { x: ear.x + 25, y: ear.y - 3 });
  }
  for (const [id, point] of pixels) {
    landmarks[id] = { x: (mirrored ? width - point.x : point.x) / width, y: point.y / height,
      visibility: confidence, presence: confidence };
  }
  return landmarks;
}

function analyzer(options = {}) {
  return new DeadliftAnalyzer({ videoWidth: 900, videoHeight: 800, ...options });
}
function feed(deadlift, options = {}) { return deadlift.update(makePose(options)); }
function fullRep(deadlift, { peak = 70, ...options } = {}) {
  feed(deadlift, options);
  feed(deadlift, { ...options, hipBack: 20, lean: 0 });
  feed(deadlift, { ...options, hipBack: 60, lean: peak / 2 });
  feed(deadlift, { ...options, hipBack: 100, lean: peak });
  feed(deadlift, { ...options, hipBack: 80, lean: peak - 4 });
  return feed(deadlift, options);
}

test('интерфейс содержит явный статус недоступности оценки позвоночника', () => {
  const result = feed(analyzer());
  assert.deepEqual(Object.keys(result), ['repCount', 'currentPhase', 'currentErrors', 'feedbackMessage',
    'spineAssessment', 'hipInitiation']);
  assert.equal(result.currentPhase, PHASE.START);
  assert.equal(result.repCount, 0);
  assert.equal(result.spineAssessment, 'unavailable');
  assert.equal(result.hipInitiation, 'pending');
  assert.match(result.feedbackMessage, /Округление позвоночника по этим точкам не определяется/);
  assert.doesNotMatch(result.feedbackMessage, /безопасн|спина ровная/i);
});

test('проходят фазы старта, hinge, нижней точки и подъёма', () => {
  const deadlift = analyzer();
  assert.equal(feed(deadlift).currentPhase, PHASE.START);
  let result = feed(deadlift, { hipBack: 20 });
  assert.equal(result.currentPhase, PHASE.HINGING);
  assert.equal(result.hipInitiation, 'observed');
  feed(deadlift, { hipBack: 65, lean: 40 });
  for (let i = 0; i < 6; i += 1) result = feed(deadlift, { hipBack: 100, lean: 70 });
  assert.equal(result.currentPhase, PHASE.BOTTOM);
  assert.equal(result.repCount, 0);
  result = feed(deadlift, { hipBack: 80, lean: 66 });
  assert.equal(result.currentPhase, PHASE.RISING);
  result = feed(deadlift);
  assert.equal(result.currentPhase, PHASE.START);
  assert.equal(result.repCount, 1);
  assert.equal(result.hipInitiation, 'observed');
  assert.deepEqual(result.currentErrors, []);
  assert.match(result.feedbackMessage, /Повтор засчитан/);
});

test('полные повторы считаются однократно после возврата в стойку', () => {
  const deadlift = analyzer();
  assert.equal(fullRep(deadlift).repCount, 1);
  assert.equal(fullRep(deadlift).repCount, 2);
  for (let i = 0; i < 6; i += 1) assert.equal(feed(deadlift).repCount, 2);
});

test('стартовые колени 150–165° и почти вертикальный корпус включают границы', () => {
  for (const [kneeAngle, lean, expected] of [
    [149.99, 0, PHASE.WAITING], [150, 0, PHASE.START], [165, 0, PHASE.START],
    [165.01, 0, PHASE.WAITING], [160, -10, PHASE.START], [160, 20, PHASE.START],
    [160, -10.01, PHASE.WAITING], [160, 20.01, PHASE.WAITING]
  ]) {
    const result = feed(analyzer(), { kneeAngle, lean });
    assert.equal(result.currentPhase, expected, `${kneeAngle} ${lean}: ${result.feedbackMessage}`);
  }
});

test('появление сразу в наклоне не считается повтором', () => {
  const deadlift = analyzer();
  assert.equal(feed(deadlift, { hipBack: 100, lean: 70 }).currentPhase, PHASE.WAITING);
  assert.equal(feed(deadlift, { hipBack: 40, lean: 30 }).repCount, 0);
  assert.equal(feed(deadlift).repCount, 0);
  assert.equal(feed(deadlift).currentPhase, PHASE.START);
});

test('порог 130° строгий и сигнал о колене виден даже без стартовой калибровки', () => {
  for (const [angle, bad] of [[129.9, true], [130, false], [130.1, false]]) {
    const result = feed(analyzer(), { kneeAngle: angle });
    assert.equal(result.currentErrors.includes(ERROR.KNEE_BEND), bad, String(angle));
    if (bad) assert.match(result.feedbackMessage, /Не сгибайте колени так сильно, отводите таз назад/);
  }
});

test('сгибание колена ниже 130° выявляется сразу в движении', () => {
  const deadlift = analyzer();
  feed(deadlift);
  feed(deadlift, { hipBack: 20 });
  const result = feed(deadlift, { hipBack: 70, lean: 50, kneeAngle: 129 });
  assert.ok(result.currentErrors.includes(ERROR.KNEE_BEND));
  assert.match(result.feedbackMessage, /^Не сгибайте колени так сильно/);
  assert.equal(result.spineAssessment, 'unavailable');
});

test('предупреждение о колене из движения сохраняется в кадре завершения', () => {
  const deadlift = analyzer();
  feed(deadlift);
  feed(deadlift, { hipBack: 20 });
  const bad = feed(deadlift, { hipBack: 100, lean: 70, kneeAngle: 129 });
  assert.ok(bad.currentErrors.includes(ERROR.KNEE_BEND));
  feed(deadlift, { hipBack: 80, lean: 60 });
  const completed = feed(deadlift);
  assert.equal(completed.repCount, 1);
  assert.ok(completed.currentErrors.includes(ERROR.KNEE_BEND));
  assert.match(completed.feedbackMessage, /Повтор засчитан/);
  assert.ok(!feed(deadlift).currentErrors.includes(ERROR.KNEE_BEND));
});

test('изменение колена строго более 5° относительно исходного значения', () => {
  for (const [kneeAngle, warning] of [[154.99, true], [155, false], [160, false], [165, false], [165.01, true]]) {
    const deadlift = analyzer();
    feed(deadlift);
    feed(deadlift, { hipBack: 20 });
    const result = feed(deadlift, { hipBack: 60, lean: 40, kneeAngle });
    assert.equal(result.currentErrors.includes(ERROR.KNEE_MOVEMENT), warning, String(kneeAngle));
  }
});

test('во время движения отдельно отмечается выход колена за 150–165°', () => {
  for (const [kneeAngle, warning] of [[149.9, true], [150, false], [165, false], [165.1, true]]) {
    const deadlift = analyzer();
    feed(deadlift);
    feed(deadlift, { hipBack: 20 });
    const result = feed(deadlift, { hipBack: 70, lean: 40, kneeAngle });
    assert.equal(result.currentErrors.includes(ERROR.KNEE_RANGE), warning, String(kneeAngle));
  }
});

test('повтор с пиком 60–80° не получает замечаний по амплитуде', () => {
  for (const peak of [60, 70, 80]) {
    const result = fullRep(analyzer(), { peak });
    assert.equal(result.repCount, 1, String(peak));
    assert.ok(!result.currentErrors.includes(ERROR.SHALLOW));
    assert.ok(!result.currentErrors.includes(ERROR.DEEP));
  }
});

test('частичный завершённый повтор засчитывается без призыва форсировать глубину', () => {
  for (const peak of [10, 30, 59.99]) {
    const result = fullRep(analyzer(), { peak });
    assert.equal(result.repCount, 1, `${peak}: ${result.feedbackMessage}`);
    assert.ok(result.currentErrors.includes(ERROR.SHALLOW));
    assert.match(result.feedbackMessage, /доступную амплитуду без боли/);
    assert.doesNotMatch(result.feedbackMessage, /наклонитесь ниже/i);
  }
});

test('наклон более 80° отмечается в текущем кадре, не дожидаясь завершения повтора', () => {
  const deadlift = analyzer();
  feed(deadlift);
  feed(deadlift, { hipBack: 20 });
  let result = feed(deadlift, { hipBack: 100, lean: 80 });
  assert.ok(!result.currentErrors.includes(ERROR.DEEP));
  result = feed(deadlift, { hipBack: 100, lean: 80.01 });
  assert.ok(result.currentErrors.includes(ERROR.DEEP));
  assert.match(result.feedbackMessage, /заданный ориентир 80°/);
});

test('короткая пауза выше ориентира не оставляет ложное замечание, если движение продолжилось', () => {
  const deadlift = analyzer();
  feed(deadlift);
  feed(deadlift, { hipBack: 20 });
  let result;
  for (let i = 0; i < 6; i += 1) result = feed(deadlift, { hipBack: 60, lean: 40 });
  assert.equal(result.currentPhase, PHASE.BOTTOM);
  assert.ok(result.currentErrors.includes(ERROR.SHALLOW));
  result = feed(deadlift, { hipBack: 70, lean: 45 });
  assert.equal(result.currentPhase, PHASE.HINGING);
  assert.ok(!result.currentErrors.includes(ERROR.SHALLOW));
  feed(deadlift, { hipBack: 100, lean: 70 });
  feed(deadlift, { hipBack: 80, lean: 66 });
  result = feed(deadlift);
  assert.equal(result.repCount, 1);
  assert.ok(!result.currentErrors.includes(ERROR.SHALLOW));
});

test('пик строго более 80° отмечается без утверждения о травме', () => {
  const result = fullRep(analyzer(), { peak: 80.01 });
  assert.equal(result.repCount, 1);
  assert.ok(result.currentErrors.includes(ERROR.DEEP));
  assert.match(result.feedbackMessage, /превысил заданный ориентир 80°/);
  assert.doesNotMatch(result.feedbackMessage, /грыж|травм/i);
});

test('слишком малая амплитуда не засчитывается как повтор', () => {
  const result = fullRep(analyzer(), { peak: 9.99 });
  assert.equal(result.repCount, 0);
  assert.match(result.feedbackMessage, /не засчитано/i);
});

test('гистерезис таза не завершает попытку из-за шума около стартового порога', () => {
  const deadlift = analyzer();
  feed(deadlift);
  assert.equal(feed(deadlift, { hipBack: 15 }).currentPhase, PHASE.HINGING);
  let result = feed(deadlift, { hipBack: 12 });
  assert.equal(result.currentPhase, PHASE.HINGING);
  assert.equal(result.repCount, 0);
  result = feed(deadlift);
  assert.equal(result.currentPhase, PHASE.START);
  assert.equal(result.repCount, 0);
});

test('после разворота допускается небольшой остаточный сдвиг таза при завершении', () => {
  const deadlift = analyzer();
  feed(deadlift);
  feed(deadlift, { hipBack: 20 });
  feed(deadlift, { hipBack: 100, lean: 70 });
  feed(deadlift, { hipBack: 80, lean: 60 });
  const notReturned = feed(deadlift, { hipBack: 16 });
  assert.equal(notReturned.repCount, 0);
  const returned = feed(deadlift, { hipBack: 10 });
  assert.equal(returned.repCount, 1);
});

test('без отведения таза относительно лодыжки повтор не засчитывается', () => {
  const deadlift = analyzer();
  feed(deadlift);
  let result = feed(deadlift, { lean: 40 });
  assert.equal(result.hipInitiation, 'uncertain');
  assert.ok(result.currentErrors.includes(ERROR.HIP_INITIATION));
  feed(deadlift, { lean: 70 });
  result = feed(deadlift);
  assert.equal(result.repCount, 0);
  assert.match(result.feedbackMessage, /не засчитано/i);
});

test('общий сдвиг в кадре не выдаётся за отведение таза', () => {
  const deadlift = analyzer();
  feed(deadlift);
  for (const lean of [40, 70, 0]) {
    const pose = makePose({ lean });
    for (const point of pose) if (Number.isFinite(point.x)) point.x += 20 / 900;
    var result = deadlift.update(pose);
  }
  assert.equal(result.repCount, 0);
  assert.ok(result.currentErrors.includes(ERROR.HIP_INITIATION));
});

test('начало через сгибание колена раньше заметного смещения таза предупреждает сразу', () => {
  const deadlift = analyzer();
  feed(deadlift);
  const result = feed(deadlift, { kneeAngle: 154 });
  assert.equal(result.hipInitiation, 'uncertain');
  assert.ok(result.currentErrors.includes(ERROR.KNEE_MOVEMENT));
  assert.ok(result.currentErrors.includes(ERROR.HIP_INITIATION));
  assert.match(result.feedbackMessage, /Начинайте движение с отведения таза/);
});

test('одновременное пересечение порогов не доказывает порядок движения', () => {
  const deadlift = analyzer();
  feed(deadlift);
  const result = feed(deadlift, { hipBack: 20, lean: 15 });
  assert.equal(result.currentPhase, PHASE.HINGING);
  assert.equal(result.hipInitiation, 'uncertain');
  assert.ok(result.currentErrors.includes(ERROR.HIP_INITIATION));
});

test('коррекция ложного начала до движения возвращает ожидание начала с таза', () => {
  const deadlift = analyzer();
  feed(deadlift);
  assert.equal(feed(deadlift, { kneeAngle: 154 }).hipInitiation, 'uncertain');
  assert.equal(feed(deadlift).hipInitiation, 'pending');
  assert.equal(feed(deadlift, { hipBack: 20 }).hipInitiation, 'observed');
});

test('положение головы сравнивается с началом: строго более 20° в обе стороны', () => {
  for (const [headChange, warning] of [[-30, true], [-20, false], [0, false], [20, false], [20.01, true]]) {
    const deadlift = analyzer();
    feed(deadlift);
    feed(deadlift, { hipBack: 20 });
    const result = feed(deadlift, { hipBack: 70, lean: 50, headChange });
    assert.equal(result.currentErrors.includes(ERROR.HEAD_POSITION), warning, String(headChange));
    assert.equal(result.spineAssessment, 'unavailable');
    if (warning) assert.match(result.feedbackMessage, /Положение головы изменилось/);
    assert.doesNotMatch(result.feedbackMessage, /горб|безопасн|спина ровная/i);
  }
});

test('стабильное положение головы не доказывает отсутствие скругления спины', () => {
  const deadlift = analyzer();
  feed(deadlift);
  feed(deadlift, { hipBack: 20 });
  const result = feed(deadlift, { hipBack: 70, lean: 60, headChange: 0 });
  assert.ok(!result.currentErrors.includes(ERROR.HEAD_POSITION));
  assert.equal(result.spineAssessment, 'unavailable');
  assert.match(result.feedbackMessage, /Округление позвоночника по этим точкам не определяется/);
});

test('отсутствие уха сбрасывает попытку и сохраняет засчитанные повторы', () => {
  const deadlift = analyzer();
  assert.equal(fullRep(deadlift).repCount, 1);
  feed(deadlift, { hipBack: 20 });
  const missing = feed(deadlift, { hipBack: 70, lean: 50, earVisible: false });
  assert.equal(missing.repCount, 1);
  assert.equal(missing.currentPhase, PHASE.WAITING);
  assert.equal(missing.hipInitiation, 'unavailable');
  assert.match(missing.feedbackMessage, /Покажите ухо/);
  feed(deadlift, { hipBack: 100, lean: 70 });
  assert.equal(feed(deadlift).repCount, 1);
});

test('при отсутствии уха сохраняется доступное предупреждение о колене', () => {
  const deadlift = analyzer({ facingDirection: 'right' });
  const result = feed(deadlift, { kneeAngle: 129, earVisible: false });
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.ok(result.currentErrors.includes(ERROR.KNEE_BEND));
  assert.match(result.feedbackMessage, /Покажите ухо/);
});

test('при отсутствии плеча доступный угол колена всё равно предупреждает об избыточном сгибе', () => {
  const pose = makePose({ kneeAngle: 129 });
  pose[11].visibility = 0;
  const result = analyzer({ facingDirection: 'right' }).update(pose);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.ok(result.currentErrors.includes(ERROR.KNEE_BEND));
  assert.match(result.feedbackMessage, /Покажите сбоку плечо/);
  assert.equal(result.spineAssessment, 'unavailable');
});

test('если направление не определено, счёт и оценка начала движения приостановлены', () => {
  const deadlift = analyzer();
  let result = feed(deadlift, { face: false });
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.equal(result.hipInitiation, 'unavailable');
  assert.match(result.feedbackMessage, /Покажите лицо сбоку или задайте направление/);
  result = feed(deadlift, { face: false, hipBack: 100, lean: 70 });
  assert.equal(result.repCount, 0);
  assert.equal(result.spineAssessment, 'unavailable');
});

test('явное направление разрешает работу без носа, но ухо остаётся обязательным', () => {
  const deadlift = analyzer({ facingDirection: 'right' });
  const result = fullRep(deadlift, { face: false });
  assert.equal(result.repCount, 1);
  assert.equal(result.hipInitiation, 'observed');
  assert.equal(feed(deadlift, { face: false, earVisible: false }).currentPhase, PHASE.WAITING);
});

test('автоматическое направление и отведение таза работают в зеркале и для обеих сторон', () => {
  for (const side of ['left', 'right']) {
    for (const mirrored of [false, true]) {
      const result = fullRep(analyzer(), { side, mirrored });
      assert.equal(result.repCount, 1, `${side} ${mirrored}: ${result.feedbackMessage}`);
      assert.equal(result.hipInitiation, 'observed');
      assert.ok(!result.currentErrors.includes(ERROR.HIP_INITIATION));
    }
  }
});

test('при одном ухе автонаправление требует противоположного глаза', () => {
  for (const mirrored of [false, true]) {
    const pose = makePose({ mirrored });
    pose[8].visibility = 0;
    const deadlift = analyzer();
    assert.equal(deadlift.update(pose).currentPhase, PHASE.WAITING);
    const direction = mirrored ? -1 : 1;
    pose[5] = { x: pose[7].x + direction * 12 / 900, y: pose[7].y,
      visibility: 1, presence: 1 };
    assert.equal(deadlift.update(pose).currentPhase, PHASE.START);
  }
});

test('нос между ушами не задаёт предполагаемое направление тела', () => {
  const pose = makePose();
  pose[0].x = (pose[7].x + pose[8].x) / 2;
  const result = analyzer().update(pose);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.match(result.feedbackMessage, /Покажите лицо сбоку или задайте направление/);
});

test('ручное направление относится к исходному зеркальному или незеркальному кадру', () => {
  for (const [mirrored, facingDirection] of [[false, 'right'], [true, 'left']]) {
    const result = fullRep(analyzer({ facingDirection }), { mirrored, face: false });
    assert.equal(result.repCount, 1);
    assert.equal(result.hipInitiation, 'observed');
  }
});

test('исчезновение лица или смена направления во время повтора отменяет попытку', () => {
  for (const mode of ['hidden', 'changed']) {
    const deadlift = analyzer();
    feed(deadlift);
    feed(deadlift, { hipBack: 20 });
    const pose = makePose({ hipBack: 70, lean: 50 });
    if (mode === 'hidden') pose[0].visibility = 0;
    else pose[0].x = pose[7].x - 0.08;
    const result = deadlift.update(pose);
    assert.equal(result.currentPhase, PHASE.WAITING, mode);
    assert.equal(result.repCount, 0);
    assert.match(result.feedbackMessage, /незавершённый повтор отменён/);
    feed(deadlift, { hipBack: 100, lean: 70 });
    assert.equal(feed(deadlift).repCount, 0);
  }
});

test('лицо и плечи не смешиваются между сторонами посреди повтора', () => {
  const deadlift = analyzer();
  feed(deadlift, { side: 'left' });
  feed(deadlift, { side: 'left', hipBack: 20 });
  const left = makePose({ side: 'left', hipBack: 70, lean: 50, earVisible: false });
  const right = makePose({ side: 'right', hipBack: 70, lean: 50 });
  for (const index of [8, 12, 24, 26, 28]) left[index] = right[index];
  const result = deadlift.update(left);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.equal(result.repCount, 0);
  assert.match(result.feedbackMessage, /Покажите ухо/);
});

test('при наличии обеих сторон явный фронтальный ракурс не используется', () => {
  const pose = makePose();
  pose[12] = { ...pose[11], x: pose[11].x + 0.12 };
  pose[24] = { ...pose[23], x: pose[23].x + 0.12 };
  const result = analyzer({ facingDirection: 'right' }).update(pose);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.match(result.feedbackMessage, /камеру строго сбоку/);
});

test('потеря основного сустава немедленно отменяет незавершённое движение', () => {
  for (const index of [11, 23, 25, 27]) {
    const deadlift = analyzer();
    feed(deadlift);
    feed(deadlift, { hipBack: 20 });
    const bad = makePose({ hipBack: 70, lean: 50 });
    bad[index].visibility = 0.49;
    const result = deadlift.update(bad);
    assert.equal(result.currentPhase, PHASE.WAITING, String(index));
    assert.equal(result.repCount, 0);
    feed(deadlift, { hipBack: 100, lean: 70 });
    assert.equal(feed(deadlift).repCount, 0);
  }
});

test('переход через null не добавляет повтор после восстановления', () => {
  const deadlift = analyzer();
  feed(deadlift);
  feed(deadlift, { hipBack: 20 });
  assert.equal(deadlift.update(null).currentPhase, PHASE.WAITING);
  feed(deadlift, { hipBack: 100, lean: 70 });
  assert.equal(feed(deadlift).repCount, 0);
});

test('значение уверенности 0.5 допустимо, некорректные данные — нет', () => {
  const good = makePose({ confidence: 0.5 });
  assert.equal(analyzer().update(good).currentPhase, PHASE.START);
  for (const mutate of [
    (p) => { p[11].x = NaN; }, (p) => { p[23].y = -0.1; },
    (p) => { p[25].x = 1.1; }, (p) => { p[27].presence = NaN; },
    (p) => { p[7].visibility = 0.49; }, (p) => { p[11] = null; }
  ]) {
    const pose = makePose();
    mutate(pose);
    const result = analyzer().update(pose);
    assert.equal(result.currentPhase, PHASE.WAITING);
    assert.equal(result.spineAssessment, 'unavailable');
  }
});

test('совпадающие суставы и вырожденное ухо не подтверждают позу', () => {
  const knee = makePose();
  knee[25] = { ...knee[23] };
  assert.equal(analyzer().update(knee).currentPhase, PHASE.WAITING);
  const ear = makePose();
  ear[7] = { ...ear[11] };
  const result = analyzer().update(ear);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.match(result.feedbackMessage, /Покажите ухо/);
});

test('глубина Z не смешивается с сагиттальной геометрией', () => {
  const deadlift = analyzer();
  const start = makePose();
  for (const point of start) point.z = NaN;
  assert.equal(deadlift.update(start).currentPhase, PHASE.START);
  const moved = makePose({ hipBack: 20 });
  for (const point of moved) point.z = Infinity;
  assert.equal(deadlift.update(moved).currentPhase, PHASE.HINGING);
});

test('размеры и пропорции кадра учитывают нормировку MediaPipe', () => {
  for (const [width, height] of [[900, 800], [1280, 800], [1000, 1200]]) {
    const deadlift = analyzer({ videoWidth: width, videoHeight: height });
    const result = fullRep(deadlift, { width, height });
    assert.equal(result.repCount, 1, `${width}×${height}: ${result.feedbackMessage}`);
    assert.equal(result.hipInitiation, 'observed');
  }
});

test('соотношение порога смещения таза к длине ноги сохраняется при изменении масштаба', () => {
  for (const scale of [0.5, 0.8, 1.2]) {
    const deadlift = analyzer({ videoWidth: 1100, videoHeight: 1000 });
    let result;
    for (const [hipBack, lean] of [[0, 0], [20, 0], [60, 40], [100, 70], [80, 66], [0, 0]]) {
      const pose = makePose({ width: 1100, height: 1000, hipBack, lean });
      for (const point of pose) if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
        point.x *= scale;
        point.y *= scale;
      }
      result = deadlift.update(pose);
    }
    assert.equal(result.repCount, 1, `${scale}: ${result.feedbackMessage}`);
    assert.equal(result.hipInitiation, 'observed');
  }
});

test('смена пропорций, стороны или направления отменяет незавершённую попытку', () => {
  for (const change of [
    (d) => d.setFrameSize(1600, 900), (d) => d.setSide('right'), (d) => d.setFacingDirection('left')
  ]) {
    const deadlift = analyzer();
    feed(deadlift);
    feed(deadlift, { hipBack: 20 });
    change(deadlift);
    assert.equal(deadlift.currentPhase, PHASE.WAITING);
    assert.equal(deadlift.repCount, 0);
  }
});

test('resetTracking сохраняет счётчик, reset начинает новый подход', () => {
  const deadlift = analyzer();
  assert.equal(fullRep(deadlift).repCount, 1);
  feed(deadlift, { hipBack: 20 });
  deadlift.resetTracking();
  assert.equal(deadlift.repCount, 1);
  assert.equal(deadlift.currentPhase, PHASE.WAITING);
  assert.equal(fullRep(deadlift).repCount, 2);
  deadlift.reset();
  assert.equal(deadlift.repCount, 0);
  assert.equal(deadlift.currentPhase, PHASE.WAITING);
});

test('неверные настройки отклоняются', () => {
  assert.throws(() => analyzer({ side: 'front' }), TypeError);
  assert.throws(() => analyzer({ facingDirection: 'up' }), TypeError);
  for (const [width, height] of [[0, 1], [1, -1], [NaN, 1], [1, Infinity]]) {
    assert.throws(() => analyzer({ videoWidth: width, videoHeight: height }), TypeError);
  }
});
