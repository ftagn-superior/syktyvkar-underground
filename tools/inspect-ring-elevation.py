# /// script
# requires-python = ">=3.13"
# dependencies = ["rasterio==1.5.2", "pyproj==3.8.0", "numpy==2.5.4", "scipy==1.18.1", "matplotlib==3.11.2"]
# ///
"""Inspect ArcticDEM for stage 0; never writes game content or database state.

Run from the repository: uv run tools/inspect-ring-elevation.py
Writes source crops, diagnostics and a preview to ignored output/.
The DSM and road samples are NOT a reconstructed bare-earth terrain.
"""

import hashlib
import json
import os
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output/ring-terrain-stage0"
OUT.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(OUT / "matplotlib-cache"))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
import numpy as np
import pyproj
import rasterio
from rasterio.features import rasterize
from rasterio.transform import Affine
from rasterio.windows import Window
from scipy.ndimage import distance_transform_edt

ORIGIN = {"lat": 61.66386729706631, "lon": 50.815951774241576}
SCALE = {"lon": 52837.29, "lat": 110573.15}
HISTORICAL_COMMIT = "81c4ae63b3c0af4144c1fb21c3365ebe13c94fef"
TILE = "44_72_1_1_2m_v4.1"
BASE = "https://pgc-opendata-dems.s3.us-west-2.amazonaws.com/arcticdem/mosaics/v4.1/2m/44_72/"
PILOT = [-225, -280, 0, -40]  # xmin, zmin, xmax, zmax; proposal, not a terrain edit


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stats(values):
    values = np.asarray(values)
    values = values[np.isfinite(values)]
    if not values.size:
        return {"count": 0}
    return {"count": int(values.size), **dict(zip(
        ["min", "p05", "median", "p95", "max"],
        map(float, np.percentile(values, [0, 5, 50, 95, 100]))))}


def json_source(name, url):
    path = OUT / name
    if not path.exists():
        with urlopen(url, timeout=60) as response:
            path.write_bytes(response.read())
    return json.loads(path.read_text())


