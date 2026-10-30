import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { browserModuleUrls } from './helpers/moduleLoader.mjs';

// Тестируем настоящий app.js с небольшим DOM-двойником, без камеры, CDN и сборки.
const { geometryUrl, analyzerUrl, factoryUrl } = await browserModuleUrls();

class Element extends EventTarget {
  constructor(id) {
    super();
    this.id = id;
    this.textContent = '';
    this.dataset = {};
    this.style = {};
    this.open = false;
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.width = 640;
    this.height = 480;
    this.attributes = new Map();
    const classes = new Set();
    this.classList = {
      toggle(name, force) {
        if (force === undefined) force = !classes.has(name);
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
      contains: (name) => classes.has(name),
      remove: (name) => classes.delete(name)
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, force) {
    if (force === undefined) force = !this.attributes.has(name);
    if (force) this.attributes.set(name, '');
    else this.attributes.delete(name);
    return force;
  }
  getContext() {
    return {
      clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fill() {},
      save() {}, restore() {}, translate() {}, scale() {}, strokeText() {}, fillText() {},
      measureText: (text) => ({ width: text.length * 8 })
    };
  }
  getBoundingClientRect() { return { width: 320, height: 240 }; }
  focus() { this.dispatchEvent(new Event('focus')); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  click() { this.dispatchEvent(new Event('click')); }
}

class Video extends Element {
  constructor() {
    super('camera');
    this.srcObject = null;
    this._src = '';
    this.currentSrc = '';
    this.videoWidth = 320;
    this.videoHeight = 240;
    this.readyState = 2;
    this.currentTime = 0;
    this.duration = 5;
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.loop = false;
    this.autoplay = true;
    this.error = null;
    this.playCalls = 0;
  }
  set src(value) { this._src = value; this.currentSrc = value; }
  get src() { return this._src; }
  removeAttribute(name) {
    super.removeAttribute(name);
    if (name === 'src') this._src = this.currentSrc = '';
  }
  load() {}
  play() {
    this.playCalls += 1;
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  pause() {
    if (!this.paused) {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }
  }
}

const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, id === 'camera' ? new Video() : new Element(id));
  return elements.get(id);
}
const video = element('camera');
const rafs = new Map();
let rafId = 0;
let clock = 100;
let urlId = 0;
const created = [];
const revoked = [];
const detections = [];
let testPose = null;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
const realNow = performance.now;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
URL.createObjectURL = () => {
  const url = `blob:test/${++urlId}`;
  created.push(url);
  return url;
};
URL.revokeObjectURL = (url) => revoked.push(url);
Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {} } });
const goalOptions = [5, 10, 15, 20].map((value) => {
  const button = new Element(`goal-${value}`);
  button.dataset.goal = String(value);
  return button;
});
globalThis.document = { getElementById: element, querySelectorAll: () => goalOptions };
globalThis.window = new EventTarget();
globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
globalThis.requestAnimationFrame = (callback) => {
  const id = ++rafId;
  rafs.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => rafs.delete(id);

const appSource = (await readFile(new URL('../app.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`)
  .replace("'./analyzer.js'", `'${analyzerUrl}'`)
  .replace("'./exerciseFactory.js'", `'${factoryUrl}'`)
  + `\nexport { formatVideoTime, loadVideoFile, stopCamera, disposePoseLandmarker, currentAnalyzer as squatAnalyzer, currentAnalyzer, currentExerciseId, selectExercise, processPoseFrame, workout, updateWorkoutHUD, finishWorkout };
export function setModelForTest(model) { poseLandmarker = model; poseConnections = []; }
export function activateWorkoutForTest(goal = null) {
  workout.active = true; workout.goal = goal; workout.startedAt = performance.now();
  workout.lastResult = null; setWorkoutInterface(true);
}
export function resetWorkoutForTest() {
  workout.active = false; workout.goal = null; workout.startedAt = 0; workout.lastResult = null;
  pendingSource = null; lastSource = { mode: 'camera' }; audioContext = null;
  selectExercise('squat');
  closeDialog(setupDialog); closeDialog(resultsDialog); setWorkoutInterface(false);
}
export function holdModelForTest(pending) {
  poseLandmarker = null;
  poseInitializationPromise = pending.then((model) => { poseLandmarker = model; return model; });
}
export function activateCameraForTest(value) { stream = value; sourceMode = 'camera'; state = 'running'; video.srcObject = value; }
export function inspectForTest() { return { sourceMode, state, fileReady, videoFileURL, lastInferenceTimestamp }; }\n`;
const appUrl = `data:text/javascript;base64,${Buffer.from(appSource).toString('base64')}`;
const app = await import(appUrl);
const fakeModel = {
  detectForVideo(source, timestamp, callback) {
    detections.push({ timestamp, currentTime: source.currentTime, paused: source.paused });
    callback({ landmarks: testPose ? [testPose] : [] });
  },
  close() {}
};

function makeStream() {
  const track = new EventTarget();
  track.readyState = 'live';
  track.stop = () => { track.readyState = 'ended'; };
  track.getSettings = () => ({ facingMode: 'user' });
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
function nextFrame() {
  const scheduled = [...rafs.values()];
  rafs.clear();
  for (const callback of scheduled) callback(clock);
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function loadFile(name = 'video.webm') {
  const pending = app.loadVideoFile({ name });
  video.dispatchEvent(new Event('loadeddata'));
  await pending;
}
function reset() {
  app.stopCamera();
  app.disposePoseLandmarker();
  app.resetWorkoutForTest();
  app.squatAnalyzer.reset();
  app.setModelForTest(fakeModel);
  clock = 100;
  app.activateWorkoutForTest();
  created.length = revoked.length = detections.length = 0;
  rafs.clear();
  video.paused = true;
  video.ended = false;
  video.seeking = false;
  video.currentTime = 0;
  video.duration = 5;
  video.videoWidth = 320;
  video.videoHeight = 240;
  video.error = null;
  video.playCalls = 0;
  testPose = null;
  delete window.AudioContext;
  delete window.webkitAudioContext;
  clock = 100;
}

test.after(() => {
  app.stopCamera();
  app.disposePoseLandmarker();
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  Object.defineProperty(performance, 'now', { configurable: true, value: realNow });
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  else delete globalThis.navigator;
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.HTMLMediaElement;
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
});

test('форматирование позиции видео учитывает минуты и часы', () => {
  assert.equal(app.formatVideoTime(NaN), '00:00');
  assert.equal(app.formatVideoTime(65.9), '01:05');
  assert.equal(app.formatVideoTime(3661), '1:01:01');
});

test('файл останавливает камеру и ждёт loadeddata, сохраняя счётчик подхода', async () => {
  reset();
  const stream = makeStream();
  app.activateCameraForTest(stream);
  app.squatAnalyzer.repCount = 4;
  let finished = false;
  const pending = app.loadVideoFile({ name: 'squat.webm' }).then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(stream.track.readyState, 'ended');
  assert.equal(video.srcObject, null);
  assert.equal(video.src, created[0]);
  assert.equal(video.autoplay, false);
  assert.equal(video.playCalls, 0);
  assert.equal(app.inspectForTest().state, 'starting');
  video.dispatchEvent(new Event('loadeddata'));
  await pending;
  assert.equal(app.inspectForTest().state, 'running');
  assert.equal(app.inspectForTest().sourceMode, 'file');
  assert.equal(video.playCalls, 1);
  assert.deepEqual([element('overlay').width, element('overlay').height], [320, 240]);
  assert.equal(app.squatAnalyzer.repCount, 4);
  assert.equal(element('video-controls').hidden, false);
  assert.equal(element('viewfinder-source').textContent, 'АНАЛИЗ ВИДЕО');
  assert.equal(element('camera-view').classList.contains('is-mirrored'), false);
  app.stopCamera();
  assert.deepEqual(revoked, created);
  assert.equal(video.src, '');
});

test('видео не воспроизводится, пока модель не закончила загрузку', async () => {
  reset();
  let releaseModel;
  app.holdModelForTest(new Promise((resolve) => { releaseModel = resolve; }));
  const pending = app.loadVideoFile({ name: 'squat.webm' });
  video.dispatchEvent(new Event('loadeddata'));
  await wait(0);
  assert.equal(app.inspectForTest().state, 'running');
  assert.equal(element('tracking-status').textContent, 'ЗАГРУЗКА МОДЕЛИ');
  assert.equal(video.paused, true);
  assert.equal(video.playCalls, 0);
  assert.equal(element('video-play').disabled, true);
  releaseModel(fakeModel);
  await pending;
  assert.equal(video.playCalls, 1);
  assert.equal(video.paused, false);
  assert.deepEqual(detections[0], { timestamp: 100, currentTime: 0, paused: true });
});

test('смена файла отменяет незавершённую загрузку и освобождает прежний URL', async () => {
  reset();
  const first = app.loadVideoFile({ name: 'first.webm' });
  const old = video.src;
  const second = app.loadVideoFile({ name: 'second.webm' });
  assert.deepEqual(revoked, [old]);
  assert.notEqual(video.src, old);
  // Запоздавшая ошибка старого ресурса не должна сломать новый файл.
  const current = video.currentSrc;
  video.currentSrc = old;
  video.error = { code: 4 };
  video.dispatchEvent(new Event('error'));
  assert.equal(app.inspectForTest().state, 'starting');
  video.currentSrc = current;
  video.error = null;
  video.dispatchEvent(new Event('loadeddata'));
  await Promise.all([first, second]);
  assert.equal(app.inspectForTest().state, 'running');
  assert.equal(element('camera-name').textContent, 'second.webm');
  assert.equal(app.inspectForTest().videoFileURL, created[1]);
  app.stopCamera();
  assert.deepEqual(revoked, created);
});

test('запоздавший getUserMedia не заменяет выбранный файл, а его треки останавливаются', async () => {
  reset();
  const lateStream = makeStream();
  let releaseCamera;
  navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => { releaseCamera = resolve; });
  element('toggle-camera').click();
  assert.equal(app.inspectForTest().state, 'starting');
  await loadFile('new.webm');
  const selected = video.src;
  releaseCamera(lateStream);
  await wait(0);
  assert.equal(lateStream.track.readyState, 'ended');
  assert.equal(app.inspectForTest().sourceMode, 'file');
  assert.equal(app.inspectForTest().state, 'running');
  assert.equal(video.src, selected);
  assert.equal(video.srcObject, null);
});

test('ошибка декодирования освобождает URL, после неё можно вернуть камеру', async () => {
  reset();
  const pending = app.loadVideoFile({ name: 'broken.mp4' });
  video.error = { code: 4 };
  video.dispatchEvent(new Event('error'));
  await pending;
  assert.equal(app.inspectForTest().state, 'error');
  assert.match(element('empty-description').textContent, /формат|кодек/i);
  assert.deepEqual(revoked, created);
  assert.equal(video.src, '');
  video.error = null;
  const stream = makeStream();
  navigator.mediaDevices.getUserMedia = async () => stream;
  element('toggle-camera').click();
  // getUserMedia, video.play и ленивый запуск анализа завершаются микрозадачами.
  await wait(0);
  assert.equal(app.inspectForTest().sourceMode, 'camera');
  assert.equal(app.inspectForTest().state, 'running');
  assert.equal(video.srcObject, stream);
  assert.equal(element('video-controls').hidden, true);
  assert.equal(element('camera-view').classList.contains('is-mirrored'), true);
  app.stopCamera();
  assert.equal(stream.track.readyState, 'ended');
});

test('запоздавшая ошибка Play не показывается для другого файла', async () => {
  reset();
  await loadFile('first.webm');
  video.pause();
  const originalPlay = video.play;
  let rejectOldPlay;
  video.play = () => new Promise((_, reject) => { rejectOldPlay = reject; });
  element('video-play').click();
  video.play = originalPlay;
  await loadFile('second.webm');
  rejectOldPlay(new DOMException('old playback failed', 'NotAllowedError'));
  await wait(0);
  assert.equal(element('camera-name').textContent, 'second.webm');
  assert.equal(element('notice').hidden, true);
  assert.equal(element('status-text').textContent, 'Видео готово');
});

test('пауза отменяет RAF; seek анализирует один кадр и сохраняет счётчик и монотонность', async () => {
  reset();
  await loadFile();
  video.currentTime = 0.3;
  nextFrame();
  video.currentTime = 0.4;
  nextFrame();
  assert.deepEqual(detections.map(({ timestamp }) => timestamp), [100, 101, 102]);
  assert.equal(rafs.size, 1);
  video.pause();
  assert.equal(rafs.size, 0);
  app.squatAnalyzer.repCount = 3;
  app.squatAnalyzer.currentPhase = 'DESCENDING';
  video.seeking = true;
  video.currentTime = 0.1;
  video.dispatchEvent(new Event('seeking'));
  assert.equal(app.squatAnalyzer.currentPhase, 'WAITING');
  assert.equal(app.squatAnalyzer.repCount, 3);
  video.seeking = false;
  video.dispatchEvent(new Event('seeked'));
  await wait(120);
  assert.equal(detections.length, 4);
  assert.equal(detections[3].paused, true);
  assert.equal(detections[3].timestamp, 103);
  assert.equal(app.squatAnalyzer.repCount, 3);
  await wait(120);
  assert.equal(detections.length, 4);
  assert.equal(rafs.size, 0);
});

test('Loop и скачок времени назад прерывают незавершённую фазу, но не обнуляют счётчик', async () => {
  reset();
  await loadFile();
  element('video-loop').click();
  assert.equal(video.loop, true);
  assert.equal(element('video-loop').getAttribute('aria-pressed'), 'true');
  video.currentTime = 4.8;
  nextFrame();
  app.squatAnalyzer.repCount = 2;
  app.squatAnalyzer.currentPhase = 'DESCENDING';
  // Проверка fallback даже в браузере, который не сгенерировал seeking на Loop.
  video.currentTime = 0.1;
  nextFrame();
  assert.equal(app.squatAnalyzer.currentPhase, 'WAITING');
  assert.equal(app.squatAnalyzer.repCount, 2);
  assert.ok(detections.at(-1).timestamp > detections.at(-2).timestamp);
  app.stopCamera();
  assert.equal(video.loop, false);
});

// Реальный автомат SquatAnalyzer получает синтетические landmarks через callback модели.
function poseAtAngle(angle) {
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const sides = [
    { shoulder: 11, hip: 23, knee: 25, ankle: 27 },
    { shoulder: 12, hip: 24, knee: 26, ankle: 28 }
  ];
  const set = (i, x, y) => { points[i] = { x: x / 320, y: y / 240, visibility: 1 }; };
  for (const [index, side] of sides.entries()) {
    const x = index ? 205 : 115;
    const direction = Math.PI / 2 + angle * Math.PI / 180;
    const hipX = x + 55 * Math.cos(direction);
    const hipY = 125 + 55 * Math.sin(direction);
    set(side.knee, x, 125); set(side.ankle, x, 180);
    set(side.hip, hipX, hipY); set(side.shoulder, hipX, hipY - 50);
  }
  return points;
}

test('при Loop повторное воспроизведение засчитывает упражнение ещё раз', async () => {
  reset();
  await loadFile();
  element('video-loop').click();
  const exercise = [175, 130, 90, 94, 120, 175];
  for (const [index, angle] of exercise.entries()) {
    video.currentTime = 1 + index * 0.5;
    testPose = poseAtAngle(angle);
    nextFrame();
  }
  assert.equal(app.squatAnalyzer.repCount, 1);
  for (const [index, angle] of exercise.entries()) {
    video.currentTime = 0.1 + index * 0.5; // начало того же ролика
    testPose = poseAtAngle(angle);
    nextFrame();
  }
  assert.equal(app.squatAnalyzer.repCount, 2);
  assert.equal(element('rep-count').textContent, '2');
  assert.ok(detections.every((frame, i) => !i || frame.timestamp > detections[i - 1].timestamp));
});

function beginIdleTest() {
  reset();
  app.resetWorkoutForTest();
  clock = 100;
}
function submitWorkout() {
  element('workout-form').dispatchEvent(new Event('submit', { cancelable: true }));
}
function selectCustom(value) {
  const input = element('custom-goal');
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event('input'));
}
function installAudioStub({ suspended = false, reject = false } = {}) {
  const calls = { contexts: 0, starts: 0, stops: 0, resumes: 0 };
  window.AudioContext = class {
    constructor() {
      calls.contexts += 1;
      this.state = suspended ? 'suspended' : 'running';
      this.currentTime = 2;
      this.destination = {};
    }
    resume() {
      calls.resumes += 1;
      if (reject) return Promise.reject(new Error('blocked'));
      this.state = 'running';
      return Promise.resolve();
    }
    createOscillator() {
      return {
        frequency: { setValueAtTime() {} },
        connect() {}, disconnect() {},
        start() { calls.starts += 1; },
        stop() { calls.stops += 1; }
      };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
    }
    close() { this.state = 'closed'; return Promise.resolve(); }
  };
  return calls;
}
function feedExercise() {
  for (const angle of [175, 130, 90, 94, 120, 175]) {
    testPose = poseAtAngle(angle);
    video.currentTime += 0.1;
    clock += 100;
    nextFrame();
  }
}

test('настройка открывается до камеры; ручное завершение сохраняет итог и новый подход сбрасывает счётчик', async () => {
  beginIdleTest();
  const audio = installAudioStub();
  const streams = [];
  navigator.mediaDevices.getUserMedia = async () => { const stream = makeStream(); streams.push(stream); return stream; };
  element('toggle-camera').click();
  assert.equal(element('workout-setup').open, true);
  assert.equal(streams.length, 0);
  assert.equal(element('finish-workout').hidden, true);
  goalOptions[0].click();
  assert.equal(goalOptions[0].getAttribute('aria-pressed'), 'true');
  assert.equal(goalOptions[1].getAttribute('aria-pressed'), 'false');
  submitWorkout();
  await wait(0);
  assert.equal(streams.length, 1);
  assert.equal(element('workout-setup').open, false);
  assert.equal(app.workout.goal, 5);
  assert.equal(element('finish-workout').hidden, false);
  assert.equal(element('rep-target').textContent, '/ 5');
  assert.equal(element('rep-progress').getAttribute('aria-valuemax'), '5');
  assert.equal(element('rep-progress').getAttribute('aria-valuenow'), '0');
  app.squatAnalyzer.repCount = 3;
  app.updateWorkoutHUD(3);
  assert.equal(element('rep-progress-fill').style.width, '60%');
  clock = 6500;
  element('finish-workout').click();
  assert.equal(app.workout.active, false);
  assert.deepEqual(app.workout.lastResult, { reason: 'manual', exerciseId: 'squat', mode: 'reps', repCount: 3, activeHoldTime: null, goal: 5, durationMs: 6400 });
  assert.equal(element('workout-results').open, true);
  assert.equal(element('results-reps').textContent, '3');
  assert.equal(element('results-goal').textContent, 'Цель: 5');
  assert.equal(element('results-duration').textContent, '00:06');
  assert.equal(streams[0].track.readyState, 'ended');
  assert.equal(rafs.size, 0);
  assert.equal(audio.starts, 0, 'manual completion is silent');
  element('finish-workout').click();
  assert.equal(app.workout.lastResult.repCount, 3);

  element('new-workout').click();
  assert.equal(element('workout-setup').open, true);
  element('free-goal').click();
  assert.equal(element('free-goal').getAttribute('aria-pressed'), 'true');
  submitWorkout();
  await wait(0);
  assert.equal(app.workout.active, true);
  assert.equal(app.workout.goal, null);
  assert.equal(app.squatAnalyzer.repCount, 0);
  assert.equal(element('rep-count').textContent, '0');
  assert.equal(element('rep-target').textContent, '∞');
  assert.equal(element('rep-progress').hidden, true);
  assert.equal(app.workout.lastResult, null);
  assert.equal(streams.length, 2);
});

test('свою цель нужно ввести целым положительным безопасным числом', async () => {
  beginIdleTest();
  let requested = 0;
  navigator.mediaDevices.getUserMedia = async () => { requested += 1; return makeStream(); };
  element('toggle-camera').click();
  for (const value of ['', '0', '-3', '1.5', '9007199254740992']) {
    selectCustom(value);
    submitWorkout();
    assert.equal(requested, 0, `invalid goal ${value}`);
    assert.equal(element('goal-error').hidden, false);
    assert.equal(element('custom-goal').getAttribute('aria-invalid'), 'true');
    assert.equal(element('workout-setup').open, true);
  }
  selectCustom('7');
  assert.equal(element('goal-error').hidden, true);
  submitWorkout();
  await wait(0);
  assert.equal(requested, 1);
  assert.equal(app.workout.goal, 7);
  assert.equal(element('rep-target').textContent, '/ 7');
  app.updateWorkoutHUD(3);
  assert.equal(element('rep-progress').getAttribute('aria-valuenow'), '3');
  assert.equal(element('rep-progress').getAttribute('aria-valuetext'), '3 из 7 повторений');
});

test('цель завершает подход на нужном повторе: один бип, один итог и никаких следующих кадров', async () => {
  beginIdleTest();
  const audio = installAudioStub({ suspended: true });
  const stream = makeStream();
  navigator.mediaDevices.getUserMedia = async () => stream;
  element('toggle-camera').click();
  selectCustom('1');
  submitWorkout();
  await wait(0);
  assert.equal(audio.contexts, 1);
  assert.equal(audio.resumes, 1);
  assert.equal(app.workout.active, true);
  feedExercise();
  assert.equal(app.workout.active, false);
  assert.equal(app.workout.lastResult.reason, 'goal');
  assert.equal(app.workout.lastResult.repCount, 1);
  assert.equal(app.workout.lastResult.goal, 1);
  assert.equal(element('results-title').textContent, 'Цель достигнута!');
  assert.equal(element('results-reps').textContent, '1');
  assert.equal(element('workout-results').open, true);
  assert.equal(stream.track.readyState, 'ended');
  assert.equal(audio.starts, 1);
  assert.equal(audio.stops, 1);
  const stoppedAt = detections.length;
  for (let i = 0; i < 3; i += 1) nextFrame();
  element('finish-workout').click();
  assert.equal(detections.length, stoppedAt);
  assert.equal(audio.starts, 1);
  assert.equal(app.workout.lastResult.repCount, 1);
});

test('свободный режим не завершает подход по количеству и не подаёт бип вручную', async () => {
  beginIdleTest();
  const audio = installAudioStub();
  navigator.mediaDevices.getUserMedia = async () => makeStream();
  element('toggle-camera').click();
  element('free-goal').click();
  submitWorkout();
  await wait(0);
  feedExercise();
  feedExercise();
  assert.equal(app.workout.active, true);
  assert.equal(audio.contexts, 0, 'свободному режиму не нужен AudioContext');
  assert.equal(app.squatAnalyzer.repCount, 2);
  assert.equal(element('rep-count').textContent, '2');
  assert.equal(element('rep-target').textContent, '∞');
  assert.equal(element('rep-progress').hidden, true);
  element('finish-workout').click();
  assert.equal(app.workout.lastResult.repCount, 2);
  assert.equal(app.workout.lastResult.goal, null);
  assert.equal(element('results-goal').textContent, 'Свободный режим');
  assert.equal(audio.starts, 0);
});

test('завершение во время запроса камеры отменяет поздний поток и сохраняет нулевой результат', async () => {
  beginIdleTest();
  const stream = makeStream();
  let releaseCamera;
  navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => { releaseCamera = resolve; });
  element('toggle-camera').click();
  submitWorkout();
  assert.equal(element('finish-workout').hidden, false);
  assert.equal(app.inspectForTest().state, 'starting');
  element('finish-workout').click();
  assert.equal(app.workout.lastResult.repCount, 0);
  releaseCamera(stream);
  await wait(0);
  assert.equal(stream.track.readyState, 'ended');
  assert.equal(app.workout.active, false);
  assert.equal(detections.length, 0);
  assert.equal(rafs.size, 0);
});

test('выбор файла открывает настройку до создания URL; завершение загрузки освобождает URL', async () => {
  beginIdleTest();
  const input = element('videoFileInput');
  input.files = [{ name: 'squat.webm' }];
  input.dispatchEvent(new Event('change'));
  assert.equal(element('workout-setup').open, true);
  assert.equal(element('setup-source').textContent, 'Источник: squat.webm');
  assert.equal(created.length, 0);
  submitWorkout();
  assert.equal(created.length, 1);
  assert.equal(app.inspectForTest().state, 'starting');
  element('finish-workout').click();
  assert.deepEqual(revoked, created);
  video.dispatchEvent(new Event('loadeddata'));
  await wait(0);
  assert.equal(app.workout.lastResult.repCount, 0);
  assert.equal(app.workout.active, false);
  assert.equal(detections.length, 0);
});

test('ошибка Web Audio не препятствует завершению и показу итогов', async () => {
  beginIdleTest();
  const audio = installAudioStub({ suspended: true, reject: true });
  navigator.mediaDevices.getUserMedia = async () => makeStream();
  element('toggle-camera').click();
  selectCustom('1');
  submitWorkout();
  await wait(0);
  feedExercise();
  await wait(0);
  assert.equal(app.workout.active, false);
  assert.equal(app.workout.lastResult.repCount, 1);
  assert.equal(element('workout-results').open, true);
  assert.equal(audio.starts, 0);
  assert.ok(audio.resumes >= 1);
});

test('отмена настройки файла не запускает источник и не мешает следующему выбору', async () => {
  beginIdleTest();
  const input = element('videoFileInput');
  input.files = [{ name: 'first.webm' }];
  input.dispatchEvent(new Event('change'));
  element('cancel-setup').click();
  assert.equal(element('workout-setup').open, false);
  assert.equal(created.length, 0);
  input.files = [{ name: 'second.webm' }];
  input.dispatchEvent(new Event('change'));
  assert.equal(element('setup-source').textContent, 'Источник: second.webm');
  submitWorkout();
  assert.equal(created.length, 1);
  video.dispatchEvent(new Event('loadeddata'));
  await wait(0);
  assert.equal(element('camera-name').textContent, 'second.webm');
  assert.equal(app.workout.active, true);
});

test('завершение во время загрузки модели не запускает распознавание после её готовности', async () => {
  beginIdleTest();
  const stream = makeStream();
  navigator.mediaDevices.getUserMedia = async () => stream;
  let resolveModel;
  app.holdModelForTest(new Promise((resolve) => { resolveModel = resolve; }));
  element('toggle-camera').click();
  submitWorkout();
  await wait(0);
  assert.equal(app.inspectForTest().state, 'running');
  element('finish-workout').click();
  resolveModel(fakeModel);
  await wait(0);
  assert.equal(stream.track.readyState, 'ended');
  assert.equal(detections.length, 0);
  assert.equal(rafs.size, 0);
  assert.equal(app.workout.lastResult.repCount, 0);
});

test('запоздавшее разрешение звука не издаёт сигнал во время нового подхода', async () => {
  beginIdleTest();
  const resumes = [];
  let starts = 0;
  window.AudioContext = class {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    resume() { return new Promise((resolve) => resumes.push(() => { this.state = 'running'; resolve(); })); }
    createOscillator() {
      return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start() { starts += 1; }, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
    }
  };
  navigator.mediaDevices.getUserMedia = async () => makeStream();
  element('toggle-camera').click();
  selectCustom('1');
  submitWorkout();
  await wait(0);
  feedExercise();
  assert.equal(app.workout.lastResult.reason, 'goal');
  assert.equal(resumes.length, 2); // разблокировка при старте и попытка звука в конце
  element('new-workout').click();
  element('free-goal').click();
  submitWorkout();
  await wait(0);
  assert.equal(app.workout.active, true);
  resumes[1]();
  await wait(0);
  assert.equal(starts, 0);
});

test('pagehide останавливает активный источник и закрывает диалоги без экрана итогов', async () => {
  beginIdleTest();
  const stream = makeStream();
  navigator.mediaDevices.getUserMedia = async () => stream;
  element('toggle-camera').click();
  submitWorkout();
  await wait(0);
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(app.workout.active, false);
  assert.equal(app.workout.lastResult, null);
  assert.equal(stream.track.readyState, 'ended');
  assert.equal(element('finish-workout').hidden, true);
  assert.equal(element('workout-results').open, false);
  assert.equal(rafs.size, 0);
});

test('цель по локальному видео останавливает плеер и освобождает URL на последнем повторе', async () => {
  beginIdleTest();
  const audio = installAudioStub();
  const input = element('videoFileInput');
  input.files = [{ name: 'squat.webm' }];
  input.dispatchEvent(new Event('change'));
  selectCustom('1');
  submitWorkout();
  video.dispatchEvent(new Event('loadeddata'));
  await wait(0);
  assert.equal(app.inspectForTest().sourceMode, 'file');
  assert.equal(app.workout.active, true);
  feedExercise();
  assert.equal(app.workout.active, false);
  assert.equal(app.workout.lastResult.reason, 'goal');
  assert.equal(app.workout.lastResult.repCount, 1);
  assert.equal(video.paused, true);
  assert.deepEqual(revoked, created);
  assert.equal(rafs.size, 0);
  assert.equal(audio.starts, 1);
  assert.equal(element('workout-results').open, true);
});

test('настройку и итоги можно закрыть без поддержки нативных методов dialog', async () => {
  beginIdleTest();
  const setup = element('workout-setup');
  const results = element('workout-results');
  const methods = [setup.showModal, setup.close, results.showModal, results.close];
  setup.showModal = setup.close = results.showModal = results.close = undefined;
  try {
    navigator.mediaDevices.getUserMedia = async () => makeStream();
    element('toggle-camera').click();
    assert.equal(setup.getAttribute('open'), '');
    element('cancel-setup').click();
    assert.equal(setup.getAttribute('open'), null);
    element('toggle-camera').click();
    submitWorkout();
    await wait(0);
    assert.equal(setup.getAttribute('open'), null);
    element('finish-workout').click();
    assert.equal(results.getAttribute('open'), '');
    element('close-results').click();
    assert.equal(results.getAttribute('open'), null);
  } finally {
    [setup.showModal, setup.close, results.showModal, results.close] = methods;
  }
});

test('запоздавшая разблокировка звука после pagehide не воспроизводит сигнал', async () => {
  beginIdleTest();
  const resumes = [];
  let starts = 0;
  window.AudioContext = class {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    resume() { return new Promise((resolve) => resumes.push(() => { this.state = 'running'; resolve(); })); }
    close() { return Promise.resolve(); } // имитируем ещё не завершившуюся очистку
    createOscillator() {
      return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start() { starts += 1; }, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
    }
  };
  navigator.mediaDevices.getUserMedia = async () => makeStream();
  element('toggle-camera').click();
  selectCustom('1');
  submitWorkout();
  await wait(0);
  feedExercise();
  assert.equal(app.workout.lastResult.reason, 'goal');
  window.dispatchEvent(new Event('pagehide'));
  resumes[1]();
  await wait(0);
  assert.equal(starts, 0);
});

test('после отказа в доступе к камере подход можно завершить вручную', async () => {
  beginIdleTest();
  navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  element('toggle-camera').click();
  submitWorkout();
  await wait(0);
  assert.equal(app.inspectForTest().state, 'error');
  assert.equal(app.workout.active, true);
  assert.equal(element('finish-workout').hidden, false);
  assert.match(element('empty-description').textContent, /доступ|разреш/i);
  element('finish-workout').click();
  assert.equal(app.workout.lastResult.reason, 'manual');
  assert.equal(app.workout.lastResult.repCount, 0);
  assert.equal(element('workout-results').open, true);
});

test('ручное завершение во время паузы видео сохраняет выполненные повторы', async () => {
  reset();
  await loadFile();
  video.pause();
  app.squatAnalyzer.repCount = 2;
  assert.equal(rafs.size, 0);
  assert.equal(element('finish-workout').hidden, false);
  element('finish-workout').click();
  assert.equal(app.workout.lastResult.reason, 'manual');
  assert.equal(app.workout.lastResult.repCount, 2);
  assert.equal(element('results-reps').textContent, '2');
  assert.deepEqual(revoked, created);
});

test('запоздавший результат модели из старого подхода не считается в новом', async () => {
  beginIdleTest();
  const callbacks = [];
  const delayedModel = { detectForVideo(_source, _timestamp, callback) { callbacks.push(callback); }, close() {} };
  app.setModelForTest(delayedModel);
  navigator.mediaDevices.getUserMedia = async () => makeStream();
  element('toggle-camera').click();
  submitWorkout();
  await wait(0);
  video.currentTime = 1;
  nextFrame();
  assert.equal(callbacks.length, 1);
  element('finish-workout').click();
  element('new-workout').click();
  element('free-goal').click();
  submitWorkout();
  await wait(0);
  app.squatAnalyzer.currentPhase = 'ASCENDING';
  app.squatAnalyzer.minimumKneeAngle = 90;
  app.squatAnalyzer.localMaximum = 150;
  callbacks[0]({ landmarks: [poseAtAngle(175)] });
  assert.equal(app.squatAnalyzer.repCount, 0);
  video.currentTime += 1;
  nextFrame();
  assert.equal(callbacks.length, 2);
  callbacks[1]({ landmarks: [poseAtAngle(175)] });
  assert.equal(app.squatAnalyzer.repCount, 1);
});

test('ошибка модели после синхронного достижения цели не перезаписывает итог', async () => {
  beginIdleTest();
  const audio = installAudioStub();
  const model = {
    detectForVideo(_source, _timestamp, callback) {
      callback({ landmarks: testPose ? [testPose] : [] });
      if (!app.workout.active) throw new Error('model cleanup after completion');
    },
    close() {}
  };
  app.setModelForTest(model);
  navigator.mediaDevices.getUserMedia = async () => makeStream();
  element('toggle-camera').click();
  selectCustom('1');
  submitWorkout();
  await wait(0);
  feedExercise();
  assert.equal(app.workout.lastResult.reason, 'goal');
  assert.equal(Object.isFrozen(app.workout.lastResult), true);
  assert.equal(app.workout.lastResult.repCount, 1);
  assert.equal(app.inspectForTest().state, 'idle');
  assert.equal(element('tracking-status').textContent, 'ПОДГОТОВКА');
  assert.equal(element('workout-results').open, true);
  assert.equal(audio.starts, 1);
});

// Интеграционные тесты используют реальные автоматы и синтетические landmarks.
// Это проверка взаимодействия с UI и временем, а не оценка реальной модели MediaPipe.
function validPlankPose() {
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const span = Math.hypot(200, 60);
  const ankle = { x: 260 + 90 * 200 / span, y: 160 + 90 * 60 / span };
  const coordinates = [
    [11, 60, 100], [23, 160, 130], [25, 260, 160],
    [27, ankle.x, ankle.y], [15, 60, ankle.y + 25]
  ];
  for (const [index, x, y] of coordinates) {
    points[index] = { x: x / 640, y: y / 480, visibility: 1, presence: 1 };
  }
  return points;
}
function validSidePlankPose() {
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const coordinates = [
    [11, 150, 175], [12, 150, 85], [23, 375, 227], [24, 375, 203],
    [25, 487.5, 264.5], [26, 487.5, 250.5], [27, 600, 303], [28, 600, 297],
    [29, 592, 310], [30, 592, 310], [31, 612, 310], [32, 612, 310],
    [13, 150, 310], [15, 165, 310]
  ];
  for (const [index, x, y] of coordinates) {
    points[index] = { x: x / 800, y: y / 600, z: 0, visibility: 1, presence: 1 };
  }
  return points;
}
const holdPoses = { plank: validPlankPose, sidePlank: validSidePlankPose };
function chooseExercise(id) {
  element('exercise-select').value = id;
  element('exercise-select').dispatchEvent(new Event('change'));
}
function nearSeconds(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}
function fileFrame(time) {
  video.currentTime = time;
  clock += 100;
  nextFrame();
}

test('селектор создаёт новый автомат, меняет единицы и недоступен во время подхода', async () => {
  beginIdleTest();
  navigator.mediaDevices.getUserMedia = async () => makeStream();
  element('toggle-camera').click();
  const oldAnalyzer = app.currentAnalyzer;
  chooseExercise('plank');
  assert.notEqual(app.currentAnalyzer, oldAnalyzer);
  assert.equal(app.currentAnalyzer.constructor.name, 'PlankAnalyzer');
  assert.equal(element('goal-unit').textContent, 'СЕКУНДЫ');
  assert.deepEqual(goalOptions.map((button) => Number(button.dataset.goal)), [15, 30, 45, 60]);
  assert.equal(goalOptions[1].getAttribute('aria-pressed'), 'true');
  assert.equal(element('rep-count-label').textContent, 'СЕКУНД');
  assert.match(element('exercise-hint').textContent, /сбоку/i);
  assert.equal(element('squat-view-control').hidden, true);

  chooseExercise('sidePlank');
  assert.equal(app.currentAnalyzer.constructor.name, 'SidePlankAnalyzer');
  submitWorkout();
  await wait(0);
  const activeAnalyzer = app.currentAnalyzer;
  assert.equal(element('exercise-select').disabled, true);
  chooseExercise('lunge'); // даже искусственный change не меняет текущий подход
  assert.equal(app.currentExerciseId, 'sidePlank');
  assert.equal(app.currentAnalyzer, activeAnalyzer);
  assert.equal(element('exercise-select').value, 'sidePlank');
  app.finishWorkout('manual');
  assert.equal(element('exercise-select').disabled, false);
  element('new-workout').click();
  chooseExercise('squat');
  assert.equal(app.currentAnalyzer.constructor.name, 'SquatAnalyzer');
  assert.notEqual(app.currentAnalyzer, oldAnalyzer);
  assert.equal(element('goal-unit').textContent, 'ПОВТОРЕНИЯ');
  assert.deepEqual(goalOptions.map((button) => Number(button.dataset.goal)), [5, 10, 15, 20]);
  assert.equal(element('squat-view-control').hidden, false);
});

for (const [id, pose] of Object.entries(holdPoses)) {
  test(`${id}: файл учитывает медиавремя только между подтверждёнными кадрами; пауза, seek и Loop его не добавляют`, async () => {
    beginIdleTest();
    app.selectExercise(id);
    app.activateWorkoutForTest();
    testPose = pose();
    await loadFile(`${id}.webm`);
    assert.equal(app.currentAnalyzer.activeHoldTime, 0, 'первый кадр файла — только предпросмотр');
    fileFrame(0.1);
    fileFrame(0.6);
    fileFrame(1.1);
    nearSeconds(app.currentAnalyzer.activeHoldTime, 1);
    assert.equal(element('rep-count').textContent, '1');
    assert.equal(element('rep-count-label').textContent, 'СЕКУНД');
    assert.equal(element('squat-phase').textContent, 'Удержание');

    video.pause();
    assert.equal(element('squat-phase').textContent, 'Пауза');
    clock += 60000;
    nextFrame();
    nearSeconds(app.currentAnalyzer.activeHoldTime, 1);
    await video.play();
    fileFrame(1.3); // первый кадр после паузы ничего не добавляет
    fileFrame(1.8);
    nearSeconds(app.currentAnalyzer.activeHoldTime, 1.5);

    video.pause();
    video.seeking = true;
    video.currentTime = 0.4;
    video.dispatchEvent(new Event('seeking'));
    video.seeking = false;
    video.dispatchEvent(new Event('seeked'));
    await wait(120); // предпросмотр на паузе не подтверждает интервал
    nearSeconds(app.currentAnalyzer.activeHoldTime, 1.5);
    assert.equal(element('squat-phase').textContent, 'Пауза');
    await video.play();
    fileFrame(0.5);
    fileFrame(1.0);
    nearSeconds(app.currentAnalyzer.activeHoldTime, 2);

    testPose = null;
    fileFrame(1.5); // поза пропала
    testPose = pose();
    fileFrame(2.0); // восстановление
    nearSeconds(app.currentAnalyzer.activeHoldTime, 2);
    fileFrame(2.5);
    nearSeconds(app.currentAnalyzer.activeHoldTime, 2.5);
    fileFrame(4.0); // неизвестный промежуток больше maxFrameGapSeconds
    nearSeconds(app.currentAnalyzer.activeHoldTime, 2.5);
    fileFrame(4.5);
    nearSeconds(app.currentAnalyzer.activeHoldTime, 3);

    fileFrame(0.1); // Loop без события seeking
    nearSeconds(app.currentAnalyzer.activeHoldTime, 3);
    fileFrame(0.6);
    nearSeconds(app.currentAnalyzer.activeHoldTime, 3.5);
    const result = app.finishWorkout('manual');
    nearSeconds(result.activeHoldTime, 3.5);
    assert.equal(result.exerciseId, id);
    assert.equal(result.repCount, null);
    assert.equal(element('results-metric-label').textContent, 'УДЕРЖАНИЕ, СЕК');
    assert.equal(element('results-reps').textContent, '3');
    assert.equal(element('results-goal').textContent, 'Свободный режим');
  });

  test(`${id}: живая камера использует секунды из монотонных часов и сохраняет удержание при смене источника`, async () => {
    beginIdleTest();
    app.selectExercise(id);
    app.activateWorkoutForTest();
    const stream = makeStream();
    app.activateCameraForTest(stream);
    testPose = pose();
    video.currentTime = 0.1; clock = 100; app.processPoseFrame();
    video.currentTime = 0.2; clock = 600; app.processPoseFrame();
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.5);
    video.currentTime = 0.3; clock = 2600; app.processPoseFrame(); // длинный пропуск
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.5);
    video.currentTime = 0.4; clock = 2850; app.processPoseFrame();
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.75);
    video.currentTime = 0;
    await loadFile('new-source.webm');
    assert.equal(stream.track.readyState, 'ended');
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.75);
    fileFrame(0.1);
    fileFrame(0.6);
    nearSeconds(app.currentAnalyzer.activeHoldTime, 1.25);
  });

  test(`${id}: цель в секундах завершает подход и подаёт ровно один бип`, async () => {
    beginIdleTest();
    const audio = installAudioStub();
    const stream = makeStream();
    navigator.mediaDevices.getUserMedia = async () => stream;
    element('toggle-camera').click();
    chooseExercise(id);
    selectCustom('1');
    testPose = pose();
    submitWorkout();
    await wait(0);
    assert.equal(app.workout.goal, 1);
    assert.equal(element('rep-target').getAttribute('aria-label'), 'Цель: 1 секунда');
    video.currentTime = 0.1; clock = 100; nextFrame();
    video.currentTime = 0.2; clock = 600; nextFrame();
    assert.equal(app.workout.active, true);
    assert.equal(element('rep-progress').getAttribute('aria-valuetext'), '0 из 1 секунды');
    video.currentTime = 0.3; clock = 1100; nextFrame();
    assert.equal(app.workout.active, false);
    nearSeconds(app.workout.lastResult.activeHoldTime, 1);
    assert.equal(app.workout.lastResult.reason, 'goal');
    assert.equal(element('results-reps').textContent, '1');
    assert.equal(element('results-goal').textContent, 'Цель: 1 с');
    assert.equal(stream.track.readyState, 'ended');
    assert.equal(audio.starts, 1);
    nextFrame();
    app.finishWorkout('manual');
    assert.equal(audio.starts, 1);
  });
}

