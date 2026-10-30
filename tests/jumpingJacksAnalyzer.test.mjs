import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const geometrySource = await readFile(new URL('../geometry.js', import.meta.url));
const geometryUrl = `data:text/javascript;base64,${geometrySource.toString('base64')}`;
const source = (await readFile(new URL('../jumpingJacksAnalyzer.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`);
const { JumpingJacksAnalyzer, JACKS_PHASE: PHASE, JACKS_ERROR: ERROR } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Синтетическая фронтальная проекция в пикселях с нормировкой MediaPipe.
function makePose({
  arms = 'closed', angle = 0, rightAngle = angle, feetRatio = 0.4,
  width = 720, height = 900, mirrored = false, confidence = 1
} = {}) {
  const pixels = new Map();
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const shoulders = { left: { x: 300, y: 240 }, right: { x: 420, y: 240 } };
  pixels.set(11, shoulders.left); pixels.set(12, shoulders.right);
  pixels.set(23, { x: 300, y: 410 }); pixels.set(24, { x: 420, y: 410 });
  pixels.set(27, { x: 360 - feetRatio * 60, y: 730 });
  pixels.set(28, { x: 360 + feetRatio * 60, y: 730 });
  pixels.set(2, { x: 340, y: 180 }); pixels.set(5, { x: 380, y: 180 });
  const rad = (degrees) => degrees * Math.PI / 180;
  function angled(side, degrees) {
    const shoulder = shoulders[side];
    const sign = side === 'left' ? -1 : 1;
    const wrist = { x: shoulder.x + sign * 180 * Math.sin(rad(degrees)),
      y: shoulder.y + 180 * Math.cos(rad(degrees)) };
    const elbow = { x: (shoulder.x + wrist.x) / 2, y: (shoulder.y + wrist.y) / 2 };
    pixels.set(side === 'left' ? 13 : 14, elbow);
    pixels.set(side === 'left' ? 15 : 16, wrist);
  }
  function open(side, apart = false) {
    const left = side === 'left';
    pixels.set(left ? 13 : 14, { x: left ? (apart ? 275 : 320) : (apart ? 445 : 400), y: 150 });
    pixels.set(left ? 15 : 16, { x: left ? (apart ? 250 : 340) : (apart ? 470 : 380), y: 70 });
  }
  if (arms === 'open' || arms === 'apart') {
    open('left', arms === 'apart'); open('right', arms === 'apart');
  } else if (arms === 'one') {
    open('left'); angled('right', 0);
  } else if (arms === 'bentClosed') {
    angled('left', 0); angled('right', 0);
    pixels.set(13, { x: 260, y: 300 }); pixels.set(14, { x: 460, y: 300 });
  } else {
    const left = arms === 'shoulder' ? 90 : arms === 'partial' ? 60 : angle;
    const right = arms === 'shoulder' ? 90 : arms === 'partial' ? 60 : rightAngle;
    angled('left', left); angled('right', right);
  }
  for (const [id, point] of pixels) {
    points[id] = { x: (mirrored ? width - point.x : point.x) / width, y: point.y / height,
      visibility: confidence, presence: confidence };
  }
  return points;
}

function analyzer(options = {}) {
  return new JumpingJacksAnalyzer({ videoWidth: 720, videoHeight: 900, ...options });
}
function feed(jacks, options, timestamp) { return jacks.update(makePose(options), timestamp); }
function fullRep(jacks, start = 0, options = {}) {
  feed(jacks, options, start);
  feed(jacks, { ...options, arms: 'open', feetRatio: 1.8 }, start + 500);
  return feed(jacks, options, start + 1000);
}
function near(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test('формат результата и полный цикл CLOSED → OPEN → CLOSED', () => {
  const jacks = analyzer();
  let result = feed(jacks, {}, 0);
  assert.deepEqual(Object.keys(result), ['repCount', 'currentPhase', 'currentErrors', 'feedbackMessage',
    'cadence', 'synchronizationDelayMs', 'eyeReference']);
  assert.equal(result.currentPhase, PHASE.CLOSED);
  assert.equal(result.eyeReference, 'both');
  assert.equal(result.repCount, 0);
  result = feed(jacks, { arms: 'shoulder', feetRatio: 1.2 }, 200);
  assert.equal(result.currentPhase, PHASE.OPENING);
  result = feed(jacks, { arms: 'open', feetRatio: 1.8 }, 400);
  assert.equal(result.currentPhase, PHASE.OPEN);
  assert.equal(result.repCount, 0);
  result = feed(jacks, { arms: 'shoulder', feetRatio: 1.2 }, 600);
  assert.equal(result.currentPhase, PHASE.CLOSING);
  result = feed(jacks, {}, 1000);
  assert.equal(result.currentPhase, PHASE.CLOSED);
  assert.equal(result.repCount, 1);
  assert.deepEqual(result.currentErrors, []);
  near(result.cadence, 60);
  assert.equal(result.synchronizationDelayMs, 0);
  assert.match(result.feedbackMessage, /Повтор засчитан/);
});

test('первый кадр OPEN и возврат в CLOSED не являются повтором', () => {
  const jacks = analyzer();
  assert.equal(feed(jacks, { arms: 'open', feetRatio: 1.8 }, 0).currentPhase, PHASE.WAITING);
  const result = feed(jacks, {}, 500);
  assert.equal(result.currentPhase, PHASE.CLOSED);
  assert.equal(result.repCount, 0);
});

test('полные повторы считаются по одному разу, удержание CLOSED не добавляет их', () => {
  const jacks = analyzer();
  assert.equal(fullRep(jacks, 0).repCount, 1);
  assert.equal(fullRep(jacks, 1001).repCount, 2);
  for (let t = 2100; t <= 2500; t += 100) assert.equal(feed(jacks, {}, t).repCount, 2);
});

test('CLOSED требует строгого угла рук к корпусу менее 30° на обеих сторонах', () => {
  for (const [angle, expected] of [[0, PHASE.CLOSED], [29.99, PHASE.CLOSED],
    [30, PHASE.WAITING], [30.01, PHASE.WAITING]]) {
    const result = feed(analyzer(), { arms: 'angle', angle }, 0);
    assert.equal(result.currentPhase, expected, `${angle}: ${result.feedbackMessage}`);
  }
  const unequal = feed(analyzer(), { arms: 'angle', angle: 20, rightAngle: 30 }, 0);
  assert.equal(unequal.currentPhase, PHASE.WAITING);
});

test('руки по швам требуют также опущенных локтей и кистей около бёдер', () => {
  assert.equal(feed(analyzer(), { arms: 'bentClosed' }, 0).currentPhase, PHASE.WAITING);
  const pose = makePose();
  pose[15].y = 0.29; // ниже плеча, но слишком далеко от бедра
  pose[16].y = 0.29;
  assert.equal(analyzer().update(pose, 0).currentPhase, PHASE.WAITING);
});

test('CLOSED требует расстояния между лодыжками строго меньше ширины плеч', () => {
  for (const [feetRatio, phase] of [[0.4, PHASE.CLOSED], [0.999, PHASE.CLOSED],
    [1, PHASE.WAITING], [1.001, PHASE.WAITING]]) {
    assert.equal(feed(analyzer(), { feetRatio }, 0).currentPhase, phase, String(feetRatio));
  }
});

test('OPEN требует ширины ног строго более 1.5 ширины плеч', () => {
  for (const [feetRatio, count] of [[1.49, 0], [1.5, 0], [1.5001, 1], [2, 1]]) {
    const jacks = analyzer();
    feed(jacks, {}, 0);
    const top = feed(jacks, { arms: 'open', feetRatio }, 500);
    assert.equal(top.currentPhase === PHASE.OPEN, count === 1, String(feetRatio));
    const result = feed(jacks, {}, 1000);
    assert.equal(result.repCount, count, String(feetRatio));
    assert.equal(result.currentErrors.includes(ERROR.NARROW_LEGS), count === 0, String(feetRatio));
  }
});

test('кисти разрешены на расстоянии до одной ширины плеч включительно', () => {
  for (const [extra, count] of [[0, 1], [0.01, 0]]) {
    const jacks = analyzer();
    feed(jacks, {}, 0);
    const open = makePose({ arms: 'open', feetRatio: 1.8 });
    open[15].x = (300 - extra / 2) / 720;
    open[16].x = (420 + extra / 2) / 720;
    jacks.update(open, 500);
    const result = feed(jacks, {}, 1000);
    assert.equal(result.repCount, count, String(extra));
    assert.equal(result.currentErrors.includes(ERROR.HANDS_APART), count === 0, String(extra));
  }
});

test('если кисти выше глаз, но не сведены, это не называют недоподнятыми руками', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  assert.notEqual(feed(jacks, { arms: 'apart', feetRatio: 1.8 }, 500).currentPhase, PHASE.OPEN);
  const result = feed(jacks, {}, 1000);
  assert.equal(result.repCount, 0);
  assert.ok(result.currentErrors.includes(ERROR.HANDS_APART));
  assert.ok(!result.currentErrors.includes(ERROR.LAZY_ARMS));
  assert.match(result.feedbackMessage, /Сводите кисти над головой/);
});

test('обе кисти должны быть строго выше уровня глаз', () => {
  for (const wristY of [180, 180.01, 179.99]) {
    const jacks = analyzer();
    feed(jacks, {}, 0);
    const open = makePose({ arms: 'open', feetRatio: 1.8 });
    for (const index of [15, 16]) open[index].y = wristY / 900;
    for (const index of [13, 14]) open[index].y = 200 / 900;
    const top = jacks.update(open, 500);
    assert.equal(top.currentPhase === PHASE.OPEN, wristY < 180, String(wristY));
    assert.equal(feed(jacks, {}, 1000).repCount, wristY < 180 ? 1 : 0);
  }
});

test('для OPEN и локти должны быть выше плеч, а кисти выше локтей', () => {
  for (const mutate of [
    (pose) => { pose[13].y = pose[11].y; },
    (pose) => { pose[14].y = pose[12].y + 0.01; },
    (pose) => { pose[13].y = pose[15].y; }
  ]) {
    const jacks = analyzer();
    feed(jacks, {}, 0);
    const pose = makePose({ arms: 'open', feetRatio: 1.8 });
    mutate(pose);
    assert.notEqual(jacks.update(pose, 500).currentPhase, PHASE.OPEN);
    const result = feed(jacks, {}, 1000);
    assert.equal(result.repCount, 0);
    assert.ok(result.currentErrors.includes(ERROR.LAZY_ARMS));
  }
});

test('ленивые руки у уровня плеч: предупреждение без зачёта цикла', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { arms: 'shoulder', feetRatio: 1.8 }, 500);
  const result = feed(jacks, {}, 1000);
  assert.equal(result.repCount, 0);
  assert.ok(result.currentErrors.includes(ERROR.LAZY_ARMS));
  assert.ok(!result.currentErrors.includes(ERROR.NARROW_LEGS));
  assert.match(result.feedbackMessage, /Поднимайте руки полностью над головой/);
});

test('одна поднятая рука не подтверждает OPEN', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { arms: 'one', feetRatio: 1.8 }, 500);
  const result = feed(jacks, {}, 1000);
  assert.equal(result.repCount, 0);
  assert.ok(result.currentErrors.includes(ERROR.LAZY_ARMS));
});

