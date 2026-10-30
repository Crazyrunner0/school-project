import { findAngle, findVerticalAngle } from './geometry.js';
import { SQUAT_ERROR, SQUAT_PHASE } from './analyzer.js';
import { EXERCISES, createAnalyzer } from './exerciseFactory.js';

// Версия WASM должна совпадать с версией ESM-модуля в importmap файла index.html.
// Модель Lite меньше и быстрее остальных вариантов Pose Landmarker.
const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm';
const MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const MIN_VISIBILITY = 0.5;

// Индексы анатомических левой и правой сторон в массиве MediaPipe Pose.
const BODY_SIDES = [
  { label: 'Л', shoulder: 11, hip: 23, knee: 25, ankle: 27, color: '#f4fff0' },
  { label: 'П', shoulder: 12, hip: 24, knee: 26, ankle: 28, color: '#d0f291' }
];

const video = document.getElementById('camera');
const canvas = document.getElementById('overlay');
const context = canvas.getContext('2d');
const cameraView = document.getElementById('camera-view');
const controls = document.getElementById('controls');
const interfaceRoot = document.getElementById('interface');
const sourceLabel = document.getElementById('source-label');
const viewfinderSource = document.getElementById('viewfinder-source');
const toggleButton = document.getElementById('toggle-camera');
const switchButton = document.getElementById('switch-camera');
const uploadButton = document.getElementById('upload-video');
const videoFileInput = document.getElementById('videoFileInput');
const videoControls = document.getElementById('video-controls');
const videoPlay = document.getElementById('video-play');
const videoPlayIcon = document.getElementById('video-play-icon');
const videoPauseIcon = document.getElementById('video-pause-icon');
const videoPlayText = document.getElementById('video-play-text');
const videoSeek = document.getElementById('video-seek');
const videoCurrentTime = document.getElementById('video-current-time');
const videoDuration = document.getElementById('video-duration');
const videoLoop = document.getElementById('video-loop');
const toggleText = document.getElementById('toggle-text');
const startIcon = document.getElementById('start-icon');
const stopIcon = document.getElementById('stop-icon');
const cameraName = document.getElementById('camera-name');
const status = document.getElementById('status');
const statusText = document.getElementById('status-text');
const emptyState = document.getElementById('empty-state');
const emptyTitle = document.getElementById('empty-title');
const emptyDescription = document.getElementById('empty-description');
const notice = document.getElementById('notice');
const trackingStatus = document.getElementById('tracking-status');
const poseNotice = document.getElementById('pose-notice');
const analysisPanel = document.getElementById('squat-panel');
const repCount = document.getElementById('rep-count');
const repCountLabel = document.getElementById('rep-count-label');
const activeExercise = document.getElementById('active-exercise');
const repCountLine = document.getElementById('rep-count-line');
const repTarget = document.getElementById('rep-target');
const repProgress = document.getElementById('rep-progress');
const repProgressFill = document.getElementById('rep-progress-fill');
const topbar = document.getElementById('topbar');
const finishButton = document.getElementById('finish-workout');
const setupDialog = document.getElementById('workout-setup');
const workoutForm = document.getElementById('workout-form');
const setupSource = document.getElementById('setup-source');
const setupDescription = document.getElementById('setup-description');
const exerciseSelect = document.getElementById('exercise-select');
const exerciseHint = document.getElementById('exercise-hint');
const goalUnit = document.getElementById('goal-unit');
const freeGoalDescription = document.getElementById('free-goal-description');
const cancelSetup = document.getElementById('cancel-setup');
const goalOptions = [...document.querySelectorAll('.goal-option')];
const customGoal = document.getElementById('custom-goal');
const goalError = document.getElementById('goal-error');
const freeGoal = document.getElementById('free-goal');
const resultsDialog = document.getElementById('workout-results');
const resultsTitle = document.getElementById('results-title');
const resultsMessage = document.getElementById('results-message');
const resultsReps = document.getElementById('results-reps');
const resultsMetricLabel = document.getElementById('results-metric-label');
const resultsGoal = document.getElementById('results-goal');
const resultsDuration = document.getElementById('results-duration');
const newWorkout = document.getElementById('new-workout');
const closeResults = document.getElementById('close-results');
const dismissResults = document.getElementById('dismiss-results');
const phaseOutput = document.getElementById('squat-phase');
const feedbackOutput = document.getElementById('squat-feedback');
const adviceBanner = document.getElementById('advice-banner');
const adviceIcon = document.getElementById('advice-icon');
const adviceLabel = document.getElementById('advice-label');
const squatView = document.getElementById('squat-view');
const squatViewControl = document.getElementById('squat-view-control');

// Для каждого нового выбора фабрика создаёт отдельный экземпляр анализатора.
let currentExerciseId = 'squat';
let currentExercise = EXERCISES[currentExerciseId];
let currentAnalyzer = createAnalyzer(currentExerciseId);
const PHASE_LABELS = {
  WAITING: 'Подготовка', STANDING: 'Стоя', DESCENDING: 'Опускание',
  BOTTOM: 'Нижняя точка', ASCENDING: 'Подъём', DOWN: 'Исходное',
  CURLING: 'Подъём', PEAK: 'Верхняя точка', LOWERING: 'Опускание',
  LUNGING: 'Выпад', START: 'Исходное', PRESSING: 'Жим', TOP: 'Верхняя точка',
  LOCKOUT: 'Выпрямление', HINGING: 'Наклон', RISING: 'Подъём',
  CLOSED: 'Исходное', OPENING: 'Раскрытие', OPEN: 'Открыто', CLOSING: 'Возврат',
  LIFTING: 'Подъём', HANG: 'Вис', PULLING: 'Подъём', TURNAROUND: 'Разворот'
};

// Один token отменяет и запоздавшие getUserMedia, и загрузку предыдущего файла.
let stream = null;
let sourceMode = 'camera';
let videoFileURL = null;
let fileReady = false;
let cancelFileLoad = null;
let pausedFrameTimer = null;
let isScrubbing = false;
let trackingState = 'idle';
let facingMode = 'user';
let explicitFacingMode = false;
let state = 'idle';
let requestId = 0;

// Подход не зависит от источника: смена камеры/файла сохраняет его счётчик.
const workout = { active: false, goal: null, startedAt: 0, runId: 0, lastResult: null };
let goalMode = 'preset';
let selectedGoal = 10;
let pendingSource = null;
let lastSource = { mode: 'camera' };
let audioContext = null;

// Модель создаётся один раз и повторно используется при остановке или смене камеры.
let poseLandmarker = null;
let poseConnections = [];
let poseInitializationPromise = null;
let poseGeneration = 0;
let animationFrameId = null;
let lastVideoTime = -1;
let lastInferenceTimestamp = -1;
// Отдельный токен инвалидирует результаты до паузы, seek, Loop или смены размера.
let trackingEpoch = 0;
let lastProcessedTimestamp = -1;
let lastHoldFrameTime = null;
const pendingFrames = new Set();

function setWorkoutInterface(active) {
  finishButton.hidden = !active;
  topbar.dataset.workout = active ? 'active' : 'idle';
  controls.dataset.workout = active ? 'active' : 'idle';
  exerciseSelect.disabled = active;
  if (!active) {
    repTarget.hidden = true;
    repProgress.hidden = true;
  }
}

function goalUnitText(value, isHold, afterIz = false) {
  const last = value % 10;
  const lastTwo = value % 100;
  const one = last === 1 && lastTwo !== 11;
  const few = last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14);
  if (afterIz) return isHold ? (one ? 'секунды' : 'секунд') : (one ? 'повторения' : 'повторений');
  if (isHold) return one ? 'секунда' : few ? 'секунды' : 'секунд';
  return one ? 'повторение' : few ? 'повторения' : 'повторений';
}

