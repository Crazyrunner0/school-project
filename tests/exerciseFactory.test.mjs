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
    assert.ok(EXERCISES[id].goals.includes(EXERCISES[id].defaultGoal));
    assert.equal(EXERCISES[id].mode === 'time', ['plank', 'sidePlank'].includes(id));
    assert.equal(EXERCISES[id].input === 'delta', ['plank', 'sidePlank'].includes(id));
    assert.equal(EXERCISES[id].input === 'timestamp', ['jumpingJacks', 'pullup'].includes(id));
  }
});

test('HTML-селектор соответствует каталогу; отсутствующие отжимания и произвольные ключи отклоняются', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const select = html.match(/<select id="exercise-select"[\s\S]*?<\/select>/)?.[0];
  assert.ok(select);
  const options = [...select.matchAll(/<option value="([^"]+)">/g)].map((match) => match[1]);
  assert.deepEqual(options, Object.keys(expected));
  for (const id of ['pushup', '__proto__', 'constructor', '', 'not-exercise']) {
    assert.throws(() => createAnalyzer(id), RangeError);
  }
});
