import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const geometrySource = await readFile(new URL('../geometry.js', import.meta.url));
const geometryUrl = `data:text/javascript;base64,${geometrySource.toString('base64')}`;
const analyzerSource = (await readFile(new URL('../pullupAnalyzer.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`);
const { PullUpAnalyzer, PULLUP_PHASE: PHASE, PULLUP_ERROR: ERROR } =
  await import(`data:text/javascript;base64,${Buffer.from(analyzerSource).toString('base64')}`);

const WIDTH = 900;
const HEIGHT = 800;

// Синтетическая фронтальная/тыловая проекция. Углы строятся в пикселях до
// нормализации и не являются примерами реального выполнения упражнения.
function makePose({
  angle = 170, rightAngle = angle, shoulderY = 500, rightShoulderY = shoulderY,
  leftWristY = 140, rightWristY = 140, face = 'both', headY = null,
  width = WIDTH, height = HEIGHT, mirrored = false, confidence = 1,
  shiftX = 0, shiftY = 0
} = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const rad = (degrees) => degrees * Math.PI / 180;
  function set(index, point) {
    const x = point.x + shiftX;
    points[index] = { x: (mirrored ? width - x : x) / width, y: (point.y + shiftY) / height,
      visibility: confidence, presence: confidence };
  }
  for (const [ids, shoulder, wrist, elbowAngle, sign] of [
    [[11, 13, 15], { x: 365, y: shoulderY }, { x: 210, y: leftWristY }, angle, -1],
    [[12, 14, 16], { x: 535, y: rightShoulderY }, { x: 690, y: rightWristY }, rightAngle, 1]
  ]) {
    const dx = wrist.x - shoulder.x;
    const dy = wrist.y - shoulder.y;
    const span = Math.hypot(dx, dy);
    const offset = span / 2 * Math.tan(rad(180 - elbowAngle) / 2);
    const elbow = { x: (shoulder.x + wrist.x) / 2 + sign * (-dy / span) * offset,
      y: (shoulder.y + wrist.y) / 2 + sign * (dx / span) * offset };
    set(ids[0], shoulder); set(ids[1], elbow); set(ids[2], wrist);
  }
  const centerY = (shoulderY + rightShoulderY) / 2;
  const mouthY = headY ?? centerY - 60;
  if (face === 'both' || face === 'mouth' || face === 'mouth-one') {
    set(9, { x: 435, y: mouthY });
    if (face !== 'mouth-one') set(10, { x: 465, y: mouthY });
  }
  if (face === 'both' || face === 'nose') set(0, { x: 450, y: headY ?? centerY - 100 });
  return points;
}
function analyzer(options = {}) {
  return new PullUpAnalyzer({ videoWidth: WIDTH, videoHeight: HEIGHT, ...options });
}
function feed(pullup, timestampMs, poseOptions = {}, updateOptions) {
  return pullup.update(makePose(poseOptions), timestampMs, updateOptions);
}
function fullRep(pullup, { startTime = 0, ...options } = {}) {
  const frames = [[0, 170, 500], [100, 145, 400], [300, 70, 190], [500, 120, 330], [700, 170, 500]];
  let result;
  for (const [time, angle, shoulderY] of frames) {
    result = feed(pullup, startTime + time, { ...options, angle, shoulderY });
  }
  return result;
}

// Логика проверяется синтетическими landmarks, а не реальным видео MediaPipe.
test('интерфейс и ограничения явно описывают ориентиры головы и перекладины', () => {
  const result = feed(analyzer(), 0);
  assert.deepEqual(Object.keys(result), ['repCount', 'currentPhase', 'currentErrors', 'feedbackMessage',
    'headReference', 'barReference']);
  assert.equal(result.repCount, 0);
  assert.equal(result.currentPhase, PHASE.HANG);
  assert.equal(result.headReference, 'mouth');
  assert.equal(result.barReference, 'wrists');
  assert.match(result.feedbackMessage, /приблизительно оценивается по точкам рта/);
  assert.match(result.feedbackMessage, /перекладины приблизительно оценивается по кистям/);
});

test('полный цикл HANG → PULLING → TOP → LOWERING → HANG считается в конце', () => {
  const pullup = analyzer();
  assert.equal(feed(pullup, 0).currentPhase, PHASE.HANG);
  assert.equal(feed(pullup, 100, { angle: 145, shoulderY: 400 }).currentPhase, PHASE.PULLING);
  const top = feed(pullup, 300, { angle: 70, shoulderY: 190 });
  assert.equal(top.currentPhase, PHASE.TOP);
  assert.equal(top.repCount, 0);
  assert.equal(feed(pullup, 500, { angle: 120, shoulderY: 330 }).currentPhase, PHASE.LOWERING);
  const result = feed(pullup, 700);
  assert.equal(result.currentPhase, PHASE.HANG);
  assert.equal(result.repCount, 1);
  assert.deepEqual(result.currentErrors, []);
  assert.match(result.feedbackMessage, /Повтор засчитан/);
});

test('полные повторы учитываются однократно', () => {
  const pullup = analyzer();
  assert.equal(fullRep(pullup).repCount, 1);
  assert.equal(fullRep(pullup, { startTime: 800 }).repCount, 2);
  assert.equal(feed(pullup, 1600).repCount, 2);
  assert.equal(feed(pullup, 1700).repCount, 2);
});

test('первый кадр вверху не подтверждает предыдущие вис и подъём', () => {
  const pullup = analyzer();
  const top = feed(pullup, 0, { angle: 70, shoulderY: 190 });
  assert.equal(top.currentPhase, PHASE.WAITING);
  assert.equal(top.repCount, 0);
  const hang = feed(pullup, 300);
  assert.equal(hang.currentPhase, PHASE.HANG);
  assert.equal(hang.repCount, 0);
});

test('при пропущенных промежуточных кадрах HANG → TOP → HANG может подтвердить цикл', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  assert.equal(feed(pullup, 300, { angle: 70, shoulderY: 190 }).currentPhase, PHASE.TOP);
  const result = feed(pullup, 600);
  assert.equal(result.repCount, 1);
});

for (const [left, right, expected] of [
  [160, 170, PHASE.WAITING], [170, 160, PHASE.WAITING], [160.01, 160.01, PHASE.HANG],
  [170, 170, PHASE.HANG], [145, 145, PHASE.WAITING]
]) {
  test(`HANG требует оба локтя строго больше 160°: ${left}° / ${right}°`, () => {
    assert.equal(feed(analyzer(), 0, { angle: left, rightAngle: right }).currentPhase, expected);
  });
}

test('прямые руки без положения кистей над плечами не подтверждают вис', () => {
  const pose = makePose();
  for (const [s, e, w] of [[11, 13, 15], [12, 14, 16]]) {
    pose[e] = { ...pose[s], y: pose[s].y + 0.08 };
    pose[w] = { ...pose[s], y: pose[s].y + 0.16 };
  }
  assert.notEqual(analyzer().update(pose, 0).currentPhase, PHASE.HANG);
});

for (const start of [144.99, 145, 150, 160]) {
  test(`старт с ${start}° не считается полным; нижнее предупреждение только строго ниже 145°`, () => {
    const pullup = analyzer();
    feed(pullup, 0, { angle: start });
    const rising = feed(pullup, 100, { angle: 110, shoulderY: 400 });
    assert.equal(rising.currentErrors.includes(ERROR.SHORT_BOTTOM), start < 145);
    const top = feed(pullup, 300, { angle: 70, shoulderY: 190 });
    assert.equal(top.currentPhase, PHASE.TOP);
    const result = feed(pullup, 600);
    assert.equal(result.repCount, 0);
    assert.equal(result.currentErrors.includes(ERROR.SHORT_BOTTOM), start < 145);
    assert.match(result.feedbackMessage, /Повтор не засчитан/);
    if (start < 145) assert.match(result.feedbackMessage, /Опускайтесь до полного виса/);
    else assert.match(result.feedbackMessage, /В начале не был подтверждён полный вис/);
  });
}

test('для нижней ошибки достаточно угла меньше 145° у одной из рук', () => {
  const pullup = analyzer();
  feed(pullup, 0, { angle: 170, rightAngle: 144 });
  const rising = feed(pullup, 100, { angle: 120, rightAngle: 110, shoulderY: 400 });
  assert.ok(rising.currentErrors.includes(ERROR.SHORT_BOTTOM));
});

test('давний полный вис не скрывает согнутый старт без подъёма плеч', () => {
  const pullup = analyzer();
  feed(pullup, 0, { angle: 170 });
  feed(pullup, 100, { angle: 140 });
  const rising = feed(pullup, 200, { angle: 110, shoulderY: 400 });
  assert.ok(rising.currentErrors.includes(ERROR.SHORT_BOTTOM));
  feed(pullup, 400, { angle: 70, shoulderY: 190 });
  const result = feed(pullup, 700);
  assert.equal(result.repCount, 0);
});

test('возврат возле низа с согнутыми локтями ещё не завершает полный повтор', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  feed(pullup, 100, { angle: 140, shoulderY: 400 });
  feed(pullup, 300, { angle: 70, shoulderY: 190 });
  feed(pullup, 500, { angle: 120, shoulderY: 330 });
  const result = feed(pullup, 700, { angle: 150, shoulderY: 490 });
  assert.equal(result.currentPhase, PHASE.LOWERING);
  assert.equal(result.repCount, 0);
  assert.match(result.feedbackMessage, /В конце вернитесь в полный вис/);
  // Даже после паузы на согнутых руках последний шаг до полного виса
  // завершает исходный повтор, а не теряется из-за раннего сброса.
  for (let i = 1; i <= 6; i += 1) {
    assert.equal(feed(pullup, 700 + i * 100, { angle: 150, shoulderY: 490 }).repCount, 0);
  }
  assert.equal(feed(pullup, 1400).repCount, 1);
});

test('новый подъём из неполного низа завершает предыдущую попытку без зачёта', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  feed(pullup, 300, { angle: 70, shoulderY: 190 });
  feed(pullup, 500, { angle: 150, shoulderY: 500 });
  const rebound = feed(pullup, 600, { angle: 130, shoulderY: 480 });
  assert.equal(rebound.currentPhase, PHASE.PULLING);
  assert.equal(rebound.repCount, 0);
  assert.match(rebound.feedbackMessage, /В конце вернитесь в полный вис/);
  feed(pullup, 700, { angle: 90, shoulderY: 230 });
  feed(pullup, 800, { angle: 70, shoulderY: 190 });
  const result = feed(pullup, 900);
  assert.equal(result.repCount, 0);
  assert.match(result.feedbackMessage, /В начале не был подтверждён полный вис/);
});

