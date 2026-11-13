# /// script
# requires-python = ">=3.13"
# dependencies = ["shapely==2.2.0", "numpy==2.5.4"]
# ///
"""Simultaneously evaluate an explicitly listed set of campus/building pad clusters.

No owner is added automatically. No publication or DB changes. Writes output/ only.
"""
import importlib.util
import argparse
import json
from pathlib import Path
import numpy as np
import shapely
from shapely.geometry import Polygon, shape
from shapely.affinity import translate

ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "content/worlds/ring-block/terrain-candidate"
OUT = ROOT / "output/ring-terrain-stage4/cluster-pad-evaluation"
module = importlib.util.spec_from_file_location("pad_diagnostics", ROOT / "tools/evaluate-syktsu-terrain-pad.py")
helper = importlib.util.module_from_spec(module)
module.loader.exec_module(helper)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", default=str(CONTENT / "ring-pad-study.json"))
    parser.add_argument("--output", default=str(OUT))
    args = parser.parse_args()
    spec_file = Path(args.spec).resolve()
    output = Path(args.output).resolve()
    assert output.is_relative_to(ROOT / "output"), "Diagnostic outputs must remain under output/"
    spec = helper.load(spec_file)
    grid_file = CONTENT / spec["sourceGrid"]
    grid = helper.load(grid_file)
    rules = {r["assetId"]: r for r in helper.load(CONTENT / "model-supports.json")["rules"]}
    layout_file = ROOT / "data/map-layout.json"
    snapshot = helper.load(layout_file)
    owners = {o["entityId"]: o for o in snapshot["instances"] if o["enabled"]}
    geometries = {}
    for oid, owner in owners.items():
        if owner["assetId"] not in rules:
            continue
        assert owner["rotation"] == {"x": 0, "y": 0, "z": 0, "w": 1}
        r = rules[owner["assetId"]]
        geometries[oid] = translate(shapely.union_all([Polygon(c["outline"], c.get("holes")) for c in r["components"]]), owner["position"]["x"], owner["position"]["z"])
    court = Polygon(helper.load(CONTENT / spec["forecourtFrom"])["forecourt"]["outline"])
    pads = []
    members = set()
    for cluster in spec["clusters"]:
        assert not members.intersection(cluster["ownerIds"]), "Duplicate cluster owner"
        members.update(cluster["ownerIds"])
        parts = [geometries[oid] for oid in cluster["ownerIds"]]
        if "osm-way-1258973447" in cluster["ownerIds"]:
            parts.append(court)
        pad = shapely.union_all(parts)
        if spec.get("clusterGeometry") == "explicit-compact-convex-ground-area":
            pad = pad.convex_hull
        pads.append(pad)
    nx, nz, spacing = grid["columns"], grid["rows"], grid["spacing"]
    xx, zz = np.meshgrid(grid["origin"]["x"] + np.arange(nx)*spacing, grid["origin"]["z"] + np.arange(nz)*spacing)
    nodes = np.column_stack([xx.ravel(), zz.ravel()])
    base = np.asarray(grid["heights"])
    distances = np.array([shapely.distance(shapely.points(nodes), pad) for pad in pads])
    a = (np.arange(nz-1)[:, None]*nx + np.arange(nx-1)[None, :]).ravel()
    tri_ids = np.stack([np.stack([a, a+nx+1, a+1], axis=1), np.stack([a, a+nx, a+nx+1], axis=1)], axis=1).reshape(-1, 3)
    tri_xz = nodes[tri_ids]
    tri_geometry = shapely.polygons(tri_xz)
    contact_points = {}
    for oid, geometry in geometries.items():
        hit = shapely.intersects(tri_geometry, geometry)
        contact_points[oid] = shapely.get_coordinates(shapely.intersection(tri_geometry[hit], geometry))
    surfaces = {}
    source = helper.load(ROOT / "content/buildings/ring-block/ring-block-ground/source.json")
    for name in ["road", "footway"]:
        layer = next(l for l in source["layers"] if l["id"] == name)
        geometry = shapely.union_all([Polygon(r[0], r[1:]) for r in layer["polygons"]])
        hit = shapely.intersects(tri_geometry, geometry)
        area = np.zeros(len(tri_geometry))
        area[hit] = shapely.area(shapely.intersection(tri_geometry[hit], geometry))
        surfaces[name] = area
    masks_file = ROOT / "output/ring-terrain-stage0/object-masks.json"
    masks = helper.load(masks_file)
    assert masks["metadata"]["inputs"]["data/map-layout.json"] == helper.sha(layout_file)
    mask_geometry = np.array([shape(f["geometry"]) for f in masks["features"]], dtype=object)
    output.mkdir(parents=True, exist_ok=True)
    results = []
    for width in spec["blendWidthsMetres"]:
        t = np.clip((distances-spec["plateauMarginMetres"])/width, 0, 1)
        weights = 1-t*t*(3-2*t)
        plateau = weights == 1
        assert np.all(np.sum(plateau, axis=0) <= 1), "Conflicting plateau nodes: explicitly merge those clusters"
        q = weights / np.maximum(1-weights, 1e-15)
        levels = np.array([cluster["levelMetres"] for cluster in spec["clusters"]])
        heights = (base + np.sum(q*levels[:, None], axis=0))/(1+np.sum(q, axis=0))
        for i, level in enumerate(levels):
            heights[plateau[i]] = level
        correction_base = heights.copy()
        correction_sum = np.zeros(len(nodes))
        correction_weight = np.zeros(len(nodes))
        for correction in spec.get("gradeCorrections", []):
            geometry = geometries[correction["ownerId"]]
            d = shapely.distance(shapely.points(nodes), geometry)
            t = np.clip((d-correction["plateauMarginMetres"])/correction["blendWidthMetres"], 0, 1)
            w = 1-t*t*(3-2*t)
            target = correction["centerY"] + correction["gain"]*(correction_base-correction["centerY"])
            correction_sum += w*(target-correction_base)
            correction_weight += w
        heights += correction_sum/np.maximum(1, correction_weight)
        h = heights.reshape(nz, nx)
        xyz = np.stack([tri_xz[:, :, 0], heights[tri_ids], tri_xz[:, :, 1]], axis=2)
        cross = np.cross(xyz[:, 1]-xyz[:, 0], xyz[:, 2]-xyz[:, 0])
        slopes = np.degrees(np.arctan2(np.hypot(cross[:, 0], cross[:, 2]), cross[:, 1]))
        changed = np.any(np.abs((heights-base)[tri_ids]) > 1e-10, axis=1)
        changed_geometry = shapely.coverage_union_all(tri_geometry[changed])
        affected_features = np.flatnonzero(shapely.intersects(mask_geometry, changed_geometry))
        affected = sorted({masks["features"][i]["properties"]["entityId"] for i in affected_features})
        buildings = []
        for oid, points in contact_points.items():
            values = helper.sample(grid, h, points)
            clearance = rules[owners[oid]["assetId"]]["clearance"]
            minimum, maximum = float(values.min()), float(values.max())
            plinth = maximum-minimum+clearance
            if oid == "osm-way-1258973447":
                assert plinth <= .2, (oid, plinth)
            buildings.append({"entityId": oid, "terrainMin": minimum, "terrainMax": maximum,
                              "minimumY": maximum+clearance, "maximumVisibleFoundationHeightMetres": plinth,
                              "explicitPadMember": oid in members})
        file = output / f"blend-{width}-grid.json"
        file.write_text(json.dumps({**grid, "heights": heights.tolist()}, separators=(",", ":")) + "\n")
        result = {"blendWidthMetres": width, "gridFile": str(file.relative_to(ROOT)), "gridSha256": helper.sha(file),
                  "allTriangleSlopeDegrees": helper.stats(slopes),
                  "surfaces": {name: helper.stats(slopes, area) for name, area in surfaces.items()},
                  "heightY": helper.stats(heights), "deltaY": helper.stats(heights-base),
                  "modifiedAreaM2": float(shapely.area(changed_geometry)), "affectedObjectCount": len(affected),
                  "affectedEntityIds": affected, "buildings": buildings,
                  "exceedingThreeMetres": sorted([b for b in buildings if b["maximumVisibleFoundationHeightMetres"] > 3],
                                                 key=lambda b: -b["maximumVisibleFoundationHeightMetres"])}
        results.append(result)
        print(json.dumps({key: result[key] for key in ["blendWidthMetres", "allTriangleSlopeDegrees", "surfaces", "modifiedAreaM2", "affectedObjectCount", "exceedingThreeMetres"]}), flush=True)
    (output / "comparison.json").write_text(json.dumps({"formatVersion": 1, "status": "unapplied-explicit-cluster-comparison",
        "inputs": {str(p.relative_to(ROOT)): helper.sha(p) for p in [spec_file, grid_file, layout_file, masks_file, Path(__file__)]},
        "authoring": spec, "results": results}, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
