import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Браузерный ES-модуль проверяется без package.json, установки пакетов и сборки.
const geometrySource = await readFile(new URL('../geometry.js', import.meta.url));
const geometryUrl = `data:text/javascript;base64,${geometrySource.toString('base64')}`;
const source = (await readFile(new URL('../gluteBridgeAnalyzer.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`);
const { GluteBridgeAnalyzer, GLUTE_PHASE: PHASE, GLUTE_ERROR: ERROR } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Задаём ориентированный угол в пикселях до нормализации MediaPipe. Плечо и
// колено неподвижны: таз с увеличением угла поднимается над линией этих точек.
function makePose({
  hipAngle = 110, kneeAngle = 90, side = 'left', mirrored = false,
  width = 900, height = 700, confidence = 1, shiftX = 0, shiftY = 0
} = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const index = side === 'left'
    ? { shoulder: 11, hip: 23, knee: 25, ankle: 27 }
    : { shoulder: 12, hip: 24, knee: 26, ankle: 28 };
  const rad = (degrees) => degrees * Math.PI / 180;
  const shoulder = { x: 140, y: 420 };
  const knee = { x: 440, y: 280 };
  const dx = knee.x - shoulder.x;
  const dy = knee.y - shoulder.y;
  const span = Math.hypot(dx, dy);
  const offset = span / 2 * Math.tan(rad(180 - hipAngle) / 2);
  const hip = {
    x: (shoulder.x + knee.x) / 2 - dy / span * offset,
    y: (shoulder.y + knee.y) / 2 + dx / span * offset
  };
  const ankleDirection = Math.atan2(hip.y - knee.y, hip.x - knee.x) - rad(kneeAngle);
  const ankle = { x: knee.x + 200 * Math.cos(ankleDirection), y: knee.y + 200 * Math.sin(ankleDirection) };
  for (const [id, point] of [[index.shoulder, shoulder], [index.hip, hip], [index.knee, knee], [index.ankle, ankle]]) {
    const x = point.x + shiftX;
    points[id] = {
      x: (mirrored ? width - x : x) / width,
      y: (point.y + shiftY) / height,
      visibility: confidence,
      presence: confidence
    };
  }
  return points;
}

function analyzer(options = {}) {
  return new GluteBridgeAnalyzer({ videoWidth: 900, videoHeight: 700, ...options });
}
function feed(bridge, options = {}) {
  return bridge.update(makePose(options));
}
function fullRep(bridge, { peak = 180, ...options } = {}) {
  feed(bridge, options);
  feed(bridge, { ...options, hipAngle: 130 });
  feed(bridge, { ...options, hipAngle: peak });
  feed(bridge, { ...options, hipAngle: peak - 10 });
  return feed(bridge, options);
}
function withBothSides(options = {}, leftConfidence = 1, rightConfidence = 1) {
  const left = makePose({ ...options, side: 'left', confidence: leftConfidence });
  const right = makePose({ ...options, side: 'right', confidence: rightConfidence });
  for (const id of [12, 24, 26, 28]) left[id] = right[id];
  return left;
}

// В этих тестах позы синтетические: они проверяют логику, а не работу модели MediaPipe.
test('интерфейс явно сообщает о недоступности контакта с полом и оценки позвоночника', () => {
  const result = feed(analyzer());
  assert.deepEqual(Object.keys(result), ['repCount', 'currentPhase', 'currentErrors', 'feedbackMessage',
    'floorContact', 'spineAssessment']);
  assert.equal(result.currentPhase, PHASE.BOTTOM);
  assert.equal(result.repCount, 0);
  assert.equal(result.floorContact, 'unavailable');
  assert.equal(result.spineAssessment, 'unavailable');
  assert.match(result.feedbackMessage, /Контакт с полом и изгиб поясницы по этим точкам не определяются/);
  assert.doesNotMatch(result.feedbackMessage, /спина ровная|безопасн|касаетесь пола/i);
});

for (const [angle, expected] of [
  [99.99, PHASE.WAITING], [100, PHASE.BOTTOM], [110, PHASE.BOTTOM],
  [120, PHASE.BOTTOM], [120.01, PHASE.WAITING]
]) {
  test(`нижняя фаза по одному углу: ${angle}° → ${expected}`, () => {
    assert.equal(feed(analyzer(), { hipAngle: angle }).currentPhase, expected);
  });
}

test('нижняя фаза не утверждает и не требует контакт с полом', () => {
  const nearTopOfFrame = feed(analyzer(), { hipAngle: 110, shiftY: -100 });
  assert.equal(nearTopOfFrame.currentPhase, PHASE.BOTTOM);
  assert.equal(nearTopOfFrame.floorContact, 'unavailable');
  assert.match(nearTopOfFrame.feedbackMessage, /по углу/);
});

test('наблюдаемый цикл проходит BOTTOM, LIFTING, PEAK, LOWERING и снова BOTTOM', () => {
  const bridge = analyzer();
  assert.equal(feed(bridge).currentPhase, PHASE.BOTTOM);
  assert.equal(feed(bridge, { hipAngle: 140 }).currentPhase, PHASE.LIFTING);
  assert.equal(feed(bridge, { hipAngle: 180 }).currentPhase, PHASE.PEAK);
  const lowering = feed(bridge, { hipAngle: 160 });
  assert.equal(lowering.currentPhase, PHASE.LOWERING);
  assert.equal(lowering.repCount, 0);
  const completed = feed(bridge);
  assert.equal(completed.currentPhase, PHASE.BOTTOM);
  assert.equal(completed.repCount, 1);
  assert.deepEqual(completed.currentErrors, []);
  assert.match(completed.feedbackMessage, /Повтор засчитан/);
});

test('повтор учитывается только один раз, стояние внизу счётчик не увеличивает', () => {
  const bridge = analyzer();
  assert.equal(fullRep(bridge).repCount, 1);
  assert.equal(fullRep(bridge).repCount, 2);
  for (let i = 0; i < 8; i += 1) assert.equal(feed(bridge).repCount, 2);
});

test('первый кадр наверху и последующий возврат не составляют повтор', () => {
  const bridge = analyzer();
  assert.equal(feed(bridge, { hipAngle: 180 }).currentPhase, PHASE.WAITING);
  const bottom = feed(bridge);
  assert.equal(bottom.currentPhase, PHASE.BOTTOM);
  assert.equal(bottom.repCount, 0);
});

test('возврат с 110° к границе BOTTOM 120° не требует прежней высоты таза', () => {
  const bridge = analyzer();
  feed(bridge, { hipAngle: 110 });
  feed(bridge, { hipAngle: 180 });
  const result = feed(bridge, { hipAngle: 120 });
  assert.equal(result.currentPhase, PHASE.BOTTOM);
  assert.equal(result.repCount, 1);
});

test('после начала с границы BOTTOM 100° возврат в другую часть диапазона допустим', () => {
  const bridge = analyzer();
  feed(bridge, { hipAngle: 100 });
  feed(bridge, { hipAngle: 180 });
  const result = feed(bridge, { hipAngle: 115 });
  assert.equal(result.currentPhase, PHASE.BOTTOM);
  assert.equal(result.repCount, 1);
});

for (const [angle, expected] of [
  [169.99, PHASE.LIFTING], [170, PHASE.PEAK], [180, PHASE.PEAK],
  [195, PHASE.PEAK], [195.01, PHASE.LIFTING]
]) {
  test(`верхний диапазон 170–195° включительно: ${angle}° → ${expected}`, () => {
    const bridge = analyzer();
    feed(bridge);
    const result = feed(bridge, { hipAngle: angle });
    assert.equal(result.currentPhase, expected);
    assert.equal(result.currentErrors.includes(ERROR.HIP_HIGH), angle > 195);
  });
}

for (const peak of [170, 180, 195]) {
  test(`подъём до ${peak}° и возврат засчитываются`, () => {
    const result = fullRep(analyzer(), { peak });
    assert.equal(result.repCount, 1);
    assert.ok(!result.currentErrors.includes(ERROR.HIP_HIGH));
  });
}

for (const peak of [150, 159.99, 160, 169.99]) {
  test(`неполный подъём до ${peak}° не засчитывается`, () => {
    const result = fullRep(analyzer(), { peak });
    assert.equal(result.repCount, 0);
    assert.equal(result.currentPhase, PHASE.BOTTOM);
    assert.equal(result.currentErrors.includes(ERROR.SHORT_LIFT), peak < 160);
    if (peak >= 160) assert.match(result.feedbackMessage, /Верхняя фаза не достигнута/);
  });
}

test('предупреждение о недостаточном подъёме появляется в подтверждённой, а не промежуточной точке', () => {
  const bridge = analyzer();
  feed(bridge);
  const rising = feed(bridge, { hipAngle: 150 });
  assert.equal(rising.currentPhase, PHASE.LIFTING);
  assert.ok(!rising.currentErrors.includes(ERROR.SHORT_LIFT));
  const descending = feed(bridge, { hipAngle: 140 });
  assert.equal(descending.currentPhase, PHASE.LOWERING);
  assert.ok(descending.currentErrors.includes(ERROR.SHORT_LIFT));
  assert.match(descending.feedbackMessage, /Поднимите таз выше, сожмите ягодицы/);
});

test('плато подтверждает локальную верхнюю точку и продолженный подъём может достичь PEAK', () => {
  const bridge = analyzer();
  feed(bridge);
  let top;
  for (let i = 0; i < 6; i += 1) top = feed(bridge, { hipAngle: 150 });
  assert.equal(top.currentPhase, PHASE.TOP);
  assert.ok(top.currentErrors.includes(ERROR.SHORT_LIFT));
  const risingAgain = feed(bridge, { hipAngle: 160 });
  assert.equal(risingAgain.currentPhase, PHASE.LIFTING);
  assert.ok(!risingAgain.currentErrors.includes(ERROR.SHORT_LIFT));
  assert.equal(feed(bridge, { hipAngle: 180 }).currentPhase, PHASE.PEAK);
  assert.equal(feed(bridge).repCount, 1);
});

test('повторный подъём ниже общего максимума не путается с новым опусканием', () => {
  const bridge = analyzer();
  feed(bridge);
  feed(bridge, { hipAngle: 180 });
  assert.equal(feed(bridge, { hipAngle: 150 }).currentPhase, PHASE.LOWERING);
  assert.equal(feed(bridge, { hipAngle: 165 }).currentPhase, PHASE.LIFTING);
  assert.equal(feed(bridge, { hipAngle: 170 }).currentPhase, PHASE.PEAK);
  assert.equal(feed(bridge, { hipAngle: 160 }).currentPhase, PHASE.LOWERING);
  assert.equal(feed(bridge).repCount, 1);
});

test('плато после повторного подъёма сравнивается с локальной, а не прежней вершиной', () => {
  const bridge = analyzer();
  feed(bridge);
  feed(bridge, { hipAngle: 190 });
  feed(bridge, { hipAngle: 150 });
  feed(bridge, { hipAngle: 160 });
  let plateau;
  for (let i = 0; i < 6; i += 1) plateau = feed(bridge, { hipAngle: 160 });
  assert.equal(plateau.currentPhase, PHASE.TOP);
  assert.equal(feed(bridge, { hipAngle: 160 }).currentPhase, PHASE.TOP);
  assert.equal(feed(bridge, { hipAngle: 150 }).currentPhase, PHASE.LOWERING);
  assert.equal(feed(bridge).repCount, 1);
});

test('слишком короткое шевеление не оставляет машину в LIFTING', () => {
  const bridge = analyzer();
  feed(bridge);
  assert.equal(feed(bridge, { hipAngle: 114 }).currentPhase, PHASE.LIFTING);
  const settled = feed(bridge);
  assert.equal(settled.currentPhase, PHASE.BOTTOM);
  assert.equal(settled.repCount, 0);
  assert.match(settled.feedbackMessage, /слишком мало/);
  assert.equal(fullRep(bridge).repCount, 1);
});

test('превышение 195° описывается нейтрально и не диагностирует поясницу', () => {
  const high = feed(analyzer(), { hipAngle: 200 });
  assert.equal(high.currentPhase, PHASE.WAITING);
  assert.ok(high.currentErrors.includes(ERROR.HIP_HIGH));
  assert.match(high.feedbackMessage, /Таз слишком высоко относительно линии плечо–колено/);
  assert.doesNotMatch(high.feedbackMessage, /гиперэкстензи|переразгиб|травм|безопасн/i);
  assert.equal(high.spineAssessment, 'unavailable');
});

test('после наблюдаемого PEAK подъём выше 195° считается с предупреждением при возврате', () => {
  const bridge = analyzer();
  feed(bridge);
  assert.equal(feed(bridge, { hipAngle: 180 }).currentPhase, PHASE.PEAK);
  const high = feed(bridge, { hipAngle: 200 });
  assert.ok(high.currentErrors.includes(ERROR.HIP_HIGH));
  feed(bridge, { hipAngle: 180 });
  const result = feed(bridge);
  assert.equal(result.repCount, 1);
  assert.ok(result.currentErrors.includes(ERROR.HIP_HIGH));
  assert.match(result.feedbackMessage, /Повтор засчитан/);
});

test('если PEAK пропущен в кадрах подъёма, его видимое положение при опускании тоже принимается', () => {
  const bridge = analyzer();
  feed(bridge);
  feed(bridge, { hipAngle: 200 });
  assert.equal(feed(bridge, { hipAngle: 180 }).currentPhase, PHASE.PEAK);
  const result = feed(bridge);
  assert.equal(result.repCount, 1);
  assert.ok(result.currentErrors.includes(ERROR.HIP_HIGH));
});

test('верхняя зона, не попавшая ни в один кадр, не засчитывается по догадке', () => {
  const bridge = analyzer();
  feed(bridge);
  feed(bridge, { hipAngle: 200 });
  const result = feed(bridge);
  assert.equal(result.repCount, 0);
  assert.ok(result.currentErrors.includes(ERROR.HIP_HIGH));
});

for (const [angle, error] of [
  [69.99, ERROR.KNEE_CLOSE], [70, null], [90, null], [110, null], [110.01, ERROR.KNEE_FAR]
]) {
  test(`угол колена в PEAK ${angle}°: ${error ?? 'без предупреждения'}`, () => {
    const bridge = analyzer();
    feed(bridge);
    const top = feed(bridge, { hipAngle: 180, kneeAngle: angle });
    assert.equal(top.currentPhase, PHASE.PEAK);
    assert.equal(top.currentErrors.includes(ERROR.KNEE_CLOSE), error === ERROR.KNEE_CLOSE);
    assert.equal(top.currentErrors.includes(ERROR.KNEE_FAR), error === ERROR.KNEE_FAR);
    if (error === ERROR.KNEE_CLOSE) assert.match(top.feedbackMessage, /не слишком ли близко стопы/);
    if (error === ERROR.KNEE_FAR) assert.match(top.feedbackMessage, /не слишком ли далеко стопы/);
    const completed = feed(bridge);
    assert.equal(completed.repCount, 1);
    if (error) assert.ok(completed.currentErrors.includes(error));
  });
}

test('коленный угол не оценивается как верхний в обычном промежуточном кадре', () => {
  const bridge = analyzer();
  feed(bridge);
  const intermediate = feed(bridge, { hipAngle: 150, kneeAngle: 50 });
  assert.equal(intermediate.currentPhase, PHASE.LIFTING);
  assert.ok(!intermediate.currentErrors.includes(ERROR.KNEE_CLOSE));
});

test('колено для итога берётся из кадра максимальной высоты, а не из ранней PEAK', () => {
  const bridge = analyzer();
  feed(bridge);
  const earlier = feed(bridge, { hipAngle: 170, kneeAngle: 50 });
  assert.ok(earlier.currentErrors.includes(ERROR.KNEE_CLOSE));
  feed(bridge, { hipAngle: 180, kneeAngle: 90 });
  const descending = feed(bridge, { hipAngle: 160, kneeAngle: 50 });
  assert.ok(!descending.currentErrors.includes(ERROR.KNEE_CLOSE));
  const result = feed(bridge);
  assert.equal(result.repCount, 1);
  assert.ok(!result.currentErrors.includes(ERROR.KNEE_CLOSE));
});

test('ошибка колена на вершине сохраняется в кадре завершения, даже если ниже исправлена', () => {
  const bridge = analyzer();
  feed(bridge);
  feed(bridge, { hipAngle: 170, kneeAngle: 90 });
  feed(bridge, { hipAngle: 180, kneeAngle: 50 });
  const descending = feed(bridge, { hipAngle: 160, kneeAngle: 90 });
  assert.ok(descending.currentErrors.includes(ERROR.KNEE_CLOSE));
  const result = feed(bridge);
  assert.equal(result.repCount, 1);
  assert.ok(result.currentErrors.includes(ERROR.KNEE_CLOSE));
  assert.ok(!feed(bridge).currentErrors.includes(ERROR.KNEE_CLOSE));
});

for (const side of ['left', 'right']) {
  for (const mirrored of [false, true]) {
    test(`ориентированный угол и счёт одинаковы: сторона ${side}, зеркало ${mirrored}`, () => {
      const bridge = analyzer();
      const options = { side, mirrored };
      assert.equal(feed(bridge, options).currentPhase, PHASE.BOTTOM);
      assert.equal(feed(bridge, { ...options, hipAngle: 170 }).currentPhase, PHASE.PEAK);
      assert.equal(feed(bridge, { ...options, hipAngle: 195 }).currentPhase, PHASE.PEAK);
      const high = feed(bridge, { ...options, hipAngle: 200 });
      assert.ok(high.currentErrors.includes(ERROR.HIP_HIGH));
      const result = feed(bridge, options);
      assert.equal(result.repCount, 1);
      assert.ok(result.currentErrors.includes(ERROR.HIP_HIGH));
    });
  }
}

for (const [width, height] of [[900, 700], [720, 1280], [1800, 1400]]) {
  test(`углы учитывают соотношение размеров видео ${width}×${height}`, () => {
    const bridge = analyzer({ videoWidth: width, videoHeight: height });
    const result = fullRep(bridge, { width, height, peak: 195 });
    assert.equal(result.repCount, 1);
    assert.deepEqual(result.currentErrors, []);
  });
}

test('перемещение всей позы в кадре не подменяет относительный подъём таза', () => {
  const bridge = analyzer();
  feed(bridge);
  const shifted = feed(bridge, { shiftY: -40 });
  assert.equal(shifted.currentPhase, PHASE.BOTTOM);
  assert.equal(shifted.repCount, 0);
});

test('одно изменение угла без подъёма таза относительно плеча не начинает повтор', () => {
  const bridge = analyzer();
  const initial = makePose();
  bridge.update(initial);
  const unchangedHip = makePose();
  unchangedHip[25] = {
    x: 2 * unchangedHip[23].x - unchangedHip[11].x,
    y: 2 * unchangedHip[23].y - unchangedHip[11].y,
    visibility: 1, presence: 1
  };
  const result = bridge.update(unchangedHip);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.equal(result.repCount, 0);
});

for (const index of [11, 23, 25, 27]) {
  test(`потеря точки ${index} отменяет незавершённый подъём`, () => {
    const bridge = analyzer();
    feed(bridge);
    feed(bridge, { hipAngle: 180 });
    const incomplete = makePose({ hipAngle: 160 });
    incomplete[index] = null;
    const lost = bridge.update(incomplete);
    assert.equal(lost.currentPhase, PHASE.WAITING);
    assert.match(lost.feedbackMessage, /Покажите сбоку/);
    assert.equal(feed(bridge).repCount, 0);
  });
}

test('потеря позы сохраняет завершённые повторы, но отменяет текущую попытку', () => {
  const bridge = analyzer();
  assert.equal(fullRep(bridge).repCount, 1);
  feed(bridge, { hipAngle: 180 });
  const missing = bridge.update(null);
  assert.equal(missing.currentPhase, PHASE.WAITING);
  assert.equal(missing.repCount, 1);
  assert.equal(feed(bridge).repCount, 1);
});

test('автовыбор фиксирует одну сторону и не подставляет другую при потере', () => {
  const bridge = analyzer();
  assert.equal(bridge.update(withBothSides({}, 0.7, 0.9)).currentPhase, PHASE.BOTTOM);
  assert.equal(bridge.activeSide, 'right');
  bridge.update(withBothSides({ hipAngle: 180 }, 1, 0.8));
  const missingRight = withBothSides({ hipAngle: 160 });
  missingRight[26] = null;
  const result = bridge.update(missingRight);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.equal(result.repCount, 0);
});

test('заданная сторона не заменяется противоположной', () => {
  const bridge = analyzer({ side: 'right' });
  assert.equal(feed(bridge, { side: 'left' }).currentPhase, PHASE.WAITING);
  assert.equal(feed(bridge, { side: 'right' }).currentPhase, PHASE.BOTTOM);
  assert.equal(fullRep(bridge, { side: 'right' }).repCount, 1);
});

test('смена стороны отменяет незавершённый цикл и сохраняет счёт', () => {
  const bridge = analyzer();
  assert.equal(fullRep(bridge).repCount, 1);
  feed(bridge, { hipAngle: 180 });
  bridge.setSide('right');
  assert.equal(bridge.currentPhase, PHASE.WAITING);
  assert.equal(feed(bridge, { hipAngle: 180, side: 'right' }).repCount, 1);
  assert.equal(feed(bridge, { side: 'right' }).repCount, 1);
  assert.equal(fullRep(bridge, { side: 'right' }).repCount, 2);
  assert.throws(() => bridge.setSide('middle'), TypeError);
});

for (const [field, value] of [['visibility', 0.49], ['presence', 0.49], ['visibility', NaN], ['x', -0.01], ['y', NaN]]) {
  test(`невалидный ${field}=${value} отбрасывает сустав`, () => {
    const pose = makePose();
    pose[23][field] = value;
    assert.equal(analyzer().update(pose).currentPhase, PHASE.WAITING);
  });
}

test('граница confidence 0,5 допустима и глубина Z не используется', () => {
  const pose = makePose({ confidence: 0.5 });
  for (const index of [11, 23, 25, 27]) pose[index].z = NaN;
  assert.equal(analyzer().update(pose).currentPhase, PHASE.BOTTOM);
});

test('вырожденные или почти вертикальные ориентиры не анализируются', () => {
  const samePoint = makePose();
  samePoint[23] = { ...samePoint[11] };
  assert.equal(analyzer().update(samePoint).currentPhase, PHASE.WAITING);
  const vertical = makePose();
  vertical[25].x = vertical[11].x;
  assert.equal(analyzer().update(vertical).currentPhase, PHASE.WAITING);
});

test('явно не боковой ракурс отклоняется при видимости противоположной стороны', () => {
  const pose = withBothSides();
  pose[12].x += 100 / 900;
  pose[24].x += 100 / 900;
  const result = analyzer().update(pose);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.match(result.feedbackMessage, /строго сбоку/);
});

test('одинаковый размер кадра не прерывает попытку', () => {
  const bridge = analyzer();
  feed(bridge);
  feed(bridge, { hipAngle: 180 });
  bridge.setFrameSize(900, 700);
  assert.equal(feed(bridge).repCount, 1);
});

test('смена разрешения даже с тем же аспектом отменяет попытку, но не счёт', () => {
  const bridge = analyzer();
  assert.equal(fullRep(bridge).repCount, 1);
  feed(bridge, { hipAngle: 180 });
  bridge.setFrameSize(1800, 1400);
  assert.equal(bridge.currentPhase, PHASE.WAITING);
  assert.equal(feed(bridge, { hipAngle: 180 }).repCount, 1);
  assert.equal(feed(bridge).repCount, 1);
  assert.equal(fullRep(bridge).repCount, 2);
});

test('смена пропорций и некорректные размеры обрабатываются явно', () => {
  const bridge = analyzer();
  feed(bridge);
  feed(bridge, { hipAngle: 180 });
  bridge.setFrameSize(900, 900);
  assert.equal(bridge.currentPhase, PHASE.WAITING);
  for (const size of [[0, 700], [900, -1], [NaN, 700], [900, Infinity]]) {
    assert.throws(() => bridge.setFrameSize(...size), TypeError);
  }
});

test('resetTracking сохраняет счёт, а reset обнуляет его', () => {
  const bridge = analyzer();
  assert.equal(fullRep(bridge).repCount, 1);
  bridge.resetTracking();
  assert.equal(bridge.currentPhase, PHASE.WAITING);
  assert.equal(bridge.repCount, 1);
  bridge.reset();
  assert.equal(bridge.currentPhase, PHASE.WAITING);
  assert.equal(bridge.repCount, 0);
});
