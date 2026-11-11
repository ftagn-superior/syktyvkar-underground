import { validateBuildingParts, type Bounds, type BuildingParts } from '@su/contracts';

export interface StaticMeshPart {
  partId: string;
  role: 'wall' | 'roof' | 'detail';
  occlusionGroup: string | null;
  color: string;
  positions: number[];
  normals: number[];
  indices: number[];
}
const invariant = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`Invalid GLB: ${message}`);
};
const align = (n: number) => Math.ceil(n / 4) * 4;
const componentBounds = (positions: number[]): Bounds => {
  const bounds: Bounds = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  for (let i = 0; i < positions.length; i += 3)
    for (const [j, axis] of ['x', 'y', 'z'].entries()) {
      const key = axis as 'x' | 'y' | 'z';
      bounds.min[key] = Math.min(bounds.min[key], positions[i + j]);
      bounds.max[key] = Math.max(bounds.max[key], positions[i + j]);
    }
  return bounds;
};

/** Deterministic glTF 2.0 writer for our generated, untextured static meshes. Imported GLBs use the same runtime loader. */
export function encodeStaticGlb(parts: StaticMeshPart[]): Uint8Array {
  const buffers: Buffer[] = [];
  const views: any[] = [];
  const accessors: any[] = [];
  const materials: any[] = [];
  const materialIds = new Map<string, number>();
  let offset = 0;
  const accessor = (values: number[], type: 'VEC3' | 'SCALAR', indices = false) => {
    const array = indices ? Uint32Array.from(values) : Float32Array.from(values);
    const bytes = Buffer.from(array.buffer);
    const view = views.length;
    views.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.length,
      target: indices ? 34963 : 34962,
    });
    buffers.push(bytes);
    offset += bytes.length;
    const result: any = {
      bufferView: view,
      componentType: indices ? 5125 : 5126,
      count: values.length / (type === 'VEC3' ? 3 : 1),
      type,
    };
    if (type === 'VEC3') {
      const b = componentBounds(values);
      result.min = Object.values(b.min);
      result.max = Object.values(b.max);
    }
    accessors.push(result);
    return accessors.length - 1;
  };
  const meshes = parts.map((part) => {
    let material = materialIds.get(part.color);
    if (material === undefined) {
      invariant(/^#[0-9a-f]{6}$/i.test(part.color), 'material color');
      material = materials.length;
      materialIds.set(part.color, material);
      // Authoring colors are sRGB hex; glTF baseColorFactor is linear RGB.
      const color = [1, 3, 5].map((i) => {
        const srgb = parseInt(part.color.slice(i, i + 2), 16) / 255;
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      });
      materials.push({
        name: part.color,
        pbrMetallicRoughness: {
          baseColorFactor: [...color, 1],
          metallicFactor: 0,
          roughnessFactor: 0.9,
        },
      });
    }
    return {
      name: part.partId,
      primitives: [
        {
          attributes: {
            POSITION: accessor(part.positions, 'VEC3'),
            NORMAL: accessor(part.normals, 'VEC3'),
          },
          indices: accessor(part.indices, 'SCALAR', true),
          material,
          mode: 4,
        },
      ],
    };
  });
  const binary = Buffer.concat(buffers);
  const json = {
    asset: { version: '2.0', generator: 'su-world-build/static-1' },
    scene: 0,
    scenes: [{ nodes: parts.map((_, index) => index) }],
    nodes: parts.map((part, index) => ({
      name: part.partId,
      mesh: index,
      extras: { su: { partId: part.partId, role: part.role, occlusionGroup: part.occlusionGroup } },
    })),
    meshes,
    materials,
    buffers: [{ byteLength: binary.length }],
    bufferViews: views,
    accessors,
  };
  const text = Buffer.from(JSON.stringify(json));
  const jsonLength = align(text.length),
    binLength = align(binary.length);
  const result = Buffer.alloc(12 + 8 + jsonLength + 8 + binLength);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonLength, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  result.fill(0x20, 20, 20 + jsonLength);
  text.copy(result, 20);
  result.writeUInt32LE(binLength, 20 + jsonLength);
  result.writeUInt32LE(0x004e4942, 24 + jsonLength);
  binary.copy(result, 28 + jsonLength);
  return result;
}

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a: number[], b: number[]): number[] {
  const result = Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) result[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  return result;
}
function matrix(node: any): number[] {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1],
    [sx, sy, sz] = node.scale ?? [1, 1, 1],
    [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * y * y - 2 * z * z) * sx,
    (2 * x * y + 2 * z * w) * sx,
    (2 * x * z - 2 * y * w) * sx,
    0,
    (2 * x * y - 2 * z * w) * sy,
    (1 - 2 * x * x - 2 * z * z) * sy,
    (2 * y * z + 2 * x * w) * sy,
    0,
    (2 * x * z + 2 * y * w) * sz,
    (2 * y * z - 2 * x * w) * sz,
    (1 - 2 * x * x - 2 * y * y) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

