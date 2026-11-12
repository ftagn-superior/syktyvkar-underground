/** Shared content registry. Add an entry and its client SVG to extend the collection. */
export interface ReactionDefinition {
  id: string;
  label: string;
  category: string;
  asset: string;
}

export const REACTION_COOLDOWN_MS = 3000;
export const REACTIONS: readonly ReactionDefinition[] = [
  { id: 'hello', label: 'Привет', category: 'Общение', asset: 'hello.svg' },
  { id: 'like', label: 'Класс', category: 'Общение', asset: 'like.svg' },
  { id: 'laugh', label: 'Смешно', category: 'Эмоции', asset: 'laugh.svg' },
  { id: 'love', label: 'Любовь', category: 'Эмоции', asset: 'love.svg' },
  { id: 'question', label: 'Вопрос', category: 'Общение', asset: 'question.svg' },
  { id: 'work', label: 'Работаю', category: 'Занятия', asset: 'work.svg' },
  { id: 'sleep', label: 'Сплюс', category: 'Занятия', asset: 'sleep.svg' },
  { id: 'eat', label: 'Кушаю', category: 'Занятия', asset: 'eat.svg' },
  { id: 'coffee', label: 'Кофе', category: 'Занятия', asset: 'coffee.svg' },
  { id: 'away', label: 'Отошёл', category: 'Статус', asset: 'away.svg' },
  { id: 'busy', label: 'Занят', category: 'Статус', asset: 'busy.svg' },
  { id: 'music', label: 'Музыка', category: 'Занятия', asset: 'music.svg' },
  { id: 'game', label: 'Играю', category: 'Занятия', asset: 'game.svg' },
  { id: 'read', label: 'Читаю', category: 'Занятия', asset: 'read.svg' },
  { id: 'think', label: 'Думаю', category: 'Эмоции', asset: 'think.svg' },
  { id: 'sad', label: 'Грущу', category: 'Эмоции', asset: 'sad.svg' },
  { id: 'angry', label: 'Злюсь', category: 'Эмоции', asset: 'angry.svg' },
  { id: 'surprise', label: 'Ого!', category: 'Эмоции', asset: 'surprise.svg' },
  { id: 'celebrate', label: 'Ура!', category: 'Эмоции', asset: 'celebrate.svg' },
  { id: 'thanks', label: 'Спасибо', category: 'Общение', asset: 'thanks.svg' },
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
  /** Infinity until the author's first movement after selecting this reaction. */
  remainingMs: number;
}
