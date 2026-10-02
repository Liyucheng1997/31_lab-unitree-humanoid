// 标准工程零件库：关节执行器模组、螺栓圈、航插、风扇、轴承座……
// 执行器外形尺寸由 description.js 的电机档位决定——模型就是关节表的可视化。
import * as THREE from 'three';
import { MAT } from './materials.js?v=20261002-eng-v1';
import { lathe, cyl, roundedBox, capScrew, hexSocket } from './geometry.js?v=20261002-eng-v1';

// 执行器外形（米）：R 外壳半径，L 轴向长度。对应 MOTORS 档位。
export const ACTUATOR_SIZE = {
  J120: { R: 0.049, L: 0.052, bolts: 10 },
  J27:  { R: 0.035, L: 0.042, bolts: 8 },
  J9:   { R: 0.021, L: 0.03,  bolts: 6 },
};

const PROXY_MAT = new THREE.MeshBasicMaterial({ visible: false });

const AXIS_ROT = {
  // 把 +Y 朝向的零件转到指定轴向（dir=+1 / -1）
  x: (d) => [0, 0, d > 0 ? -Math.PI / 2 : Math.PI / 2],
  y: (d) => [d > 0 ? 0 : Math.PI, 0, 0],
  z: (d) => [d > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0],
};

/** 在局部 +Y 朝外的圆周上布置 n 颗内六角螺钉（含六角孔）。 */
export function boltCircle(sink, body, { n, radius, y, d = 0.0045, xf, phase = 0, flip = false }) {
  const m = new THREE.Matrix4();
  const parts = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const screw = capScrew(d);
    const hole = hexSocket(d);
    if (flip) { screw.rotateX(Math.PI); hole.rotateX(Math.PI); }
    m.makeTranslation(Math.cos(a) * radius, y, Math.sin(a) * radius);
    screw.applyMatrix4(m);
    hole.applyMatrix4(m);
    parts.push(screw, hole);
    sink.add(body, screw, MAT.alu, xf);
    sink.add(body, hole, MAT.rubber, xf);
  }
  return parts;
}

/**
 * 关节执行器模组（准直驱行星减速电机）。
 * 定子壳体 + 散热筋 + 后端盖/编码器罩归 housingBody，输出法兰 + 螺栓圈归 outputBody，
 * 两者共享关节轴线，所以关节转动时只有法兰在转——和实物完全一致。
 *
 * @param {PartSink} sink
 * @param {Object} o
 * @param {string} o.motor       'J120' | 'J27' | 'J9'
 * @param {'x'|'y'|'z'} o.axis    转轴
 * @param {1|-1} o.dir            输出端朝向（沿轴正/负方向）
 * @param {number[]} o.at         模组中心（关节系，位于转轴上）
 * @param {THREE.Object3D} o.housingBody
 * @param {number[]} [o.housingOffset] 关节原点在 housingBody 中的位置
 * @param {THREE.Object3D} o.outputBody  （原点 = 关节原点）
 * @param {number[]} [o.outputAt] 模组中心在 outputBody 中的位置（缺省同 at）
 * @param {string} [o.joint]      关节名，用于负载指示灯
 * @param {number} [o.scaleL=1]   轴向长度缩放（扁平盘式电机用）
 * @returns {{ring: THREE.Mesh, joint?: string}}
 */
