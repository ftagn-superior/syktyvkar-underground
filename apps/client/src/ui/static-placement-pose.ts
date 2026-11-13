import type { Bounds, ItemPose, PlacementCatalog, Vec3 } from '@su/contracts';

type GroundHit = { point: Vec3; normal: Vec3; entityId?: string };
export type PlacementSurfaceRay = (from: Vec3, to: Vec3) => GroundHit | undefined;

/** A disposable estimate over loaded collision geometry. Exact support geometry and
 * the accepted owner Y remain server decisions; no private height grid is downloaded. */
export function staticPlacementPreviewPose(
  catalog: PlacementCatalog,
  assetId: string,
  ray: { from: Vec3; to: Vec3 },
  rotation: ItemPose['rotation'],
  bounds: Bounds,
  surfaceRay: PlacementSurfaceRay,
): ItemPose | undefined {
  if (catalog.groundY !== null) {
    const dy = ray.to.y - ray.from.y;
    const t = dy === 0 ? -1 : (catalog.groundY - ray.from.y) / dy;
    if (t < 0 || t > 1) return;
    return {
      position: {
        x: ray.from.x + (ray.to.x - ray.from.x) * t,
        y: catalog.groundY,
        z: ray.from.z + (ray.to.z - ray.from.z) * t,
      },
      rotation,
    };
  }
  const policy = catalog.models.find((model) => model.assetId === assetId)?.placement;
  const groundIds = new Set(catalog.terrain?.groundEntityIds);
  if (!policy || !groundIds.size) return;
  const hit = surfaceRay(ray.from, ray.to);
  // A roof, item or unloaded ground cannot lend its height to a terrain preview.
  if (!hit?.entityId || !groundIds.has(hit.entityId) || hit.normal.y <= 1e-6) return;
  const position = { ...hit.point };
  const yaw = 2 * Math.atan2(rotation.y, rotation.w);
  const cos = Math.cos(yaw),
    sin = Math.sin(yaw);
  const height = (x: number, z: number) => {
    const point = { x: position.x + x * cos + z * sin, z: position.z - x * sin + z * cos };
    const sample = surfaceRay({ ...point, y: bounds.max.y + 1 }, { ...point, y: bounds.min.y - 1 });
    return sample?.entityId && groundIds.has(sample.entityId) && sample.normal.y > 1e-6
      ? sample.point.y
      : undefined;
  };
  if (policy.kind === 'ground-anchor') {
    const centre = height(policy.anchor.x, policy.anchor.z);
    if (centre === undefined) return;
    const samples = [centre];
    // The explicit contact square stays vertical as on the server. Nine samples
    // catch tilted contacts without pretending to reproduce exact grid extrema.
    for (const dx of [-policy.contactRadius, 0, policy.contactRadius]) {
      for (const dz of [-policy.contactRadius, 0, policy.contactRadius]) {
        if (!dx && !dz) continue;
        // Contact radius is a world-axis square around the rotated local anchor.
        const sample = height(
          policy.anchor.x + dx * cos - dz * sin,
          policy.anchor.z + dx * sin + dz * cos,
        );
        if (sample === undefined) return;
        samples.push(sample);
      }
    }
    if (Math.max(...samples) - Math.min(...samples) > policy.maximumTerrainReliefMetres + 1e-6)
      return;
    position.y =
      (policy.contactDatum === 'minimum' ? Math.min(...samples) : centre) - policy.anchor.y;
  } else {
    let minimumOwnerY = -Infinity;
    for (const sample of policy.heightSamples) {
      const groundY = height(sample.x, sample.z);
      if (groundY === undefined) return;
      minimumOwnerY = Math.max(minimumOwnerY, groundY + sample.offsetY);
    }
    if (!Number.isFinite(minimumOwnerY)) return;
    position.y = minimumOwnerY;
  }
  return { position, rotation };
}