test('кадр разворота к новому подъёму относится к новой попытке и не теряется', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  feed(pullup, 200, { angle: 100, shoulderY: 300 }); // верх ещё не достигнут
  feed(pullup, 400, { angle: 130, shoulderY: 500 }); // неполный нижний возврат
  const nextTop = feed(pullup, 600, { angle: 70, shoulderY: 190 });
  assert.equal(nextTop.currentPhase, PHASE.TOP);
  assert.ok(nextTop.currentErrors.includes(ERROR.SHORT_TOP)); // итог предыдущей попытки
  assert.ok(nextTop.currentErrors.includes(ERROR.SHORT_BOTTOM)); // начало новой
  assert.match(nextTop.feedbackMessage, /Начинается следующий подъём/);
  const result = feed(pullup, 800);
  assert.equal(result.repCount, 0);
  assert.ok(result.currentErrors.includes(ERROR.SHORT_BOTTOM));
  assert.ok(!result.currentErrors.includes(ERROR.SHORT_TOP));
});

test('равенство уровня головы и средней высоты кистей не является TOP', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  const equal = feed(pullup, 200, { angle: 80, shoulderY: 200, headY: 140 });
  assert.equal(equal.currentPhase, PHASE.PULLING);
  const above = feed(pullup, 300, { angle: 70, shoulderY: 190, headY: 139.99 });
  assert.equal(above.currentPhase, PHASE.TOP);
});