test('если каждая рука достигла верха отдельно, проблема в синхронности рук, а не их высоте', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { arms: 'one', feetRatio: 1.8 }, 200);
  const rightOnly = makePose({ arms: 'open', feetRatio: 1.8 });
  const closed = makePose({ feetRatio: 1.8 });
  rightOnly[13] = closed[13];
  rightOnly[15] = closed[15];
  jacks.update(rightOnly, 400);
  const result = feed(jacks, {}, 600);
  assert.equal(result.repCount, 0);
  assert.ok(result.currentErrors.includes(ERROR.ARMS_NOT_TOGETHER));
  assert.ok(!result.currentErrors.includes(ERROR.LAZY_ARMS));
  assert.match(result.feedbackMessage, /обе руки одновременно/);
});

test('узкая постановка ног: предупреждение без зачёта цикла', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { arms: 'open', feetRatio: 1.2 }, 500);
  const result = feed(jacks, {}, 1000);
  assert.equal(result.repCount, 0);
  assert.ok(result.currentErrors.includes(ERROR.NARROW_LEGS));
  assert.ok(!result.currentErrors.includes(ERROR.LAZY_ARMS));
  assert.match(result.feedbackMessage, /Прыгайте шире/);
});

test('недостаточная амплитуда рук и ног может сообщаться одновременно', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { arms: 'shoulder', feetRatio: 1.2 }, 500);
  const result = feed(jacks, {}, 1000);
  assert.equal(result.repCount, 0);
  assert.ok(result.currentErrors.includes(ERROR.NARROW_LEGS));
  assert.ok(result.currentErrors.includes(ERROR.LAZY_ARMS));
});

