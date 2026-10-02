// 零件批处理：同一刚体（关节 Group）上、同一材质的静态零件合并成一个网格。
// 机器人有上千个零件（螺钉、鳍片、法兰、板件），逐个建 Mesh 会产生上千次 draw call；
// 按"刚体 × 材质"合批后整机只剩百余次，阴影与 AO 通道的开销同步下降。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const tmp = new THREE.Object3D();

/** 统一属性布局（position/normal/uv，非索引），保证可合并。 */
function normalize(geometry) {
  let g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) {
    const count = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  for (const name of Object.keys(g.attributes)) {
    if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  }
  g.morphAttributes = {};
  g.clearGroups();
  sanitizeNormals(g);
  return g;
}

/**
 * 退化顶点（车削件轴线、穹顶顶点）的法线可能为零向量，着色器里 normalize 会得到 NaN，
 * 再被 Bloom 模糊扩散成整屏黑。这里把零法线替换为所在三角形的面法线。
 * 适用于非索引几何。
 */
export function sanitizeNormals(g) {
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const face = new THREE.Vector3();
  let fixed = 0;
  for (let i = 0; i < nrm.count; i++) {
    const l = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    if (l > 1e-6 && Number.isFinite(l)) continue;
    const t = i - (i % 3);
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    face.subVectors(c, b).cross(a.sub(b));
    if (face.lengthSq() < 1e-20) face.set(0, 1, 0);
    face.normalize();
    nrm.setXYZ(i, face.x, face.y, face.z);
    fixed++;
  }
  if (fixed) nrm.needsUpdate = true;
  return fixed;
}

export class PartSink {
  constructor() {
    /** @type {Map<THREE.Object3D, Map<THREE.Material, THREE.BufferGeometry[]>>} */
    this.buckets = new Map();
    this.partCount = 0;
  }

  /**
   * 登记一个静态零件。
   * @param {THREE.Object3D} body  所属刚体（关节 Group）
   * @param {THREE.BufferGeometry} geometry
   * @param {THREE.Material} material
   * @param {{p?:number[], r?:number[], s?:number[]|number}} [xf] 相对 body 的位姿
   */
  add(body, geometry, material, xf = {}) {
    tmp.position.set(...(xf.p ?? [0, 0, 0]));
    tmp.rotation.set(...(xf.r ?? [0, 0, 0]));
    const s = xf.s ?? 1;
    if (Array.isArray(s)) tmp.scale.set(...s); else tmp.scale.setScalar(s);
    tmp.updateMatrix();
    const g = normalize(geometry.clone());
    g.applyMatrix4(tmp.matrix);
    if (!this.buckets.has(body)) this.buckets.set(body, new Map());
    const byMat = this.buckets.get(body);
    if (!byMat.has(material)) byMat.set(material, []);
    byMat.get(material).push(g);
    this.partCount++;
    return g;
  }

  /** 合批：每个刚体每种材质生成一个 Mesh。 */
  flush() {
    let meshes = 0;
    for (const [body, byMat] of this.buckets) {
      for (const [material, list] of byMat) {
        const merged = mergeGeometries(list, false);
        if (!merged) continue;
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, material);
        mesh.name = `${body.name || 'body'}:${material.name || 'mat'}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.batched = true;
        body.add(mesh);
        meshes++;
        for (const g of list) g.dispose();
      }
    }
    this.buckets.clear();
    return meshes;
  }
}
