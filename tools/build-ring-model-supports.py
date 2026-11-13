# /// script
# requires-python = ">=3.13"
# dependencies = ["shapely==2.2.0"]
# ///
"""Build explicit private support inputs from actual generated model contact geometry.

uv run tools/build-ring-model-supports.py [--check]
No publication, placement changes, database writes, bbox foundations or guessed doors.
Kit foundation candidates remain separate from accepted model support policies.
"""
import argparse
import hashlib
import importlib.util
import json
import subprocess
from collections import Counter
from pathlib import Path

import shapely
from shapely.geometry import Polygon

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "content/worlds/ring-block/terrain-candidate"
POLICIES = DIRECTORY / "model-policies.json"
PILOT = "osm-way-1258973447"
PRECISION = 0.0001
HELPER = ROOT / "tools/build-ring-pilot-support.py"
spec = importlib.util.spec_from_file_location("pilot_support_helpers", HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

JS = r"""
import { inspectRingSupportModels } from './tools/world-build/src/ring-support-authoring.ts';
console.log(JSON.stringify(await inspectRingSupportModels()));
"""


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def normalize(triangles):
    polygons = [Polygon(triangle) for triangle in triangles]
    assert polygons and all(p.is_valid and p.area > 0 for p in polygons)
    exact = shapely.union_all(polygons)
    normalized = shapely.union_all([shapely.set_precision(p, PRECISION) for p in polygons])
    assert normalized.is_valid and not normalized.is_empty
    assert normalized.geom_type in ("Polygon", "MultiPolygon")
    components = helper.components(normalized)
    return components, {
        "contactTriangleCount": len(triangles),
        "exactContactAreaM2": exact.area,
        "supportAreaM2": normalized.area,
        "precisionFilledFootprintHausdorffBoundMetres": helper.filled_footprint_deviation_bound(exact, normalized),
        "precisionSymmetricDifferenceM2": exact.symmetric_difference(normalized).area,
        "componentCount": len(components),
        "holeCount": sum(len(c.get("holes", [])) for c in components),
    }


def rule_for(asset_id, triangles, clearance):
    components, geometry = normalize(triangles)
    return {
        "kind": "foundation-v2", "assetId": asset_id, "components": components,
        "jointY": 0, "clearance": clearance, "burial": 0.1, "color": "#8b8580",
    }, geometry


def generate():
    assert shapely.__version__ == "2.2.0", "Use pinned Shapely version"
    policies = json.loads(POLICIES.read_text())
    assert policies["formatVersion"] == 1
    authored = {item["assetId"]: item for item in policies["models"]}
    assert len(authored) == len(policies["models"]), "Duplicate authoring policy"
    observed = json.loads(subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-"], input=JS,
        cwd=ROOT, text=True, capture_output=True, check=True,
    ).stdout)
    assert set(authored) == {model["assetId"] for model in observed["models"]}, "Review policy for new or removed catalog model"
    rules, models, candidates = [], [], []
    for model in observed["models"]:
        aid, source, actual = model["assetId"], model["source"], model["evidence"]
        policy = authored[aid]
        assert policy["recipeSha256"] == source["recipeSha256"], f"{aid}: recipe changed; review policy"
        evidence = {
            "modelInputSha256": actual["modelInputSha256"],
            **({"modelBounds": actual["modelBounds"]} if "modelBounds" in actual else {}),
        }
        triangles = [triangle for part in actual.get("renderedGroundInputs", []) for triangle in part["triangles"]]
        if source["kind"] == "footprint":
            expected = [name + "-body" if policy["sectioned"] else "body" for name in policy["groundedSectionIds"]]
            assert sorted(expected) == sorted(body["id"] for body in actual["bodyInputs"]), (aid, expected, [body["id"] for body in actual["bodyInputs"]])
            excluded = [name + "-body" for name in policy["excludedElevatedSectionIds"]]
            assert sorted(excluded) == sorted(body["id"] for body in actual["excludedElevatedBodies"])
            triangles += [triangle for body in actual["bodyInputs"] for triangle in body["triangles"]]
            rule, geometry = rule_for(aid, triangles, 0.08)
            if aid == PILOT:
                companion = json.loads((ROOT / f"content/buildings/ring-block/{PILOT}/terrain-support.json").read_text())
                def occupied(components):
                    return shapely.union_all([Polygon(c["outline"], c.get("holes")) for c in components])
                assert occupied(rule["components"]).symmetric_difference(occupied(companion["rule"]["components"])).area < 1e-8, "Pilot generic union diverged from reviewed companion"
                rule = companion["rule"]
                evidence["pilotCompanion"] = {
                    "path": f"content/buildings/ring-block/{PILOT}/terrain-support.json",
                    "sha256": sha(ROOT / f"content/buildings/ring-block/{PILOT}/terrain-support.json"),
                }
            rules.append(rule)
            evidence.update({
                **geometry,
                "groundedBodyPlanes": [{key: value for key, value in body.items() if key != "triangles"}
                                       | {"bottomTriangleCount": len(body["triangles"])} for body in actual["bodyInputs"]],
                "excludedElevatedBodies": actual["excludedElevatedBodies"],
                "renderedGroundParts": [{"partId": part["partId"], "bottomTriangleCount": len(part["triangles"])}
                                        for part in actual["renderedGroundInputs"]],
                "excludedDecorativeBottomParts": [{"partId": part["partId"], "bottomTriangleCount": len(part["triangles"])}
                                        for part in actual["decorativeGroundInputs"]],
                "entranceAuthoring": actual["entrances"],
                "entranceStatus": "reviewed-main-outer-step-approach-only" if aid == PILOT
                    else "authored-input-requires-approach-review" if actual["entrances"] else "no-authored-entrance-data",
                "supportMethod": "Union of actual generated ground-body bottom triangles and structural porch/step/post bottom triangles at local Y=0; elevated bodies and decorative facade projections excluded. Root outline and bounding box are not used.",
            })
        elif source["kind"] == "kit":
            evidence.update({
                "authoredBasePlanes": actual["authoredBasePlanes"],
                "colliders": actual["colliders"],
                "groundContactParts": [{"partId": part["partId"], "bottomTriangleCount": len(part["triangles"])}
                                       for part in actual["renderedGroundInputs"]],
                "generatedShapeKinds": sorted({plane["kind"] for plane in actual["authoredBasePlanes"]}),
            })
            if policy["policy"]["kind"] == "unsupported":
                candidate = {"assetId": aid, "status": "requires-authoring-review", "source": source,
                             "modelInputSha256": actual["modelInputSha256"],
                             "limitations": [policy["policy"]["reason"],
                                 "Only actual rendered bottoms at Y=0 are included. Raised lower faces and surrounding access are not solved by this candidate.",
                                 "No automatic adoption: evaluate maximum foundation height, all contacts and neighbouring connections on the intended grid."]}
                if triangles:
                    candidate_rule, geometry = rule_for(aid, triangles, 0.02)
                    candidate.update(candidateRule=candidate_rule, evidence=geometry)
                else:
                    candidate["limitations"].append("No observed ground-plane triangles; candidate foundation is unavailable.")
                candidates.append(candidate)
        models.append({"assetId": aid, "source": source, "policy": policy["policy"], "evidence": evidence})
    files = [
        "tools/build-ring-model-supports.py", "tools/build-ring-pilot-support.py",
        "tools/world-build/src/ring-support-authoring.ts", "tools/world-build/src/city.ts",
        "tools/world-build/src/facade.ts", "tools/world-build/src/kit.ts",
        "tools/world-build/src/house.ts", "tools/world-build/src/triangulate.ts",
        "packages/terrain-build/src/triangulate.ts",
        str(POLICIES.relative_to(ROOT)),
    ]
    generator = {
        "files": {path: sha(ROOT / path) for path in files},
        "shapelyVersion": shapely.__version__, "geosVersion": shapely.geos_version_string,
        "authoringPrecisionMetres": PRECISION,
        "operation": "Actual contact triangle union with explicit 0.1 mm coordinate precision; no buffer/simplification/hole filling in the output. Precision deviation verified below 1 mm.",
    }
    supports = {"formatVersion": 1, "status": "unapplied-authoring-inputs", "generator": generator, "rules": rules}
    encoded_supports = encode(supports)
    classification = {
        "formatVersion": 1, "status": "unapplied-authoring-inputs", "catalogFile": observed["catalogFile"],
        "catalogSha256": observed["catalogSha256"],
        "supportsSha256": hashlib.sha256(encoded_supports.encode()).hexdigest(),
        "summary": {
            "models": len(models), "sourceKinds": dict(Counter(m["source"]["kind"] for m in models)),
            "policies": dict(Counter(m["policy"]["kind"] for m in models)),
            "foundationRules": len(rules), "unsupportedKitCandidates": len(candidates),
            "entranceStatuses": dict(Counter(m["evidence"]["entranceStatus"] for m in models if m["source"]["kind"] == "footprint")),
        },
        "models": models,
    }
    return {
        "model-supports.json": encoded_supports,
        "model-classification.json": encode(classification),
        "kit-support-candidates.json": encode({"formatVersion": 1, "status": "requires-authoring-review",
                                               "generator": generator, "models": candidates}),
    }, classification["summary"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    outputs, summary = generate()
    for name, data in outputs.items():
        path = DIRECTORY / name
        if args.check:
            assert path.read_text() == data, f"{name} is stale; regenerate and review"
        else:
            path.write_text(data)
    print(json.dumps({"check": args.check, **summary}))


if __name__ == "__main__":
    main()
