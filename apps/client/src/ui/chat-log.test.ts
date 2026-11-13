import { describe, expect, it } from 'vitest';
import { CHAT_LOG_LINES, ChatHistory, type ChatSource } from './chat-log';

const said = (name: string, sequence: number, text = `реплика ${sequence}`): ChatSource => ({
  name,
  color: '#E8A33A',
  chatText: text,
  chatSequence: sequence,
});

describe('chat history', () => {
  it('logs each new chat sequence once', () => {
    const history = new ChatHistory();
    expect(history.observe([['a', said('Аня', 1)]], 'b')).toBe(true);
    expect(history.observe([['a', said('Аня', 1)]], 'b')).toBe(false);
    expect(history.observe([['a', said('Аня', 2)]], 'b')).toBe(true);
    expect(history.current.map((line) => line.text)).toEqual(['реплика 1', 'реплика 2']);
  });
  it('skips players without a bubble and marks own lines', () => {
    const history = new ChatHistory();
    history.observe(
      [
        ['a', { name: 'Аня', chatText: '', chatSequence: 3 }],
        ['b', said('Я', 1)],
      ],
      'b',
    );
    expect(history.current).toHaveLength(1);
    expect(history.current[0].own).toBe(true);
  });
  it('keeps only the last lines', () => {
    const history = new ChatHistory();
    for (let sequence = 1; sequence <= CHAT_LOG_LINES + 3; sequence++)
      history.observe([['a', said('Аня', sequence)]], undefined);
    expect(history.current).toHaveLength(CHAT_LOG_LINES);
    expect(history.current.at(-1)!.text).toBe(`реплика ${CHAT_LOG_LINES + 3}`);
  });
});
