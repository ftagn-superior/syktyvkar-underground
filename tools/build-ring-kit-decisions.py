# /// script
# requires-python = ">=3.13"
# dependencies = ["shapely==2.2.0"]
# ///
"""Explicit game-content decisions for the inspected 64 rigid kit models.

Preserves source geometry, cavities and original raised parts. Never changes poses.
Run with --check to compare the complete reproducible artifact.
"""
import hashlib
import json
import math
import sys
from pathlib import Path

import shapely
from shapely.geometry import Polygon

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "content/worlds/ring-block/terrain-candidate"
CATALOG = DIRECTORY / "model-classification.json"
CANDIDATES = DIRECTORY / "kit-support-candidates.json"
OUT = DIRECTORY / "kit-support-decisions.json"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ring(points):
    values = [[round(x, 4), round(z, 4)] for x, z in list(points.coords)[:-1]]
    first = min(range(len(values)), key=lambda i: values[i])
    return values[first:] + values[:first]


def box_ring(box):
    x, _, z = box["center"]
    sx, _, sz = box["size"]
    yaw = math.radians(box.get("yaw", 0))
    c, s = math.cos(yaw), math.sin(yaw)
    return [[x + c * dx + s * dz, z - s * dx + c * dz]
            for dx, dz in [(-sx/2, -sz/2), (sx/2, -sz/2), (sx/2, sz/2), (-sx/2, sz/2)]]


def main():
    if shapely.__version__ != "2.2.0":
        raise ValueError("Expected Shapely 2.2.0")
    catalog = json.loads(CATALOG.read_text())
    candidates = json.loads(CANDIDATES.read_text())["models"]
    models = {m["assetId"]: m for m in catalog["models"]}
    if len(candidates) != 64:
        raise ValueError("The explicit kit review must be repeated for a changed catalog")
    decisions = []
    for candidate in candidates:
        asset_id = candidate["assetId"]
        model = models[asset_id]
        recipe_path = ROOT / model["source"]["recipeFile"]
        if sha(recipe_path) != model["source"]["recipeSha256"]:
            raise ValueError(f"Source changed: {asset_id}")
        recipe = json.loads(recipe_path.read_text())
        rule = candidate["candidateRule"]
        polygons = [Polygon(c["outline"], c.get("holes", [])) for c in rule["components"]]
        glass = [part for part in recipe["parts"] if part["id"] == "glass"]
        treatment = "individual-grounded-feet-or-existing-plinth"
        notes = ["Keep the original model rigid and vertical, including designed clearances of raised parts.",
                 "Foundation occupies only reviewed contact regions; no bounding-box courtyard or bench infill.",
                 "Maximum visible foundation height 0.6 m; reject larger relief for individual authoring."]
        if glass:
            # The observed shelters have three glass walls whose bottoms are intentionally
            # 0.1 m above their local planting plane, plus an independent sign post.
            if len(glass) != 1 or len(glass[0]["shapes"]) != 3:
                raise ValueError(f"Unexpected shelter construction: {asset_id}")
            for shape in glass[0]["shapes"]:
                box = shape["box"]
                if abs(box["center"][1] - box["size"][1]/2 - 0.1) > 1e-9:
                    raise ValueError(f"Changed glass base plane: {asset_id}")
                polygons.append(Polygon(box_ring(box)).buffer(0.02, join_style="mitre"))
            treatment = "shelter-wall-strips-and-sign-foot"
            notes.append("Add narrow footing strips with an explicit 0.02 m rim around the three actual glass-wall footprints; keep the original 0.1 m gap above local Y=0. Do not fill the shelter interior.")
        # Independent imported wall coordinates differ by fractions of a millimetre.
        # A declared 1 mm authoring grid removes hairline steps at their joints;
        # the maximum per-vertex displacement remains below 0.71 mm.
        precision = 0.001 if glass else 0.0001
        normalized = shapely.union_all([shapely.set_precision(p, precision) for p in polygons])
        if glass:
            normalized = normalized.simplify(0.001, preserve_topology=True)
        if not normalized.is_valid or normalized.is_empty:
            raise ValueError(f"Invalid kit foundation: {asset_id}")
        components = list(normalized.geoms) if normalized.geom_type == "MultiPolygon" else [normalized]
        rule["components"] = [{"outline": ring(p.exterior),
                              **({"holes": [ring(h) for h in p.interiors]} if p.interiors else {})}
                             for p in sorted(components, key=lambda p: (p.bounds, p.area))]
        decisions.append({"assetId": asset_id, "sourceRecipeSha256": sha(recipe_path),
                          "authoringPrecisionMetres": precision,
                          "treatment": treatment, "maximumVisibleHeight": 0.6,
                          "rule": rule, "rationale": notes})
    result = {"formatVersion": 1, "status": "explicit-game-authoring-requires-world-validation",
              "generator": {"file": "tools/build-ring-kit-decisions.py", "sha256": sha(Path(__file__)),
                            "shapely": shapely.__version__, "precisionMetres": 0.0001},
              "modelClassificationSha256": sha(CATALOG), "candidateRulesSha256": sha(CANDIDATES),
              "decisions": decisions}
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if "--check" in sys.argv:
        if OUT.read_text() != encoded:
            raise ValueError("Kit decisions are stale")
    else:
        OUT.write_text(encoded)
    print(json.dumps({"decisions": len(decisions), "shelters": sum(d["treatment"].startswith("shelter") for d in decisions), "sha256": sha(OUT)}))


if __name__ == "__main__":
    main()
