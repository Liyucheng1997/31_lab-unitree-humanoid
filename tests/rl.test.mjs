import test from 'node:test';
import assert from 'node:assert/strict';
import { MLP, makeRng } from '../src/rl/nn.js';
import { PPOAgent, RolloutBuffer } from '../src/rl/ppo.js';
import { BalanceEnv, OBS_DIM, ACT_DIM, buildObs } from '../src/rl/BalanceEnv.js';
import { TrainerCore } from '../src/rl/Trainer.js';

// ------------------------------------------------------------------
// 神经网络
// ------------------------------------------------------------------
test('MLP 能拟合简单函数（y = 2x，回归几步损失下降）', () => {
  const net = new MLP([1, 16, 1], 3);
  const rng = makeRng(9);
  const loss = () => {
    let total = 0;
    for (let i = 0; i < 32; i++) {
      const x = (i / 16) - 1;
      const y = net.forward([x])[0];
      total += (y - 2 * x) ** 2;
    }
    return total / 32;
  };
  const before = loss();
  for (let step = 0; step < 300; step++) {
    net.zeroGrad();
    for (let i = 0; i < 16; i++) {
      const x = rng() * 2 - 1;
      const y = net.forward([x])[0];
      net.backward([2 * (y - 2 * x)]);
    }
    net.adamStep(0.01, 1 / 16);
  }
  const after = loss();
  assert.ok(after < before * 0.1, `损失未下降: ${before} → ${after}`);
});

test('MLP 权重导出/导入 round-trip 输出一致', () => {
  const a = new MLP([4, 8, 2], 1);
  const b = new MLP([4, 8, 2], 2);
  b.setParams(a.getParams());
  const x = [0.1, -0.2, 0.3, 0.7];
  assert.deepEqual(Array.from(b.forward(x)), Array.from(a.forward(x)));
});

// ------------------------------------------------------------------
// GAE
// ------------------------------------------------------------------
test('GAE 与手算一致（两步小样例）', () => {
  const buffer = new RolloutBuffer(2, 1, 1);
  // r=[1,1], v=[0.5,0.5], 无终止, lastVal=0.5, γ=0.9, λ=0.8
  buffer.add([0], [0], 0, 1, 0.5, false);
  buffer.add([0], [0], 0, 1, 0.5, false);
  buffer.computeGAE(0.5, 0.9, 0.8);
  const delta1 = 1 + 0.9 * 0.5 - 0.5;   // 0.95 (t=1)
  const delta0 = 1 + 0.9 * 0.5 - 0.5;   // 0.95 (t=0)
  const adv1 = delta1;
  const adv0 = delta0 + 0.9 * 0.8 * adv1;
  assert.ok(Math.abs(buffer.adv[1] - adv1) < 1e-12);
  assert.ok(Math.abs(buffer.adv[0] - adv0) < 1e-12);
  assert.ok(Math.abs(buffer.ret[0] - (adv0 + 0.5)) < 1e-12);
});

// ------------------------------------------------------------------
// 平衡环境
// ------------------------------------------------------------------
test('环境观测 10 维、动作 2 维，含域随机化参数', () => {
  const env = new BalanceEnv(5);
  const obs = env.reset();
  assert.equal(obs.length, OBS_DIM);
  assert.equal(ACT_DIM, 2);
  const r1 = env.step([0.3, -0.2]);
  assert.equal(r1.obs.length, OBS_DIM);
  assert.ok(Number.isFinite(r1.reward));
});

test('恒定满偏动作会把重心推出支撑域并触发摔倒终止', () => {
  const env = new BalanceEnv(7, { obsNoise: 0, pushIntervalRange: [999, 999] });
  env.reset();
  let done = false;
  let steps = 0;
  while (!done && steps < env.c.episodeLength) {
    ({ done } = env.step([1, 1]));   // ZMP 恒偏一角 → LIPM 发散
    steps += 1;
  }
  assert.ok(steps < env.c.episodeLength, '满偏动作竟然没摔倒');
});

test('buildObs 与环境内部状态一致（关噪声时）', () => {
  const env = new BalanceEnv(11, { obsNoise: 0 });
  const obs = env.reset();
  const omega = Math.sqrt(env.c.gravity / env.comHeight);
  const expected = buildObs({
    comX: env.comX, comZ: env.comZ, velX: env.velX, velZ: env.velZ,
    capX: env.comX + env.velX / omega, capZ: env.comZ + env.velZ / omega,
    prevAX: 0, prevAZ: 0, halfX: env.halfX, halfZ: env.halfZ,
  });
  for (let i = 0; i < OBS_DIM; i++) {
    assert.ok(Math.abs(obs[i] - expected[i]) < 1e-12, `第 ${i} 维不一致`);
  }
});

// ------------------------------------------------------------------
// PPO 学习冒烟测试（固定种子，确定性）
// ------------------------------------------------------------------
test('PPO 从零学习：30 迭代内回合回报显著提升', () => {
  // 关闭模仿热启动，验证纯 RL 学习信号。固定种子全程确定性。
  // （KL 早停让前期学习更稳但更慢：离线探测 i1≈6 → i20≈14 → i40≈37）
  const trainer = new TrainerCore({
    numEnvs: 16, horizon: 128, seed: 123, pretrain: false,
  });
  const first = trainer.iterate();
  let last = first;
  for (let i = 0; i < 29; i++) last = trainer.iterate();
  assert.ok(last.meanEpReturn > first.meanEpReturn + 8,
    `回报未提升: ${first.meanEpReturn.toFixed(1)} → ${last.meanEpReturn.toFixed(1)}`);
});

test('模仿学习热启动：起步即接近 PD 专家水平', () => {
  const trainer = new TrainerCore({ numEnvs: 8, horizon: 128, seed: 42 });
  // 热启动策略回合很长（≈500 步），要跑几个迭代才有完整回合统计。
  let stats;
  for (let i = 0; i < 8; i++) stats = trainer.iterate();
  assert.ok(stats.meanEpReturn > 60,
    `热启动回报仅 ${stats.meanEpReturn.toFixed(1)}，应接近专家水平（随机≈6，专家≈250+）`);
});

test('最优 checkpoint 被记录且可用于部署', () => {
  const trainer = new TrainerCore({ numEnvs: 8, horizon: 128, seed: 42 });
  for (let i = 0; i < 3; i++) trainer.iterate();
  const w = trainer.deployWeights();
  assert.equal(w.obsDim, OBS_DIM);
  assert.equal(w.actDim, ACT_DIM);
});

test('PPOAgent 权重存取 round-trip 后确定性动作一致', () => {
  const a = new PPOAgent(OBS_DIM, ACT_DIM, {}, 42);
  const saved = a.save();
  const b = new PPOAgent(OBS_DIM, ACT_DIM, {}, 99);
  b.load(saved);
  const obs = new Float64Array(OBS_DIM).fill(0.1);
  assert.deepEqual(
    Array.from(b.act(obs, true).action),
    Array.from(a.act(obs, true).action));
});
