# /// script
# requires-python = ">=3.13"
# dependencies = ["rasterio==1.5.2", "pyproj==3.8.0", "numpy==2.5.4", "scipy==1.18.1", "matplotlib==3.11.2"]
# ///
"""Relative DSM/footprint alignment diagnostic; not ground-control validation."""
import json, math, os, hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/"output/ring-terrain-stage0"
os.environ.setdefault('MPLCONFIGDIR',str(OUT/'matplotlib-cache'))
import numpy as np
import rasterio
from scipy.ndimage import map_coordinates, minimum_filter
from pyproj import Transformer
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

origin=[50.815951774241576,61.66386729706631]
def project(x,z):
 return Transformer.from_crs(4326,3413,always_xy=True).transform(origin[0]+x/52837.29,origin[1]-z/110573.15)
with rasterio.open(OUT/'arcticdem-dem-crop.tif') as ds:
 dem=ds.read(1).astype(float); tf=ds.transform
def sample(points):
 x,y=project(points[:,0],points[:,1]); col,row=~tf*(x,y)
 return map_coordinates(dem,[row-.5,col-.5],order=1,mode='constant',cval=np.nan)

base=ROOT/'content/buildings/ring-block'
catalog=json.loads((base/'catalog.json').read_text())['assets']
placements=json.loads((ROOT/'content/worlds/ring-block/cells/0_0.json').read_text())['buildings']
buildings=[];excluded=[];all_footprints=0
for p in placements:
 af=base/catalog[p['assetId']]; a=json.loads(af.read_text())
 if a['source'].get('kind')!='footprint':continue
 s=json.loads((af.parent/a['source']['file']).read_text()); q=p['rotation'];all_footprints+=1
 if s.get('sections'):
  excluded.append({'id':p['entityId'],'reason':'compound recipe: top-level outline is not authoritative body geometry','section_count':len(s['sections'])})
  continue
 theta=2*math.atan2(q['y'],q['w']); cs,sn=math.cos(theta),math.sin(theta)
 raw=np.array(s['outline']); poly=raw@np.array([[cs,-sn],[sn,cs]])+np.array([p['position']['x'],p['position']['z']])
 area=.5*np.sum(poly[:,0]*np.roll(poly[:,1],-1)-poly[:,1]*np.roll(poly[:,0],-1))
 buildings.append({'id':p['entityId'],'poly':poly,'area':abs(area),'height':s['height'], 'center':poly.mean(axis=0),'orientation':np.sign(area)})

selected=[]; ins=[]; outs=[]; slices=[]
for b in buildings:
 if b['height']<6 or b['area']<200:continue
 inside=[];outside=[]
 for first,last in zip(b['poly'],np.roll(b['poly'],-1,axis=0)):
  vec=last-first; length=np.linalg.norm(vec)
  if length<8:continue
  n=np.array([vec[1],-vec[0]])/length*b['orientation']
  # Avoid vertices; long straight edges contribute samples every ~4m.
  for along in np.arange(4,length-3,4):
   p=first+vec*along/length
   if not(-245<p[0]<307 and -721<p[1]<107):continue
   inside.append(p-4*n);outside.append(p+4*n)
 if len(inside)<8:continue
 slices.append(slice(len(ins),len(ins)+len(inside)));ins.extend(inside);outs.extend(outside);selected.append(b)
ins=np.array(ins);outs=np.array(outs)
offsets=np.array([(x,z) for z in range(-20,21,2) for x in range(-20,21,2)])
scores=[]
for offset in offsets:
 contrast=sample(ins+offset)-sample(outs+offset)
 scores.append([float(np.nanmean(np.clip(contrast[sl],-10,20))) for sl in slices])
scores=np.array(scores)
zero=int(np.where(np.all(offsets==0,axis=1))[0][0])
def choice(mask):
 a=np.median(scores[:,mask],axis=1);best=int(a.argmax())
 return {'count_buildings':int(np.sum(mask)),'best_source_sampling_offset_xz_m':offsets[best].tolist(),'mean_edge_contrast_m_at_zero':float(a[zero]),'mean_edge_contrast_m_at_best':float(a[best]),'index':best}
