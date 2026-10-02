// 整机建模回归：在 Node 中装配完整模型（three 来自 devDependencies），
// 校验接口、关节枢轴、执行器与关节表一一对应、触地高度、机构闭环、渲染预算。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildRobot } from '../src/robot/RobotBuilder.js';
import { JOINTS } from '../src/robot/description.js';
import { DIM } from '../src/robot/skeleton.js';
import { IdleBehavior } from '../src/control/behaviors.js';

const rig = buildRobot();
const box = new THREE.Box3();

const GROUPS = ['waist', 'head', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR',
  'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR'];

test('rig 接口与旧版兼容：关节 Group、面部、双手', () => {
  for (const g of GROUPS) assert.ok(rig.joints[g]?.isObject3D, `缺少关节 ${g}`);
  for (const j of JOINTS) assert.ok(rig.joints[j.group], `关节表 ${j.name} 的 Group ${j.group} 不存在`);
  for (const fn of ['setEmotion', 'flash', 'update']) assert.equal(typeof rig.face[fn], 'function');
  for (const side of ['L', 'R']) assert.equal(typeof rig.hands[side].setCurl, 'function');
  for (const fn of ['update', 'setXRay', 'setExplode']) assert.equal(typeof rig[fn], 'function');
});

test('关节枢轴位置与 skeleton.js 尺寸一致（控制层的运动学前提）', () => {
  const j = rig.joints;
  const eq = (v, x, y, z) => assert.ok(v.distanceTo(new THREE.Vector3(x, y, z)) < 1e-9, `${v.toArray()} ≠ ${[x, y, z]}`);
  eq(j.hipL.position, DIM.hipWidth / 2, -DIM.pelvisH * 0.4, 0);
  eq(j.hipR.position, -DIM.hipWidth / 2, -DIM.pelvisH * 0.4, 0);
  eq(j.kneeL.position, 0, -DIM.thigh, 0);
  eq(j.ankleL.position, 0, -DIM.shin, 0);
  eq(j.shoulderL.position, DIM.shoulderWidth, DIM.torsoH * 0.88, 0);
  eq(j.elbowR.position, 0, -DIM.upperArm, 0);
  eq(j.waist.position, 0, DIM.pelvisH / 2, 0);
  eq(j.head.position, 0, DIM.torsoH + DIM.neckH / 2, 0);
});

test('31 个关节各有一台执行器模组，名称与关节表一一对应', () => {
  const names = rig.inspectables.map((p) => p.userData.inspect.joint).sort();
  assert.deepEqual(names, JOINTS.map((j) => j.name).sort());
  assert.equal(rig.stats.actuators, JOINTS.length);
});

test('站立姿态下足底贴地、头顶高度约 1.5m', () => {
  const pose = new IdleBehavior().update({
    t: 0, dt: 1 / 60, dim: DIM, params: { speed: 1, stride: 0.26, turn: 0 },
  });
  for (const [name, r] of Object.entries(pose.joints)) {
    rig.joints[name]?.rotation.set(r.x || 0, r.y || 0, r.z || 0);
  }
  rig.root.position.set(0, pose.rootHeight, 0);
  rig.update(0);
  rig.root.updateMatrixWorld(true);
  const feet = new THREE.Box3().setFromObject(rig.joints.ankleL);
  assert.ok(Math.abs(feet.min.y) < 0.006, `足底高度 ${feet.min.y.toFixed(4)}m`);
  const head = new THREE.Box3().setFromObject(rig.joints.head);
  assert.ok(head.max.y > 1.45 && head.max.y < 1.62, `头顶高度 ${head.max.y.toFixed(3)}m`);
});

test('串联级分解：髋中间级只含前两轴转动，末级姿态与关节 Group 严格一致', () => {
  const hip = rig.joints.hipL;
  hip.rotation.set(-0.7, 0.35, 0.25);
  rig.update(0);
  rig.root.updateMatrixWorld(true);
  const s2 = rig.root.getObjectByName('hipL:stage2');
  const qS2 = s2.getWorldQuaternion(new THREE.Quaternion());
  const qHip = hip.getWorldQuaternion(new THREE.Quaternion());
  // 髋为 pitch→roll→yaw（'XZY'），s2 到末级只剩绕 Y 的 yaw
  const rel = qS2.invert().multiply(qHip);
  assert.ok(Math.abs(rel.x) < 1e-9 && Math.abs(rel.z) < 1e-9, `残余 ${rel.toArray()}`);
  hip.rotation.set(0, 0, 0);
});

test('踝并联连杆在全行程内闭环可达、杆长不变', () => {
  rig.diagnostics.linkageMaxError = 0;
  rig.diagnostics.unreachable = 0;
  for (const side of ['L', 'R']) {
    const ankle = rig.joints[`ankle${side}`];
    for (let p = -1.0; p <= 0.85; p += 0.05) {
      for (let r = -0.3; r <= 0.3; r += 0.1) {
        ankle.rotation.set(p, 0, r);
        rig.update(1 / 60);
      }
    }
    ankle.rotation.set(0, 0, 0);
  }
  rig.update(0);
  assert.equal(rig.diagnostics.unreachable, 0);
  assert.ok(rig.diagnostics.linkageMaxError < 1e-6, `闭环误差 ${rig.diagnostics.linkageMaxError}`);
});

test('所有网格法线有限且非零（防止 NaN 经 Bloom 扩散成黑屏）', () => {
  let bad = 0;
  rig.root.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.geometry.getAttribute('normal');
    if (!n) return;
    for (let i = 0; i < n.count; i++) {
      const l = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
      if (!(l > 0.5 && l < 1.5)) bad++;
    }
  });
  assert.equal(bad, 0);
});

test('渲染预算：合批后网格数与三角面数受控', () => {
  assert.ok(rig.stats.parts > 1000, `零件数 ${rig.stats.parts}`);
  assert.ok(rig.stats.meshes < 480, `网格数 ${rig.stats.meshes}`);
  assert.ok(rig.stats.triangles < 650_000, `三角面 ${rig.stats.triangles}`);
});

test('爆炸视图可逆，X 光模式可恢复原材质', () => {
  const homes = rig.shells.map((m) => m.position.clone());
  const mats = rig.shells.map((m) => m.material);
  rig.setExplode(1);
  assert.ok(rig.shells.every((m, i) => m.position.distanceTo(homes[i]) > 0.01));
  rig.setExplode(0);
  assert.ok(rig.shells.every((m, i) => m.position.distanceTo(homes[i]) < 1e-12));
  rig.setXRay(true);
  assert.ok(rig.shells.every((m) => m.material.name === 'xray'));
  rig.setXRay(false);
  assert.ok(rig.shells.every((m, i) => m.material === mats[i]));
  box.makeEmpty();
});
