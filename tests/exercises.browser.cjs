/* Реальный DOM/canvas и синтетическая камера/позы; MediaPipe и Web Audio подменены.
   NODE_PATH=/path/to/node_modules node tests/exercises.browser.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const modelUrl = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/vision_bundle.mjs';
const stub = `
export class FilesetResolver { static async forVisionTasks() { return {}; } }
export class PoseLandmarker {
  static POSE_CONNECTIONS = [];
  static async createFromOptions() { return new PoseLandmarker(); }
  detectForVideo(video, timestamp, callback) {
    window.__detections++;
    callback({ landmarks: window.__pose ? [window.__pose] : [] });
  }
  close() {}
}`;
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webm': 'video/webm' };
const fixture = path.join(root, 'tests/fixtures/short.webm');
const server = http.createServer((req, res) => {
  const name = path.normalize(decodeURIComponent(new URL(req.url, 'http://localhost').pathname)).replace(/^\/+/, '');
  const file = path.resolve(root, name || 'index.html');
  if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end(); return;
  }
  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
      contentType: 'text/javascript', body: stub, headers: { 'access-control-allow-origin': '*' }
    }));
    await page.addInitScript(() => {
      window.__pose = null;
      window.__detections = 0;
      window.__beeps = 0;
      window.AudioContext = class {
        constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
        resume() { this.state = 'running'; return Promise.resolve(); }
        close() { this.state = 'closed'; return Promise.resolve(); }
        createOscillator() {
          return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {},
            start() { window.__beeps++; }, stop() {} };
        }
        createGain() {
          return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
        }
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 240;
        const ctx = canvas.getContext('2d');
        let index = 0;
        const paint = () => { ctx.fillStyle = index++ % 2 ? '#334638' : '#4a6350'; ctx.fillRect(0, 0, 320, 240); };
        paint();
        const stream = canvas.captureStream(10);
        const track = stream.getVideoTracks()[0];
        const timer = setInterval(paint, 100);
        const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
        track.getSettings = () => ({ facingMode: 'user' });
        return stream;
      };
      window.__makePose = (side) => {
        const points = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0 }));
        let coordinates, width, height;
        if (side) {
          width = 800; height = 600;
          coordinates = [[11,150,175],[12,150,85],[23,375,227],[24,375,203],
            [25,487.5,264.5],[26,487.5,250.5],[27,600,303],[28,600,297],
            [29,592,310],[30,592,310],[31,612,310],[32,612,310],[13,150,310],[15,165,310]];
        } else {
          width = 640; height = 480;
          const span = Math.hypot(200, 60);
          const x = 260 + 90 * 200 / span, y = 160 + 90 * 60 / span;
          coordinates = [[11,60,100],[23,160,130],[25,260,160],[27,x,y],[15,60,y + 25]];
        }
        for (const [i, x, y] of coordinates) {
          points[i] = { x: x / width, y: y / height, z: 0, visibility: 1, presence: 1 };
        }
        return points;
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.click('#toggle-camera');
    const screens = [
      { width: 390, height: 844 }, { width: 280, height: 568 }, { width: 320, height: 480 },
      { width: 480, height: 320 }, { width: 568, height: 320 }, { width: 844, height: 390 },
      { width: 1440, height: 900 }
    ];
    async function visible(selector, bounds) {
      const data = await page.locator(selector).evaluate((node) => {
        const r = node.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height,
          visible: node === hit || node.contains(hit) };
      });
      assert.ok(data.w > 0 && data.h > 0 && data.x >= 0 && data.y >= 0 &&
        data.right <= bounds.width && data.bottom <= bounds.height && data.visible,
      `${selector} at ${JSON.stringify(bounds)}: ${JSON.stringify(data)}`);
    }
    async function assertActiveLayout(screen) {
      await page.setViewportSize(screen);
      const layout = await page.evaluate(() => {
        const rect = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
        };
        const banner = document.querySelector('.advice-banner');
        return { score: rect('.hud-scoreboard'), banner: rect('.advice-banner'), footer: rect('.controls'),
          bannerHeight: banner.clientHeight, scrollHeight: banner.scrollHeight };
      });
      const noOverlap = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      assert.ok(layout.bannerHeight > 0 && noOverlap(layout.score, layout.banner) && noOverlap(layout.banner, layout.footer),
        `HUD overlap ${JSON.stringify(screen)}: ${JSON.stringify(layout)}`);
    }
    const ids = ['squat', 'plank', 'sidePlank', 'bicepCurl', 'lunge', 'overheadPress',
      'deadlift', 'jumpingJacks', 'gluteBridge', 'pullup'];
    assert.deepEqual(await page.locator('.exercise-card').evaluateAll((cards) => cards.map((card) => card.dataset.exercise)), ids);
    assert.equal(await page.locator('#exercise-sheet svg, #exercise-sheet img, #exercise-sheet picture, #exercise-sheet canvas').count(), 0);
    assert.equal(await page.locator('.exercise-picker svg, .exercise-picker img, .exercise-picker picture, .exercise-picker canvas').count(), 0);
    assert.equal(await page.locator('#exercise-sheet').evaluate((node) => /[\p{Extended_Pictographic}\uFE0F]/u.test(node.textContent)), false);
    const catalog = await page.evaluate(async () => {
      const { EXERCISES } = await import('./exerciseFactory.js');
      return Object.fromEntries(Object.entries(EXERCISES).map(([id, item]) => [id, {
        label: item.label, muscle: item.muscle, camera: item.camera, mode: item.mode, hint: item.hint
      }]));
    });
    async function chooseExercise(id) {
      if (!(await page.locator('#exercise-sheet').isVisible())) await page.click('#exercise-select');
      assert.equal(await page.locator('#exercise-select').getAttribute('aria-expanded'), 'true');
      await page.locator(`.exercise-card[data-exercise="${id}"]`).click();
      assert.equal(await page.locator(`.exercise-card[data-exercise="${id}"]`).getAttribute('aria-checked'), 'true');
      assert.equal(await page.locator('.exercise-card[aria-checked="true"]').count(), 1);
      assert.equal(await page.locator('.exercise-card[tabindex="0"]').count(), 1);
      await page.click('#exercise-sheet-done');
      assert.equal(await page.locator('#exercise-select').getAttribute('aria-expanded'), 'false');
    }
    for (const id of ids) {
      const card = page.locator(`.exercise-card[data-exercise="${id}"]`);
      assert.equal(await card.locator('.exercise-card-name').textContent(), catalog[id].label);
      assert.equal(await card.locator('.exercise-badge-muscle').textContent(), catalog[id].muscle);
      assert.equal((await card.locator('.exercise-card-camera').textContent()).trim(), catalog[id].camera);
      assert.equal(await card.locator('.exercise-badge-mode').textContent(), catalog[id].mode === 'time' ? 'Таймер' : 'Повторения');
      await chooseExercise(id);
      assert.equal(await page.locator('#exercise-selected-name').textContent(), catalog[id].label);
      assert.equal(await page.locator('#exercise-selected-muscle').textContent(), catalog[id].muscle);
      assert.equal(await page.locator('#exercise-selected-mode').textContent(), catalog[id].mode === 'time' ? 'Таймер' : 'Повторения');
      assert.equal(await page.locator('#exercise-hint').textContent(), catalog[id].hint);
      const isHold = ['plank', 'sidePlank'].includes(id);
      assert.equal(await page.locator('#goal-unit').textContent(), isHold ? 'СЕКУНДЫ' : 'ПОВТОРЕНИЯ');
      assert.equal(await page.locator('#rep-count-label').textContent(), isHold ? 'СЕКУНД' : 'ПОВТОРОВ');
      assert.deepEqual(await page.locator('.goal-option').allTextContents(), isHold ? ['15', '30', '45', '60'] : ['5', '10', '15', '20']);
      for (const screen of screens) {
        await page.setViewportSize(screen);
        await page.evaluate(() => { document.querySelector('#workout-setup').scrollTop = 0; });
        await visible('#exercise-select', screen);
        await visible('#start-workout', screen);
      }
    }
    // Клавиатурный радиошаблон, видимое выделение, сохранение цели и возврат фокуса.
    await page.setViewportSize(screens[0]);
    await chooseExercise('squat');
    await page.click('#exercise-select');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.exercise), 'squat');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'exercise-sheet-close');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.exercise), 'squat');
    const colors = await page.evaluate(() => ({
      selected: getComputedStyle(document.querySelector('.exercise-card[data-exercise="squat"]')).borderTopColor,
      other: getComputedStyle(document.querySelector('.exercise-card[data-exercise="plank"]')).borderTopColor
    }));
    assert.notEqual(colors.selected, colors.other);
    const selectedStyle = await page.locator('.exercise-card[data-exercise="squat"]').evaluate((node) => ({
      background: getComputedStyle(node).backgroundColor,
      shadow: getComputedStyle(node).boxShadow,
      backgroundImage: getComputedStyle(node).backgroundImage
    }));
    assert.equal(selectedStyle.backgroundImage, 'none');
    assert.notEqual(selectedStyle.shadow, 'none');
    const selectedBox = await page.locator('.exercise-card[data-exercise="squat"]').boundingBox();
    await page.mouse.move(selectedBox.x + selectedBox.width / 2, selectedBox.y + selectedBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(200);
    const pressedScale = await page.locator('.exercise-card[data-exercise="squat"]').evaluate((node) =>
      new DOMMatrixReadOnly(getComputedStyle(node).transform).a);
    assert.ok(Math.abs(pressedScale - 0.98) < 0.001, `отклик на нажатие: ${pressedScale}`);
    await page.mouse.up();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.exercise), 'plank');
    assert.equal(await page.locator('.exercise-card[data-exercise="plank"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#goal-unit').textContent(), 'СЕКУНДЫ');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.exercise), 'pullup');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.exercise), 'squat');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.exercise), 'pullup');
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.exercise), 'squat');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#exercise-sheet').isVisible(), false);
    assert.equal(await page.locator('#workout-setup').isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'exercise-select');
    assert.equal(await page.locator('#exercise-select').getAttribute('aria-expanded'), 'false');

    await page.locator('#custom-goal').fill('17');
    await page.click('#exercise-select');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space'); // текущая карточка не сбрасывает цель
    await page.click('#exercise-sheet-done');
    assert.equal(await page.locator('#custom-goal').inputValue(), '17');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'exercise-select');
    await page.click('#exercise-select');
    await page.mouse.click(5, 5); // backdrop закрывает только каталог
    assert.equal(await page.locator('#exercise-sheet').isVisible(), false);
    assert.equal(await page.locator('#workout-setup').isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'exercise-select');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.click('#exercise-select');
    assert.equal(await page.locator('.exercise-sheet-content').evaluate((node) => getComputedStyle(node).animationName), 'none');
    await page.click('#exercise-sheet-done');
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // Независимая прокрутка и доступные действия на узких и горизонтальных экранах.
    for (const screen of screens) {
      await page.setViewportSize(screen);
      await page.click('#exercise-select');
      await page.locator('.exercise-sheet-content').evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {})));
      });
      await visible('#exercise-sheet-close', screen);
      await visible('#exercise-sheet-done', screen);
      const layout = await page.evaluate(() => {
        const list = document.querySelector('.exercise-list');
        const footer = document.querySelector('.exercise-sheet-footer');
        const lr = list.getBoundingClientRect();
        const fr = footer.getBoundingClientRect();
        return { height: list.clientHeight, content: list.scrollHeight, width: list.clientWidth,
          contentWidth: list.scrollWidth, listBottom: lr.bottom, footerTop: fr.top };
      });
      assert.ok(layout.height > 40 && layout.content > layout.height && layout.contentWidth <= layout.width &&
        layout.listBottom <= layout.footerTop + 1, `каталог ${JSON.stringify(screen)}: ${JSON.stringify(layout)}`);
      const cardsLayout = await page.locator('.exercise-card').evaluateAll((cards) => cards.map((card) => {
        const bounds = (selector) => {
          const { left, right, top, bottom } = card.querySelector(selector).getBoundingClientRect();
          return { left, right, top, bottom };
        };
        const { left, right, top, bottom } = card.getBoundingClientRect();
        const badge = getComputedStyle(card.querySelector('.exercise-card-camera'));
        return { id: card.dataset.exercise, rect: { left, right, top, bottom },
          heading: bounds('.exercise-card-heading'), name: bounds('.exercise-card-name'),
          mode: bounds('.exercise-badge-mode'), badges: bounds('.exercise-card-badges'),
          muscle: bounds('.exercise-badge-muscle'), camera: bounds('.exercise-card-camera'),
          overflow: card.scrollWidth > card.clientWidth || card.scrollHeight > card.clientHeight,
          fontSize: parseFloat(badge.fontSize), fontWeight: Number(badge.fontWeight), spacing: parseFloat(badge.letterSpacing) };
      }));
      for (const card of cardsLayout) {
        const within = (r) => r.left >= card.rect.left - 1 && r.right <= card.rect.right + 1 &&
          r.top >= card.rect.top - 1 && r.bottom <= card.rect.bottom + 1;
        assert.ok(!card.overflow && [card.name, card.mode, card.muscle, card.camera].every(within),
          `содержимое карточки выходит за границы ${JSON.stringify(screen)}: ${JSON.stringify(card)}`);
        assert.ok(card.name.right <= card.mode.left + 1 && card.heading.bottom <= card.badges.top + 1,
          `порядок строк карточки ${JSON.stringify(screen)}: ${JSON.stringify(card)}`);
        assert.ok(card.fontSize >= 11 && card.fontSize <= 12 && card.fontWeight >= 600 && card.spacing >= 0.5,
          `стиль бейджа ${JSON.stringify(screen)}: ${JSON.stringify(card)}`);
      }
      await page.locator('.exercise-card[data-exercise="pullup"]').click();
      assert.equal(await page.locator('#exercise-sheet-selection').textContent(), 'Подтягивания');
      assert.ok((await page.locator('.exercise-list').evaluate((list) => list.scrollTop)) > 0);
      await page.click('#exercise-sheet-done');
      await visible('#start-workout', screen);
    }

    await page.setViewportSize(screens[0]);
    await chooseExercise('plank');
    await page.evaluate(() => { window.__pose = window.__makePose(false); });
    await page.click('#free-goal');
    await page.click('#start-workout');
    await page.waitForFunction(() => document.querySelector('#squat-phase').textContent === 'Удержание');
    await page.waitForFunction(() => Number(document.querySelector('#rep-count').textContent) >= 1, null, { timeout: 6000 });
    assert.equal(await page.locator('#squat-view-control').isVisible(), false);
    assert.equal(await page.locator('#exercise-select').isDisabled(), true);
    assert.equal(await page.locator('.exercise-card[data-exercise="lunge"]').isDisabled(), true);
    await page.evaluate(() => document.querySelector('.exercise-card[data-exercise="lunge"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(await page.locator('#active-exercise').textContent(), 'ПЛАНКА');
    assert.equal(await page.locator('.exercise-card[data-exercise="plank"]').getAttribute('aria-checked'), 'true');
    for (const screen of screens) await assertActiveLayout(screen);
    await page.setViewportSize(screens[0]);
    await page.click('#finish-workout');
    await page.waitForSelector('#workout-results[open]');
    assert.equal(await page.locator('#results-metric-label').textContent(), 'УДЕРЖАНИЕ, СЕК');
    assert.ok(Number(await page.locator('#results-reps').textContent()) >= 1);
    assert.equal(await page.locator('#results-score-value').textContent(), '—');
    assert.equal(await page.locator('#results-grade').textContent(), 'Оценка недоступна');
    assert.equal(await page.locator('#results-clean').textContent(), '—');
    assert.equal(await page.locator('#results-tempo').textContent(), '—');
    assert.equal(await page.locator('#results-hold').isVisible(), true);
    assert.match(await page.locator('#results-hold-ratio').textContent(), /^[\d,.]+%$/);
    assert.match(await page.locator('#results-hold').textContent(), /это не оценка техники/);
    const ratio = Number(await page.locator('#results-hold-progress').getAttribute('aria-valuenow'));
    assert.ok(ratio >= 0 && ratio <= 100);
    assert.equal(await page.evaluate(() => window.__beeps), 0);
    await page.click('#new-workout');
    await chooseExercise('sidePlank');
    await page.locator('#custom-goal').fill('1');
    await page.evaluate(() => { window.__pose = window.__makePose(true); });
    await page.click('#start-workout');
    await page.waitForSelector('#workout-results[open]', { timeout: 8000 });
    assert.equal(await page.locator('#results-status').textContent(), 'ЦЕЛЬ ДОСТИГНУТА');
    assert.equal(await page.locator('#results-reps').textContent(), '1');
    assert.equal(await page.locator('#results-goal').textContent(), 'из 1 с');
    assert.equal(await page.evaluate(() => window.__beeps), 1);

    // Длинные ограничения других анализаторов сохраняются в тексте и не перекрывают HUD.
    for (const [id, text] of [['deadlift', 'Округление позвоночника'],
      ['gluteBridge', 'изгиб поясницы'], ['pullup', 'перекладины']]) {
      await page.click('#new-workout');
      await chooseExercise(id);
      await page.click('#free-goal');
      await page.evaluate(() => { window.__pose = null; });
      await page.click('#start-workout');
      await page.waitForFunction((value) => document.querySelector('#squat-feedback').textContent.includes(value), text);
      assert.equal(await page.locator('#advice-banner').getAttribute('tabindex'), '0');
      for (const screen of screens) await assertActiveLayout(screen);
      await page.setViewportSize(screens[0]);
      await page.click('#finish-workout');
      await page.waitForSelector('#workout-results[open]');
      assert.equal(await page.locator('#results-metric-label').textContent(), 'ПОВТОРЫ');
    }
    // Очень длинная цель в HUD не должна заслонять текст другого упражнения.
    await page.click('#new-workout');
    await chooseExercise('gluteBridge');
    await page.locator('#custom-goal').fill('9007199254740991');
    await page.click('#start-workout');
    await page.waitForFunction(() => document.querySelector('#tracking-status').textContent === 'АНАЛИЗ АКТИВЕН');
    for (const screen of screens) await assertActiveLayout(screen);
    await page.setViewportSize(screens[0]);
    await page.click('#finish-workout');

    // Реальный HTMLVideoElement: пауза и seek не включаются в удержание.
    await page.click('#close-results');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'toggle-camera');
    await page.evaluate(() => { window.__pose = window.__makePose(false); });
    await page.locator('#videoFileInput').setInputFiles(fixture);
    await chooseExercise('plank');
    await page.click('[data-goal="60"]');
    await page.click('#start-workout');
    await page.waitForFunction(() => document.querySelector('#camera').currentTime > 0.7 &&
      parseFloat(document.querySelector('#rep-progress-fill').style.width) > 0, null, { timeout: 8000 });
    await page.click('#video-play');
    await page.waitForFunction(() => document.querySelector('#camera').paused &&
      document.querySelector('#squat-phase').textContent === 'Пауза');
    const holdSeconds = () => page.locator('#rep-progress-fill').evaluate((node) => parseFloat(node.style.width) * 60 / 100);
    const beforePause = await holdSeconds();
    for (const screen of screens) await assertActiveLayout(screen);
    await page.setViewportSize(screens[0]);
    await page.waitForTimeout(1000);
    assert.ok(Math.abs(await holdSeconds() - beforePause) < 0.001);
    await page.evaluate(() => { document.querySelector('#camera').currentTime = 0.1; });
    await page.waitForFunction(() => !document.querySelector('#camera').seeking);
    await page.waitForTimeout(200); // единичный предпросмотр на паузе
    assert.ok(Math.abs(await holdSeconds() - beforePause) < 0.001);
    assert.equal(await page.locator('#squat-phase').textContent(), 'Пауза');
    await page.click('#video-play');
    await page.waitForFunction(() => document.querySelector('#camera').currentTime > 0.7, null, { timeout: 8000 });
    await page.click('#video-play');
    const afterResume = await holdSeconds();
    assert.ok(afterResume > beforePause && afterResume - beforePause < 0.8,
      `пауза или seek добавили лишнее время: ${beforePause} → ${afterResume}`);
    await page.click('#finish-workout');
    assert.equal(await page.locator('#results-metric-label').textContent(), 'УДЕРЖАНИЕ, СЕК');
    assert.deepEqual(errors, []);
    console.log('PASS упражнения: селектор, единицы, адаптивность, обе планки, реальный WebM, итоги и сигнал');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
