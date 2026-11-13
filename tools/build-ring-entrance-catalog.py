# /// script
# requires-python = ">=3.13"
# ///
"""Freeze explicit full-terrain entrance rules with reproducible source pins.

This writes authoring data, never an active release or static database placement.
"""
import copy
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "content/worlds/ring-block/terrain-candidate"
DIRECTORY = ROOT / "output/ring-terrain-stage5/entrance-approaches"


def load(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def door_key(entity_id, door):
    return entity_id, door["partId"], door["index"]


def pose_digest(snapshot):
    rows = [[o['entityId'], o['assetId'], o['enabled'],
             *[math.floor(o['position'][key]*1e8+.5) for key in ['x', 'y', 'z']],
             *[math.floor(o['rotation'][key]*1e10+.5) for key in ['x', 'y', 'z', 'w']]]
            for o in sorted(snapshot['instances'], key=lambda o:o['entityId'])]
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def main():
    audit = load(DIRECTORY / "entrance-audit-ready.json")
    preliminary = load(DIRECTORY / "preliminary-ready.json")
    actual = load(DIRECTORY / "actual-geometry-ready.json")
    platforms = load(DIRECTORY / "facade-platforms-ready.json")
    platform_actual = load(DIRECTORY / "facade-platforms-actual.json")
    kit_screen = load(DIRECTORY / "final-kit-screen.json")
    source_snapshot_path = ROOT / "output/ring-terrain-stage5/intermediate/target-static-snapshot.json"
    snapshot = load(source_snapshot_path)
    source_owners = {o["entityId"]: o for o in snapshot["instances"] if o["enabled"]}
    source_rules = {r["assetId"]: r for r in load(CONTENT / "model-supports.json")["rules"]}
    models = {m["assetId"]: m for m in load(CONTENT / "model-classification.json")["models"]}
    study = load(CONTENT / "entrance-authoring-study.json")
    good_straights = {door_key(r["entityId"], r["door"]): r for r in actual["results"] if r["status"] == "geometry-candidate-needs-final-clearance"}
    good_podiums = {r["entityId"]: r for r in platform_actual["results"] if r["status"] == "actual-podium-geometry-candidate"}
    podiums = {r["entityId"]: r for r in platforms["ownerOverrides"] if r["entityId"] in good_podiums}
    covered = {}
    for facade in platforms["facades"]:
        if facade["entityId"] not in podiums:
            continue
        approach_id = facade.get("servedBy", facade["id"])
        for door in facade["doors"]:
            covered[door_key(facade["entityId"], door)] = approach_id
    entries = {}
    unresolved = []
    for candidate in preliminary["doors"]:
        oid = candidate["entityId"]
        key = door_key(oid, candidate["door"])
        if key not in covered and key not in good_straights:
            unresolved.append({"entityId": oid, "partId": key[1], "index": key[2], "reason": "No accepted geometry candidate."})
            continue
        if oid not in entries:
            rule = copy.deepcopy(podiums[oid]["rule"] if oid in podiums else source_rules[candidate["assetId"]])
            rule["ownerId"] = oid
            entries[oid] = {"entityId": oid, "assetId": candidate["assetId"], "placement": {key: source_owners[oid][key] for key in ["position", "rotation"]},
                            "kind": "explicit-pedestrian-podium" if oid in podiums else "straight-approaches",
                            "rule": rule, "doors": [],
                            "maximumAllowedSlopeDegrees": study.get("maximumActualSlopeDegrees", {}).get(oid, 8)}
            if oid in podiums:
                entries[oid]["podium"] = {key: podiums[oid][key] for key in ["rationale", "originalSupportAreaM2", "addedPodiumAreaM2", "authoringPrecisionMetres", "precisionSymmetricDifferenceAreaM2"]}
        entry = entries[oid]
        if key in covered:
            approach_id = covered[key]
            measured = next(a["maximumTopSlopeDegrees"] for a in good_podiums[oid]["assets"] if a["role"] == "approach:"+approach_id)
        else:
            approach = candidate["approach"]
            approach_id = approach["id"]
            entry["rule"].setdefault("approaches", []).append(approach)
            measured = good_straights[key]["maximumEmittedSlopeDegrees"]
        entry["doors"].append({"partId": key[1], "index": key[2], "thresholdHeightMetres": candidate["door"]["thresholdHeightMetres"], "approachId": approach_id, "maximumEmittedSlopeDegrees": measured})
    low_doors = [{"entityId": m["entityId"], "assetId": m["assetId"], "partId": d["partId"], "index": d["index"], "thresholdHeightMetres": d["thresholdHeightMetres"], "status": "direct-terrain-volume-check-pending"} for m in audit["models"] for d in m["doors"] if d["thresholdHeightMetres"] <= .2]
    no_doors = [{"entityId": m["entityId"], "assetId": m["assetId"], "status": "entrances-unverified-no-authored-door-data"} for m in audit["models"] if not m["doors"]]
    pins = {CONTENT / filename for filename in ["full-grid-ready.json", "model-supports.json", "model-classification.json", "entrance-authoring-study.json"]}
    pins.update(ROOT / file for file in ["packages/terrain-build/src/supports.ts", "packages/terrain-build/src/terrain.ts", "packages/contracts/src/terrain.ts"])
    for model in models.values():
        source = model["source"]
        pins.update([ROOT / source["recipeFile"], ROOT / source["descriptorFile"]])
    evidence_files = [DIRECTORY / name for name in ["entrance-audit-ready.json", "preliminary-ready.json", "actual-geometry-ready.json", "facade-platforms-ready.json", "facade-platforms-actual.json", "final-kit-screen.json"]]
    clear_kit = kit_screen["summary"]["structuresWithPotentialKitContacts"] == 0
    clear_conflicts = kit_screen["summary"]["structuresWithProposedConflicts"] == 0
    geometry_complete = not unresolved and clear_kit and clear_conflicts and len(covered)+len([key for key in good_straights if key not in covered]) == audit["summary"]["over20cm"]
    catalog = {"formatVersion": 1, "worldId": "ring-block", "status": "geometry-checked-authoring-candidate" if geometry_complete else "incomplete-authoring-candidate",
               "terrain": {"file": str((CONTENT / "full-grid-ready.json").relative_to(ROOT)), "sha256": sha(CONTENT / "full-grid-ready.json")},
               "sourcePins": [{"file": str(path.relative_to(ROOT)), "sha256": sha(path)} for path in sorted(pins)],
               "sourceWorldMapVersion": kit_screen["mapVersion"],
               "sourcePlacementSnapshotSha256": sha(source_snapshot_path),
               "populationPoseSha256": pose_digest(snapshot),
               "evidence": [{"file": str(path.relative_to(ROOT)), "sha256": sha(path)} for path in evidence_files],
               "gates": {"allHighThresholdDoorsHaveGeneratedRules": not unresolved, "kitProjectionClear": clear_kit, "proposedStructureConflictsClear": clear_conflicts, "fullCityRepresentativePhysics": "pending", "directTerrainDoorVolumes": "pending"},
               "summary": {"owners": len(entries), "highThresholdDoors": len(preliminary["doors"]), "coveredHighThresholdDoors": sum(len(e["doors"]) for e in entries.values()), "podiumOwners": len(podiums), "directTerrainDoors": len(low_doors), "modelsWithoutAuthoredDoors": len(no_doors), "unresolvedHighThresholdDoors": len(unresolved)},
               "limitations": ["Decorative door faces do not imply open interiors. Access stops outside the actual outer structural step or facade.", "Models without authored door faces have unverified entrances; no entrances are invented.", "Geometry and kit screening alone are not physical route acceptance. Pending gates remain explicit.", "Explicit podiums extend the foundation support union with authored pedestrian landings; source structural footprints and open courtyards are retained."],
               "owners": sorted(entries.values(), key=lambda e: e["entityId"]), "directTerrainDoors": low_doors, "modelsWithoutAuthoredDoors": no_doors, "unresolved": unresolved}
    # The build input belongs with authoring content; execution reports remain in output.
    override_file = CONTENT / "full-entrance-overrides.json"
    override_file.write_text(json.dumps([e["rule"] for e in catalog["owners"]], ensure_ascii=False, indent=2)+"\n")
    catalog['overrideArtifact'] = {'file': str(override_file.relative_to(ROOT)), 'sha256': sha(override_file)}
    physical_reports = []
    for filename in ['full-city-entrance-probes.json', 'low-door-volumes.json']:
        path = DIRECTORY / filename
        if not path.exists():
            continue
        report = load(path)
        if report.get('terrainSha256') == catalog['terrain']['sha256'] and report.get('overridesSha256') == catalog['overrideArtifact']['sha256']:
            physical_reports.append((path, report))
    catalog['physicalEvidence'] = [{'file': str(path.relative_to(ROOT)), 'sha256': sha(path)} for path, _ in physical_reports]
    # Only execution reports can establish a runtime baseline. Never repin old
    # results to today's code while regenerating authoring data.
    catalog['physicalRuntimePins'] = []
    if len(physical_reports) == 2:
        runtime_pins = physical_reports[0][1].get('physicalRuntimePins', [])
        if runtime_pins and all(report.get('physicalRuntimePins') == runtime_pins for _, report in physical_reports):
            catalog['physicalRuntimePins'] = runtime_pins
    runtime_current = bool(catalog['physicalRuntimePins']) and all(
        not Path(pin['file']).is_absolute() and '..' not in Path(pin['file']).parts
        and (ROOT / pin['file']).is_file() and sha(ROOT / pin['file']) == pin['sha256']
        for pin in catalog['physicalRuntimePins'])
    if len(physical_reports) == 2 and len({r['mapVersion'] for _, r in physical_reports}) == 1:
        catalog['physicalMapVersion'] = physical_reports[0][1]['mapVersion']
        gates = ['fullCityRepresentativePhysics', 'directTerrainDoorVolumes']
        expected_routes = [catalog['summary']['highThresholdDoors'], catalog['summary']['directTerrainDoors']]
        for gate, (_, report), count in zip(gates, physical_reports, expected_routes):
            accepted = report.get('status') == 'passed' and report.get('failures') == 0 and report.get('routes') == count and report.get('runs') == count*2 and len(report.get('results', [])) == count*2 and all(r.get('status') == 'passed' for r in report['results'])
            catalog['gates'][gate] = 'passed' if accepted else 'failed'
        if runtime_current and all(catalog['gates'][gate] == 'passed' for gate in gates):
            if geometry_complete:
                catalog['status'] = 'physics-checked-authoring-candidate'
            for door in catalog['directTerrainDoors']:
                door['status'] = 'full-city-volume-walk-sprint-checked'
    (CONTENT / "full-entrance-catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2)+"\n")
    print(json.dumps({"status": catalog["status"], **catalog["summary"]}))


if __name__ == "__main__":
    main()