def main():
    world_path = ROOT / "content/worlds/ring-block/world.json"
    ground_path = ROOT / "content/buildings/ring-block/ring-block-ground/source.json"
    world = json.loads(world_path.read_text())
    ground = json.loads(ground_path.read_text())
    low, high = world["bounds"]["min"], world["bounds"]["max"]
    xmin, xmax, zmin, zmax = low["x"], high["x"], low["z"], high["z"]
    to_dem = pyproj.Transformer.from_crs(4326, 3413, always_xy=True)
    from_dem = pyproj.Transformer.from_crs(3413, 4326, always_xy=True)

    def project(x, z):
        return to_dem.transform(ORIGIN["lon"] + x / SCALE["lon"], ORIGIN["lat"] - z / SCALE["lat"])

    # Densify the perimeter; include a 60 m source margin, without extending the game world.
    t = np.linspace(0, 1, 101)
    left, right, top, bottom = xmin - 60, xmax + 60, zmin - 60, zmax + 60
    bx = np.concatenate([left + (right-left)*t, left + (right-left)*t, np.full(101,left), np.full(101,right)])
    bz = np.concatenate([np.full(101,top), np.full(101,bottom), top + (bottom-top)*t, top + (bottom-top)*t])
    px, py = project(bx, bz)
    tile = json_source("tile.json", BASE + TILE + ".json")
    assert tile["id"] == TILE and tile["properties"]["proj:code"] == "EPSG:3413"
    arrays, crop_transform, asset_evidence = {}, None, {}
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="60",
                      GDAL_HTTP_MAX_RETRY="2", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif"):
        for band in ["dem", "mad", "count", "datamask", "mindate", "maxdate"]:
            path = OUT / f"arcticdem-{band}-crop.tif"
            url = tile["assets"][band]["href"]
            if not path.exists():
                print(f"Reading bounded COG window: {band}", flush=True)
                with rasterio.open(url) as source:
                    assert source.crs.to_epsg() == 3413 and source.res == (2, 2)
                    rows, cols = rasterio.transform.rowcol(source.transform, px, py)
                    row0, col0 = int(min(rows)), int(min(cols))
                    row1, col1 = int(max(rows))+1, int(max(cols))+1
                    assert 0 <= row0 < row1 <= source.height and 0 <= col0 < col1 <= source.width
                    window = Window(col0, row0, col1-col0, row1-row0)
                    data = source.read(1, window=window)
                    profile = source.profile.copy()
                    profile.update(width=data.shape[1], height=data.shape[0],
                                   transform=source.window_transform(window), compress="deflate")
                    temporary = path.with_suffix(".partial.tif")
                    with rasterio.open(temporary, "w", **profile) as dest:
                        dest.write(data, 1)
                    temporary.replace(path)
            with rasterio.open(path) as crop:
                if crop_transform is None:
                    crop_transform = crop.transform
                assert crop.transform == crop_transform
                # Count/datamask=0 carry information; retain these rather than masking them.
                arrays[band] = crop.read(1).astype(float)
                arrays[band][arrays[band] == -9999] = np.nan
            asset_evidence[band] = {"url": url, "crop": str(path.relative_to(ROOT)),
                                    "sha256": sha(path), "bytes": path.stat().st_size}

    rr, cc = np.indices(arrays["dem"].shape)
    ex, ny = crop_transform * (cc + 0.5, rr + 0.5)
    lon, lat = from_dem.transform(ex, ny)
    native_x = (lon - ORIGIN["lon"]) * SCALE["lon"]
    native_z = -(lat - ORIGIN["lat"]) * SCALE["lat"]
    inside = (native_x >= xmin) & (native_x <= xmax) & (native_z >= zmin) & (native_z <= zmax)
    native_valid = inside & np.isfinite(arrays["dem"])

    # Nearest-neighbour display/diagnostic samples; no smoothing or terrain inference.
    xs, zs = np.arange(xmin, xmax+1, 2), np.arange(zmin, zmax+1, 2)
    xx, zz = np.meshgrid(xs, zs)
    gx, gy = project(xx, zz)
    rows, cols = rasterio.transform.rowcol(crop_transform, gx, gy)
    rows, cols = np.asarray(rows).reshape(xx.shape), np.asarray(cols).reshape(xx.shape)
    sampled = {name: data[rows, cols] for name, data in arrays.items()}
    grid_transform = Affine(2, 0, xmin-1, 0, 2, zmin-1)
    road_layer = next(layer for layer in ground["layers"] if layer["id"] == "road")
    roads = rasterize([({"type": "Polygon", "coordinates": polygon}, 1)
                       for polygon in road_layer["polygons"]], out_shape=xx.shape,
                      transform=grid_transform).astype(bool)
    # Distance is between raster sample centres, not a surveyed polygon-edge clearance.
    road_core = distance_transform_edt(np.pad(roads, 1), sampling=2)[1:-1, 1:-1] > 4
    pilot = (xx >= PILOT[0]) & (xx <= PILOT[2]) & (zz >= PILOT[1]) & (zz <= PILOT[3])
    quality = (sampled["count"] >= 3) & (sampled["datamask"] == 1) & (sampled["mad"] <= 1)
    near_origin = (np.abs(xx) <= 40) & (np.abs(zz) <= 40)
    road_samples = np.argwhere(road_core & quality & np.isfinite(sampled["dem"]))
    highest_roads = sorted(road_samples, key=lambda rc: sampled["dem"][tuple(rc)], reverse=True)[:5]
    report = {
        "purpose": "Source inspection only; DSM and road samples are not bare-earth terrain",
        "source": {"dataset": "ArcticDEM mosaic", "version": "4.1", "tile": TILE,
                   "metadataUrl": BASE + TILE + ".json", "metadataSha256": sha(OUT / "tile.json"),
                   "crs": "EPSG:3413", "heightDatum": "WGS84 ellipsoid", "license": "CC-BY-4.0"},
        "georeference": {"origin": ORIGIN, "metersPerDegree": SCALE, "historicalCommit": HISTORICAL_COMMIT,
                         "formula": "lon=lon0+x/52837.29; lat=lat0-z/110573.15", "north": "-Z"},
        "inputs": {str(p.relative_to(ROOT)): sha(p) for p in [world_path, ground_path]},
        "worldBounds": world["bounds"],
        "wgs84Bounds": {"west": ORIGIN["lon"]+xmin/SCALE["lon"], "east": ORIGIN["lon"]+xmax/SCALE["lon"],
                        "south": ORIGIN["lat"]-zmax/SCALE["lat"], "north": ORIGIN["lat"]-zmin/SCALE["lat"]},
        "nativeWorldPixels": int(inside.sum()), "nativeValidPixels": int(native_valid.sum()),
        "nativeCoverageFraction": float(native_valid.sum()/inside.sum()),
        "nativeWorldStatistics": {name: stats(data[inside]) for name, data in arrays.items()},
        "diagnosticGrid": {"step": 2, "shape": list(xx.shape), "method": "nearest", "valid": int(np.isfinite(sampled["dem"]).sum())},
        "roadCoreDSM": stats(sampled["dem"][road_core]),
        "roadCoreDefinition": "Euclidean distance to non-road raster centres >4 m on the 2 m diagnostic grid",
        "roadCoreQualityFilteredDSM": stats(sampled["dem"][road_core & quality]),
        "originRoadCoreQualityFilteredDSM": stats(sampled["dem"][road_core & quality & near_origin]),
        "pilotBoundsXZ": PILOT, "pilotRoadCoreQualityFilteredDSM": stats(sampled["dem"][road_core & quality & pilot]),
        "highestRoadSamplesForReview": [{"x": float(xx[r,c]), "z": float(zz[r,c]),
                                         "dsmHeight": float(sampled["dem"][r,c])} for r,c in highest_roads],
        "qualityFilter": "count>=3, datamask=1, MAD<=1 m; does not establish ground truth",
        "assets": asset_evidence,
        "libraryVersions": {"rasterio": rasterio.__version__, "pyproj": pyproj.__version__, "numpy": np.__version__},
    }
    (OUT / "source-inspection.json").write_text(json.dumps(report, indent=2) + "\n")
    fig, axes = plt.subplots(1, 3, figsize=(14, 8), constrained_layout=True)
    extent = [xmin-1, xmax+1, zmax+1, zmin-1]
    panels = [(sampled["dem"], "DSM including roofs and trees", "terrain", 120, 160),
              (np.where(road_core, sampled["dem"], np.nan), "Road interior DSM (not validated ground)", "viridis", 120, 140),
              (sampled["mad"], "Source stack MAD (m; not terrain accuracy)", "magma", 0, 3)]
    for ax, (values, title, cmap, vmin, vmax) in zip(axes, panels):
        im = ax.imshow(values, extent=extent, origin="upper", cmap=cmap, vmin=vmin, vmax=vmax)
        ax.add_patch(Rectangle((PILOT[0],PILOT[1]), PILOT[2]-PILOT[0], PILOT[3]-PILOT[1],
                               fill=False, edgecolor="red", linewidth=1.5))
        ax.set(title=title, xlabel="Game X (east), m", ylabel="Game Z (south), m")
        ax.set_aspect("equal")
        ax.set_xlim(xmin, xmax)
        ax.set_ylim(zmax, zmin)
        fig.colorbar(im, ax=ax, shrink=0.6)
    fig.suptitle("ring-block / ArcticDEM v4.1 / north up / red: proposed pilot")
    fig.savefig(OUT / "source-preview.png", dpi=150)
    print(json.dumps({k: report[k] for k in ["nativeCoverageFraction", "nativeWorldStatistics", "roadCoreQualityFilteredDSM", "originRoadCoreQualityFilteredDSM", "pilotRoadCoreQualityFilteredDSM"]}, indent=2))


if __name__ == "__main__":
    main()
