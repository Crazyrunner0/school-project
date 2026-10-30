import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { browserModuleUrls } from './helpers/moduleLoader.mjs';

// Загружаем реальный app.js в минимальном DOM без камеры и сторонних зависимостей.
const { geometryUrl, analyzerUrl, factoryUrl } = await browserModuleUrls();
const { SQUAT_PHASE: PHASE, SQUAT_ERROR: ERROR } = await import(analyzerUrl);

const strokes = [];
const angleTexts = [];
const context = {
  currentPath: [],
  clearRect() {},
  beginPath() { this.currentPath = []; },
  moveTo(x, y) { this.currentPath.push(['M', x, y]); },
  lineTo(x, y) { this.currentPath.push(['L', x, y]); },
  arc() {},
  stroke() { strokes.push({ color: this.strokeStyle, points: [...this.currentPath] }); },
  fill() {},
  save() {},
  restore() {},
  translate() {},
  scale() {},
  measureText(text) { return { width: text.length * 8 }; },
  strokeText(text) { angleTexts.push(text); },
  fillText() {}
};
const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      textContent: '',
      dataset: {},
      style: {},
      width: 640,
      height: 640,
      classList: { toggle() {}, contains() { return false; } },
      addEventListener() {},
      getContext() { return context; },
      getBoundingClientRect() { return { width: 640, height: 640 }; },
      setAttribute() {},
      getAttribute() { return null; },
      toggleAttribute() {}
    });
  }
  return elements.get(id);
}
globalThis.document = { getElementById: element, querySelectorAll: () => [] };
globalThis.window = { addEventListener() {} };
const appSource = (await readFile(new URL('../app.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`)
  .replace("'./analyzer.js'", `'${analyzerUrl}'`)
  .replace("'./exerciseFactory.js'", `'${factoryUrl}'`)
  + '\nexport { chooseAdvice, updateAdvice, resetAdvice, drawPose, selectExercise, currentAnalyzer as squatAnalyzer };'
  + '\nexport function setConnectionsForTest(value) { poseConnections = value; }'
  + '\nexport function activateWorkoutForTest() { workout.active = true; workout.goal = null; }'
  + '\nexport function deactivateWorkoutForTest() { workout.active = false; }\n';
const appUrl = `data:text/javascript;base64,${Buffer.from(appSource).toString('base64')}`;
const { chooseAdvice, updateAdvice, resetAdvice, drawPose, selectExercise, squatAnalyzer, setConnectionsForTest, activateWorkoutForTest, deactivateWorkoutForTest } = await import(appUrl);
activateWorkoutForTest();

afterImportCleanup();
function afterImportCleanup() {
  delete globalThis.document;
  delete globalThis.window;
}

function status({ errors = [], phase = PHASE.DESCENDING, feedback = 'Опускайтесь подконтрольно.' } = {}) {
  return { repCount: 0, currentPhase: phase, currentErrors: errors, feedbackMessage: feedback };
}
function shown() {
  return { level: element('advice-banner').dataset.level, text: element('squat-feedback').textContent };
}

test('подсказки различают отсутствие позы, ракурс, положительную и промежуточную глубину', () => {
  assert.equal(chooseAdvice(status({ phase: PHASE.WAITING, feedback: 'Покажите камере таз, колени и лодыжки.' })).key, 'no-pose');
  assert.equal(chooseAdvice(status({ feedback: 'Ракурс не определён: выберите вид спереди или сбоку.' })).level, 'neutral');
  assert.equal(chooseAdvice(status({ phase: PHASE.BOTTOM, feedback: 'Достигнута целевая глубина. Поднимайтесь.' })).level, 'good');
  assert.equal(chooseAdvice(status({ phase: PHASE.BOTTOM, feedback: 'Глубина близка к цели. Поднимайтесь.' })).level, 'warning');
  assert.equal(chooseAdvice(status({ phase: PHASE.STANDING, feedback: 'Повтор засчитан. Глубина недостаточна: ориентир — около 90° в колене.' })).key, 'previous-shallow');
});

test('ошибки приоритетнее других сообщений; наклон важнее глубины и предупреждения коленей', () => {
  const advice = chooseAdvice(status({ errors: [ERROR.KNEES_INWARD, ERROR.SHALLOW, ERROR.BACK_LEAN] }));
  assert.equal(advice.key, 'back');
  assert.equal(advice.level, 'danger');
  assert.equal(chooseAdvice(status({ errors: [ERROR.KNEES_INWARD, ERROR.SHALLOW] })).key, 'shallow');
  assert.equal(chooseAdvice(status({ errors: [ERROR.KNEE_PAST_TOE] })).level, 'warning');
});

test('ошибка остаётся не менее 1800 мс и одинаковые кадры не продлевают таймер', () => {
  resetAdvice();
  const danger = status({ errors: [ERROR.BACK_LEAN] });
  const good = status();
  updateAdvice(danger, 100);
  assert.equal(shown().level, 'danger');
  updateAdvice(danger, 1700);
  updateAdvice(good, 1899);
  assert.equal(shown().level, 'danger');
  updateAdvice(good, 1900);
  assert.equal(shown().level, 'good');
});

test('более серьёзная ошибка появляется немедленно, а другая ошибка не мерцает', () => {
  resetAdvice();
  updateAdvice(status({ errors: [ERROR.KNEES_INWARD] }), 100);
  assert.equal(shown().level, 'warning');
  updateAdvice(status({ errors: [ERROR.BACK_LEAN] }), 150);
  assert.equal(shown().level, 'danger');
  assert.match(shown().text, /наклон корпуса/i);
  updateAdvice(status({ errors: [ERROR.SHALLOW] }), 1000);
  assert.match(shown().text, /наклон корпуса/i);
  updateAdvice(status({ errors: [ERROR.SHALLOW] }), 1950);
  assert.match(shown().text, /глубина/i);
  // Предупреждение о корпусе приоритетнее даже другого красного сообщения.
  updateAdvice(status({ errors: [ERROR.BACK_LEAN] }), 1951);
  assert.match(shown().text, /наклон корпуса/i);
});

test('краткая нижняя точка сразу показывает достигнутую глубину', () => {
  resetAdvice();
  updateAdvice(status(), 0);
  updateAdvice(status({ phase: PHASE.BOTTOM, feedback: 'Достигнута целевая глубина. Поднимайтесь.' }), 50);
  assert.match(shown().text, /глубина достигнута/i);
  updateAdvice(status({ phase: PHASE.ASCENDING }), 100);
  assert.match(shown().text, /глубина достигнута/i);
  updateAdvice(status({ phase: PHASE.ASCENDING }), 650);
  assert.match(shown().text, /стойку/i);
});

test('обычные подсказки удерживаются 600 мс, сброс очищает старое предупреждение', () => {
  resetAdvice();
  updateAdvice(status(), 100);
  const before = shown();
  updateAdvice(status({ phase: PHASE.ASCENDING }), 699);
  assert.deepEqual(shown(), before);
  updateAdvice(status({ phase: PHASE.ASCENDING }), 700);
  assert.match(shown().text, /стойку/i);
  updateAdvice(status({ errors: [ERROR.BACK_LEAN] }), 701);
  resetAdvice();
  assert.equal(shown().level, 'neutral');
  assert.match(shown().text, /Встаньте прямо/i);
  updateAdvice(status(), 702);
  assert.equal(shown().level, 'good');
});


test('Canvas рисует неоновый скелет и красным только проблемный сегмент корпуса', () => {
  resetAdvice();
  squatAnalyzer.reset();
  squatAnalyzer.setView('front');
  setConnectionsForTest([{ start: 11, end: 23 }, { start: 12, end: 24 }]);
  const pose = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const set = (index, x, y) => { pose[index] = { x, y, visibility: 1 }; };
  set(11, 0.65, 0.2); set(23, 0.35, 0.4); set(25, 0.35, 0.6); set(27, 0.35, 0.8);
  set(12, 0.65, 0.2); set(24, 0.65, 0.4); set(26, 0.65, 0.6); set(28, 0.65, 0.8);
  strokes.length = 0;
  drawPose({ landmarks: [pose] });
  assert.ok(strokes.some((stroke) => stroke.color === 'rgba(102, 255, 191, 0.82)'));
  assert.ok(angleTexts.length > 0, 'подписи углов доступны для приседаний');
  const red = strokes.filter((stroke) => stroke.color === '#ff4954');
  assert.equal(red.length, 1);
  assert.deepEqual(red[0].points, [['M', 0.65 * 640, 0.2 * 640], ['L', 0.35 * 640, 0.4 * 640]]);
  assert.match(shown().text, /наклон корпуса/i);
  drawPose({ landmarks: [] });
  assert.deepEqual(squatAnalyzer.getHighlightedSegments(), []);
});

test('другие упражнения не получают приседальные углы и сегменты подсветки', () => {
  deactivateWorkoutForTest();
  selectExercise('bicepCurl');
  activateWorkoutForTest();
  const pose = Array.from({ length: 33 }, () => ({ x: 0.4, y: 0.4, visibility: 1 }));
  strokes.length = 0;
  angleTexts.length = 0;
  drawPose({ landmarks: [pose] });
  assert.ok(strokes.some((stroke) => stroke.color === 'rgba(102, 255, 191, 0.82)'));
  assert.ok(strokes.every((stroke) => !['#ff4954', '#ffcf63'].includes(stroke.color)));
  assert.deepEqual(angleTexts, []);
});