test('задержавшиеся результаты до паузы или в неверном порядке не добавляют время', async () => {
  beginIdleTest();
  app.selectExercise('plank');
  app.activateWorkoutForTest();
  testPose = validPlankPose();
  await loadFile();
  fileFrame(0.1);
  fileFrame(0.2);
  nearSeconds(app.currentAnalyzer.activeHoldTime, 0.1);
  const pending = [];
  app.setModelForTest({ detectForVideo(source, timestamp, callback) { pending.push(callback); }, close() {} });
  fileFrame(0.4);
  video.pause();
  pending.shift()({ landmarks: [testPose] });
  nearSeconds(app.currentAnalyzer.activeHoldTime, 0.1);
  await video.play();
  fileFrame(0.5);
  fileFrame(0.7);
  pending.pop()({ landmarks: [testPose] }); // новый кадр приходит первым
  pending.pop()({ landmarks: [testPose] }); // старый результат игнорируется
  nearSeconds(app.currentAnalyzer.activeHoldTime, 0.1);
  fileFrame(0.9);
  pending.pop()({ landmarks: [testPose] });
  nearSeconds(app.currentAnalyzer.activeHoldTime, 0.3);
});

test('автоматы jumping jacks и подтягиваний получают возрастающие timestamps после seek и смены источника', async () => {
  for (const id of ['jumpingJacks', 'pullup']) {
    beginIdleTest();
    app.selectExercise(id);
    app.activateWorkoutForTest();
    app.activateCameraForTest(makeStream());
    const times = [];
    const original = app.currentAnalyzer.update.bind(app.currentAnalyzer);
    app.currentAnalyzer.update = (landmarks, timestamp) => { times.push(timestamp); return original(landmarks, timestamp); };
    for (const currentTime of [0.1, 0.2, 0.3]) {
      video.currentTime = currentTime;
      app.processPoseFrame();
    }
    video.currentTime = 0;
    await loadFile(`${id}.webm`);
    fileFrame(1.0);
    video.seeking = true;
    video.currentTime = 0.2;
    video.dispatchEvent(new Event('seeking'));
    video.seeking = false;
    video.dispatchEvent(new Event('seeked'));
    fileFrame(0.3);
    assert.ok(times.length >= 6, id);
    assert.ok(times.every((value, index) => index === 0 || value > times[index - 1]), id);
  }
});

