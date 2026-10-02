// 工程级程序化建模：整机由"关节表 → 执行器模组 → 结构件 → 外壳 → 线束 → 电子"逐层装配。
//
//  ● 执行器：31 个关节各有一台按电机档位（J120/J27/J9）定尺寸的模组，定子归父刚体、
//    输出法兰归子刚体；外壳负载环实时显示力矩/额定比。
//  ● 串联关节链：髋/肩/腰/颈/腕的多轴 Group 被分解成真实的串联级（髋 pitch→roll→yaw
//    等），中间级的支架与电机按分解角运动——外观即机构。
//  ● 并联踝：小腿上两台 J27 经曲柄-连杆推动足部，每帧由闭环方程解算曲柄角。
//  ● 外壳：超椭圆放样的分体壳（真实壁厚 + 分模缝），可 X 光透视、可爆炸分解。
//  ● 合批：同刚体同材质零件合并，上千零件压到百余次 draw call。
//
// 返回的 rig 与旧接口兼容：{ root, joints, face, hands }，并新增
//   update(dt, actuators)  机构同步（串联级 / 连杆 / 负载灯）
//   setXRay(on) / setExplode(t)  工程视图
//   stats                   零件/网格/三角面统计
import * as THREE from 'three';
import { DIM } from './skeleton.js?v=20261002-eng-v1';
import { MAT, setXRay as setMaterialXRay, labelTexture, warningTexture, decalMaterial } from './model/materials.js?v=20261002-eng-v1';
import { PartSink } from './model/PartSink.js?v=20261002-eng-v1';
import {
  loft, curve, lathe, roundedBox, cyl, plate, tube, limbShell,
} from './model/geometry.js?v=20261002-eng-v1';
import { actuator, bearingBoss, fan, vent, decal } from './model/components.js?v=20261002-eng-v1';
import { buildFace } from './model/Face.js?v=20261002-eng-v1';
import { buildHand } from './model/Hand.js?v=20261002-eng-v1';
import { solveCrank } from './model/loftCore.js?v=20261002-eng-v1';

export { EMOTIONS } from './model/Face.js?v=20261002-eng-v1';

const HALF_PI = Math.PI / 2;
const FRONT = HALF_PI;            // 超椭圆角：+Z 正面
const BACK = -HALF_PI;
// 踝驱动曲柄半径（m）。踝 pitch 需覆盖约 ±0.9 rad：足端力臂 40mm 的竖向行程
// 0.04·sin0.9≈31mm，曲柄 42mm 时只需转过 ≈48°，远离 90° 的奇异位形。
const crankRadius = 0.042;

// ------------------------------------------------------------------
// 装配上下文
// ------------------------------------------------------------------
class Assembly {
  constructor() {
    this.sink = new PartSink();
    this.shells = [];       // 可透视 / 可爆炸的外壳面板
    this.actuators = [];    // { ring, joint, motor }
    this.chains = [];       // 串联级同步器
    this.linkages = [];     // 踝并联连杆
    this.decals = [];
  }

  part(body, geometry, material, p, r, s) {
    return this.sink.add(body, geometry, material, { p, r, s });
  }

  /** 外壳面板：独立网格，记录爆炸方向。 */
  shell(body, geometry, material, { explode = [0, 0, 1], dist = 0.07, name = 'shell' } = {}) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.home = mesh.position.clone();
    mesh.userData.explode = new THREE.Vector3(...explode).normalize().multiplyScalar(dist);
    body.add(mesh);
    this.shells.push(mesh);
    return mesh;
  }

  motor(o) {
    const a = actuator(this.sink, o);
    this.actuators.push(a);
    return a;
  }

  /**
   * 把多轴关节 Group 分解成串联级。three 的 Euler 'XYZ' 是 Rx·Ry·Rz；机构的真实
   * 串联顺序（如髋 pitch→roll→yaw = 'XZY'）通过对同一姿态重新做欧拉分解得到，
   * 末级就是关节 Group 本身，所以肢体末端姿态与伺服层输出严格一致。
   */
  chain(parentBody, group, order) {
    const s1 = new THREE.Group();
    s1.name = `${group.name}:stage1`;
    s1.position.copy(group.position);
    parentBody.add(s1);
    const s2 = new THREE.Group();
    s2.name = `${group.name}:stage2`;
    s1.add(s2);
    const e = new THREE.Euler();
    const a0 = order[0].toLowerCase();
    const a1 = order[1].toLowerCase();
    const sync = () => {
      e.setFromQuaternion(group.quaternion, order);
      s1.rotation.set(0, 0, 0);
      s2.rotation.set(0, 0, 0);
      s1.rotation[a0] = e[a0];
      s2.rotation[a1] = e[a1];
    };
    this.chains.push(sync);
    return { s1, s2, sync };
  }
}

// 由 [[y, a, b, z, n], ...] 关键帧得到截面函数 prof(y)
function profileY(keys) {
  const sorted = [...keys].sort((p, q) => p[0] - q[0]);
  const ch = (k, def) => curve(sorted.map((row) => [row[0], row[k] ?? def]));
  const A = ch(1);
  const B = ch(2);
  const Z = ch(3, 0);
  const N = ch(4, 2.6);
  return (y) => ({ a: A(y), b: B(y), z: Z(y), n: N(y) });
}

/** 在截面函数上截取 [y0,y1] 段、角度 arc 的壳体，可整体外扩 grow。 */
function shellGeo(prof, y0, y1, arc, { thickness = 0.0035, grow = 0, radial = 48, segments = 28, x = 0 } = {}) {
  return loft({
    radial, segments, arc, thickness,
    profile: (v) => {
      const y = y0 + (y1 - y0) * v;
      const s = prof(y);
      return { y, a: s.a + grow, b: s.b + grow, x, z: s.z, n: s.n };
    },
  });
}

// 弧度区间：以 center 为中心 ± half
const arcAround = (center, half) => [center - half, center + half];
// 左右镜像弧：右侧把 θ 映射为 π−θ
const sideArc = (s, center, half) => (s > 0 ? arcAround(center, half) : arcAround(Math.PI - center, half));

