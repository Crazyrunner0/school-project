import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const geometrySource = await readFile(new URL('../geometry.js', import.meta.url));
const geometryUrl = `data:text/javascript;base64,${geometrySource.toString('base64')}`;
const analyzerSource = (await readFile(new URL('../overheadPressAnalyzer.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`);
const analyzerUrl = `data:text/javascript;base64,${Buffer.from(analyzerSource).toString('base64')}`;
const { OverheadPressAnalyzer, OVERHEAD_PHASE: PHASE, OVERHEAD_ERROR: ERROR } = await import(analyzerUrl);

const WIDTH = 640;
const HEIGHT = 480;

// Угол локтя и подъём руки задаются независимо от нормировки кадра.
function makePose(leftAngle, {
  rightAngle = leftAngle, span = 160, lean = 0, mirrored = false,
  face = true, hips = true, confidence = 1, rightYOffset = 0, z = undefined
} = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const indices = {
    left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23 },
    right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24 }
  };
  const radians = (degrees) => degrees * Math.PI / 180;
  function set(index, x, y) {
    const point = { x: (mirrored ? WIDTH - x : x) / WIDTH, y: y / HEIGHT,
      visibility: confidence, presence: confidence };
    if (z !== undefined) point.z = z;
    points[index] = point;
  }
  for (const name of ['left', 'right']) {
    const angle = name === 'left' ? leftAngle : rightAngle;
    const xOffset = name === 'left' ? -span / 2 : span / 2;
    const yOffset = name === 'right' ? rightYOffset : 0;
    const hip = { x: 320 + xOffset, y: 360 + yOffset };
    const shoulder = {
      x: hip.x + 140 * Math.sin(radians(lean)),
      y: hip.y - 140 * Math.cos(radians(lean))
    };
    const t = Math.max(0, Math.min(1, (angle - 70) / 100));
    const upperDirection = 116.565051177 + 145.30484647 * t;
    const upper = { x: 70 * Math.cos(radians(upperDirection)), y: 70 * Math.sin(radians(upperDirection)) };
    const foreDirection = upperDirection - 180 - angle;
    const fore = { x: 70 * Math.cos(radians(foreDirection)), y: 70 * Math.sin(radians(foreDirection)) };
    const sign = name === 'left' ? 1 : -1;
    const elbow = { x: shoulder.x + sign * upper.x, y: shoulder.y + upper.y };
    const wrist = { x: elbow.x + sign * fore.x, y: elbow.y + fore.y };
    set(indices[name].shoulder, shoulder.x, shoulder.y);
    set(indices[name].elbow, elbow.x, elbow.y);
    set(indices[name].wrist, wrist.x, wrist.y);
    if (hips) set(indices[name].hip, hip.x, hip.y);
  }
  if (face) {
    const centerX = 320 + 140 * Math.sin(radians(lean));
    const shoulderY = 360 - 140 * Math.cos(radians(lean));
    set(0, centerX + 30, shoulderY - 28);
    set(7, centerX + 3, shoulderY - 20);
    set(8, centerX + 8, shoulderY - 20);
  }
  return points;
}
function analyzer(options = {}) {
  return new OverheadPressAnalyzer({ videoWidth: WIDTH, videoHeight: HEIGHT, ...options });
}
function feed(press, angle, options = {}) { return press.update(makePose(angle, options)); }
function fullRep(press, options = {}) {
  for (const angle of [70, 100, 150, 170, 160, 100]) feed(press, angle, options);
  return feed(press, 70, options);
}

test('фазы жима и возврат в старт для подсчёта повторения', () => {
  const press = analyzer();
  let result = feed(press, 70);
  assert.deepEqual(Object.keys(result), ['repCount', 'currentPhase', 'currentErrors', 'feedbackMessage']);
  assert.equal(result.currentPhase, PHASE.START);
  assert.equal(feed(press, 100).currentPhase, PHASE.PRESSING);
  assert.equal(feed(press, 150).currentPhase, PHASE.PRESSING);
  assert.equal(feed(press, 170).currentPhase, PHASE.LOCKOUT);
  assert.equal(feed(press, 165).currentPhase, PHASE.LOWERING);
  assert.equal(feed(press, 100).repCount, 0);
  result = feed(press, 70);
  assert.equal(result.currentPhase, PHASE.START);
  assert.equal(result.repCount, 1);
  assert.deepEqual(result.currentErrors, []);
  assert.match(result.feedbackMessage, /Повтор засчитан/);
  assert.equal(feed(press, 70).repCount, 1);
});

test('старт: обе руки 60–80°, точки в верхнем положении не запускают подсчёт', () => {
  for (const angle of [60, 70, 80]) {
    assert.equal(feed(analyzer(), angle).currentPhase, PHASE.START, String(angle));
  }
  for (const angle of [59.99, 80.01, 170]) {
    assert.equal(feed(analyzer(), angle).currentPhase, PHASE.WAITING, String(angle));
  }
  const press = analyzer();
  feed(press, 170); feed(press, 100);
  assert.equal(feed(press, 70).repCount, 0);
});

test('фиксация требует больше 165° одновременно в обоих локтях', () => {
  const press = analyzer();
  feed(press, 70); feed(press, 120);
  assert.equal(feed(press, 165).currentPhase, PHASE.PRESSING);
  assert.notEqual(feed(press, 170, { rightAngle: 165 }).currentPhase, PHASE.LOCKOUT);
  assert.equal(feed(press, 165.01).currentPhase, PHASE.LOCKOUT);
});

test('полностью прямые горизонтальные руки не объявляются выжиманием над головой', () => {
  const press = analyzer();
  feed(press, 70);
  const pose = makePose(170);
  for (const [shoulder, elbow, wrist, sign] of [[11, 13, 15, -1], [12, 14, 16, 1]]) {
    pose[elbow].x = pose[shoulder].x + sign * 60 / WIDTH;
    pose[elbow].y = pose[shoulder].y;
    pose[wrist].x = pose[shoulder].x + sign * 120 / WIDTH;
    pose[wrist].y = pose[shoulder].y;
  }
  const horizontal = press.update(pose);
  assert.notEqual(horizontal.currentPhase, PHASE.LOCKOUT);
  const finish = feed(press, 70);
  assert.equal(finish.repCount, 0); // горизонтальное разгибание — не вертикальный жим
});

test('частичный жим считается с предупреждением при лучшем угле ниже 160°', () => {
  const press = analyzer();
  feed(press, 70); feed(press, 110); feed(press, 159);
  const turn = feed(press, 155);
  assert.equal(turn.currentPhase, PHASE.LOWERING);
  assert.ok(turn.currentErrors.includes(ERROR.SHORT_PRESS));
  assert.match(turn.feedbackMessage, /Полностью выпрямляйте обе руки/);
  const finish = feed(press, 70);
  assert.equal(finish.repCount, 1);
  assert.ok(finish.currentErrors.includes(ERROR.SHORT_PRESS));
  assert.match(finish.feedbackMessage, /Повтор засчитан/);
});

test('160–165° — не недожим <160°, но и не LOCKOUT', () => {
  for (const angle of [160, 162, 165]) {
    const press = analyzer();
    feed(press, 70); feed(press, 120);
    assert.notEqual(feed(press, angle).currentPhase, PHASE.LOCKOUT);
    const turn = feed(press, angle - 4);
    assert.ok(!turn.currentErrors.includes(ERROR.SHORT_PRESS), String(angle));
    const finish = feed(press, 70);
    assert.equal(finish.repCount, 1);
    assert.ok(!finish.currentErrors.includes(ERROR.SHORT_PRESS));
    assert.match(finish.feedbackMessage, /полностью выпрямить руки над головой/i);
  }
});

test('нижняя лучшая одновременная степень выпрямления учитывает обе руки', () => {
  const press = analyzer();
  feed(press, 70); feed(press, 110);
  feed(press, 170, { rightAngle: 155 });
  const turn = feed(press, 155, { rightAngle: 150 });
  assert.ok(turn.currentErrors.includes(ERROR.SHORT_PRESS));
  const result = feed(press, 70);
  assert.equal(result.repCount, 1);
  assert.ok(result.currentErrors.includes(ERROR.SHORT_PRESS));
});

test('плато не называется LOCKOUT и после паузы можно продолжить жим', () => {
  const press = analyzer();
  feed(press, 70); feed(press, 110);
  for (let i = 0; i < 5; i += 1) assert.equal(feed(press, 150).currentPhase, PHASE.PRESSING);
  const top = feed(press, 150);
  assert.equal(top.currentPhase, PHASE.TOP);
  assert.ok(top.currentErrors.includes(ERROR.SHORT_PRESS));
  assert.equal(feed(press, 155).currentPhase, PHASE.PRESSING);
  const lockout = feed(press, 170);
  assert.equal(lockout.currentPhase, PHASE.LOCKOUT);
  assert.ok(!lockout.currentErrors.includes(ERROR.SHORT_PRESS));
  feed(press, 150);
  assert.equal(feed(press, 70).repCount, 1);
});

test('шум и возврат к старту без необходимой амплитуды не считаются повтором', () => {
  const press = analyzer();
  feed(press, 70); feed(press, 74);
  const finish = feed(press, 70);
  assert.equal(finish.currentPhase, PHASE.START);
  assert.equal(finish.repCount, 0);
  assert.ok(!finish.currentErrors.includes(ERROR.SHORT_PRESS));
  for (let i = 0; i < 6; i += 1) assert.equal(feed(press, 70).repCount, 0);
});

test('асимметрия локтевых углов строго больше 15°', () => {
  for (const [rightAngle, asymmetric] of [[115, false], [115.01, true], [130, true]]) {
    const press = analyzer({ view: 'front' });
    feed(press, 70, { hips: false });
    const result = feed(press, 100, { rightAngle, hips: false });
    assert.equal(result.currentErrors.includes(ERROR.ASYMMETRY), asymmetric, String(rightAngle));
    if (asymmetric) assert.match(result.feedbackMessage, /Выжимайте вес равномерно обеими руками/);
    assert.match(result.feedbackMessage, /проверка высоты кистей недоступна/i);
  }
});

test('асимметрия высоты: строго больше 15% среднего расстояния плечо–таз', () => {
  for (const [offset, asymmetric] of [[21, false], [21.01, true], [30, true]]) {
    const press = analyzer({ view: 'front' });
    feed(press, 70);
    const result = feed(press, 100, { rightYOffset: offset });
    assert.equal(result.currentErrors.includes(ERROR.ASYMMETRY), asymmetric, String(offset));
  }
});

test('асимметрия сохраняется до завершения повтора и не переносится на следующий', () => {
  const press = analyzer({ view: 'front' });
  feed(press, 70);
  assert.ok(feed(press, 110, { rightAngle: 130 }).currentErrors.includes(ERROR.ASYMMETRY));
  feed(press, 150); feed(press, 170); feed(press, 150);
  const finish = feed(press, 70);
  assert.ok(finish.currentErrors.includes(ERROR.ASYMMETRY));
  assert.equal(finish.repCount, 1);
  const next = feed(press, 100);
  assert.ok(!next.currentErrors.includes(ERROR.ASYMMETRY));
});

test('сбоку прогиб — отклонение плеч назад строго более 15° от исходного', () => {
  const press = analyzer({ view: 'side', facingDirection: 'right' });
  feed(press, 70, { span: 16, lean: 5, face: false });
  feed(press, 110, { span: 16, lean: 5, face: false });
  let result = feed(press, 130, { span: 16, lean: -10, face: false });
  assert.ok(!result.currentErrors.includes(ERROR.BACK_LEAN));
  result = feed(press, 140, { span: 16, lean: -10.01, face: false });
  assert.ok(result.currentErrors.includes(ERROR.BACK_LEAN));
  assert.match(result.feedbackMessage, /Не прогибайте поясницу, зафиксируйте кор/);
});

test('наклон вперёд не называется прогибом назад', () => {
  const press = analyzer({ view: 'side', facingDirection: 'right' });
  feed(press, 70, { span: 16 }); feed(press, 110, { span: 16 });
  const result = feed(press, 130, { span: 16, lean: 25 });
  assert.ok(!result.currentErrors.includes(ERROR.BACK_LEAN));
});

test('авторакурс и видимое лицо определяют направление назад, в том числе в зеркале', () => {
  for (const mirrored of [false, true]) {
    const press = analyzer();
    feed(press, 70, { span: 16, mirrored });
    feed(press, 110, { span: 16, mirrored });
    const result = feed(press, 130, { span: 16, mirrored, lean: -20 });
    assert.ok(result.currentErrors.includes(ERROR.BACK_LEAN), String(mirrored));
  }
});

test('анфас и неуверенный промежуточный ракурс не сообщают о прогибе назад', () => {
  for (const span of [160, 70]) {
    const press = analyzer();
    feed(press, 70, { span }); feed(press, 110, { span });
    const result = feed(press, 130, { span, lean: -25 });
    assert.ok(!result.currentErrors.includes(ERROR.BACK_LEAN));
    if (span === 70) assert.match(result.feedbackMessage, /Ракурс не определён/);
  }
});

test('без лица или явной настройки направление назад не выдумывается', () => {
  const press = analyzer({ view: 'side' });
  feed(press, 70, { span: 16, face: false });
  feed(press, 110, { span: 16, face: false });
  const result = feed(press, 130, { span: 16, face: false, lean: -20 });
  assert.ok(!result.currentErrors.includes(ERROR.BACK_LEAN));
  assert.match(result.feedbackMessage, /лицо и таз|направление/i);
  // Лицо появилось позже, но исходное направление не было известно.
  const late = feed(press, 140, { span: 16, face: true, lean: -20 });
  assert.ok(!late.currentErrors.includes(ERROR.BACK_LEAN));
});

test('исторический прогиб скрывается, если текущее направление неизвестно', () => {
  const press = analyzer({ view: 'side' });
  feed(press, 70, { span: 16 }); feed(press, 110, { span: 16 });
  assert.ok(feed(press, 130, { span: 16, lean: -20 }).currentErrors.includes(ERROR.BACK_LEAN));
  const lost = feed(press, 140, { span: 16, lean: -20, face: false });
  assert.ok(!lost.currentErrors.includes(ERROR.BACK_LEAN));
  assert.doesNotMatch(lost.feedbackMessage, /Не прогибайте/);
  assert.ok(feed(press, 150, { span: 16, lean: -20 }).currentErrors.includes(ERROR.BACK_LEAN));
});

test('без таза можно проверить углы и считать, но нельзя заявлять полную проверку техники', () => {
  const press = analyzer({ view: 'front' });
  const start = feed(press, 70, { hips: false });
  assert.match(start.feedbackMessage, /проверка высоты кистей недоступна/i);
  const result = fullRep(press, { hips: false });
  assert.equal(result.repCount, 1);
  assert.match(result.feedbackMessage, /проверка высоты кистей недоступна/i);
});

test('краткая потеря руки приостанавливает фазу, длительная отменяет попытку', () => {
  const press = analyzer();
  assert.equal(fullRep(press).repCount, 1);
  feed(press, 110); feed(press, 150);
  const missing = makePose(150);
  missing[16].visibility = 0.49;
  for (let i = 0; i < 9; i += 1) assert.equal(press.update(missing).repCount, 1);
  assert.equal(press.update(missing).currentPhase, PHASE.WAITING);
  assert.equal(feed(press, 70).repCount, 1);
});

test('resetTracking, reset и настройки сохраняют счёт, пока его не обнулят', () => {
  const press = analyzer();
  fullRep(press);
  feed(press, 110);
  press.resetTracking();
  assert.equal(press.repCount, 1);
  assert.equal(press.currentPhase, PHASE.WAITING);
  press.setView('side');
  press.setFacingDirection('right');
  assert.equal(press.repCount, 1);
  assert.throws(() => press.setView('three-quarter'), TypeError);
  assert.throws(() => press.setFacingDirection('forward'), TypeError);
  assert.throws(() => press.setFrameSize(0, 480), TypeError);
  feed(press, 70, { span: 16 });
  press.setFrameSize(1280, 960);
  assert.equal(press.currentPhase, PHASE.START);
  press.setFrameSize(640, 640);
  assert.equal(press.currentPhase, PHASE.WAITING);
  press.reset();
  assert.equal(press.repCount, 0);
});


test('угол недожима измеряется в верхней точке кистей, не при горизонтальном разгибании', () => {
  const press = analyzer();
  feed(press, 70);
  const horizontal = makePose(170);
  for (const [shoulder, elbow, wrist, sign] of [[11, 13, 15, -1], [12, 14, 16, 1]]) {
    horizontal[elbow].x = horizontal[shoulder].x + sign * 60 / WIDTH;
    horizontal[elbow].y = horizontal[shoulder].y;
    horizontal[wrist].x = horizontal[shoulder].x + sign * 120 / WIDTH;
    horizontal[wrist].y = horizontal[shoulder].y;
  }
  press.update(horizontal); // локти ~180°, но кисти ещё не подняты
  assert.equal(feed(press, 155).currentPhase, PHASE.PRESSING);
  const turn = feed(press, 150);
  assert.equal(turn.currentPhase, PHASE.LOWERING);
  assert.ok(turn.currentErrors.includes(ERROR.SHORT_PRESS));
  const finish = feed(press, 70);
  assert.equal(finish.repCount, 1);
  assert.ok(finish.currentErrors.includes(ERROR.SHORT_PRESS));
});


test('одна поднятая рука не считается жимом и после возврата не блокирует следующий повтор', () => {
  const press = analyzer();
  feed(press, 70);
  const one = feed(press, 140, { rightAngle: 70 });
  assert.ok(one.currentErrors.includes(ERROR.ASYMMETRY));
  const returned = feed(press, 70);
  assert.equal(returned.currentPhase, PHASE.START);
  assert.equal(returned.repCount, 0);
  const next = feed(press, 100);
  assert.ok(!next.currentErrors.includes(ERROR.ASYMMETRY));
  for (const angle of [150, 170, 150, 70]) feed(press, angle);
  assert.equal(press.repCount, 1);
});

test('заметный неполный жим обеими руками считается после возврата', () => {
  const press = analyzer();
  feed(press, 70); feed(press, 90);
  const finish = feed(press, 70);
  assert.equal(finish.repCount, 1);
  assert.ok(finish.currentErrors.includes(ERROR.SHORT_PRESS));
});

test('угол 60–80° не считается стартом, если кисти далеко от уровня плеч', () => {
  const pose = makePose(70);
  for (const [shoulderIndex, elbowIndex, wristIndex, angle] of [[11, 13, 15, -Math.PI / 2], [12, 14, 16, Math.PI / 2]]) {
    const shoulder = pose[shoulderIndex];
    for (const index of [elbowIndex, wristIndex]) {
      const dx = (pose[index].x - shoulder.x) * WIDTH;
      const dy = (pose[index].y - shoulder.y) * HEIGHT;
      pose[index].x = shoulder.x + (dx * Math.cos(angle) - dy * Math.sin(angle)) / WIDTH;
      pose[index].y = shoulder.y + (dx * Math.sin(angle) + dy * Math.cos(angle)) / HEIGHT;
    }
  }
  assert.equal(analyzer().update(pose).currentPhase, PHASE.WAITING);
});

test('выпрямление рук в разные моменты не создаёт ложный одновременный LOCKOUT', () => {
  const press = analyzer();
  feed(press, 70); feed(press, 110);
  assert.notEqual(feed(press, 170, { rightAngle: 150 }).currentPhase, PHASE.LOCKOUT);
  assert.notEqual(feed(press, 150, { rightAngle: 170 }).currentPhase, PHASE.LOCKOUT);
  const turn = feed(press, 130);
  assert.ok(turn.currentErrors.includes(ERROR.SHORT_PRESS));
  assert.equal(feed(press, 70).repCount, 1);
});

test('один видимый таз позволяет оценить высоту кистей по доступной стороне', () => {
  const press = analyzer({ view: 'front' });
  feed(press, 70);
  const pose = makePose(100, { rightYOffset: 21.01 });
  pose[24].visibility = 0;
  const result = press.update(pose);
  assert.ok(result.currentErrors.includes(ERROR.ASYMMETRY));
  assert.doesNotMatch(result.feedbackMessage, /проверка высоты кистей недоступна/i);
});

test('отклонение назад только при опускании не отмечается ошибкой жима', () => {
  const press = analyzer({ view: 'side', facingDirection: 'right' });
  feed(press, 70, { span: 16 }); feed(press, 110, { span: 16 });
  feed(press, 170, { span: 16 });
  const down = feed(press, 140, { span: 16, lean: -20 });
  assert.equal(down.currentPhase, PHASE.LOWERING);
  assert.ok(!down.currentErrors.includes(ERROR.BACK_LEAN));
  const finish = feed(press, 70, { span: 16, lean: -20 });
  assert.equal(finish.repCount, 1);
  assert.ok(!finish.currentErrors.includes(ERROR.BACK_LEAN));
});

test('выбранное направление left работает с зеркальными landmarks', () => {
  const press = analyzer({ view: 'side', facingDirection: 'left' });
  feed(press, 70, { span: 16, mirrored: true, face: false });
  feed(press, 110, { span: 16, mirrored: true, face: false });
  const result = feed(press, 130, { span: 16, mirrored: true, face: false, lean: -20 });
  assert.ok(result.currentErrors.includes(ERROR.BACK_LEAN));
});

test('потеря опорного таза не заменяется другим тазом в середине повтора', () => {
  const press = analyzer({ view: 'side', facingDirection: 'right' });
  feed(press, 70, { span: 16 }); feed(press, 110, { span: 16 });
  const missing = makePose(130, { span: 16, lean: -20 });
  missing[23].visibility = 0;
  const result = press.update(missing);
  assert.ok(!result.currentErrors.includes(ERROR.BACK_LEAN));
  assert.match(result.feedbackMessage, /плечо и таз/i);
});

test('поворот лица при завершении не возвращает старое предупреждение о прогибе', () => {
  const press = analyzer({ view: 'side' });
  feed(press, 70, { span: 16 }); feed(press, 110, { span: 16 });
  assert.ok(feed(press, 140, { span: 16, lean: -20 }).currentErrors.includes(ERROR.BACK_LEAN));
  feed(press, 170, { span: 16 }); feed(press, 140, { span: 16 });
  const finishPose = makePose(70, { span: 16 });
  finishPose[0].x = finishPose[7].x - 0.06;
  const finish = press.update(finishPose);
  assert.equal(finish.repCount, 1);
  assert.ok(!finish.currentErrors.includes(ERROR.BACK_LEAN));
  assert.match(finish.feedbackMessage, /Направление изменилось/);
});

test('масштаб кадра и частичное отсутствие Z не искажают углы', () => {
  const standard = analyzer();
  const wide = new OverheadPressAnalyzer({ videoWidth: 960, videoHeight: HEIGHT });
  for (const angle of [70, 110, 150, 170, 150, 70]) {
    const original = makePose(angle, { z: 0 });
    const reshaped = original.map((point) => ({ ...point, x: point.x * WIDTH / 960,
      ...(point.z === undefined ? {} : { z: point.z * WIDTH / 960 }) }));
    const a = standard.update(original);
    const b = wide.update(reshaped);
    assert.equal(b.currentPhase, a.currentPhase);
    assert.equal(b.repCount, a.repCount);
    assert.deepEqual(b.currentErrors, a.currentErrors);
  }
  assert.equal(wide.repCount, 1);
  const fallback = analyzer();
  const mixed = makePose(70, { z: 0 });
  delete mixed[15].z;
  assert.equal(fallback.update(mixed).currentPhase, PHASE.START);
});

test('сломанные или вышедшие за кадр точки не приводят к ложным повторам', () => {
  const press = analyzer();
  for (const pose of [null, [], makePose(70, { confidence: 0.49 })]) {
    const result = press.update(pose);
    assert.equal(result.repCount, 0);
    assert.equal(result.currentPhase, PHASE.WAITING);
  }
  const coincident = makePose(70);
  coincident[13] = { ...coincident[11] };
  assert.equal(press.update(coincident).repCount, 0);
  const outside = makePose(70);
  outside[16].x = 1.1;
  assert.equal(press.update(outside).currentPhase, PHASE.WAITING);
});


test('при частичном Z обе руки сравниваются в 2D, чтобы не создавать ложную асимметрию', () => {
  const pose = makePose(70, { z: 0 });
  pose[16].z = 0.2; // другая рука имеет заметную глубину
  delete pose[15].z; // неполный Z требует 2D для обеих
  const result = analyzer({ view: 'front' }).update(pose);
  assert.equal(result.currentPhase, PHASE.START);
  assert.ok(!result.currentErrors.includes(ERROR.ASYMMETRY));
});


test('смена размерности в ходе жима отменяет незавершённый цикл без потери счёта', () => {
  const press = analyzer();
  feed(press, 70, { z: 0 }); feed(press, 110, { z: 0 });
  const mixed = makePose(150, { z: 0 });
  delete mixed[15].z;
  const result = press.update(mixed);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.equal(result.repCount, 0);
  assert.equal(feed(press, 70).currentPhase, PHASE.START);
  assert.equal(fullRep(press).repCount, 1);
});


test('при прямых руках ниже головы совет касается высоты, а не выпрямления локтей', () => {
  const press = analyzer({ view: 'front' });
  feed(press, 70);
  const pose = makePose(170);
  for (const [shoulder, elbow, wrist, sign] of [[11, 13, 15, -1], [12, 14, 16, 1]]) {
    pose[elbow].x = pose[shoulder].x + sign * 60 / WIDTH; pose[elbow].y = pose[shoulder].y;
    pose[wrist].x = pose[shoulder].x + sign * 120 / WIDTH; pose[wrist].y = pose[shoulder].y;
  }
  let result;
  for (let i = 0; i < 6; i += 1) result = press.update(pose);
  assert.equal(result.currentPhase, PHASE.TOP);
  assert.ok(!result.currentErrors.includes(ERROR.SHORT_PRESS));
  assert.match(result.feedbackMessage, /Поднимите кисти выше/);
});

test('полные 3D-координаты обеих рук используются для сравнения углов', () => {
  const pose = makePose(60, { z: 0 });
  pose[16].z = 0.2;
  const result = analyzer({ view: 'front' }).update(pose);
  assert.ok(result.currentErrors.includes(ERROR.ASYMMETRY));
});

test('при одном ухе для автоматического направления необходим противоположный глаз', () => {
  const press = analyzer({ view: 'side' });
  function profile(angle, lean = 0, withEye = true) {
    const pose = makePose(angle, { span: 16, lean });
    pose[8].visibility = 0;
    if (withEye) pose[5] = { ...pose[0], x: pose[0].x - 0.02 };
    return pose;
  }
  press.update(profile(70)); press.update(profile(110));
  assert.ok(press.update(profile(130, -20)).currentErrors.includes(ERROR.BACK_LEAN));
  const missing = analyzer({ view: 'side' });
  missing.update(profile(70, 0, false)); missing.update(profile(110, 0, false));
  assert.ok(!missing.update(profile(130, -20, false)).currentErrors.includes(ERROR.BACK_LEAN));
});

test('при фронтальном ракурсе явно обозначается недоступность оценки корпуса назад', () => {
  const press = analyzer({ view: 'front' });
  feed(press, 70);
  const result = feed(press, 110);
  assert.match(result.feedbackMessage, /только при боковом ракурсе/);
});


test('прямые руки недостаточно высоко относительно плеч не становятся LOCKOUT', () => {
  const press = analyzer({ view: 'front' });
  feed(press, 70);
  function extended(degrees) {
    const pose = makePose(170);
    for (const [shoulder, elbow, wrist, sign] of [[11, 13, 15, -1], [12, 14, 16, 1]]) {
      const dx = sign * 70 * Math.cos(degrees * Math.PI / 180);
      const dy = -70 * Math.sin(degrees * Math.PI / 180);
      pose[elbow].x = pose[shoulder].x + dx / WIDTH;
      pose[elbow].y = pose[shoulder].y + dy / HEIGHT;
      pose[wrist].x = pose[shoulder].x + 2 * dx / WIDTH;
      pose[wrist].y = pose[shoulder].y + 2 * dy / HEIGHT;
    }
    return pose;
  }
  assert.notEqual(press.update(extended(30)).currentPhase, PHASE.LOCKOUT);
  assert.equal(press.update(extended(45)).currentPhase, PHASE.LOCKOUT);
});
