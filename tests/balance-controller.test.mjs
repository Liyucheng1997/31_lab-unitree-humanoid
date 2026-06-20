import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BalanceController, GRAVITY, pointMargin, supportPolygon,
} from '../src/control/BalanceController.js';
import { BaduanjinBehavior, WalkBehavior } from '../src/control/behaviors.js';
import { DIM } from '../src/robot/skeleton.js';

const standingPose = {
  feet: {
    L: { x: DIM.hipWidth * 0.5, z: 0, contact: true },
    R: { x: -DIM.hipWidth * 0.5, z: 0, contact: true },
  },
  balanceTarget: { x: 0, z: 0 },
};

test('重力采用标准值，双足接触生成正确支撑域和稳定裕度', () => {
  assert.equal(GRAVITY, 9.81);
  const bounds = supportPolygon(standingPose.feet);
  assert.deepEqual({
    minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ,
  }, {
    minX: -0.1525, maxX: 0.1525, minZ: -0.09, maxZ: 0.09,
  });
  assert.equal(bounds.points.length, 4);
  assert.equal(pointMargin({ x: 0, z: 0 }, bounds), 0.09);
  assert.ok(pointMargin({ x: 0.2, z: 0 }, bounds) < 0);
});

test('交错双脚使用真实凸支撑域，不把外接矩形角落误判为稳定', () => {
  const bounds = supportPolygon({
    L: { x: 0.1, z: 0.2, contact: true },
    R: { x: -0.1, z: -0.2, contact: true },
  });
  const unsupportedCorner = { x: 0.14, z: -0.2 };
  assert.ok(unsupportedCorner.x < bounds.maxX && unsupportedCorner.z > bounds.minZ);
  assert.ok(pointMargin(unsupportedCorner, bounds) < 0);
});

test('ZMP 闭环能抵消外部冲量并把重心恢复到双足中心', () => {
  const controller = new BalanceController();
  controller.applyImpulse(8.5, 3.5);
  let state;
  for (let i = 0; i < 180; i++) state = controller.step(standingPose, 1 / 60);

  assert.equal(state.status, 'stable');
  assert.ok(Math.hypot(state.com.x, state.com.z) < 1e-4, `COM 未恢复：${JSON.stringify(state.com)}`);
  assert.ok(Math.hypot(state.velocity.x, state.velocity.z) < 1e-4,
    `COM 速度未衰减：${JSON.stringify(state.velocity)}`);
});

test('关闭平衡闭环后，相同冲量会在真实重力下越过支撑域', () => {
  const controller = new BalanceController();
  controller.enabled = false;
  controller.applyImpulse(8.5, 3.5);
  let state;
  for (let i = 0; i < 60; i++) state = controller.step(standingPose, 1 / 60);

  assert.equal(state.status, 'unstable');
  assert.ok(state.margin < 0);
});

test('默认步态的预载换脚策略不进入失稳状态', () => {
  const behavior = new WalkBehavior();
  const controller = new BalanceController();
  let time = 0;
  let minimumMargin = Infinity;
  for (let i = 0; i < 600; i++) {
    time += 1 / 60;
    const pose = behavior.update({
      t: time, dt: 1 / 60, dim: DIM,
      params: { speed: 1, stride: 0.26, turn: 0 },
    });
    const state = controller.step(pose, 1 / 60);
    minimumMargin = Math.min(minimumMargin, state.margin);
    assert.notEqual(state.status, 'unstable', `第 ${i} 帧发生失稳`);
  }
  assert.ok(minimumMargin > 0, `最小稳定裕度 ${minimumMargin}`);
});

test('八段锦完整八式包含脚步且全程保持稳定', () => {
  const behavior = new BaduanjinBehavior();
  const controller = new BalanceController();
  const liftedForms = new Set();
  let heelMin = Infinity;
  let heelMax = -Infinity;
  let minimumMargin = Infinity;
  let time = 0;

  for (let i = 0; i < 64 * 60; i++) {
    time += 1 / 60;
    const pose = behavior.update({
      t: time, dt: 1 / 60, dim: DIM,
      params: { speed: 1, stride: 0.26, turn: 0 },
    });
    const form = behavior.formIndex;
    if (Object.values(pose.feet).some((foot) => foot.contact === false)) liftedForms.add(form);
    if (form === 7) {
      heelMin = Math.min(heelMin, pose.joints.ankleL.x);
      heelMax = Math.max(heelMax, pose.joints.ankleL.x);
    }
    const state = controller.step(pose, 1 / 60);
    minimumMargin = Math.min(minimumMargin, state.margin);
    assert.notEqual(state.status, 'unstable', `第 ${form + 1} 式第 ${i} 帧发生失稳`);
  }

  assert.deepEqual([...liftedForms].sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(heelMax - heelMin > 0.15, '第八式应有明显的七次提踵');
  assert.ok(minimumMargin > 0, `最小稳定裕度 ${minimumMargin}`);
});