function updateWorkoutHUD(count) {
  const isHold = currentExercise.mode === 'time';
  const displayedCount = isHold ? Math.floor(Math.max(0, count)) : count;
  const countText = String(displayedCount);
  // aria-live не должен повторно озвучивать прежнее значение на каждом кадре.
  if (repCount.textContent !== countText) repCount.textContent = countText;
  repTarget.hidden = !workout.active;
  if (!workout.active) {
    repProgress.hidden = true;
    return;
  }

  const targetText = workout.goal === null ? '∞' : `/ ${workout.goal}`;
  const targetLabel = workout.goal === null
    ? 'Свободный режим, без цели' : `Цель: ${workout.goal} ${goalUnitText(workout.goal, isHold)}`;
  // Даже очень длинную пользовательскую цель показываем целиком, не заслоняя фазу.
  const goalLength = workout.goal === null ? 0 : String(workout.goal).length;
  const compactTarget = goalLength > 4;
  if (repCountLine.dataset.compact !== String(compactTarget)) repCountLine.dataset.compact = String(compactTarget);
  const targetFontSize = compactTarget
    ? `${Number(Math.max(7, Math.min(14, 132 / (goalLength + 2))).toFixed(2))}px` : '';
  if (repTarget.style.fontSize !== targetFontSize) repTarget.style.fontSize = targetFontSize;
  if (repTarget.textContent !== targetText) repTarget.textContent = targetText;
  if (repTarget.getAttribute('aria-label') !== targetLabel) repTarget.setAttribute('aria-label', targetLabel);

  if (workout.goal === null) {
    repProgress.hidden = true;
    repProgressFill.style.width = '0%';
    return;
  }

  const progress = Math.min(count, workout.goal);
  const maximum = String(workout.goal);
  const displayedProgress = Math.min(displayedCount, workout.goal);
  const current = String(displayedProgress);
  const valueText = `${displayedProgress} из ${workout.goal} ${goalUnitText(workout.goal, isHold, true)}`;
  const width = `${progress / workout.goal * 100}%`;
  repProgress.hidden = false;
  if (repProgress.getAttribute('aria-valuemax') !== maximum) repProgress.setAttribute('aria-valuemax', maximum);
  if (repProgress.getAttribute('aria-valuenow') !== current) repProgress.setAttribute('aria-valuenow', current);
  if (repProgress.getAttribute('aria-valuetext') !== valueText) repProgress.setAttribute('aria-valuetext', valueText);
  if (repProgressFill.style.width !== width) repProgressFill.style.width = width;
}

function chooseGoal(mode, value = null) {
  goalMode = mode;
  selectedGoal = mode === 'preset' ? value : null;
  for (const button of goalOptions) {
    button.setAttribute('aria-pressed', String(mode === 'preset' && Number(button.dataset.goal) === value));
  }
  freeGoal.setAttribute('aria-pressed', String(mode === 'free'));
  if (mode !== 'custom') customGoal.value = '';
  customGoal.setAttribute('aria-invalid', 'false');
  goalError.hidden = true;
}

// Настройки и единицы всегда берём из одного каталога; значения цели не
// переносятся между упражнениями с разными единицами измерения.
function configureExerciseInterface() {
  const isHold = currentExercise.mode === 'time';
  exerciseSelect.value = currentExerciseId;
  exerciseHint.textContent = currentExercise.hint;
  setupDescription.textContent = isHold
    ? 'Сколько секунд удерживать?'
    : 'Сколько повторений выполнить?';
  goalUnit.textContent = isHold ? 'СЕКУНДЫ' : 'ПОВТОРЕНИЯ';
  freeGoalDescription.textContent = isHold ? 'Без ограничения времени' : 'Без ограничения повторений';
  goalOptions.forEach((button, index) => {
    button.dataset.goal = String(currentExercise.goals[index]);
    button.textContent = button.dataset.goal;
  });
  chooseGoal('preset', currentExercise.defaultGoal);
  repCountLabel.textContent = isHold ? 'СЕКУНД' : 'ПОВТОРОВ';
  activeExercise.textContent = currentExercise.label.toUpperCase();
  activeExercise.title = currentExercise.label;
  analysisPanel.setAttribute('aria-label', `Анализ упражнения: ${currentExercise.label}`);
  analysisPanel.dataset.exercise = currentExerciseId;
  // Длинный текст других автоматов можно прокрутить с клавиатуры и на телефоне.
  adviceBanner.tabIndex = currentExerciseId === 'squat' ? -1 : 0;
  squatViewControl.hidden = currentExerciseId !== 'squat';
  phaseOutput.textContent = PHASE_LABELS.WAITING;
  updateWorkoutHUD(0);
  resetAdvice();
}

function selectExercise(exerciseId) {
  // Даже программное изменение select во время подхода не меняет автомат и счётчик.
  if (workout.active || !Object.prototype.hasOwnProperty.call(EXERCISES, exerciseId)) {
    exerciseSelect.value = currentExerciseId;
    return false;
  }
  if (exerciseId !== currentExerciseId) {
    currentExerciseId = exerciseId;
    currentExercise = EXERCISES[exerciseId];
    currentAnalyzer = createAnalyzer(exerciseId);
    if (exerciseId === 'squat' && ['auto', 'front', 'side'].includes(squatView.value)) {
      currentAnalyzer.setView(squatView.value);
    }
    invalidateFrameClock();
  }
  configureExerciseInterface();
  return true;
}

function readWorkoutGoal() {
  if (goalMode === 'free') return null;
  if (goalMode === 'preset') return selectedGoal;
  const value = customGoal.value.trim();
  const number = Number(value);
  if (!value || !Number.isSafeInteger(number) || number <= 0) {
    customGoal.focus();
    customGoal.setAttribute('aria-invalid', 'true');
    goalError.hidden = false;
    return undefined;
  }
  return number;
}

function isDialogOpen(dialog) {
  // Запасной вариант для браузеров без HTMLDialogElement.
  return dialog.open === true || dialog.getAttribute('open') !== null;
}

function openDialog(dialog) {
  if (isDialogOpen(dialog)) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (!isDialogOpen(dialog)) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

// Окно открывается до getUserMedia и до декодирования выбранного файла.
function openWorkoutSetup(source) {
  if (workout.active) return;
  pendingSource = source;
  chooseGoal('preset', currentExercise.defaultGoal);
  setupSource.textContent = source.mode === 'file'
    ? `Источник: ${source.file.name}` : 'Источник: живая камера';
  setupSource.title = setupSource.textContent;
  openDialog(setupDialog);
  exerciseSelect.focus();
}

// AudioContext создаётся или разблокируется непосредственно по нажатию
// «Начать подход»: это необходимо для звука в большинстве мобильных браузеров.
function prepareCompletionSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextClass();
    if (audioContext.state !== 'running') audioContext.resume().catch(() => {});
  } catch (error) {
    // Отсутствие Web Audio или запрет браузера не должны мешать завершению.
    console.warn('Звуковой сигнал недоступен:', error);
    audioContext = null;
  }
}

