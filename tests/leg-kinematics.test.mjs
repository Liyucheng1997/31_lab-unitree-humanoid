import test from 'node:test';
import assert from 'node:assert/strict';
import { solveLegIK } from '../src/control/MathUtils.js';
import { KNEE_SIGN } from '../src/control/behaviors.js';
import { DIM, FORWARD_Z } from '../src/robot/skeleton.js';

test('站立时膝关节朝机器人视觉正面 +Z 弯曲，脚踝保持在髋部下方', () => {
  const { hip, knee } = solveLegIK(
    0, -DIM.standHipHeight, DIM.thigh, DIM.shin, KNEE_SIGN);

  const kneeZ = -DIM.thigh * Math.sin(hip);
  const ankleZ = kneeZ - DIM.shin * Math.sin(hip + knee);

  assert.ok(kneeZ * FORWARD_Z > 0,
    `膝关节应位于髋部前方 (+Z)，实际 z=${kneeZ.toFixed(4)}`);
  assert.ok(Math.abs(ankleZ) < 1e-9, `脚踝应回到髋部正下方，实际 z=${ankleZ}`);
});

test('屈膝和向前迈步时，膝盖持续朝前且足端到达 +Z 目标', () => {
  for (const footY of [-0.56, -0.50, -0.44]) {
    for (const footZ of [0, 0.12]) {
      const { hip, knee } = solveLegIK(
        footZ * FORWARD_Z, footY, DIM.thigh, DIM.shin, KNEE_SIGN);
      const kneeZ = -DIM.thigh * Math.sin(hip);
      const ankleZ = kneeZ - DIM.shin * Math.sin(hip + knee);

      assert.ok(kneeZ * FORWARD_Z > 0,
        `footY=${footY}, footZ=${footZ} 时膝盖反向，kneeZ=${kneeZ}`);
      assert.ok(Math.abs(ankleZ - footZ * FORWARD_Z) < 1e-9,
        `足端未到达目标：期望 ${footZ}，实际 ${ankleZ}`);
    }
  }
});
