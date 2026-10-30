import { SquatAnalyzer } from './analyzer.js';
import { PlankAnalyzer } from './plankAnalyzer.js';
import { SidePlankAnalyzer } from './sidePlankAnalyzer.js';
import { BicepCurlAnalyzer } from './bicepCurlAnalyzer.js';
import { LungeAnalyzer } from './lungeAnalyzer.js';
import { OverheadPressAnalyzer } from './overheadPressAnalyzer.js';
import { DeadliftAnalyzer } from './deadliftAnalyzer.js';
import { JumpingJacksAnalyzer } from './jumpingJacksAnalyzer.js';
import { GluteBridgeAnalyzer } from './gluteBridgeAnalyzer.js';
import { PullUpAnalyzer } from './pullupAnalyzer.js';

const REP_GOALS = Object.freeze([5, 10, 15, 20]);
const TIME_GOALS = Object.freeze([15, 30, 45, 60]);

// Каталог объединяет фабрику и данные интерфейса; каждый вызов createAnalyzer
// создаёт независимый автомат с собственным счётчиком или временем удержания.
export const EXERCISES = Object.freeze({
  squat: Object.freeze({
    label: 'Приседания', mode: 'reps', input: 'pose', Analyzer: SquatAnalyzer,
    goals: REP_GOALS, defaultGoal: 10,
    hint: 'Камера спереди или сбоку. Покажите тело целиком, включая стопы.',
    initialAdvice: 'Встаньте прямо, чтобы начать отсчёт.'
  }),
  plank: Object.freeze({
    label: 'Планка', mode: 'time', input: 'delta', Analyzer: PlankAnalyzer,
    goals: TIME_GOALS, defaultGoal: 30,
    hint: 'Камера сбоку, на уровне пола. Покажите тело и точки опоры.',
    initialAdvice: 'Примите положение планки и покажите тело сбоку.'
  }),
  sidePlank: Object.freeze({
    label: 'Боковая планка', mode: 'time', input: 'delta', Analyzer: SidePlankAnalyzer,
    goals: TIME_GOALS, defaultGoal: 30,
    hint: 'Камера перед вами. Покажите оба плеча, опорную руку и стопы.',
    initialAdvice: 'Примите боковую планку и покажите тело целиком.'
  }),
  bicepCurl: Object.freeze({
    label: 'Сгибания рук', mode: 'reps', input: 'pose', Analyzer: BicepCurlAnalyzer,
    goals: REP_GOALS, defaultGoal: 10,
    hint: 'Камера сбоку. Покажите плечо, локоть, кисть, таз и лицо.',
    initialAdvice: 'Покажите руку сбоку и опустите её перед началом.'
  }),
  lunge: Object.freeze({
    label: 'Выпады', mode: 'reps', input: 'pose', Analyzer: LungeAnalyzer,
    goals: REP_GOALS, defaultGoal: 10,
    hint: 'Камера сбоку. Покажите обе ноги, стопы и корпус целиком.',
    initialAdvice: 'Встаньте ровно и покажите обе ноги.'
  }),
  overheadPress: Object.freeze({
    label: 'Жим вверх', mode: 'reps', input: 'pose', Analyzer: OverheadPressAnalyzer,
    goals: REP_GOALS, defaultGoal: 10,
    hint: 'Покажите обе руки, голову и корпус; ракурс спереди или сбоку.',
    initialAdvice: 'Согните руки и расположите кисти около плеч.'
  }),
  deadlift: Object.freeze({
    label: 'Румынская тяга', mode: 'reps', input: 'pose', Analyzer: DeadliftAnalyzer,
    goals: REP_GOALS, defaultGoal: 10,
    hint: 'Камера строго сбоку. Покажите лицо, ухо, корпус и ноги.',
    initialAdvice: 'Встаньте сбоку к камере и примите исходное положение.'
  }),
  jumpingJacks: Object.freeze({
    label: 'Jumping jacks', mode: 'reps', input: 'timestamp', Analyzer: JumpingJacksAnalyzer,
    goals: REP_GOALS, defaultGoal: 10,
    hint: 'Камера спереди. Покажите тело целиком и хотя бы один глаз.',
    initialAdvice: 'Встаньте прямо: ноги вместе, руки вдоль тела.'
  }),
  gluteBridge: Object.freeze({
    label: 'Ягодичный мостик', mode: 'reps', input: 'pose', Analyzer: GluteBridgeAnalyzer,
    goals: REP_GOALS, defaultGoal: 10,
    hint: 'Камера строго сбоку на уровне пола. Покажите плечо, таз и ногу.',
    initialAdvice: 'Примите нижнее положение и покажите тело сбоку.'
  }),
  pullup: Object.freeze({
    label: 'Подтягивания', mode: 'reps', input: 'timestamp', Analyzer: PullUpAnalyzer,
    goals: REP_GOALS, defaultGoal: 10,
    hint: 'Покажите обе руки и лицо. Сзади без видимого рта или носа подсчёт недоступен.',
    initialAdvice: 'Покажите обе руки и лицо, затем начните из виса.'
  })
});

export function createAnalyzer(exerciseId) {
  if (!Object.prototype.hasOwnProperty.call(EXERCISES, exerciseId)) throw new RangeError(`Неизвестное упражнение: ${exerciseId}`);
  const { Analyzer } = EXERCISES[exerciseId];
  return new Analyzer();
}