function playCompletionBeep(runId) {
  const audio = audioContext;
  if (!audio || audio.state === 'closed') return;
  const play = () => {
    // Позднее разрешение браузера не должно прозвучать в следующем подходе.
    if (audioContext !== audio || audio.state !== 'running' || workout.runId !== runId || workout.active) return;
    try {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const now = audio.currentTime;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(660, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(now);
      oscillator.stop(now + 0.26);
    } catch (error) {
      console.warn('Не удалось воспроизвести сигнал:', error);
    }
  };
  if (audio.state === 'running') play();
  else audio.resume().then(play).catch(() => {});
}

// Итоги содержат отдельно время подхода и фактически подтверждённое удержание.
function showWorkoutResults(result) {
  const isHold = result.mode === 'time';
  resultsTitle.textContent = result.reason === 'goal' ? 'Цель достигнута!' : 'Отличная работа!';
  resultsMessage.textContent = `${EXERCISES[result.exerciseId].label}: ${result.reason === 'goal'
    ? 'запланированный подход завершён.' : 'подход завершён вручную.'}`;
  resultsMetricLabel.textContent = isHold ? 'УДЕРЖАНИЕ, СЕК' : 'ПОВТОРЫ';
  resultsReps.textContent = String(isHold ? Math.floor(result.activeHoldTime) : result.repCount);
  resultsGoal.textContent = result.goal === null ? 'Свободный режим'
    : `Цель: ${result.goal}${isHold ? ' с' : ''}`;
  resultsDuration.textContent = formatVideoTime(result.durationMs / 1000);
  openDialog(resultsDialog);
}

function finishWorkout(reason = 'manual') {
  if (!workout.active) return null; // Повторный клик и запоздавшие кадры игнорируем.
  const isHold = currentExercise.mode === 'time';
  const result = Object.freeze({
    reason,
    exerciseId: currentExerciseId,
    mode: currentExercise.mode,
    repCount: isHold ? null : currentAnalyzer.repCount,
    activeHoldTime: isHold ? currentAnalyzer.activeHoldTime : null,
    goal: workout.goal,
    durationMs: Math.max(0, performance.now() - workout.startedAt)
  });
  workout.active = false; // Блокируем подсчёт до остановки потока и показа итогов.
  workout.lastResult = result;
  setWorkoutInterface(false);
  stopCamera();
  if (reason === 'goal') playCompletionBeep(workout.runId);
  showWorkoutResults(result);
  return result;
}

function startWorkout(event) {
  event.preventDefault();
  if (workout.active || !pendingSource) return;
  const goal = readWorkoutGoal();
  if (goal === undefined) return;
  const source = pendingSource;
  pendingSource = null;
  closeDialog(setupDialog);

  workout.active = true;
  workout.goal = goal;
  workout.startedAt = performance.now();
  workout.runId += 1;
  workout.lastResult = null;
  lastSource = source;
  setWorkoutInterface(true);
  resetAnalysisSession();
  if (goal !== null) prepareCompletionSound();

  if (source.mode === 'file') switchSource('file', source.file);
  else {
    setSourceMode('camera');
    startCamera(facingMode, explicitFacingMode);
  }
}

function setFacingMode(mode) {
  facingMode = mode;
  cameraName.textContent = mode === 'user' ? 'Фронтальная' : 'Задняя';
  // Видео и canvas зеркалятся вместе: координаты скелета остаются совмещёнными.
  cameraView.classList.toggle('is-mirrored', mode === 'user');
}

function setSourceMode(mode, fileName = '') {
  sourceMode = mode;
  controls.dataset.source = mode;
  interfaceRoot.dataset.source = mode;
  uploadButton.setAttribute('aria-pressed', String(mode === 'file'));
  sourceLabel.textContent = mode === 'file' ? 'ВИДЕОФАЙЛ' : 'ВЫБРАННАЯ КАМЕРА';
  viewfinderSource.textContent = mode === 'file' ? 'АНАЛИЗ ВИДЕО' : 'ВИД ИЗ КАМЕРЫ';
  if (mode === 'file') {
    cameraView.classList.remove('is-mirrored');
    cameraName.textContent = fileName || 'Видеофайл';
    cameraName.title = fileName;
  } else {
    cameraName.removeAttribute('title');
    setFacingMode(facingMode);
  }
}

function setState(nextState, message = '') {
  const isFile = sourceMode === 'file';
  const states = isFile ? {
    idle: {
      status: 'Видео не выбрано',
      title: 'Выберите видео',
      description: 'Загрузите видео с устройства, чтобы начать анализ.'
    },
    starting: {
      status: 'Загрузка видео',
      title: 'Открываем видео',
      description: 'Подготавливаем локальный файл для анализа.'
    },
    running: { status: 'Видео готово' },
    error: {
      status: 'Видео недоступно',
      title: 'Не удалось открыть видео',
      description: message
    }
  } : {
    idle: {
      status: 'Камера выключена',
      title: 'Движение начинается здесь',
      description: 'Включите камеру или выберите видео, чтобы начать анализ.'
    },
    starting: {
      status: 'Подключение',
      title: 'Подключаем камеру',
      description: 'Разрешите доступ к камере, если браузер запросит его.'
    },
    running: { status: 'Камера включена' },
    error: {
      status: 'Камера недоступна',
      title: 'Не удалось включить камеру',
      description: message
    }
  };
  const current = states[nextState];
  const isActive = nextState === 'running' || nextState === 'starting';

  state = nextState;
  status.dataset.state = nextState;
  statusText.textContent = current.status;
  emptyState.hidden = nextState === 'running';
  emptyState.dataset.state = nextState;
  cameraView.classList.toggle('has-stream', nextState === 'running');
  const showVideoControls = isFile && fileReady && nextState === 'running';
  controls.dataset.player = String(showVideoControls);
  videoControls.hidden = !showVideoControls;
  switchButton.hidden = isFile;
  switchButton.disabled = nextState === 'starting';
  startIcon.toggleAttribute('hidden', !isFile && isActive);
  stopIcon.toggleAttribute('hidden', isFile || !isActive);
  toggleText.textContent = isFile
    ? 'Живая камера'
    : nextState === 'starting' ? 'Отменить'
      : nextState === 'running' ? 'Стоп камеры' : 'Старт камеры';
  toggleButton.setAttribute('aria-label', isFile
    ? 'Вернуться к живой камере'
    : nextState === 'starting' ? 'Отменить запуск камеры' : toggleText.textContent);

  if (nextState !== 'running') {
    emptyTitle.textContent = current.title;
    emptyDescription.textContent = current.description;
  }
  if (isFile && fileReady) updateVideoControls();
}

function setNotice(message = '') {
  notice.textContent = message;
  notice.hidden = !message;
}

// Ошибки модели показываются отдельно от ошибок камеры: видео может продолжать работать.
function setTrackingState(nextState, message = '') {
  const labels = {
    idle: 'ПОДГОТОВКА',
    loading: 'ЗАГРУЗКА МОДЕЛИ',
    running: 'АНАЛИЗ АКТИВЕН',
    error: 'ОШИБКА АНАЛИЗА'
  };
  trackingState = nextState;
  trackingStatus.textContent = labels[nextState];
  analysisPanel.hidden = nextState !== 'running' || !workout.active;
  poseNotice.textContent = message;
  poseNotice.hidden = !message;
  if (sourceMode === 'file' && fileReady) updateVideoControls();
}

function stopTracks(mediaStream) {
  mediaStream.getTracks().forEach((track) => track.stop());
}

function cancelPoseFrame() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function cancelPausedPreview() {
  if (pausedFrameTimer !== null) {
    clearTimeout(pausedFrameTimer);
    pausedFrameTimer = null;
  }
}

// Сбрасываем только непрерывность кадров, не накопленный результат подхода.
function invalidateFrameClock() {
  trackingEpoch += 1;
  lastHoldFrameTime = null;
  pendingFrames.clear();
}

// Отменяем следующий кадр и стираем скелет, чтобы он не оставался на новом источнике.
function stopPoseLoop() {
  cancelPoseFrame();
  cancelPausedPreview();
  lastVideoTime = -1;
  invalidateFrameClock();
  context?.clearRect(0, 0, canvas.width, canvas.height);
  currentAnalyzer.resetTracking();
  phaseOutput.textContent = PHASE_LABELS.WAITING;
  resetAdvice();
  analysisPanel.hidden = true;
}

function releaseSource() {
  if (cancelFileLoad) cancelFileLoad();
  stopPoseLoop();
  const previousStream = stream;
  const previousURL = videoFileURL;
  stream = null;
  videoFileURL = null;
  fileReady = false;
  isScrubbing = false;
  setTrackingState('idle');
  video.pause();
  video.srcObject = null;
  if (previousStream) stopTracks(previousStream);
  if (previousURL) {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(previousURL);
  }
  video.loop = false;
}

function resetAnalysisSession() {
  invalidateFrameClock();
  currentAnalyzer.reset();
  updateWorkoutHUD(0);
  phaseOutput.textContent = PHASE_LABELS.WAITING;
  resetAdvice();
}

function stopCamera() {
  requestId += 1;
  releaseSource();
  if (sourceMode !== 'camera') setSourceMode('camera');
  setNotice();
  setState('idle');
}

function syncCanvasSize() {
  const { videoWidth, videoHeight } = video;
  if (videoWidth && videoHeight && (canvas.width !== videoWidth || canvas.height !== videoHeight)) {
    // Внутреннее разрешение canvas равно разрешению видео, а не размеру элемента в CSS.
    // Одинаковый object-fit: cover в style.css сохраняет совмещение при любом экране.
    // Эталоны некоторых автоматов зависят от размеров в пикселях, в том числе
    // при неизменном aspect ratio; прерываем попытку, но сохраняем результат.
    currentAnalyzer.resetTracking();
    invalidateFrameClock();
    canvas.width = videoWidth;
    canvas.height = videoHeight;
  }
}

function isActiveFile() {
  return sourceMode === 'file' && fileReady && videoFileURL !== null && state === 'running';
}

function formatVideoTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

function updateVideoControls() {
  const canSeek = fileReady && Number.isFinite(video.duration) && video.duration > 0;
  const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const playing = !video.paused && !video.ended;
  videoPlay.disabled = !fileReady || trackingState === 'loading';
  videoSeek.disabled = !canSeek;
  videoLoop.disabled = !fileReady;
  videoPlayIcon.toggleAttribute('hidden', playing);
  videoPauseIcon.toggleAttribute('hidden', !playing);
  videoPlayText.textContent = playing ? 'Пауза' : 'Play';
  videoPlay.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести видео');
  videoLoop.setAttribute('aria-pressed', String(video.loop));
  videoDuration.textContent = formatVideoTime(video.duration);
  if (!isScrubbing) {
    videoSeek.max = canSeek ? String(video.duration) : '0';
    videoSeek.value = canSeek ? String(Math.min(current, video.duration)) : '0';
    videoCurrentTime.textContent = formatVideoTime(current);
    videoSeek.setAttribute('aria-valuetext',
      `${formatVideoTime(current)} из ${formatVideoTime(video.duration)}`);
  }
}

// При смене источника подписки и таймер снимаются сразу, а ожидающий вызов
// получает отмену вместо ошибки. loadeddata означает первый декодированный кадр.
function waitForVideoData(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const cleanup = () => {
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('error', onError);
      clearTimeout(timeoutId);
      if (cancelFileLoad === cancel) cancelFileLoad = null;
    };
    const finish = (error, cancelled = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(!cancelled);
    };
    const cancel = () => finish(null, true);
    const onLoadedData = () => {
      if (videoFileURL !== url || (video.currentSrc && video.currentSrc !== url)) return;
      if (!video.videoWidth || !video.videoHeight) {
        finish(new Error('В видео не найдено изображение. Выберите другой файл.'));
      } else {
        finish(null);
      }
    };
    const onError = () => {
      // Игнорируем запоздавшее событие старого ресурса после смены файла.
      if (videoFileURL === url && video.error && (!video.currentSrc || video.currentSrc === url)) {
        finish(new Error('Формат или кодек видео не поддерживается браузером. Попробуйте другой файл.'));
      }
    };
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('error', onError);
    timeoutId = setTimeout(() => finish(new Error('Не удалось вовремя загрузить видео. Попробуйте другой файл.')), 30000);
    cancelFileLoad = cancel;
  });
}

