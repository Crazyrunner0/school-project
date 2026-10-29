import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Тестируем браузерные ES-модули без package.json, сервера и сборки.
const geometrySource = await readFile(new URL('../geometry.js', import.meta.url));
const geometryUrl = `data:text/javascript;base64,${geometrySource.toString('base64')}`;
const analyzerSource = (await readFile(new URL('../analyzer.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`);
const analyzerUrl = `data:text/javascript;base64,${Buffer.from(analyzerSource).toString('base64')}`;
const { SquatAnalyzer, SQUAT_PHASE: PHASE, SQUAT_ERROR: ERROR } = await import(analyzerUrl);

// Создаём две ноги с заданными углами; все координаты заданы в масштабе высоты кадра.
function makePose(angle, {
  leftAngle = angle,
  rightAngle = angle,
  knees = [0.35, 0.65],
  ankles = [0.35, 0.65],
  lean = 0,
  footDirection = 1,
  width = 1,
  height = 1
} = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const sides = [
    { shoulder: 11, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 },
    { shoulder: 12, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 }
  ];
  function set(index, x, y) {
    points[index] = { x: x * height / width, y, visibility: 1, presence: 1 };
  }
  sides.forEach((side, index) => {
    const kneeX = knees[index];
    const ankleX = ankles[index];
    const kneeY = 0.55;
    const ankleY = 0.75;
    const direction = Math.atan2(ankleY - kneeY, ankleX - kneeX)
      + [leftAngle, rightAngle][index] * Math.PI / 180;
    const hipX = kneeX + 0.2 * Math.cos(direction);
    const hipY = kneeY + 0.2 * Math.sin(direction);
    const leanRadians = lean * Math.PI / 180;
    set(side.knee, kneeX, kneeY);
    set(side.ankle, ankleX, ankleY);
    set(side.hip, hipX, hipY);
    set(side.shoulder, hipX + 0.2 * Math.sin(leanRadians), hipY - 0.2 * Math.cos(leanRadians));
    set(side.heel, ankleX - footDirection * 0.05, 0.8);
    set(side.toe, ankleX + footDirection * 0.05, 0.8);
  });
  return points;
}

function feed(analyzer, angle, options) {
  return analyzer.update(makePose(angle, options));
}

function withAnalyzer(view = 'front') {
  return new SquatAnalyzer({ view });
}

function reachBottom(analyzer, angle) {
  feed(analyzer, 175);
  feed(analyzer, 130);
  feed(analyzer, angle);
  return feed(analyzer, angle + 4);
}

function mirror(pose) {
  return pose.map((point) => ({ ...point, x: 1 - point.x }));
}

test('публичный результат и пороги фаз: 160 и 140 градусов строго на границе', () => {
  const analyzer = withAnalyzer();
  let result = analyzer.update(makePose(90));
  assert.deepEqual(Object.keys(result), ['repCount', 'currentPhase', 'currentErrors', 'feedbackMessage']);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.equal(result.repCount, 0);
  assert.equal(feed(analyzer, 160).currentPhase, PHASE.WAITING);
  assert.equal(feed(analyzer, 161).currentPhase, PHASE.STANDING);
  assert.equal(feed(analyzer, 140).currentPhase, PHASE.STANDING);
  assert.equal(feed(analyzer, 139).currentPhase, PHASE.DESCENDING);
  assert.equal(feed(analyzer, 120).currentPhase, PHASE.DESCENDING);
  assert.equal(feed(analyzer, 95).currentPhase, PHASE.DESCENDING);
  result = feed(analyzer, 99);
  assert.equal(result.currentPhase, PHASE.BOTTOM);
  assert.equal(result.repCount, 0);
  assert.equal(feed(analyzer, 105).currentPhase, PHASE.ASCENDING);
  assert.equal(feed(analyzer, 160).currentPhase, PHASE.ASCENDING);
  result = feed(analyzer, 161);
  assert.equal(result.currentPhase, PHASE.STANDING);
  assert.equal(result.repCount, 1);
  assert.equal(feed(analyzer, 175).repCount, 1);

  feed(analyzer, 135);
  feed(analyzer, 88);
  feed(analyzer, 92);
  feed(analyzer, 120);
  assert.equal(feed(analyzer, 175).repCount, 2);
  assert.equal(feed(analyzer, 175).repCount, 2);
});

test('пауза внизу определяет фазу BOTTOM, а не считает повтор сразу', () => {
  const analyzer = withAnalyzer();
  feed(analyzer, 175);
  feed(analyzer, 130);
  for (let i = 0; i < 5; i += 1) assert.equal(feed(analyzer, 89).currentPhase, PHASE.DESCENDING);
  let result = feed(analyzer, 89);
  assert.equal(result.currentPhase, PHASE.BOTTOM);
  assert.equal(result.repCount, 0);
  assert.match(result.feedbackMessage, /целевая глубина/i);
  assert.equal(feed(analyzer, 93).currentPhase, PHASE.ASCENDING);
  result = feed(analyzer, 175);
  assert.equal(result.repCount, 1);
  assert.equal(result.currentPhase, PHASE.STANDING);
});

test('глубина: >100° — ошибка, 100° — не ошибка, до 90° — целевая', () => {
  for (const [angle, shallow] of [[101, true], [100.01, true], [100, false], [95, false], [90, false], [80, false]]) {
    const analyzer = withAnalyzer();
    const result = reachBottom(analyzer, angle);
    assert.equal(result.currentPhase, PHASE.BOTTOM);
    assert.equal(result.currentErrors.includes(ERROR.SHALLOW), shallow, `угол ${angle}`);
    if (angle <= 90) assert.match(result.feedbackMessage, /целевая глубина/i);
  }
});

test('ошибка глубины сохраняется в сообщении после повтора, в том числе при пропущенном подъёме', () => {
  const analyzer = withAnalyzer();
  feed(analyzer, 175);
  feed(analyzer, 130);
  let result = feed(analyzer, 175); // минимум и стойка между двумя обработанными кадрами
  assert.equal(result.repCount, 1);
  assert.equal(result.currentPhase, PHASE.STANDING);
  assert.ok(result.currentErrors.includes(ERROR.SHALLOW));
  assert.match(result.feedbackMessage, /Повтор засчитан.*Глубина недостаточна/i);
  result = feed(analyzer, 175);
  assert.equal(result.repCount, 1);
  assert.ok(!result.currentErrors.includes(ERROR.SHALLOW));
  assert.match(result.feedbackMessage, /Глубина недостаточна/i);
  result = feed(analyzer, 130);
  assert.doesNotMatch(result.feedbackMessage, /Повтор засчитан/i);
});

test('после паузы можно продолжить опускание; при медленном повторном снижении учитывается новый минимум', () => {
  const analyzer = withAnalyzer();
  feed(analyzer, 175);
  feed(analyzer, 130);
  for (let i = 0; i < 6; i += 1) feed(analyzer, 110);
  assert.equal(analyzer.currentPhase, PHASE.BOTTOM);
  assert.equal(feed(analyzer, 109).currentPhase, PHASE.BOTTOM);
  assert.equal(feed(analyzer, 108).currentPhase, PHASE.BOTTOM);
  assert.equal(feed(analyzer, 106).currentPhase, PHASE.DESCENDING);
  assert.equal(feed(analyzer, 110).currentPhase, PHASE.BOTTOM);
  assert.equal(feed(analyzer, 115).currentPhase, PHASE.ASCENDING);
  feed(analyzer, 120);
  feed(analyzer, 119);
  feed(analyzer, 118);
  assert.equal(feed(analyzer, 116).currentPhase, PHASE.DESCENDING);
  feed(analyzer, 80);
  const bottom = feed(analyzer, 84);
  assert.equal(bottom.currentPhase, PHASE.BOTTOM);
  assert.ok(!bottom.currentErrors.includes(ERROR.SHALLOW));
  assert.match(bottom.feedbackMessage, /целевая глубина/i);
  feed(analyzer, 110);
  assert.equal(feed(analyzer, 175).repCount, 1);
});

test('наклон корпуса: порог строго больше 45°, учитываются обе стороны и глубина', () => {
  const analyzer = withAnalyzer();
  assert.ok(!feed(analyzer, 175, { lean: 45 }).currentErrors.includes(ERROR.BACK_LEAN));
  assert.ok(feed(analyzer, 175, { lean: 45.1 }).currentErrors.includes(ERROR.BACK_LEAN));
  const pose = makePose(175);
  for (const index of [11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]) pose[index].z = 0;
  pose[11].z = 0.3;
  assert.ok(analyzer.update(pose).currentErrors.includes(ERROR.BACK_LEAN));
  pose[11].visibility = 0.49;
  assert.ok(!analyzer.update(pose).currentErrors.includes(ERROR.BACK_LEAN));
});

test('фронтальный вид: завал к центру, допуск и зеркальное отображение', () => {
  const inward = makePose(110, { knees: [0.42, 0.58], ankles: [0.35, 0.65] });
  const analyzer = withAnalyzer();
  feed(analyzer, 175);
  let result = analyzer.update(inward);
  assert.ok(result.currentErrors.includes(ERROR.KNEES_INWARD));
  assert.ok(!result.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  result = analyzer.update(mirror(inward));
  assert.ok(result.currentErrors.includes(ERROR.KNEES_INWARD));
  result = feed(analyzer, 110, { knees: [0.33, 0.67], ankles: [0.35, 0.65] });
  assert.ok(!result.currentErrors.includes(ERROR.KNEES_INWARD));
  result = feed(analyzer, 110, { knees: [0.379, 0.621], ankles: [0.35, 0.65] });
  assert.ok(!result.currentErrors.includes(ERROR.KNEES_INWARD));
});

test('одновременно выявленные ошибки доступны в currentErrors', () => {
  const analyzer = withAnalyzer('front');
  feed(analyzer, 175);
  const options = { knees: [0.42, 0.58], ankles: [0.35, 0.65], lean: 50 };
  feed(analyzer, 130, options);
  feed(analyzer, 110, options);
  const result = feed(analyzer, 114, options);
  assert.equal(result.currentPhase, PHASE.BOTTOM);
  assert.ok(result.currentErrors.includes(ERROR.SHALLOW));
  assert.ok(result.currentErrors.includes(ERROR.BACK_LEAN));
  assert.ok(result.currentErrors.includes(ERROR.KNEES_INWARD));
  assert.match(result.feedbackMessage, /наклон корпуса/i);
});

test('боковой вид: сравнение колена с носком с учётом направления стопы и допуска', () => {
  const analyzer = withAnalyzer('side');
  feed(analyzer, 175);
  const pastToe = makePose(110, { knees: [0.42, 0.72], ankles: [0.35, 0.65] });
  let result = analyzer.update(pastToe);
  assert.ok(result.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  assert.ok(!result.currentErrors.includes(ERROR.KNEES_INWARD));
  result = analyzer.update(mirror(pastToe));
  assert.ok(result.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  result = feed(analyzer, 110, { knees: [0.404, 0.704], ankles: [0.35, 0.65] });
  assert.ok(!result.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  result = feed(analyzer, 110, { knees: [0.406, 0.706], ankles: [0.35, 0.65] });
  assert.ok(result.currentErrors.includes(ERROR.KNEE_PAST_TOE));

  const unavailable = makePose(110);
  unavailable[29].presence = 0;
  unavailable[30].visibility = 0;
  result = analyzer.update(unavailable);
  assert.ok(!result.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  assert.match(result.feedbackMessage, /стопы и пятки/i);
});

test('HUD выделяет только сторону корпуса, на которой превышен порог наклона', () => {
  const analyzer = withAnalyzer();
  const pose = makePose(175);
  const radians = 50 * Math.PI / 180;
  pose[11].x = pose[23].x + 0.2 * Math.sin(radians);
  pose[11].y = pose[23].y - 0.2 * Math.cos(radians);
  const result = analyzer.update(pose);
  assert.ok(result.currentErrors.includes(ERROR.BACK_LEAN));
  assert.deepEqual(analyzer.getHighlightedSegments(), [
    { start: 11, end: 23, level: 'danger' }
  ]);
  analyzer.update(null);
  assert.deepEqual(analyzer.getHighlightedSegments(), []);
});

test('HUD выделяет проверенное колено с предупреждением, сохраняя направление при зеркалировании', () => {
  const front = withAnalyzer('front');
  feed(front, 175);
  const inward = makePose(110, { knees: [0.42, 0.65], ankles: [0.35, 0.65] });
  assert.ok(front.update(inward).currentErrors.includes(ERROR.KNEES_INWARD));
  assert.deepEqual(front.getHighlightedSegments(), [{ start: 25, end: 27, level: 'warning' }]);
  assert.ok(front.update(mirror(inward)).currentErrors.includes(ERROR.KNEES_INWARD));
  assert.deepEqual(front.getHighlightedSegments(), [{ start: 25, end: 27, level: 'warning' }]);

  const side = withAnalyzer('side');
  feed(side, 175);
  const pastToe = makePose(110, { knees: [0.42, 0.65], ankles: [0.35, 0.65] });
  assert.ok(side.update(pastToe).currentErrors.includes(ERROR.KNEE_PAST_TOE));
  assert.deepEqual(side.getHighlightedSegments(), [{ start: 25, end: 27, level: 'warning' }]);
  side.resetTracking();
  assert.deepEqual(side.getHighlightedSegments(), []);
});

test('HUD показывает ошибку глубины на доступных ногах и очищает её после потери позы', () => {
  const analyzer = withAnalyzer('front');
  const bottom = reachBottom(analyzer, 110);
  assert.ok(bottom.currentErrors.includes(ERROR.SHALLOW));
  assert.deepEqual(analyzer.getHighlightedSegments(), [
    { start: 23, end: 25, level: 'danger' },
    { start: 25, end: 27, level: 'danger' },
    { start: 24, end: 26, level: 'danger' },
    { start: 26, end: 28, level: 'danger' }
  ]);
  analyzer.update([]);
  assert.deepEqual(analyzer.getHighlightedSegments(), []);
});

test('авторакурс выбирает фронтальный и боковой виды, промежуточный не делает вывод', () => {
  const auto = withAnalyzer('auto');
  feed(auto, 175);
  let result = feed(auto, 110, { knees: [0.32, 0.68], ankles: [0.25, 0.75] });
  assert.ok(result.currentErrors.includes(ERROR.KNEES_INWARD));

  const side = withAnalyzer('auto');
  feed(side, 175, { knees: [0.5, 0.51], ankles: [0.5, 0.51] });
  result = feed(side, 110, { knees: [0.57, 0.58], ankles: [0.5, 0.51] });
  assert.ok(result.currentErrors.includes(ERROR.KNEE_PAST_TOE));

  const unknown = withAnalyzer('auto');
  feed(unknown, 175, { knees: [0.4, 0.5], ankles: [0.4, 0.5] });
  result = feed(unknown, 110, { knees: [0.47, 0.57], ankles: [0.4, 0.5] });
  assert.ok(!result.currentErrors.includes(ERROR.KNEES_INWARD));
  assert.ok(!result.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  assert.match(result.feedbackMessage, /ракурс не определён/i);
  unknown.setView('side');
  result = feed(unknown, 110, { knees: [0.47, 0.57], ankles: [0.4, 0.5] });
  assert.ok(result.currentErrors.includes(ERROR.KNEE_PAST_TOE));
});

test('ненадёжные точки пропускаются, а угол усредняется по доступным коленям', () => {
  const analyzer = withAnalyzer();
  feed(analyzer, 175);
  feed(analyzer, 130);
  let result = analyzer.update(makePose(0, { leftAngle: 80, rightAngle: 130 }));
  assert.equal(result.currentPhase, PHASE.DESCENDING);
  result = analyzer.update(makePose(0, { leftAngle: 84, rightAngle: 134 }));
  assert.equal(result.currentPhase, PHASE.BOTTOM);
  assert.ok(result.currentErrors.includes(ERROR.SHALLOW)); // среднее 105°

  const oneSide = withAnalyzer();
  feed(oneSide, 175);
  const pose = makePose(90);
  pose[26].visibility = 0.49;
  result = oneSide.update(pose);
  assert.equal(result.currentPhase, PHASE.DESCENDING);
  pose[25].presence = 0.49;
  result = oneSide.update(pose);
  assert.match(result.feedbackMessage, /покажите камере/i);
});

test('при длительной потере позы незавершённый повтор прерывается, но счётчик сохраняется', () => {
  const analyzer = withAnalyzer();
  reachBottom(analyzer, 80);
  feed(analyzer, 110);
  assert.equal(feed(analyzer, 175).repCount, 1);
  feed(analyzer, 130);
  feed(analyzer, 85);
  for (let i = 0; i < 9; i += 1) {
    const missing = analyzer.update(null);
    assert.equal(missing.currentPhase, PHASE.DESCENDING);
    assert.equal(missing.repCount, 1);
    assert.deepEqual(missing.currentErrors, []);
  }
  const missing = analyzer.update([]);
  assert.equal(missing.currentPhase, PHASE.WAITING);
  assert.equal(missing.repCount, 1);
  let result = feed(analyzer, 175);
  assert.equal(result.currentPhase, PHASE.STANDING);
  assert.equal(result.repCount, 1);
  analyzer.resetTracking();
  result = feed(analyzer, 175);
  assert.equal(result.repCount, 1);
  analyzer.reset();
  assert.equal(feed(analyzer, 175).repCount, 0);
});

test('коррекция пропорций кадра и изменение разрешения или ориентации', () => {
  const analyzer = new SquatAnalyzer({ view: 'front', videoWidth: 640, videoHeight: 360 });
  const frame = { width: 640, height: 360 };
  assert.equal(feed(analyzer, 175, frame).currentPhase, PHASE.STANDING);
  assert.equal(feed(analyzer, 130, frame).currentPhase, PHASE.DESCENDING);
  analyzer.setFrameSize(1280, 720);
  assert.equal(analyzer.currentPhase, PHASE.DESCENDING);
  analyzer.setFrameSize(720, 1280);
  assert.equal(analyzer.currentPhase, PHASE.WAITING);
  assert.throws(() => analyzer.setFrameSize(0, 720), TypeError);
  assert.throws(() => analyzer.setFrameSize(NaN, 720), TypeError);
  assert.throws(() => analyzer.setView('profile'), TypeError);
});
