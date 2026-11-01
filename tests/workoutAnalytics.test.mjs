import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../workoutAnalytics.js', import.meta.url), 'utf8');
const { WorkoutAnalytics, scoreCategory, coachTip } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const pose = () => Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1, presence: 1 }));
const sample = (phase, count, errors = []) => ({ currentPhase: phase, repCount: count, currentErrors: errors });
const observe = (stats, phase, count, errors = [], points = pose(), analyzer = {}) =>
  stats.observe(sample(phase, count, errors), { landmarks: points, analyzer });

function squat(stats, count, errors = []) {
  observe(stats, 'DESCENDING', count - 1);
  observe(stats, 'BOTTOM', count - 1);
  observe(stats, 'ASCENDING', count - 1);
  observe(stats, 'STANDING', count, errors);
}

test('без повторов нет ни оценки, ни утверждения об идеальной технике', () => {
  const stats = new WorkoutAnalytics('squat', 'reps');
  const result = stats.snapshot(1200, 0);
  assert.equal(result.scorePercent, null);
  assert.equal(result.assessedReps, 0);
  assert.equal(result.cleanReps, 0);
  assert.deepEqual(result.errors, []);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.errors));
  assert.deepEqual(scoreCategory(null), { level: 'unknown', label: 'Недостаточно данных' });
});

test('ошибка на многих кадрах учитывается один раз на завершённый повтор; несколько ошибок остаются раздельными', () => {
  const stats = new WorkoutAnalytics('squat', 'reps');
  const back = 'Чрезмерный наклон корпуса';
  const shallow = 'Недостаточная глубина приседания';
  observe(stats, 'DESCENDING', 0, [back]);
  observe(stats, 'BOTTOM', 0, [back, shallow]);
  observe(stats, 'ASCENDING', 0, [back]);
  observe(stats, 'STANDING', 1, [shallow]);
  squat(stats, 2, [shallow]);
  squat(stats, 3);
  const result = stats.snapshot(6000, 3);
  assert.equal(result.cleanReps, 1);
  assert.equal(result.flaggedReps, 2);
  assert.equal(result.assessedReps, 3);
  assert.equal(result.scorePercent, 33.3);
  assert.deepEqual(result.errors.map(({ name, count }) => [name, count]), [[shallow, 2], [back, 1]]);
  assert.ok(result.errors.every(Object.isFrozen));
});

test('промежуточный недосед, исправленный до конца движения, не сохраняется как итоговая ошибка', () => {
  const stats = new WorkoutAnalytics('squat', 'reps');
  const shallow = 'Недостаточная глубина приседания';
  observe(stats, 'DESCENDING', 0);
  observe(stats, 'BOTTOM', 0, [shallow]);
  observe(stats, 'DESCENDING', 0);
  observe(stats, 'ASCENDING', 0);
  observe(stats, 'STANDING', 1);
  const result = stats.snapshot(3000, 1);
  assert.equal(result.scorePercent, 100);
  assert.equal(result.cleanReps, 1);
  assert.deepEqual(result.errors, []);
});

test('потерянные точки не превращают неподтверждённый повтор в чистый', () => {
  const stats = new WorkoutAnalytics('squat', 'reps');
  observe(stats, 'DESCENDING', 0);
  observe(stats, 'BOTTOM', 0, [], null);
  observe(stats, 'ASCENDING', 0);
  observe(stats, 'STANDING', 1);
  const result = stats.snapshot(3000, 1);
  assert.equal(result.unknownReps, 1);
  assert.equal(result.cleanReps, 0);
  assert.equal(result.scorePercent, null);
});

test('подтверждённое замечание остаётся замечанием даже при пропущенных кадрах', () => {
  const stats = new WorkoutAnalytics('squat', 'reps');
  observe(stats, 'DESCENDING', 0, ['Чрезмерный наклон корпуса']);
  observe(stats, 'BOTTOM', 0, [], null);
  observe(stats, 'STANDING', 1);
  const result = stats.snapshot(3000, 1);
  assert.equal(result.flaggedReps, 1);
  assert.equal(result.unknownReps, 0);
  assert.equal(result.scorePercent, 0);
});

test('незавершённая попытка после seek не переносит ошибки в следующий повтор', () => {
  const stats = new WorkoutAnalytics('squat', 'reps');
  observe(stats, 'DESCENDING', 0, ['Чрезмерный наклон корпуса']);
  stats.cancelAttempt();
  squat(stats, 1);
  const result = stats.snapshot(3000, 1);
  assert.equal(result.cleanReps, 1);
  assert.deepEqual(result.errors, []);
});

test('анализаторы с итоговыми ошибками не закрепляют временные подсказки', () => {
  const stats = new WorkoutAnalytics('deadlift', 'reps');
  observe(stats, 'HINGING', 0);
  observe(stats, 'BOTTOM', 0, ['Заданный ориентир наклона не достигнут']);
  observe(stats, 'RISING', 0);
  observe(stats, 'START', 1); // в итоговом снимке ориентир достигнут
  const result = stats.snapshot(3000, 1);
  assert.equal(result.cleanReps, 1);
  assert.deepEqual(result.errors, []);
});