test('все упражнения на повторы передают HUD результат и текст собственного анализатора', () => {
  for (const id of ['bicepCurl', 'lunge', 'overheadPress', 'deadlift', 'jumpingJacks', 'gluteBridge', 'pullup']) {
    beginIdleTest();
    app.selectExercise(id);
    app.activateWorkoutForTest();
    app.activateCameraForTest(makeStream());
    const analyzer = app.currentAnalyzer;
    let observed;
    const original = analyzer.update.bind(analyzer);
    analyzer.update = (...args) => { observed = original(...args); return observed; };
    analyzer.repCount = 2;
    testPose = validPlankPose(); // видимые точки, не претендующие на корректную позу упражнения
    video.currentTime = 0.1;
    app.processPoseFrame();
    assert.equal(element('rep-count').textContent, '2', id);
    assert.equal(element('rep-count-label').textContent, 'ПОВТОРОВ', id);
    assert.equal(element('squat-feedback').textContent, observed.feedbackMessage, id);
    assert.equal(element('squat-view-control').hidden, true, id);
    const result = app.finishWorkout('manual');
    assert.equal(result.exerciseId, id);
    assert.equal(result.repCount, 2);
    assert.equal(result.activeHoldTime, null);
    assert.equal(element('results-metric-label').textContent, 'ПОВТОРЫ');
  }
});

