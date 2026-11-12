import type { Vec3, WorldManifest } from '../../packages/contracts/src/index.js';
import { CellStreamer } from '../../apps/client/src/streaming/cells.js';
import { VerifiedResources } from '../../apps/client/src/streaming/resources.js';

export type AreaStep = {
  position: Vec3;
  drawRadius: number;
  preview?: boolean;
};

/** Observe production selection without loading or mutating any scene resources. */
export function selectedExtractionAreas(manifest: WorldManifest, steps: AreaStep[]) {
  const resources = new VerifiedResources(manifest, '/', {
    fetch: async () => new Response(null, { status: 503 }),
  });
  const stream = new CellStreamer(
    manifest,
    resources,
    { retainStatic: () => {}, releaseStatic: () => {} },
    { prepareCellAssets: async () => () => {}, retainStatic: () => {}, releaseStatic: () => {} },
  );
  try {
    return steps.map((step) => {
      if (step.preview) stream.setPreview(step.position, step.drawRadius);
      else {
        stream.setArea(step.position);
        stream.setVisualArea(step.position, step.drawRadius);
      }
      const selected = stream.diagnostics();
      return {
        ...step,
        critical: selected.required.sort(),
        physics: selected.physicsRequired.sort(),
        graphics: selected.graphicsRequired.sort(),
      };
    });
  } finally {
    stream.dispose();
  }
}
