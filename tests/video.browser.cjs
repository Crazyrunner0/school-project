// Дополнительный браузерный smoke-тест реального WebM; MediaPipe заменён тестовой моделью.
// Запуск и установка Playwright описаны в README.md.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'short.webm');
const moduleUrl = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/vision_bundle.mjs';
const stub = `
export class FilesetResolver { static async forVisionTasks() { return {}; } }
export class PoseLandmarker {
  static POSE_CONNECTIONS = [];
  static async createFromOptions() { window.__models++; return new PoseLandmarker(); }
  detectForVideo(video, timestamp, callback) {
    window.__frames.push({ timestamp, currentTime: video.currentTime,
      source: video.srcObject ? 'camera' : 'file' });
    callback({ landmarks: [] });
  }
  close() {}
}`;

async function run() {
  const allowed = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/geometry.js', ['geometry.js', 'text/javascript; charset=utf-8']],
    ['/analyzer.js', ['analyzer.js', 'text/javascript; charset=utf-8']],
    ...['exerciseFactory.js', 'plankAnalyzer.js', 'sidePlankAnalyzer.js', 'bicepCurlAnalyzer.js',
      'lungeAnalyzer.js', 'overheadPressAnalyzer.js', 'deadliftAnalyzer.js', 'jumpingJacksAnalyzer.js',
      'gluteBridgeAnalyzer.js', 'pullupAnalyzer.js'].map((file) => [`/${file}`, [file, 'text/javascript; charset=utf-8']]),
    ['/style.css', ['style.css', 'text/css; charset=utf-8']]
  ]);
  const server = http.createServer(async (request, response) => {
    const entry = allowed.get(new URL(request.url, 'http://localhost').pathname);
    if (!entry) { response.writeHead(404).end(); return; }
    try {
      const body = await fs.readFile(path.join(root, entry[0]));
      response.writeHead(200, { 'content-type': entry[1] }).end(body);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const options = { headless: true, args: ['--no-sandbox'] };
    if (process.env.MOTION_CHROMIUM_PATH) options.executablePath = process.env.MOTION_CHROMIUM_PATH;
    // В CI без системного Chrome можно передать MOTION_SPARTICUZ=1.
    if (process.env.MOTION_SPARTICUZ === '1') {
      const serverlessChromium = require('@sparticuz/chromium').default;
      options.executablePath = await serverlessChromium.executablePath();
      options.args = serverlessChromium.args;
    }
    browser = await chromium.launch(options);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(moduleUrl, (route) => route.fulfill({
      contentType: 'text/javascript', body: stub, headers: { 'access-control-allow-origin': '*' }
    }));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    await page.evaluate(() => {
      window.__models = 0;
      window.__frames = [];
      window.__streams = [];
      window.__created = [];
      window.__revoked = [];
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob); window.__created.push(url); return url;
      };
      URL.revokeObjectURL = (url) => { window.__revoked.push(url); revoke(url); };
      navigator.mediaDevices.getUserMedia = async () => {
        const source = document.createElement('canvas');
        source.width = 160; source.height = 120;
        const context = source.getContext('2d');
        let tick = 0;
        const paint = () => {
          context.fillStyle = tick++ % 2 ? '#445c44' : '#556c55';
          context.fillRect(0, 0, 160, 120);
        };
        paint();
        const stream = source.captureStream(8);
        paint();
        setInterval(paint, 125);
        Object.defineProperty(stream.getVideoTracks()[0], 'getSettings', {
          value: () => ({ facingMode: 'user' })
        });
        window.__streams.push(stream);
        return stream;
      };
    });
    const state = (value) => page.waitForFunction(
      (wanted) => document.querySelector('#status').dataset.state === wanted, value, { timeout: 12000 });
    const tracking = () => page.waitForFunction(
      () => document.querySelector('#tracking-status').textContent === 'АНАЛИЗ АКТИВЕН', null, { timeout: 12000 });
    const frames = () => page.evaluate(() => window.__frames.slice());
    const checkIncreasing = (values) => assert.ok(values.length > 1 && values.every(
      (frame, i) => !i || frame.timestamp > values[i - 1].timestamp));

    await page.click('#toggle-camera');
    await page.click('#start-workout');
    await state('running');
    await tracking();
    await page.waitForFunction(() => window.__frames.length > 0);
    assert.equal(await page.locator('#video-controls').isVisible(), false);
    await page.locator('#videoFileInput').setInputFiles(fixture);
    await state('running');
    await tracking();
    await page.waitForFunction(() => document.querySelector('#camera').currentTime > 0.35);
    const selected = await page.evaluate(() => {
      const video = document.querySelector('#camera');
      const canvas = document.querySelector('#overlay');
      return { url: video.src, track: window.__streams[0].getTracks()[0].readyState,
        dimensions: [video.videoWidth, video.videoHeight, canvas.width, canvas.height],
        mirrored: document.querySelector('#camera-view').classList.contains('is-mirrored'),
        models: window.__models };
    });
    assert.match(selected.url, /^blob:/);
    assert.equal(selected.track, 'ended');
    assert.deepEqual(selected.dimensions, [160, 120, 160, 120]);
    assert.equal(selected.mirrored, false);
    assert.equal(selected.models, 1);
    assert.equal(await page.locator('#video-controls').isVisible(), true);

    await page.click('#video-play');
    await page.waitForFunction(() => document.querySelector('#camera').paused);
    const pausedCount = (await frames()).length;
    await page.waitForTimeout(300);
    assert.equal((await frames()).length, pausedCount);
    await page.evaluate(() => {
      const seek = document.querySelector('#video-seek');
      seek.value = '0.1';
      seek.dispatchEvent(new Event('input', { bubbles: true }));
      seek.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction((n) => window.__frames.length > n, pausedCount);
    await page.waitForTimeout(200);
    assert.equal((await frames()).length, pausedCount + 1);
    checkIncreasing(await frames());

    await page.click('#video-loop');
    assert.equal(await page.locator('#video-loop').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => { document.querySelector('#camera').currentTime = 2.6; });
    await page.waitForFunction(() => !document.querySelector('#camera').seeking);
    await page.click('#video-play');
    await page.waitForFunction(() => document.querySelector('#camera').currentTime < 0.6 &&
      !document.querySelector('#camera').paused, null, { timeout: 10000 });
    checkIncreasing(await frames());

    // Поле, кнопки и HUD должны оставаться видимыми и доступными на телефоне.
    for (const size of [{ width: 280, height: 568 }, { width: 480, height: 320 }]) {
      await page.setViewportSize(size);
      const layout = await page.evaluate(() => {
        const get = (selector) => {
          const item = document.querySelector(selector);
          const rect = item.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            hit: item === hit || item.contains(hit), scrollWidth: item.scrollWidth, width: item.clientWidth };
        };
        return { play: get('#video-play'), seek: get('#video-seek'), loop: get('#video-loop'),
          camera: get('#toggle-camera'), upload: get('#upload-video'),
          uploadText: get('#upload-video span'), documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight };
      });
      for (const key of ['play', 'seek', 'loop', 'camera', 'upload']) {
        const rect = layout[key];
        assert.ok(rect.left >= 0 && rect.right <= size.width && rect.top >= 0 &&
          rect.bottom <= size.height && rect.hit, JSON.stringify({ size, key, layout }));
      }
      assert.ok(layout.uploadText.scrollWidth <= layout.uploadText.width + 1);
      assert.ok(layout.documentWidth <= size.width && layout.documentHeight <= size.height);
    }
    await page.setViewportSize({ width: 390, height: 844 });

    // Повторный выбор того же файла создаёт новый URL и удаляет старый.
    await page.locator('#videoFileInput').setInputFiles(fixture);
    await state('running');
    await tracking();
    const replacement = await page.evaluate(() => ({ url: document.querySelector('#camera').src,
      revoked: window.__revoked.slice() }));
    assert.notEqual(replacement.url, selected.url);
    assert.ok(replacement.revoked.includes(selected.url));
    await page.locator('#videoFileInput').setInputFiles({
      name: 'invalid.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not video')
    });
    await state('error');
    assert.match(await page.locator('#empty-description').textContent(), /формат|кодек/i);
    assert.ok(await page.evaluate((url) => window.__revoked.includes(url), replacement.url));
    assert.ok(await page.evaluate(() => window.__revoked.includes(window.__created.at(-1))));

    await page.click('#toggle-camera');
    await state('running');
    await tracking();
    assert.equal(await page.locator('#video-controls').isVisible(), false);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('#camera').srcObject)), true);
    assert.equal(await page.evaluate(() => document.querySelector('#camera').getAttribute('src')), null);
    assert.equal(await page.evaluate(() => window.__models), 1);
    await page.waitForFunction(() => window.__frames.at(-1)?.source === 'camera');
    checkIncreasing(await frames());

    // Safari и другие браузеры могут заблокировать autoplay после загрузки модели.
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    await page.evaluate(() => {
      window.__models = 0;
      window.__frames = [];
      const video = document.querySelector('#camera');
      const play = video.play.bind(video);
      let blocked = false;
      video.play = () => {
        if (!blocked) {
          blocked = true;
          return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
        }
        return play();
      };
    });
    await page.locator('#videoFileInput').setInputFiles(fixture);
    await page.click('#start-workout');
    await tracking();
    await page.waitForFunction(() => document.querySelector('#status-text').textContent === 'Нажмите Play');
    await page.waitForFunction(() => window.__frames.length === 1);
    await page.waitForTimeout(250);
    assert.equal((await frames()).length, 1);
    assert.equal(await page.evaluate(() => document.querySelector('#camera').paused), true);
    await page.setViewportSize({ width: 280, height: 568 });
    const blockedLayout = await page.evaluate(() => {
      const get = (selector) => document.querySelector(selector).getBoundingClientRect();
      const header = get('.topbar'), footer = get('.controls'), score = get('.hud-scoreboard');
      const banner = get('.advice-banner'), view = get('.squat-view');
      return { headerBottom: header.bottom, footerTop: footer.top,
        scoreTop: score.top, scoreBottom: score.bottom, bannerTop: banner.top,
        bannerBottom: banner.bottom, viewTop: view.top, viewBottom: view.bottom };
    });
    assert.ok(blockedLayout.scoreTop >= blockedLayout.headerBottom &&
      blockedLayout.scoreBottom <= blockedLayout.bannerTop &&
      blockedLayout.bannerBottom <= blockedLayout.viewTop &&
      blockedLayout.viewBottom <= blockedLayout.footerTop, JSON.stringify(blockedLayout));
    await page.click('#video-play');
    await page.waitForFunction(() => !document.querySelector('#camera').paused);
    await page.waitForFunction(() => window.__frames.length > 1);
    assert.equal(await page.locator('#status-text').textContent(), 'Видео готово');
    assert.deepEqual(errors, []);
    console.log('PASS реальный WebM: камера, источник, пауза, seek, Loop, ошибки, cleanup и адаптивность');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