// ------------------------------------------------------------------
// 骨盆
// ------------------------------------------------------------------
function buildPelvis(A, root) {
  // 中央承力框：两台髋 pitch 电机背靠背安装其上
  A.part(root, roundedBox(0.05, 0.11, 0.13, 0.008), MAT.frame, [0, -0.02, 0]);
  A.part(root, plate({
    topW: 0.2, bottomW: 0.16, height: 0.13, depth: 0.008, radius: 0.012,
    holes: [{ w: 0.05, h: 0.05, x: -0.045, y: 0.0 }, { w: 0.05, h: 0.05, x: 0.045, y: 0.0 }],
  }), MAT.frame, [0, 0.0, -0.068]);
  // IMU 惯性测量单元（橙色标识）+ 线束接线盒
  A.part(root, roundedBox(0.036, 0.016, 0.03, 0.003), MAT.accent, [0, 0.044, 0.025]);
  A.part(root, roundedBox(0.026, 0.004, 0.02, 0.0015), MAT.pcb, [0, 0.054, 0.025]);
  A.part(root, roundedBox(0.07, 0.03, 0.03, 0.004), MAT.graphite, [0, 0.04, -0.035]);

  // 骨盆壳：方度较高的超椭圆（n≈3.4），侧面收紧，避免"尿布"式鼓包
  const prof = profileY([
    [-0.088, 0.1, 0.07, 0.0, 3.0],
    [-0.045, 0.122, 0.088, 0.002, 3.4],
    [0.015, 0.128, 0.094, 0.0, 3.6],
    [0.062, 0.118, 0.09, -0.004, 3.4],
  ]);
  // 前裆甲（白）+ 后臀甲（石墨）+ 左右侧裙（石墨）
  A.shell(root, shellGeo(prof, -0.084, 0.058, arcAround(FRONT, 0.92), { thickness: 0.004 }), MAT.shell,
    { explode: [0, -0.2, 1], name: 'pelvis-front' });
  A.shell(root, shellGeo(prof, -0.07, 0.058, arcAround(BACK, 0.9), { grow: 0.016, thickness: 0.004 }), MAT.graphite,
    { explode: [0, 0, -1], name: 'pelvis-back' });
  for (const s of [1, -1]) {
    A.shell(root, shellGeo(prof, -0.03, 0.056, sideArc(s, 0, 0.56), { grow: 0.003 }), MAT.graphite,
      { explode: [s, 0, 0], name: 'pelvis-side' });
  }
  // 前裆甲中央分模筋（石墨）
  A.part(root, roundedBox(0.022, 0.1, 0.01, 0.004), MAT.graphite, [0, -0.02, 0.092]);
  // 腰带亮条
  A.part(root, roundedBox(0.06, 0.005, 0.004, 0.0018, 1), MAT.ledSoft, [0, 0.03, 0.111]);
}