// Оба источника используют один video/canvas и одну модель. Сам файл остаётся
// на устройстве: blob URL освобождается при замене или возврате к камере.
async function loadVideoFile(file) {
  if (!file || !workout.active) return;
  const currentRequest = ++requestId;
  releaseSource();
  setSourceMode('file', file.name);
  setNotice();
  setState('starting');
  video.autoplay = false;
  video.loop = false;
  video.preload = 'auto';

  try {
    const url = URL.createObjectURL(file);
    videoFileURL = url;
    const loaded = waitForVideoData(url);
    video.src = url;
    video.load();
    if (!await loaded || currentRequest !== requestId || videoFileURL !== url) return;

    fileReady = true;
    syncCanvasSize();
    setState('running');
    // Автозапуск только после загрузки модели: начало ролика не теряется.
    await startPoseTracking(currentRequest);
  } catch (error) {
    if (currentRequest !== requestId) return;
    releaseSource();
    setState('error', error?.message || 'Не удалось открыть видео. Попробуйте другой файл.');
  }
}

function getErrorMessage(error) {
  switch (error?.name) {
    case 'MediaDevicesUnavailable':
      return 'Камера недоступна. Откройте приложение по HTTPS или на localhost и проверьте поддержку браузера.';
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Доступ к камере запрещён. Разрешите его в настройках браузера и попробуйте снова.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Камера не найдена. Проверьте её подключение или выберите другую камеру.';
    case 'OverconstrainedError':
      return 'Выбранная камера недоступна. Попробуйте сменить камеру.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Не удалось открыть камеру. Возможно, она используется другим приложением.';
    default:
      return 'Проверьте доступ к камере и попробуйте снова.';
  }
}

// Загрузка ESM, WASM и модели выполняется только после запуска камеры.
async function initializePoseLandmarker(generation) {
  const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
  if (generation !== poseGeneration) return null;

  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  if (generation !== poseGeneration) return null;

  // Одна поза без маски и ускорение GPU снижают задержку; реальный FPS зависит от устройства.
  const options = {
    runningMode: 'VIDEO',
    numPoses: 1,
    outputSegmentationMasks: false
  };
  let landmarker;

  try {
    // GPU обычно быстрее на смартфонах; маски сегментации нам не нужны.
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' }
    });
  } catch (error) {
    if (generation !== poseGeneration) return null;
    // Если WebGL/GPU недоступен, приложение продолжит работу на CPU.
    console.warn('GPU недоступен, используется CPU:', error);
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'CPU' }
    });
  }

  // Страница могла закрыться, пока модель скачивалась или инициализировалась.
  if (generation !== poseGeneration) {
    landmarker.close();
    return null;
  }

  poseConnections = PoseLandmarker.POSE_CONNECTIONS;
  poseLandmarker = landmarker;
  return landmarker;
}

function getPoseLandmarker() {
  if (poseLandmarker) return Promise.resolve(poseLandmarker);

  // Параллельные запуски или смены камеры используют один запрос и одну модель.
  if (!poseInitializationPromise) {
    const pending = initializePoseLandmarker(poseGeneration);
    poseInitializationPromise = pending;
    pending.then(
      () => { if (poseInitializationPromise === pending) poseInitializationPromise = null; },
      () => { if (poseInitializationPromise === pending) poseInitializationPromise = null; }
    );
  }
  return poseInitializationPromise;
}

function disposePoseLandmarker() {
  // Инвалидируем и незавершённую загрузку, чтобы она не оставила ресурсы после pagehide.
  poseGeneration += 1;
  const previousLandmarker = poseLandmarker;
  poseLandmarker = null;
  poseInitializationPromise = null;
  poseConnections = [];
  lastInferenceTimestamp = -1;
  lastProcessedTimestamp = -1;
  invalidateFrameClock();
  if (previousLandmarker) previousLandmarker.close();
}

function isVisible(landmark) {
  return landmark && Number.isFinite(landmark.x) && Number.isFinite(landmark.y)
    && (landmark.visibility ?? 1) >= MIN_VISIBILITY;
}

