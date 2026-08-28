import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOINTS, RPO_JOINT_COUNT, jointSpecs, TOTAL_MASS, MOTORS,
} from '../src/robot/description.js';
import { JointActuator, ActuatorLayer } from '../src/robot/Actuators.js';
import { ROBOT_MASS } from '../src/control/BalanceController.js';
import { generateURDF } from '../src/robot/urdfExport.js';

// ------------------------------------------------------------------
// 机器人描述层
// ------------------------------------------------------------------
test('与 rpo.urdf 对齐的关节数为 23（每腿 6 + 每臂 5 + 腰 1）', () => {
  assert.equal(RPO_JOINT_COUNT, 23);
  for (const prefix of ['left', 'right']) {
    for (const j of ['thigh_pitch', 'thigh_yaw', 'thigh_roll', 'knee',
      'ankle_pitch', 'ankle_roll', 'arm_pitch', 'arm_roll', 'arm_yaw',
      'elbow_pitch', 'elbow_yaw']) {
      assert.ok(JOINTS.some((s) => s.name === `${prefix}_${j}_joint`),
        `缺少关节 ${prefix}_${j}_joint`);
    }
  }
  assert.ok(JOINTS.some((s) => s.name === 'torso_joint'));
});

test('关节限位有序、执行器规格为正、增益可解析', () => {
  for (const spec of jointSpecs()) {
    assert.ok(spec.lower < spec.upper, `${spec.name} 限位反了`);
    assert.ok(spec.effort > 0 && spec.velocity > 0, `${spec.name} 执行器规格非法`);
    assert.ok(spec.kp > 0 && spec.kd > 0 && spec.inertia > 0,
      `${spec.name} 伺服增益非法`);
  }
});

test('髋膝用 rpo 高扭矩档（120N·m/25rad/s），踝用中扭矩档（27N·m）', () => {
  const byName = new Map(jointSpecs().map((s) => [s.name, s]));
  assert.equal(byName.get('left_thigh_pitch_joint').effort, MOTORS.J120.effort);
  assert.equal(byName.get('left_knee_joint').velocity, MOTORS.J120.velocity);
  assert.equal(byName.get('right_ankle_pitch_joint').effort, MOTORS.J27.effort);
});

test('连杆质量预算与平衡模型总质量一致', () => {
  assert.ok(Math.abs(TOTAL_MASS - ROBOT_MASS) < 0.5,
    `质量预算 ${TOTAL_MASS} 与 ROBOT_MASS ${ROBOT_MASS} 不符`);
});

// ------------------------------------------------------------------
// 执行器伺服
// ------------------------------------------------------------------
const spec = {
  name: 'test', lower: -1.5, upper: 1.5,
  effort: 27, velocity: 12, inertia: 0.05, kp: 12.8, kd: 1.44,
};

test('伺服收敛：阶跃目标在 0.5s 内到位且不震荡发散', () => {
  const a = new JointActuator(spec);
  a.setTarget(0.8);
  for (let i = 0; i < 250; i++) a.tick(0.002);
  assert.ok(Math.abs(a.q - 0.8) < 0.03, `0.5s 后误差 ${Math.abs(a.q - 0.8)}`);
});

test('力矩饱和：任何时刻 |τ| ≤ effort，速度 ≤ velocity', () => {
  const a = new JointActuator({ ...spec, kp: 500 });
  a.setTarget(1.5);
  for (let i = 0; i < 500; i++) {
    a.tick(0.002);
    assert.ok(Math.abs(a.torque) <= spec.effort + 1e-9);
    assert.ok(Math.abs(a.dq) <= spec.velocity + 1e-9);
  }
});

test('机械限位：超限目标被钳制，位置永不越界', () => {
  const a = new JointActuator(spec);
  a.setTarget(99);
  assert.equal(a.target, spec.upper);
  for (let i = 0; i < 1000; i++) {
    a.tick(0.002);
    assert.ok(a.q <= spec.upper + 1e-9 && a.q >= spec.lower - 1e-9);
  }
});

test('ActuatorLayer 把伺服角写回关节 Group，fallback 分量平滑跟随', () => {
  // 最小假 Three Group
  const makeGroup = () => ({
    rotation: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
  });
  const joints = { hipL: makeGroup(), kneeL: makeGroup(), ankleL: makeGroup() };
  const layer = new ActuatorLayer(joints);
  const targets = {
    hipL: { x: -0.5, y: 0.2, z: 0.1 },
    kneeL: { x: 1.0, y: 0, z: 0 },
    ankleL: { x: -0.3, y: 0.4, z: 0 },   // ankle.y 无映射 → fallback
  };
  layer.setTargets(targets);
  for (let i = 0; i < 60; i++) layer.step(1 / 60, targets, () => 0.05);
  assert.ok(Math.abs(joints.hipL.rotation.x - (-0.5)) < 0.05);
  assert.ok(Math.abs(joints.kneeL.rotation.x - 1.0) < 0.05);
  assert.ok(Math.abs(joints.ankleL.rotation.y - 0.4) < 0.05, 'fallback 分量未跟随');
});

// ------------------------------------------------------------------
// URDF 导出
// ------------------------------------------------------------------
test('URDF 含全部 rpo 关节且 XML 标签平衡', () => {
  const urdf = generateURDF();
  assert.ok(urdf.includes('<robot name='));
  for (const s of JOINTS.filter((j) => j.rpo)) {
    assert.ok(urdf.includes(`name="${s.name}"`), `URDF 缺 ${s.name}`);
  }
  for (const tag of ['link', 'joint', 'inertial', 'visual', 'collision']) {
    const open = (urdf.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
    const close = (urdf.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(open, close, `<${tag}> 标签不平衡: ${open} vs ${close}`);
  }
  assert.ok(urdf.includes('effort="120"'), '缺高扭矩电机规格');
});