// ------------------------------------------------------------------
// 腰（3 轴：yaw → roll → pitch）与躯干
// ------------------------------------------------------------------
function buildWaist(A, root, waist, joints) {
  joints.waist = waist;
  const W = waist.position.toArray();
  const ch = A.chain(root, waist, 'YZX');

  A.motor({ motor: 'J120', axis: 'y', dir: 1, at: [0, -0.006, 0], scaleL: 0.66,
    housingBody: root, housingOffset: W, outputBody: ch.s1, joint: 'torso_joint' });
  A.motor({ motor: 'J120', axis: 'z', dir: 1, at: [0, 0.0, -0.078], scaleL: 0.72,
    housingBody: ch.s1, outputBody: ch.s2, joint: 'torso_roll_joint' });
  A.motor({ motor: 'J120', axis: 'x', dir: -1, at: [0.078, 0.0, 0], scaleL: 0.72,
    housingBody: ch.s2, outputBody: waist, joint: 'torso_pitch_joint' });
  bearingBoss(A.sink, ch.s2, { R: 0.03, at: [-0.06, 0, 0], axis: 'x', dir: -1 });

  // 级间支架
  A.part(ch.s1, roundedBox(0.09, 0.012, 0.11, 0.004), MAT.frame, [0, 0.022, -0.035]);
  A.part(ch.s1, roundedBox(0.07, 0.06, 0.01, 0.004), MAT.frame, [0, 0.0, -0.106]);
  for (const s of [1, -1]) {
    A.part(ch.s2, plate({ topW: 0.06, bottomW: 0.075, height: 0.08, depth: 0.008, radius: 0.01,
      holes: [{ circle: 0.016, x: 0, y: 0 }] }), MAT.frame, [s * 0.108, 0.0, -0.01], [0, HALF_PI, 0]);
  }
  A.part(ch.s2, roundedBox(0.22, 0.01, 0.05, 0.004), MAT.frame, [0, -0.04, -0.035]);

  // 躯干底板 + 左右脊柱侧板（减重孔）+ 肩横梁
  A.part(waist, roundedBox(0.2, 0.01, 0.13, 0.004), MAT.frame, [0, 0.055, -0.005]);
  for (const s of [1, -1]) {
    A.part(waist, plate({
      topW: 0.12, bottomW: 0.12, height: 0.29, depth: 0.007, radius: 0.012,
      holes: [
        { w: 0.07, h: 0.07, x: 0, y: 0.08 }, { w: 0.07, h: 0.07, x: 0, y: -0.01 },
        { w: 0.07, h: 0.05, x: 0, y: -0.09 },
      ],
    }), MAT.frame, [s * 0.062, 0.205, -0.008], [0, HALF_PI, 0]);
  }
  const beam = cyl(0.015, 0.015, 0.25, 20);
  beam.rotateZ(HALF_PI);
  A.part(waist, beam, MAT.carbon, [0, DIM.torsoH * 0.88, -0.004]);
  A.part(waist, roundedBox(0.16, 0.012, 0.11, 0.004), MAT.frame, [0, 0.37, -0.005]);

  // ---- 电池包（背部快拆）----
  const bat = [0, 0.215, -0.108];
  A.part(waist, roundedBox(0.19, 0.2, 0.052, 0.012, 4), MAT.graphite, bat);
  A.part(waist, roundedBox(0.17, 0.18, 0.004, 0.006), MAT.frame, [0, bat[1], bat[2] - 0.026]);
  for (let i = 0; i < 5; i++) {
    A.part(waist, roundedBox(0.012, 0.005, 0.004, 0.0015, 1), MAT.ledSoft,
      [-0.03 + i * 0.015, bat[1] - 0.07, bat[2] - 0.029]);
  }
  const handle = tube([[-0.05, 0, 0], [-0.045, 0.022, 0], [0, 0.028, 0], [0.045, 0.022, 0], [0.05, 0, 0]], 0.006, 24, 10);
  A.part(waist, handle, MAT.rubber, [0, bat[1] + 0.1, bat[2] - 0.01]);
  for (const s of [1, -1]) {
    A.part(waist, roundedBox(0.012, 0.034, 0.01, 0.003), MAT.accent, [s * 0.087, bat[1] + 0.04, bat[2] - 0.024]);
  }
  // 电池铭牌
  const batLabel = decalMaterial(labelTexture([
    { text: 'LI-ION  48V  15Ah', font: 'bold 34px "Segoe UI", sans-serif' },
    { text: '720Wh · HOT-SWAP · DO NOT PIERCE', font: '22px "Segoe UI", sans-serif' },
  ], { w: 512, h: 128, fg: '#c9d1da' }));
  A.decals.push(decal(waist, batLabel, { w: 0.12, h: 0.03, at: [0, bat[1] + 0.035, bat[2] - 0.0285], rot: [0, Math.PI, 0] }));

  // ---- 主控计算单元（X 光可见）：主板 + SoC 散热器 + 风扇 ----
  A.part(waist, roundedBox(0.13, 0.1, 0.004, 0.002), MAT.pcb, [0, 0.235, 0.03]);
  A.part(waist, roundedBox(0.05, 0.05, 0.006, 0.002), MAT.frame, [0, 0.24, 0.035]);
  for (let i = 0; i < 9; i++) {
    A.part(waist, new THREE.BoxGeometry(0.0016, 0.05, 0.02), MAT.alu, [-0.024 + i * 0.006, 0.24, 0.048]);
  }
  for (let i = 0; i < 4; i++) {
    A.part(waist, roundedBox(0.012, 0.022, 0.003, 0.001), MAT.frame, [0.04, 0.2 + i * 0.025 - 0.03, 0.034]);
  }
  fan(A.sink, waist, { R: 0.024, at: [0.042, 0.255, 0.04] });
  // 电源分配板 + 母排
  A.part(waist, roundedBox(0.1, 0.05, 0.004, 0.002), MAT.pcb, [0, 0.12, 0.03]);
  A.part(waist, new THREE.BoxGeometry(0.08, 0.006, 0.003), MAT.copper, [0, 0.135, 0.034]);
  A.part(waist, new THREE.BoxGeometry(0.08, 0.006, 0.003), MAT.copper, [0, 0.105, 0.034]);

  // ---- 躯干外壳：胸甲 / 侧甲 / 背甲 / 腹甲 ----
  const prof = profileY([
    [0.105, 0.114, 0.082, 0.004, 2.7],
    [0.19, 0.126, 0.088, 0.008, 2.8],
    [0.27, 0.146, 0.096, 0.011, 2.9],
    [0.33, 0.152, 0.096, 0.008, 3.0],
    [0.375, 0.13, 0.083, 0.0, 2.8],
    [0.41, 0.07, 0.056, -0.004, 2.4],
  ]);
  // 胸甲上下分体：3mm 分模缝
  A.shell(waist, shellGeo(prof, 0.112, 0.236, arcAround(FRONT, 1.2), { thickness: 0.004, segments: 16 }),
    MAT.shell, { explode: [0, -0.3, 1], dist: 0.09, name: 'chest-lower' });
  A.shell(waist, shellGeo(prof, 0.24, 0.408, arcAround(FRONT, 1.2), { thickness: 0.004, segments: 24 }),
    MAT.shell, { explode: [0, 0.3, 1], dist: 0.09, name: 'chest-upper' });
  A.shell(waist, shellGeo(prof, 0.12, 0.408, arcAround(BACK, 1.02), { thickness: 0.004, segments: 36 }),
    MAT.shell, { explode: [0, 0, -1], dist: 0.11, name: 'chest-back' });
  for (const s of [1, -1]) {
    A.shell(waist, shellGeo(prof, 0.12, 0.29, sideArc(s, 0, 0.29), { grow: -0.002 }), MAT.graphite,
      { explode: [s, 0, 0], dist: 0.08, name: 'chest-side' });
    // 侧面散热格栅（风道入口）+ 内部风扇
    vent(A.sink, waist, { w: 0.05, h: 0.09, slats: 7, at: [s * 0.144, 0.2, 0.0], rot: [0, s * HALF_PI, 0] });
    fan(A.sink, waist, { R: 0.02, at: [s * 0.122, 0.2, 0.0], rot: [0, s * HALF_PI, 0] });
  }
  // 腹甲（石墨，随腰 pitch 级运动）
  const abd = profileY([[-0.035, 0.1, 0.07, 0.012, 2.6], [0.04, 0.114, 0.082, 0.012, 2.7], [0.11, 0.118, 0.084, 0.006, 2.7]]);
  A.shell(waist, shellGeo(abd, -0.03, 0.105, arcAround(FRONT, 0.85)), MAT.graphite,
    { explode: [0, -0.3, 1], dist: 0.07, name: 'abdomen' });

  // 胸甲中线表面 z（贴花、灯条贴合曲面）
  const chestZ = (y) => { const p = prof(y); return p.z + p.b + 0.0006; };
  // 胸前灯条 + 铭牌 + 电源键
  A.part(waist, roundedBox(0.07, 0.006, 0.004, 0.002, 1), MAT.led, [0, 0.338, chestZ(0.338) - 0.001]);
  // 胸口电源键：铝环 + 发光按钮
  A.part(waist, cyl(0.0085, 0.0085, 0.004, 28), MAT.alu, [0, 0.296, chestZ(0.296)], [HALF_PI - 0.1, 0, 0]);
  A.part(waist, cyl(0.0058, 0.0058, 0.0045, 28), MAT.ledSoft, [0, 0.296, chestZ(0.296) + 0.0008], [HALF_PI - 0.1, 0, 0]);
  const badge = decalMaterial(labelTexture([
    { text: 'WH-01', font: 'bold 64px "Segoe UI", sans-serif' },
  ], { w: 256, h: 80, fg: '#2b323a', align: 'center' }));
  A.decals.push(decal(waist, badge, { w: 0.06, h: 0.019, at: [0, 0.262, chestZ(0.262)], rot: [-0.04, 0, 0] }));
  const serial = decalMaterial(labelTexture([
    { text: 'S/N 0001-A  ·  31 DOF  ·  35 kg', font: '24px "Consolas", monospace' },
  ], { w: 512, h: 48, fg: '#5a6570' }));
  A.decals.push(decal(waist, serial, { w: 0.08, h: 0.0075, at: [0, 0.222, chestZ(0.222)], rot: [-0.1, 0, 0] }));

  // ---- 躯干内部线束：脊柱两侧主干 ----
  for (const s of [1, -1]) {
    A.part(waist, tube([[s * 0.04, 0.06, -0.06], [s * 0.045, 0.16, -0.065], [s * 0.05, 0.28, -0.06], [s * 0.1, 0.33, -0.04], [s * 0.13, 0.33, -0.02]], 0.007), MAT.cable);
    A.part(waist, tube([[s * 0.03, 0.06, 0.04], [s * 0.035, 0.15, 0.045], [s * 0.03, 0.3, 0.04], [s * 0.012, 0.39, 0.02]], 0.0045), MAT.cable);
  }
  return ch;
}

