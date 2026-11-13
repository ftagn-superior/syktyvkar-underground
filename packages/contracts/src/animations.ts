/** Engine-independent catalog. IDs also key the client's procedural clip registry. */
export interface AnimationDefinition {
  id: string;
  label: string;
  category: string;
  cooldownMs: number;
  mode: 'upperBody' | 'fullBody';
  rig: 'humanoid-v1';
}

export const ANIMATIONS = [
  {
    id: 'wave',
    label: 'Помахать рукой',
    category: 'Общение',
    cooldownMs: 1000,
    mode: 'upperBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'clap',
    label: 'Хлопать',
    category: 'Общение',
    cooldownMs: 1000,
    mode: 'upperBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'dance',
    label: 'Танцевать',
    category: 'Развлечения',
    cooldownMs: 1000,
    mode: 'fullBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'point',
    label: 'Указать',
    category: 'Общение',
    cooldownMs: 1000,
    mode: 'upperBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'cheer',
    label: 'Радоваться',
    category: 'Эмоции',
    cooldownMs: 1000,
    mode: 'upperBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'shrug',
    label: 'Пожать плечами',
    category: 'Эмоции',
    cooldownMs: 1000,
    mode: 'upperBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'bow',
    label: 'Поклониться',
    category: 'Общение',
    cooldownMs: 1000,
    mode: 'fullBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'stretch',
    label: 'Потянуться',
    category: 'Разминка',
    cooldownMs: 1000,
    mode: 'fullBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'march',
    label: 'Маршировать',
    category: 'Разминка',
    cooldownMs: 1000,
    mode: 'fullBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'balance',
    label: 'Держать баланс',
    category: 'Разминка',
    cooldownMs: 1000,
    mode: 'fullBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'boxing',
    label: 'Боксировать',
    category: 'Разминка',
    cooldownMs: 1000,
    mode: 'fullBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'disco',
    label: 'Диско',
    category: 'Танцы',
    cooldownMs: 1000,
    mode: 'fullBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'robot',
    label: 'Робот',
    category: 'Танцы',
    cooldownMs: 1000,
    mode: 'fullBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'sway',
    label: 'Покачиваться',
    category: 'Танцы',
    cooldownMs: 1000,
    mode: 'fullBody',
    rig: 'humanoid-v1',
  },
  {
    id: 'conduct',
    label: 'Дирижировать',
    category: 'Развлечения',
    cooldownMs: 1000,
    mode: 'upperBody',
    rig: 'humanoid-v1',
  },
] as const satisfies readonly AnimationDefinition[];

export type AnimationId = (typeof ANIMATIONS)[number]['id'];
export function findAnimation(value: unknown) {
  return typeof value === 'string' ? ANIMATIONS.find((entry) => entry.id === value) : undefined;
}
export interface AnimationRequest {
  requestId: number;
  worldEpoch: string;
  animationId: AnimationId;
}
export interface AnimationPlayback {
  animationId: AnimationId | null;
  sequence: number;
  startedAtTick: number;
  /** Zero until the author's first movement; the pose keeps cycling meanwhile. */
  endsAtTick: number;
  changedAtTick: number;
}