test('небольшое шевеление около CLOSED не считается попыткой и не даёт ошибок', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { arms: 'angle', angle: 31, feetRatio: 0.45 }, 200);
  const result = feed(jacks, {}, 400);
  assert.equal(result.repCount, 0);
  assert.deepEqual(result.currentErrors, []);
});

test('подсказка при неполном развороте не мешает затем достигнуть OPEN', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { arms: 'shoulder', feetRatio: 1.8 }, 200);
  const short = feed(jacks, { arms: 'angle', angle: 65, feetRatio: 1.6 }, 400);
  assert.equal(short.currentPhase, PHASE.CLOSING);
  assert.ok(short.currentErrors.includes(ERROR.LAZY_ARMS));
  const top = feed(jacks, { arms: 'open', feetRatio: 1.8 }, 600);
  assert.equal(top.currentPhase, PHASE.OPEN);
  assert.ok(!top.currentErrors.includes(ERROR.LAZY_ARMS));
  const result = feed(jacks, {}, 800);
  assert.equal(result.repCount, 1);
  assert.ok(!result.currentErrors.includes(ERROR.LAZY_ARMS));
});

test('после неполной попытки корректный цикл не наследует прошлые ошибки', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { arms: 'shoulder', feetRatio: 1.8 }, 500);
  const incomplete = feed(jacks, {}, 1000);
  assert.ok(incomplete.currentErrors.includes(ERROR.LAZY_ARMS));
  feed(jacks, { arms: 'open', feetRatio: 1.8 }, 1500);
  const completed = feed(jacks, {}, 2000);
  assert.equal(completed.repCount, 1);
  assert.deepEqual(completed.currentErrors, []);
});

