import { describe, expect, it } from 'vitest';
import type { PlacementCatalog } from '@su/contracts';
import { filterPlacementModels, normalizePlacementSearch } from './placement-catalog';

const model = (
  assetId: string,
  name: string,
  category: string,
  tags: string[],
  description = '',
) => ({ assetId, metadata: { name, category, tags, description } });
const models: PlacementCatalog['models'] = [
  model('birch-small', 'Берёза', 'vegetation', ['tree', 'small']),
  model('birch-large', 'Берёза', 'vegetation', ['tree', 'large']),
  model('bench', 'Скамейка парковая', 'street-furniture', ['bench'], 'Деревянное сиденье'),
  model('fence', 'Секция забора', 'barriers', ['fence', 'short']),
];

describe('placement catalog search', () => {
  it('normalizes case, repeated spaces and ё and requires every word', () => {
    expect(normalizePlacementSearch('  БЕРЁЗА   МАЛЫЙ  ')).toBe('береза малый');
    expect(filterPlacementModels(models, '  БЕРЕЗА маленький  ').map((m) => m.assetId)).toEqual([
      'birch-small',
    ]);
    expect(filterPlacementModels(models, 'береза деревянное')).toEqual([]);
  });
  it('combines category with tags, controlled Russian synonyms, description and technical ID', () => {
    expect(filterPlacementModels(models, 'дерево', 'vegetation')).toHaveLength(2);
    expect(filterPlacementModels(models, 'деревянное сиденье')[0].assetId).toBe('bench');
    expect(filterPlacementModels(models, 'лавка', 'vegetation')).toEqual([]);
    expect(filterPlacementModels(models, 'ограда короткий')[0].assetId).toBe('fence');
    expect(filterPlacementModels(models, 'birch-large')[0].assetId).toBe('birch-large');
  });
  it('sorts Russian names, then stable asset ID for duplicate names without mutating metadata', () => {
    const original = JSON.stringify(models);
    expect(filterPlacementModels(models, '').map((m) => m.assetId)).toEqual([
      'birch-large',
      'birch-small',
      'fence',
      'bench',
    ]);
    expect(JSON.stringify(models)).toBe(original);
  });
});
