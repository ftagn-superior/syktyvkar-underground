# /// script
# requires-python = ">=3.13"
# dependencies = ["shapely==2.2.0"]
# ///
"""Regenerate the pilot's private support INPUT, never foundations or model resources.

Run: uv run tools/build-ring-pilot-support.py [--check]
The observed model revision and ground-bearing sections are intentionally explicit.
Node/tsx evaluates the actual generator for floor planes, porches and step footprints.
The support input declares 0.1 mm coordinate precision; measured deviation must stay below 1 mm.
Shapely performs a union without buffering, arbitrary simplification or hole filling.
"""
import argparse
import hashlib
import json
import math
import subprocess
from pathlib import Path

import shapely
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient

ROOT = Path(__file__).resolve().parents[1]
ASSET_ID = "osm-way-1258973447"
MODEL = ROOT / "content/buildings/ring-block" / ASSET_ID
SOURCE_SHA256 = "a150b4178482bc236c3c8649cff5e6308ff17823d4f8143ba4041cf0caca766e"
AUTHORING_PRECISION_METRES = 0.0001
GROUNDED_SECTIONS = [
    "admissions", "spine-north", "spine-recess", "spine-middle", "tower-north",
    "entrance", "tower-south", "spine-south", "wing-north", "bump",
    "wing-middle", "wing-gym", "wing-south", "wing-south-end",
]

JS = r"""
import { inspectPilotSupportModel } from './tools/world-build/src/pilot-support.ts';
console.log(JSON.stringify(await inspectPilotSupportModel()));
"""


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ring_points(ring):
    points = [list(p) for p in list(ring.coords)[:-1]]
    first = min(range(len(points)), key=lambda i: tuple(points[i]))
    return points[first:] + points[:first]


def components(geometry):
    polygons = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
    result = []
    for polygon in polygons:
        polygon = orient(polygon, sign=1)
        item = {"outline": ring_points(polygon.exterior)}
        holes = sorted((ring_points(hole) for hole in polygon.interiors), key=lambda ring: ring[0])
        if holes:
            item["holes"] = holes
        result.append(item)
    return sorted(result, key=lambda item: item["outline"])


def approach_on_boundary(geometry, original):
    """Anchor the central 2.4 m approach to the precision-normalized outer step edge."""
    middle = [(a + b) / 2 for a, b in zip(*original["edge"])]
    polygons = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
    candidates = []
    for polygon in polygons:
        ring = list(orient(polygon, sign=1).exterior.coords)
        for a, b in zip(ring, ring[1:]):
            length = math.dist(a, b)
            if length < 2.4:
                continue
            tangent = [(b[i] - a[i]) / length for i in range(2)]
            outward = [tangent[1], -tangent[0]]
            if sum(x * y for x, y in zip(outward, original["outward"])) < 0.999:
                continue
            along = sum((middle[i] - a[i]) * tangent[i] for i in range(2))
            if not 1.2 <= along <= length - 1.2:
                continue
            projected = [a[i] + along * tangent[i] for i in range(2)]
            edge = [[projected[i] + sign * 1.2 * tangent[i] for i in range(2)] for sign in (-1, 1)]
            candidates.append((math.dist(middle, projected), {"edge": edge, "outward": outward}))
    assert candidates, "No observed outer step edge can receive the approach"
    distance, result = min(candidates, key=lambda item: item[0])
    assert distance <= 0.001, "Approach moved more than the declared authoring tolerance"
    return result, distance


def filled_footprint_deviation_bound(a, b):
    # GEOS' polygon Hausdorff uses boundaries: joining an infinitesimal seam can
    # remove a long internal boundary without moving the occupied area. Prove
    # mutual filled-set containment instead; buffers here are diagnostics only.
    def contained(radius):
        return a.difference(b.buffer(radius)).is_empty and b.difference(a.buffer(radius)).is_empty
    low, high = 0, 0.001
    assert contained(high), "Support precision changed occupied area by more than 1 mm"
    for _ in range(20):
        middle = (low + high) / 2
        if contained(middle):
            high = middle
        else:
            low = middle
    return high