test('асинхронность измеряется по моментам достижения рук и ног: порог строго более 300 мс', () => {
  for (const [lag, error] of [[299, false], [300, false], [301, true]]) {
    const jacks = analyzer();
    feed(jacks, {}, 0);
    feed(jacks, { arms: 'open', feetRatio: 0.4 }, 100);
    const top = feed(jacks, { arms: 'open', feetRatio: 1.8 }, 100 + lag);
    assert.equal(top.currentPhase, PHASE.OPEN);
    assert.equal(top.synchronizationDelayMs, lag);
    assert.equal(top.currentErrors.includes(ERROR.ASYNCHRONY), error, String(lag));
    const result = feed(jacks, {}, 600 + lag);
    assert.equal(result.repCount, 1);
    assert.equal(result.currentErrors.includes(ERROR.ASYNCHRONY), error, String(lag));
    if (error) assert.match(result.feedbackMessage, /одновременно/);
  }
});

test('асинхронность обнаруживается и когда ноги достигли OPEN первыми', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { feetRatio: 1.8 }, 100);
  const top = feed(jacks, { arms: 'open', feetRatio: 1.8 }, 401);
  assert.equal(top.synchronizationDelayMs, 301);
  assert.ok(top.currentErrors.includes(ERROR.ASYNCHRONY));
  assert.equal(feed(jacks, {}, 900).repCount, 1);
});

test('раздельные положения рук и ног не заменяют совместное OPEN', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { arms: 'open', feetRatio: 0.4 }, 100);
  feed(jacks, { feetRatio: 1.8 }, 200);
  const result = feed(jacks, {}, 300);
  assert.equal(result.repCount, 0);
  assert.equal(result.synchronizationDelayMs, 100);
  assert.ok(result.currentErrors.includes(ERROR.OPEN_NOT_CONFIRMED));
  assert.ok(!result.currentErrors.includes(ERROR.ASYNCHRONY));
});