function jacksPose(open) {
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  const feet = open ? 1.8 : 0.4;
  const coordinates = [[11,300,240],[12,420,240],[23,300,410],[24,420,410],
    [27,360 - feet * 60,730],[28,360 + feet * 60,730],[2,340,180],[5,380,180]];
  coordinates.push(...(open ? [[13,320,150],[14,400,150],[15,340,70],[16,380,70]]
    : [[13,300,330],[14,420,330],[15,300,420],[16,420,420]]));
  for (const [i, x, y] of coordinates) points[i] = { x: x / 720, y: y / 900, visibility: 1, presence: 1 };
  return points;
}
function pullupPose(angle, shoulderY) {
  const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
  function set(i, x, y) { points[i] = { x: x / 900, y: y / 800, visibility: 1, presence: 1 }; }
  for (const [ids, sx, wx, sign] of [[[11,13,15],365,210,-1], [[12,14,16],535,690,1]]) {
    const dx = wx - sx, dy = 140 - shoulderY, span = Math.hypot(dx, dy);
    const offset = span / 2 * Math.tan((180 - angle) * Math.PI / 360);
    set(ids[0], sx, shoulderY);
    set(ids[1], (sx + wx) / 2 + sign * (-dy / span) * offset,
      (shoulderY + 140) / 2 + sign * (dx / span) * offset);
    set(ids[2], wx, 140);
  }
  set(9, 435, shoulderY - 60); set(10, 465, shoulderY - 60); set(0, 450, shoulderY - 100);
  return points;
}

