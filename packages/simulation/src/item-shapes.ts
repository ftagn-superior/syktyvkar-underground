import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import {
  PhysicsShapeBox,
  PhysicsShapeCapsule,
  PhysicsShapeContainer,
  PhysicsShapeSphere,
  type PhysicsShape,
} from '@babylonjs/core/Physics/v2/physicsShape.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { itemShapeParts, type ItemShapePart, type ItemType } from '@su/contracts';

function createPart(part: ItemShapePart, scene: Scene): PhysicsShape {
  const center = new Vector3(part.center.x, part.center.y, part.center.z);
  switch (part.kind) {
    case 'box':
      return new PhysicsShapeBox(
        center,
        Quaternion.Identity(),
        new Vector3(part.size.x, part.size.y, part.size.z),
        scene,
      );
    case 'sphere':
      return new PhysicsShapeSphere(center, part.radius, scene);
    case 'capsule': {
      const halfSegment = new Vector3(0, part.height / 2 - part.radius, 0);
      return new PhysicsShapeCapsule(
        center.subtract(halfSegment),
        center.add(halfSegment),
        part.radius,
        scene,
      );
    }
  }
}

/** Babylon containers hold native child references; release our child handles as well. */
class ItemShapeContainer extends PhysicsShapeContainer {
  constructor(
    scene: Scene,
    private readonly parts: PhysicsShape[],
  ) {
    super(scene);
    for (const part of parts) this.addChild(part);
  }
  override dispose(): void {
    super.dispose();
    for (const part of this.parts) part.dispose();
  }
}

export function createItemShape(type: ItemType, scene: Scene): PhysicsShape {
  const parts = itemShapeParts(type).map((part) => {
    const shape = createPart(part, scene);
    shape.material = { friction: type.friction, restitution: type.restitution };
    return shape;
  });
  return parts.length === 1 ? parts[0] : new ItemShapeContainer(scene, parts);
}