/** Supported import profile: self-contained static triangle meshes with float positions and semantic tags. */
export function inspectStaticGlb(
  bytes: Uint8Array,
  assetId: string,
): { parts: BuildingParts; bounds: Bounds; document: any } {
  const data = Buffer.from(bytes);
  invariant(
    data.length >= 28 &&
      data.readUInt32LE(0) === 0x46546c67 &&
      data.readUInt32LE(4) === 2 &&
      data.readUInt32LE(8) === data.length,
    'header',
  );
  const jsonLength = data.readUInt32LE(12);
  invariant(
    data.readUInt32LE(16) === 0x4e4f534a && 20 + jsonLength + 8 <= data.length,
    'JSON chunk',
  );
  const document = JSON.parse(
    data
      .subarray(20, 20 + jsonLength)
      .toString('utf8')
      .trim(),
  );
  const binaryOffset = 28 + jsonLength;
  invariant(
    data.readUInt32LE(24 + jsonLength) === 0x004e4942 &&
      binaryOffset + data.readUInt32LE(20 + jsonLength) === data.length,
    'BIN chunk',
  );
  invariant(document.asset?.version === '2.0', 'glTF version');
  invariant(
    !document.extensionsRequired?.length,
    'required extensions are not supported by this static authoring profile',
  );
  invariant(
    !document.animations?.length && !document.skins?.length,
    'animated/skinned models are outside the static building profile',
  );
  invariant(
    document.buffers?.length === 1 && document.buffers[0].uri === undefined,
    'self-contained buffer required',
  );
  invariant(
    (document.images ?? []).every(
      (image: any) => image.uri === undefined && Number.isInteger(image.bufferView),
    ),
    'images must be embedded',
  );
  const parts = validateBuildingParts({
    formatVersion: 1,
    assetId,
    parts: (document.nodes ?? []).flatMap((node: any, nodeIndex: number) =>
      node.extras?.su ? [{ ...node.extras.su, nodeIndex }] : [],
    ),
  });
  const positions: number[] = [];
  const visited = new Set<number>();
  const renderedParts = new Set<string>();
  const walk = (index: number, parent: number[], inheritedPart?: string) => {
    invariant(
      Number.isInteger(index) && document.nodes[index] && !visited.has(index),
      'node hierarchy',
    );
    visited.add(index);
    const node = document.nodes[index];
    invariant(node.weights === undefined, 'morph weights are outside the static building profile');
    const world = multiply(parent, matrix(node));
    invariant(world.length === 16 && world.every(Number.isFinite), 'finite node transform');
    const partId = node.extras?.su?.partId ?? inheritedPart;
    if (node.mesh !== undefined) {
      invariant(partId !== undefined, 'every mesh must belong to a semantic part');
      const mesh = document.meshes?.[node.mesh];
      invariant(mesh?.primitives?.length, 'mesh primitives');
      invariant(
        mesh.weights === undefined,
        'morph weights are outside the static building profile',
      );
      renderedParts.add(partId);
      for (const primitive of mesh.primitives) {
        invariant(
          primitive.targets === undefined,
          'morph targets are outside the static building profile',
        );
        invariant((primitive.mode ?? 4) === 4, 'triangle primitives required');
        const accessor = document.accessors?.[primitive.attributes?.POSITION];
        invariant(
          accessor?.type === 'VEC3' && accessor.componentType === 5126 && !accessor.sparse,
          'float VEC3 positions without sparse encoding required',
        );
        const view = document.bufferViews?.[accessor.bufferView];
        invariant(view?.buffer === 0, 'position buffer view');
        const start = binaryOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0),
          stride = view.byteStride ?? 12;
        invariant(
          start >= binaryOffset &&
            stride >= 12 &&
            accessor.count > 0 &&
            start + (accessor.count - 1) * stride + 12 <= data.length,
          'position byte range',
        );
        for (let i = 0; i < accessor.count; i++) {
          const p = start + i * stride,
            x = data.readFloatLE(p),
            y = data.readFloatLE(p + 4),
            z = data.readFloatLE(p + 8);
          positions.push(
            world[0] * x + world[4] * y + world[8] * z + world[12],
            world[1] * x + world[5] * y + world[9] * z + world[13],
            world[2] * x + world[6] * y + world[10] * z + world[14],
          );
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world, partId);
  };
  invariant(
    document.scenes?.length === 1 && (document.scene ?? 0) === 0,
    'one static scene required',
  );
  for (const root of document.scenes[0].nodes ?? []) walk(root, identity());
  invariant(positions.length > 0 && positions.every(Number.isFinite), 'finite geometry required');
  invariant(
    parts.parts.every((part) => visited.has(part.nodeIndex) && renderedParts.has(part.partId)),
    'semantic parts must own visible geometry in the scene',
  );
  return { parts, bounds: componentBounds(positions), document };
}