test('jumping jacks: полный синтетический цикл через приложение достигает цели', () => {
  beginIdleTest();
  app.selectExercise('jumpingJacks');
  app.activateWorkoutForTest(1);
  app.activateCameraForTest(makeStream());
  video.videoWidth = 720; video.videoHeight = 900;
  for (const [index, open] of [false, true, false].entries()) {
    testPose = jacksPose(open);
    clock = 100 + index * 500;
    video.currentTime = 0.1 + index * 0.1;
    app.processPoseFrame();
  }
  assert.equal(app.workout.active, false);
  assert.equal(app.workout.lastResult.exerciseId, 'jumpingJacks');
  assert.equal(app.workout.lastResult.repCount, 1);
  assert.equal(element('results-reps').textContent, '1');
});

test('подтягивания: полный синтетический HANG → TOP → HANG через приложение достигает цели', () => {
  beginIdleTest();
  app.selectExercise('pullup');
  app.activateWorkoutForTest(1);
  app.activateCameraForTest(makeStream());
  video.videoWidth = 900; video.videoHeight = 800;
  const frames = [[0,170,500],[100,145,400],[300,70,190],[500,120,330],[700,170,500]];
  for (const [index, [time, angle, shoulder]] of frames.entries()) {
    testPose = pullupPose(angle, shoulder);
    clock = 100 + time;
    video.currentTime = 0.1 + index * 0.1;
    app.processPoseFrame();
  }
  assert.equal(app.workout.active, false);
  assert.equal(app.workout.lastResult.exerciseId, 'pullup');
  assert.equal(app.workout.lastResult.repCount, 1);
  assert.equal(element('results-reps').textContent, '1');
});