def generate():
    assert shapely.__version__ == "2.2.0", "Use the pinned Shapely version"
    assert sha(MODEL / "source.json") == SOURCE_SHA256, "Pilot source changed; review the rule before regeneration"
    recipe = json.loads((MODEL / "source.json").read_text())
    section_by_id = {section["id"]: section for section in recipe["sections"]}
    assert set(section_by_id) == set(GROUNDED_SECTIONS + ["entrance-attic"])
    generated = json.loads(subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-"], input=JS,
        cwd=ROOT, text=True, capture_output=True, check=True,
    ).stdout)
    planes = {plane["id"]: plane for plane in generated["bodyPlanes"]}
    for section_id in GROUNDED_SECTIONS:
        plane = planes[section_id + "-body"]
        assert plane["minY"] == 0 and plane["bottomTriangles"] == 2
    assert abs(planes["entrance-attic-body"]["minY"] - 16.8) < 1e-12
    body_polygons = [Polygon(section_by_id[name]["outline"]) for name in GROUNDED_SECTIONS]
    assert all(polygon.is_valid and polygon.area > 0 for polygon in body_polygons)
    bodies = shapely.union_all(body_polygons)
    porch_polygons = [Polygon(triangle) for part in generated["porchFloorTriangles"] for triangle in part["triangles"]]
    assert all(polygon.is_valid and polygon.area > 0 for polygon in porch_polygons)
    exact_support = shapely.union_all([*body_polygons, *porch_polygons])
    support = shapely.union_all([shapely.set_precision(polygon, AUTHORING_PRECISION_METRES)
                                for polygon in [*body_polygons, *porch_polygons]])
    assert support.is_valid and support.geom_type in ("Polygon", "MultiPolygon")
    deviation = filled_footprint_deviation_bound(exact_support, support)
    original_outline = Polygon(recipe["outline"])
    normalized = components(support)
    approach, approach_deviation = approach_on_boundary(support, generated["approach"])
    rule = {
        "kind": "foundation-v2", "assetId": ASSET_ID, "components": normalized,
        "jointY": 0, "clearance": 0.08, "burial": 0.10, "color": "#8b8580",
        "approaches": [{"id": "main-entrance", **approach, "length": 6,
                        "targetY": 0.04, "color": "#b5afa1"}],
    }
    return {
        "formatVersion": 1,
        "source": {"assetId": ASSET_ID, "recipeFile": "source.json", "recipeSha256": SOURCE_SHA256,
                   "descriptorSha256": sha(MODEL / "asset.json")},
        "generator": {"script": "tools/build-ring-pilot-support.py", "scriptSha256": sha(Path(__file__)),
                      "shapelyVersion": shapely.__version__, "geosVersion": shapely.geos_version_string,
                      "operation": "Union of observed ground body outlines and generated porch/step bottom triangles at explicit 0.1 mm authoring precision; no buffer, arbitrary simplify or hole filling.",
                      "authoringPrecisionMetres": AUTHORING_PRECISION_METRES},
        "rule": rule,
        "evidence": {
            "modelInputSha256": generated["modelInputSha256"],
            "sectionCount": len(section_by_id), "groundedSections": GROUNDED_SECTIONS,
            "excludedElevatedSections": ["entrance-attic"], "bodyPlanes": generated["bodyPlanes"],
            "porchInputs": [{"partId": part["partId"], "bottomTriangleCount": len(part["triangles"])}
                            for part in generated["porchFloorTriangles"]],
            "groundBodyAreaM2": bodies.area, "supportAreaM2": support.area,
            "exactSupportAreaM2": exact_support.area,
            "precisionFilledFootprintHausdorffBoundMetres": deviation,
            "precisionSymmetricDifferenceM2": exact_support.symmetric_difference(support).area,
            "approachBoundaryAdjustmentMetres": approach_deviation,
            "supportComponentCount": len(normalized), "supportHoleCount": sum(len(c.get("holes", [])) for c in normalized),
            "unusedRootOutlineAreaM2": original_outline.area,
            "unusedRootOutlineSymmetricDifferenceM2": original_outline.symmetric_difference(bodies).area,
            "modelBounds": generated["modelBounds"], "entrance": generated["entrance"],
            "joint": "The 14 ground body colliders close at local Y=0. No ground-level rendered floor exists in generatePrism; existing porch and step bottom faces also lie at Y=0. The elevated attic does not receive a separate foundation.",
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify the committed companion without writing")
    args = parser.parse_args()
    value = generate()
    path = MODEL / "terrain-support.json"
    text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if args.check:
        assert path.read_text() == text, "Pilot support companion is stale; regenerate and review its geometry"
    else:
        path.write_text(text)
    print(json.dumps({"checked": args.check, "path": str(path.relative_to(ROOT)),
                      "components": value["evidence"]["supportComponentCount"],
                      "holes": value["evidence"]["supportHoleCount"],
                      "supportAreaM2": value["evidence"]["supportAreaM2"],
                      "unusedOutlineDifferenceM2": value["evidence"]["unusedRootOutlineSymmetricDifferenceM2"]}))


if __name__ == "__main__":
    main()
