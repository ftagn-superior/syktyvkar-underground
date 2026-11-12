import type { BuildingInstance, WorldCell, WorldSource } from '@su/contracts';

export const SCENE_SEED = 20261111;
export const CELL_SIZE = 125;
export const DENSE_CELL = '8_8';

export function generatePlacements(seed = SCENE_SEED) {
  let randomState = seed >>> 0;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x1_0000_0000;
  };
  const cells: WorldCell[] = [];
  let extra = 6;
  for (let z = 0; z < 16; z++)
    for (let x = 0; x < 16; x++) {
      const dense = x === 8 && z === 8;
      const count = dense ? 64 : 6 + (extra-- > 0 ? 1 : 0);
      const buildings: BuildingInstance[] = [];
      for (let slot = 0; slot < count; slot++) {
        const spacing = dense ? 14 : 36;
        const columns = dense ? 8 : 3;
        const margin = dense ? 10 : 20;
        const position = {
          x:
            -1000 +
            x * CELL_SIZE +
            margin +
            (slot % columns) * spacing +
            (dense ? 0 : random() * 4 - 2),
          y: 0,
          z:
            -1000 +
            z * CELL_SIZE +
            margin +
            Math.floor(slot / columns) * spacing +
            (dense ? 0 : random() * 4 - 2),
        };
        if (x === 6 && z === 5 && slot === 0) Object.assign(position, { x: -125, z: -312.5 });
        if (x === 5 && z === 5 && slot === 0) Object.assign(position, { x: -250, z: -250 });
        const assetId =
          x === 15 && z === 15
            ? 'house-remote-a'
            : x === 0 && z === 15
              ? 'house-remote-b'
              : slot % 2
                ? 'house-b'
                : 'house-a';
        buildings.push({
          entityId: `house-${x}-${z}-${slot}`,
          assetId,
          position,
          rotation:
            slot % 2
              ? { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
              : { x: 0, y: 0, z: 0, w: 1 },
        });
      }
      cells.push({ formatVersion: 2, statics: [], cellId: `${x}_${z}`, buildings });
    }
  return cells;
}

/** A fixed acceptance profile, independent of the runtime renderer and server. */
export function generateStreamingCells(source: WorldSource): WorldCell[] {
  if (
    source.cellSize !== CELL_SIZE ||
    source.bounds.min.x !== -1000 ||
    source.bounds.min.z !== -1000 ||
    source.bounds.max.x !== 1000 ||
    source.bounds.max.z !== 1000
  )
    throw new Error('streaming-lab generator requires the 2000m world and 125m grid');
  const seed = source.generator!.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('Invalid generator seed');
  return generatePlacements(seed).map((cell) => {
    const [x, z] = cell.cellId.split('_').map(Number);
    return {
      ...cell,
      statics: [
        {
          entityId: `ground-${cell.cellId}`,
          kind: 'obstacle',
          position: { x: -1000 + (x + 0.5) * CELL_SIZE, y: -0.5, z: -1000 + (z + 0.5) * CELL_SIZE },
          size: { x: CELL_SIZE, y: 1, z: CELL_SIZE },
          mass: 0,
          friction: 0.6,
          restitution: 0.05,
          color: '#263441',
        },
      ],
    };
  });
}