// ------------------------------------------------------------------
// 头颈：yaw → pitch（头 roll 为编舞用的被动分量）
// ------------------------------------------------------------------
function buildHead(A, waist, neck, joints, rig) {
  joints.head = neck;
  const N = neck.position.toArray();
  const ch = A.chain(waist, neck, 'YXZ');
  A.motor({ motor: 'J9', axis: 'y', dir: 1, at: [0, -0.022, 0],
    housingBody: waist, housingOffset: N, outputBody: ch.s1, joint: 'head_yaw_joint' });
  A.motor({ motor: 'J9', axis: 'x', dir: -1, at: [0.036, 0.0, 0],
    housingBody: ch.s1, outputBody: ch.s2, joint: 'head_pitch_joint' });
  bearingBoss(A.sink, ch.s1, { R: 0.016, at: [-0.03, 0, 0], axis: 'x', dir: 1 });
  for (const s of [1, -1]) {
    A.part(ch.s1, roundedBox(0.006, 0.04, 0.034, 0.002), MAT.frame, [s * 0.026, 0.0, 0]);
  }
  A.part(ch.s1, roundedBox(0.058, 0.006, 0.034, 0.002), MAT.frame, [0, -0.01, 0]);

  // 颈柱 + 波纹护套
  A.part(neck, cyl(0.02, 0.022, 0.05, 24), MAT.frame, [0, 0.03, -0.004]);
  const bellows = [];
  for (let i = 0; i <= 8; i++) {
    const y = i * 0.0045;
    bellows.push([0.026 + (i % 2) * 0.003, y]);
  }
  A.part(neck, lathe(bellows, 32), MAT.rubber, [0, 0.012, -0.004]);

  // 头壳（白）：超椭圆放样，圆顶封口
  const H0 = 0.042;
  const H1 = 0.246;
  const prof = profileY([
    [H0, 0.05, 0.056, 0.004, 2.4],
    [0.07, 0.07, 0.078, 0.006, 2.5],
    [0.11, 0.082, 0.09, 0.006, 2.6],
    [0.16, 0.085, 0.093, 0.002, 2.6],
    [0.205, 0.078, 0.086, -0.004, 2.5],
    [0.232, 0.056, 0.064, -0.008, 2.3],
    [H1, 0.0, 0.0, -0.01, 2.2],
  ]);
  A.shell(neck, loft({
    radial: 64, segments: 40,
    profile: (v) => { const y = H0 + (H1 - H0) * v; const s = prof(y); return { y, ...s, a: s.a, b: s.b }; },
  }), MAT.shell, { explode: [0, 1, 0], dist: 0.02, name: 'head-core' });
  // 下颌与后颈护板（石墨）
  A.shell(neck, shellGeo(prof, H0 + 0.002, 0.085, arcAround(BACK, 1.9), { grow: 0.002, thickness: 0.003 }),
    MAT.graphite, { explode: [0, -1, -1], dist: 0.04, name: 'head-jaw' });

  // 面罩：前向弧面，比头壳外扩 3mm
  const VY0 = 0.088;
  const VY1 = 0.198;
  const VG = 0.0035;
  const visorArc = arcAround(FRONT, 1.08);
  const visor = A.shell(neck, shellGeo(prof, VY0, VY1, visorArc, { grow: VG, thickness: 0.004, radial: 56, segments: 24 }),
    MAT.visor, { explode: [0, 0, 1], dist: 0.06, name: 'visor' });

  // 面罩曲面采样：给 LED 点阵定位
  const surface = (x, y) => {
    const s = prof(y);
    const a = s.a + VG;
    const b = s.b + VG;
    const u = Math.min(Math.abs(x) / a, 0.999);
    const zr = b * Math.pow(1 - Math.pow(u, s.n), 1 / s.n);
    const p = new THREE.Vector3(x, y, s.z + zr);
    const nx = Math.sign(x) * s.n * Math.pow(u, s.n - 1) / a;
    const nz = s.n * Math.pow(zr / b, s.n - 1) / b;
    const n = new THREE.Vector3(nx, 0, nz).normalize();
    return { p, n };
  };
  // LED 点阵挂在面罩上（面罩原点与头部重合），爆炸视图时随面罩一起移出
  rig.face = buildFace(visor, surface, { eyeY: 0.148, eyeX: 0.031, mouthY: 0.108, pitch: 0.0042 });

  // 立体深度相机：双目镜头 + 红外投射器，嵌在面罩上沿
  for (const x of [-0.036, 0, 0.036]) {
    const { p, n } = surface(x, 0.184);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    const e = new THREE.Euler().setFromQuaternion(q);
    const r = x === 0 ? 0.0035 : 0.0055;
    A.part(neck, cyl(r * 1.45, r * 1.45, 0.002, 24), MAT.frame, p.toArray(), e.toArray().slice(0, 3));
    A.part(neck, cyl(r, r, 0.0024, 24), x === 0 ? MAT.accent : MAT.lens, p.clone().addScaledVector(n, 0.0004).toArray(), e.toArray().slice(0, 3));
  }

  // 耳部模组：麦克风阵列格栅 + 状态环
  for (const s of [1, -1]) {
    const x = s * 0.083;
    const ear = lathe([[0, -0.008], [0.019, -0.008], [0.021, -0.004], [0.021, 0.004], [0.017, 0.008], [0, 0.008]], 32);
    ear.rotateZ(-s * HALF_PI);
    A.part(neck, ear, MAT.graphite, [x + s * 0.004, 0.142, -0.008]);
    const grille = lathe([[0, 0.0], [0.013, 0.0]], 24);
    grille.rotateZ(-s * HALF_PI);
    A.part(neck, grille, MAT.rubber, [x + s * 0.0125, 0.142, -0.008]);
    const ring = new THREE.TorusGeometry(0.0165, 0.0012, 6, 32);
    ring.rotateY(HALF_PI);
    A.part(neck, ring, MAT.led, [x + s * 0.0122, 0.142, -0.008]);
  }

  // 头顶后部激光雷达（360° 扫描窗）
  const lidarAt = [0, 0.214, -0.062];
  A.part(neck, lathe([[0, 0], [0.032, 0], [0.033, 0.004], [0.033, 0.006]], 40), MAT.frame, lidarAt, [-0.45, 0, 0]);
  A.part(neck, lathe([[0.031, 0.006], [0.03, 0.02]], 40), MAT.lens, lidarAt, [-0.45, 0, 0]);
  A.part(neck, lathe([[0.03, 0.02], [0.027, 0.025], [0, 0.026]], 40), MAT.frame, lidarAt, [-0.45, 0, 0]);
}

