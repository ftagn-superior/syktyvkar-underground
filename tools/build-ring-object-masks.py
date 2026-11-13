# /// script
# requires-python = ">=3.13"
# dependencies = ["shapely==2.2.0"]
# ///
"""Diagnostic XZ object masks from current recipes and an actual static layout export.

Run: uv run tools/build-ring-object-masks.py
Requires shapely==2.2.0 and this repository's installed Node/tsx dependencies.
Writes only output/ring-terrain-stage0/object-masks.json; no game content or database writes.
"""
import collections
import hashlib
import json
import math
import subprocess
from pathlib import Path

import shapely
from shapely import affinity
from shapely.geometry import Polygon, mapping

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output/ring-terrain-stage0/object-masks.json"
PRECISION_METERS = 1e-7

JS = r"""
import { readFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { generateFootprint } from './tools/world-build/src/city.ts';
import { generateKit } from './tools/world-build/src/kit.ts';
import { treeRenderRecipe } from './tools/world-build/src/tree-instances.ts';
const hash = data => createHash('sha256').update(data).digest('hex');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const root = process.cwd();
const catPath = resolve('content/buildings/ring-block/catalog.json');
const catalog = await read(catPath);
const layout = await read('data/map-layout.json');
const used = new Set(layout.instances.filter(x => x.enabled).map(x => x.assetId));
const models = {};
for (const assetId of [...used].sort()) {
  const relativePath = catalog.assets[assetId];
  if (!relativePath) throw new Error(`Missing catalog asset: ${assetId}`);
  const descriptorPath = resolve(dirname(catPath), relativePath);
  const descriptor = await read(descriptorPath);
  const sourcePath = resolve(dirname(descriptorPath), descriptor.source.file);
  const recipe = await read(sourcePath);
  const groups = [];
  let coreRings = [];
  const kind = descriptor.source.kind;
  const add = (category, classification, parts) => {
    const triangles = [];
    for (const part of parts) {
      for (let i=0;i<part.indices.length;i+=3) {
        triangles.push(part.indices.slice(i,i+3).map(index => part.positions.slice(index*3,index*3+3)));
      }
    }
    groups.push({ category, classification, triangles });
  };
  if (kind === 'footprint') {
    add('building', 'descriptor.source.kind=footprint', generateFootprint(assetId, recipe).parts);
    // Sections replace the top-level outline; empty space between them stays empty.
    coreRings = recipe.sections?.length ? recipe.sections.map(s => s.outline) : [recipe.outline];
  } else if (kind === 'kit') {
    const tree = treeRenderRecipe(assetId, recipe);
    if (tree) {
      add('vegetation', `validated treeRenderRecipe profile: ${tree.foliage}`, generateKit(assetId, recipe).parts);
    } else {
      const vegetation = [], structures = [];
      for (const part of recipe.parts) {
        const foliageShapes = part.shapes.filter(s => Object.hasOwn(s, 'foliage'));
        const otherShapes = part.shapes.filter(s => !Object.hasOwn(s, 'foliage'));
        if (foliageShapes.length) vegetation.push({...part, shapes: foliageShapes});
        if (otherShapes.length) structures.push({...part, shapes: otherShapes});
      }
      if (vegetation.length) add('vegetation', 'explicit KitShape.foliage',
        generateKit(assetId, {...recipe, merge: false, parts: vegetation}).parts);
      if (structures.length) add('other-structure', 'kit shapes without explicit vegetation type; no name-based building inference',
        generateKit(assetId, {...recipe, merge: false, parts: structures}).parts);
    }
  } else {
    throw new Error(`Unsupported actual placement kind ${kind}: ${assetId}`);
  }
  models[assetId] = {
    sourceKind: kind,
    descriptorPath: relative(root, descriptorPath), descriptorSha256: hash(await readFile(descriptorPath)),
    sourcePath: relative(root, sourcePath), sourceSha256: hash(await readFile(sourcePath)),
    groups, coreRings,
  };
}
process.stdout.write(JSON.stringify({models}));
"""


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def union_polygons(polygons):
    if not polygons:
        raise ValueError("No nondegenerate projected polygons")
    result = shapely.union_all(polygons, grid_size=PRECISION_METERS)
    if not result.is_valid:
        raise ValueError(shapely.is_valid_reason(result))
    if result.geom_type not in ("Polygon", "MultiPolygon"):
        raise ValueError(f"Nonpolygon union: {result.geom_type}")
    return result


