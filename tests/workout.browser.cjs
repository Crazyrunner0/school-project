/* Browser integration: real DOM/video, synthetic camera/poses and a stub of the MediaPipe model.
   NODE_PATH=/path/to/node_modules node tests/workout.browser.cjs
   Optional: MOTION_CHROMIUM_PATH=/path/to/chromium or MOTION_SPARTICUZ=1. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'tests/fixtures/short.webm');
const modelUrl = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/vision_bundle.mjs';
const stub = `
export class FilesetResolver { static async forVisionTasks() { return {}; } }
export class PoseLandmarker {
  static POSE_CONNECTIONS = [];
  static async createFromOptions() { return new PoseLandmarker(); }
  detectForVideo(video, timestamp, callback) {
    window.__detections += 1;
    callback({ landmarks: window.__pose ? [window.__pose] : [] });
  }
  close() {}
}`;
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webm': 'video/webm' };
const server = http.createServer((req, res) => {
  const name = path.normalize(decodeURIComponent(new URL(req.url, 'http://localhost').pathname)).replace(/^\/+/, '');
  const file = path.resolve(root, name || 'index.html');
  if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const options = { headless: true, args: ['--mute-audio'] };
    if (process.env.MOTION_CHROMIUM_PATH) options.executablePath = process.env.MOTION_CHROMIUM_PATH;
    if (process.env.MOTION_SPARTICUZ === '1') {
      const sparticuz = require('@sparticuz/chromium').default;
      options.executablePath = await sparticuz.executablePath();
      options.args.push(...sparticuz.args);
    }
    browser = await chromium.launch(options);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(modelUrl, (route) => route.fulfill({
      status: 200, contentType: 'text/javascript', body: stub, headers: { 'access-control-allow-origin': '*' }
    }));
    await page.addInitScript(() => {
      window.__detections = 0;
      window.__cameraRequests = 0;
      window.__streams = [];
      window.__audioStarts = 0;
      window.__pose = null;
      window.AudioContext = class {
        constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
        resume() { this.state = 'running'; return Promise.resolve(); }
        close() { this.state = 'closed'; return Promise.resolve(); }
        createOscillator() {
          return {
            frequency: { setValueAtTime() {} }, connect() {}, disconnect() {},
            start() { window.__audioStarts += 1; }, stop() {}
          };
        }
        createGain() {
          return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
        }
      };
      navigator.mediaDevices.getUserMedia = async () => {
        window.__cameraRequests += 1;
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const ctx = canvas.getContext('2d');
        let index = 0;
        const paint = () => {
          ctx.fillStyle = index++ % 2 ? '#334638' : '#4a6350';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        };
        paint();
        const stream = canvas.captureStream(10);
        const track = stream.getVideoTracks()[0];
        const timer = setInterval(paint, 100);
        const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
        track.getSettings = () => ({ facingMode: 'user' });
        window.__streams.push(stream);
        return stream;
      };
      window.__setAngle = (angle) => {
        const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
        const sides = [{ shoulder: 11, hip: 23, knee: 25, ankle: 27 }, { shoulder: 12, hip: 24, knee: 26, ankle: 28 }];
        const set = (i, x, y) => { points[i] = { x: x / 320, y: y / 240, visibility: 1 }; };
        sides.forEach((side, i) => {
          const x = i ? 205 : 115;
          const direction = Math.PI / 2 + angle * Math.PI / 180;
          const hipX = x + 55 * Math.cos(direction), hipY = 125 + 55 * Math.sin(direction);
          set(side.knee, x, 125); set(side.ankle, x, 180);
          set(side.hip, hipX, hipY); set(side.shoulder, hipX, hipY - 50);
        });
        window.__pose = points;
        return window.__detections;
      };
    });
    await page.goto(address);
    const open = (selector) => page.waitForSelector(`${selector}[open]`);
    const tracking = () => page.waitForFunction(() => document.querySelector('#tracking-status').textContent === 'АНАЛИЗ АКТИВЕН');
    async function feedExercise() {
      for (const angle of [175, 130, 90, 94, 120, 175]) {
        const oldCount = await page.evaluate((value) => window.__setAngle(value), angle);
        await page.waitForFunction((previous) => window.__detections > previous, oldCount, { timeout: 5000 });
      }
    }
    const screens = [
      { width: 390, height: 844 }, { width: 280, height: 568 }, { width: 320, height: 480 },
      { width: 480, height: 320 }, { width: 568, height: 320 }, { width: 844, height: 390 }
    ];
    async function visible(selector, bounds) {
      const data = await page.locator(selector).evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
          hit: node === target || node.contains(target), hidden: node.hidden };
      });
      assert.ok(!data.hidden && data.width > 0 && data.height > 0, `${selector} not visible: ${JSON.stringify(data)}`);
      assert.ok(data.x >= 0 && data.y >= 0 && data.right <= bounds.width && data.bottom <= bounds.height,
        `${selector} outside ${bounds.width}x${bounds.height}: ${JSON.stringify(data)}`);
      assert.ok(data.hit, `${selector} is covered: ${JSON.stringify(data)}`);
    }
    const noOverlap = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
    async function activeLayout(bounds) {
      await visible('#finish-workout', bounds);
      const layout = await page.evaluate(() => {
        const rect = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
        };
        return { score: rect('.hud-scoreboard'), banner: rect('.advice-banner'), view: rect('.squat-view'), footer: rect('.controls'),
          overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(!layout.overflow, `horizontal overflow: ${JSON.stringify(bounds)}`);
      for (const [a, b] of [['score', 'banner'], ['score', 'view'], ['banner', 'view'], ['banner', 'footer']]) {
        assert.ok(noOverlap(layout[a], layout[b]), `${a}/${b} overlap at ${JSON.stringify(bounds)}: ${JSON.stringify(layout)}`);
      }
    }

    // Local video: merely choosing a file must not start decoding or request a camera.
    await page.locator('#videoFileInput').setInputFiles(fixture);
    await open('#workout-setup');
    assert.match(await page.locator('#setup-source').textContent(), /short\.webm/);
    assert.equal(await page.evaluate(() => window.__cameraRequests), 0);
    assert.equal(await page.locator('#camera').getAttribute('src'), null);
    assert.equal(await page.locator('[data-goal="10"]').getAttribute('aria-pressed'), 'true');
    for (const screen of screens) {
      await page.setViewportSize(screen);
      await visible('#start-workout', screen);
      await visible('#free-goal', screen);
      await visible('[data-goal="5"]', screen);
      await visible('[data-goal="20"]', screen);
    }
    await page.setViewportSize(screens[0]);
    await page.locator('#custom-goal').focus();
    await page.click('#start-workout');
    assert.equal(await page.locator('#goal-error').isVisible(), true);
    assert.equal(await page.evaluate(() => window.__cameraRequests), 0);
    await page.locator('#custom-goal').fill('7');
    await page.click('[data-goal="15"]');
    assert.equal(await page.locator('#custom-goal').inputValue(), '');
    assert.equal(await page.locator('[data-goal="15"]').getAttribute('aria-pressed'), 'true');
    await page.click('#start-workout');
    await tracking();
    for (const screen of screens) { await page.setViewportSize(screen); await activeLayout(screen); }
    await page.setViewportSize(screens[0]);
    assert.equal(await page.locator('#rep-target').textContent(), '/ 15');
    assert.equal(await page.locator('#rep-progress').getAttribute('aria-valuemax'), '15');
    assert.equal(await page.evaluate(() => window.__cameraRequests), 0);
    await page.click('#finish-workout');
    await open('#workout-results');
    assert.equal(await page.locator('#results-reps').textContent(), '0');
    assert.equal(await page.locator('#results-goal').textContent(), 'Цель: 15');
    assert.equal(await page.locator('#camera').getAttribute('src'), null);
    await page.click('#new-workout');
    await open('#workout-setup');
    assert.match(await page.locator('#setup-source').textContent(), /short\.webm/);
    await page.click('#cancel-setup');

    // Real analyzer, controlled input poses and a one-repetition custom goal.
    await page.click('#toggle-camera');
    await open('#workout-setup');
    assert.equal(await page.evaluate(() => window.__cameraRequests), 0);
    await page.locator('#custom-goal').fill('1');
    await page.click('#start-workout');
    await tracking();
    assert.equal(await page.evaluate(() => window.__cameraRequests), 1);
    for (const screen of screens) { await page.setViewportSize(screen); await activeLayout(screen); }
    await page.setViewportSize(screens[0]);
    await feedExercise();
    await open('#workout-results');
    assert.equal(await page.locator('#results-title').textContent(), 'Цель достигнута!');
    assert.equal(await page.locator('#results-reps').textContent(), '1');
    assert.equal(await page.locator('#results-goal').textContent(), 'Цель: 1');
    assert.equal(await page.evaluate(() => window.__audioStarts), 1);
    assert.equal(await page.evaluate(() => window.__streams[0].getVideoTracks()[0].readyState), 'ended');
    const lastFrame = await page.evaluate(() => window.__detections);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.__detections), lastFrame);
    for (const screen of screens) { await page.setViewportSize(screen); await visible('#new-workout', screen); }
    await page.setViewportSize(screens[0]);

    // Start afresh in free mode; switching sources preserves completed reps.
    await page.click('#new-workout');
    await open('#workout-setup');
    await page.click('#free-goal');
    await page.click('#start-workout');
    await tracking();
    assert.equal(await page.locator('#rep-count').textContent(), '0');
    assert.equal(await page.locator('#rep-target').textContent(), '∞');
    assert.equal(await page.locator('#rep-progress').isHidden(), true);
    await feedExercise();
    await feedExercise();
    await page.waitForFunction(() => document.querySelector('#rep-count').textContent === '2');
    await page.locator('#videoFileInput').setInputFiles(fixture);
    await tracking();
    assert.equal(await page.locator('#rep-count').textContent(), '2');
    assert.equal(await page.locator('#rep-target').textContent(), '∞');
    await page.click('#toggle-camera');
    await tracking();
    assert.equal(await page.locator('#rep-count').textContent(), '2');
    await page.click('#finish-workout');
    await open('#workout-results');
    assert.equal(await page.locator('#results-title').textContent(), 'Отличная работа!');
    assert.equal(await page.locator('#results-reps').textContent(), '2');
    assert.equal(await page.locator('#results-goal').textContent(), 'Свободный режим');
    assert.equal(await page.evaluate(() => window.__audioStarts), 1, 'ручное завершение не добавляет сигнал');

    await page.click('#new-workout');
    await page.click('#start-workout');
    await tracking();
    assert.equal(await page.locator('#rep-count').textContent(), '0');
    assert.equal(await page.locator('#rep-target').textContent(), '/ 10');
    assert.equal(await page.locator('#rep-progress').getAttribute('aria-valuenow'), '0');
    await page.click('#finish-workout');
    await open('#workout-results');

    // A large, valid custom number must remain complete and not collide with the HUD.
    await page.click('#new-workout');
    await page.locator('#custom-goal').fill('9007199254740991');
    await page.click('#start-workout');
    await tracking();
    assert.equal(await page.locator('#rep-target').textContent(), '/ 9007199254740991');
    for (const screen of screens) {
      await page.setViewportSize(screen);
      await activeLayout(screen);
      const hud = await page.evaluate(() => {
        const rect = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
        };
        return { target: rect('#rep-target'), phase: rect('.hud-phase-group'), score: rect('.hud-scoreboard') };
      });
      assert.ok(hud.target.left >= hud.score.left && hud.target.right <= hud.score.right,
        `large target outside scoreboard at ${JSON.stringify(screen)}: ${JSON.stringify(hud)}`);
      assert.ok(noOverlap(hud.target, hud.phase), `large target overlaps phase: ${JSON.stringify(hud)}`);
    }
    await page.setViewportSize(screens[0]);
    await page.locator('#videoFileInput').setInputFiles(fixture);
    await tracking();
    for (const screen of screens) { await page.setViewportSize(screen); await activeLayout(screen); }
    await page.setViewportSize(screens[0]);
    await page.click('#finish-workout');
    assert.deepEqual(errors, []);
    console.log('PASS подходы: настройка до источника, цель и Web Audio, свободный режим, итоги, смена источников и мобильная адаптация');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