// ------------------------------------------------------------------
// 手臂：肩 pitch → roll → yaw，肘 pitch，腕 yaw → pitch → roll
// ------------------------------------------------------------------
function buildArm(A, waist, side, joints, rig) {
  const s = side === 'L' ? 1 : -1;
  const n = side === 'L' ? 'left' : 'right';

  const shoulder = new THREE.Group();
  shoulder.name = `shoulder${side}`;
  shoulder.position.set(s * DIM.shoulderWidth, DIM.torsoH * 0.88, 0);
  waist.add(shoulder);
  joints[`shoulder${side}`] = shoulder;
  const SP = shoulder.position.toArray();
  const ch = A.chain(waist, shoulder, 'XZY');

  A.motor({ motor: 'J27', axis: 'x', dir: s, at: [-s * 0.06, 0, 0],
    housingBody: waist, housingOffset: SP, outputBody: ch.s1, joint: `${n}_arm_pitch_joint` });
  A.motor({ motor: 'J27', axis: 'z', dir: 1, at: [0, 0, -0.004],
    housingBody: ch.s1, outputBody: ch.s2, joint: `${n}_arm_roll_joint` });
  A.motor({ motor: 'J27', axis: 'y', dir: -1, at: [0, -0.088, 0],
    housingBody: ch.s2, outputBody: shoulder, joint: `${n}_arm_yaw_joint` });

  // pitch 输出 → roll 电机的 C 形支架
  A.part(ch.s1, plate({ topW: 0.066, bottomW: 0.066, height: 0.07, depth: 0.006, radius: 0.012,
    holes: [{ circle: 0.016, x: 0, y: 0 }] }), MAT.frame, [-s * 0.033, 0, -0.004], [0, HALF_PI, 0]);
  A.part(ch.s1, roundedBox(0.04, 0.006, 0.05, 0.002), MAT.frame, [-s * 0.014, 0.038, -0.004]);
  // roll 输出 → yaw 电机的叉形支架
  for (const z of [0.03, -0.038]) {
    A.part(ch.s2, plate({ topW: 0.05, bottomW: 0.064, height: 0.085, depth: 0.006, radius: 0.012,
      holes: [{ w: 0.026, h: 0.03, x: 0, y: 0.0 }] }), MAT.frame, [0, -0.04, z]);
  }
  A.part(ch.s2, roundedBox(0.064, 0.006, 0.074, 0.002), MAT.frame, [0, -0.066, -0.004]);

  // 肩甲：罩住外侧与顶部，随 pitch 级运动
  const capProf = profileY([[-0.045, 0.06, 0.06, 0, 2.2], [0.0, 0.06, 0.06, 0, 2.2], [0.035, 0.05, 0.05, 0, 2.2], [0.058, 0.026, 0.026, 0, 2.1], [0.066, 0, 0, 0, 2]]);
  A.shell(ch.s1, shellGeo(capProf, -0.045, 0.066, sideArc(s, 0, 1.3), { x: s * 0.004, thickness: 0.0035 }),
    MAT.shell, { explode: [s, 0.6, 0], dist: 0.07, name: 'shoulder-cap' });
  A.part(ch.s1, roundedBox(0.004, 0.026, 0.006, 0.0015, 1), MAT.ledSoft, [s * 0.066, 0.004, 0.0]);

  // ---- 上臂 ----
  for (const x of [0.028, -0.028]) {
    A.part(shoulder, plate({ topW: 0.05, bottomW: 0.04, height: 0.17, depth: 0.006, radius: 0.01,
      holes: [{ w: 0.022, h: 0.05, x: 0, y: 0.035 }, { w: 0.018, h: 0.04, x: 0, y: -0.03 }] }),
      MAT.frame, [x, -0.205, 0], [0, HALF_PI, 0]);
  }
  A.part(shoulder, roundedBox(0.064, 0.008, 0.05, 0.003), MAT.frame, [0, -0.118, 0]);
  const upperProf = profileY([[-0.27, 0.036, 0.039, 0.002, 2.4], [-0.2, 0.041, 0.044, 0.004, 2.6], [-0.12, 0.044, 0.047, 0.002, 2.6]]);
  A.shell(shoulder, shellGeo(upperProf, -0.122, -0.268, sideArc(s, 0, 2.55)), MAT.shell,
    { explode: [s, 0, 0.5], dist: 0.07, name: 'upper-arm' });
  A.part(shoulder, tube([[-s * 0.01, -0.12, -0.034], [-s * 0.012, -0.2, -0.04], [-s * 0.006, -0.27, -0.038]], 0.0045, 16, 8), MAT.cable);

  // 肘：J27，定子在上臂，输出在前臂
  const elbow = new THREE.Group();
  elbow.name = `elbow${side}`;
  elbow.position.set(0, -DIM.upperArm, 0);
  shoulder.add(elbow);
  joints[`elbow${side}`] = elbow;
  A.motor({ motor: 'J27', axis: 'x', dir: s, at: [0, 0, 0],
    housingBody: shoulder, housingOffset: elbow.position.toArray(), outputBody: elbow, joint: `${n}_elbow_pitch_joint` });

  // ---- 前臂 ----
  for (const x of [0.033, -0.033]) {
    A.part(elbow, plate({ topW: 0.056, bottomW: 0.034, height: 0.085, depth: 0.006, radius: 0.012,
      holes: [{ circle: 0.012, x: 0, y: 0.02 }] }), MAT.frame, [x, -0.03, 0], [0, HALF_PI, 0]);
  }
  A.part(elbow, roundedBox(0.072, 0.008, 0.036, 0.003), MAT.frame, [0, -0.07, 0]);
  A.part(elbow, cyl(0.015, 0.015, 0.16, 20), MAT.carbon, [0, -0.15, -0.004]);
  const foreProf = profileY([[-0.236, 0.029, 0.031, 0.003, 2.4], [-0.15, 0.034, 0.036, 0.006, 2.6], [-0.06, 0.037, 0.038, 0.004, 2.6]]);
  A.shell(elbow, shellGeo(foreProf, -0.064, -0.236, sideArc(s, 0, 2.5)), MAT.shell,
    { explode: [s, 0, 0.5], dist: 0.07, name: 'forearm' });
  // 肘部后护板
  const elbowCap = profileY([[-0.045, 0.034, 0.042, 0, 2.2], [0, 0.04, 0.048, 0, 2.2], [0.03, 0.03, 0.036, 0, 2.2]]);
  A.shell(elbow, shellGeo(elbowCap, -0.045, 0.03, arcAround(BACK, 0.95), { thickness: 0.003 }), MAT.graphite,
    { explode: [0, 0, -1], dist: 0.05, name: 'elbow-guard' });
  A.part(elbow, tube([[-s * 0.01, -0.06, -0.028], [-s * 0.008, -0.15, -0.026], [0, -0.23, -0.022]], 0.0035, 16, 8), MAT.cable);

  // ---- 腕：前臂 yaw（J9，位于前臂末端）→ pitch → roll ----
  const wrist = new THREE.Group();
  wrist.name = `wrist${side}`;
  wrist.position.set(0, -DIM.foreArm - 0.018, 0);
  elbow.add(wrist);
  joints[`wrist${side}`] = wrist;
  const WP = wrist.position.toArray();
  const wc = A.chain(elbow, wrist, 'YXZ');
  A.motor({ motor: 'J9', axis: 'y', dir: -1, at: [0, 0.046, 0],
    housingBody: elbow, housingOffset: WP, outputBody: wc.s1, joint: `${n}_elbow_yaw_joint` });
  A.motor({ motor: 'J9', axis: 'x', dir: s, at: [0, 0, 0],
    housingBody: wc.s1, outputBody: wc.s2, joint: `${n}_wrist_pitch_joint` });
  A.motor({ motor: 'J9', axis: 'z', dir: -1, at: [0, -0.004, 0.028], scaleL: 0.6,
    housingBody: wc.s2, outputBody: wrist, joint: `${n}_wrist_roll_joint` });
  for (const x of [0.022, -0.022]) {
    A.part(wc.s1, roundedBox(0.005, 0.044, 0.03, 0.002), MAT.frame, [x, 0.008, 0]);
  }
  A.part(wc.s1, roundedBox(0.05, 0.005, 0.03, 0.002), MAT.frame, [0, 0.028, 0]);
  A.part(wc.s2, roundedBox(0.03, 0.03, 0.005, 0.002), MAT.frame, [0, -0.006, 0.016]);

  rig.hands[side] = buildHand(A.sink, wrist, side);
}

