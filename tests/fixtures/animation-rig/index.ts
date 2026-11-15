import type { AnimationDefinition } from '../../../packages/contracts/src/animations';
import type { AnimationLibrary } from '../../../apps/client/src/rendering/avatars/character-animator';
import { clip as sit } from './sit';
import { clip as lie } from './lie';
import { clip as side } from './side';
import { clip as cartwheel } from './cartwheel';

/** Technical fixtures only: these IDs are never part of the released catalog. */
export const rigDefinitions: readonly AnimationDefinition[] = [
  {
    id: 'rig-sit',
    label: 'Тест: сидение',
    category: 'Каркас',
    cooldownMs: 1000,
    mode: 'fullBody',
    rig: 'humanoid-v2',
    support: 'ground',
    seated: 'variant',
    seatedMessage: 'Отдельный вариант: расслабленная посадка в коляске с согнутыми локтями.',
    reducedMotion: 'static',
    reducedMotionLabel: 'Статичное сидение.',
  },
  ...[
    ['lie', 'лежание', 'Статичное лежание.'],
    ['side', 'лежание на боку', 'Статичное лежание на боку.'],
    ['cartwheel', 'колесо на месте', 'Уменьшенное движение: подготовка к колесу без вращения.'],
  ].map(
    ([id, label, reducedMotionLabel]) =>
      ({
        id: 'rig-' + id,
        label: 'Тест: ' + label,
        category: 'Каркас',
        cooldownMs: 1000,
        mode: 'fullBody',
        rig: 'humanoid-v2',
        support: 'ground',
        seated: 'unavailable',
        seatedMessage: 'Это движение недоступно в коляске. Выберите другой скин.',
        reducedMotion: 'static',
        reducedMotionLabel,
      }) as AnimationDefinition,
  ),
];
export const rigClips = {
  'rig-sit': sit,
  'rig-lie': lie,
  'rig-side': side,
  'rig-cartwheel': cartwheel,
};
export const rigLibrary: AnimationLibrary = {
  find: (id) => rigDefinitions.find((a) => a.id === id),
  clips: rigClips,
};