test('большой пропуск кадров не используется для утверждения об асинхронности', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { arms: 'open', feetRatio: 0.4 }, 100);
  const afterGap = feed(jacks, { arms: 'open', feetRatio: 1.8 }, 1600);
  assert.equal(afterGap.currentPhase, PHASE.WAITING);
  assert.equal(afterGap.synchronizationDelayMs, null);
  assert.ok(!afterGap.currentErrors.includes(ERROR.ASYNCHRONY));
  assert.equal(feed(jacks, {}, 1800).repCount, 0);
});

test('раздельные положения могут дополнительно показать задержку более 300 мс', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { arms: 'open', feetRatio: 0.4 }, 100);
  feed(jacks, { feetRatio: 1.8 }, 401);
  const result = feed(jacks, {}, 600);
  assert.equal(result.repCount, 0);
  assert.ok(result.currentErrors.includes(ERROR.OPEN_NOT_CONFIRMED));
  assert.ok(result.currentErrors.includes(ERROR.ASYNCHRONY));
});

test('один видимый глаз допустим, но результат отмечен как приблизительный', () => {
  const jacks = analyzer();
  for (const [time, options] of [[0, {}], [500, { arms: 'open', feetRatio: 1.8 }], [1000, {}]]) {
    const pose = makePose(options);
    pose[5].visibility = 0;
    const result = jacks.update(pose, time);
    assert.equal(result.eyeReference, 'single');
    assert.match(result.feedbackMessage, /одному видимому глазу/);
  }
  assert.equal(jacks.repCount, 1);
});

test('если OPEN оценивался по одному глазу, завершение сохраняет это ограничение', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  const open = makePose({ arms: 'open', feetRatio: 1.8 });
  open[5].visibility = 0;
  assert.equal(jacks.update(open, 500).eyeReference, 'single');
  const completed = feed(jacks, {}, 1000);
  assert.equal(completed.repCount, 1);
  assert.equal(completed.eyeReference, 'single');
  assert.match(completed.feedbackMessage, /одному видимому глазу/);
});

test('при двух глазах кисти должны быть выше более высокого видимого глаза', () => {
  const open = makePose({ arms: 'open', feetRatio: 1.8 });
  open[2].y = 170 / 900;
  open[5].y = 190 / 900;
  for (const index of [15, 16]) open[index].y = 180 / 900;
  for (const index of [13, 14]) open[index].y = 200 / 900;
  const both = analyzer();
  feed(both, {}, 0);
  assert.notEqual(both.update(open, 500).currentPhase, PHASE.OPEN);
  const one = analyzer();
  feed(one, {}, 0);
  open[2].visibility = 0;
  const result = one.update(open, 500);
  assert.equal(result.currentPhase, PHASE.OPEN);
  assert.equal(result.eyeReference, 'single');
});

test('без обоих глаз незавершённый цикл отменяется и не засчитывается', () => {
  const jacks = analyzer();
  feed(jacks, {}, 0);
  feed(jacks, { arms: 'open', feetRatio: 1.8 }, 500);
  const missing = makePose();
  missing[2].visibility = 0;
  missing[5].visibility = 0;
  const result = jacks.update(missing, 700);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.equal(result.eyeReference, 'unavailable');
  assert.match(result.feedbackMessage, /хотя бы один глаз/);
  assert.equal(feed(jacks, {}, 1000).repCount, 0);
});

test('средний темп учитывает все полные повторы и остановки с первого update', () => {
  const jacks = analyzer();
  const first = fullRep(jacks, 0);
  near(first.cadence, 60);
  feed(jacks, { arms: 'open', feetRatio: 1.8 }, 1500);
  const second = feed(jacks, {}, 2000);
  assert.equal(second.repCount, 2);
  near(second.cadence, 60);
  const idle = feed(jacks, {}, 3000);
  near(idle.cadence, 40);
  near(jacks.getCadence(5000), 24);
});

test('время ожидания позы в начале подхода тоже входит в средний темп', () => {
  const jacks = analyzer();
  assert.equal(jacks.update(null, 0).cadence, 0);
  feed(jacks, {}, 1000);
  feed(jacks, { arms: 'open', feetRatio: 1.8 }, 1500);
  const result = feed(jacks, {}, 2000);
  assert.equal(result.repCount, 1);
  near(result.cadence, 30);
});

