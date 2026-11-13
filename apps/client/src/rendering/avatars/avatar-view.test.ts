import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import type { DisplayPlayer } from '../../presentation/display-state';
import { AVATAR_SKINS } from '@su/contracts';
import { AvatarView } from './avatar-view';

describe('avatar visual ownership', () => {
  it.each(AVATAR_SKINS.map((skin) => skin.id))(
    'fits and releases %s without affecting another avatar',
    (skinId) => {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const shadow = new ShadowGenerator(
        128,
        new DirectionalLight('sun', new Vector3(0, -1, 0), scene),
      );
      const config = { height: 1.8, radius: 0.35, speed: 4, sprintSpeed: 14, mass: 70 };
      const create = (id: string) => {
        const root = new TransformNode(id, scene);
        root.rotationQuaternion = Quaternion.Identity();
        return { root, avatar: new AvatarView(root, scene, shadow, config, skinId) };
      };
      const first = create('first');
      const second = create('second');
      const player: DisplayPlayer = {
        entityId: 'first',
        kind: 'player',
        skinId,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        velocity: { x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
        revision: 0,
        grounded: true,
        motionRevision: 0,
        motionEnabled: true,
      };
      // Seven shared body parts; the wheelchair adds its frame and the spinning wheels.
      const parts = skinId === 'bear-wheelchair' ? 9 : 7;
      try {
        const bounds = first.root.getHierarchyBoundingVectors(true);
        expect(bounds.min.y).toBeGreaterThanOrEqual(-0.901);
        expect(bounds.max.y).toBeLessThanOrEqual(0.901);
        expect(bounds.max.y - bounds.min.y).toBeGreaterThan(1.7);
        player.color = '#65d6bc';
        first.avatar.update(player, 1 / 60, true, false);
        const head = scene.getMeshByName('head-shell-first')!;
        const face = scene.getMeshByName('face-first')!;
        const arm = scene.getMeshByName('leftArm-first')!;
        const headColors = Array.from(head.getVerticesData(VertexBuffer.ColorKind)!);
        const faceColors = Array.from(face.getVerticesData(VertexBuffer.ColorKind)!);
        const armColors = Array.from(arm.getVerticesData(VertexBuffer.ColorKind)!);
        player.color = '#cb93db';
        first.avatar.update(player, 1 / 60, true, false);
        // Only the standard figure's head is clothing; skin, fur and headscarves keep their colors.
        if (skinId === 'standard')
          expect(Array.from(head.getVerticesData(VertexBuffer.ColorKind)!)).not.toEqual(headColors);
        else expect(Array.from(head.getVerticesData(VertexBuffer.ColorKind)!)).toEqual(headColors);
        expect(Array.from(face.getVerticesData(VertexBuffer.ColorKind)!)).toEqual(faceColors);
        const recolored = Array.from(arm.getVerticesData(VertexBuffer.ColorKind)!);
        expect(recolored).not.toEqual(armColors);
        // The yellow grip shares a mesh with the sleeve and must keep its own color.
        // Bare hands and paws share a mesh with the sleeve and must keep their own color.
        if (skinId !== 'standard') expect(recolored.slice(-4)).toEqual(armColors.slice(-4));
        const stablePosition = first.root.position.clone();
        player.velocity.z = 14;
        for (let step = 0; step < 60; step++) first.avatar.update(player, 1 / 60, true, false);
        expect(first.root.position.equals(stablePosition)).toBe(true);
        player.connected = false;
        first.avatar.update(player, 1 / 60, true, false);
        for (const mesh of first.root.getChildMeshes()) {
          // The ground marker is deliberately fainter than the body (MARKER_ALPHA = 0.55).
          if (mesh.name.startsWith('marker-'))
            expect(mesh.material!.alpha).toBeCloseTo(0.45 * 0.55);
          else expect(mesh.material!.alpha).toBe(0.45);
        }
        expect(shadow.getShadowMap()!.renderList).toHaveLength(parts * 2);
        first.avatar.dispose();
        first.root.dispose();
        expect(shadow.getShadowMap()!.renderList).toHaveLength(parts);
        expect(second.root.getChildMeshes()).toHaveLength(parts);
        for (const mesh of second.root.getChildMeshes()) {
          expect(mesh.isDisposed()).toBe(false);
          expect(scene.materials).toContain(mesh.material);
        }
        second.avatar.dispose();
        second.root.dispose();
        expect(scene.meshes).toHaveLength(0);
        expect(scene.transformNodes).toHaveLength(0);
        expect(shadow.getShadowMap()!.renderList).toHaveLength(0);
        expect(
          scene.materials.filter((material) => material.name !== 'default material'),
        ).toHaveLength(0);
      } finally {
        scene.dispose();
        engine.dispose();
      }
    },
  );

  it('switches skins through one animator without moving the root or retaining old graphics', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const shadow = new ShadowGenerator(
      128,
      new DirectionalLight('sun', new Vector3(0, -1, 0), scene),
    );
    const root = new TransformNode('switching', scene);
    root.rotationQuaternion = Quaternion.Identity();
    const avatar = new AvatarView(root, scene, shadow, {
      height: 1.8,
      radius: 0.35,
      speed: 4,
      sprintSpeed: 14,
      mass: 70,
    });
    const player: DisplayPlayer = {
      entityId: 'switching',
      kind: 'player',
      skinId: 'minifigure',
      revision: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      velocity: { x: 0, y: 0, z: 4 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      grounded: true,
      motionRevision: 0,
      motionEnabled: true,
      color: '#65d6bc',
      animation: {
        worldEpoch: 'epoch',
        animationId: 'wave',
        sequence: 1,
        startedAtTick: 0,
        endsAtTick: 180,
        changedAtTick: 0,
        displayTick: 60,
      },
    };
    try {
      for (let step = 0; step < 60; step++) avatar.update(player, 1 / 60, true, false);
      const nodes = scene.transformNodes.length;
      const position = root.position.clone();
      for (let swap = 0; swap < 20; swap++) {
        const before = avatar.diagnostics().phase;
        player.skinId = swap % 2 ? 'minifigure' : 'standard';
        avatar.update(player, 1 / 60, true, false);
        const state = avatar.diagnostics();
        expect(state.skinId).toBe(player.skinId);
        expect(state.animation.elapsedMs).toBe(1000);
        expect(state.animation.reason).toBe('playing');
        expect(state.movement).toBeGreaterThan(0.99);
        expect((state.phase - before + Math.PI * 2) % (Math.PI * 2)).toBeLessThan(0.5);
        expect(root.position.equals(position)).toBe(true);
        expect(scene.meshes).toHaveLength(8); // rig and the stable own-player marker
        expect(scene.transformNodes).toHaveLength(nodes);
        expect(shadow.getShadowMap()!.renderList).toHaveLength(7);
        const bounds = root.getHierarchyBoundingVectors(true);
        expect(bounds.max.y).toBeLessThan(1.2);
      }
      avatar.dispose();
      root.dispose();
      expect(scene.meshes).toHaveLength(0);
      expect(scene.transformNodes).toHaveLength(0);
      expect(shadow.getShadowMap()!.renderList).toHaveLength(0);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it('keeps the wheelchair bear seated, silent and rolling its wheels by distance', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const shadow = new ShadowGenerator(
      128,
      new DirectionalLight('sun', new Vector3(0, -1, 0), scene),
    );
    const root = new TransformNode('rolling', scene);
    root.rotationQuaternion = Quaternion.Identity();
    const config = { height: 1.8, radius: 0.35, speed: 4, sprintSpeed: 14, mass: 70 };
    const avatar = new AvatarView(root, scene, shadow, config, 'bear-wheelchair');
    const player: DisplayPlayer = {
      entityId: 'rolling',
      kind: 'player',
      skinId: 'bear-wheelchair',
      revision: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      velocity: { x: 0, y: 0, z: 4 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      grounded: true,
      motionRevision: 0,
      motionEnabled: true,
    };
    try {
      const axle = scene.getTransformNodeByName('axle-rolling')!;
      const hip = scene.getTransformNodeByName('leftHip-rolling')!;
      const body = scene.getTransformNodeByName('pose-rolling')!;
      let steps = 0;
      for (let frame = 0; frame < 120; frame++) {
        steps += avatar.update(player, 1 / 60, true, false).count;
        expect(hip.rotation.x).toBeCloseTo(0, 9);
        expect(body.position.y).toBeCloseTo(0, 9);
      }
      expect(steps).toBe(0);
      expect(avatar.diagnostics().mode).toBe('walk');
      // Two seconds at up to 4 m/s on a 0.3 m wheel: several forward turns (+x rolls toward +z).
      expect(axle.rotation.x).toBeGreaterThan(10);
      expect(axle.rotation.x).toBeLessThan(8 / 0.3 + 0.001);
      player.velocity.z = 0;
      for (let frame = 0; frame < 120; frame++) avatar.update(player, 1 / 60, true, false);
      const stopped = axle.rotation.x;
      avatar.update(player, 1 / 60, true, false);
      expect(axle.rotation.x).toBeCloseTo(stopped, 3);
      avatar.dispose();
      root.dispose();
      expect(scene.transformNodes).toHaveLength(0);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
