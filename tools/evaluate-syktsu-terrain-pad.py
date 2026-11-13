# /// script
# requires-python = ">=3.13"
# dependencies = ["shapely==2.2.0", "numpy==2.5.4"]
# ///
"""Compare explicit Syktsu ground pads; write only diagnostic grids/reports to output/.

uv run tools/evaluate-syktsu-terrain-pad.py
This does not accept a candidate, change the source grid, publish a world or move owners.
"""
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Polygon, shape
from shapely.affinity import translate

ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "content/worlds/ring-block/terrain-candidate"
OUT = ROOT / "output/ring-terrain-stage4/pad-evaluation"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text())


def stats(values, weights=None):
    a = np.asarray(values)
    if weights is not None:
        valid = np.asarray(weights) > 1e-8
        a, weights = a[valid], np.asarray(weights)[valid]
        order = np.argsort(a)
        p95 = np.interp(.95 * np.sum(weights), np.cumsum(weights[order]), a[order])
    else:
        p95 = np.percentile(a, 95)
    return {"min": float(a.min()), "p95": float(p95), "max": float(a.max())}


def sample(grid, heights, points):
    p = np.asarray(points)
    u, v = (p[:, 0] - grid["origin"]["x"]) / grid["spacing"], (p[:, 1] - grid["origin"]["z"]) / grid["spacing"]
    assert np.all((u >= 0) & (v >= 0) & (u <= grid["columns"]-1) & (v <= grid["rows"]-1))
    col, row = np.minimum(grid["columns"]-2, np.floor(u).astype(int)), np.minimum(grid["rows"]-2, np.floor(v).astype(int))
    x, z = u-col, v-row
    a, b = heights[row, col], heights[row, col+1]
    c, d = heights[row+1, col+1], heights[row+1, col]
    return np.where(z <= x, a + x*(b-a) + z*(c-b), a + z*(d-a) + x*(c-d))


def support_range(grid, heights, support, tri_geometries, triangle_ids, tri_points):
    intersect = shapely.intersects(tri_geometries, support)
    clipped = shapely.intersection(tri_geometries[intersect], support)
    points = shapely.get_coordinates(clipped)
    values = sample(grid, heights, points)
    return {"min": float(values.min()), "max": float(values.max()), "sampleVertices": len(values)}