function toFramePoint(landmark, width, height) {
  if (!isVisible(landmark)) return null;

  // X нормирован по ширине, Y — по высоте; Z — относительная глубина в масштабе X.
  // Z может быть отрицательным: не ограничиваем координаты диапазоном 0…1.
  const point = { x: landmark.x * width, y: landmark.y * height };
  if (landmark.z !== undefined) {
    point.z = Number.isFinite(landmark.z) ? landmark.z * width : NaN;
  }
  return point;
}

function drawAngleValues(landmarks, width, height) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  // Для object-fit: cover определяем видимую часть кадра и размер шрифта в её масштабе.
  const scale = Math.max(rect.width / width, rect.height / height);
  const visibleWidth = Math.min(width, rect.width / scale);
  const visibleHeight = Math.min(height, rect.height / scale);
  const left = (width - visibleWidth) / 2;
  const top = (height - visibleHeight) / 2;
  const right = left + visibleWidth;
  const bottom = top + visibleHeight;
  const padding = 4 / scale;
  const fontSize = Math.max(8, 14 / scale);
  const mirrored = cameraView.classList.contains('is-mirrored');

  context.save();
  try {
    // CSS зеркалит весь canvas для фронтальной камеры. Зеркалим текст второй раз,
    // чтобы он читался нормально, но оставался рядом с соответствующим суставом.
    if (mirrored) {
      context.translate(width, 0);
      context.scale(-1, 1);
    }
    context.font = `600 ${fontSize}px system-ui, sans-serif`;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    context.lineWidth = 3.5 / scale;
    context.strokeStyle = 'rgba(4, 9, 5, 0.95)';

    function drawLabel(side, name, point, angle) {
      if (!point || angle === null) return;
      const x = mirrored ? width - point.x : point.x;
      const y = point.y;
      // Не показываем подпись у сустава, скрытого за границами обрезанного видео.
      if (x < left || x > right || y < top || y > bottom) return;

      const text = `${side.label} ${name}: ${Math.round(angle)}°`;
      const maxTextWidth = Math.max(0, visibleWidth - 2 * padding);
      if (!maxTextWidth) return;
      const textWidth = Math.min(context.measureText(text).width, maxTextWidth);
      const offset = 8 / scale;
      const preferredX = x < width / 2 ? x - offset - textWidth : x + offset;
      const textX = Math.max(left + padding, Math.min(preferredX, right - padding - textWidth));
      // Подписи сторон немного разнесены по вертикали, если суставы накладываются.
      const preferredY = y + (side.label === 'Л' ? -10 : 10) / scale;
      const textY = Math.max(top + padding + fontSize / 2,
        Math.min(preferredY, bottom - padding - fontSize / 2));

      context.fillStyle = side.color;
      context.strokeText(text, textX, textY, maxTextWidth);
      context.fillText(text, textX, textY, maxTextWidth);
    }

    for (const side of BODY_SIDES) {
      const shoulder = toFramePoint(landmarks[side.shoulder], width, height);
      const hip = toFramePoint(landmarks[side.hip], width, height);
      const knee = toFramePoint(landmarks[side.knee], width, height);
      const ankle = toFramePoint(landmarks[side.ankle], width, height);

      // Неполные, скрытые и совпадающие точки дают null, а не неверный угол.
      const kneeAngle = findAngle(hip, knee, ankle);
      const hipAngle = findAngle(shoulder, hip, knee);
      const trunkAngle = findVerticalAngle(shoulder, hip);
      drawLabel(side, 'колено', knee, kneeAngle);
      drawLabel(side, 'таз', hip, hipAngle);
      drawLabel(side, 'корпус', shoulder, trunkAngle);
    }
  } finally {
    context.restore();
  }
}

// Приоритет и минимальное время чтения относятся к тексту, а не к цвету скелета.
// Новая более серьёзная ошибка появляется сразу, не ожидая завершения предыдущей подсказки.
const ADVICE_STYLES = {
  neutral: { priority: 0, label: 'ПОДГОТОВКА', icon: '–' },
  good: { priority: 0, label: 'ПРОДОЛЖАЙТЕ', icon: '✓' },
  warning: { priority: 1, label: 'ВНИМАНИЕ', icon: '!' },
  danger: { priority: 2, label: 'НУЖНА КОРРЕКЦИЯ', icon: '!' }
};
const ADVICE_MIN_MS = 600;
const WARNING_MIN_MS = 1800;
const ADVICE = {
  waiting: { key: 'waiting', level: 'neutral', text: 'Встаньте прямо, чтобы начать отсчёт.' },
  noPose: { key: 'no-pose', level: 'neutral', text: 'Покажите камере таз, колени и лодыжки.' },
  unknownView: { key: 'unknown-view', level: 'neutral', text: 'Выберите ракурс: спереди или сбоку.' },
  missingFront: { key: 'missing-front', level: 'neutral', text: 'Покажите камере колени и лодыжки.' },
  missingSide: { key: 'missing-side', level: 'neutral', text: 'Покажите камере стопы и пятки.' },
  standing: { key: 'standing', level: 'neutral', text: 'Начните приседание, когда будете готовы.' },
  repDone: { key: 'rep-done', level: 'good', text: 'Повтор засчитан. Продолжайте!' },
  descending: { key: 'descending', level: 'good', text: 'Опускайтесь подконтрольно.' },
  ascending: { key: 'ascending', level: 'good', text: 'Плавно вернитесь в исходную стойку.' },
  deep: { key: 'deep', level: 'good', priority: 0.5, text: 'Целевая глубина достигнута!' },
  almostDeep: { key: 'almost-deep', level: 'warning', text: 'В следующий раз чуть глубже, если комфортно.' },
  shallow: { key: 'shallow', level: 'danger', text: 'Недостаточная глубина приседания.' },
  previousShallow: { key: 'previous-shallow', level: 'warning', text: 'В прошлом повторе глубина была недостаточной.' },
  back: { key: 'back', level: 'danger', priority: 3, text: 'Слишком сильный наклон корпуса.' },
  knees: { key: 'knees', level: 'warning', text: 'Не сводите колени внутрь — направляйте их к стопам.' },
  pastToe: { key: 'past-toe', level: 'warning', text: 'Колено впереди носка: проверьте положение и ракурс.' }
};
const FILE_ADVICE_TEXT = {
  waiting: 'Человек должен стоять прямо для начала отсчёта.',
  'no-pose': 'В кадре должны быть видны таз, колени и лодыжки.',
  'missing-front': 'В кадре должны быть видны колени и лодыжки.',
  'missing-side': 'В кадре должны быть видны стопы и пятки.'
};
let displayedAdvice = null;
let adviceShownAt = 0;

function adviceText(advice) {
  return sourceMode === 'file' ? FILE_ADVICE_TEXT[advice.key] ?? advice.text : advice.text;
}

