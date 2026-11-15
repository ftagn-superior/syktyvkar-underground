import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Same unique-buffer counter for the frozen v5 renderer; no streaming changes. */
export const frozenGeometryProbe = `(()=>{const buffers=new Set(),indices=new Set();let vertexBytes=0,indexBytes=0,triangles=0;for(const mesh of [...this.scene.meshes,...[...this.buildings.assets.values()].flatMap(a=>a.container?.meshes??[])]){if(!mesh.geometry)continue;for(const vb of Object.values(mesh.geometry.getVertexBuffers()??{})){const b=vb.getBuffer();if(!b||buffers.has(b))continue;buffers.add(b);const d=vb.getData();vertexBytes+=d?(Array.isArray(d)?d.length*4:d.byteLength):mesh.getTotalVertices()*vb.byteStride;}const b=mesh.geometry.getIndexBuffer();if(!b||indices.has(b))continue;indices.add(b);const d=mesh.getIndices();indexBytes+=d?(Array.isArray(d)?d.length*4:d.byteLength):mesh.getTotalIndices()*4;triangles+=mesh.getTotalIndices()/3;}return{vertexBytes,indexBytes,geometryBytes:vertexBytes+indexBytes,triangles,gpuAllocationEstimate:vertexBytes+indexBytes,cpuArrayEstimate:vertexBytes+indexBytes};})()`;
export function adaptFrozenCityLodScript(script: string): string | undefined {
  if (!script.includes('this.zoom=1,this.touchMode=')) return;
  if (!script.includes('geometries:this.scene.geometries.length'))
    throw new Error('Frozen geometry probe marker missing');
  return script
    .replace(
      'this.zoom=1,this.touchMode=',
      'this.zoom=Number(new URLSearchParams(location.search).get("initialZoom"))||1,this.touchMode=',
    )
    .replace(
      'geometries:this.scene.geometries.length',
      `geometry:${frozenGeometryProbe},geometries:this.scene.geometries.length`,
    );
}
export async function copyFrozenCityLodClient(source: string, target: string) {
  await cp(source, target, { recursive: true });
  let count = 0;
  for (const name of await readdir(join(target, 'assets'))) {
    if (!name.endsWith('.js')) continue;
    const path = join(target, 'assets', name),
      patched = adaptFrozenCityLodScript(await readFile(path, 'utf8'));
    if (patched) {
      await writeFile(path, patched);
      count++;
    }
  }
  if (count !== 1) throw new Error('Expected one frozen WorldView measurement adapter');
}
