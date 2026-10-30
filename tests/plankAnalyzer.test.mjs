import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Проверяем настоящий браузерный модуль без package.json и сборки.
const geometrySource = await readFile(new URL('../geometry.js', import.meta.url));
const geometryUrl = `data:text/javascript;base64,${geometrySource.toString('base64')}`;
const analyzerSource = (await readFile(new URL('../plankAnalyzer.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`);
const analyzerUrl = `data:text/javascript;base64,${Buffer.from(analyzerSource).toString('base64')}`;
const { PlankAnalyzer } = await import(analyzerUrl);

// Искусственный профиль: углы задаются в пикселях, затем нормируются как в MediaPipe.
function makePose({
  bodyAngle = 180, hipDirection = 'sag', kneeAngle = 180,
  support = 'wrist', side = 'left', mirrored = false,
  width = 640, height = 480, fallen = false
} = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const indices = side === 'left'
    ? { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 }
    : { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 };
  const shoulder = { x: 60, y: fallen ? 300 : 100 };
  const knee = { x: 260, y: fallen ? 300 : 160 };
  const dx = knee.x - shoulder.x, dy = knee.y - shoulder.y;
  const span = Math.hypot(dx, dy);
  const offset = span / 2 * Math.tan((180 - bodyAngle) * Math.PI / 360)
    * (hipDirection === 'pike' ? -1 : 1);
  const hip = {
    x: (shoulder.x + knee.x) / 2 - dy / span * offset,
    y: (shoulder.y + knee.y) / 2 + dx / span * offset
  };
  const direction = Math.atan2(knee.y - hip.y, knee.x - hip.x) + (180 - kneeAngle) * Math.PI / 180;
  const ankle = { x: knee.x + 90 * Math.cos(direction), y: knee.y + 90 * Math.sin(direction) };
  const ground = fallen ? ankle.y : ankle.y + 25;
  const wrist = { x: shoulder.x, y: ground };
  const elbow = { x: shoulder.x, y: support === 'elbow' ? ground : (shoulder.y + ground) / 2 };
  function set(name, point) {
    points[indices[name]] = { x: (mirrored ? width - point.x : point.x) / width, y: point.y / height,
      visibility: 1, presence: 1 };
  }
  set('shoulder', shoulder); set('hip', hip); set('knee', knee); set('ankle', ankle);
  if (support === 'wrist' || support === 'both') set('wrist', wrist);
  if (support === 'elbow' || support === 'both') set('elbow', elbow);
  if (support === 'raised') set('wrist', { x: shoulder.x, y: shoulder.y });
  return points;
}
function analyzer() { return new PlankAnalyzer({ videoWidth: 640, videoHeight: 480, maxFrameGapSeconds: 2 }); }
function assertNear(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
}

test('считает только интервалы между подтверждёнными корректными кадрами', () => {
  const plank = analyzer();
  const good = makePose();
  let result = plank.update(good, 2);
  assert.deepEqual(Object.keys(result), ['activeHoldTime', 'isFormCorrect', 'feedbackMessage']);
  assert.equal(result.isFormCorrect, true);
  assert.equal(result.activeHoldTime, 0); // до первого кадра состояние неизвестно
  result = plank.update(good, 0.25);
  assertNear(result.activeHoldTime, 0.25);
  result = plank.update(good, 1.5);
  assertNear(result.activeHoldTime, 1.75);
  assert.match(result.feedbackMessage, /линии/i);
});

test('после ошибки или пропажи позы время не включает интервал восстановления', () => {
  const plank = analyzer();
  const good = makePose();
  plank.update(good, 0);
  plank.update(good, 1);
  const bad = plank.update(makePose({ bodyAngle: 150 }), 3);
  assert.equal(bad.isFormCorrect, false);
  assert.match(bad.feedbackMessage, /Поднимите таз, напрягите пресс!/);
  assertNear(bad.activeHoldTime, 1);
  assertNear(plank.update(good, 5).activeHoldTime, 1);
  assertNear(plank.update(good, 0.5).activeHoldTime, 1.5);
  const missing = plank.update(null, 3);
  assert.equal(missing.isFormCorrect, false);
  assertNear(missing.activeHoldTime, 1.5);
  assertNear(plank.update(good, 4).activeHoldTime, 1.5);
  assertNear(plank.update(good, 0.2).activeHoldTime, 1.7);
});

test('коридор 165–180° и пороги провисания/поднятого таза соблюдаются на границах', () => {
  const cases = [
    { bodyAngle: 159.9, hipDirection: 'sag', correct: false, message: /Поднимите таз, напрягите пресс!/ },
    { bodyAngle: 160, hipDirection: 'sag', correct: false, message: /Выровняйте корпус/ },
    { bodyAngle: 164.99, hipDirection: 'sag', correct: false, message: /Выровняйте корпус/ },
    { bodyAngle: 165, hipDirection: 'sag', correct: true },
    { bodyAngle: 180, hipDirection: 'sag', correct: true },
    { bodyAngle: 165, hipDirection: 'pike', correct: true }, // ориентированный угол 195°
    { bodyAngle: 164.99, hipDirection: 'pike', correct: false, message: /Опустите таз, держите прямую линию!/ }
  ];
  for (const item of cases) {
    const result = analyzer().update(makePose(item), 0);
    assert.equal(result.isFormCorrect, item.correct, JSON.stringify(item));
    if (item.message) assert.match(result.feedbackMessage, item.message);
  }
});

test('сгибание коленей и промежуток между порогом ошибки и идеальной формой', () => {
  for (const [angle, correct, message] of [
    [159.9, false, /Выпрямите ноги в коленях!/],
    [160, false, /Выпрямите ноги, чтобы удерживать прямую линию/],
    [164.99, false, /Выпрямите ноги, чтобы удерживать прямую линию/],
    [165, true, null], [180, true, null]
  ]) {
    const result = analyzer().update(makePose({ kneeAngle: angle }), 0);
    assert.equal(result.isFormCorrect, correct, `угол колена ${angle}`);
    if (message) assert.match(result.feedbackMessage, message);
  }
});

test('ошибки таза и коленей показываются вместе', () => {
  const result = analyzer().update(makePose({ bodyAngle: 150, kneeAngle: 150 }), 0);
  assert.equal(result.isFormCorrect, false);
  assert.match(result.feedbackMessage, /Поднимите таз, напрягите пресс!/);
  assert.match(result.feedbackMessage, /Выпрямите ноги в коленях!/);
});

test('ориентированный угол сохраняет смысл при зеркалировании и для обеих сторон', () => {
  for (const side of ['left', 'right']) {
    for (const mirrored of [false, true]) {
      const cases = [
        [{ side, mirrored }, true, /линии/i],
        [{ side, mirrored, bodyAngle: 150, hipDirection: 'sag' }, false, /Поднимите таз/],
        [{ side, mirrored, bodyAngle: 150, hipDirection: 'pike' }, false, /Опустите таз/]
      ];
      for (const [options, correct, message] of cases) {
        const result = analyzer().update(makePose(options), 0);
        assert.equal(result.isFormCorrect, correct, JSON.stringify(options));
        assert.match(result.feedbackMessage, message);
      }
    }
  }
});

test('прямая и локтевая планка распознаются по доступной точке опоры', () => {
  for (const support of ['wrist', 'elbow', 'both']) {
    const result = analyzer().update(makePose({ support }), 0);
    assert.equal(result.isFormCorrect, true, support);
  }
});

test('отсутствие опоры или поднятая рука приводит к осторожной паузе', () => {
  const plank = analyzer();
  plank.update(makePose(), 0);
  plank.update(makePose(), 1);
  for (const support of ['none', 'raised']) {
    const result = plank.update(makePose({ support }), 0.5);
    assert.equal(result.isFormCorrect, false);
    assertNear(result.activeHoldTime, 1);
    assert.match(result.feedbackMessage, /локоть или запястье/);
  }
  assertNear(plank.update(makePose(), 2).activeHoldTime, 1);
  assertNear(plank.update(makePose(), 0.5).activeHoldTime, 1.5);
});

test('положение лёжа на полу останавливает таймер, а возврат не добавляет паузу', () => {
  for (const support of ['wrist', 'elbow']) {
    const plank = analyzer();
    const good = makePose({ support });
    plank.update(good, 0);
    plank.update(good, 2);
    const result = plank.update(makePose({ support, fallen: true }), 1);
    assert.equal(result.isFormCorrect, false, support);
    assertNear(result.activeHoldTime, 2);
    assert.match(result.feedbackMessage, /Поднимитесь с пола/);
    assertNear(plank.update(good, 10).activeHoldTime, 2);
    assertNear(plank.update(good, 0.5).activeHoldTime, 2.5);
  }
});

test('выбирается видимая сторона с опорой, а не смешиваются суставы', () => {
  const left = makePose({ side: 'left', support: 'none' });
  const right = makePose({ side: 'right', support: 'wrist' });
  for (const index of [12, 14, 16, 24, 26, 28, 30, 32]) left[index] = right[index];
  assert.equal(analyzer().update(left, 0).isFormCorrect, true);
  // Недостаточные части разных сторон не складываются в искусственный профиль.
  left[25].visibility = 0;
  left[24].visibility = 0;
  assert.equal(analyzer().update(left, 0).isFormCorrect, false);
});

test('невидимые, испорченные и совпадающие точки останавливают подсчёт', () => {
  const plank = analyzer();
  const good = makePose();
  plank.update(good, 0);
  plank.update(good, 1);
  const corruptions = [
    (pose) => { pose[23].visibility = 0.49; },
    (pose) => { pose[25].presence = NaN; },
    (pose) => { pose[27].x = NaN; },
    (pose) => { pose[11].y = -0.01; },
    (pose) => { pose[25] = { ...pose[23] }; }
  ];
  for (const corrupt of corruptions) {
    const pose = makePose();
    corrupt(pose);
    const result = plank.update(pose, 2);
    assert.equal(result.isFormCorrect, false);
    assertNear(result.activeHoldTime, 1);
    assert.match(result.feedbackMessage, /Покажите тело сбоку/);
  }
});

test('вертикальная стойка не может считаться планкой', () => {
  const pose = makePose();
  for (const [index, y] of [[11, 0.15], [23, 0.35], [25, 0.55], [27, 0.75]]) {
    pose[index].x = 0.5;
    pose[index].y = y;
  }
  const result = analyzer().update(pose, 1);
  assert.equal(result.isFormCorrect, false);
  assertNear(result.activeHoldTime, 0);
});

test('формат кадра и 2D-проекция обрабатываются корректно', () => {
  const plank = analyzer();
  const good = makePose({ width: 640, height: 480 });
  for (const index of [11, 15, 23, 25, 27]) good[index].z = NaN; // Z не используется в боковой 2D-проекции
  assert.equal(plank.update(good, 0).isFormCorrect, true);
  assert.equal(plank.update(good, 0.5).activeHoldTime, 0.5);
  plank.setFrameSize(1280, 960); // тот же aspect ratio
  assert.equal(plank.update(good, 0.5).activeHoldTime, 1);
  plank.setFrameSize(640, 640); // новое соотношение прерывает непрерывность
  plank.setFrameSize(640, 480);
  assert.equal(plank.update(good, 5).activeHoldTime, 1);
  assert.equal(plank.update(good, 1).activeHoldTime, 2);
  assert.throws(() => plank.setFrameSize(0, 480), TypeError);
  assert.throws(() => plank.setFrameSize(640, Infinity), TypeError);
});

test('resetTracking сохраняет время, reset обнуляет, неправильный deltaTime не начисляется', () => {
  const plank = analyzer();
  const good = makePose();
  plank.update(good, 0);
  plank.update(good, 2);
  plank.resetTracking();
  assert.equal(plank.update(good, 10).activeHoldTime, 2);
  assert.equal(plank.update(good, 1).activeHoldTime, 3);
  for (const invalid of [-1, NaN, Infinity, '1']) {
    assert.throws(() => plank.update(good, invalid), RangeError);
    assert.equal(plank.activeHoldTime, 3);
  }
  assert.equal(plank.update(good, 8).activeHoldTime, 3);
  plank.reset();
  assert.equal(plank.update(good, 5).activeHoldTime, 0);
  assert.equal(plank.update(good, 0.75).activeHoldTime, 0.75);
});


test('слишком большой интервал без наблюдения не засчитывается', () => {
  const plank = new PlankAnalyzer({ videoWidth: 640, videoHeight: 480 });
  const good = makePose();
  plank.update(good, 0);
  assertNear(plank.update(good, 0.5).activeHoldTime, 0.5);
  const afterGap = plank.update(good, 5);
  assert.equal(afterGap.isFormCorrect, true); // текущая поза снова видна
  assertNear(afterGap.activeHoldTime, 0.5); // но предыдущие пять секунд неизвестны
  assertNear(plank.update(good, 0.25).activeHoldTime, 0.75);
  assert.throws(() => new PlankAnalyzer({ maxFrameGapSeconds: 0 }), TypeError);
  assert.throws(() => new PlankAnalyzer({ maxFrameGapSeconds: Infinity }), TypeError);
});

test('точка опоры вне кадра не считается видимой даже при высокой оценке модели', () => {
  const pose = makePose({ support: 'wrist' });
  pose[15].y = 1.1;
  pose[15].visibility = 1;
  const result = analyzer().update(pose, 0);
  assert.equal(result.isFormCorrect, false);
  assert.match(result.feedbackMessage, /локоть или запястье/);
});


test('локоть в воздухе без видимого запястья не принимается за точку опоры', () => {
  const pose = makePose({ support: 'both' });
  pose[15].visibility = 0; // рука прямая, виден только не касающийся пола локоть
  const result = analyzer().update(pose, 0);
  assert.equal(result.isFormCorrect, false);
  assert.match(result.feedbackMessage, /локоть или запястье/);
});

test('приближение пола работает для обеих сторон и зеркального видео', () => {
  for (const side of ['left', 'right']) {
    for (const mirrored of [false, true]) {
      for (const support of ['wrist', 'elbow']) {
        const result = analyzer().update(makePose({ side, mirrored, support, fallen: true }), 0);
        assert.equal(result.isFormCorrect, false, JSON.stringify({ side, mirrored, support }));
        assert.match(result.feedbackMessage, /Поднимитесь с пола/);
      }
    }
  }
});

test('граничная уверенность 0.5 допустима, но меньшая переводит таймер на паузу', () => {
  const pose = makePose();
  for (const index of [11, 15, 23, 25, 27]) {
    pose[index].visibility = 0.5;
    pose[index].presence = 0.5;
  }
  const plank = analyzer();
  assert.equal(plank.update(pose, 0).isFormCorrect, true);
  assert.equal(plank.update(pose, 1).activeHoldTime, 1);
  pose[15].visibility = 0.499;
  const missingSupport = plank.update(pose, 1);
  assert.equal(missingSupport.isFormCorrect, false);
  assert.equal(missingSupport.activeHoldTime, 1);
  assert.match(missingSupport.feedbackMessage, /локоть или запястье/);
});