function chooseAdvice(result) {
  if (currentExerciseId !== 'squat') {
    // Показываем фактическую рекомендацию анализатора, включая ограничения.
    // Для повторений отсутствие предупреждений не равно оценке безопасности.
    const text = result.feedbackMessage || currentExercise.initialAdvice;
    const hasError = Array.isArray(result.currentErrors) && result.currentErrors.length > 0;
    const level = hasError || (currentExercise.mode === 'time' && !result.isFormCorrect)
      ? 'warning' : currentExercise.mode === 'time' && result.isFormCorrect ? 'good' : 'neutral';
    return { key: `${currentExerciseId}:${level}:${text}`, level, text };
  }
  const errors = result.currentErrors;
  if (errors.includes(SQUAT_ERROR.BACK_LEAN)) return ADVICE.back;
  if (errors.includes(SQUAT_ERROR.SHALLOW)) return ADVICE.shallow;
  if (errors.includes(SQUAT_ERROR.KNEES_INWARD)) return ADVICE.knees;
  if (errors.includes(SQUAT_ERROR.KNEE_PAST_TOE)) return ADVICE.pastToe;

  // При недостатке данных не выдаём зелёную оценку техники.
  if (result.feedbackMessage.startsWith('Покажите камере')) return ADVICE.noPose;
  if (result.currentPhase === SQUAT_PHASE.WAITING) return ADVICE.waiting;
  if (result.feedbackMessage.startsWith('Ракурс не определён')) return ADVICE.unknownView;
  if (result.feedbackMessage.startsWith('Для проверки коленей')) {
    return result.feedbackMessage.includes('лодыжки') ? ADVICE.missingFront : ADVICE.missingSide;
  }
  if (result.feedbackMessage.includes('Глубина недостаточна')) return ADVICE.previousShallow;
  if (result.currentPhase === SQUAT_PHASE.BOTTOM) {
    if (result.feedbackMessage.startsWith('Достигнута целевая глубина')) return ADVICE.deep;
    if (result.feedbackMessage.startsWith('Глубина близка к цели')) return ADVICE.almostDeep;
  }
  if (result.currentPhase === SQUAT_PHASE.DESCENDING) return ADVICE.descending;
  if (result.currentPhase === SQUAT_PHASE.ASCENDING) return ADVICE.ascending;
  return result.feedbackMessage.startsWith('Повтор засчитан') ? ADVICE.repDone : ADVICE.standing;
}

function renderAdvice(advice, now) {
  displayedAdvice = advice;
  adviceShownAt = now;
  const style = ADVICE_STYLES[advice.level];
  adviceBanner.dataset.level = advice.level;
  adviceIcon.textContent = style.icon;
  adviceLabel.textContent = style.label;
  feedbackOutput.textContent = adviceText(advice);
}

function updateAdvice(result, now = performance.now()) {
  const next = chooseAdvice(result);
  if (displayedAdvice?.key === next.key) return; // Не продлеваем таймер каждым кадром.

  if (displayedAdvice) {
    const currentStyle = ADVICE_STYLES[displayedAdvice.level];
    const currentPriority = displayedAdvice.priority ?? currentStyle.priority;
    const nextPriority = next.priority ?? ADVICE_STYLES[next.level].priority;
    const minDuration = currentStyle.priority > 0 ? WARNING_MIN_MS : ADVICE_MIN_MS;
    if (nextPriority <= currentPriority && now - adviceShownAt < minDuration) return;
  }
  renderAdvice(next, now);
}

function resetAdvice() {
  displayedAdvice = null;
  adviceShownAt = 0;
  adviceBanner.dataset.level = ADVICE.waiting.level;
  adviceIcon.textContent = ADVICE_STYLES.neutral.icon;
  adviceLabel.textContent = ADVICE_STYLES.neutral.label;
  feedbackOutput.textContent = currentExerciseId === 'squat'
    ? adviceText(ADVICE.waiting) : currentExercise.initialAdvice;
}

// Файловой планке передаём интервалы медиавремени, живой — performance.now().
// В паузе/на seek обрабатывается только предпросмотр с нулевым интервалом.
function holdDeltaSeconds(frame) {
  if (!frame || frame.pausedPreview) {
    lastHoldFrameTime = null;
    return 0;
  }
  const now = frame.sourceMode === 'file' ? frame.videoTime : frame.wallTimeMs / 1000;
  if (!Number.isFinite(now)) {
    lastHoldFrameTime = null;
    return 0;
  }
  const delta = lastHoldFrameTime === null ? 0 : now - lastHoldFrameTime;
  if (!Number.isFinite(delta) || delta < 0) {
    // Даже небольшой скачок назад не должен повторно начислить тот же участок.
    lastHoldFrameTime = null;
    currentAnalyzer.resetTracking();
    return 0;
  }
  lastHoldFrameTime = now;
  return delta;
}

// Передаём каждому автомату именно тот вариант времени, который он ожидает.
function updateExerciseAnalysis(landmarks, frame) {
  if (!workout.active) return null;
  currentAnalyzer.setFrameSize(canvas.width, canvas.height);
  let result;
  if (currentExercise.input === 'delta') {
    result = currentAnalyzer.update(landmarks, holdDeltaSeconds(frame));
    // Предпросмотр на паузе не подтверждает начало последующего удержания.
    if (frame?.pausedPreview) currentAnalyzer.resetTracking();
  } else if (currentExercise.input === 'timestamp') {
    result = currentAnalyzer.update(landmarks, frame?.timestampMs ?? performance.now());
  } else {
    result = currentAnalyzer.update(landmarks);
  }
  const isHold = currentExercise.mode === 'time';
  const metric = isHold ? result.activeHoldTime : result.repCount;
  const phase = isHold ? (result.isFormCorrect && !frame?.pausedPreview ? 'Удержание' : 'Пауза')
    : PHASE_LABELS[result.currentPhase] ?? PHASE_LABELS.WAITING;
  updateWorkoutHUD(metric);
  if (phaseOutput.textContent !== phase) phaseOutput.textContent = phase;
  updateAdvice(result);
  if (workout.goal !== null && metric >= workout.goal) finishWorkout('goal');
  return result;
}

// Предупреждения и ошибки отрисовываются отдельно поверх общего неонового контура.
function drawHighlightedSegments(landmarks, segments, width, height, lineWidth) {
  for (const [level, color] of [['warning', '#ffcf63'], ['danger', '#ff4954']]) {
    let hasSegments = false;
    context.beginPath();
    for (const segment of segments) {
      if (segment.level !== level) continue;
      const from = landmarks[segment.start];
      const to = landmarks[segment.end];
      if (!isVisible(from) || !isVisible(to)) continue;
      context.moveTo(from.x * width, from.y * height);
      context.lineTo(to.x * width, to.y * height);
      hasSegments = true;
    }
    if (!hasSegments) continue;
    context.lineWidth = lineWidth * 2.4;
    context.strokeStyle = 'rgba(14, 10, 10, 0.9)';
    context.stroke();
    context.lineWidth = lineWidth * 1.45;
    context.strokeStyle = color;
    context.stroke();
  }
}

// Колбэк MediaPipe вызывается синхронно; результат используется без копирования масок.
function drawPose(result, frame = null) {
  if (!workout.active) return;
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);

  const landmarks = result.landmarks?.[0];
  // Передаём и отсутствие позы, чтобы автомат не засчитал повтор через потерянные кадры.
  updateExerciseAnalysis(landmarks ?? null, frame);
  if (!workout.active || !landmarks) return;

  // X и Y нормированы по размеру кадра и могут выходить за его границы.
  const shortSide = Math.min(width, height);
  const lineWidth = Math.max(2, shortSide * 0.004);
  const radius = Math.max(2.5, shortSide * 0.006);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();

  // Рисуем все кости одним контуром, пропуская ненадёжные или закрытые суставы.
  for (const { start, end } of poseConnections) {
    const from = landmarks[start];
    const to = landmarks[end];
    if (!isVisible(from) || !isVisible(to)) continue;
    context.moveTo(from.x * width, from.y * height);
    context.lineTo(to.x * width, to.y * height);
  }
  context.strokeStyle = 'rgba(8, 20, 10, 0.8)';
  context.lineWidth = lineWidth * 1.8;
  context.stroke();
  context.strokeStyle = 'rgba(102, 255, 191, 0.82)';
  context.lineWidth = lineWidth;
  context.stroke();

  // Сегменты относятся к текущему кадру; текст ошибки удерживается отдельно.
  if (typeof currentAnalyzer.getHighlightedSegments === 'function') {
    drawHighlightedSegments(landmarks, currentAnalyzer.getHighlightedSegments(), width, height, lineWidth);
  }

  // Суставы рисуются поверх линий; тёмная обводка видна и на светлом видео.
  context.beginPath();
  for (const landmark of landmarks) {
    if (!isVisible(landmark)) continue;
    const x = landmark.x * width;
    const y = landmark.y * height;
    context.moveTo(x + radius, y);
    context.arc(x, y, radius, 0, Math.PI * 2);
  }
  context.fillStyle = '#ddffeb';
  context.fill();
  context.strokeStyle = '#153d2c';
  context.lineWidth = Math.max(1, lineWidth * 0.45);
  context.stroke();

  // Имеющиеся подписи коленей, таза и корпуса относятся только к приседаниям.
  if (currentExerciseId === 'squat') drawAngleValues(landmarks, width, height);
}

