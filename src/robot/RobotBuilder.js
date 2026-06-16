import * as THREE from 'three';
import { DIM } from './skeleton.js';

// ---------- 材质（宇树风格：白壳 / 黑关节 / 蓝光） ----------
const matShell = new THREE.MeshStandardMaterial({
  color: 0xeef2f7, roughness: 0.42, metalness: 0.15,
});
const matDark = new THREE.MeshStandardMaterial({
  color: 0x20242c, roughness: 0.55, metalness: 0.55,
});
const matJoint = new THREE.MeshStandardMaterial({
  color: 0x12151b, roughness: 0.4, metalness: 0.7,
});
const matAccent = new THREE.MeshStandardMaterial({
  color: 0x38bdf8, emissive: 0x0ea5e9, emissiveIntensity: 1.6, roughness: 0.3,
});
const matVisor = new THREE.MeshStandardMaterial({
  color: 0x0a0d12, roughness: 0.15, metalness: 0.3,
  emissive: 0x113355, emissiveIntensity: 0.6,
});

// 圆角盒（壳体常用）
function shell(w, h, d, mat = matShell, radius = 0.02) {
  const geo = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// 关节球/圆柱
function joint(r, len = null, mat = matJoint) {
  let geo;
  if (len === null) geo = new THREE.SphereGeometry(r, 20, 16);
  else {
    geo = new THREE.CylinderGeometry(r, r, len, 20);
    geo.rotateZ(Math.PI / 2); // 沿 X 轴的关节轴
  }
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

// 在 group 内放一个相对中心带偏移的网格
function add(parent, mesh, x = 0, y = 0, z = 0) {
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

/**
 * 构建机器人。返回 { root, joints }，joints 是命名枢轴的字典。
 * 层级：
 *   root(pelvis) → waist(torso) → neck(head)
 *                → shoulderL/R → elbowL/R
 *   root → hipL/R → kneeL/R → ankleL/R
 */
export function buildRobot() {
  const joints = {};
  const root = new THREE.Group();      // 即 pelvis 枢轴 / 整机根
  root.name = 'root';

  // ---- 骨盆壳 ----
  add(root, shell(DIM.pelvisW, DIM.pelvisH, DIM.torsoD * 0.95, matDark), 0, 0, 0);
  add(root, shell(DIM.pelvisW * 0.7, DIM.pelvisH * 0.5, DIM.torsoD, matShell),
      0, DIM.pelvisH * 0.2, 0);

  // ---- 腰 / 躯干 ----
  const waist = new THREE.Group();
  waist.position.set(0, DIM.pelvisH * 0.5, 0);
  root.add(waist);
  joints.waist = waist;

  const torso = shell(DIM.torsoW, DIM.torsoH, DIM.torsoD, matShell);
  add(waist, torso, 0, DIM.torsoH * 0.5, 0);
  // 胸前装甲 + 蓝光条
  add(waist, shell(DIM.torsoW * 0.6, DIM.torsoH * 0.5, 0.02, matDark),
      0, DIM.torsoH * 0.55, DIM.torsoD * 0.5);
  add(waist, shell(0.05, 0.05, 0.02, matAccent),
      0, DIM.torsoH * 0.62, DIM.torsoD * 0.51);
  // 肩部横梁
  add(waist, shell(DIM.shoulderWidth * 2, 0.09, 0.13, matDark),
      0, DIM.torsoH * 0.92, 0);

  // ---- 颈 / 头 ----
  const neck = new THREE.Group();
  neck.position.set(0, DIM.torsoH + DIM.neckH * 0.5, 0);
  waist.add(neck);
  joints.head = neck;
  add(neck, joint(0.045), 0, 0, 0);
  const head = shell(DIM.headW, DIM.headH, DIM.headW * 0.95, matShell, 0.03);
  add(neck, head, 0, DIM.neckH * 0.5 + DIM.headH * 0.5, 0);
  // 面罩（黑色弧形）
  add(neck, shell(DIM.headW * 0.82, DIM.headH * 0.42, 0.03, matVisor),
      0, DIM.neckH * 0.5 + DIM.headH * 0.52, DIM.headW * 0.47);
  // 两侧传感器蓝点
  add(neck, shell(0.03, 0.03, 0.02, matAccent),
      DIM.headW * 0.3, DIM.neckH * 0.5 + DIM.headH * 0.52, DIM.headW * 0.46);
  add(neck, shell(0.03, 0.03, 0.02, matAccent),
      -DIM.headW * 0.3, DIM.neckH * 0.5 + DIM.headH * 0.52, DIM.headW * 0.46);

  // ---- 手臂 ----
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;

    const shoulder = new THREE.Group();
    shoulder.position.set(s * DIM.shoulderWidth, DIM.torsoH * 0.9, 0);
    waist.add(shoulder);
    joints['shoulder' + side] = shoulder;
    add(shoulder, joint(0.055), 0, 0, 0);

    // 上臂（从肩向下）
    add(shoulder, shell(0.075, DIM.upperArm, 0.085, matShell),
        0, -DIM.upperArm * 0.5, 0);
    add(shoulder, shell(0.08, 0.06, 0.09, matDark), 0, -DIM.upperArm * 0.15, 0);

    // 肘
    const elbow = new THREE.Group();
    elbow.position.set(0, -DIM.upperArm, 0);
    shoulder.add(elbow);
    joints['elbow' + side] = elbow;
    add(elbow, joint(0.045), 0, 0, 0);

    // 前臂 + 手
    add(elbow, shell(0.065, DIM.foreArm, 0.07, matShell), 0, -DIM.foreArm * 0.5, 0);
    add(elbow, shell(0.07, 0.09, 0.085, matDark),
        0, -DIM.foreArm - 0.03, 0); // 手掌
  }

  // ---- 腿 ----
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;

    const hip = new THREE.Group();
    hip.position.set(s * DIM.hipWidth * 0.5, -DIM.pelvisH * 0.4, 0);
    root.add(hip);
    joints['hip' + side] = hip;
    add(hip, joint(0.06), 0, 0, 0);

    // 大腿
    add(hip, shell(0.105, DIM.thigh, 0.12, matShell), 0, -DIM.thigh * 0.5, 0);
    add(hip, shell(0.11, 0.08, 0.13, matDark), 0, -DIM.thigh * 0.2, 0);

    // 膝
    const knee = new THREE.Group();
    knee.position.set(0, -DIM.thigh, 0);
    hip.add(knee);
    joints['knee' + side] = knee;
    add(knee, joint(0.05), 0, 0, 0);

    // 小腿
    add(knee, shell(0.085, DIM.shin, 0.1, matShell), 0, -DIM.shin * 0.5, 0);
    add(knee, shell(0.05, DIM.shin * 0.6, 0.04, matAccent),
        0, -DIM.shin * 0.5, 0.055); // 小腿前蓝光条

    // 踝 + 脚
    const ankle = new THREE.Group();
    ankle.position.set(0, -DIM.shin, 0);
    knee.add(ankle);
    joints['ankle' + side] = ankle;
    add(ankle, joint(0.04), 0, 0, 0);
    // 脚掌（前部偏 -Z = 前方）
    add(ankle, shell(0.1, DIM.footH, DIM.footLen, matDark),
        0, -DIM.footH * 0.5 - 0.01, -DIM.footLen * 0.18);
  }

  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { root, joints };
}