// ------------------------------------------------------------------
// 腿：髋 pitch → roll → yaw，膝 pitch，踝并联（双 J27 + 曲柄连杆）
// ------------------------------------------------------------------
function buildLeg(A, root, side, joints) {
  const s = side === 'L' ? 1 : -1;
  const n = side === 'L' ? 'left' : 'right';

  const hip = new THREE.Group();
  hip.name = `hip${side}`;
  hip.position.set(s * DIM.hipWidth * 0.5, -DIM.pelvisH * 0.4, 0);
  root.add(hip);
  joints[`hip${side}`] = hip;
  const HP = hip.position.toArray();
  const ch = A.chain(root, hip, 'XZY');

  A.motor({ motor: 'J120', axis: 'x', dir: s, at: [-s * 0.05, 0, 0],
    housingBody: root, housingOffset: HP, outputBody: ch.s1, joint: `${n}_thigh_pitch_joint` });
  A.motor({ motor: 'J120', axis: 'z', dir: 1, at: [0, 0, -0.074], scaleL: 0.78,
    housingBody: ch.s1, outputBody: ch.s2, joint: `${n}_thigh_roll_joint` });
  A.motor({ motor: 'J120', axis: 'y', dir: -1, at: [0, -0.108, 0], scaleL: 0.82,
    housingBody: ch.s2, outputBody: hip, joint: `${n}_thigh_yaw_joint` });

  // pitch 输出 → roll 电机：C 形支架（侧板 + 顶板 + 背板）
  A.part(ch.s1, plate({ topW: 0.09, bottomW: 0.09, height: 0.1, depth: 0.007, radius: 0.016,
    holes: [{ circle: 0.022, x: 0.012, y: 0 }] }), MAT.frame, [-s * 0.016, 0, -0.012], [0, HALF_PI, 0]);
  A.part(ch.s1, roundedBox(0.06, 0.007, 0.1, 0.003), MAT.frame, [s * 0.012, 0.053, -0.055]);
  A.part(ch.s1, roundedBox(0.06, 0.06, 0.007, 0.003), MAT.frame, [s * 0.012, 0.025, -0.104]);
  // roll 输出 → yaw 电机：L 形支架
  A.part(ch.s2, plate({ topW: 0.08, bottomW: 0.09, height: 0.115, depth: 0.008, radius: 0.014,
    holes: [{ w: 0.04, h: 0.04, x: 0, y: 0.01, r: 0.01 }] }), MAT.frame, [0, -0.035, -0.043]);
  A.part(ch.s2, roundedBox(0.09, 0.007, 0.07, 0.003), MAT.frame, [0, -0.083, -0.012]);

  // ---- 大腿 ----
  A.part(hip, roundedBox(0.09, 0.008, 0.09, 0.004), MAT.frame, [0, -0.142, 0]);
  for (const x of [0.038, -0.038]) {
    A.part(hip, plate({ topW: 0.085, bottomW: 0.11, height: 0.27, depth: 0.007, radius: 0.016,
      holes: [
        { w: 0.04, h: 0.06, x: 0, y: 0.075 }, { w: 0.045, h: 0.065, x: 0, y: -0.005 },
        { circle: 0.015, x: 0, y: -0.08 },
      ] }), MAT.frame, [x, -0.28, 0], [0, HALF_PI, 0]);
  }
  // 大腿后部线束（髋 → 膝）
  A.part(hip, tube([[0, -0.14, -0.05], [-s * 0.01, -0.22, -0.056], [-s * 0.012, -0.31, -0.054], [0, -0.37, -0.05]], 0.0065, 20, 8), MAT.cable);
  A.part(hip, tube([[s * 0.012, -0.15, -0.046], [s * 0.016, -0.25, -0.05], [s * 0.012, -0.36, -0.046]], 0.0042, 20, 8), MAT.cable);

  const thighProf = profileY([
    [-0.362, 0.048, 0.052, 0.008, 2.5],
    [-0.28, 0.056, 0.062, 0.012, 2.7],
    [-0.2, 0.062, 0.068, 0.012, 2.8],
    [-0.13, 0.064, 0.068, 0.006, 2.8],
  ]);
  A.shell(hip, shellGeo(thighProf, -0.136, -0.27, arcAround(FRONT, 1.42), { thickness: 0.0045, segments: 20 }),
    MAT.shell, { explode: [0, 0.2, 1], dist: 0.09, name: 'thigh-upper' });
  A.shell(hip, shellGeo(thighProf, -0.274, -0.358, arcAround(FRONT, 1.36), { thickness: 0.0045, segments: 14 }),
    MAT.shell, { explode: [0, -0.2, 1], dist: 0.09, name: 'thigh-lower' });
  // 大腿外侧石墨嵌条
  A.shell(hip, shellGeo(thighProf, -0.17, -0.33, sideArc(s, 0, 0.16), { grow: 0.0035, thickness: 0.003, segments: 16 }),
    MAT.graphite, { explode: [s, 0, 0], dist: 0.06, name: 'thigh-inlay' });
  A.shell(hip, shellGeo(thighProf, -0.16, -0.33, arcAround(BACK, 0.82), { thickness: 0.0035 }),
    MAT.graphite, { explode: [0, 0, -1], dist: 0.07, name: 'thigh-back' });
  A.part(hip, roundedBox(0.006, 0.09, 0.004, 0.002, 1), MAT.ledSoft, [s * 0.05, -0.24, 0.05]);

  // ---- 膝 / 小腿 ----
  const knee = new THREE.Group();
  knee.name = `knee${side}`;
  knee.position.set(0, -DIM.thigh, 0);
  hip.add(knee);
  joints[`knee${side}`] = knee;
  // 膝：J120，定子在大腿，输出法兰在小腿
  A.motor({ motor: 'J120', axis: 'x', dir: s, at: [0, 0, 0], scaleL: 0.9,
    housingBody: hip, housingOffset: knee.position.toArray(), outputBody: knee, joint: `${n}_knee_joint` });

  for (const x of [0.05, -0.05]) {
    A.part(knee, plate({ topW: 0.08, bottomW: 0.06, height: 0.11, depth: 0.007, radius: 0.026,
      holes: [{ circle: 0.02, x: 0, y: 0.022 }] }), MAT.frame, [x, -0.03, -0.008], [0, HALF_PI, 0]);
  }
  A.part(knee, roundedBox(0.106, 0.01, 0.06, 0.004), MAT.frame, [0, -0.082, -0.01]);
  A.part(knee, cyl(0.017, 0.017, 0.25, 20), MAT.carbon, [0, -0.2, 0.004]);
  A.part(knee, roundedBox(0.04, 0.012, 0.04, 0.004), MAT.frame, [0, -0.327, 0.002]);

  // 膝盖护甲
  const capProf = profileY([[-0.07, 0.044, 0.05, 0.004, 2.4], [-0.01, 0.056, 0.066, 0.004, 2.5], [0.036, 0.04, 0.05, 0.0, 2.3]]);
  A.shell(knee, shellGeo(capProf, -0.07, 0.036, arcAround(FRONT, 1.15), { thickness: 0.004 }), MAT.graphite,
    { explode: [0, 0.3, 1], dist: 0.08, name: 'knee-cap' });
  A.part(knee, roundedBox(0.018, 0.005, 0.004, 0.0018, 1), MAT.led, [0, -0.012, 0.07]);

  // 小腿前甲
  const shinProf = profileY([
    [-0.315, 0.034, 0.036, 0.008, 2.4],
    [-0.2, 0.04, 0.046, 0.014, 2.6],
    [-0.08, 0.047, 0.052, 0.012, 2.6],
  ]);
  A.shell(knee, shellGeo(shinProf, -0.085, -0.31, arcAround(FRONT, 1.3), { thickness: 0.004, segments: 30 }),
    MAT.shell, { explode: [0, 0, 1], dist: 0.09, name: 'shin-front' });
  A.part(knee, roundedBox(0.005, 0.11, 0.004, 0.002, 1), MAT.ledSoft, [s * 0.03, -0.19, 0.052]);
  const warn = decalMaterial(warningTexture());
  A.decals.push(decal(knee, warn, { w: 0.016, h: 0.016, at: [0, -0.12, 0.0655], rot: [-0.06, 0, 0] }));

  // ---- 踝：十字万向节 + 双曲柄并联驱动 ----
  const ankle = new THREE.Group();
  ankle.name = `ankle${side}`;
  ankle.position.set(0, -DIM.shin, 0);
  knee.add(ankle);
  joints[`ankle${side}`] = ankle;
  const ac = A.chain(knee, ankle, 'XZY');
  // 小腿侧叉耳（承载 pitch 销轴）
  for (const x of [0.03, -0.03]) {
    A.part(knee, plate({ topW: 0.03, bottomW: 0.036, height: 0.06, depth: 0.006, radius: 0.012,
      holes: [{ circle: 0.007, x: 0, y: -0.018 }] }), MAT.frame, [x, -0.352, 0], [0, HALF_PI, 0]);
  }
  // 十字轴（pitch 级）
  const crossX = cyl(0.0085, 0.0085, 0.066, 16);
  crossX.rotateZ(HALF_PI);
  A.part(ac.s1, crossX, MAT.alu);
  A.part(ac.s1, roundedBox(0.026, 0.026, 0.026, 0.004), MAT.gunmetal);
  const crossZ = cyl(0.0075, 0.0075, 0.05, 16);
  crossZ.rotateX(HALF_PI);
  A.part(ac.s1, crossZ, MAT.alu);

  const crankR = crankRadius;
  const motors = [
    { x: s * 0.025, dir: s, crankX: s * 0.058, footX: s * 0.034, joint: `${n}_ankle_pitch_joint` },
    { x: -s * 0.025, dir: -s, crankX: -s * 0.058, footX: -s * 0.034, joint: `${n}_ankle_roll_joint` },
  ];
  const motorY = -0.112;
  const motorZ = -0.04;
  const footY = 0.0;
  const footZ = -0.04;
  const linkage = { ankle, knee, rods: [] };
  for (const m of motors) {
    const crank = new THREE.Group();
    crank.name = `${side}-ankle-crank`;
    crank.position.set(m.crankX, motorY, motorZ);
    knee.add(crank);
    A.motor({ motor: 'J27', axis: 'x', dir: m.dir, at: [m.x, motorY, motorZ],
      housingBody: knee, outputBody: crank, outputAt: [m.x - m.crankX, 0, 0], joint: m.joint });
    // 曲柄臂：从转轴指向后方
    A.part(crank, roundedBox(0.008, 0.016, crankR + 0.016, 0.004), MAT.alu, [0, 0, -crankR / 2]);
    const hub = cyl(0.013, 0.013, 0.016, 20);
    hub.rotateZ(HALF_PI);
    A.part(crank, hub, MAT.alu);
    A.part(crank, new THREE.SphereGeometry(0.0065, 16, 12), MAT.gunmetal, [0, 0, -crankR]);

    // 连杆：带两端球铰的钛合金杆（动态网格）
    const rodGeo = cyl(0.0042, 0.0042, 1, 12);
    rodGeo.translate(0, 0.5, 0);
    const rod = new THREE.Mesh(rodGeo, MAT.alu);
    rod.castShadow = true;
    knee.add(rod);
    const endGeo = cyl(0.0068, 0.0068, 0.022, 14);
    const endA = new THREE.Mesh(endGeo, MAT.frame);
    const endB = new THREE.Mesh(endGeo, MAT.frame);
    endA.castShadow = endB.castShadow = true;
    rod.add(endA, endB);

    // 足端球销
    A.part(ankle, new THREE.SphereGeometry(0.0065, 16, 12), MAT.gunmetal, [m.footX, footY, footZ]);
    A.part(ankle, cyl(0.004, 0.004, 0.03, 10), MAT.alu, [m.footX, footY - 0.015, footZ]);

    const M = new THREE.Vector3(m.crankX, motorY, motorZ);
    const F = new THREE.Vector3(m.footX, footY, footZ);
    const A0 = F.clone().add(ankle.position);
    const theta0 = -HALF_PI;               // 曲柄朝后
    const P0 = M.clone().add(new THREE.Vector3(0, Math.cos(theta0), Math.sin(theta0)).multiplyScalar(crankR));
    linkage.rods.push({ crank, rod, endA, endB, M, F, L: P0.distanceTo(A0), theta: theta0, theta0 });
  }
  A.linkages.push(linkage);

  // ---- 足 ----
  buildFoot(A, ankle, s);
}

