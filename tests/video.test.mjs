import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Тестируем настоящий app.js с небольшим DOM-двойником, без камеры, CDN и сборки.
const geometrySource = await readFile(new URL('../geometry.js', import.meta.url));
const geometryUrl = `data:text/javascript;base64,${geometrySource.toString('base64')}`;
const analyzerSource = (await readFile(new URL('../analyzer.js', import.meta.url), 'utf8'))
  .replace("'./geometry.js'", `'${geometryUrl}'`);
const analyzerUrl = `data:text/javascript;base64,${Buffer.from(analyzerSource).toString('base64')}`;

class Element extends EventTarget {
  constructor(id) {
    super();
    this.id = id;
    this.textContent = '';
    this.dataset = {};
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
globalThis.document = { getElementById: element };
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
  + `\nexport { formatVideoTime, loadVideoFile, stopCamera, disposePoseLandmarker, squatAnalyzer };
export function setModelForTest(model) { poseLandmarker = model; poseConnections = []; }
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
  app.squatAnalyzer.reset();
  app.setModelForTest(fakeModel);
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

test('файл останавливает камеру и ждёт loadeddata перед запуском и настройкой canvas', async () => {
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
  assert.equal(app.squatAnalyzer.repCount, 0);
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
