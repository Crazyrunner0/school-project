import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Проверяем браузерный ES-модуль без package.json и сборки.
const geometrySource = await readFile(new URL('../geometry.js', import.meta.url));
const geometryUrl = `data:text/javascript;base64,${geometrySource.toString('base64')}`;
const source = (await readFile(new URL('../sidePlankAnalyzer.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`);
const { SidePlankAnalyzer } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Синтетическая фронтальная проекция: все углы сначала задаются в пикселях.
function makePose({
  angle = 180, twist = 0, twistAxis = 'depth', side = 'left', support = 'both',
  mirrored = false, roll = 0, fallen = false, width = 800, height = 600
} = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const pixels = new Map();
  const shoulder = { x: 150, y: fallen ? 285 : 130 };
  const ankle = { x: 600, y: 300 };
  const dx = ankle.x - shoulder.x, dy = ankle.y - shoulder.y;
  const span = Math.hypot(dx, dy);
  const offset = span / 2 * Math.tan((180 - angle) * Math.PI / 360);
  const hip = { x: (shoulder.x + ankle.x) / 2 - dy / span * offset,
    y: (shoulder.y + ankle.y) / 2 + dx / span * offset };
  const knee = { x: (hip.x + ankle.x) / 2, y: (hip.y + ankle.y) / 2 };
  const halfShoulders = fallen ? 25 : 45;
  const radians = twist * Math.PI / 180;
  const sx = twistAxis === 'image' ? halfShoulders * Math.sin(radians) : 0;
  const sy = halfShoulders * Math.cos(radians);
  const sz = twistAxis === 'depth' ? halfShoulders * Math.sin(radians) : 0;
  const lower = { x: shoulder.x + sx, y: shoulder.y + sy, z: sz };
  const upper = { x: shoulder.x - sx, y: shoulder.y - sy, z: -sz };
  const lowerSide = side === 'left' ? 11 : 12;
  const upperSide = side === 'left' ? 12 : 11;
  pixels.set(lowerSide, lower); pixels.set(upperSide, upper);
  for (const [index, point] of [
    [23, { x: hip.x, y: hip.y + 12 }], [24, { x: hip.x, y: hip.y - 12 }],
    [25, { x: knee.x, y: knee.y + 7 }], [26, { x: knee.x, y: knee.y - 7 }],
    [27, { x: ankle.x, y: ankle.y + 3 }], [28, { x: ankle.x, y: ankle.y - 3 }],
    [29, { x: ankle.x - 8, y: 310 }], [30, { x: ankle.x - 8, y: 310 }],
    [31, { x: ankle.x + 12, y: 310 }], [32, { x: ankle.x + 12, y: 310 }]
  ]) pixels.set(index, point);
  const elbow = side === 'left' ? 13 : 14;
  const wrist = side === 'left' ? 15 : 16;
  if (support === 'both' || support === 'elbow') pixels.set(elbow, { x: shoulder.x, y: 310 });
  if (support === 'both' || support === 'wrist') pixels.set(wrist, { x: shoulder.x + 15, y: 310 });
  if (support === 'raised') {
    pixels.set(elbow, { x: shoulder.x, y: 40 });
    pixels.set(wrist, { x: shoulder.x + 10, y: 40 });
  }

  const turn = roll * Math.PI / 180;
  for (const [index, point] of pixels) {
    const x = 400 + (point.x - 400) * Math.cos(turn) - (point.y - 250) * Math.sin(turn);
    const y = 250 + (point.x - 400) * Math.sin(turn) + (point.y - 250) * Math.cos(turn);
    points[index] = { x: (mirrored ? width - x : x) / width, y: y / height,
      z: (point.z ?? 0) / width, visibility: 1, presence: 1 };
  }
  return points;
}

function analyzer(options = {}) {
  return new SidePlankAnalyzer({ videoWidth: 800, videoHeight: 600, maxFrameGapSeconds: 2, ...options });
}
function near(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('совместимый формат таймера и накопление между подтверждёнными кадрами', () => {
  const plank = analyzer();
  const good = makePose();
  let result = plank.update(good, 1.5);
  assert.deepEqual(Object.keys(result), ['activeHoldTime', 'isFormCorrect', 'feedbackMessage']);
  assert.equal(result.isFormCorrect, true);
  assert.equal(result.activeHoldTime, 0);
  result = plank.update(good, 0.25);
  near(result.activeHoldTime, 0.25);
  result = plank.update(good, 1.5);
  near(result.activeHoldTime, 1.75);
  assert.match(result.feedbackMessage, /ровно/);
});

test('подсчёт прерывается на ошибке и при пропаже позы, восстановление не включает паузу', () => {
  const plank = analyzer();
  const good = makePose();
  plank.update(good, 0);
  plank.update(good, 1);
  const bad = plank.update(makePose({ angle: 150 }), 1);
  assert.equal(bad.isFormCorrect, false);
  assert.match(bad.feedbackMessage, /Поднимите бедра выше, держите ровную линию!/);
  near(bad.activeHoldTime, 1);
  near(plank.update(good, 1).activeHoldTime, 1);
  near(plank.update(good, 0.5).activeHoldTime, 1.5);
  near(plank.update(null, 1).activeHoldTime, 1.5);
  near(plank.update(good, 1).activeHoldTime, 1.5);
  near(plank.update(good, 0.1).activeHoldTime, 1.6);
});

test('порог провисания строгий, а диапазон 165–185° включает границы', () => {
  const cases = [
    [159.9, false, /Поднимите бедра выше, держите ровную линию!/],
    [160, false, /Выровняйте тело/],
    [164.99, false, /Выровняйте тело/],
    [165, true, /ровно/],
    [170, true, /ровно/],
    [180, true, /ровно/],
    [185, true, /ровно/],
    [185.01, false, /опустите бедра/i],
    [195, false, /опустите бедра/i]
  ];
  for (const [angle, correct, message] of cases) {
    const result = analyzer().update(makePose({ angle }));
    assert.equal(result.isFormCorrect, correct, `угол ${angle}: ${result.feedbackMessage}`);
    assert.match(result.feedbackMessage, message);
    if (angle >= 160) assert.doesNotMatch(result.feedbackMessage, /Поднимите бедра выше, держите ровную линию!/);
  }
});

test('ориентированный угол различает поднятый и провисший таз на обеих сторонах и в зеркале', () => {
  for (const side of ['left', 'right']) {
    for (const mirrored of [false, true]) {
      for (const [angle, correct, message] of [
        [155, false, /Поднимите бедра выше/], [165, true, /ровно/],
        [185, true, /ровно/], [190, false, /опустите бедра/i]
      ]) {
        const result = analyzer().update(makePose({ side, mirrored, angle }));
        assert.equal(result.isFormCorrect, correct, `${side} ${mirrored} ${angle}: ${result.feedbackMessage}`);
        assert.match(result.feedbackMessage, message);
      }
    }
  }
});

test('отклонение плеч в глубину более 20° останавливает таймер в обоих направлениях', () => {
  for (const [twist, correct] of [[-45, false], [-20.01, false], [-20, true],
    [0, true], [19.9, true], [20, true], [20.01, false], [45, false]]) {
    const result = analyzer().update(makePose({ twist, twistAxis: 'depth' }));
    assert.equal(result.isFormCorrect, correct, `${twist}: ${result.feedbackMessage}`);
    if (!correct) assert.match(result.feedbackMessage, /не скручивайте корпус/);
  }
});

test('отклонение плеч в плоскости изображения также учитывается', () => {
  for (const [twist, correct] of [[-30, false], [-20, true], [20, true], [30, false]]) {
    const result = analyzer().update(makePose({ twist, twistAxis: 'image' }));
    assert.equal(result.isFormCorrect, correct, `${twist}: ${result.feedbackMessage}`);
    if (!correct) assert.match(result.feedbackMessage, /перпендикулярно полу/);
  }
});

test('отсутствие Z любого плеча ставит таймер на паузу без ложного подтверждения формы', () => {
  for (const missing of [[11], [12], [11, 12]]) {
    const plank = analyzer();
    plank.update(makePose(), 0);
    plank.update(makePose(), 1);
    const pose = makePose();
    for (const index of missing) delete pose[index].z;
    const result = plank.update(pose, 1);
    assert.equal(result.isFormCorrect, false);
    near(result.activeHoldTime, 1);
    assert.match(result.feedbackMessage, /Нет данных глубины обоих плеч/);
    near(plank.update(makePose(), 1).activeHoldTime, 1);
    near(plank.update(makePose(), 0.5).activeHoldTime, 1.5);
  }
});

test('NaN и бесконечность глубины плеч не интерпретируются как отсутствие скручивания', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const pose = makePose();
    pose[11].z = value;
    const result = analyzer().update(pose);
    assert.equal(result.isFormCorrect, false);
    assert.match(result.feedbackMessage, /Нет данных глубины/);
  }
});

test('нулевая глубина является корректной координатой', () => {
  const pose = makePose();
  pose[11].z = 0;
  pose[12].z = 0;
  assert.equal(analyzer().update(pose).isFormCorrect, true);
});

test('заметный двумерный наклон плеч виден и без Z, но время не засчитывается', () => {
  const pose = makePose({ twist: 30, twistAxis: 'image' });
  delete pose[11].z;
  delete pose[12].z;
  const result = analyzer().update(pose);
  assert.equal(result.isFormCorrect, false);
  assert.match(result.feedbackMessage, /не скручивайте корпус/);
  assert.match(result.feedbackMessage, /Нет данных глубины/);
});

test('опорой может служить локоть, запястье или оба', () => {
  for (const side of ['left', 'right']) {
    for (const support of ['elbow', 'wrist', 'both']) {
      const result = analyzer().update(makePose({ side, support }));
      assert.equal(result.isFormCorrect, true, `${side} ${support}: ${result.feedbackMessage}`);
    }
  }
});

test('без опорной руки или с поднятой опорной рукой удержание приостановлено', () => {
  for (const support of ['none', 'raised']) {
    const result = analyzer().update(makePose({ support }));
    assert.equal(result.isFormCorrect, false);
    assert.match(result.feedbackMessage, /локоть или запястье опорной руки/);
  }
});

test('свободная верхняя рука не подменяет невидимую опорную', () => {
  const pose = makePose({ side: 'left', support: 'none' });
  pose[14] = { x: 150 / 800, y: 310 / 600, z: 0, visibility: 1, presence: 1 };
  pose[16] = { x: 165 / 800, y: 310 / 600, z: 0, visibility: 1, presence: 1 };
  const result = analyzer().update(pose);
  assert.equal(result.isFormCorrect, false);
  assert.match(result.feedbackMessage, /локоть или запястье опорной руки/);
});

test('лежание на боку не засчитывается по приблизительной линии опор', () => {
  for (const side of ['left', 'right']) {
    for (const mirrored of [false, true]) {
      const plank = analyzer();
      plank.update(makePose({ side, mirrored }), 0);
      plank.update(makePose({ side, mirrored }), 1);
      const result = plank.update(makePose({ side, mirrored, fallen: true }), 1);
      assert.equal(result.isFormCorrect, false);
      near(result.activeHoldTime, 1);
      assert.match(result.feedbackMessage, /Поднимитесь с пола/);
    }
  }
});

test('сомнительная высота одной части корпуса не подтверждает форму', () => {
  const pose = makePose();
  // Опорное плечо около линии пола, таз остаётся выше.
  pose[11].y = 290 / 600;
  pose[12].y = 200 / 600;
  const result = analyzer().update(pose);
  assert.equal(result.isFormCorrect, false);
  assert.match(result.feedbackMessage, /не удаётся подтвердить/i);
});

test('опоры не экстраполируются далеко за пределы их отрезка', () => {
  const pose = makePose();
  pose[13].x = 300 / 800;
  pose[15].x = 300 / 800;
  const result = analyzer().update(pose);
  assert.equal(result.isFormCorrect, false);
  assert.match(result.feedbackMessage, /положение относительно пола не видно/);
});

test('слишком крутая линия опор не объявляется полом', () => {
  const pose = makePose();
  pose[13].y = 100 / 600;
  pose[15].y = 100 / 600;
  const result = analyzer().update(pose);
  assert.equal(result.isFormCorrect, false);
  assert.match(result.feedbackMessage, /положение относительно пола не видно/);
});

test('локоть далеко от опорного плеча не принимается за опору', () => {
  const pose = makePose({ support: 'elbow' });
  pose[13].x = 0;
  pose[13].y = 590 / 600;
  const result = analyzer().update(pose);
  assert.equal(result.isFormCorrect, false);
  assert.match(result.feedbackMessage, /положение относительно пола не видно/);
});

test('лодыжки могут служить оценкой опоры, если пятки и носки не видны', () => {
  const pose = makePose();
  for (const index of [29, 30, 31, 32]) pose[index].visibility = 0;
  assert.equal(analyzer().update(pose).isFormCorrect, true);
});

test('неправдоподобно далёкая точка стопы игнорируется', () => {
  const pose = makePose();
  for (const index of [29, 30, 31, 32]) {
    pose[index].x = 0.9;
    pose[index].y = 0.95;
  }
  assert.equal(analyzer().update(pose).isFormCorrect, true);
});

test('колени, оказавшиеся далеко ниже линии опор, делают оценку пола ненадёжной', () => {
  const pose = makePose();
  pose[25].y = 580 / 600;
  const result = analyzer().update(pose);
  assert.equal(result.isFormCorrect, false);
  assert.match(result.feedbackMessage, /положение относительно пола не видно/);
});

test('недоступные колени не заменяют и не блокируют заданную проверку оси', () => {
  const pose = makePose();
  pose[25].visibility = 0;
  pose[26].visibility = 0;
  assert.equal(analyzer().update(pose).isFormCorrect, true);
});

test('наклон камеры компенсируется линией пола, также в зеркале', () => {
  for (const roll of [-8, 8]) {
    for (const mirrored of [false, true]) {
      for (const [angle, correct] of [[155, false], [165, true], [180, true], [185, true], [190, false]]) {
        const result = analyzer().update(makePose({ roll, mirrored, angle }));
        assert.equal(result.isFormCorrect, correct, `${roll} ${mirrored} ${angle}: ${result.feedbackMessage}`);
      }
    }
  }
});

test('оценка плеч относительно наклонной линии пола не зависит от поворота камеры', () => {
  for (const roll of [-8, 8]) {
    for (const twist of [0, 19.9, 20, 20.1, 30]) {
      const result = analyzer().update(makePose({ roll, twist, twistAxis: 'depth' }));
      assert.equal(result.isFormCorrect, twist <= 20, `${roll} ${twist}: ${result.feedbackMessage}`);
    }
  }
});

test('отклонение плеч в плоскости кадра сравнивается с наклонным полом', () => {
  for (const roll of [-8, 8]) {
    for (const twist of [-25, -20, 0, 20, 25]) {
      const result = analyzer().update(makePose({ roll, twist, twistAxis: 'image' }));
      assert.equal(result.isFormCorrect, Math.abs(twist) <= 20, `${roll} ${twist}: ${result.feedbackMessage}`);
    }
  }
});

test('пороговые значения не меняются при масштабе тела в кадре', () => {
  for (const scale of [0.5, 0.8, 1.2]) {
    for (const [angle, twist, correct] of [[165, 0, true], [185, 20, true], [164, 0, false], [180, 21, false]]) {
      const pose = makePose({ angle, twist });
      for (const point of pose) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        point.x = point.x * scale;
        point.y = point.y * scale;
        if (Number.isFinite(point.z)) point.z *= scale;
      }
      const result = analyzer().update(pose);
      assert.equal(result.isFormCorrect, correct, `${scale} ${angle} ${twist}: ${result.feedbackMessage}`);
    }
  }
});

test('смена опорной стороны не засчитывает неизвестный промежуток', () => {
  const plank = analyzer();
  plank.update(makePose({ side: 'left' }), 0);
  plank.update(makePose({ side: 'left' }), 1);
  near(plank.update(makePose({ side: 'right' }), 1).activeHoldTime, 1);
  near(plank.update(makePose({ side: 'right' }), 0.5).activeHoldTime, 1.5);
});

test('при большом промежутке между кадрами время не прибавляется', () => {
  const plank = analyzer();
  const good = makePose();
  plank.update(good, 0);
  near(plank.update(good, 2).activeHoldTime, 2);
  near(plank.update(good, 2.01).activeHoldTime, 2);
  near(plank.update(good, 0.5).activeHoldTime, 2.5);
});

test('resetTracking сохраняет время, reset начинает подход заново', () => {
  const plank = analyzer();
  const good = makePose();
  plank.update(good, 0);
  plank.update(good, 1);
  plank.resetTracking();
  near(plank.update(good, 1).activeHoldTime, 1);
  near(plank.update(good, 0.5).activeHoldTime, 1.5);
  plank.reset();
  near(plank.update(good, 1).activeHoldTime, 0);
  near(plank.update(good, 0.5).activeHoldTime, 0.5);
});

test('невалидный deltaTime сбрасывает связь кадров, но не накопленное время', () => {
  for (const invalid of [-1, NaN, Infinity, '1']) {
    const plank = analyzer();
    const good = makePose();
    plank.update(good, 0);
    plank.update(good, 1);
    assert.throws(() => plank.update(good, invalid), RangeError);
    near(plank.update(good, 1).activeHoldTime, 1);
    near(plank.update(good, 0.5).activeHoldTime, 1.5);
  }
});

test('конструктор проверяет максимальный промежуток', () => {
  for (const invalid of [0, -1, NaN, Infinity, '1']) {
    assert.throws(() => analyzer({ maxFrameGapSeconds: invalid }), TypeError);
  }
});

test('изменение пропорций кадра прерывает интервал, одинаковые пропорции — нет', () => {
  const plank = analyzer();
  const good = makePose();
  plank.update(good, 0);
  plank.update(good, 1);
  plank.setFrameSize(1600, 1200);
  near(plank.update(good, 0.5).activeHoldTime, 1.5);
  plank.setFrameSize(1280, 720);
  const wide = makePose({ width: 1280, height: 720 });
  near(plank.update(wide, 1).activeHoldTime, 1.5);
  near(plank.update(wide, 0.5).activeHoldTime, 2);
});

test('размеры и соотношение сторон видеокадра учитываются для X, Y и Z', () => {
  for (const [width, height] of [[800, 600], [1280, 720], [700, 1000]]) {
    for (const twist of [0, 19.9, 20.1]) {
      const plank = analyzer({ videoWidth: width, videoHeight: height });
      const result = plank.update(makePose({ width, height, twist }));
      assert.equal(result.isFormCorrect, twist < 20, `${width}×${height}, ${twist}: ${result.feedbackMessage}`);
    }
  }
});

test('недопустимые размеры отклоняются без изменения накопленного времени', () => {
  const plank = analyzer();
  const good = makePose();
  plank.update(good, 0);
  plank.update(good, 1);
  for (const [width, height] of [[0, 1], [1, -1], [NaN, 1], [1, Infinity], ['800', 600]]) {
    assert.throws(() => plank.setFrameSize(width, height), TypeError);
  }
  near(plank.update(good, 0.5).activeHoldTime, 1.5);
});

test('требуются оба плеча, обе точки таза и обе лодыжки', () => {
  for (const index of [11, 12, 23, 24, 27, 28]) {
    const pose = makePose();
    pose[index].visibility = 0.49;
    const result = analyzer().update(pose);
    assert.equal(result.isFormCorrect, false, String(index));
    assert.match(result.feedbackMessage, /оба плеча, таз и обе лодыжки/);
  }
});

test('0.5 уверенности допустима, отсутствие или порча координат ставит на паузу', () => {
  const plank = analyzer();
  const pose = makePose();
  for (const index of [11, 12, 13, 15, 23, 24, 27, 28]) {
    pose[index].visibility = 0.5;
    pose[index].presence = 0.5;
  }
  assert.equal(plank.update(pose).isFormCorrect, true);
  const corruptions = [
    (p) => { p[23].x = NaN; }, (p) => { p[24].y = -0.01; },
    (p) => { p[27].x = 1.01; }, (p) => { p[28].presence = NaN; },
    (p) => { p[11] = null; }
  ];
  for (const corrupt of corruptions) {
    const bad = makePose();
    corrupt(bad);
    assert.equal(plank.update(bad, 1).isFormCorrect, false);
  }
});

test('совпадающие или практически совпадающие плечи не подтверждают положение', () => {
  const coincident = makePose();
  coincident[11] = { ...coincident[12] };
  const coincidentResult = analyzer().update(coincident);
  assert.equal(coincidentResult.isFormCorrect, false);
  assert.match(coincidentResult.feedbackMessage, /плеча раздельно/);
  const close = makePose();
  close[11].y = 136 / 600;
  close[12].y = 124 / 600;
  const closeResult = analyzer().update(close);
  assert.equal(closeResult.isFormCorrect, false);
  assert.match(closeResult.feedbackMessage, /плеча раздельно/);
});

test('вырожденная ось и вертикальная стойка не принимаются за планку', () => {
  const collapsed = makePose();
  for (const [hip, shoulder] of [[23, 11], [24, 12]]) collapsed[hip] = { ...collapsed[shoulder] };
  assert.equal(analyzer().update(collapsed).isFormCorrect, false);
  const standing = makePose();
  for (const index of [11, 12, 23, 24, 27, 28]) standing[index].x = 0.5;
  for (const index of [11, 12]) standing[index].y = 0.15;
  for (const index of [23, 24]) standing[index].y = 0.45;
  for (const index of [27, 28]) standing[index].y = 0.75;
  assert.equal(analyzer().update(standing).isFormCorrect, false);
});

test('одновременные ошибки оси и плеч выводятся вместе', () => {
  const result = analyzer().update(makePose({ angle: 150, twist: 30 }));
  assert.equal(result.isFormCorrect, false);
  assert.match(result.feedbackMessage, /Поднимите бедра выше/);
  assert.match(result.feedbackMessage, /не скручивайте корпус/);
});
