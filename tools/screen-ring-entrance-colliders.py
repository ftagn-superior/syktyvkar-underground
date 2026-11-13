# /// script
# requires-python = ">=3.13"
# dependencies = ["shapely==2.2.0", "numpy==2.5.4"]
# ///
"""Conservative projected access screening against actual final-pilot kit colliders.

This is a candidate filter, not a capsule walk acceptance: mesh collider height
bounds are conservative and a real collider contact may still have a walkable detour.
"""
import importlib.util
import argparse
import json
from pathlib import Path
import numpy as np
import shapely
from shapely.geometry import Polygon, MultiPoint, LineString, shape

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output/ring-terrain-stage4/entrance-approaches"
spec = importlib.util.spec_from_file_location("pad_helpers", ROOT / "tools/evaluate-syktsu-terrain-pad.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--grid', type=Path, default=ROOT / 'content/worlds/ring-block/terrain-candidate/pilot-grid-ready.json')
    parser.add_argument('--snapshot', type=Path, default=ROOT / 'output/ring-terrain-stage4/static-preflight.json')
    parser.add_argument('--directory', type=Path, default=OUT)
    args = parser.parse_args()
    directory = args.directory
    obstacles_path = directory / "actual-kit-colliders.json"
    obstacles = helper.load(obstacles_path)
    grid_path = args.grid
    grid = helper.load(grid_path)
    heights = np.array(grid["heights"]).reshape(grid["rows"], grid["columns"])
    preliminary = helper.load(directory / "preliminary-ready.json")["doors"]
    actual = helper.load(directory / "actual-geometry-ready.json")["results"]
    platforms = helper.load(directory / "facade-platforms-ready.json")
    platform_actual = helper.load(directory / "facade-platforms-actual.json")["results"]
    loaded = helper.load(args.snapshot)
    snapshot = loaded.get('targetSnapshot', loaded)
    owners = {o["entityId"]: o for o in snapshot["instances"]}
    accepted_platform_owners = {r["entityId"] for r in platform_actual if r["status"] == "actual-podium-geometry-candidate"}
    replaced_doors = {(f["entityId"], d["partId"], d["index"]) for f in platforms["facades"] if f["entityId"] in accepted_platform_owners for d in f["doors"]}
    accepted_straight = {(r["entityId"], r["door"]["partId"], r["door"]["index"]) for r in actual if r["status"] == "geometry-candidate-needs-final-clearance"}
    shapes, meta = [], []
    for collider in obstacles["colliders"]:
        vertices = np.array(collider["vertices"])
        if collider["kind"] == "box":
            projected = MultiPoint(vertices[:, [0, 2]]).convex_hull
        else:
            parts = []
            for indices in np.array(collider["indices"]).reshape(-1, 3):
                points = vertices[indices][:, [0, 2]]
                polygon = Polygon(points)
                parts.append(polygon if polygon.area > 1e-12 else LineString(points))
            projected = shapely.union_all(parts)
        if projected.is_empty:
            continue
        shapes.append(projected)
        meta.append({k: collider[k] for k in ["entityId", "assetId", "colliderId", "kind"]} | {"minimumY": float(vertices[:, 1].min()), "maximumY": float(vertices[:, 1].max())})
    tree = shapely.STRtree(shapes)
    structures = []
    xx, zz = np.meshgrid(grid["origin"]["x"]+np.arange(grid["columns"])*grid["spacing"], grid["origin"]["z"]+np.arange(grid["rows"])*grid["spacing"])
    terrain_nodes = np.column_stack([xx.ravel(), zz.ravel()])
    node_points = shapely.points(terrain_nodes)

    def add_structure(identity, oid, role, polygon, level):
        # The floor interval is deliberately conservative for descending strips.
        floor_min = level
        if role == "descent":
            # Include grid nodes as well as outline samples so an interior
            # depression cannot be missed by looking only at four corners.
            boundary = shapely.segmentize(polygon.boundary, .1)
            samples = np.vstack([shapely.get_coordinates(boundary), terrain_nodes[shapely.intersects(polygon, node_points)]])
            floor_min = min(level, float(helper.sample(grid, heights, samples).min())-.02)
        contacts = []
        for index in tree.query(polygon, predicate="intersects"):
            collider = meta[index]
            if collider["maximumY"] < floor_min+.02 or collider["minimumY"] > level+1.8:
                continue
            intersection = polygon.intersection(shapes[index])
            contacts.append({**collider, "projectedIntersectionAreaM2": float(intersection.area), "projectedIntersectionLengthMetres": float(intersection.length)})
        structures.append({"id": identity, "entityId": oid, "role": role, "areaM2": polygon.area,
                           "surfaceHeightInterval": [floor_min, level], "potentialKitContacts": contacts,
                           "status": "potential-contact-needs-route-check" if contacts else "no-contact-in-conservative-kit-screen", "_polygon": polygon})

    for candidate in preliminary:
        key = (candidate["entityId"], candidate["door"]["partId"], candidate["door"]["index"])
        if key not in accepted_straight or key in replaced_doors:
            continue
        owner = owners[candidate["entityId"]]
        a = candidate["approach"]
        near = np.array(a["edge"])+[owner["position"]["x"], owner["position"]["z"]]
        far = near+np.array(a["outward"])*a["length"]
        add_structure(candidate["entityId"]+":"+a["id"], candidate["entityId"], "descent", Polygon([near[0], near[1], far[1], far[0]]), owner["position"]["y"]+a["targetY"])
    for facade in platforms["facades"]:
        if facade["entityId"] not in accepted_platform_owners or "selected" not in facade:
            continue
        add_structure(facade["id"]+":platform", facade["entityId"], "platform", shape(facade["selected"]["platform"]), facade["levelY"])
        add_structure(facade["id"]+":descent", facade["entityId"], "descent", shape(facade["selected"]["ramp"]), facade["levelY"])
    for i, left in enumerate(structures):
        for right in structures[i+1:]:
            if left["entityId"] == right["entityId"] and left["role"] == right["role"] == "platform":
                continue
            area = left["_polygon"].intersection(right["_polygon"]).area
            if area > 1e-5:
                left.setdefault("proposedStructureConflicts", []).append({"id": right["id"], "overlapM2": area})
                right.setdefault("proposedStructureConflicts", []).append({"id": left["id"], "overlapM2": area})
    for structure in structures:
        del structure["_polygon"]
    report = {"formatVersion": 1, "status": "unapplied-conservative-final-kit-screen", "mapVersion": obstacles["mapVersion"],
              "inputs": {str(p.resolve().relative_to(ROOT)): helper.sha(p) for p in [obstacles_path, grid_path, directory/"facade-platforms-ready.json", directory/"facade-platforms-actual.json", directory/"actual-geometry-ready.json", args.snapshot, Path(__file__)]},
              "limitations": ["Projected collider shapes come from transformed actual box corners and mesh triangles, not model bounding boxes.", "Vertical collider bounds and the entire descent floor interval are conservative; listed potential contacts need exact 3D/capsule route checks.", "All 2.4 m of authored walking width are screened. A collision in this width does not prove that every possible character route is blocked.", "Actual kit supports, walking to the far edge, shared-city Havok and browser acceptance remain separate checks."],
              "summary": {"actualKitColliders": len(shapes), "proposedStructures": len(structures), "structuresWithPotentialKitContacts": sum(bool(s["potentialKitContacts"]) for s in structures), "structuresWithProposedConflicts": sum(bool(s.get("proposedStructureConflicts")) for s in structures)}, "structures": structures}
    (directory / "final-kit-screen.json").write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n")
    print(json.dumps(report["summary"]))
    for structure in structures:
        if structure["potentialKitContacts"] or structure.get("proposedStructureConflicts"):
            print(structure["id"], [(c["entityId"], c["colliderId"]) for c in structure["potentialKitContacts"]], "conflicts", structure.get("proposedStructureConflicts", []))


if __name__ == "__main__":
    main()