for (const [id, pose] of Object.entries(holdPoses)) {
  test(`${id}: возврат из файла к камере сохраняет время, но не переносит неподтверждённый интервал`, async () => {
    beginIdleTest();
    app.selectExercise(id);
    app.activateWorkoutForTest();
    testPose = pose();
    await loadFile('source.webm');
    fileFrame(0.1);
    fileFrame(0.6);
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.5);
    const stream = makeStream();
    navigator.mediaDevices.getUserMedia = async () => stream;
    element('toggle-camera').click();
    await wait(0);
    assert.equal(app.inspectForTest().sourceMode, 'camera');
    assert.deepEqual(revoked, created);
    video.currentTime = 0.1; clock += 5000; nextFrame();
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.5);
    video.currentTime = 0.2; clock += 250; nextFrame();
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.75);
  });
}

for (const [id, pose] of Object.entries(holdPoses)) {
  test(`${id}: одинаковые значения часов камеры не превращаются в искусственные миллисекунды удержания`, () => {
    beginIdleTest();
    app.selectExercise(id);
    app.activateWorkoutForTest();
    app.activateCameraForTest(makeStream());
    testPose = pose();
    for (const time of [0.1, 0.2, 0.3]) {
      video.currentTime = time;
      clock = 100; // timestamp модели увеличивается, но реальное время не прошло
      app.processPoseFrame();
    }
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0);
    video.currentTime = 0.4; clock = 200; app.processPoseFrame();
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.1);
  });

  test(`${id}: небольшой скачок медиавремени назад не начисляет участок дважды`, async () => {
    beginIdleTest();
    app.selectExercise(id);
    app.activateWorkoutForTest();
    testPose = pose();
    await loadFile('jitter.webm');
    fileFrame(0.1);
    fileFrame(0.6);
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.5);
    fileFrame(0.58); // меньше порога fallback Loop и без события seeking
    fileFrame(0.65);
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.5);
    fileFrame(0.75);
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.6);
  });
}