export function actuator(sink, o) {
  const size = ACTUATOR_SIZE[o.motor];
  const R = size.R;
  const L = size.L * (o.scaleL ?? 1);
  const h = L / 2;
  const off = o.housingOffset ?? [0, 0, 0];
  const r = AXIS_ROT[o.axis](o.dir);
  const hp = [o.at[0] + off[0], o.at[1] + off[1], o.at[2] + off[2]];
  const hxf = { p: hp, r };
  const oxf = { p: o.outputAt ?? o.at, r };
  const ch = Math.min(0.004, R * 0.12);

  // 定子壳：喷砂枪灰，带三道散热筋
  const ribs = [];
  const ribN = R > 0.03 ? 3 : 2;
  for (let i = 0; i < ribN; i++) {
    const y = -h + L * (0.3 + 0.18 * i);
    ribs.push([R, y - 0.0018], [R + 0.0022, y - 0.001], [R + 0.0022, y + 0.001], [R, y + 0.0018]);
  }
  sink.add(o.housingBody, lathe([
    [R * 0.78, -h], [R - ch, -h], [R, -h + ch], ...ribs,
    [R, h - 0.007], [R * 0.95, h - 0.0045],
  ], 44), MAT.gunmetal, hxf);
  // 后端盖 + 编码器罩（黑色阳极）
  sink.add(o.housingBody, lathe([
    [0, -h - 0.007], [R * 0.36, -h - 0.007], [R * 0.4, -h - 0.004], [R * 0.4, -h - 0.002],
    [R * 0.74, -h - 0.002], [R * 0.8, -h + 0.0015], [R * 0.78, -h + 0.002],
  ], 36), MAT.frame, hxf);
  boltCircle(sink, o.housingBody, {
    n: Math.max(4, size.bolts - 2), radius: R * 0.6, y: -h - 0.002,
    d: R * 0.09, xf: hxf, phase: 0.3, flip: true,
  });
  // 侧面航插（橙色）+ 线缆出口
  const plug = cyl(R * 0.16, R * 0.16, R * 0.32, 14);
  plug.rotateZ(Math.PI / 2);
  plug.translate(R + R * 0.12, -h * 0.35, 0);
  sink.add(o.housingBody, plug, MAT.accent, hxf);
  const plugCap = cyl(R * 0.11, R * 0.11, R * 0.08, 12);
  plugCap.rotateZ(Math.PI / 2);
  plugCap.translate(R + R * 0.31, -h * 0.35, 0);
  sink.add(o.housingBody, plugCap, MAT.alu, hxf);

  // 输出法兰（机加工铝，拉丝纹理）+ 交叉滚子轴承暗缝
  sink.add(o.outputBody, lathe([
    [R * 0.93, h - 0.0042], [R * 0.95, h - 0.001], [R * 0.9, h + 0.0035],
    [R * 0.52, h + 0.0035], [R * 0.47, h + 0.006], [R * 0.24, h + 0.006],
    [R * 0.2, h + 0.0035], [0, h + 0.0035],
  ], 44), MAT.alu, oxf);
  sink.add(o.outputBody, lathe([
    [R * 0.955, h - 0.0058], [R * 0.955, h - 0.0042], [R * 0.93, h - 0.0042],
  ], 44), MAT.rubber, oxf);
  boltCircle(sink, o.outputBody, {
    n: size.bolts, radius: R * 0.72, y: h + 0.0035, d: R * 0.1, xf: oxf,
  });

  // 负载指示环：单独网格 + 独立材质，由遥测实时着色（青→琥珀→红）
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x35d9ff, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(R * 0.975, R * 0.035, 6, 48), ringMat);
  ring.name = `led:${o.joint ?? o.motor}`;
  const rq = new THREE.Euler(...r);
  ring.position.set(...hp);
  ring.quaternion.setFromEuler(rq);
  // 环面默认在 XY 平面，转到垂直于局部 Y 的平面
  ring.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)));
  ring.translateZ(-(h - 0.0062));
  o.housingBody.add(ring);

  // 检视代理体：不可见的包络圆柱，供鼠标悬停拾取（射线检测不受 visible 影响）
  const proxyGeo = new THREE.CylinderGeometry(R * 1.05, R * 1.05, L + 0.014, 12);
  const proxy = new THREE.Mesh(proxyGeo, PROXY_MAT);
  proxy.visible = false;
  proxy.position.set(...hp);
  proxy.rotation.set(...r);
  proxy.userData.inspect = { joint: o.joint, motor: o.motor };
  o.housingBody.add(proxy);
  return { ring, proxy, joint: o.joint, motor: o.motor };
}

/** 轴承座 / 从动侧支撑（关节另一端的被动轴承）。 */
export function bearingBoss(sink, body, { R, at, axis, dir = 1, mat = MAT.alu }) {
  const xf = { p: at, r: AXIS_ROT[axis](dir) };
  sink.add(body, lathe([
    [R * 0.45, -0.004], [R, -0.004], [R, 0.002], [R * 0.9, 0.006], [R * 0.45, 0.006], [R * 0.4, 0.003], [0, 0.003],
  ], 32), mat, xf);
}

/** 圆形散热风扇（叶轮 + 外框 + 防护格栅），面向 +Z。 */
export function fan(sink, body, { R, at, rot = [0, 0, 0] }) {
  const xf = { p: at, r: rot };
  const frame = roundedBox(R * 2.2, R * 2.2, 0.008, 0.003);
  sink.add(body, frame, MAT.frame, xf);
  const blades = [];
  for (let i = 0; i < 7; i++) {
    const b = new THREE.BoxGeometry(R * 0.78, 0.0012, 0.006);
    b.translate(R * 0.5, 0, 0);
    b.rotateX(0.5);
    b.rotateZ((i / 7) * Math.PI * 2);
    b.translate(0, 0, 0.002);
    blades.push(b);
    sink.add(body, b, MAT.rubber, xf);
  }
  const hub = cyl(R * 0.32, R * 0.32, 0.007, 20);
  hub.rotateX(Math.PI / 2);
  hub.translate(0, 0, 0.003);
  sink.add(body, hub, MAT.graphite, xf);
  for (let k = 1; k <= 3; k++) {
    const g = new THREE.TorusGeometry(R * (0.32 + k * 0.22), 0.0009, 4, 32);
    g.translate(0, 0, 0.0055);
    sink.add(body, g, MAT.alu, xf);
  }
  return blades;
}

/** 平行百叶格栅（XY 平面，叶片沿 X），用于散热进/出风口。 */
export function vent(sink, body, { w, h, slats, at, rot = [0, 0, 0], mat = MAT.frame }) {
  const xf = { p: at, r: rot };
  const pitch = h / slats;
  for (let i = 0; i < slats; i++) {
    const g = roundedBox(w, pitch * 0.42, 0.006, 0.0012, 1);
    g.rotateX(-0.45);
    g.translate(0, -h / 2 + pitch * (i + 0.5), 0);
    sink.add(body, g, mat, xf);
  }
  const back = new THREE.BoxGeometry(w + 0.004, h + 0.004, 0.002);
  back.translate(0, 0, -0.004);
  sink.add(body, back, MAT.rubber, xf);
}

/** 贴花：贴在零件表面的薄片（铭牌、警示标）。 */
export function decal(body, material, { w, h, at, rot = [0, 0, 0] }) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  mesh.position.set(...at);
  mesh.rotation.set(...rot);
  mesh.renderOrder = 2;
  mesh.userData.decal = true;
  body.add(mesh);
  return mesh;
}
