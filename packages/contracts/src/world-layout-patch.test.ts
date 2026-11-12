import { describe, expect, it } from 'vitest';
import {
  applyWorldLayoutPatch,
  createWorldLayoutPatch,
  validateWorldLayoutPatch,
  type WorldLayoutSnapshot,
} from './index.js';

function snapshot(): WorldLayoutSnapshot {
  return {
    formatVersion: 1,
    worldId: 'example',
    assetReleaseVersion: 'a'.repeat(64),
    seedVersion: 'b'.repeat(64),
    revision: 7,
    instances: ['first', 'second'].map((entityId) => ({
      entityId,
      assetId: 'bollard',
      instanceRevision: 3,
      enabled: true,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      sourceRef: { provider: 'manual', type: 'bollard', id: entityId },
    })),
  };
}

describe('offline layout patches', () => {
  it('diffs and previews additions, replacements, source clearing, disabling and deletions without mutating inputs', () => {
    const base = snapshot(),
      edited = structuredClone(base),
      preserved = structuredClone(base);
    edited.instances[0].position = { x: 12, y: 1, z: -5 };
    edited.instances[0].rotation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    edited.instances[0].assetId = 'other-bollard';
    edited.instances[0].enabled = false;
    delete edited.instances[0].sourceRef;
    edited.instances.pop();
    edited.instances.push({
      ...structuredClone(edited.instances[0]),
      entityId: 'third',
      instanceRevision: 1,
    });
    const patch = createWorldLayoutPatch(base, edited);
    expect(patch.operations.map((op) => op.op)).toEqual(['update', 'delete', 'add']);
    const applied = applyWorldLayoutPatch(base, patch);
    expect(applied.revision).toBe(10);
    expect(applied.instances.map((i) => i.instanceRevision)).toEqual([4, 1]);
    expect(applied.instances.map(({ instanceRevision: _r, ...i }) => i)).toEqual(
      edited.instances.map(({ instanceRevision: _r, ...i }) => i),
    );
    expect(base).toEqual(preserved);
    expect(edited.instances[0].instanceRevision).toBe(3);
  });

  it('ignores ordering and emits no operations for unchanged placements', () => {
    const base = snapshot(),
      edited = structuredClone(base);
    edited.instances.reverse();
    const patch = createWorldLayoutPatch(base, edited);
    expect(patch.operations).toEqual([]);
    expect(applyWorldLayoutPatch(base, patch)).toEqual(base);
  });

  it.each(['worldId', 'assetReleaseVersion', 'seedVersion', 'revision'] as const)(
    'rejects edits to exported %s and a patch against another base',
    (field) => {
      const base = snapshot(),
        edited = structuredClone(base);
      if (field === 'revision') edited.revision++;
      else edited[field] = field === 'worldId' ? 'other-world' : 'c'.repeat(64);
      expect(() => createWorldLayoutPatch(base, edited)).toThrow(`do not edit ${field}`);
      const patch = createWorldLayoutPatch(base, base);
      expect(() => applyWorldLayoutPatch(edited, patch)).toThrow(
        field === 'revision' ? 'stale patch' : field,
      );
    },
  );

  it('refuses forged object revisions, duplicate identities and updates of missing instances', () => {
    const base = snapshot(),
      edited = structuredClone(base);
    edited.instances[0].instanceRevision++;
    expect(() => createWorldLayoutPatch(base, edited)).toThrow('do not edit instanceRevision');
    edited.instances[0].instanceRevision--;
    edited.instances[0].position.x++;
    const patch = createWorldLayoutPatch(base, edited);
    expect(patch.operations[0].op).toBe('update');
    if (patch.operations[0].op !== 'update') throw new Error('Expected update');
    patch.operations[0].expectedRevision = 2;
    expect(() => applyWorldLayoutPatch(base, patch)).toThrow('stale instance first');
    patch.operations[0].expectedRevision = 3;
    patch.operations[0].instance.entityId = 'missing';
    expect(() => applyWorldLayoutPatch(base, patch)).toThrow('does not exist');
    patch.operations.push(patch.operations[0]);
    expect(() => validateWorldLayoutPatch(patch)).toThrow('multiple operations');
    edited.instances.push(edited.instances[0]);
    expect(() => createWorldLayoutPatch(base, edited)).toThrow('duplicate instance');
  });

  it('rejects an add over an existing identity, missing deletes, empty updates and revision overflows', () => {
    const base = snapshot(),
      patch = createWorldLayoutPatch(base, base);
    const { instanceRevision: _r, ...instance } = base.instances[0];
    patch.operations = [{ op: 'add', instance }];
    expect(() => applyWorldLayoutPatch(base, patch)).toThrow('already exists');
    patch.operations = [{ op: 'delete', entityId: 'missing', expectedRevision: 1 }];
    expect(() => applyWorldLayoutPatch(base, patch)).toThrow('does not exist');
    patch.operations = [{ op: 'update', instance, expectedRevision: 3 }];
    expect(() => applyWorldLayoutPatch(base, patch)).toThrow('makes no changes');
    instance.position = { x: 1, y: 0, z: 0 };
    base.revision = patch.baseRevision = 2147483647;
    expect(() => applyWorldLayoutPatch(base, patch)).toThrow('revision must be');
    base.revision = patch.baseRevision = 7;
    base.instances[0].instanceRevision = 2147483647;
    patch.operations = [{ op: 'update', instance, expectedRevision: 2147483647 }];
    expect(() => applyWorldLayoutPatch(base, patch)).toThrow('revision must be');
  });

  it.each([
    (s: any) => {
      s.instances[0].position.x = NaN;
    },
    (s: any) => {
      s.instances[0].rotation.w = 2;
    },
    (s: any) => {
      s.instances[0].enabled = 'false';
    },
    (s: any) => {
      s.instances[0].scale = 2;
    },
    (s: any) => {
      s.instances[0].position.xx = 0;
    },
    (s: any) => {
      s.ignoredTypo = true;
    },
  ])('rejects malformed and silently ignored candidate fields', (mutate) => {
    const base = snapshot(),
      edited = structuredClone(base);
    mutate(edited);
    expect(() => createWorldLayoutPatch(base, edited)).toThrow();
  });

  it('requires revision 1 for new instances and rejects unknown operation fields', () => {
    const base = snapshot(),
      edited = structuredClone(base);
    edited.instances.push({ ...structuredClone(edited.instances[0]), entityId: 'new' });
    expect(() => createWorldLayoutPatch(base, edited)).toThrow('must have instanceRevision 1');
    const patch = createWorldLayoutPatch(base, base);
    (patch.operations as unknown[]).push({
      op: 'delete',
      entityId: 'first',
      expectedRevision: 3,
      force: true,
    });
    expect(() => validateWorldLayoutPatch(patch)).toThrow('unknown field force');
  });
});
