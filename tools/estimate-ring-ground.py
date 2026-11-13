# /// script
# requires-python = ">=3.13"
# dependencies = ["rasterio==1.5.2", "pyproj==3.8.0", "numpy==2.5.4", "scipy==1.18.1", "matplotlib==3.11.2"]
# ///
"""Diagnostic ground reconstruction, not a production heightfield or surveyed DTM.

Requires the stage-0 ArcticDEM crops and object-masks.json. Writes only output/.
Masks + source quality select candidate observations; they do not prove bare earth.
"""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output/ring-terrain-stage0"
os.environ.setdefault("MPLCONFIGDIR", str(OUT / "matplotlib-cache"))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
import numpy as np
from pyproj import Transformer
import rasterio
from rasterio.features import rasterize
from rasterio.transform import Affine
from scipy.ndimage import distance_transform_edt, map_coordinates, maximum_filter, minimum_filter
from scipy.sparse import coo_matrix, diags, eye, kron, vstack
from scipy.sparse.linalg import spsolve
from scipy.spatial import cKDTree


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def summary(a):
    a = np.asarray(a)
    a = a[np.isfinite(a)]
    return {"count": int(a.size), **dict(zip(["min", "p05", "median", "p95", "max"],
            map(float, np.percentile(a, [0, 5, 50, 95, 100]))))} if a.size else {"count": 0}