def project_triangles(triangles, transform=lambda p: p):
    polygons = []
    for triangle in triangles:
        points = [transform(p) for p in triangle]
        poly = Polygon([(p[0], p[2]) for p in points])
        if poly.area > 1e-10:
            polygons.append(poly)
    return union_polygons(polygons)


def normalize(q):
    length = math.sqrt(sum(q[k]**2 for k in ('x', 'y', 'z', 'w')))
    if not math.isfinite(length) or length < 1e-10:
        raise ValueError('Invalid placement quaternion')
    return {k: q[k]/length for k in ('x', 'y', 'z', 'w')}


def transform_point(point, position, q):
    x, y, z = point
    tx = 2 * (q['y']*z-q['z']*y)
    ty = 2 * (q['z']*x-q['x']*z)
    tz = 2 * (q['x']*y-q['y']*x)
    return [position['x'] + x+q['w']*tx+q['y']*tz-q['z']*ty,
            position['y'] + y+q['w']*ty+q['z']*tx-q['x']*tz,
            position['z'] + z+q['w']*tz+q['x']*ty-q['y']*tx]


def hole_count(geometry):
    if geometry.geom_type == 'Polygon':
        return len(geometry.interiors)
    return sum(len(p.interiors) for p in geometry.geoms)


def main():
    snapshot_path = ROOT/'data/map-layout.json'
    snapshot = json.loads(snapshot_path.read_text())
    result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-'],
                            input=JS, text=True, cwd=ROOT, capture_output=True, check=True)
    models = json.loads(result.stdout)['models']
    prototypes = {}
    for asset_id, model in models.items():
        prototypes[asset_id] = [project_triangles(g['triangles']) for g in model['groups']]
        if model['coreRings']:
            model['core'] = union_polygons([Polygon(r) for r in model['coreRings']])
    features, errors, tilted = [], [], []
    for instance in snapshot['instances']:
        if not instance['enabled']:
            continue
        asset_id = instance['assetId']
        model = models[asset_id]
        p, q = instance['position'], normalize(instance['rotation'])
        yaw_only = abs(q['x']) < 1e-12 and abs(q['z']) < 1e-12
        if not yaw_only:
            tilted.append(instance['entityId'])
        # The full quaternion fallback handles pitched/rolled graphics without flattening first.
        affine = [1-2*q['y']**2, 2*q['y']*q['w'], -2*q['y']*q['w'], 1-2*q['y']**2, p['x'], p['z']]
        for index, group in enumerate(model['groups']):
            geometry = (affinity.affine_transform(prototypes[asset_id][index], affine) if yaw_only
                        else project_triangles(group['triangles'], lambda v: transform_point(v,p,q)))
            if not geometry.is_valid:
                raise ValueError(f"Invalid world mask: {instance['entityId']}")
            properties = {
                'entityId': instance['entityId'], 'assetId': asset_id,
                'category': group['category'], 'classification': group['classification'],
                'sourceKind': model['sourceKind'], 'instanceRevision': instance['instanceRevision'],
                'position': p, 'rotation': instance['rotation'],
                'areaM2': geometry.area, 'holes': hole_count(geometry),
                'bufferMetersApplied': 0,
            }
            if group['category']=='building' and yaw_only:
                core = affinity.affine_transform(model['core'], affine)
                properties['bodyFootprintGeometry'] = mapping(core)
                properties['bodyFootprintAreaM2'] = core.area
                properties['bodyFootprintHoles'] = hole_count(core)
            features.append({'type':'Feature', 'id':instance['entityId']+':'+group['category'],
                             'properties':properties, 'geometry':mapping(geometry)})
    kinds = collections.Counter(model['sourceKind'] for model in models.values())
    category_counts = collections.Counter(f['properties']['category'] for f in features)
    source_files = ['data/map-layout.json', 'content/buildings/ring-block/catalog.json',
                    'tools/world-build/src/city.ts', 'tools/world-build/src/kit.ts',
                    'tools/world-build/src/tree-instances.ts', 'packages/contracts/src/world-grid.ts']
    document = {
        'type':'FeatureCollection',
        'metadata': {
            'purpose':'Unbuffered diagnostic surface exclusion masks, not foundation support rules or a verified historical DSM object inventory',
            'coordinateSystem':'Game XZ metres (east, south); GeoJSON coordinates are [x,z], NOT EPSG:4326',
            'sourceRevision': snapshot['revision'], 'assetReleaseVersion':snapshot['assetReleaseVersion'],
            'inputs': {p:sha(ROOT/p) for p in source_files},
            'reproduction': 'uv run tools/build-ring-object-masks.py (repository Node dependencies must be installed)',
            'generatorScriptSha256':sha(Path(__file__)), 'shapelyVersion':shapely.__version__,
            'method':'Run actual generateFootprint/generateKit; project visual triangle surfaces, union per model, apply normalized instance quaternion. Full 3D projection fallback for tilted instances. Ground absent from editable snapshot.',
            'coreMethod':'For footprint body masks, union sections outlines when present; otherwise outline. Current format has no explicit holes field. Any union holes are retained. Elevated sections remain excluded because they occlude a DSM from above.',
            'precisionGridMeters':PRECISION_METERS,
            'enabledInstanceCount':sum(i['enabled'] for i in snapshot['instances']),
            'representedInstanceCount':len(set(f['properties']['entityId'] for f in features)),
            'assetCount':len(models), 'assetSourceKinds':dict(kinds), 'featureCounts':dict(category_counts),
            'tiltedInstances':tilted, 'omissions':errors,
            'bufferGuidance':'No buffer is baked. Compare 0, 2 and 4 m positive buffers by category as diagnostic sensitivity; these distances are assumptions, not measured registration error. Rasterize complete polygons with holes, then use a Euclidean distance transform if buffering on a grid.',
            'limitations':[
                'Current authored graphics approximate real structures and vegetation; source DSM dates are 2018-2020 while layout is current.',
                'No claim that all real roofs, tree crowns, parked vehicles or temporary structures are represented.',
                'Vegetation uses the validated treeRenderRecipe profile or explicit KitShape.foliage; other kit geometry is other-structure without guessed building classification.',
                'Masks include visible overhangs and all elevated geometry; they do not identify ground contact, walkable arches, doors or load-bearing foundations.',
                'Body footprints omit facade/roof extras, whereas feature.geometry includes all projected generated graphics.',
            ],
            'assets':{key:{k:v for k,v in model.items() if k not in ('groups','coreRings','core')} for key,model in models.items()},
        },
        'features':features,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(document,ensure_ascii=False,separators=(',',':'))+'\n')
    reread=json.loads(OUT.read_text())
    assert len(reread['features'])==len(features)
    assert document['metadata']['enabledInstanceCount']==document['metadata']['representedInstanceCount']
    pilot=next(f for f in features if f['properties']['entityId']=='osm-way-1258973447')
    print(json.dumps({'output':str(OUT.relative_to(ROOT)),'bytes':OUT.stat().st_size,'sha256':sha(OUT),
                     'assetSourceKinds':dict(kinds),'featureCounts':dict(category_counts),
                     'representedInstances':document['metadata']['representedInstanceCount'],
                     'tiltedInstances':tilted,'pilot':pilot['properties']},ensure_ascii=False))


if __name__=='__main__':
    main()