test('при неодинаковой высоте запястий используется средняя горизонтальная линия', () => {
  const pullup = analyzer();
  feed(pullup, 0, { leftWristY: 140, rightWristY: 160 });
  const equal = feed(pullup, 200, { angle: 80, shoulderY: 200,
    leftWristY: 140, rightWristY: 160, headY: 150 });
  assert.notEqual(equal.currentPhase, PHASE.TOP);
  const above = feed(pullup, 300, { angle: 70, shoulderY: 190,
    leftWristY: 140, rightWristY: 160, headY: 149.99 });
  assert.equal(above.currentPhase, PHASE.TOP);
});

test('недотяг не показывается при подъёме, но появляется после разворота', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  const rising = feed(pullup, 100, { angle: 130, shoulderY: 360 });
  assert.ok(!rising.currentErrors.includes(ERROR.SHORT_TOP));
  feed(pullup, 300, { angle: 100, shoulderY: 300 });
  const descending = feed(pullup, 500, { angle: 120, shoulderY: 330 });
  assert.equal(descending.currentPhase, PHASE.LOWERING);
  assert.ok(descending.currentErrors.includes(ERROR.SHORT_TOP));
  assert.match(descending.feedbackMessage, /Тянитесь выше, подбородок над турником/);
  const result = feed(pullup, 700);
  assert.equal(result.repCount, 0);
  assert.ok(result.currentErrors.includes(ERROR.SHORT_TOP));
});