centers=np.array([b['center'] for b in selected])
allmask=np.ones(len(selected),dtype=bool)
report={'purpose':'Relative alignment diagnostic only; no surveyed control, no automatic correction',
 'sourceSamplingOffsetMeaning':'DSM is sampled at model X+dx,Z+dz. A positive result is a diagnostic optimum, not an authorized georeference change.',
 'method':'Current simple footprint geometries only; compound recipes with sections excluded because top-level outlines are not authoritative body geometry. Buildings>=6m high and >=200m2, edges>=8m; samples 4m inside/outside every4m, away from vertices/map boundary. Per building mean clipped contrast [-10,20]; aggregate median across buildings. Translation search +/-20m step2m.',
 'n_all_footprints':all_footprints,'n_simple_footprints':len(buildings),'excluded_compound_recipes':excluded,'n_selected_buildings':len(selected),'n_edge_samples':len(ins),'overall':choice(allmask),
 'spatial_groups':{}}
for name,mask in [('north',centers[:,1]<-307),('south',centers[:,1]>=-307),('west',centers[:,0]<31),('east',centers[:,0]>=31)]:
 report['spatial_groups'][name]=choice(mask)
train=np.array([int(hashlib.sha256(b['id'].encode()).hexdigest()[:8],16)%2==0 for b in selected]);test=~train
train_choice=choice(train);i=train_choice['index']
report['building_holdout']={'train':train_choice,'test_at_train_offset':float(np.median(scores[i,test])),'test_at_zero':float(np.median(scores[zero,test])), 'test_independent_best':choice(test),'note':'building holdout checks alignment consistency; does not measure geodetic truth'}
report['individual_buildings']=[{'id':b['id'],'center_xz':b['center'].tolist(),'area_m2':b['area'],'height_m':b['height'],'edge_samples':sl.stop-sl.start,'best_offset':offsets[scores[:,k].argmax()].tolist(),'zero_contrast':float(scores[zero,k]),'best_contrast':float(scores[:,k].max())} for k,(b,sl) in enumerate(zip(selected,slices))]

# Explain high road samples by nearest model footprint and local DSM envelope.
source=json.loads((OUT/'source-inspection.json').read_text())
report['highest_road_context']=[]
for h in source['highestRoadSamplesForReview']:
 p=np.array([h['x'],h['z']]);dist=[]
 for b in buildings:
  a=b['poly'];v=np.roll(a,-1,axis=0)-a;t=np.clip(((p-a)*v).sum(axis=1)/(v*v).sum(axis=1),0,1)
  d=np.linalg.norm(p-a-v*t[:,None],axis=1).min();dist.append((d,b['id']))
 nearby=np.array([p+[dx,dz] for dz in range(-10,11,2) for dx in range(-10,11,2)])
 vals=sample(nearby)
 report['highest_road_context'].append({**h,'nearest_footprint_boundary_m':float(min(dist)[0]),'nearest_building':min(dist)[1],'local_20m_DSM_min_p10_median_max':np.nanpercentile(vals,[0,10,50,100]).tolist()})
(OUT/'alignment-diagnostic.json').write_text(json.dumps(report,indent=2)+'\n')

fig,axes=plt.subplots(1,3,figsize=(15,9),layout='constrained')
xs=np.arange(-269,332,2);zs=np.arange(-745,132,2);xx,zz=np.meshgrid(xs,zs);pts=np.column_stack([xx.ravel(),zz.ravel()])
best=offsets[report['overall']['index']]
for ax,offset,title in zip(axes[:2],[np.array([0,0]),best],['Current registration',f'Diagnostic optimum sampling offset {best.tolist()} m']):
 vals=sample(pts+offset).reshape(xx.shape)
 ax.imshow(vals,extent=[-270,332,132,-746],cmap='terrain',vmin=120,vmax=160)
 for b in buildings:
  poly=np.vstack([b['poly'],b['poly'][0]]);ax.plot(poly[:,0],poly[:,1],color='black',lw=.5,alpha=.8)
 ax.set(xlim=(-269,331),ylim=(131,-745),title=title,xlabel='X east / m',ylabel='Z south / m')
a=np.median(scores,axis=1).reshape(21,21)
im=axes[2].imshow(a,extent=[-21,21,21,-21],cmap='viridis');axes[2].scatter([0,best[0]],[0,best[1]],c=['red','white'])
axes[2].set(title='Median building edge contrast / m',xlabel='Source sample dx / m',ylabel='Source sample dz / m');fig.colorbar(im,ax=axes[2],shrink=.5)
fig.savefig(OUT/'alignment-preview.png',dpi=150)
print(json.dumps({k:report[k] for k in ['n_selected_buildings','n_edge_samples','overall','spatial_groups','building_holdout','highest_road_context']},indent=2))