test('resetTracking сохраняет счёт и среднее время, reset начинает новый подход', () => {
  const jacks = analyzer();
  assert.equal(fullRep(jacks, 0).repCount, 1);
  jacks.resetTracking();
  const resumed = feed(jacks, {}, 3000);
  assert.equal(resumed.repCount, 1);
  near(resumed.cadence, 20);
  feed(jacks, { arms: 'open', feetRatio: 1.8 }, 3500);
  assert.equal(feed(jacks, {}, 4000).repCount, 2);
  jacks.reset();
  const fresh = feed(jacks, {}, 0);
  assert.equal(fresh.repCount, 0);
  assert.equal(fresh.cadence, 0);
});

test('большой пропуск кадров отменяет незавершённый цикл, но не обнуляет подход', () => {
  const jacks = analyzer();
  assert.equal(fullRep(jacks, 0).repCount, 1);
  feed(jacks, { arms: 'open', feetRatio: 1.8 }, 1500);
  const afterGap = feed(jacks, {}, 3000);
  assert.equal(afterGap.repCount, 1);
  assert.equal(afterGap.currentPhase, PHASE.CLOSED);
  near(afterGap.cadence, 20);
});

test('порог пропуска кадров настраивается и включён на границе', () => {
  const jacks = analyzer({ maxFrameGapMs: 500 });
  assert.equal(fullRep(jacks, 0).repCount, 1);
  const lost = analyzer({ maxFrameGapMs: 499 });
  assert.equal(fullRep(lost, 0).repCount, 0);
});

test('некорректный или не возрастающий timestamp отменяет цикл без потери счёта', () => {
  for (const invalid of [500, 499, -1, NaN, Infinity, '501']) {
    const jacks = analyzer();
    feed(jacks, {}, 0);
    feed(jacks, { arms: 'open', feetRatio: 1.8 }, 500);
    assert.throws(() => feed(jacks, {}, invalid), RangeError);
    const next = feed(jacks, {}, 600);
    assert.equal(next.repCount, 0);
    assert.equal(next.currentPhase, PHASE.CLOSED);
  }
});

test('getCadence проверяет источник времени и не требует обработки кадра', () => {
  const jacks = analyzer();
  assert.equal(jacks.getCadence(0), 0);
  fullRep(jacks, 0);
  near(jacks.getCadence(2000), 30);
  for (const invalid of [-1, NaN, Infinity, 999]) assert.throws(() => jacks.getCadence(invalid), RangeError);
  assert.equal(feed(jacks, {}, 1500).repCount, 1); // чтение метрики не сдвигает timestamp кадра
});

test('performance.now() можно не передавать явно', () => {
  const jacks = analyzer();
  const result = jacks.update(makePose());
  assert.equal(result.currentPhase, PHASE.CLOSED);
  assert.equal(jacks.update(makePose()).repCount, 0);
});

test('getCadence без аргумента работает даже при пониженной точности performance.now()', () => {
  const original = globalThis.performance;
  try {
    globalThis.performance = { now: () => 1000 };
    const jacks = analyzer();
    jacks.update(makePose());
    jacks.update(makePose({ arms: 'open', feetRatio: 1.8 }));
    assert.equal(jacks.update(makePose()).repCount, 1);
    assert.doesNotThrow(() => jacks.getCadence());
  } finally {
    globalThis.performance = original;
  }
});

test('зеркальный кадр и обе стороны сохраняют полный цикл', () => {
  for (const mirrored of [false, true]) {
    const result = fullRep(analyzer(), 0, { mirrored });
    assert.equal(result.repCount, 1);
    assert.deepEqual(result.currentErrors, []);
  }
});

test('размеры видеокадра восстанавливают единый масштаб X и Y', () => {
  for (const [width, height] of [[720, 900], [1280, 900], [900, 1200]]) {
    const result = fullRep(analyzer({ videoWidth: width, videoHeight: height }), 0, { width, height });
    assert.equal(result.repCount, 1, `${width}×${height}: ${result.feedbackMessage}`);
  }
});