// Источник может быть камерой или локальным видео. Пока модель жива, её
// timestamps не сбрасываются при seek, Loop или переключении источника.
function hasActiveSource() {
  return workout.active && state === 'running' && (sourceMode === 'camera' ? Boolean(stream) : isActiveFile());
}

function resetPartialTracking() {
  currentAnalyzer.resetTracking();
  invalidateFrameClock();
  phaseOutput.textContent = PHASE_LABELS.WAITING;
  lastVideoTime = -1;
  context?.clearRect(0, 0, canvas.width, canvas.height);
  resetAdvice();
}

function processPoseFrame(force = false) {
  if (!hasActiveSource() || !poseLandmarker || video.seeking ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
  if (!force && video.currentTime === lastVideoTime) return;

  // Некоторые браузеры зацикливают video без заметного события seeking.
  if (sourceMode === 'file' && lastVideoTime >= 0 && video.currentTime < lastVideoTime - 0.05) {
    resetPartialTracking();
  }
  syncCanvasSize();
  lastVideoTime = video.currentTime;
  // Не используем currentTime: он уменьшается при перемотке и зацикливании.
  const wallTimeMs = performance.now();
  const timestamp = Math.max(wallTimeMs, lastInferenceTimestamp + 1);
  lastInferenceTimestamp = timestamp;

  const frameRequest = requestId;
  const frameWorkout = workout.runId;
  const frameEpoch = trackingEpoch;
  const frame = {
    timestampMs: timestamp,
    wallTimeMs,
    sourceMode,
    videoTime: video.currentTime,
    pausedPreview: sourceMode === 'file' && (video.paused || video.ended)
  };
  const ticket = { timestamp };
  pendingFrames.add(ticket);
  try {
    poseLandmarker.detectForVideo(video, timestamp, (result) => {
      // Если новый результат опередил ещё не полученный старый, промежуток
      // не подтверждён: сначала прерываем попытку или удержание.
      const skippedOlderFrame = [...pendingFrames].some((other) => other.timestamp < timestamp);
      pendingFrames.delete(ticket);
      // Запоздавшие и пришедшие не по порядку результаты нельзя использовать
      // после паузы, перемотки, нового подхода, источника или другого кадра.
      if (!workout.active || requestId !== frameRequest || workout.runId !== frameWorkout ||
          trackingEpoch !== frameEpoch || timestamp <= lastProcessedTimestamp) return;
      if (skippedOlderFrame) {
        currentAnalyzer.resetTracking();
        lastHoldFrameTime = null;
      }
      lastProcessedTimestamp = timestamp;
      drawPose(result, frame);
    });
  } catch (error) {
    pendingFrames.delete(ticket);
    // Достижение цели могло остановить источник прямо внутри синхронного колбэка.
    if (!workout.active || requestId !== frameRequest || workout.runId !== frameWorkout) return;
    console.error('Ошибка обработки позы:', error);
    stopPoseLoop();
    disposePoseLandmarker();
    setTrackingState('error', sourceMode === 'camera'
      ? 'Не удалось обработать кадр. Перезапустите камеру.'
      : 'Не удалось обработать кадр. Попробуйте выбрать файл заново или обновить страницу.');
  }
}

function shouldTrackPlayback() {
  return hasActiveSource() && trackingState === 'running' &&
    (sourceMode === 'camera' || (!video.paused && !video.ended && !video.seeking));
}

function requestPoseFrame() {
  if (animationFrameId === null && poseLandmarker && shouldTrackPlayback()) {
    animationFrameId = requestAnimationFrame(renderLoop);
  }
}

function renderLoop() {
  animationFrameId = null;
  if (!shouldTrackPlayback()) return;
  processPoseFrame();
  requestPoseFrame();
}

// На паузе RAF отсутствует; после seek рисуем максимум один кадр с debounce.
function schedulePausedPreview() {
  cancelPausedPreview();
  pausedFrameTimer = setTimeout(() => {
    pausedFrameTimer = null;
    if (isActiveFile() && video.paused && !video.seeking && trackingState === 'running') {
      processPoseFrame(true);
    }
  }, 80);
}

async function startPoseTracking(currentRequest) {
  if (!workout.active || currentRequest !== requestId) return;
  setTrackingState('loading');
  try {
    if (!context) throw new Error('Canvas 2D is unavailable');
    const landmarker = await getPoseLandmarker();
    if (!landmarker || !hasActiveSource() || currentRequest !== requestId) return;
    setTrackingState('running');
    lastVideoTime = -1;

    if (sourceMode === 'file') {
      // Сначала анализируем загруженный кадр, затем запускаем видео. Даже при
      // задержке первого RAF или запрете autoplay исходная поза не потеряется.
      processPoseFrame(true);
      if (currentRequest !== requestId || !isActiveFile() || trackingState !== 'running') return;
      try {
        await video.play();
      } catch (error) {
        if (currentRequest === requestId && isActiveFile() && error.name !== 'AbortError') {
          statusText.textContent = 'Нажмите Play';
        }
      }
    } else {
      requestPoseFrame();
    }
  } catch (error) {
    if (currentRequest !== requestId || !hasActiveSource()) return;
    console.error('Не удалось загрузить MediaPipe Pose:', error);
    setTrackingState('error', 'Не удалось загрузить модель. Проверьте интернет и обновите страницу.');
  }
}

async function startCamera(mode, exact = false) {
  if (!workout.active) return { cancelled: true };
  const currentRequest = ++requestId;
  let newStream;
  setNotice();
  setState('starting');

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      const error = new Error('Media devices are unavailable');
      error.name = 'MediaDevicesUnavailable';
      throw error;
    }

    newStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: exact ? { exact: mode } : mode,
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });

    // Запрос разрешения нельзя отменить: запоздавший поток сразу освобождаем.
    if (currentRequest !== requestId) {
      stopTracks(newStream);
      return { cancelled: true };
    }

    stream = newStream;
    const track = stream.getVideoTracks()[0];
    if (!track) {
      const error = new Error('No video track');
      error.name = 'NotFoundError';
      throw error;
    }

    const actualFacing = track.getSettings?.().facingMode;
    if (actualFacing === 'user' || actualFacing === 'environment') {
      if (exact && actualFacing !== mode) {
        const error = new Error('Requested camera is unavailable');
        error.name = 'OverconstrainedError';
        throw error;
      }
      setFacingMode(actualFacing);
    }

    track.addEventListener('ended', () => {
      if (stream !== newStream) return;
      requestId += 1;
      releaseSource();
      setNotice();
      setState('error', 'Камера отключилась. Проверьте доступ к ней и попробуйте снова.');
    }, { once: true });

    video.autoplay = true;
    video.srcObject = stream;
    await video.play();
    if (currentRequest !== requestId) return { cancelled: true };

    syncCanvasSize();
    setState('running');
    startPoseTracking(currentRequest);
    return { ok: true };
  } catch (error) {
    if (currentRequest !== requestId) {
      if (newStream && newStream !== stream) stopTracks(newStream);
      return { cancelled: true };
    }
    releaseSource();
    setState('error', getErrorMessage(error));
    return { error };
  }
}

