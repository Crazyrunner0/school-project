import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const geometrySource = await readFile(new URL('../geometry.js', import.meta.url));
const geometryUrl = `data:text/javascript;base64,${geometrySource.toString('base64')}`;
const analyzerSource = (await readFile(new URL('../lungeAnalyzer.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`);
const analyzerUrl = `data:text/javascript;base64,${Buffer.from(analyzerSource).toString('base64')}`;
const { LungeAnalyzer, LUNGE_PHASE: PHASE, LUNGE_ERROR: ERROR } = await import(analyzerUrl);

const WIDTH = 640;
const HEIGHT = 480;

// Две независимые ноги с контролируемыми углами и профилем вправо.
function makePose(frontAngle, {
  front = 'left', rearAngle = frontAngle, lean = 0, mirrored = false,
  feetClose = false, kneeShift = 0, rearKneeShift = 0, toes = 'both', shoulders = true,
  confidence = 1, z = undefined, rearGroundGap = 20
} = {}) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const indices = {
    left: { shoulder: 11, hip: 23, knee: 25, ankle: 27, toe: 31 },
    right: { shoulder: 12, hip: 24, knee: 26, ankle: 28, toe: 32 }
  };
  const rad = (value) => value * Math.PI / 180;
  function set(index, x, y) {
    const point = { x: (mirrored ? WIDTH - x : x) / WIDTH, y: y / HEIGHT,
      visibility: confidence, presence: confidence };
    if (z !== undefined) point.z = z;
    landmarks[index] = point;
  }
  for (const side of ['left', 'right']) {
    const forward = side === front;
    const ankleX = feetClose ? (forward ? 310 : 300) : (forward ? 410 : 220);
    const kneeX = ankleX + (forward ? kneeShift : rearKneeShift);
    const ankle = { x: ankleX, y: 420 };
    const knee = { x: kneeX, y: forward ? 330 : 420 - rearGroundGap };
    const toAnkle = Math.atan2(ankle.y - knee.y, ankle.x - knee.x);
    const angle = forward ? frontAngle : rearAngle;
    const toHip = toAnkle + (forward ? 1 : -1) * rad(angle);
    const hip = { x: knee.x + 90 * Math.cos(toHip), y: knee.y + 90 * Math.sin(toHip) };
    const shoulder = { x: hip.x + 100 * Math.sin(rad(lean)), y: hip.y - 100 * Math.cos(rad(lean)) };
    set(indices[side].hip, hip.x, hip.y);
    set(indices[side].knee, knee.x, knee.y);
    set(indices[side].ankle, ankle.x, ankle.y);
    if (shoulders) set(indices[side].shoulder, shoulder.x, shoulder.y);
    if (toes === 'both' || toes === (forward ? 'front' : 'rear')) set(indices[side].toe, ankle.x + 30, ankle.y);
  }
  return landmarks;
}

function analyzer(options = {}) {
  return new LungeAnalyzer({ videoWidth: WIDTH, videoHeight: HEIGHT, ...options });
}
function feed(lunge, angle, options = {}) { return lunge.update(makePose(angle, options)); }
function fullRep(lunge, options = {}) {
  for (const angle of [175, 140, 90, 94, 120]) feed(lunge, angle, options);
  return feed(lunge, 175, options);
}

test('фазы выпада и счётчик: начальная стойка, спуск, минимум, подъём и стойка', () => {
  const lunge = analyzer();
  let result = feed(lunge, 175);
  assert.deepEqual(Object.keys(result), ['repCount', 'currentPhase', 'currentErrors', 'feedbackMessage']);
  assert.equal(result.currentPhase, PHASE.STANDING);
  assert.equal(feed(lunge, 140).currentPhase, PHASE.LUNGING);
  assert.equal(lunge.activeSide, 'left');
  assert.equal(feed(lunge, 90).currentPhase, PHASE.LUNGING);
  assert.equal(feed(lunge, 94).currentPhase, PHASE.BOTTOM);
  assert.equal(feed(lunge, 120).currentPhase, PHASE.ASCENDING);
  result = feed(lunge, 175);
  assert.equal(result.currentPhase, PHASE.STANDING);
  assert.equal(result.repCount, 1);
  assert.deepEqual(result.currentErrors, []);
  assert.match(result.feedbackMessage, /Повтор засчитан/);
  assert.equal(feed(lunge, 175).repCount, 1);
});

test('для завершения нужно выпрямить обе ноги', () => {
  const lunge = analyzer();
  feed(lunge, 175); feed(lunge, 140); feed(lunge, 90); feed(lunge, 94);
  const partialStand = feed(lunge, 175, { rearAngle: 140 });
  assert.equal(partialStand.repCount, 0);
  assert.notEqual(partialStand.currentPhase, PHASE.STANDING);
  assert.equal(feed(lunge, 175).repCount, 1);
});

test('попеременные ноги и повторения в разножке считаются по одному', () => {
  const lunge = analyzer();
  assert.equal(fullRep(lunge, { front: 'left' }).repCount, 1);
  assert.equal(fullRep(lunge, { front: 'right' }).repCount, 2);
  assert.equal(fullRep(lunge, { front: 'right' }).repCount, 3);
});

test('по началу внизу или небольшой дрожи не засчитывается ложный повтор', () => {
  const lunge = analyzer();
  assert.equal(feed(lunge, 90).currentPhase, PHASE.WAITING);
  assert.equal(feed(lunge, 175).repCount, 0);
  assert.equal(feed(lunge, 159).currentPhase, PHASE.LUNGING);
  assert.equal(feed(lunge, 175).repCount, 0);
  assert.equal(feed(lunge, 175).repCount, 0);
});

test('минимум подтверждается плато без преждевременного подсчёта', () => {
  const lunge = analyzer();
  feed(lunge, 175); feed(lunge, 140);
  for (let i = 0; i < 5; i += 1) assert.equal(feed(lunge, 90).currentPhase, PHASE.LUNGING);
  const bottom = feed(lunge, 90);
  assert.equal(bottom.currentPhase, PHASE.BOTTOM);
  assert.equal(bottom.repCount, 0);
  assert.equal(feed(lunge, 94).currentPhase, PHASE.ASCENDING);
  assert.equal(feed(lunge, 175).repCount, 1);
});

test('недосед строго больше 105°, повтор при возврате засчитывается', () => {
  for (const [angle, shallow] of [[100, false], [105, false], [105.01, true], [115, true], [150, true]]) {
    const lunge = analyzer();
    feed(lunge, 175); feed(lunge, angle);
    const bottom = feed(lunge, angle + 4, { rearAngle: 90 });
    assert.equal(bottom.currentPhase, PHASE.BOTTOM, String(angle));
    assert.equal(bottom.currentErrors.includes(ERROR.SHALLOW), shallow, String(angle));
    const finish = feed(lunge, 175);
    assert.equal(finish.repCount, 1);
    assert.equal(finish.currentErrors.includes(ERROR.SHALLOW), shallow, String(angle));
    if (shallow) assert.match(finish.feedbackMessage, /Опускайтесь ниже/);
  }
});

test('85–95° и заднее колено около 90° принимаются как целевые ориентиры', () => {
  for (const angle of [85, 90, 95]) {
    const lunge = analyzer();
    feed(lunge, 175); feed(lunge, 140);
    feed(lunge, angle, { rearAngle: 90 });
    const bottom = feed(lunge, angle + 4, { rearAngle: 110 });
    assert.equal(bottom.currentPhase, PHASE.BOTTOM);
    assert.doesNotMatch(bottom.feedbackMessage, /Ориентир для переднего/);
    assert.doesNotMatch(bottom.feedbackMessage, /заднее колено/);
  }
});

test('пограничная глубина и отклонение задней ноги дают совет, а не выдуманный контакт с полом', () => {
  const lunge = analyzer();
  feed(lunge, 175); feed(lunge, 140);
  feed(lunge, 100, { rearAngle: 120 });
  const bottom = feed(lunge, 104, { rearAngle: 90 });
  assert.ok(!bottom.currentErrors.includes(ERROR.SHALLOW));
  assert.match(bottom.feedbackMessage, /85–95/);
  assert.match(bottom.feedbackMessage, /заднее колено/);
  assert.doesNotMatch(bottom.feedbackMessage, /ударилось|коснулось|не касается/);
});

test('после паузы можно опуститься глубже, и прежний недосед исчезает', () => {
  const lunge = analyzer();
  feed(lunge, 175); feed(lunge, 140);
  let bottom;
  for (let i = 0; i < 6; i += 1) bottom = feed(lunge, 120);
  assert.ok(bottom.currentErrors.includes(ERROR.SHALLOW));
  feed(lunge, 119); feed(lunge, 118);
  assert.equal(feed(lunge, 116).currentPhase, PHASE.LUNGING);
  feed(lunge, 100);
  bottom = feed(lunge, 104);
  assert.equal(bottom.currentPhase, PHASE.BOTTOM);
  assert.ok(!bottom.currentErrors.includes(ERROR.SHALLOW));
  assert.equal(feed(lunge, 175).repCount, 1);
});

test('при пропуске кадров возврат из минимума прямо в стойку засчитывает повтор', () => {
  const lunge = analyzer();
  feed(lunge, 175); feed(lunge, 120);
  const result = feed(lunge, 175);
  assert.equal(result.currentPhase, PHASE.STANDING);
  assert.equal(result.repCount, 1);
  assert.ok(result.currentErrors.includes(ERROR.SHALLOW));
});

test('колено слишком далеко за носком проверяется только у передней ноги и в обе стороны', () => {
  for (const mirrored of [false, true]) {
    const lunge = analyzer();
    feed(lunge, 175, { mirrored });
    let result = feed(lunge, 130, { mirrored, rearKneeShift: 60 });
    assert.ok(!result.currentErrors.includes(ERROR.KNEE_PAST_TOE));
    result = feed(lunge, 120, { mirrored, kneeShift: 60 });
    assert.ok(result.currentErrors.includes(ERROR.KNEE_PAST_TOE));
    assert.match(result.feedbackMessage, /Не уводите колено слишком далеко вперёд/);
    feed(lunge, 90, { mirrored });
    feed(lunge, 94, { mirrored });
    const finish = feed(lunge, 175, { mirrored });
    assert.equal(finish.repCount, 1);
    assert.ok(finish.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  }
});

test('для положения колена за носком применяется допуск, а не любое пересечение', () => {
  const near = analyzer();
  feed(near, 175);
  assert.ok(!feed(near, 130, { kneeShift: 38 }).currentErrors.includes(ERROR.KNEE_PAST_TOE));
  const far = analyzer();
  feed(far, 175);
  assert.ok(feed(far, 130, { kneeShift: 42 }).currentErrors.includes(ERROR.KNEE_PAST_TOE));
});

test('наклон вперёд строго больше 20° — ошибка; 15–20° — рекомендация', () => {
  for (const mirrored of [false, true]) {
    for (const [lean, error, hint] of [[15, false, false], [15.01, false, true], [20, false, true], [20.01, true, false]]) {
      const lunge = analyzer();
      feed(lunge, 175, { mirrored });
      const result = feed(lunge, 130, { mirrored, lean });
      assert.equal(result.currentErrors.includes(ERROR.BACK_LEAN), error, `${mirrored} ${lean}`);
      assert.equal(result.feedbackMessage.includes('не более 15°'), hint, `${mirrored} ${lean}`);
      if (error) assert.match(result.feedbackMessage, /Держите спину ровно/);
    }
  }
});

test('наклон назад не называется завалом вперёд', () => {
  const lunge = analyzer();
  feed(lunge, 175);
  const result = feed(lunge, 130, { lean: -25 });
  assert.ok(!result.currentErrors.includes(ERROR.BACK_LEAN));
  assert.match(result.feedbackMessage, /ближе к вертикали/);
});

test('без видимого носка передней ноги повтор считается, но проверка колена недоступна', () => {
  const lunge = analyzer();
  feed(lunge, 175, { toes: 'rear' });
  const mid = feed(lunge, 130, { toes: 'rear', kneeShift: 60 });
  assert.ok(!mid.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  assert.match(mid.feedbackMessage, /Покажите носок передней стопы/);
  feed(lunge, 90, { toes: 'rear' }); feed(lunge, 94, { toes: 'rear' });
  assert.equal(feed(lunge, 175, { toes: 'rear' }).repCount, 1);
});

test('без направления и расстановки стоп передняя нога не выдумывается', () => {
  const lunge = analyzer();
  feed(lunge, 175, { toes: 'none' });
  let result = feed(lunge, 130, { toes: 'none', lean: 25, kneeShift: 60 });
  assert.equal(lunge.activeSide, null);
  assert.ok(!result.currentErrors.includes(ERROR.BACK_LEAN));
  assert.ok(!result.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  assert.match(result.feedbackMessage, /определить переднюю ногу/);
  feed(lunge, 90, { toes: 'none' });
  result = feed(lunge, 175, { toes: 'none' });
  assert.equal(result.repCount, 0);
  const close = analyzer();
  feed(close, 175, { feetClose: true });
  feed(close, 90, { feetClose: true });
  assert.equal(feed(close, 175, { feetClose: true }).repCount, 0);
});

test('при ручном направлении и без носков счёт работает, проверка колена недоступна', () => {
  const lunge = analyzer({ facingDirection: 'right' });
  const result = fullRep(lunge, { toes: 'none' });
  assert.equal(result.repCount, 1);
  assert.match(result.feedbackMessage, /Покажите носок передней стопы/);
});

test('передняя нога может определиться уже во время шага', () => {
  const lunge = analyzer();
  feed(lunge, 175, { feetClose: true });
  const unknown = feed(lunge, 130, { feetClose: true });
  assert.equal(unknown.currentPhase, PHASE.LUNGING);
  assert.equal(lunge.activeSide, null);
  feed(lunge, 100);
  assert.equal(lunge.activeSide, 'left');
  assert.equal(feed(lunge, 104).currentPhase, PHASE.BOTTOM);
  assert.equal(feed(lunge, 175).repCount, 1);
});

test('смена передней ноги до стойки отменяет незавершённый повтор', () => {
  const lunge = analyzer();
  feed(lunge, 175); feed(lunge, 130); feed(lunge, 90);
  const changed = feed(lunge, 100, { front: 'right' });
  assert.equal(changed.currentPhase, PHASE.WAITING);
  assert.equal(changed.repCount, 0);
  assert.match(changed.feedbackMessage, /Передняя нога сменилась/);
  assert.equal(feed(lunge, 175, { front: 'right' }).repCount, 0);
  assert.equal(fullRep(lunge, { front: 'right' }).repCount, 1);
});

test('низкая уверенность и длительная потеря двух ног прерывают попытку без потери счётчика', () => {
  const lunge = analyzer();
  assert.equal(fullRep(lunge).repCount, 1);
  feed(lunge, 130); feed(lunge, 90);
  const missing = makePose(90);
  missing[26].visibility = 0.49;
  for (let i = 0; i < 9; i += 1) assert.equal(lunge.update(missing).repCount, 1);
  assert.equal(lunge.update(missing).currentPhase, PHASE.WAITING);
  assert.equal(feed(lunge, 175).repCount, 1);
});

test('без плеча не заявляется правильный корпус и повтор можно считать', () => {
  const lunge = analyzer();
  const start = feed(lunge, 175, { shoulders: false });
  assert.match(start.feedbackMessage, /проверка корпуса недоступна/);
  for (const angle of [140, 90, 94]) feed(lunge, angle, { shoulders: false });
  const finish = feed(lunge, 175, { shoulders: false });
  assert.equal(finish.repCount, 1);
  assert.match(finish.feedbackMessage, /проверка корпуса недоступна/);
});

test('изменение размера кадра, направления и сбросы сохраняют или обнуляют счёт', () => {
  const lunge = analyzer();
  fullRep(lunge);
  feed(lunge, 130);
  lunge.resetTracking();
  assert.equal(lunge.repCount, 1);
  assert.equal(lunge.currentPhase, PHASE.WAITING);
  lunge.setFacingDirection('left');
  assert.equal(lunge.repCount, 1);
  assert.throws(() => lunge.setFacingDirection('forward'), TypeError);
  assert.throws(() => lunge.setFrameSize(0, 480), TypeError);
  feed(lunge, 175, { mirrored: true });
  lunge.setFrameSize(1280, 960);
  assert.equal(lunge.currentPhase, PHASE.STANDING);
  lunge.setFrameSize(640, 640);
  assert.equal(lunge.currentPhase, PHASE.WAITING);
  lunge.reset();
  assert.equal(lunge.repCount, 0);
});


test('старое положение стоп не фиксирует не ту ногу при попеременном шаге', () => {
  const lunge = analyzer();
  feed(lunge, 175, { front: 'left' });
  // Задняя нога начала шаг, но прежде расположенная впереди ещё не согнулась.
  feed(lunge, 175, { front: 'left', rearAngle: 130 });
  assert.equal(lunge.activeSide, null);
  feed(lunge, 130, { front: 'right', rearAngle: 175 });
  assert.equal(lunge.activeSide, 'right');
  feed(lunge, 90, { front: 'right' });
  feed(lunge, 94, { front: 'right' });
  assert.equal(feed(lunge, 175, { front: 'right' }).repCount, 1);
});


test('высота заднего колена оценивается по проекции пола, без утверждения об ударе', () => {
  const high = analyzer();
  feed(high, 175); feed(high, 140);
  feed(high, 90, { rearAngle: 90, rearGroundGap: 90 });
  const highBottom = feed(high, 94, { rearAngle: 90, rearGroundGap: 90 });
  assert.match(highBottom.feedbackMessage, /колено может быть высоко/i);
  assert.doesNotMatch(highBottom.feedbackMessage, /ударилось|коснулось/);

  const near = analyzer();
  feed(near, 175); feed(near, 140);
  feed(near, 90, { rearAngle: 90, rearGroundGap: 2 });
  const nearBottom = feed(near, 94, { rearAngle: 90, rearGroundGap: 2 });
  assert.match(nearBottom.feedbackMessage, /зазор над предполагаемым полом/i);
});

test('без обеих видимых опор или при неопределённом полу нельзя утверждать его положение', () => {
  const lunge = analyzer({ facingDirection: 'right' });
  for (const angle of [175, 140, 90]) feed(lunge, angle, { toes: 'front' });
  const bottom = feed(lunge, 94, { toes: 'front' });
  assert.match(bottom.feedbackMessage, /Уровень пола не определён/);
  assert.doesNotMatch(bottom.feedbackMessage, /колено может быть высоко/);
});

test('угол задней ноги обновляется на стабильном плато около минимума передней', () => {
  const lunge = analyzer();
  feed(lunge, 175); feed(lunge, 140);
  feed(lunge, 90, { rearAngle: 120 });
  feed(lunge, 90.6, { rearAngle: 90 });
  const bottom = feed(lunge, 94, { rearAngle: 110 });
  assert.equal(bottom.currentPhase, PHASE.BOTTOM);
  assert.doesNotMatch(bottom.feedbackMessage, /согнуть заднее колено примерно/i);
});

test('без направления не показываются прежние ошибки, требующие знания переда', () => {
  const lunge = analyzer();
  feed(lunge, 175);
  const bad = feed(lunge, 130, { lean: 25, kneeShift: 60 });
  assert.ok(bad.currentErrors.includes(ERROR.BACK_LEAN));
  assert.ok(bad.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  const lost = feed(lunge, 110, { toes: 'none', lean: 25, kneeShift: 60 });
  assert.ok(!lost.currentErrors.includes(ERROR.BACK_LEAN));
  assert.ok(!lost.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  assert.match(lost.feedbackMessage, /направление стоп/i);
  const restored = feed(lunge, 90);
  assert.ok(restored.currentErrors.includes(ERROR.BACK_LEAN));
  assert.ok(restored.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  feed(lunge, 94);
  const finish = feed(lunge, 175, { toes: 'none' });
  assert.equal(finish.repCount, 1);
  assert.ok(!finish.currentErrors.includes(ERROR.BACK_LEAN));
  assert.ok(!finish.currentErrors.includes(ERROR.KNEE_PAST_TOE));
});

test('противоположные направления стоп не дают уверенного определения передней ноги', () => {
  const lunge = analyzer();
  feed(lunge, 175);
  const pose = makePose(130, { lean: 25 });
  pose[32].x = pose[28].x - 30 / WIDTH;
  const result = lunge.update(pose);
  assert.equal(lunge.activeSide, null);
  assert.ok(!result.currentErrors.includes(ERROR.BACK_LEAN));
  assert.match(result.feedbackMessage, /определить переднюю ногу/);
});

test('все ошибки доступны одновременно и недосед виден в итоговой подсказке', () => {
  const lunge = analyzer();
  feed(lunge, 175);
  feed(lunge, 130, { lean: 25, kneeShift: 60 });
  feed(lunge, 120);
  const bottom = feed(lunge, 124);
  assert.ok(bottom.currentErrors.includes(ERROR.KNEE_PAST_TOE));
  assert.ok(bottom.currentErrors.includes(ERROR.BACK_LEAN));
  assert.ok(bottom.currentErrors.includes(ERROR.SHALLOW));
  const finish = feed(lunge, 175);
  assert.equal(finish.repCount, 1);
  assert.match(finish.feedbackMessage, /Держите спину ровно/);
  assert.match(finish.feedbackMessage, /Не уводите колено/);
  assert.match(finish.feedbackMessage, /Опускайтесь ниже/);
});

test('граница исходной стойки и достоверность обеих ног проверяются консервативно', () => {
  const lunge = analyzer();
  assert.equal(feed(lunge, 160).currentPhase, PHASE.WAITING);
  assert.equal(feed(lunge, 160.01).currentPhase, PHASE.STANDING);
  const coincident = makePose(90);
  coincident[26] = { ...coincident[24] };
  assert.equal(lunge.update(coincident).repCount, 0);
  const outside = makePose(90);
  outside[28].x = 1.5;
  assert.match(lunge.update(outside).feedbackMessage, /обе лодыжки/);
  assert.equal(lunge.update(null).repCount, 0);
});

test('используются 3D при полном Z и 2D при неполном наборе координат', () => {
  const lunge = analyzer();
  const pose = makePose(175, { z: 0 });
  assert.equal(lunge.update(pose).currentPhase, PHASE.STANDING);
  lunge.reset();
  pose[27].z = 0.25;
  assert.equal(lunge.update(pose).currentPhase, PHASE.WAITING);
  delete pose[27].z;
  assert.equal(lunge.update(pose).currentPhase, PHASE.STANDING);
});

test('оценка уровня пола зеркально симметрична и отключается при сильном наклоне линии опор', () => {
  for (const mirrored of [false, true]) {
    const lunge = analyzer();
    feed(lunge, 175, { mirrored }); feed(lunge, 140, { mirrored });
    feed(lunge, 90, { mirrored, rearGroundGap: 90 });
    assert.match(feed(lunge, 94, { mirrored, rearGroundGap: 90 }).feedbackMessage, /колено может быть высоко/i);
  }
  const lunge = analyzer();
  feed(lunge, 175); feed(lunge, 140);
  const tilted = makePose(90);
  tilted[31].y = 300 / HEIGHT;
  lunge.update(tilted);
  tilted[25] = makePose(94)[25]; tilted[23] = makePose(94)[23];
  const result = lunge.update(tilted);
  assert.match(result.feedbackMessage, /Уровень пола не определён/);
});

test('проекция пола не экстраполируется далеко за пределы видимых стоп', () => {
  const lunge = analyzer();
  feed(lunge, 175); feed(lunge, 140);
  feed(lunge, 90, { rearKneeShift: -60 });
  const bottom = feed(lunge, 94, { rearKneeShift: -60 });
  assert.match(bottom.feedbackMessage, /Уровень пола не определён/);
});


test('соотношение сторон кадра исправляется до вычисления углов и направлений', () => {
  const standard = analyzer();
  const wide = new LungeAnalyzer({ videoWidth: 960, videoHeight: HEIGHT });
  for (const angle of [175, 140, 90, 94, 120, 175]) {
    const original = makePose(angle);
    const reshaped = original.map((point) => ({ ...point, x: point.x * WIDTH / 960 }));
    const a = standard.update(original);
    const b = wide.update(reshaped);
    assert.equal(b.currentPhase, a.currentPhase);
    assert.equal(b.repCount, a.repCount);
    assert.deepEqual(b.currentErrors, a.currentErrors);
  }
  assert.equal(wide.repCount, 1);
});
