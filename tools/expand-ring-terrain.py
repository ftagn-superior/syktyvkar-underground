# /// script
# requires-python = ">=3.13"
# dependencies = ["rasterio==1.5.2", "pyproj==3.8.0", "numpy==2.5.4", "scipy==1.18.1", "matplotlib==3.11.2"]
# ///
"""Extend the ring canvas with GEDTM30 bare-earth heights; preserve every old node.

uv run tools/expand-ring-terrain.py [--check]
Public COG windows are cached under output/. No objects or database writes.
The committed grid builds offline; downloading is only needed to regenerate it.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORLD = ROOT / "content/worlds/ring-block"
AUTHORING = WORLD / "terrain-expansion"
OUT = ROOT / "output/ring-terrain-expansion"
OUT.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(OUT / "matplotlib-cache"))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
import numpy as np
from pyproj import Transformer
import rasterio
from rasterio.windows import Window
from scipy.ndimage import map_coordinates


def sha(data):
    return hashlib.sha256(data).hexdigest()


def stats(values):
    return dict(zip(["min", "p05", "median", "p95", "max"],
                    map(float, np.percentile(values, [0, 5, 50, 95, 100]))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    config_bytes = (AUTHORING / "source.json").read_bytes()
    config = json.loads(config_bytes)
    old_bytes = (WORLD / config["preservedGrid"]).read_bytes()
    assert sha(old_bytes) == config["preservedGridSha256"], "Preserved city grid changed"
    old = json.loads(old_bytes)
    step = old["spacing"]
    b = config["worldBoundsXZ"]
    west, east, north, south = b["west"], b["east"], b["north"], b["south"]
    origin, scale = config["originWgs84"], config["metresPerDegree"]

    def geographic(x, z):
        return origin["lon"] + x / scale["lon"], origin["lat"] - z / scale["lat"]

    ox, oz = old["origin"]["x"], old["origin"]["z"]
    ex, ez = ox + (old["columns"]-1)*step, oz + (old["rows"]-1)*step
    assert west < ox < ex < east and north < oz < ez < south
    # A minimal halo keeps the existing triangle lattice and exact world edges.
    x0 = ox + np.floor((west-ox)/step)*step
    z0 = oz + np.floor((north-oz)/step)*step
    x1 = ox + np.ceil((east-ox)/step)*step
    z1 = oz + np.ceil((south-oz)/step)*step
    xs, zs = np.arange(x0, x1+step/2, step), np.arange(z0, z1+step/2, step)
    xx, zz = np.meshgrid(xs, zs)
    margin = config["sourceMarginMetres"]
    t = np.linspace(0, 1, 101)
    left, right, top, bottom = x0-margin, x1+margin, z0-margin, z1+margin
    bx = np.r_[left+(right-left)*t, left+(right-left)*t, np.full(101,left), np.full(101,right)]
    bz = np.r_[np.full(101,top), np.full(101,bottom), top+(bottom-top)*t, top+(bottom-top)*t]
    lon, lat = geographic(bx, bz)
    sources, rasters = {}, {}
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="60",
                      GDAL_HTTP_MAX_RETRY="2", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif"):
        for name, url in config["sources"].items():
            path = OUT / f"{name}-crop.tif"
            if not path.exists():
                print(f"Reading bounded public COG window: {name}", flush=True)
                with rasterio.open(url) as src:
                    transform = Transformer.from_crs(4326, src.crs, always_xy=True)
                    px, py = transform.transform(lon, lat)
                    rows, cols = rasterio.transform.rowcol(src.transform, px, py)
                    r0, c0 = int(min(rows))-2, int(min(cols))-2
                    r1, c1 = int(max(rows))+3, int(max(cols))+3
                    assert 0 <= r0 < r1 <= src.height and 0 <= c0 < c1 <= src.width
                    window = Window(c0, r0, c1-c0, r1-r0)
                    values = src.read(window=window)
                    profile = src.profile.copy()
                    profile.update(width=window.width, height=window.height,
                                   transform=src.window_transform(window), compress="deflate")
                    temporary = path.with_suffix(".partial.tif")
                    with rasterio.open(temporary, "w", **profile) as dest:
                        dest.write(values)
                        dest.scales, dest.offsets = src.scales, src.offsets
                        dest.update_tags(**src.tags())
                        for band in range(1, src.count+1):
                            dest.update_tags(band, **src.tags(band))
                    temporary.replace(path)
            with rasterio.open(path) as src:
                values = src.read(1, masked=True).filled(np.nan).astype(float)
                assert src.scales[0] == 1 and src.offsets[0] == 0, f"Unreviewed scale: {name}"
                if name == "ground":
                    assert src.crs.to_epsg() == 3857
                    assert src.tags().get("VERTICAL_DATUM") == "EGM2008/EPSG:3855"
                assert np.isfinite(values).all(), f"Missing source heights: {name}"
                rasters[name] = (values, src.transform, Transformer.from_crs(4326, src.crs, always_xy=True))
                sources[name] = {"url": url, "sha256": sha(path.read_bytes()),
                                 "bytes": path.stat().st_size, "crs": str(src.crs),
                                 "resolution": list(src.res), "shape": list(values.shape),
                                 "scale": src.scales[0], "offset": src.offsets[0]}

    def sample(name, x, z):
        values, affine, transform = rasters[name]
        px, py = transform.transform(*geographic(x, z))
        col, row = ~affine * (px, py)
        result = map_coordinates(values, [row-.5, col-.5], order=1, mode="constant", cval=np.nan)
        assert np.isfinite(result).all(), f"Sample outside source coverage: {name}"
        return result

    def ground(x, z):
        # GEDTM's orthometric EGM2008 H -> WGS84 ellipsoid h -> game's Y.
        return sample("ground", x, z) + sample("geoid", x, z) - config["heightReferenceEllipsoidMetres"]

    raw = ground(xx, zz)
    cx, cz = np.clip(xx, ox, ex), np.clip(zz, oz, ez)
    u, v = (cx-ox)/step, (cz-oz)/step
    col = np.minimum(np.floor(u).astype(int), old["columns"]-2)
    row = np.minimum(np.floor(v).astype(int), old["rows"]-2)
    fx, fz = u-col, v-row
    oh = np.asarray(old["heights"]).reshape(old["rows"], old["columns"])
    a, bb, c, d = oh[row,col], oh[row,col+1], oh[row+1,col+1], oh[row+1,col]
    edge = np.where(fz <= fx, a+(bb-a)*fx+(c-bb)*fz, a+(c-d)*fx+(d-a)*fz)
    distance = np.hypot(xx-cx, zz-cz)
    blend = np.clip(distance/config["transitionMetres"], 0, 1)
    weight = 1-blend*blend*(3-2*blend)
    heights = np.round(raw + weight*(edge-ground(cx, cz)), 5)
    # Copy, never resample, the accepted city surface and authored gameplay pads.
    ic, ir = int(round((ox-x0)/step)), int(round((oz-z0)/step))
    heights[ir:ir+old["rows"], ic:ic+old["columns"]] = oh
    assert np.array_equal(heights[ir:ir+old["rows"], ic:ic+old["columns"]], oh)
    grid = {"formatVersion": 1, "origin": {"x": float(x0), "z": float(z0)},
            "spacing": step, "columns": len(xs), "rows": len(zs),
            "bottom": float(np.floor(heights.min())-4), "heights": heights.ravel().tolist()}
    grid_bytes = (json.dumps(grid, separators=(",", ":"))+"\n").encode()
    dx, dz = np.diff(heights, axis=1)/step, np.diff(heights, axis=0)/step
    slopes = np.degrees(np.arctan(np.r_[np.hypot(dx[:-1],dz[:,1:]).ravel(),
                                                     np.hypot(dx[1:],dz[:,:-1]).ravel()]))
    report = {
        "formatVersion": 1, "worldBoundsXZ": b, "areaSquareMetres": (east-west)*(south-north),
        "sourceConfigSha256": sha(config_bytes), "preservedGridSha256": sha(old_bytes),
        "sources": sources, "heightFormula": "Y = H_GEDTM_EGM2008 + N_EGM2008 - 124",
        "sourceInterpolation": "bilinear; no invented fine-scale terrain detail",
        "transition": {"metres": config["transitionMetres"], "method": "nearest old boundary residual, faded with smoothstep outside the old footprint only"},
        "preservedNodes": oh.size, "changedPreservedNodes": 0,
        "grid": {k: value for k, value in grid.items() if k != "heights"},
        "heightY": stats(heights), "slopeDegrees": stats(slopes),
        "sourceHeightY": stats(raw), "geoidMetres": stats(sample("geoid",xx,zz)),
        "maxTransitionCorrectionMetres": float(np.max(np.abs(heights[distance>0]-raw[distance>0]))),
        "output": {"file": "grid.json", "sha256": sha(grid_bytes)},
        "limitations": ["GEDTM30 v1.2 is an inferred bare-earth model, not a local survey.",
                        "Nominal 30 m source (~36.4 m here); 4 m output is interpolation, not 4 m source accuracy.",
                        "Existing ArcticDEM-derived city heights/pads are preserved exactly; the 200 m join is an explicit game adaptation.",
                        "No buildings, trees, roads, water surfaces or other new objects were imported."],
        "attribution": ["GEDTM30 v1.2, OpenGeoHub, CC BY 4.0, https://zenodo.org/records/18887460",
                        "EGM2008, NGA / PROJ-data, https://cdn.proj.org/us_nga_README.txt",
                        "Preserved city: ArcticDEM Mosaic v4.1, PGC / University of Minnesota, Maxar imagery, CC BY 4.0, doi:10.7910/DVN/3VDC4W"]}
    for name, data in [("grid.json", grid_bytes), ("provenance.json", (json.dumps(report,indent=2)+"\n").encode())]:
        path = AUTHORING / name
        if args.check:
            assert path.read_bytes() == data, f"Stale terrain expansion: {name}"
        else:
            path.write_bytes(data)
    fig, axes = plt.subplots(1,2,figsize=(16,6),constrained_layout=True)
    for ax, values, title in zip(axes,[heights, heights-raw],["Expanded ground Y, m (north up)", "Join / preserved city minus GEDTM, m"]):
        im=ax.imshow(values,extent=[x0,x1,z1,z0],origin="upper",cmap="terrain" if ax==axes[0] else "RdBu_r")
        ax.add_patch(Rectangle((ox,oz),ex-ox,ez-oz,fill=False,edgecolor="black"))
        ax.add_patch(Rectangle((west,north),east-west,south-north,fill=False,edgecolor="red"))
        ax.plot(0,0,"k+");ax.set(title=title,xlabel="X east, m",ylabel="Z south, m")
        fig.colorbar(im,ax=ax,shrink=.7)
    fig.savefig(OUT/"height-preview.png",dpi=150)
    print(json.dumps({k:report[k] for k in ["grid","heightY","slopeDegrees","preservedNodes","changedPreservedNodes","maxTransitionCorrectionMetres","output"]},indent=2))


if __name__ == "__main__":
    main()