test('порог ширины и положения рук не зависит от масштаба человека в кадре', () => {
  for (const scale of [0.5, 0.8, 1.2]) {
    const jacks = analyzer({ videoWidth: 900, videoHeight: 1200 });
    let result;
    for (const [time, options] of [[0, {}], [500, { arms: 'open', feetRatio: 1.8 }], [1000, {}]]) {
      const pose = makePose({ width: 900, height: 1200, ...options });
      for (const point of pose) if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
        point.x *= scale;
        point.y *= scale;
      }
      result = jacks.update(pose, time);
    }
    assert.equal(result.repCount, 1, `${scale}: ${result.feedbackMessage}`);
  }
});

test('смена пропорций отменяет цикл без потери уже засчитанных повторов', () => {
  const jacks = analyzer();
  fullRep(jacks, 0);
  feed(jacks, { arms: 'open', feetRatio: 1.8 }, 1500);
  jacks.setFrameSize(1280, 900);
  const result = feed(jacks, { width: 1280, height: 900 }, 1800);
  assert.equal(result.repCount, 1);
  assert.equal(result.currentPhase, PHASE.CLOSED);
});

test('отсутствие любого необходимого сустава отменяет попытку', () => {
  for (const index of [11, 12, 13, 14, 15, 16, 23, 24, 27, 28]) {
    const jacks = analyzer();
    feed(jacks, {}, 0);
    feed(jacks, { arms: 'open', feetRatio: 1.8 }, 500);
    const pose = makePose();
    pose[index].visibility = 0.49;
    const missing = jacks.update(pose, 700);
    assert.equal(missing.currentPhase, PHASE.WAITING, String(index));
    assert.match(missing.feedbackMessage, /Покажите тело целиком/);
    assert.equal(feed(jacks, {}, 1000).repCount, 0);
  }
});

test('уверенность 0.5 допустима, испорченные координаты и presence — нет', () => {
  assert.equal(feed(analyzer(), { confidence: 0.5 }, 0).currentPhase, PHASE.CLOSED);
  for (const mutate of [
    (p) => { p[11].x = NaN; }, (p) => { p[12].y = -0.01; },
    (p) => { p[15].x = 1.01; }, (p) => { p[27].presence = NaN; },
    (p) => { p[13] = null; }
  ]) {
    const pose = makePose();
    mutate(pose);
    assert.equal(analyzer().update(pose, 0).currentPhase, PHASE.WAITING);
  }
});

test('совпадающие плечо и локоть, узкий профиль и перевёрнутая поза не подтверждают форму', () => {
  const collapsed = makePose();
  collapsed[13] = { ...collapsed[11] };
  assert.equal(analyzer().update(collapsed, 0).currentPhase, PHASE.WAITING);
  const profile = makePose();
  profile[11].x = 350 / 720; profile[12].x = 370 / 720;
  const notFront = analyzer().update(profile, 0);
  assert.equal(notFront.currentPhase, PHASE.WAITING);
  assert.match(notFront.feedbackMessage, /лицом к камере/);
  const upsideDown = makePose();
  upsideDown[27].y = 0.2;
  assert.equal(analyzer().update(upsideDown, 0).currentPhase, PHASE.WAITING);
});

test('Z не смешивается с фронтальной 2D-геометрией', () => {
  const jacks = analyzer();
  const closed = makePose();
  for (const point of closed) point.z = NaN;
  assert.equal(jacks.update(closed, 0).currentPhase, PHASE.CLOSED);
  const open = makePose({ arms: 'open', feetRatio: 1.8 });
  for (const point of open) point.z = Infinity;
  assert.equal(jacks.update(open, 500).currentPhase, PHASE.OPEN);
});

test('некорректные размеры и временной порог отклоняются', () => {
  for (const invalid of [0, -1, NaN, Infinity, '1000']) {
    assert.throws(() => analyzer({ maxFrameGapMs: invalid }), TypeError);
  }
  for (const [width, height] of [[0, 1], [1, -1], [NaN, 1], [1, Infinity]]) {
    assert.throws(() => analyzer({ videoWidth: width, videoHeight: height }), TypeError);
  }
});