function buildFoot(A, ankle, s) {
  const SOLE = -DIM.footH * 0.835;      // 足底面（与旧模型一致，保证触地高度不变）
  const zMid = 0.03;
  const footLen = 0.212;
  // 足底橡胶（防滑纹）
  A.part(ankle, plate({ topW: 0.098, bottomW: 0.08, height: footLen, depth: 0.012, radius: 0.034 }),
    MAT.tread, [0, SOLE + 0.006, zMid], [HALF_PI, 0, 0]);
  // 铝合金足板（减重孔）
  A.part(ankle, plate({ topW: 0.09, bottomW: 0.072, height: footLen - 0.014, depth: 0.007, radius: 0.03,
    holes: [{ w: 0.04, h: 0.05, x: 0, y: 0.04, r: 0.012 }, { w: 0.034, h: 0.04, x: 0, y: -0.035, r: 0.01 }] }),
    MAT.frame, [0, SOLE + 0.0155, zMid], [HALF_PI, 0, 0]);
  // 四角力传感器
  for (const [x, z] of [[0.03, 0.105], [-0.03, 0.105], [0.026, -0.05], [-0.026, -0.05]]) {
    A.part(ankle, cyl(0.007, 0.007, 0.004, 16), MAT.accent, [x, SOLE + 0.021, z]);
  }
  // 足端叉耳（承载 roll 销轴）
  for (const z of [0.026, -0.026]) {
    A.part(ankle, plate({ topW: 0.026, bottomW: 0.05, height: 0.04, depth: 0.006, radius: 0.01,
      holes: [{ circle: 0.007, x: 0, y: 0.012 }] }), MAT.frame, [0, -0.012, z]);
  }
  // 脚跟连杆座
  A.part(ankle, roundedBox(0.086, 0.03, 0.014, 0.004), MAT.frame, [0, -0.018, -0.042]);

  // 前足白色鞋面壳：沿 −Y 放样后转到 +Z
  const fronts = limbShell({
    length: 0.115, radial: 36, segments: 16, arc: [0, Math.PI], thickness: 0.003,
    keys: [[0, 0.044, 0.024, 0, 2.6], [0.45, 0.047, 0.02, 0, 2.8], [0.85, 0.04, 0.013, 0, 2.6], [1, 0.022, 0.008, 0, 2.2]],
  });
  fronts.rotateX(-HALF_PI);
  A.shell(ankle, fronts, MAT.shell, { explode: [0, 1, 0.4], dist: 0.05, name: 'foot-front' });
  fronts.translate(0, SOLE + 0.019, 0.024);
  // 脚跟护壳：同样沿 −Y 放样，转到 +Z 后再绕 Y 翻转 180° 指向脚后跟
  const heel = limbShell({
    length: 0.05, radial: 32, segments: 10, arc: [0, Math.PI], thickness: 0.003,
    keys: [[0, 0.044, 0.026, 0, 2.6], [0.6, 0.042, 0.024, 0, 2.6], [1, 0.028, 0.016, 0, 2.3]],
  });
  heel.rotateX(-HALF_PI);
  heel.rotateY(Math.PI);
  heel.translate(0, SOLE + 0.019, -0.03);
  A.shell(ankle, heel, MAT.graphite, { explode: [0, 0.5, -1], dist: 0.04, name: 'foot-heel' });
  // 脚尖防撞条
  A.part(ankle, roundedBox(0.07, 0.012, 0.012, 0.005), MAT.rubber, [0, SOLE + 0.012, zMid + footLen / 2 - 0.004]);
}

