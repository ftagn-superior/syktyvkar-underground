# /// script
# requires-python = ">=3.13"
# dependencies = ["shapely==2.2.0", "numpy==2.5.4"]
# ///
"""Propose straight approaches from actual generated doors and structural support edges.

Writes a diagnostic catalogue under output/. Does not accept access, move owners or edit terrain.
"""
import importlib.util
import argparse
import json
import math
from pathlib import Path
import numpy as np
import shapely
from shapely.geometry import Polygon
from shapely.affinity import translate

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "content/worlds/ring-block/terrain-candidate"
OUT = ROOT / "output/ring-terrain-stage4/entrance-approaches"
spec = importlib.util.spec_from_file_location("pad_helpers", ROOT / "tools/evaluate-syktsu-terrain-pad.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--grid', type=Path, default=DIRECTORY / 'pilot-grid-with-pads.json')
    parser.add_argument('--audit', type=Path, default=ROOT / 'output/ring-terrain-stage4/entrance-audit.json')
    parser.add_argument('--snapshot', type=Path, default=ROOT / 'data/map-layout.json')
    parser.add_argument('--output', type=Path, default=OUT / 'preliminary.json')
    parser.add_argument('--authoring-study', type=Path, default=DIRECTORY / 'entrance-authoring-study.json')
    args = parser.parse_args()
    audit = helper.load(args.audit)
    study = helper.load(args.authoring_study)
    grid = helper.load(args.grid)
    heights = np.array(grid["heights"]).reshape(grid["rows"], grid["columns"])
    rules = {r["assetId"]: r for r in helper.load(DIRECTORY / "model-supports.json")["rules"]}
    loaded = helper.load(args.snapshot)
    snapshot = loaded.get('targetSnapshot', loaded)
    owners = {o["entityId"]: o for o in snapshot["instances"] if o["enabled"]}
    footprint = {}
    for oid, owner in owners.items():
        if owner["assetId"] not in rules: continue
        rule = rules[owner["assetId"]]
        footprint[oid] = translate(shapely.union_all([Polygon(c["outline"], c.get("holes")) for c in rule["components"]]),owner["position"]["x"],owner["position"]["z"])
    road_layer = next(l for l in helper.load(ROOT / "content/buildings/ring-block/ring-block-ground/source.json")["layers"] if l["id"] == "road")
    roads = shapely.union_all([Polygon(r[0],r[1:]) for r in road_layer["polygons"]])
    results = []
    for model in audit["models"]:
        owner = owners[model["entityId"]]
        rule = rules[model["assetId"]]
        ox,oz=owner["position"]["x"],owner["position"]["z"]
        assert owner["rotation"]=={"x":0,"y":0,"z":0,"w":1}
        for door in model["doors"]:
            if door["thresholdHeightMetres"] <= .2: continue
            local=np.array([door["world"]["x"]-ox,door["world"]["z"]-oz])
            observed_normal=np.array([door["outward"]["x"],door["outward"]["z"]])
            boundary=[]
            for ci,component in enumerate(rule["components"]):
                for ri,ring in enumerate([component["outline"],*component.get("holes",[])]):
                    for ei,(a,b) in enumerate(zip(ring,ring[1:]+ring[:1])):
                        a,b=np.array(a),np.array(b);length=np.linalg.norm(b-a)
                        if length < 2.4: continue
                        tangent=(b-a)/length;normal=np.array([tangent[1],-tangent[0]])
                        if np.dot(normal,observed_normal) < .999: continue
                        along=np.dot(local-a,tangent);clipped=np.clip(along,1.2,length-1.2)
                        if abs(clipped-along)>.55:continue
                        middle=a+tangent*clipped;offset=np.dot(middle-local,normal)
                        if not -.1 <= offset <= 6:continue
                        edge=[(middle-tangent*1.2).tolist(),(middle+tangent*1.2).tolist()]
                        boundary.append({"component":ci,"ring":ri,"edgeIndex":ei,"edge":edge,"outward":normal.tolist(),"offsetFromDoorMetres":float(offset),"sideShiftMetres":float(clipped-along)})
            result={"entityId":model["entityId"],"assetId":model["assetId"],"door":door,"fixedOwnerY":model["ownerY"],"status":"unresolved","trials":[]}
            if not boundary:
                result["reason"]="No sufficiently wide actual support boundary aligns with this door without a substantial side shift."
                results.append(result);continue
            boundary.sort(key=lambda item:(abs(item["offsetFromDoorMetres"]),abs(item["sideShiftMetres"])))
            anchor=boundary[0];result["supportEdge"]=anchor
            near=np.array(anchor["edge"])+[ox,oz];normal=np.array(anchor["outward"]);target=model["ownerY"]+door["localBottomY"]+.04
            maximum_length = study.get('maximumStraightLengthMetres', {}).get(model['entityId'], 40)
            door_key = f"{model['entityId']}/{door['partId']}/{door['index']}"
            minimum_length = study.get('minimumStraightLengthMetres', {}).get(door_key, 4)
            length_step = study.get('straightLengthStepMetres', {}).get(model['entityId'], 2)
            for length_value in np.arange(minimum_length, maximum_length+length_step/2, length_step):
                length = float(length_value)
                far=near+normal*length;ramp=Polygon([near[0],near[1],far[1],far[0]])
                world_bounds=(grid["origin"]["x"],grid["origin"]["z"],grid["origin"]["x"]+(grid["columns"]-1)*grid["spacing"],grid["origin"]["z"]+(grid["rows"]-1)*grid["spacing"])
                xmin,zmin,xmax,zmax=ramp.bounds
                if xmin<world_bounds[0] or zmin<world_bounds[1] or xmax>world_bounds[2] or zmax>world_bounds[3]:
                    result["trials"].append({"length":length,"status":"outside-world"});continue
                ticks=np.linspace(0,1,int(round(length*4))+1)
                points=np.stack([near[0]+normal*length*t for t in ticks]+[near.mean(axis=0)+normal*length*t for t in ticks]+[near[1]+normal*length*t for t in ticks])
                ground=helper.sample(grid,heights,points).reshape(3,-1)
                top=target*(1-ticks)[None,:]+ground*ticks[None,:]
                along=np.diff(top,axis=1)/.25
                across=(top[2]-top[0])/2.4
                slope=float(np.degrees(np.arctan(np.max(np.hypot(along,np.maximum(np.abs(across[:-1]),np.abs(across[1:]))[None,:])))))
                own_overlap=float(ramp.intersection(footprint[model["entityId"]]).area)
                neighbours=[{"entityId":oid,"overlapM2":float(ramp.intersection(geometry).area)} for oid,geometry in footprint.items() if oid!=model["entityId"] and ramp.intersection(geometry).area>1e-5]
                road_overlap=float(ramp.intersection(roads).area)
                raises_owner=max(0,float(ground.max())-(model["ownerY"]+door["localBottomY"]+.04))
                trial={"length":length,"estimatedMaxSlopeDegrees":slope,"roadOverlapM2":road_overlap,"ownSupportOverlapM2":own_overlap,"neighbourFootprints":neighbours,"ownerRaiseRequiredAtProbesMetres":raises_owner}
                slope_limit = study.get('preliminarySlopeLimitDegrees', {}).get(model['entityId'], 8)
                trial["status"]="candidate-for-actual-geometry" if slope<=slope_limit and own_overlap<1e-5 and not neighbours and road_overlap<.05 and raises_owner<1e-8 else "rejected-preliminary"
                result["trials"].append(trial)
                if trial["status"]=="candidate-for-actual-geometry":
                    result.update(status=trial["status"],selected=trial,approach={"id":f"door-{door['partId']}-{door['index']}","edge":anchor["edge"],"outward":anchor["outward"],"length":length,"targetY":door["localBottomY"]+.04,"color":"#b5afa1"})
                    break
            if result["status"]=="unresolved":
                result["reason"]="No straight4..40m candidate simultaneously meets the preliminary8-degree, owner-height, footprint and road criteria. Local landing/stair/dogleg authoring or another explicit decision is required."
            results.append(result)
    accepted=[r for r in results if r["status"]=="candidate-for-actual-geometry"]
    # Different doors can produce crossing ramps; keep the conflict explicit.
    for i,left in enumerate(accepted):
        def polygon(r):
            a=r["approach"];o=owners[r["entityId"]];near=np.array(a["edge"])+[o["position"]["x"],o["position"]["z"]];far=near+np.array(a["outward"])*a["length"];return Polygon([near[0],near[1],far[1],far[0]])
        lp=polygon(left)
        for right in accepted[i+1:]:
            area=float(lp.intersection(polygon(right)).area)
            if area>1e-5:
                left.setdefault("approachConflicts",[]).append({"entityId":right["entityId"],"approachId":right["approach"]["id"],"areaM2":area})
                right.setdefault("approachConflicts",[]).append({"entityId":left["entityId"],"approachId":left["approach"]["id"],"areaM2":area})
    report={"formatVersion":1,"status":"unapplied-preliminary-door-approaches","inputs":{str(p.resolve().relative_to(ROOT)):helper.sha(p) for p in [args.grid,args.audit,args.snapshot,args.authoring_study,Path(__file__)]},
            "criteria":{"widthMetres":2.4,"maximumEstimatedSlopeDegrees":8,"defaultLengthsMetres":[4,40],"maximumLengthOverridesMetres":study.get('maximumStraightLengthMetres',{}),"maximumSideShiftMetres":.55,"terrainMutation":False,"ownerYMutation":False},
            "limitations":["Slope estimates use quarter-metre samples, not the emitted triangulation; actual generator/collision checks are still required.","Other buildings and roads are screened in XZ. Kit collider checks require the final proposed placement snapshot.","Decorative doors do not imply an interior opening. Porch access ends at its actual outer structural support edge."],
            "summary":{"doors":len(results),"preliminaryCandidates":len(accepted),"unresolved":len(results)-len(accepted),"candidatesWithRampConflicts":sum(bool(r.get("approachConflicts")) for r in accepted)},"doors":results}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps(report["summary"]))


if __name__=="__main__":main()
