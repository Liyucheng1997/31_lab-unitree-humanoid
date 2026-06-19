import test from 'node:test';
import assert from 'node:assert/strict';
import { DIM, baseRootHeight } from '../src/robot/skeleton.js';
import { IdleBehavior } from '../src/control/behaviors.js';

test('机器人名义总高不低于 1.45m', () => {
  const nominalHeight = baseRootHeight() + DIM.pelvisH * 0.5
    + DIM.torsoH + DIM.neckH + DIM.headH;
  assert.ok(nominalHeight >= 1.45,
    `当前名义高度仅 ${nominalHeight.toFixed(3)}m`);
});

test('默认站立时手臂向前自然微屈，不向后伸', () => {
  const pose = new IdleBehavior().update({
    t: 0, dt: 1 / 60, dim: DIM, params: { speed: 1, stride: 0.26, turn: 0 },
  });
  for (const side of ['L', 'R']) {
    assert.ok(pose.joints[`shoulder${side}`].x < 0,
      `${side} 肩应略向前，实际 ${pose.joints[`shoulder${side}`].x}`);
    assert.ok(pose.joints[`elbow${side}`].x < 0,
      `${side} 肘应向前屈曲，实际 ${pose.joints[`elbow${side}`].x}`);
  }
});