test('промежуточный повторный подъём выше низа остаётся частью той же попытки', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  feed(pullup, 200, { angle: 70, shoulderY: 190 });
  assert.equal(feed(pullup, 400, { angle: 110, shoulderY: 330 }).currentPhase, PHASE.LOWERING);
  assert.equal(feed(pullup, 500, { angle: 90, shoulderY: 250 }).currentPhase, PHASE.PULLING);
  assert.equal(feed(pullup, 600, { angle: 70, shoulderY: 190 }).currentPhase, PHASE.TOP);
  assert.equal(feed(pullup, 800).repCount, 1);
});

test('плато подтверждает неполный верх; продолженный подъём может исправить попытку', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  let top;
  for (let i = 1; i <= 6; i += 1) top = feed(pullup, i * 100, { angle: 100, shoulderY: 300 });
  assert.equal(top.currentPhase, PHASE.TURNAROUND);
  assert.ok(top.currentErrors.includes(ERROR.SHORT_TOP));
  const rising = feed(pullup, 700, { angle: 90, shoulderY: 275 });
  assert.equal(rising.currentPhase, PHASE.PULLING);
  assert.ok(!rising.currentErrors.includes(ERROR.SHORT_TOP));
  assert.equal(feed(pullup, 900, { angle: 70, shoulderY: 190 }).currentPhase, PHASE.TOP);
  assert.equal(feed(pullup, 1100).repCount, 1);
});

test('малое шевеление возвращается в HANG, не застревая в PULLING', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  assert.equal(feed(pullup, 100, { angle: 169, shoulderY: 490 }).currentPhase, PHASE.PULLING);
  const settled = feed(pullup, 200);
  assert.equal(settled.currentPhase, PHASE.HANG);
  assert.equal(settled.repCount, 0);
  assert.match(settled.feedbackMessage, /слишком мало/);
  assert.equal(fullRep(pullup, { startTime: 300 }).repCount, 1);
});

test('вертикального движения без сгибания обеих рук недостаточно для подсчёта', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  feed(pullup, 200, { angle: 170, shoulderY: 190 });
  const result = feed(pullup, 500);
  assert.equal(result.repCount, 0);
  assert.match(result.feedbackMessage, /Движение слишком мало/);
});

for (const face of ['mouth', 'mouth-one', 'nose']) {
  test(`доступный лицевой ориентир ${face} поддерживается с предупреждением о приближении`, () => {
    const pullup = analyzer();
    const start = feed(pullup, 0, { face });
    assert.equal(start.headReference, face === 'mouth-one' ? 'mouth-single' : face);
    assert.match(start.feedbackMessage, face === 'nose' ? /положение подбородка не подтверждено/ : /приблизительно/);
    const result = fullRep(pullup, { startTime: 100, face });
    assert.equal(result.repCount, 1);
  });
}

test('использование одной точки рта сохраняется в информации о законченной попытке', () => {
  const pullup = analyzer();
  feed(pullup, 0, { face: 'both' });
  const partial = feed(pullup, 200, { angle: 140, shoulderY: 400, face: 'mouth-one' });
  assert.equal(partial.headReference, 'mouth-single');
  feed(pullup, 400, { angle: 70, shoulderY: 190, face: 'both' });
  const result = feed(pullup, 600, { face: 'both' });
  assert.equal(result.repCount, 1);
  assert.equal(result.headReference, 'mouth-single');
});

test('нос не подменяет рот, если обе точки рта доступны', () => {
  const pullup = analyzer();
  feed(pullup, 0, { face: 'both' });
  // При Y плеч 230 нос уже выше кистей, а рот ещё ниже.
  const pose = feed(pullup, 200, { angle: 90, shoulderY: 230, face: 'both' });
  assert.equal(pose.headReference, 'mouth');
  assert.notEqual(pose.currentPhase, PHASE.TOP);
});

