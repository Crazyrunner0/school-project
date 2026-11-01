import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { browserModuleUrls } from './helpers/moduleLoader.mjs';

const { factoryUrl } = await browserModuleUrls();
const { EXERCISES, createAnalyzer } = await import(factoryUrl);
const expected = {
  squat: 'SquatAnalyzer', plank: 'PlankAnalyzer', sidePlank: 'SidePlankAnalyzer',
  bicepCurl: 'BicepCurlAnalyzer', lunge: 'LungeAnalyzer', overheadPress: 'OverheadPressAnalyzer',
  deadlift: 'DeadliftAnalyzer', jumpingJacks: 'JumpingJacksAnalyzer',
  gluteBridge: 'GluteBridgeAnalyzer', pullup: 'PullUpAnalyzer'
};

const cardMetadata = {
  squat: ['Ноги', 'Камера спереди или сбоку'],
  plank: ['Кор', 'Камера сбоку'],
  sidePlank: ['Кор', 'Камера спереди'],
  bicepCurl: ['Бицепс', 'Камера сбоку'],
  lunge: ['Ноги', 'Камера сбоку'],
  overheadPress: ['Плечи', 'Камера спереди или сбоку'],
  deadlift: ['Задняя цепь', 'Камера строго сбоку'],
  jumpingJacks: ['Всё тело', 'Камера спереди'],
  gluteBridge: ['Ягодицы', 'Камера строго сбоку'],
  pullup: ['Спина', 'Камера спереди · видно лицо']
};

test('фабрика создаёт независимый работающий экземпляр для каждого доступного упражнения', () => {
  assert.deepEqual(Object.keys(EXERCISES), Object.keys(expected));
  for (const [id, className] of Object.entries(expected)) {
    const a = createAnalyzer(id);
    const b = createAnalyzer(id);
    assert.equal(a.constructor.name, className);
    assert.notEqual(a, b);
    for (const method of ['update', 'setFrameSize', 'resetTracking', 'reset']) {
      assert.equal(typeof a[method], 'function', `${id}.${method}`);
    }
    assert.ok(EXERCISES[id].hint && EXERCISES[id].initialAdvice);
    assert.deepEqual([EXERCISES[id].muscle, EXERCISES[id].camera], cardMetadata[id]);
    assert.ok(EXERCISES[id].goals.includes(EXERCISES[id].defaultGoal));
    assert.equal(EXERCISES[id].mode === 'time', ['plank', 'sidePlank'].includes(id));
    assert.equal(EXERCISES[id].input === 'delta', ['plank', 'sidePlank'].includes(id));
    assert.equal(EXERCISES[id].input === 'timestamp', ['jumpingJacks', 'pullup'].includes(id));
  }
});

test('карточки соответствуют каталогу; отсутствующие отжимания и произвольные ключи отклоняются', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<button class="exercise-select" id="exercise-select"/);
  assert.doesNotMatch(html, /<select[^>]*id="exercise-select"/);
  assert.match(html, /role="radiogroup" aria-label="Выбор упражнения"/);
  const cards = [...html.matchAll(/<button class="exercise-card"[^>]*data-exercise="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)];
  assert.deepEqual(cards.map((match) => match[1]), Object.keys(expected));
  for (const [card, id] of cards) {
    const exercise = EXERCISES[id];
    assert.ok(card.includes(`>${exercise.label}</span>`), `${id}: название`);
    assert.ok(card.includes(`>${exercise.muscle}</span>`), `${id}: мышцы`);
    assert.ok(card.includes(`>${exercise.mode === 'time' ? 'Таймер' : 'Повторения'}</span>`), `${id}: режим`);
    assert.ok(card.includes(`>${exercise.camera}</span>`), `${id}: ракурс`);
    assert.ok(card.includes(`href="#exercise-icon-${id}"`), `${id}: иллюстрация`);
  }
  assert.equal(cards.filter(([card]) => card.includes('aria-checked="true"')).length, 1);
  for (const id of ['pushup', '__proto__', 'constructor', '', 'not-exercise']) {
    assert.throws(() => createAnalyzer(id), RangeError);
  }
});
