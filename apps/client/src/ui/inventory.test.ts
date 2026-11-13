import { describe, expect, it } from 'vitest';
import type { InventoryView } from '@su/contracts';
import { groupInventory, inventoryTotal } from './inventory';

const item = (itemId: string, typeId: string, properties: Record<string, unknown> = {}) =>
  ({ itemId, typeId, properties }) as InventoryView['slots'][number]['items'][number];

describe('backpack grouping', () => {
  it('shows one tile per type across stacks', () => {
    const inventory = {
      slots: [
        { slotId: 's1', items: [item('a', 'crate'), item('b', 'crate')] },
        { slotId: 's2', items: [item('c', 'soap')] },
        { slotId: 's3', items: [item('d', 'crate')] },
      ],
    } as InventoryView;
    const groups = groupInventory(inventory);
    expect(groups.map((group) => [group.typeId, group.count])).toEqual([
      ['crate', 3],
      ['soap', 1],
    ]);
    expect(groups[0].item.itemId).toBe('a');
    expect(inventoryTotal(inventory)).toBe(4);
  });
  it('keeps items with different properties apart', () => {
    const inventory = {
      slots: [
        { slotId: 's1', items: [item('a', 'crate', { paint: 'red' })] },
        { slotId: 's2', items: [item('b', 'crate', { paint: 'blue' }), item('c', 'crate')] },
      ],
    } as InventoryView;
    expect(groupInventory(inventory)).toHaveLength(3);
  });
});