test('при съёмке без лица внешний chinY поддерживает полный повтор', () => {
  const pullup = analyzer();
  let result;
  for (const [time, angle, shoulderY] of [[0, 170, 500], [100, 145, 400], [300, 70, 190],
    [500, 120, 330], [700, 170, 500]]) {
    result = feed(pullup, time, { face: 'none', angle, shoulderY }, { chinY: (shoulderY - 70) / HEIGHT });
  }
  assert.equal(result.repCount, 1);
  assert.equal(result.headReference, 'external');
  assert.match(result.feedbackMessage, /передана извне/);
});

test('внешний chinY при наличии имеет приоритет над точками рта и носом', () => {
  const pullup = analyzer();
  feed(pullup, 0, {}, { chinY: 440 / HEIGHT });
  const nearTop = feed(pullup, 200, { angle: 70, shoulderY: 190 }, { chinY: 150 / HEIGHT });
  assert.equal(nearTop.headReference, 'external');
  assert.notEqual(nearTop.currentPhase, PHASE.TOP);
  const descending = feed(pullup, 400, { angle: 110, shoulderY: 300 }, { chinY: 230 / HEIGHT });
  assert.ok(descending.currentErrors.includes(ERROR.SHORT_TOP));
  const result = feed(pullup, 600, {}, { chinY: 440 / HEIGHT });
  assert.equal(result.repCount, 0);
});

test('без рта, носа и внешнего chinY попытка отменяется', () => {
  const pullup = analyzer();
  feed(pullup, 0, { face: 'none' }, { chinY: 440 / HEIGHT });
  feed(pullup, 100, { face: 'none', angle: 140, shoulderY: 400 }, { chinY: 340 / HEIGHT });
  const missing = feed(pullup, 200, { face: 'none', angle: 80, shoulderY: 200 });
  assert.equal(missing.currentPhase, PHASE.WAITING);
  assert.equal(missing.headReference, 'unavailable');
  assert.equal(missing.repCount, 0);
  assert.match(missing.feedbackMessage, /попытка отменена/);
  const returned = feed(pullup, 400, { face: 'none' }, { chinY: 440 / HEIGHT });
  assert.equal(returned.repCount, 0);
});

test('источник головы не переключается с рта на нос посреди подтягивания', () => {
  const pullup = analyzer();
  feed(pullup, 0, { face: 'both' });
  feed(pullup, 100, { angle: 140, shoulderY: 400, face: 'both' });
  const switched = feed(pullup, 300, { angle: 80, shoulderY: 210, face: 'nose' });
  assert.equal(switched.currentPhase, PHASE.WAITING);
  assert.equal(switched.repCount, 0);
  assert.match(switched.feedbackMessage, /ориентир головы/i);
});

test('потеря закреплённого внешнего chinY не подменяется видимым носом или ртом', () => {
  const pullup = analyzer();
  feed(pullup, 0, { face: 'both' }, { chinY: 430 / HEIGHT });
  feed(pullup, 100, { angle: 140, shoulderY: 400, face: 'both' }, { chinY: 330 / HEIGHT });
  const result = feed(pullup, 300, { angle: 70, shoulderY: 190, face: 'both' });
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.equal(result.repCount, 0);
  assert.match(result.feedbackMessage, /попытка отменена/);
});

test('некорректная внешняя координата и формат опций отклоняются', () => {
  for (const chinY of [-0.01, 1.01, NaN, Infinity, '0.2']) {
    assert.throws(() => feed(analyzer(), 0, {}, { chinY }), RangeError);
  }
  assert.throws(() => feed(analyzer(), 0, {}, 0.5), TypeError);
  assert.equal(feed(analyzer(), 0, { face: 'none' }, { chinY: 0.7 }).headReference, 'external');
});

for (const [deltaLeft, deltaRight, warning] of [[50, 25, false], [80, 30, true]]) {
  test(`скорость плеч за 200 мс: подъёмы ${deltaLeft}/${deltaRight} px, асимметрия ${warning}`, () => {
    const pullup = analyzer();
    feed(pullup, 0);
    feed(pullup, 100, { angle: 160, shoulderY: 500 - deltaLeft / 2,
      rightShoulderY: 500 - deltaRight / 2 });
    const result = feed(pullup, 200, { angle: 145, shoulderY: 500 - deltaLeft,
      rightShoulderY: 500 - deltaRight });
    assert.equal(result.currentErrors.includes(ERROR.ASYMMETRY), warning);
    if (warning) assert.match(result.feedbackMessage, /Тяните равномерно обеими руками/);
  });
}

