/** Shared content registry. Add an entry and its client SVG to extend the collection. */
export interface ReactionDefinition {
  id: string;
  label: string;
  category: string;
  asset: string;
}

export const REACTION_DURATION_MS = 3000;
export const REACTIONS: readonly ReactionDefinition[] = [
  { id: 'hello', label: 'Привет', category: 'Общение', asset: 'hello.svg' },
  { id: 'like', label: 'Класс', category: 'Общение', asset: 'like.svg' },
  { id: 'laugh', label: 'Смешно', category: 'Эмоции', asset: 'laugh.svg' },
  { id: 'love', label: 'Любовь', category: 'Эмоции', asset: 'love.svg' },
  { id: 'question', label: 'Вопрос', category: 'Общение', asset: 'question.svg' },
];

const byId = new Map(REACTIONS.map((reaction) => [reaction.id, reaction]));
export function findReaction(id: unknown): ReactionDefinition | undefined {
  return typeof id === 'string' ? byId.get(id) : undefined;
}

export interface ReactionRequest {
  requestId: number;
  worldEpoch: string;
  reactionId: string;
}

export interface DisplayReaction {
  id: string;
  sequence: number;
  remainingMs: number;
}