for (const [id, pose] of Object.entries(holdPoses)) {
  test(`${id}: изменение разрешения с прежними пропорциями прерывает интервал, но сохраняет результат`, () => {
    beginIdleTest();
    app.selectExercise(id);
    app.activateWorkoutForTest();
    app.activateCameraForTest(makeStream());
    testPose = pose();
    video.currentTime = 0.1; clock = 100; app.processPoseFrame();
    video.currentTime = 0.2; clock = 600; app.processPoseFrame();
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.5);
    video.videoWidth = 640; video.videoHeight = 480; // как 320×240, пропорции те же
    video.currentTime = 0.3; clock = 1100; app.processPoseFrame();
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.5);
    video.currentTime = 0.4; clock = 1350; app.processPoseFrame();
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.75);
  });
}

for (const [id, pose] of Object.entries(holdPoses)) {
  test(`${id}: кадр, опередивший необработанный, не засчитывает промежуток с неизвестной позой`, async () => {
    beginIdleTest();
    app.selectExercise(id);
    app.activateWorkoutForTest();
    testPose = pose();
    await loadFile('out-of-order.webm');
    fileFrame(0.1);
    fileFrame(0.2);
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.1);
    const callbacks = [];
    app.setModelForTest({ detectForVideo(source, timestamp, callback) { callbacks.push(callback); }, close() {} });
    fileFrame(0.3); // в нём могла отсутствовать поза
    fileFrame(0.4);
    callbacks.pop()({ landmarks: [testPose] }); // более поздний результат пришёл первым
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.1);
    callbacks.pop()({ landmarks: [] }); // запоздавший кадр уже игнорируется
    fileFrame(0.5);
    callbacks.pop()({ landmarks: [testPose] });
    nearSeconds(app.currentAnalyzer.activeHoldTime, 0.2);
  });
}