test('порог 0,8 ширины плеч в секунду строгий', () => {
  // Ширина 170 px, окно 0,2 c: разница 27,2 px соответствует ровно 0,8.
  for (const [difference, expected] of [[27.19, false], [27.2, false], [27.21, true]]) {
    const pullup = analyzer();
    feed(pullup, 0);
    const result = feed(pullup, 200, { angle: 150, shoulderY: 450,
      rightShoulderY: 500 - (50 - difference) });
    assert.equal(result.currentErrors.includes(ERROR.ASYMMETRY), expected, String(difference));
  }
});

test('при подъёме замечается и случай, когда одно плечо растёт, а другое опускается', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  feed(pullup, 100, { angle: 145, shoulderY: 400 });
  feed(pullup, 200, { angle: 140, shoulderY: 390, rightShoulderY: 410 });
  const result = feed(pullup, 300, { angle: 130, shoulderY: 360, rightShoulderY: 440 });
  assert.ok(result.currentErrors.includes(ERROR.ASYMMETRY));
});

test('разные исходные высоты плеч не считаются разницей скоростей', () => {
  const pullup = analyzer();
  feed(pullup, 0, { shoulderY: 500, rightShoulderY: 470 });
  feed(pullup, 100, { angle: 160, shoulderY: 470, rightShoulderY: 440 });
  const result = feed(pullup, 200, { angle: 145, shoulderY: 430, rightShoulderY: 400 });
  assert.ok(!result.currentErrors.includes(ERROR.ASYMMETRY));
});

test('подсказка асимметрии не возникает из-за разных скоростей опускания', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  feed(pullup, 100, { angle: 140, shoulderY: 400 });
  feed(pullup, 300, { angle: 70, shoulderY: 190 });
  const down = feed(pullup, 500, { angle: 110, shoulderY: 250, rightShoulderY: 300 });
  assert.ok(!down.currentErrors.includes(ERROR.ASYMMETRY));
});

test('асимметрия после подтверждения сохраняется в итоговом кадре', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  feed(pullup, 100, { angle: 160, shoulderY: 460, rightShoulderY: 485 });
  const uneven = feed(pullup, 200, { angle: 145, shoulderY: 420, rightShoulderY: 470 });
  assert.ok(uneven.currentErrors.includes(ERROR.ASYMMETRY));
  feed(pullup, 400, { angle: 70, shoulderY: 190 });
  const result = feed(pullup, 600);
  assert.equal(result.repCount, 1);
  assert.ok(result.currentErrors.includes(ERROR.ASYMMETRY));
  assert.ok(!feed(pullup, 700).currentErrors.includes(ERROR.ASYMMETRY));
});

for (const mirrored of [false, true]) {
  for (const [width, height] of [[900, 800], [720, 1280], [1800, 1600]]) {
    test(`учёт размеров ${width}×${height} и зеркала ${mirrored}`, () => {
      const pullup = analyzer({ videoWidth: width, videoHeight: height });
      const result = fullRep(pullup, { width, height, mirrored });
      assert.equal(result.repCount, 1);
      assert.deepEqual(result.currentErrors, []);
    });
  }
}

test('смещение всех точек и кистей вместе не является подъёмом тела относительно турника', () => {
  const pullup = analyzer();
  feed(pullup, 0);
  const shifted = feed(pullup, 200, { shiftY: -50 });
  assert.equal(shifted.currentPhase, PHASE.HANG);
  assert.equal(shifted.repCount, 0);
});

for (const index of [11, 12, 13, 14, 15, 16]) {
  test(`потеря обязательной точки ${index} отменяет незавершённый повтор`, () => {
    const pullup = analyzer();
    feed(pullup, 0);
    feed(pullup, 100, { angle: 145, shoulderY: 400 });
    const missing = makePose({ angle: 70, shoulderY: 190 });
    missing[index] = null;
    assert.equal(pullup.update(missing, 300).currentPhase, PHASE.WAITING);
    assert.equal(feed(pullup, 500).repCount, 0);
  });
}

