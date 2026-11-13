# /// script
# requires-python = ">=3.13"
# dependencies = ["shapely==2.2.0", "numpy==2.5.4"]
# ///
"""Study explicit facade galleries and side descents without modifying terrain or owners.

The structures in this report are NEW entry structures, not observed model support
footprints. They require a future authored structure contract and full-city acceptance.
"""
import importlib.util
import argparse
import itertools
import json
from pathlib import Path
import numpy as np
import shapely
from shapely.geometry import Polygon, LineString, Point, MultiPoint, mapping, shape
from shapely.ops import nearest_points
from shapely.affinity import translate

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "content/worlds/ring-block/terrain-candidate"
OUT = ROOT / "output/ring-terrain-stage4/entrance-approaches"
spec = importlib.util.spec_from_file_location("pad_helpers", ROOT / "tools/evaluate-syktsu-terrain-pad.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--grid', type=Path, default=DIRECTORY / 'pilot-grid-ready.json')
    parser.add_argument('--snapshot', type=Path, default=ROOT / 'output/ring-terrain-stage4/static-preflight.json')
    parser.add_argument('--directory', type=Path, default=OUT)
    args = parser.parse_args()
    output_directory = args.directory
    paths = {
        "grid": args.grid,
        "snapshot": args.snapshot,
        "preliminary": output_directory / "preliminary-ready.json",
        "actual": output_directory / "actual-geometry-ready.json",
        "rules": DIRECTORY / "model-supports.json",
        "study": DIRECTORY / "entrance-authoring-study.json",
        "kitColliders": output_directory / "actual-kit-colliders.json",
    }
    grid = helper.load(paths["grid"])
    heights = np.array(grid["heights"]).reshape(grid["rows"], grid["columns"])
    loaded = helper.load(paths["snapshot"])
    snapshot = loaded.get('targetSnapshot', loaded)
    owners = {o["entityId"]: o for o in snapshot["instances"] if o["enabled"]}
    rules = {r["assetId"]: r for r in helper.load(paths["rules"])["rules"]}
    preliminary = helper.load(paths["preliminary"])["doors"]
    actual = helper.load(paths["actual"])["results"]
    study = helper.load(paths["study"])
    revision_keys = {(r["entityId"], r["door"]["partId"], r["door"]["index"]) for r in actual if r["status"] != "geometry-candidate-needs-final-clearance"}
    revision_keys.update((r["entityId"], r["partId"], r["index"]) for r in study["additionalProblemDoors"])
    kit_shapes, kit_meta = [], []
    for collider in helper.load(paths["kitColliders"])["colliders"]:
        vertices = np.array(collider["vertices"])
        if collider["kind"] == "box":
            projected = MultiPoint(vertices[:, [0, 2]]).convex_hull
        else:
            parts = []
            for triangle in np.array(collider["indices"]).reshape(-1, 3):
                points = vertices[triangle][:, [0, 2]]
                polygon = Polygon(points)
                parts.append(polygon if polygon.area > 1e-12 else LineString(points))
            projected = shapely.union_all(parts)
        kit_shapes.append(projected)
        kit_meta.append({"entityId": collider["entityId"], "colliderId": collider["colliderId"], "minY": float(vertices[:, 1].min()), "maxY": float(vertices[:, 1].max())})
    kit_tree = shapely.STRtree(kit_shapes)
    def kit_contacts(polygon, minimum_y, maximum_y):
        return [kit_meta[i] for i in kit_tree.query(polygon, predicate="intersects") if kit_meta[i]["maxY"] >= minimum_y+.02 and kit_meta[i]["minY"] <= maximum_y+1.8]
    footprint = {}
    for oid, owner in owners.items():
        if owner["assetId"] not in rules:
            continue
        assert owner["rotation"] == {"x": 0, "y": 0, "z": 0, "w": 1}
        footprint[oid] = translate(shapely.union_all([Polygon(c["outline"], c.get("holes")) for c in rules[owner["assetId"]]["components"]]), owner["position"]["x"], owner["position"]["z"])
    road_layer = next(l for l in helper.load(ROOT / "content/buildings/ring-block/ring-block-ground/source.json")["layers"] if l["id"] == "road")
    roads = shapely.union_all([Polygon(r[0], r[1:]) for r in road_layer["polygons"]])
    groups = {}
    for candidate in preliminary:
        key = (candidate["entityId"], candidate["door"]["partId"], candidate["door"]["index"])
        if candidate["status"] != "unresolved" and key not in revision_keys:
            continue
        edge = candidate.get("supportEdge")
        if edge is None:
            continue
        group_key = (candidate["entityId"], edge["component"], edge["ring"], edge["edgeIndex"])
        groups[group_key] = [c for c in preliminary if c["entityId"] == candidate["entityId"] and c.get("supportEdge") and all(c["supportEdge"][field] == edge[field] for field in ["component", "ring", "edgeIndex"])]
        if candidate["entityId"] in study["localProblemDoorsOnly"]:
            # The full facade gallery reaches terrain above the fixed clearance.
            # Limit this explicit intervention to its problematic door.
            groups[group_key] = [c for c in groups[group_key] if c["status"] == "unresolved" or (c["entityId"], c["door"]["partId"], c["door"]["index"]) in revision_keys]
    covered_keys = {(c['entityId'], c['door']['partId'], c['door']['index']) for group in groups.values() for c in group}
    accepted_keys = {(c['entityId'], c['door']['partId'], c['door']['index']) for c in actual if c['status'] == 'geometry-candidate-needs-final-clearance'}
    retained_approaches = []
    for candidate in preliminary:
        key = (candidate['entityId'], candidate['door']['partId'], candidate['door']['index'])
        if key not in accepted_keys or key in covered_keys:
            continue
        approach = candidate['approach']
        owner = owners[candidate['entityId']]
        near = np.array(approach['edge'])+[owner['position']['x'], owner['position']['z']]
        far = near+np.array(approach['outward'])*approach['length']
        retained_approaches.append((key, Polygon([near[0], near[1], far[1], far[0]])))

    def screening(polygon, owner_id):
        return {
            "roadOverlapM2": float(polygon.intersection(roads).area),
            "ownSupportOverlapM2": float(polygon.intersection(footprint[owner_id]).area),
            "neighbourFootprints": [{"entityId": oid, "overlapM2": float(polygon.intersection(shape).area)} for oid, shape in footprint.items() if oid != owner_id and polygon.intersection(shape).area > 1e-5],
        }

    def clear(check):
        return check["roadOverlapM2"] < .05 and check["ownSupportOverlapM2"] < 1e-5 and not check["neighbourFootprints"]

    def mesh_strip(near, direction, length, level):
        # This is an explicit proposed top mesh, not a prediction of foundation-v2.
        # 10 lanes across 2.4 m; <=0.25 m longitudinal intervals.
        along = np.linspace(0, 1, int(np.ceil(length / .25)) + 1)
        across = np.linspace(0, 1, 11)
        points = near[0] + across[:, None, None] * (near[1] - near[0]) + along[None, :, None] * direction * length
        flat = points.reshape(-1, 2)
        ground = helper.sample(grid, heights, flat).reshape(len(across), len(along))
        top = level * (1 - along)[None, :] + ground * along[None, :]
        xyz = np.stack([points[:, :, 0], top, points[:, :, 1]], axis=2)
        a, b, c, d = xyz[:-1, :-1], xyz[1:, :-1], xyz[1:, 1:], xyz[:-1, 1:]
        crosses = np.concatenate([np.cross(b-a, c-a).reshape(-1, 3), np.cross(c-a, d-a).reshape(-1, 3)])
        slope = float(np.degrees(np.arctan2(np.hypot(crosses[:, 0], crosses[:, 2]), np.abs(crosses[:, 1]))).max())
        return {"maximumProposedTopTriangleSlopeDegrees": slope, "minimumSampledGroundClearanceMetres": float((top-ground).min()), "maximumHeightAboveSampledTerrainMetres": float((top-ground).max()), "minimumTopY": float(top.min()), "topTriangles": int(len(crosses))}

    results = []
    for group_key, entrances in groups.items():
        oid, component, ring_id, edge_id = group_key
        owner = owners[oid]
        shift = np.array([owner["position"]["x"], owner["position"]["z"]])
        component_rule = rules[owner["assetId"]]["components"][component]
        ring = [component_rule["outline"], *component_rule.get("holes", [])][ring_id]
        a, b = np.array(ring[edge_id]) + shift, np.array(ring[(edge_id+1) % len(ring)]) + shift
        tangent = (b-a)/np.linalg.norm(b-a)
        normal = np.array([tangent[1], -tangent[0]])
        centres = [np.mean(c["supportEdge"]["edge"], axis=0) + shift for c in entrances]
        distances = [float(np.dot(c-a, tangent)) for c in centres]
        end_margin = study["galleryEndMarginMetres"].get(oid, 1.2)
        start, end = min(distances)-end_margin, max(distances)+end_margin
        gallery_length = end-start
        levels = [c["fixedOwnerY"] + c["door"]["localBottomY"] for c in entrances]
        assert max(levels)-min(levels) < 1e-8
        level = levels[0]
        descent_width = study.get("descentLaneWidthMetres", {}).get(oid, 2.4)
        gallery_width = study.get("galleryWidthMetres", {}).get(oid, 2.4)
        assert abs(level-owner["position"]["y"]-rules[owner["assetId"]]["jointY"]) < 1e-8
        gallery = Polygon([a+tangent*start, a+tangent*end, a+tangent*end+normal*gallery_width, a+tangent*start+normal*gallery_width])
        gallery_check = screening(gallery, oid)
        group = {"id": f"{oid}-facade-{component}-{ring_id}-{edge_id}", "entityId": oid,
                 "doors": [{"partId": c["door"]["partId"], "index": c["door"]["index"]} for c in entrances],
                 "fixedOwnerY": owner["position"]["y"], "levelY": level,
                 "galleryLengthMetres": gallery_length, "galleryWidthMetres": gallery_width,
                 "descentLaneWidthMetres": descent_width,
                 "gallery": mapping(gallery), "galleryScreening": gallery_check,
                 "trials": [], "status": "requires-alternative-authoring"}
        # A 2.4 m gallery beside the wall and a separate 2.4 m descent lane keep
        # a descending ramp from crossing the remaining doors on that facade.
        for end_name, cap_start in [("start", start), ("end", end-2.4)]:
            cap = Polygon([a+tangent*cap_start, a+tangent*(cap_start+2.4), a+tangent*(cap_start+2.4)+normal*(gallery_width+descent_width), a+tangent*cap_start+normal*(gallery_width+descent_width)])
            platform = shapely.union_all([gallery, cap])
            platform_check = screening(platform, oid)
            sample_points = []
            for distance in np.linspace(start, end, int(np.ceil(gallery_length/.25))+1):
                sample_points.extend([a+tangent*distance+normal*n for n in [0, gallery_width/2, gallery_width]])
            sample_points.extend(shapely.get_coordinates(cap))
            platform_ground = helper.sample(grid, heights, np.array(sample_points))
            for sign in [-1, 1]:
                direction = tangent * sign
                ramp_start = cap_start + (2.4 if sign > 0 else 0)
                near = np.array([a+tangent*ramp_start+normal*gallery_width, a+tangent*ramp_start+normal*(gallery_width+descent_width)])
                minimum_length = study["minimumSideDescentLengthMetres"].get(oid, 4)
                for length in range(minimum_length, 62, 2):
                    far = near+direction*length
                    ramp = Polygon([near[0], near[1], far[1], far[0]])
                    polygon = shapely.union_all([platform, ramp])
                    xmin, zmin, xmax, zmax = polygon.bounds
                    if xmin < grid["origin"]["x"] or zmin < grid["origin"]["z"] or xmax > grid["origin"]["x"]+(grid["columns"]-1)*grid["spacing"] or zmax > grid["origin"]["z"]+(grid["rows"]-1)*grid["spacing"]:
                        continue
                    check = screening(ramp, oid)
                    mesh = mesh_strip(near, direction, length, level)
                    contacts = kit_contacts(platform, level, level)+kit_contacts(ramp, mesh["minimumTopY"]-.02, level)
                    retained_conflicts = [{"door": key, "overlapM2": float(polygon.intersection(geometry).area)} for key, geometry in retained_approaches if polygon.intersection(geometry).area > 1e-5]
                    trial = {"end": end_name, "directionSign": sign, "lengthMetres": length,
                             **check, **mesh, "platformRoadOverlapM2": platform_check["roadOverlapM2"],
                             "platformOwnSupportOverlapM2": platform_check["ownSupportOverlapM2"],
                             "platformNeighbourFootprints": platform_check["neighbourFootprints"],
                             "platformMaximumHeightAboveSampledTerrainMetres": float(level-platform_ground.min()),
                             "platformMinimumSampledGroundClearanceMetres": float(level-platform_ground.max()),
                             "potentialKitContacts": contacts,
                             "retainedApproachConflicts": retained_conflicts,
                             "totalAreaM2": float(polygon.area)}
                    ok = clear(check) and clear(platform_check) and not contacts and not retained_conflicts and mesh["maximumProposedTopTriangleSlopeDegrees"] <= study.get('maximumSideSlopeDegrees', {}).get(oid, 8) and mesh["minimumSampledGroundClearanceMetres"] >= -1e-8 and float(level-platform_ground.max()) >= rules[owner["assetId"]]["clearance"]-1e-8
                    trial["status"] = "proposed-top-mesh-candidate" if ok else "rejected-screening"
                    if ok:
                        trial.update(platform=mapping(platform), ramp=mapping(ramp), rampNearEdge=near.tolist(), rampDirection=direction.tolist())
                    group["trials"].append(trial)
                    if ok:
                        break
        candidates = [t for t in group["trials"] if t["status"] == "proposed-top-mesh-candidate"]
        if candidates:
            group["selected"] = min(candidates, key=lambda t: t["totalAreaM2"])
            group["status"] = "unapplied-custom-structure-candidate"
        else:
            clear_trials = [t for t in group["trials"] if clear(t) and t["platformRoadOverlapM2"] < .05 and t["platformOwnSupportOverlapM2"] < 1e-5 and not t["platformNeighbourFootprints"]]
            if clear_trials:
                group["bestClearTrial"] = min(clear_trials, key=lambda t: t["maximumProposedTopTriangleSlopeDegrees"])
        group["substantialFacadeRemodelling"] = gallery_length >= 20 or (group.get("selected", {}).get("totalAreaM2", 0) >= 60) or group["status"] != "unapplied-custom-structure-candidate"
        results.append(group)

    # Explicit owner-specific corner connection: the short southern facade has
    # insufficient room for its own 8-degree descent. Join its door to the west
    # facade's landing along the real building boundary and use one shared descent.
    def connect_explicit_corner():
        corner_owner = study["cornerConnectionOwner"]
        if not all(any(r["id"] == corner_owner+suffix for r in results) for suffix in ["-facade-0-0-2", "-facade-0-0-3"]):
            return
        south = next(r for r in results if r["id"] == corner_owner+"-facade-0-0-2")
        west = next(r for r in results if r["id"] == corner_owner+"-facade-0-0-3")
        owner = owners[corner_owner]
        shift = np.array([owner["position"]["x"], owner["position"]["z"]])
        ring = np.array(rules[owner["assetId"]]["components"][0]["outline"])+shift
        south_door = next(c for c in preliminary if c["entityId"] == corner_owner and c["door"]["index"] == 0)
        west_door = next(c for c in preliminary if c["entityId"] == corner_owner and c["door"]["index"] == 1)
        south_middle = np.mean(south_door["supportEdge"]["edge"], axis=0)+shift
        west_middle = np.mean(west_door["supportEdge"]["edge"], axis=0)+shift
        south_tangent = (ring[3]-ring[2])/np.linalg.norm(ring[3]-ring[2])
        west_tangent = (ring[0]-ring[3])/np.linalg.norm(ring[0]-ring[3])
        corner_line = LineString([south_middle-south_tangent*1.2, ring[3], west_middle+west_tangent*1.2])
        corner_gallery = corner_line.buffer(-2.4, single_sided=True, join_style="mitre", cap_style="flat")
        for trial in west["trials"]:
            if trial["status"] != "proposed-top-mesh-candidate":
                continue
            platform = shapely.union_all([shape(trial["platform"]), corner_gallery])
            check = screening(platform, corner_owner)
            surface_points = shapely.get_coordinates(platform)
            platform_clearance = float(west["levelY"]-helper.sample(grid, heights, surface_points).max())
            ramp = shape(trial["ramp"])
            if clear(check) and not kit_contacts(platform, west["levelY"], west["levelY"]) and platform_clearance >= rules[owner["assetId"]]["clearance"]-1e-8 and platform.intersection(ramp).area < 1e-5:
                south.update(status="served-by-explicit-corner-gallery", servedBy=west["id"], cornerGallery=mapping(corner_gallery))
                west["selected"] = {**trial, "platform": mapping(platform), "totalAreaM2": float(platform.union(ramp).area)}
                west["doors"] = [*south["doors"], *west["doors"]]
                west["galleryLengthMetres"] = corner_line.length
                west["cornerGallery"] = mapping(corner_gallery)
                west["rationale"] = "Connect the southern and western door with an explicit 2.4 m corner gallery; share the western side descent without entering the southern road corridor."
                west["substantialFacadeRemodelling"] = True
                break
    connect_explicit_corner()

    # Coordinate the selected facades of the same owner. Added podiums are an
    # explicit union with the observed footprint, never a bounding rectangle.
    overrides = []
    for oid in sorted({r["entityId"] for r in results}):
        facades = [r for r in results if r["entityId"] == oid and r["status"] != "served-by-explicit-corner-gallery"]
        if not all("selected" in r for r in facades):
            continue
        choices = [[r["selected"]] if "cornerGallery" in r else [t for t in r["trials"] if t["status"] == "proposed-top-mesh-candidate"] for r in facades]
        coordinated = []
        for combination in itertools.product(*choices):
            platform = shapely.union_all([footprint[oid], *[shape(t["platform"]) for t in combination]])
            ramps = [shape(t["ramp"]) for t in combination]
            if any(ramp.intersection(platform).area > 1e-5 for ramp in ramps):
                continue
            if any(left.intersection(right).area > 1e-5 for i, left in enumerate(ramps) for right in ramps[i+1:]):
                continue
            coordinated.append((platform.area+sum(ramp.area for ramp in ramps), combination, platform))
        if not coordinated:
            for facade in facades:
                facade["coordinatedStatus"] = "no-compatible-approach-combination"
            continue
        _, combination, platform = min(coordinated, key=lambda c: c[0])
        owner = owners[oid]
        shift = np.array([owner["position"]["x"], owner["position"]["z"]])
        # Explicit 0.1 mm authoring precision removes float-scale touch slivers.
        # It is not a change to the shared geometry kernel or source model.
        raw_local = translate(platform, -shift[0], -shift[1])
        local = shapely.orient_polygons(shapely.set_precision(raw_local.simplify(.0001, preserve_topology=True), .0001).simplify(.0001, preserve_topology=True))
        observed_boundary = translate(footprint[oid], -shift[0], -shift[1]).boundary
        observed_vertices = shapely.get_coordinates(observed_boundary)
        def restore_observed_line(ring):
            points = []
            for point in list(ring.coords)[:-1]:
                nearest_vertex = observed_vertices[np.argmin(np.linalg.norm(observed_vertices-np.array(point), axis=1))]
                if np.linalg.norm(nearest_vertex-np.array(point)) < .0002:
                    points.append(tuple(nearest_vertex))
                    continue
                nearest = nearest_points(observed_boundary, Point(point))[0]
                points.append(tuple(nearest.coords[0]) if nearest.distance(Point(point)) < .0002 else point)
            return points
        authored_polygons = list(local.geoms) if local.geom_type == "MultiPolygon" else [local]
        local = shapely.orient_polygons(shapely.union_all([Polygon(restore_observed_line(p.exterior), [restore_observed_line(h) for h in p.interiors]) for p in authored_polygons]))
        deviation_area = float(local.symmetric_difference(raw_local).area)
        polygons = list(local.geoms) if local.geom_type == "MultiPolygon" else [local]
        components = [{"outline": list(p.exterior.coords)[:-1], "holes": [list(h.coords)[:-1] for h in p.interiors]} for p in polygons]
        approaches = []
        for facade, trial in zip(facades, combination):
            facade["selected"] = trial
            facade["coordinatedStatus"] = "compatible-with-same-owner-platforms"
            original_near = np.array(trial["rampNearEdge"])-shift
            intended_width = float(np.linalg.norm(original_near[1]-original_near[0]))
            original_middle = original_near.mean(axis=0)
            original_outward = np.array(trial["rampDirection"])
            attachments = []
            for polygon in polygons:
                for boundary in [polygon.exterior, *polygon.interiors]:
                    coordinates = np.array(boundary.coords)
                    for a, b in zip(coordinates[:-1], coordinates[1:]):
                        direction = b-a
                        length = np.linalg.norm(direction)
                        if length < intended_width-.001:
                            continue
                        tangent = direction/length
                        outward = np.array([tangent[1], -tangent[0]])
                        if np.dot(outward, original_outward) < .999999:
                            continue
                        width = min(intended_width-.001, length-.001)
                        along = np.clip(np.dot(original_middle-a, tangent), width/2, length-width/2)
                        middle = a+tangent*along
                        distance = np.linalg.norm(middle-original_middle)
                        if distance < .002:
                            attachments.append((distance, [middle-tangent*width/2, middle+tangent*width/2], outward))
            assert attachments, f"No 0.1 mm attachment for {facade['id']}"
            _, near, outward = min(attachments, key=lambda item: item[0])
            approaches.append({"id": facade["id"], "edge": np.array(near).tolist(), "outward": outward.tolist(), "length": trial["lengthMetres"], "targetY": rules[owner["assetId"]]["jointY"], "color": "#b5afa1"})
        overrides.append({"entityId": oid, "fixedOwnerY": owner["position"]["y"], "status": "unapplied-explicit-pedestrian-podium",
                          "rationale": "Observed structural support union explicit pedestrian facade galleries and turn landings. Open courtyards remain open. The owner and terrain stay fixed.",
                          "originalSupportAreaM2": footprint[oid].area, "addedPodiumAreaM2": platform.area-footprint[oid].area,
                          "authoringPrecisionMetres": .0001, "precisionSymmetricDifferenceAreaM2": deviation_area,
                          "collinearSimplificationToleranceMetres": .0001,
                          "facades": [r["id"] for r in facades], "rule": {**rules[owner["assetId"]], "ownerId": oid, "components": components, "approaches": approaches}})
    report = {"formatVersion": 1, "status": "unapplied-facade-platform-study",
              "inputs": {str(p.resolve().relative_to(ROOT)): helper.sha(p) for p in [*paths.values(), Path(__file__)]},
              "criteria": {"galleryWidthMetres": 2.4, "separateDescentLaneWidthMetres": 2.4, "maximumTopTriangleSlopeDegrees": 8, "ownerYMutation": False, "terrainMutation": False},
              "limitations": ["The support overrides intentionally add authored pedestrian podiums. They retain the observed structural footprint separately as provenance.", "The preliminary slope uses a top mesh sampled at <=0.25 m along and 0.24 m across. Actual foundation-v2 generation and fixed-owner placement checks are required.", "This report screens actual support footprints and roads and same-owner podium/approach conflicts; final city kit colliders and cross-owner proposed structures remain unchecked.", "The existing foundation-v2 contract can represent the explicit union podium and its attached rectangular side descents. Its physical cap lies at jointY; the visual cap is 2 mm lower.", "Decorative doors remain closed; no interior access is asserted."],
              "summary": {"facades": len(results), "candidateFacades": sum(r["status"] == "unapplied-custom-structure-candidate" for r in results), "cornerServedFacades": sum(r["status"] == "served-by-explicit-corner-gallery" for r in results), "unresolvedFacades": sum(r["status"] == "requires-alternative-authoring" for r in results), "substantialRemodellingFacades": sum(r["substantialFacadeRemodelling"] for r in results), "candidateOwnerOverrides": len(overrides)}, "facades": results, "ownerOverrides": overrides}
    (output_directory / "facade-platforms-ready.json").write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n")
    print(json.dumps(report["summary"]))
    for facade in results:
        chosen = facade.get("selected", facade.get("bestClearTrial", {}))
        print(facade["id"], facade["status"], "gallery", round(facade["galleryLengthMetres"], 2), "descent", chosen.get("lengthMetres"), "slope", round(chosen.get("maximumProposedTopTriangleSlopeDegrees", 0), 2))


if __name__ == "__main__":
    main()
