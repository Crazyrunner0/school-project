import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Тот же модуль, что использует браузер: Node запускает ES-модуль без сборки.
const source = await readFile(new URL('../../workoutAnalytics.js', import.meta.url));
export const { WorkoutAnalytics, coachTip } =
  await import(`data:text/javascript;base64,${source.toString('base64')}`);

// Пропускаем реальные результаты автомата через сборщик с исходными landmarks.
export function trackWorkout(analyzer, exerciseId) {
  const stats = new WorkoutAnalytics(exerciseId, 'reps');
  const update = analyzer.update.bind(analyzer);
  analyzer.update = (landmarks, ...args) => {
    const result = update(landmarks, ...args);
    stats.observe(result, { landmarks, analyzer });
    return result;
  };
  return stats;
}

export function assertAllRecommendations(exerciseId, errors) {
  const fallback = coachTip(exerciseId, '__unknown_error__');
  for (const error of Object.values(errors)) {
    assert.notEqual(coachTip(exerciseId, error), fallback, `${exerciseId}: нет рекомендации для ${error}`);
  }
}
