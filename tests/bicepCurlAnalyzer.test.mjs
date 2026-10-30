import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const geometrySource = await readFile(new URL('../geometry.js', import.meta.url));
const geometryUrl = `data:text/javascript;base64,${geometrySource.toString('base64')}`;
const analyzerSource = (await readFile(new URL('../bicepCurlAnalyzer.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`);
const analyzerUrl = `data:text/javascript;base64,${Buffer.from(analyzerSource).toString('base64')}`;
const { BicepCurlAnalyzer, BICEP_PHASE: PHASE, BICEP_ERROR: ERROR } = await import(analyzerUrl);

// Синтетический профиль: геометрия задаётся в пикселях и затем нормируется.
function makePose(angle, {
  side = 'left', lean = 0, elbowDrift = 0, face = true, hipVisible = true,
  mirrored = false, width = 640, height = 480, confidence = 1, z = undefined
} = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const indices = side === 'left'
    ? { shoulder: 11, elbow: 13, wrist: 15, hip: 23 }
    : { shoulder: 12, elbow: 14, wrist: 16, hip: 24 };
  const radians = (value) => value * Math.PI / 180;
  const hip = { x: 300, y: 300 };
  const shoulder = { x: hip.x + 120 * Math.sin(radians(lean)), y: hip.y - 120 * Math.cos(radians(lean)) };
  const downAngle = Math.atan2(hip.y - shoulder.y, hip.x - shoulder.x) + radians(elbowDrift);
  const elbow = { x: shoulder.x + 70 * Math.cos(downAngle), y: shoulder.y + 70 * Math.sin(downAngle) };
  const toShoulder = Math.atan2(shoulder.y - elbow.y, shoulder.x - elbow.x);
  const wristAngle = toShoulder + radians(angle);
  const wrist = { x: elbow.x + 70 * Math.cos(wristAngle), y: elbow.y + 70 * Math.sin(wristAngle) };
  function set(index, point) {
    const value = { x: (mirrored ? width - point.x : point.x) / width, y: point.y / height,
      visibility: confidence, presence: confidence };
    if (z !== undefined) value.z = z;
    points[index] = value;
  }
  set(indices.shoulder, shoulder); set(indices.elbow, elbow); set(indices.wrist, wrist);
  if (hipVisible) set(indices.hip, hip);
  if (face) {
    set(0, { x: shoulder.x + 30, y: shoulder.y - 32 });
    set(7, { x: shoulder.x + 3, y: shoulder.y - 25 });
    set(8, { x: shoulder.x + 8, y: shoulder.y - 25 });
  }
  return points;
}
function analyzer(options = {}) { return new BicepCurlAnalyzer({ videoWidth: 640, videoHeight: 480, ...options }); }
function feed(curl, angle, options = {}) { return curl.update(makePose(angle, options)); }
function fullRep(curl, options = {}) {
  for (const angle of [175, 140, 90, 45, 60, 120]) feed(curl, angle, options);
  return feed(curl, 160, options);
}

test('фазы и строгие границы DOWN >155° и PEAK ≤45°', () => {
  const curl = analyzer();
  let result = feed(curl, 155);
  assert.deepEqual(Object.keys(result), ['repCount', 'currentPhase', 'currentErrors', 'feedbackMessage']);
  assert.equal(result.currentPhase, PHASE.WAITING);
  assert.equal(feed(curl, 156).currentPhase, PHASE.DOWN);
  assert.equal(feed(curl, 153).currentPhase, PHASE.CURLING);
  assert.equal(feed(curl, 45.01).currentPhase, PHASE.CURLING);
  assert.equal(feed(curl, 45).currentPhase, PHASE.PEAK);
  assert.equal(feed(curl, 48).currentPhase, PHASE.LOWERING);
  assert.equal(feed(curl, 155).currentPhase, PHASE.LOWERING);
  result = feed(curl, 156);
  assert.equal(result.currentPhase, PHASE.DOWN);
  assert.equal(result.repCount, 1);
  assert.deepEqual(result.currentErrors, []);
  assert.match(result.feedbackMessage, /Повтор засчитан/);
  assert.equal(feed(curl, 170).repCount, 1);
});

test('полные повторения считаются один раз после возвращения в DOWN', () => {
  const curl = analyzer();
  assert.equal(fullRep(curl).repCount, 1);
  assert.equal(fullRep(curl).repCount, 2);
  for (let i = 0; i < 6; i += 1) assert.equal(feed(curl, 175).repCount, 2);
});

test('неполный верх засчитывается при возврате вниз с предупреждением >55°', () => {
  const curl = analyzer();
  feed(curl, 170); feed(curl, 130); feed(curl, 56);
  const turn = feed(curl, 59);
  assert.equal(turn.currentPhase, PHASE.LOWERING);
  assert.ok(turn.currentErrors.includes(ERROR.SHORT_TOP));
  const result = feed(curl, 160);
  assert.equal(result.repCount, 1);
  assert.ok(result.currentErrors.includes(ERROR.SHORT_TOP));
  assert.match(result.feedbackMessage, /Поднимайте предплечье выше/);
  assert.match(feed(curl, 170).feedbackMessage, /Повтор засчитан/);
});

test('граница 55° и зона 45–55° не выдают недожим и не объявляют PEAK', () => {
  for (const angle of [45.01, 50, 55]) {
    const curl = analyzer();
    feed(curl, 170); feed(curl, 100);
    assert.equal(feed(curl, angle).currentPhase, PHASE.CURLING);
    const turn = feed(curl, angle + 3);
    assert.equal(turn.currentPhase, PHASE.LOWERING);
    assert.ok(!turn.currentErrors.includes(ERROR.SHORT_TOP), String(angle));
    const result = feed(curl, 160);
    assert.equal(result.repCount, 1);
    assert.ok(!result.currentErrors.includes(ERROR.SHORT_TOP));
    assert.match(result.feedbackMessage, /целевой верхней точки/);
  }
});

test('старт с локтем <145° выявляет неполное разгибание, но цикл считается', () => {
  const curl = analyzer();
  assert.equal(feed(curl, 120).currentPhase, PHASE.WAITING);
  const start = feed(curl, 100);
  assert.equal(start.currentPhase, PHASE.CURLING);
  assert.ok(start.currentErrors.includes(ERROR.SHORT_BOTTOM));
  feed(curl, 40); feed(curl, 70);
  const result = feed(curl, 160);
  assert.equal(result.repCount, 1);
  assert.ok(result.currentErrors.includes(ERROR.SHORT_BOTTOM));
  assert.match(result.feedbackMessage, /Полностью разгибайте руку/);
  const boundary = analyzer();
  feed(boundary, 145); feed(boundary, 130);
  assert.ok(!feed(boundary, 100).currentErrors.includes(ERROR.SHORT_BOTTOM));
});

test('недостаточное разгибание между попытками обнаруживается по максимуму возврата', () => {
  const curl = analyzer();
  for (const angle of [175, 120, 45, 80, 140]) feed(curl, angle);
  const next = feed(curl, 135);
  assert.equal(next.currentPhase, PHASE.CURLING);
  assert.ok(next.currentErrors.includes(ERROR.SHORT_BOTTOM));
  feed(curl, 45); feed(curl, 80);
  const result = feed(curl, 160);
  assert.equal(result.repCount, 1); // предыдущая попытка не возвращалась в DOWN
  assert.ok(result.currentErrors.includes(ERROR.SHORT_BOTTOM));
});

test('не считаем повтор по шуму, первому появлению вверху или без возврата в DOWN', () => {
  const curl = analyzer();
  for (const angle of [40, 50, 90, 130, 160, 159, 160, 154, 160]) feed(curl, angle);
  assert.equal(curl.repCount, 0); // 6° — меньше минимального движения
  const peak = feed(curl, 100);
  assert.equal(peak.repCount, 0);
  feed(curl, 45);
  assert.equal(feed(curl, 150).repCount, 0);
  assert.equal(feed(curl, 160).repCount, 1);
});

test('уход локтя: строго больше 25°, включая зеркальное видео', () => {
  for (const mirrored of [false, true]) {
    const curl = analyzer();
    let result = feed(curl, 175, { elbowDrift: 25, mirrored });
    assert.ok(!result.currentErrors.includes(ERROR.ELBOW_DRIFT));
    result = feed(curl, 175, { elbowDrift: 25.01, mirrored });
    assert.ok(result.currentErrors.includes(ERROR.ELBOW_DRIFT));
    assert.match(result.feedbackMessage, /локоть у корпуса/i);
  }
});

test('наклон назад >10° отсчитывается от положения внизу, а не от вертикали', () => {
  const curl = analyzer({ facingDirection: 'right' });
  feed(curl, 175, { lean: 5, face: false });
  feed(curl, 145, { lean: 5, face: false });
  let result = feed(curl, 100, { lean: -5, face: false });
  assert.ok(!result.currentErrors.includes(ERROR.BACK_SWAY)); // ровно 10°
  result = feed(curl, 90, { lean: -5.01, face: false });
  assert.ok(result.currentErrors.includes(ERROR.BACK_SWAY));
  assert.match(result.feedbackMessage, /Не раскачивайте корпус назад/);
});

test('наклон вперёд не ошибочно называется раскачкой назад', () => {
  const curl = analyzer({ facingDirection: 'right' });
  feed(curl, 175, { face: false });
  feed(curl, 145, { face: false });
  const forward = feed(curl, 90, { lean: 15, face: false });
  assert.ok(!forward.currentErrors.includes(ERROR.BACK_SWAY));
});

test('направление тела определяется по лицу и сохраняет знак после зеркалирования', () => {
  for (const mirrored of [false, true]) {
    const curl = analyzer();
    feed(curl, 175, { mirrored });
    feed(curl, 145, { mirrored });
    const back = feed(curl, 90, { mirrored, lean: -12 });
    assert.ok(back.currentErrors.includes(ERROR.BACK_SWAY), `зеркало: ${mirrored}`);
  }
});

test('без лица и явного направления не делаем утверждение о наклоне назад', () => {
  const curl = analyzer();
  feed(curl, 175, { face: false });
  feed(curl, 145, { face: false });
  const result = feed(curl, 90, { face: false, lean: -20 });
  assert.ok(!result.currentErrors.includes(ERROR.BACK_SWAY));
  assert.match(result.feedbackMessage, /лицо сбоку|направление/);
});

test('если нос между ушами, фронтальный ракурс не выдаёт направление', () => {
  const curl = analyzer();
  const frontal = makePose(175);
  frontal[7].x = frontal[0].x - 0.05;
  frontal[8].x = frontal[0].x + 0.05;
  const result = curl.update(frontal);
  assert.match(result.feedbackMessage, /лицо сбоку|направление/);
});

test('ошибки локтя и раскачки сохраняются до завершения повтора', () => {
  const curl = analyzer({ facingDirection: 'right' });
  feed(curl, 175); feed(curl, 145);
  const bad = feed(curl, 90, { lean: -15, elbowDrift: 30 });
  assert.ok(bad.currentErrors.includes(ERROR.BACK_SWAY));
  assert.ok(bad.currentErrors.includes(ERROR.ELBOW_DRIFT));
  feed(curl, 45); feed(curl, 80);
  const result = feed(curl, 160);
  assert.equal(result.repCount, 1);
  assert.ok(result.currentErrors.includes(ERROR.BACK_SWAY));
  assert.ok(result.currentErrors.includes(ERROR.ELBOW_DRIFT));
});

test('без таза можно считать руку, но проверка техники не выдаёт ложных ошибок', () => {
  const curl = analyzer();
  const missing = { hipVisible: false };
  const start = feed(curl, 175, missing);
  assert.match(start.feedbackMessage, /Покажите плечо и таз/);
  for (const angle of [140, 90, 45, 60, 120]) feed(curl, angle, missing);
  const result = feed(curl, 160, missing);
  assert.equal(result.repCount, 1);
  assert.ok(!result.currentErrors.includes(ERROR.ELBOW_DRIFT));
  assert.ok(!result.currentErrors.includes(ERROR.BACK_SWAY));
});

test('при выборе auto анализируется одна наиболее видимая рука', () => {
  const left = makePose(175, { side: 'left', confidence: 0.7 });
  const right = makePose(175, { side: 'right', confidence: 1 });
  for (const index of [12, 14, 16, 24]) left[index] = right[index];
  const curl = analyzer();
  assert.equal(curl.update(left).currentPhase, PHASE.DOWN);
  assert.equal(curl.activeSide, 'right');
  // Движение другой руки не засчитывается вместо выбранной.
  const nextLeft = makePose(40, { side: 'left', confidence: 0.7 });
  for (const index of [12, 14, 16, 24]) nextLeft[index] = right[index];
  assert.equal(curl.update(nextLeft).currentPhase, PHASE.DOWN);
  assert.equal(curl.repCount, 0);
});

test('краткая потеря не переключает руку; длительная отменяет фазу и сохраняет счёт', () => {
  const curl = analyzer();
  assert.equal(fullRep(curl).repCount, 1);
  feed(curl, 130);
  const other = makePose(175, { side: 'right' });
  for (let i = 0; i < 9; i += 1) {
    const result = curl.update(other);
    assert.equal(curl.activeSide, 'left');
    assert.equal(result.repCount, 1);
  }
  const switched = curl.update(other);
  assert.equal(curl.activeSide, 'right');
  assert.equal(switched.currentPhase, PHASE.DOWN);
  assert.equal(switched.repCount, 1);
  assert.equal(curl.update(null).repCount, 1);
});

test('размеры кадра, неполный Z и доступные 3D-координаты обрабатываются корректно', () => {
  const curl = analyzer();
  const pose = makePose(175, { z: 0 });
  assert.equal(curl.update(pose).currentPhase, PHASE.DOWN);
  curl.reset();
  pose[15].z = 0.25; // угол в 3D отличается от 2D
  assert.equal(curl.update(pose).currentPhase, PHASE.WAITING);
  delete pose[15].z; // смешанная размерность: безопасное 2D
  assert.equal(curl.update(pose).currentPhase, PHASE.DOWN);
  curl.setFrameSize(1280, 960);
  assert.equal(curl.currentPhase, PHASE.DOWN);
  curl.setFrameSize(640, 640);
  assert.equal(curl.currentPhase, PHASE.WAITING);
  assert.throws(() => curl.setFrameSize(0, 480), TypeError);
});

test('resetTracking, reset и выбор руки/направления не теряют счёт без команды reset', () => {
  const curl = analyzer();
  fullRep(curl);
  feed(curl, 100);
  curl.resetTracking();
  assert.equal(curl.repCount, 1);
  assert.equal(curl.currentPhase, PHASE.WAITING);
  curl.setSide('right');
  assert.equal(curl.repCount, 1);
  assert.equal(curl.activeSide, 'right');
  curl.setFacingDirection('left');
  assert.equal(curl.repCount, 1);
  assert.throws(() => curl.setSide('both'), TypeError);
  assert.throws(() => curl.setFacingDirection('backwards'), TypeError);
  curl.reset();
  assert.equal(curl.repCount, 0);
  assert.equal(curl.activeSide, 'right');
});


test('DOWN и PEAK не показываются за пределами своих углов даже при небольшом колебании', () => {
  const curl = analyzer();
  assert.equal(feed(curl, 156).currentPhase, PHASE.DOWN);
  assert.equal(feed(curl, 155).currentPhase, PHASE.WAITING);
  assert.equal(feed(curl, 153).currentPhase, PHASE.CURLING);
  assert.equal(feed(curl, 45).currentPhase, PHASE.PEAK);
  assert.equal(feed(curl, 45.1).currentPhase, PHASE.LOWERING);
  assert.equal(feed(curl, 44.9).currentPhase, PHASE.PEAK);
  assert.equal(feed(curl, 60).currentPhase, PHASE.LOWERING);
  assert.equal(feed(curl, 160).repCount, 1);
});

test('автоопределение не сообщает наклон назад, когда лицо пропало на подъёме', () => {
  const curl = analyzer();
  feed(curl, 175);
  feed(curl, 145);
  const lost = feed(curl, 90, { face: false, lean: -20 });
  assert.ok(!lost.currentErrors.includes(ERROR.BACK_SWAY));
  assert.match(lost.feedbackMessage, /лицо сбоку|направление/);
  const visible = feed(curl, 80, { face: true, lean: -20 });
  assert.ok(visible.currentErrors.includes(ERROR.BACK_SWAY));
});

test('направление должно быть известно ещё до подъёма, а смена ракурса не даёт ложный back', () => {
  const missingAtBottom = analyzer();
  feed(missingAtBottom, 175, { face: false });
  feed(missingAtBottom, 145, { face: false });
  const late = feed(missingAtBottom, 90, { face: true, lean: -20 });
  assert.ok(!late.currentErrors.includes(ERROR.BACK_SWAY));
  assert.match(late.feedbackMessage, /исходной стойке неизвестно/);

  const turned = analyzer();
  feed(turned, 175);
  feed(turned, 145);
  const opposite = feed(turned, 90, { mirrored: true, lean: -20 });
  assert.ok(!opposite.currentErrors.includes(ERROR.BACK_SWAY));
  assert.match(opposite.feedbackMessage, /Ракурс изменился/);
});

test('отсутствие тазовых landmarks остаётся заметным после завершения повтора', () => {
  const curl = analyzer();
  const missing = { hipVisible: false };
  for (const angle of [175, 140, 45, 70, 160]) feed(curl, angle, missing);
  const result = feed(curl, 175, missing);
  assert.equal(result.repCount, 1);
  assert.match(result.feedbackMessage, /Повтор засчитан/);
  assert.match(result.feedbackMessage, /проверка корпуса и локтя недоступна/i);
});

test('явное направление left корректно работает с зеркальными landmarks', () => {
  const curl = analyzer({ facingDirection: 'left' });
  feed(curl, 175, { mirrored: true, face: false });
  feed(curl, 145, { mirrored: true, face: false });
  const result = feed(curl, 90, { mirrored: true, face: false, lean: -11 });
  assert.ok(result.currentErrors.includes(ERROR.BACK_SWAY));
});


test('автовыбор предпочитает руку с видимым тазом для оценки техники', () => {
  const left = makePose(175, { side: 'left', hipVisible: false, confidence: 1 });
  const right = makePose(175, { side: 'right', confidence: 0.8 });
  for (const index of [12, 14, 16, 24]) left[index] = right[index];
  const curl = analyzer();
  curl.update(left);
  assert.equal(curl.activeSide, 'right');
});

test('расслабление назад только при опускании не записывается как ошибка подъёма', () => {
  const curl = analyzer({ facingDirection: 'right' });
  feed(curl, 175); feed(curl, 145); feed(curl, 45);
  const down = feed(curl, 90, { lean: -20 });
  assert.equal(down.currentPhase, PHASE.LOWERING);
  assert.ok(!down.currentErrors.includes(ERROR.BACK_SWAY));
  const result = feed(curl, 160, { lean: -20 });
  assert.equal(result.repCount, 1);
  assert.ok(!result.currentErrors.includes(ERROR.BACK_SWAY));
});

test('если таз появился только во время подъёма, исходный наклон не выдумывается', () => {
  const curl = analyzer({ facingDirection: 'right' });
  feed(curl, 175, { hipVisible: false });
  feed(curl, 145, { hipVisible: false });
  const result = feed(curl, 90, { lean: -20 });
  assert.ok(!result.currentErrors.includes(ERROR.BACK_SWAY));
  assert.match(result.feedbackMessage, /таз внизу движения/i);
});

test('низкая уверенность и вырожденные или неверные координаты не приводят к подсчёту', () => {
  const curl = analyzer();
  for (const pose of [null, [], makePose(175, { confidence: 0.49 })]) {
    const result = curl.update(pose);
    assert.equal(result.repCount, 0);
    assert.equal(result.currentPhase, PHASE.WAITING);
  }
  const coincident = makePose(175);
  coincident[13] = { ...coincident[11] };
  assert.equal(curl.update(coincident).repCount, 0);
  const outside = makePose(175);
  outside[15].x = 1.5;
  assert.equal(curl.update(outside).currentPhase, PHASE.WAITING);
});


test('исходный наклон обновляется перед подъёмом даже при неполном разгибании', () => {
  const curl = analyzer({ facingDirection: 'right' });
  feed(curl, 140, { lean: 0 });
  feed(curl, 140, { lean: -15 }); // наклонились до начала сгибания
  const start = feed(curl, 130, { lean: -15 });
  assert.ok(start.currentErrors.includes(ERROR.SHORT_BOTTOM));
  assert.ok(!start.currentErrors.includes(ERROR.BACK_SWAY));
});

test('исходный наклон новой попытки обновляется при паузе после неполного разгибания', () => {
  const curl = analyzer({ facingDirection: 'right' });
  for (const angle of [175, 130, 45, 90, 140]) feed(curl, angle);
  feed(curl, 140, { lean: -15 });
  const start = feed(curl, 130, { lean: -15 });
  assert.ok(start.currentErrors.includes(ERROR.SHORT_BOTTOM));
  assert.ok(!start.currentErrors.includes(ERROR.BACK_SWAY));
});


test('одно ухо с носом само по себе не доказывает направление фронтального лица', () => {
  const curl = analyzer();
  const pose = makePose(175);
  pose[8].visibility = 0; // осталось лишь одно ухо
  let result = curl.update(pose);
  assert.match(result.feedbackMessage, /лицо сбоку|направление/);
  // Видимый противоположный глаз находится по другую сторону от носа: анфас.
  pose[5] = { ...pose[0], x: pose[0].x + 0.03 };
  result = curl.update(pose);
  assert.match(result.feedbackMessage, /лицо сбоку|направление/);
});

test('при одном ухе и противоположном глазе профиль может дать направление', () => {
  const curl = analyzer();
  function profile(angle, lean = 0) {
    const pose = makePose(angle, { lean });
    pose[8].visibility = 0;
    pose[5] = { ...pose[0], x: pose[0].x - 0.02 };
    return pose;
  }
  curl.update(profile(175)); curl.update(profile(145));
  const result = curl.update(profile(90, -15));
  assert.ok(result.currentErrors.includes(ERROR.BACK_SWAY));
});

test('минимальная уверенность таза учитывается при выборе между полными сторонами', () => {
  const left = makePose(175, { side: 'left', confidence: 1 });
  const right = makePose(175, { side: 'right', confidence: 0.8 });
  left[23].visibility = 0.5;
  for (const index of [12, 14, 16, 24]) left[index] = right[index];
  const curl = analyzer();
  curl.update(left);
  assert.equal(curl.activeSide, 'right');
});

test('граничное движение 10° считается, а минимум 55.001° уже предупреждается', () => {
  const exact = analyzer();
  feed(exact, 160); feed(exact, 150);
  assert.equal(feed(exact, 160).repCount, 1);
  const top = analyzer();
  feed(top, 170); feed(top, 90); feed(top, 55.001);
  assert.ok(feed(top, 58.001).currentErrors.includes(ERROR.SHORT_TOP));
  assert.equal(feed(top, 160).repCount, 1);
});


test('ранее зафиксированная раскачка не заявляется на кадрах с неизвестным направлением', () => {
  const curl = analyzer();
  feed(curl, 175); feed(curl, 145);
  assert.ok(feed(curl, 90, { lean: -15 }).currentErrors.includes(ERROR.BACK_SWAY));
  const lost = feed(curl, 80, { lean: -15, face: false });
  assert.ok(!lost.currentErrors.includes(ERROR.BACK_SWAY));
  assert.doesNotMatch(lost.feedbackMessage, /назад/i);
  assert.match(lost.feedbackMessage, /лицо сбоку|направление/);
  // Ошибка не забыта и снова видна, когда направление восстановлено.
  assert.ok(feed(curl, 70, { lean: -15 }).currentErrors.includes(ERROR.BACK_SWAY));
  feed(curl, 45); feed(curl, 70);
  const finish = feed(curl, 160);
  assert.ok(finish.currentErrors.includes(ERROR.BACK_SWAY));
  const lostAtBottom = feed(curl, 175, { face: false });
  assert.doesNotMatch(lostAtBottom.feedbackMessage, /назад/i);
});

test('при неизвестном направлении на последнем кадре старое предупреждение о спине не всплывает', () => {
  const curl = analyzer();
  feed(curl, 175); feed(curl, 145);
  assert.ok(feed(curl, 90, { lean: -15 }).currentErrors.includes(ERROR.BACK_SWAY));
  for (const angle of [45, 70]) feed(curl, angle, { face: false });
  const finish = feed(curl, 160, { face: false });
  assert.equal(finish.repCount, 1);
  assert.ok(!finish.currentErrors.includes(ERROR.BACK_SWAY));
  assert.doesNotMatch(finish.feedbackMessage, /назад/i);
});


test('смена направления на кадре завершения скрывает ранее отмеченную раскачку', () => {
  const curl = analyzer();
  feed(curl, 175); feed(curl, 145);
  assert.ok(feed(curl, 90, { lean: -15 }).currentErrors.includes(ERROR.BACK_SWAY));
  feed(curl, 45); feed(curl, 70);
  const finish = feed(curl, 160, { mirrored: true });
  assert.equal(finish.repCount, 1);
  assert.ok(!finish.currentErrors.includes(ERROR.BACK_SWAY));
  assert.doesNotMatch(finish.feedbackMessage, /назад/i);
  assert.match(finish.feedbackMessage, /Ракурс изменился/);
});


test('при нескольких ошибках итог сохраняет предупреждения об обоих концах амплитуды', () => {
  const curl = analyzer({ facingDirection: 'right' });
  feed(curl, 120); feed(curl, 100);
  feed(curl, 60, { elbowDrift: 30 });
  feed(curl, 63); // частичная верхняя точка
  const result = feed(curl, 160);
  assert.equal(result.repCount, 1);
  assert.ok(result.currentErrors.includes(ERROR.ELBOW_DRIFT));
  assert.ok(result.currentErrors.includes(ERROR.SHORT_BOTTOM));
  assert.ok(result.currentErrors.includes(ERROR.SHORT_TOP));
  assert.match(result.feedbackMessage, /локоть у корпуса/i);
  assert.match(result.feedbackMessage, /Полностью разгибайте руку/);
  assert.match(result.feedbackMessage, /Поднимайте предплечье выше/);
});

test('в промежутке 45–55° рекомендация о цели не скрывается другой ошибкой', () => {
  const curl = analyzer();
  feed(curl, 175); feed(curl, 100, { elbowDrift: 30 });
  feed(curl, 50); feed(curl, 53);
  const result = feed(curl, 160);
  assert.ok(result.currentErrors.includes(ERROR.ELBOW_DRIFT));
  assert.ok(!result.currentErrors.includes(ERROR.SHORT_TOP));
  assert.match(result.feedbackMessage, /локоть у корпуса/i);
  assert.match(result.feedbackMessage, /целевой верхней точки/);
});