async function switchCamera() {
  if (sourceMode !== 'camera' || state === 'starting') return;

  const previousMode = facingMode;
  const nextMode = previousMode === 'user' ? 'environment' : 'user';
  const wasRunning = state === 'running';
  setFacingMode(nextMode);
  explicitFacingMode = true;
  setNotice();

  if (!wasRunning) {
    setState('idle');
    return;
  }

  // На многих телефонах первую камеру нужно закрыть до открытия второй.
  releaseSource();
  const result = await startCamera(nextMode, true);
  if (!result.error) return;

  const canRestore = ['NotFoundError', 'OverconstrainedError', 'NotReadableError'].includes(result.error.name);
  if (!canRestore) return;

  setFacingMode(previousMode);
  explicitFacingMode = false;
  const restored = await startCamera(previousMode);
  if (restored.ok) {
    setNotice('Другая камера недоступна. Включена доступная камера.');
  }
}

// Внутри активного подхода смена источника сбрасывает фазу, но не счётчик.
function switchSource(mode, file = null) {
  if (!workout.active) return;
  if (mode === 'file') {
    if (!file) return;
    lastSource = { mode: 'file', file };
    return loadVideoFile(file);
  }
  if (mode !== 'camera' || sourceMode !== 'file') return;

  requestId += 1;
  releaseSource();
  setSourceMode('camera');
  lastSource = { mode: 'camera' };
  return startCamera(facingMode, explicitFacingMode);
}

toggleButton.addEventListener('click', () => {
  if (!workout.active) {
    openWorkoutSetup({ mode: 'camera' });
  } else if (sourceMode === 'file') {
    switchSource('camera');
  } else if (state === 'running' || state === 'starting') {
    stopCamera();
  } else {
    startCamera(facingMode, explicitFacingMode);
  }
});

uploadButton.addEventListener('click', () => videoFileInput.click());
videoFileInput.addEventListener('change', () => {
  const file = videoFileInput.files?.[0];
  // Повторный выбор того же файла тоже должен вызвать change.
  videoFileInput.value = '';
  if (!file) return;
  if (workout.active) switchSource('file', file);
  else openWorkoutSetup({ mode: 'file', file });
});

for (const button of goalOptions) {
  button.addEventListener('click', () => chooseGoal('preset', Number(button.dataset.goal)));
}
customGoal.addEventListener('focus', () => {
  if (goalMode !== 'custom') chooseGoal('custom');
});
customGoal.addEventListener('input', () => chooseGoal('custom'));
freeGoal.addEventListener('click', () => chooseGoal('free'));
workoutForm.addEventListener('submit', startWorkout);
cancelSetup.addEventListener('click', () => {
  pendingSource = null;
  closeDialog(setupDialog);
});
setupDialog.addEventListener('close', () => {
  // Событие close может прийти после повторного открытия другого диалога настройки.
  if (!isDialogOpen(setupDialog)) pendingSource = null;
});
finishButton.addEventListener('click', () => finishWorkout('manual'));
closeResults.addEventListener('click', () => closeDialog(resultsDialog));
dismissResults.addEventListener('click', () => closeDialog(resultsDialog));
newWorkout.addEventListener('click', () => {
  closeDialog(resultsDialog);
  openWorkoutSetup(lastSource);
});

videoPlay.addEventListener('click', async () => {
  if (!isActiveFile()) return;
  if (!video.paused && !video.ended) {
    video.pause();
    return;
  }
  const currentRequest = requestId;
  try {
    if (video.ended) video.currentTime = 0;
    await video.play();
  } catch (error) {
    if (currentRequest === requestId && isActiveFile() && error.name !== 'AbortError') {
      statusText.textContent = 'Ошибка Play';
    }
  }
});

videoSeek.addEventListener('input', () => {
  if (!isActiveFile() || videoSeek.disabled) return;
  const target = Math.max(0, Math.min(Number(videoSeek.value), video.duration));
  if (!Number.isFinite(target)) return;
  isScrubbing = true;
  videoCurrentTime.textContent = formatVideoTime(target);
  videoSeek.setAttribute('aria-valuetext',
    `${formatVideoTime(target)} из ${formatVideoTime(video.duration)}`);
  try {
    video.currentTime = target;
  } catch {
    isScrubbing = false;
    updateVideoControls();
    statusText.textContent = 'Нет перемотки';
  }
});

function finishScrubbing() {
  isScrubbing = false;
  if (isActiveFile()) updateVideoControls();
}
videoSeek.addEventListener('change', finishScrubbing);
videoSeek.addEventListener('blur', finishScrubbing);

videoLoop.addEventListener('click', () => {
  if (!isActiveFile()) return;
  video.loop = !video.loop;
  updateVideoControls();
});

// События самого video также покрывают окончание ролика и системную паузу.
video.addEventListener('play', () => {
  if (!isActiveFile()) return;
  cancelPausedPreview();
  invalidateFrameClock();
  if (currentExercise.mode === 'time') currentAnalyzer.resetTracking();
  updateVideoControls();
  statusText.textContent = 'Видео готово';
  setNotice();
  requestPoseFrame();
});
video.addEventListener('pause', () => {
  if (!isActiveFile()) return;
  cancelPoseFrame();
  cancelPausedPreview();
  invalidateFrameClock();
  if (currentExercise.mode === 'time') {
    currentAnalyzer.resetTracking();
    phaseOutput.textContent = 'Пауза';
  }
  updateVideoControls();
});
video.addEventListener('seeking', () => {
  if (!isActiveFile()) return;
  cancelPoseFrame();
  cancelPausedPreview();
  // Фаза до скачка не должна завершить повтор после него; счётчик сохраняем.
  resetPartialTracking();
  updateVideoControls();
});
video.addEventListener('seeked', () => {
  if (!isActiveFile()) return;
  updateVideoControls();
  if (video.paused || video.ended) schedulePausedPreview();
  else requestPoseFrame();
});
video.addEventListener('ended', () => {
  if (!isActiveFile()) return;
  cancelPoseFrame();
  cancelPausedPreview();
  invalidateFrameClock();
  if (currentExercise.mode === 'time') {
    currentAnalyzer.resetTracking();
    phaseOutput.textContent = 'Пауза';
  }
  updateVideoControls();
});
video.addEventListener('timeupdate', () => {
  if (isActiveFile()) updateVideoControls();
});
video.addEventListener('durationchange', () => {
  if (isActiveFile()) updateVideoControls();
});
video.addEventListener('error', () => {
  if (!isActiveFile() || !video.error || (video.currentSrc && video.currentSrc !== videoFileURL)) return;
  requestId += 1;
  releaseSource();
  setState('error', 'Не удалось декодировать видео. Попробуйте другой файл.');
});

switchButton.addEventListener('click', switchCamera);
exerciseSelect.addEventListener('change', () => selectExercise(exerciseSelect.value));
squatView.addEventListener('change', () => {
  if (currentExerciseId === 'squat') currentAnalyzer.setView(squatView.value);
});
video.addEventListener('loadedmetadata', syncCanvasSize);
video.addEventListener('resize', syncCanvasSize);
window.addEventListener('resize', syncCanvasSize);
window.addEventListener('pagehide', () => {
  workout.active = false;
  workout.runId += 1; // Отменяем отложенный звук, если страница уходит в bfcache.
  setWorkoutInterface(false);
  pendingSource = null;
  lastSource = { mode: 'camera' };
  closeDialog(setupDialog);
  closeDialog(resultsDialog);
  stopCamera();
  disposePoseLandmarker();
  if (audioContext && audioContext.state !== 'closed') audioContext.close().catch(() => {});
  audioContext = null;
});

// Синхронизируем начальное состояние с упражнением по умолчанию.
configureExerciseInterface();