test('ошибки завершённых незасчитанных попыток показываются, но не входят в оценку повторов', () => {
  const stats = new WorkoutAnalytics('gluteBridge', 'reps');
  observe(stats, 'LIFTING', 0);
  observe(stats, 'LOWERING', 0);
  observe(stats, 'BOTTOM', 0, ['Недостаточный подъём таза']);
  let result = stats.snapshot(3000, 0);
  assert.equal(result.scorePercent, null);
  assert.deepEqual(result.errors.map(({ name, count }) => [name, count]), [['Недостаточный подъём таза', 1]]);
  observe(stats, 'LIFTING', 0);
  observe(stats, 'PEAK', 0);
  observe(stats, 'BOTTOM', 1);
  result = stats.snapshot(6000, 1);
  assert.equal(result.scorePercent, 100);
  assert.equal(result.errors[0].count, 1);
});

test('подтягивания: разбор предыдущей попытки не смешивается с ошибками новой', () => {
  const stats = new WorkoutAnalytics('pullup', 'reps');
  const analyzer = { summaryAttempt: null };
  observe(stats, 'PULLING', 0, [], pose(), analyzer);
  analyzer.summaryAttempt = { sequence: 1, counted: false, errors: ['Недотяг сверху'] };
  observe(stats, 'TOP', 0, ['Недотяг сверху', 'Неполная амплитуда снизу'], pose(), analyzer);
  observe(stats, 'LOWERING', 0, [], pose(), analyzer);
  analyzer.summaryAttempt = { sequence: 2, counted: true, errors: [] };
  observe(stats, 'HANG', 1, [], pose(), analyzer);
  const result = stats.snapshot(2000, 1);
  assert.equal(result.cleanReps, 1);
  assert.deepEqual(result.errors.map(({ name, count }) => [name, count]), [['Недотяг сверху', 1]]);
});

test('неизвестный набор ошибок и несколько повторов за один кадр не считаются чистыми', () => {
  const stats = new WorkoutAnalytics('lunge', 'reps');
  observe(stats, 'LUNGING', 0);
  stats.observe({ currentPhase: 'STANDING', repCount: 2 }, { landmarks: pose() });
  const result = stats.snapshot(2000, 2);
  assert.equal(result.unknownReps, 2);
  assert.equal(result.cleanReps, 0);
  assert.equal(result.scorePercent, null);
});

test('границы оценки соответствуют 85% и 60%; красная зона не утверждает риск травмы', () => {
  assert.equal(scoreCategory(85).label, 'Отличная форма');
  assert.equal(scoreCategory(84.9).label, 'Требует внимания');
  assert.equal(scoreCategory(60).label, 'Требует внимания');
  assert.equal(scoreCategory(59.9).label, 'Много замечаний');
  assert.equal(scoreCategory(0).level, 'low');
  assert.match(coachTip('squat', 'Колено выходит за носок'), /само по себе.*не означает опасную технику/i);
  assert.match(coachTip('deadlift', 'Изменение положения головы'), /позвоночник.*не оценивает/i);
});

test('для удержания доля использует только подтверждённые интервалы реального времени, не медиавремя и не паузы', () => {
  const stats = new WorkoutAnalytics('plank', 'time');
  const frame = (wallTimeMs, activeHoldTime, epoch = 0, pausedPreview = false) =>
    stats.observe({ activeHoldTime }, { frame: { wallTimeMs, pausedPreview }, epoch, analyzer: { maxFrameGapSeconds: 1 } });
  frame(100, 0);
  frame(300, 0.1); // в замедленном видео 0.1 с медиавремени, но 0.2 с реального
  frame(400, 0.1, 0, true);
  frame(1000, 0.1, 1);
  frame(1100, 0.2, 1);
  frame(5000, 0.3, 1); // слишком большой пропуск не подтверждён
  const result = stats.snapshot(5000);
  assert.equal(result.confirmedWallMs, 300);
  assert.equal(result.holdRatioPercent, 6);
  assert.equal(result.scorePercent, null);
  assert.equal(result.cleanReps, null);
  assert.deepEqual(result.errors, []);
});

test('удержание без кадров или без измеримой длительности не получает выдуманный процент', () => {
  const stats = new WorkoutAnalytics('sidePlank', 'time');
  assert.equal(stats.snapshot(1000).holdRatioPercent, null);
  stats.observe({ activeHoldTime: 0 }, { frame: { wallTimeMs: 1 }, epoch: 0 });
  assert.equal(stats.snapshot(0).holdRatioPercent, null);
  assert.equal(stats.snapshot(1000).holdRatioPercent, 0);
});


test('округление не переносит долю через границу категории', () => {
  const stats = new WorkoutAnalytics('squat', 'reps');
  stats.cleanReps = 1699; stats.flaggedReps = 301; // 84,95%
  let score = stats.snapshot(1000, 2000).scorePercent;
  assert.equal(score, 84.9);
  assert.equal(scoreCategory(score).label, 'Требует внимания');
  stats.cleanReps = 1199; stats.flaggedReps = 801; // 59,95%
  score = stats.snapshot(1000, 2000).scorePercent;
  assert.equal(score, 59.9);
  assert.equal(scoreCategory(score).label, 'Много замечаний');
  stats.cleanReps = 17; stats.flaggedReps = 3;
  assert.equal(scoreCategory(stats.snapshot(1000, 20).scorePercent).label, 'Отличная форма');
  stats.cleanReps = 3; stats.flaggedReps = 2;
  assert.equal(scoreCategory(stats.snapshot(1000, 5).scorePercent).label, 'Требует внимания');
});