test('потеря позы сохраняет счёт, но не достраивает прерванный повтор', () => {
  const pullup = analyzer();
  assert.equal(fullRep(pullup).repCount, 1);
  feed(pullup, 800, { angle: 145, shoulderY: 400 });
  const missing = pullup.update(null, 900);
  assert.equal(missing.repCount, 1);
  assert.equal(missing.currentPhase, PHASE.WAITING);
  assert.equal(feed(pullup, 1000).repCount, 1);
});

for (const [property, value] of [['visibility', 0.49], ['presence', 0.49], ['visibility', NaN],
  ['x', -0.1], ['y', NaN]]) {
  test(`невалидное значение ${property}=${value} отбрасывает точку`, () => {
    const pose = makePose();
    pose[11][property] = value;
    assert.equal(analyzer().update(pose, 0).currentPhase, PHASE.WAITING);
  });
}

test('порог confidence 0,5 включительно; Z не участвует в оценке', () => {
  const pose = makePose({ confidence: 0.5 });
  for (const id of [0, 9, 10, 11, 12, 13, 14, 15, 16]) pose[id].z = NaN;
  assert.equal(analyzer().update(pose, 0).currentPhase, PHASE.HANG);
});

test('узкий профиль плеч отбраковывается, но строгий ракурс автоматически не доказывается', () => {
  const pose = makePose();
  pose[12].x = pose[11].x + 5 / WIDTH;
  const result = analyzer().update(pose, 0);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.match(result.feedbackMessage, /боковой ракурс/);
});

test('пропуск кадров более заданного лимита отменяет попытку', () => {
  const pullup = analyzer({ maxFrameGapMs: 500 });
  feed(pullup, 0);
  feed(pullup, 100, { angle: 140, shoulderY: 400 });
  const late = feed(pullup, 601, { angle: 70, shoulderY: 190 });
  assert.equal(late.currentPhase, PHASE.WAITING);
  assert.equal(feed(pullup, 800).repCount, 0);
});

test('временные отметки должны строго возрастать внутри отслеживания', () => {
  const pullup = analyzer();
  feed(pullup, 100);
  for (const time of [100, 99, -1, NaN, Infinity]) assert.throws(() => feed(pullup, time), RangeError);
  assert.equal(feed(pullup, 101).currentPhase, PHASE.HANG);
  pullup.resetTracking();
  assert.equal(feed(pullup, 0).currentPhase, PHASE.HANG);
  assert.throws(() => analyzer({ maxFrameGapMs: 0 }), TypeError);
});

test('если временная отметка опущена, применяется performance.now()', () => {
  const pullup = analyzer();
  let result;
  for (const [angle, shoulderY] of [[170, 500], [145, 400], [70, 190], [120, 330], [170, 500]]) {
    result = pullup.update(makePose({ angle, shoulderY }));
  }
  assert.equal(result.repCount, 1);
});

test('неизменный размер не сбрасывает попытку, смена разрешения с тем же аспектом сбрасывает', () => {
  const first = analyzer();
  feed(first, 0);
  feed(first, 100, { angle: 145, shoulderY: 400 });
  first.setFrameSize(WIDTH, HEIGHT);
  feed(first, 300, { angle: 70, shoulderY: 190 });
  assert.equal(feed(first, 600).repCount, 1);

  const second = analyzer();
  assert.equal(fullRep(second).repCount, 1);
  feed(second, 800, { angle: 145, shoulderY: 400 });
  second.setFrameSize(WIDTH * 2, HEIGHT * 2);
  assert.equal(second.currentPhase, PHASE.WAITING);
  assert.equal(feed(second, 900, { angle: 70, shoulderY: 190 }).repCount, 1);
  assert.equal(feed(second, 1000).repCount, 1);
});

test('setFrameSize валидирует размеры; reset и resetTracking управляют счётчиком', () => {
  const pullup = analyzer();
  assert.equal(fullRep(pullup).repCount, 1);
  for (const size of [[0, 800], [900, -1], [NaN, 800], [900, Infinity]]) {
    assert.throws(() => pullup.setFrameSize(...size), TypeError);
  }
  pullup.resetTracking();
  assert.equal(pullup.repCount, 1);
  assert.equal(pullup.currentPhase, PHASE.WAITING);
  pullup.reset();
  assert.equal(pullup.repCount, 0);
});