// ------------------------------------------------------------------
// 整机
// ------------------------------------------------------------------
export function buildRobot() {
  const joints = {};
  const rig = { root: null, joints, face: null, hands: {} };
  const A = new Assembly();

  const root = new THREE.Group();
  root.name = 'root';
  rig.root = root;

  const waist = new THREE.Group();
  waist.name = 'waist';
  waist.position.set(0, DIM.pelvisH * 0.5, 0);
  root.add(waist);

  buildPelvis(A, root);
  buildWaist(A, root, waist, joints);

  const neck = new THREE.Group();
  neck.name = 'head';
  neck.position.set(0, DIM.torsoH + DIM.neckH * 0.5, 0);
  waist.add(neck);
  buildHead(A, waist, neck, joints, rig);

  buildArm(A, waist, 'L', joints, rig);
  buildArm(A, waist, 'R', joints, rig);
  buildLeg(A, root, 'L', joints);
  buildLeg(A, root, 'R', joints);

  const meshes = A.sink.flush();

  // ---- 统计 ----
  let triangles = 0;
  let meshCount = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    meshCount++;
    const g = o.geometry;
    const tri = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    triangles += o.isInstancedMesh ? tri * o.count : tri;
  });
  rig.stats = { parts: A.sink.partCount, batched: meshes, meshes: meshCount, triangles: Math.round(triangles), actuators: A.actuators.length };

  // ---- 机构同步 ----
  const tmpQ = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();
  const tmpA = new THREE.Vector3();
  const tmpP = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const cold = new THREE.Color(0x35d9ff);
  const warm = new THREE.Color(0xffb020);
  const hot = new THREE.Color(0xff3040);
  const ledColor = new THREE.Color();

  // 机构诊断：连杆闭环误差（m）与不可达次数，用于回归测试与调参
  rig.diagnostics = { linkageMaxError: 0, unreachable: 0 };

  rig.update = (dt, actuatorLayer) => {
    for (const sync of A.chains) sync();

    // 踝并联连杆闭环：足端球销随踝转动，反解曲柄角，杆件对齐两端球铰
    for (const lk of A.linkages) {
      for (const r of lk.rods) {
        tmpA.copy(r.F).applyEuler(lk.ankle.rotation).add(lk.ankle.position);
        const sol = solveCrank(r.M.toArray(), tmpA.toArray(), crankRadius, r.L, r.theta);
        r.theta = sol.theta;
        if (!sol.reachable) rig.diagnostics.unreachable++;
        r.crank.rotation.x = r.theta - r.theta0;
        tmpP.set(0, Math.cos(r.theta), Math.sin(r.theta)).multiplyScalar(crankRadius).add(r.M);
        tmpV.subVectors(tmpP, tmpA);
        const len = tmpV.length();
        rig.diagnostics.linkageMaxError = Math.max(rig.diagnostics.linkageMaxError, Math.abs(len - r.L));
        r.rod.position.copy(tmpA);
        r.rod.quaternion.copy(tmpQ.setFromUnitVectors(up, tmpV.normalize()));
        r.rod.scale.set(1, len, 1);
        r.endA.scale.set(1, 1 / len, 1);
        r.endB.scale.set(1, 1 / len, 1);
        r.endA.position.set(0, 0.012 / len, 0);
        r.endB.position.set(0, 1 - 0.012 / len, 0);
      }
    }

    // 负载指示环：|τ|/τmax → 青 / 琥珀 / 红，饱和时闪烁
    if (actuatorLayer) {
      for (const a of A.actuators) {
        if (!a.ring || !a.joint) continue;
        const act = actuatorLayer.byName.get(a.joint);
        if (!act) continue;
        const load = Math.min(1, Math.abs(act.torque) / act.spec.effort);
        if (load < 0.5) ledColor.copy(cold).lerp(warm, load / 0.5);
        else ledColor.copy(warm).lerp(hot, (load - 0.5) / 0.5);
        // 目标亮度：常态 0.6~1.6（不泛光），力矩饱和 12（越过 Bloom 阈值，出现红色辉光）
        const lum = 0.2126 * ledColor.r + 0.7152 * ledColor.g + 0.0722 * ledColor.b;
        const target = act.saturated ? 12 : 0.6 + load * 1.0;
        a.ring.material.color.copy(ledColor).multiplyScalar(target / Math.max(lum, 0.05));
      }
    }
  };

  // 可检视的执行器（悬停显示关节名、电机档位与实时遥测）
  rig.inspectables = A.actuators.filter((a) => a.joint).map((a) => a.proxy);
  rig.shells = A.shells;

  rig.setXRay = (on) => {
    setMaterialXRay(A.shells, on);
    for (const d of A.decals) d.visible = !on;
    if (rig.face) rig.face.mesh.visible = true;
  };

  rig.setExplode = (t) => {
    const k = t * 1.6;
    for (const m of A.shells) {
      m.position.copy(m.userData.home).addScaledVector(m.userData.explode, k);
    }
  };

  rig.update(0);
  return rig;
}