def main():
    inspection = json.loads((OUT / "source-inspection.json").read_text())
    objects = json.loads((OUT / "object-masks.json").read_text())
    ground_path = ROOT / "content/buildings/ring-block/ring-block-ground/source.json"
    ground = json.loads(ground_path.read_text())
    assert sha(ROOT / "data/map-layout.json") == objects["metadata"]["inputs"]["data/map-layout.json"]
    bounds = inspection["worldBounds"]
    xmin, xmax = bounds["min"]["x"], bounds["max"]["x"]
    zmin, zmax = bounds["min"]["z"], bounds["max"]["z"]
    xs, zs = np.arange(xmin, xmax+1, 2), np.arange(zmin, zmax+1, 2)
    xx, zz = np.meshgrid(xs, zs)
    transform = Affine(2, 0, xmin-1, 0, 2, zmin-1)
    georef = inspection["georeference"]
    projection = Transformer.from_crs(4326, 3413, always_xy=True)

    def source_grid(dx=0, dz=0):
        ex, ny = projection.transform(georef["origin"]["lon"] + (xx+dx)/georef["metersPerDegree"]["lon"],
                                      georef["origin"]["lat"] - (zz+dz)/georef["metersPerDegree"]["lat"])
        result = {}
        for band in ["dem", "mad", "count", "datamask"]:
            path = OUT / f"arcticdem-{band}-crop.tif"
            assert sha(path) == inspection["assets"][band]["sha256"]
            with rasterio.open(path) as ds:
                cc, rr = (~ds.transform) * (ex, ny)
                assert rr.min() >= 0 and cc.min() >= 0 and rr.max() < ds.height and cc.max() < ds.width
                result[band] = map_coordinates(ds.read(1).astype(float), [rr-0.5, cc-0.5], order=0, mode="nearest")
        return result

    def polygon_mask(shapes):
        return rasterize([(s, 1) for s in shapes], out_shape=xx.shape, transform=transform,
                         all_touched=True).astype(bool)

    category_masks = {category: polygon_mask([f["geometry"] for f in objects["features"]
                      if f["properties"]["category"] == category])
                      for category in ["building", "vegetation", "other-structure"]}
    distances = {k: distance_transform_edt(~mask, sampling=2) for k, mask in category_masks.items()}
    open_layers = {"road", "footway", "parking", "service", "pitch", "playground", "green", "park"}
    mapped_open = polygon_mask([{"type": "Polygon", "coordinates": p} for layer in ground["layers"]
                               if layer["id"] in open_layers for p in layer["polygons"]])

    # 10 m inference lattice; the final row may extend <10 m past the world boundary.
    hx = np.arange(xmin, xmax+10, 10)
    hz = np.arange(zmin, zmax+10, 10)
    nx, nz = len(hx), len(hz)

    def second(n):
        return diags([np.ones(n-2), -2*np.ones(n-2), np.ones(n-2)], [0,1,2], shape=(n-2,n))

    dx = diags([-np.ones(nx-1), np.ones(nx-1)], [0,1], shape=(nx-1,nx))
    dz = diags([-np.ones(nz-1), np.ones(nz-1)], [0,1], shape=(nz-1,nz))
    curvature = vstack([kron(eye(nz), second(nx)), kron(second(nz), eye(nx)),
                       np.sqrt(2)*kron(dz, dx)]).tocsr()
    penalty = curvature.T @ curvature

    def design(x, z):
        u, v = (np.asarray(x)-xmin)/10, (np.asarray(z)-zmin)/10
        i, j = np.minimum(u.astype(int), nx-2), np.minimum(v.astype(int), nz-2)
        fu, fv = u-i, v-j
        ids = np.stack([j*nx+i, j*nx+i+1, (j+1)*nx+i, (j+1)*nx+i+1], axis=1)
        weights = np.stack([(1-fu)*(1-fv), fu*(1-fv), (1-fu)*fv, fu*fv], axis=1)
        return coo_matrix((weights.ravel(), (np.repeat(np.arange(u.size),4),ids.ravel())),
                          shape=(u.size,nx*nz)).tocsr()

    evaluation = design(xx.ravel(), zz.ravel())

    def observations(bands, buffer, percentile):
        finite = np.isfinite(bands["dem"]) & (bands["dem"] != -9999)
        quality = finite & (bands["count"] >= 3) & (bands["datamask"] == 1) & (bands["mad"] <= 1)
        local_range = maximum_filter(bands["dem"], size=3) - minimum_filter(bands["dem"], size=3)
        allowed = quality & mapped_open & (distances["building"] > buffer) & (distances["vegetation"] > 4)
        allowed &= (distances["other-structure"] > 2) & (local_range <= 2)
        # Aggregate within 10 m blocks to avoid overweighting adjacent DSM samples.
        cells = ((zz-zmin)//10 * nx + (xx-xmin)//10).astype(int)
        anchors = []
        for cell in np.unique(cells[allowed]):
            r, c = np.where(allowed & (cells == cell))
            if len(r) < 3:
                continue
            values = bands["dem"][r,c]
            q = np.percentile(values, percentile)
            pick = int(np.argmin(np.abs(values-q)))
            anchors.append([xx[r[pick],c[pick]], zz[r[pick],c[pick]], values[pick], len(r)])
        return np.asarray(anchors, dtype=float), allowed

    solver_audits = []

    def fit(anchors, smoothing=30):
        assert len(anchors) >= 20, "Insufficient candidate support"
        A = design(anchors[:,0], anchors[:,1])
        target = anchors[:,2] - 124
        weights = np.ones(len(target))
        previous = None
        # Symmetric Huber IRLS suppresses gross disagreements; it does not identify vegetation.
        for iteration in range(100):
            weighted = A.T @ diags(weights)
            solution = spsolve(weighted @ A + smoothing*penalty + 1e-9*eye(nx*nz), weighted @ target)
            residual = np.asarray(A @ solution) - target
            new_weights = np.minimum(1, 1/np.maximum(np.abs(residual), 1e-12))
            delta = float(np.max(np.abs(solution-previous))) if previous is not None else None
            if delta is not None and delta <= 0.001 and np.max(np.abs(weights-new_weights)) <= 0.001:
                solver_audits.append({"anchorCount":len(anchors),"smoothing":smoothing,
                                      "iterations":iteration+1,"maxNodeChangeM":delta,"converged":True})
                return solution
            weights, previous = new_weights, solution
        raise RuntimeError(f"Ground fit did not converge after 100 iterations: {delta} m")

    bands = source_grid()
    anchors, allowed = observations(bands, 16, 20)
    solution = fit(anchors)
    primary = np.asarray(evaluation @ solution).reshape(xx.shape)
    variants = {}
    for name, buffer, quantile, smoothing, offset in [
        ("building_buffer_12",12,20,30,(0,0)), ("building_buffer_20",20,20,30,(0,0)),
        ("block_median",16,50,30,(0,0)), ("smoothing_10",16,20,10,(0,0)),
        ("smoothing_100",16,20,100,(0,0)), ("diagnostic_source_offset",16,20,30,(-6,2))]:
        obs, _ = observations(source_grid(*offset) if offset != (0,0) else bands, buffer, quantile)
        values = np.asarray(evaluation @ fit(obs, smoothing)).reshape(xx.shape)
        variants[name] = {"values": values, "anchorCount": len(obs)}
    all_values = np.stack([primary] + [v["values"] for v in variants.values()])
    spread = all_values.max(axis=0)-all_values.min(axis=0)
    distance = cKDTree(anchors[:,:2]).query(np.column_stack([xx.ravel(),zz.ravel()]))[0].reshape(xx.shape)
    pilot = (xx>=-225)&(xx<=0)&(zz>=-280)&(zz<=-40)
    # Spatial blocked holdout with a 20 m exclusion buffer around each test block.
    blocks = np.floor((anchors[:,:2]-[xmin,zmin])/60).astype(int)
    folds = (blocks[:,0] + 2*blocks[:,1]) % 4
    checks = []
    for fold in range(4):
        test = folds == fold
        train = ~test
        for bx, bz in np.unique(blocks[test], axis=0):
            x0, z0 = xmin+bx*60-20, zmin+bz*60-20
            train &= ~((anchors[:,0]>=x0)&(anchors[:,0]<=x0+100)&(anchors[:,1]>=z0)&(anchors[:,1]<=z0+100))
        pred = np.asarray(design(anchors[test,0],anchors[test,1]) @ fit(anchors[train])) + 124
        error = pred-anchors[test,2]
        checks.append({"fold":fold,"trainAnchors":int(train.sum()),"testAnchors":int(test.sum()),
                       "absoluteResidualM":summary(np.abs(error)),"signedResidualM":summary(error)})
    # Both planes for the existing NW-SE diagonal, matching contracts/terrain.ts.
    a,b,c,d = primary[:-1,:-1],primary[:-1,1:],primary[1:,1:],primary[1:,:-1]
    slopes = np.degrees(np.arctan(np.concatenate([np.hypot((b-a)/2,(c-b)/2).ravel(),
                                                np.hypot((c-d)/2,(d-a)/2).ravel()])))
    pilot_cells = pilot[:-1,:-1] & pilot[:-1,1:] & pilot[1:,1:] & pilot[1:,:-1]
    pilot_slopes = np.degrees(np.arctan(np.concatenate([np.hypot((b-a)/2,(c-b)/2)[pilot_cells],
                                                       np.hypot((c-d)/2,(d-a)/2)[pilot_cells]])))
    route = np.array([[0,0],[-33,-75],[-68,-130],[-93.0264,-120.1397],[-68,-130],[-100,-200],[-141,-280]])
    route_y = np.asarray(design(route[:,0],route[:,1])@solution)
    route_lengths = np.linalg.norm(np.diff(route,axis=0),axis=1)
    report = {
        "status":"diagnostic_candidate_not_approved_terrain", "verticalReference":"WGS84 ellipsoid, Y=h-124",
        "georeferenceChangeApplied":False,
        "method":"Mapped open areas; 16 m buildings / 4 m vegetation / 2 m other exclusions; source quality; 3x3 DSM range<=2m; 10m blocks with >=3 samples, observed value nearest p20; Huber curvature-regularized 10m lattice; bilinear diagnostic output at 2m",
        "parameters":{"smoothing":30,"huberDeltaM":1,"maxIterations":100,"convergenceMaxNodeChangeM":0.001,
                      "convergenceMaxWeightChange":0.001,"qualityMadMaxM":1,"blockMeters":10},
        "solverAudits":solver_audits,
        "inputs":{str(p.relative_to(ROOT)):sha(p) for p in [OUT/"source-inspection.json",OUT/"object-masks.json",ground_path]},
        "candidateSampleCount":int(allowed.sum()),"anchorCount":len(anchors),
        "heightY":summary(primary),"pilotHeightY":summary(primary[pilot]),"triangleSlopeDegrees":summary(slopes),
        "pilotTriangleSlopeDegrees":summary(pilot_slopes),
        "nearestAnchorDistanceM":summary(distance),"pilotNearestAnchorDistanceM":summary(distance[pilot]),
        "within50mAnchorFraction":float(np.mean(distance<=50)),"pilotWithin50mAnchorFraction":float(np.mean(distance[pilot]<=50)),
        "variantRangeM":summary(spread),"pilotVariantRangeM":summary(spread[pilot]),
        "variants":{k:{"anchorCount":v["anchorCount"],"heightY":summary(v["values"]),
                       "absoluteDeltaM":summary(np.abs(v["values"]-primary))} for k,v in variants.items()},
        "spatialHoldout":{"blockMeters":60,"bufferMeters":20,"folds":checks,
                          "interpretation":"Agreement with held-out candidate DSM observations only; not ground truth or geodetic accuracy"},
        "route":{"pointsXZ":route.tolist(),"estimatedY":route_y.tolist(),
                 "segmentAverageSlopeDegrees":np.degrees(np.arctan(np.abs(np.diff(route_y))/route_lengths)).tolist(),
                 "interpretation":"Diagnostic profile, not a validated walkable route"},
        "limitations":["Contemporary authored masks are not a complete historical inventory of roofs and vegetation",
                       "Wide elevated objects can survive candidate selection", "No surveyed bare-earth controls",
                       "Interpolated areas and extrapolation at edges remain uncertain", "Variant spread is not a confidence interval",
                       "Smoothing controls slopes; these are candidate slopes, not proven real slopes"]}
    (OUT/"ground-estimate.json").write_text(json.dumps(report,indent=2)+"\n")
    (OUT/"ground-anchors.json").write_text(json.dumps({"columns":["x","z","ellipsoidHeight","candidateCount"],"anchors":anchors.tolist()},separators=(",",":"))+"\n")
    np.savez_compressed(OUT/"ground-estimate-arrays.npz", x=xs,z=zs,y=primary,spread=spread,distance=distance,candidates=allowed)
    (OUT/"ground-candidate-grid.json").write_text(json.dumps({"status":report["status"],"origin":{"x":xmin,"z":zmin},"spacing":2,
        "rows":len(zs),"columns":len(xs),"heights":np.round(primary,5).ravel().tolist(),"verticalReference":report["verticalReference"]},separators=(",",":"))+"\n")
    fig,axs=plt.subplots(1,4,figsize=(18,8),constrained_layout=True)
    panels=[(np.where(allowed,bands["dem"]-124,np.nan),"Candidate observations (Y, m)","terrain",-2,16),
            (primary,"Smooth candidate (Y, m)","terrain",-2,16),
            (distance,"Distance to candidate anchor (m)","viridis",0,150),
            (spread,"Spread of method variants (m)","magma",0,3)]
    for ax,(values,title,cmap,lo,hi) in zip(axs,panels):
        im=ax.imshow(values,extent=[xmin-1,xmax+1,zmax+1,zmin-1],origin="upper",vmin=lo,vmax=hi,cmap=cmap)
        ax.add_patch(Rectangle((-225,-280),225,240,fill=False,color="red"))
        ax.set(title=title,xlabel="X east, m",ylabel="Z south, m",xlim=(xmin,xmax),ylim=(zmax,zmin))
        fig.colorbar(im,ax=ax,shrink=.6,extend="both" if np.nanmin(values)<lo else ("max" if np.nanmax(values)>hi else "neither"))
    fig.suptitle("Diagnostic reconstruction only / north up / red: pilot / no surveyed ground control")
    fig.savefig(OUT/"ground-estimate-preview.png",dpi=150)
    print(json.dumps({k:report[k] for k in ["anchorCount","heightY","pilotHeightY","triangleSlopeDegrees","within50mAnchorFraction","pilotWithin50mAnchorFraction","variantRangeM","pilotVariantRangeM","spatialHoldout"]},indent=2))


if __name__ == "__main__":
    main()