def main():
    assert shapely.__version__ == "2.2.0"
    assert np.__version__ == "2.5.4"
    spec_path = CONTENT / "syktsu-pad-study.json"
    spec = load(spec_path)
    assert spec["status"] == "unapplied-comparison-input"
    grid_path = CONTENT / spec["sourceGrid"]
    grid = load(grid_path)
    companion_path = ROOT / spec["sourceRule"]
    rule = load(companion_path)["rule"]
    layout_path = ROOT / "data/map-layout.json"
    layout = load(layout_path)
    owner = next(item for item in layout["instances"] if item["entityId"] == spec["ownerId"])
    assert owner["enabled"] and owner["assetId"] == rule["assetId"]
    assert owner["position"]["x"] == spec["sourcePlacement"]["x"]
    assert owner["position"]["z"] == spec["sourcePlacement"]["z"]
    assert owner["rotation"] == {"x": 0, "y": 0, "z": 0, "w": 1}
    ox, oz = owner["position"]["x"], owner["position"]["z"]
    support = translate(shapely.union_all([Polygon(c["outline"], c.get("holes")) for c in rule["components"]]), ox, oz)
    court = Polygon(spec["pedestrianForecourt"]["outline"])
    pad = shapely.union_all([support, court])
    assert pad.is_valid and court.is_valid
    margin = spec["plateauMarginMetres"]
    assert margin >= math.sqrt(2) * grid["spacing"]
    nx, nz, spacing = grid["columns"], grid["rows"], grid["spacing"]
    xx, zz = np.meshgrid(grid["origin"]["x"] + np.arange(nx)*spacing, grid["origin"]["z"] + np.arange(nz)*spacing)
    nodes = np.column_stack([xx.ravel(), zz.ravel()])
    base = np.asarray(grid["heights"]).reshape(nz, nx)
    distance = shapely.distance(shapely.points(nodes), pad).reshape(nz, nx)
    a = (np.arange(nz-1)[:, None]*nx + np.arange(nx-1)[None, :]).ravel()
    triangle_ids = np.stack([np.stack([a, a+nx+1, a+1], axis=1), np.stack([a, a+nx, a+nx+1], axis=1)], axis=1).reshape(-1, 3)
    triangle_points = nodes[triangle_ids]
    triangle_geometries = shapely.polygons(triangle_points)
    def slopes(h):
        xyz = np.stack([triangle_points[:, :, 0], h.ravel()[triangle_ids], triangle_points[:, :, 1]], axis=2)
        cross = np.cross(xyz[:, 1]-xyz[:, 0], xyz[:, 2]-xyz[:, 0])
        return np.degrees(np.arctan2(np.hypot(cross[:, 0], cross[:, 2]), cross[:, 1]))
    ground_path = ROOT / "content/buildings/ring-block/ring-block-ground/source.json"
    ground = load(ground_path)
    surfaces = {}
    for name in ["road", "footway", "service", "green"]:
        layer = next(layer for layer in ground["layers"] if layer["id"] == name)
        polygons = [Polygon(rings[0], rings[1:]) for rings in layer["polygons"]]
        # One known self-crossing green polygon is unrelated to this pad. A zero buffer
        # here only cleans the DIAGNOSTIC area mask; no output terrain or covering changes.
        polygons = [p if p.is_valid else p.buffer(0) for p in polygons]
        polygon = shapely.union_all(polygons)
        selected = shapely.intersects(triangle_geometries, polygon)
        areas = np.zeros(len(triangle_geometries))
        areas[selected] = shapely.area(shapely.intersection(triangle_geometries[selected], polygon))
        surfaces[name] = areas
    masks_path = ROOT / "output/ring-terrain-stage0/object-masks.json"
    masks = load(masks_path)
    assert masks["metadata"]["inputs"]["data/map-layout.json"] == sha(layout_path)
    mask_shapes = np.array([shape(feature["geometry"]) for feature in masks["features"]], dtype=object)
    model_catalog = load(CONTENT / "model-classification.json")
    model_policy = {model["assetId"]: model["policy"]["kind"] for model in model_catalog["models"]}
    approach = rule["approaches"][0]
    near = np.asarray(approach["edge"]) + [ox, oz]
    far = near + np.asarray(approach["outward"])*approach["length"]
    route = np.array([[0, 0], [-33, -75], [-68, -130], np.mean(far, axis=0)])
    route_points = np.vstack([np.linspace(start, end, int(np.linalg.norm(end-start)/.25)+2)[:-1]
                              for start, end in zip(route, route[1:])] + [route[-1:]])
    OUT.mkdir(parents=True, exist_ok=True)
    summary = []
    base_slopes = slopes(base)
    base_support = support_range(grid, base, support, triangle_geometries, triangle_ids, triangle_points)
    for width in spec["blendWidthsMetres"]:
        t = np.clip((distance-margin)/width, 0, 1)
        weight = 1-t*t*(3-2*t)
        changed_triangles = np.any(weight.ravel()[triangle_ids] > 0, axis=1)
        changed_geometry = shapely.coverage_union_all(triangle_geometries[changed_triangles])
        affected_features = np.flatnonzero(shapely.intersects(mask_shapes, changed_geometry))
        affected = {masks["features"][i]["properties"]["entityId"]: masks["features"][i]["properties"]["assetId"] for i in affected_features}
        for level in spec["levelsMetres"]:
            h = base + (level-base)*weight
            gradient = slopes(h)
            delta = h-base
            support_stats = support_range(grid, h, support, triangle_geometries, triangle_ids, triangle_points)
            maximum_foundation = support_stats["max"] + rule["clearance"] - support_stats["min"]
            assert maximum_foundation <= .081, "Pad failed to flatten the complete support footprint"
            route_y = sample(grid, h, route_points)
            route_slopes = np.degrees(np.arctan2(np.abs(np.diff(route_y)), np.linalg.norm(np.diff(route_points, axis=0), axis=1)))
            far_y = sample(grid, h, far)
            owner_y = support_stats["max"] + rule["clearance"] - rule["jointY"]
            approach_slope = np.degrees(np.arctan2(np.abs(owner_y+approach["targetY"]-far_y), approach["length"]))
            name = f"level-{level}-blend-{width}"
            output_grid = {**grid, "heights": h.ravel().tolist()}
            file = OUT / f"{name}-grid.json"
            file.write_text(json.dumps(output_grid, separators=(",", ":"), allow_nan=False) + "\n")
            result = {
                "id": name, "levelMetres": level, "blendWidthMetres": width,
                "gridFile": str(file.relative_to(ROOT)), "gridSha256": sha(file),
                "heightY": stats(h.ravel()), "allTriangleSlopeDegrees": stats(gradient),
                "modifiedRegionSlopeDegrees": stats(gradient[changed_triangles]),
                "surfaces": {key: {"wholeSurfaceSlopeDegreesAreaWeighted": stats(gradient, areas),
                                   "modifiedAreaM2": float(np.sum(areas[changed_triangles])),
                                   "modifiedSurfaceSlopeDegreesAreaWeighted": stats(gradient[changed_triangles], areas[changed_triangles])}
                             for key, areas in surfaces.items()},
                "groundChangeY": stats(delta[weight > 0]),
                "modifiedAreaM2": float(shapely.area(changed_geometry)),
                "affectedObjects": {"count": len(affected), "byPolicy": dict(Counter(model_policy[aid] for aid in affected.values())),
                                    "entityIds": sorted(affected)},
                "support": {**support_stats, "ownerY": owner_y, "maximumVisibleFoundationHeightMetres": maximum_foundation},
                "mainApproach": {"lengthMetres": approach["length"], "farEdgeY": far_y.tolist(),
                                 "topY": owner_y+approach["targetY"], "endpointSlopeDegrees": stats(approach_slope)},
                "route": {"pointsXZ": route.tolist(), "surfaceSlopeDegreesAtQuarterMetreSamples": stats(route_slopes)},
            }
            summary.append(result)
            print(json.dumps({"id": name, "maxSlope": result["allTriangleSlopeDegrees"]["max"],
                              "roadMax": result["surfaces"]["road"]["modifiedSurfaceSlopeDegreesAreaWeighted"]["max"],
                              "footwayMax": result["surfaces"]["footway"]["modifiedSurfaceSlopeDegreesAreaWeighted"]["max"],
                              "routeMax": result["route"]["surfaceSlopeDegreesAtQuarterMetreSamples"]["max"],
                              "foundationMax": maximum_foundation, "objects": len(affected)}), flush=True)
    report = {
        "formatVersion": 1, "status": "unapplied-explicit-pad-comparison",
        "sourceGridUnchanged": True,
        "inputs": {str(path.relative_to(ROOT)): sha(path) for path in [spec_path, grid_path, companion_path, layout_path, ground_path, masks_path, Path(__file__)]},
        "versions": {"shapely": shapely.__version__, "numpy": np.__version__},
        "authoring": spec,
        "method": "Smoothstep of Euclidean distance to an explicit actual structural footprint plus main-entrance forecourt; source values retained beyond transition. Every intersecting foundation grid cell lies in the flat plateau. No new solid geometry is generated; open courtyards remain terrain.",
        "limitations": ["Approximate gameplay grade, not a surveyed campus elevation.",
                        "Road and path slopes are exact gradients of intersecting terrain triangles; p95 is weighted by horizontal intersected area.",
                        "Affected objects use whole projected generated masks, including crowns and overhangs, not only object centres; this is a conservative inventory, not support acceptance.",
                        "Route values are quarter-metre terrain samples, not capsule/gameplay acceptance.",
                        "One invalid green polygon is repaired only in diagnostic area weights; terrain and source covering polygons are not changed."],
        "baseline": {"allTriangleSlopeDegrees": stats(base_slopes), "supportRange": base_support,
                     "maxVisibleFoundationHeightMetres": base_support["max"] + rule["clearance"] - base_support["min"]},
        "variants": summary,
    }
    (OUT / "comparison.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
