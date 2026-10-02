// 训练器核心（对齐 roboparty_train 的 train.py 角色）：
// 并行环境采样 → GAE → PPO 更新，一次 iterate() 为一个完整迭代。
// 该类与执行线程无关：trainWorker.js 在 Web Worker 里跑它（推荐），
// 也可以在主线程逐迭代调用（降级方案）。

import { PPOAgent, RolloutBuffer } from './ppo.js?v=20261002-eng-v1';
import {
  BalanceEnv, OBS_DIM, ACT_DIM, ENV_CONFIG, buildObs,
} from './BalanceEnv.js?v=20261002-eng-v1';
import { makeRng } from './nn.js?v=20261002-eng-v1';

export const TRAIN_CONFIG = {
  numEnvs: 16,
  horizon: 128,      // 每迭代每环境步数 → 2048 样本/迭代
  seed: 20260828,
  pretrain: true,    // 模仿学习热启动：先克隆 PD 专家再 RL 微调（工业管线标准做法）
  criticWarmup: 15,  // 前 N 迭代冻结 actor 只训练价值网络（防噪声优势毁掉示教策略）
};

export class TrainerCore {
  constructor(options = {}) {
    this.cfg = { ...TRAIN_CONFIG, ...options };
    this.agent = new PPOAgent(OBS_DIM, ACT_DIM, {}, this.cfg.seed);
    this.envs = [];
    this.buffers = [];
    this.obsCache = [];
    for (let i = 0; i < this.cfg.numEnvs; i++) {
      const env = new BalanceEnv(this.cfg.seed + i * 131);
      this.envs.push(env);
      this.buffers.push(new RolloutBuffer(this.cfg.horizon, OBS_DIM, ACT_DIM));
      this.obsCache.push(env.observe());
    }
    this.epReturn = new Float64Array(this.cfg.numEnvs);
    this.epLen = new Float64Array(this.cfg.numEnvs);
    this.recentReturns = [];
    this.recentLens = [];
    this.iter = 0;
    this.totalSteps = 0;
    // 最优 checkpoint：部署/导出用历史最优策略，不受训练后期漂移影响。
    this.best = { return: -Infinity, weights: null, iter: 0 };
    this.badStreak = 0;   // 发散监测：连续低于最优 40% 的迭代数

    if (this.cfg.pretrain) this.pretrainFromPD();
  }

  /**
   * 模仿学习热启动：用 BalanceController 同款 PD 律（kp=20, kd=6）当专家，
   * 监督回归 actor 均值。起点即接近手调控制器水平，PPO 在此基础上
   * 针对域随机化（延迟/噪声/参数摄动）微调鲁棒性——对齐真实人形
   * 机器人 "经典控制器示教 + RL 精调" 的落地路线。
   */
  pretrainFromPD(steps = 800, batch = 64) {
    const rng = makeRng(this.cfg.seed + 991);
    const c = ENV_CONFIG;
    const obs = new Float64Array(OBS_DIM);
    const range = ([lo, hi]) => lo + rng() * (hi - lo);
    const clamp1 = (v) => Math.max(-1, Math.min(1, v));

    for (let s = 0; s < steps; s++) {
      this.agent.actor.zeroGrad();
      for (let b = 0; b < batch; b++) {
        const comH = range(c.comHeightRange);
        const halfX = range(c.halfXRange);
        const halfZ = range(c.halfZRange);
        const comX = (rng() * 2 - 1) * 0.18;
        const comZ = (rng() * 2 - 1) * 0.18;
        const velX = (rng() * 2 - 1) * 0.8;
        const velZ = (rng() * 2 - 1) * 0.8;

        // 专家：PD 反解 ZMP（与 BalanceController.step 相同的公式）
        const g = c.gravity;
        const ax = clamp1((comX - comH / g * (20 * -comX - 6 * velX)) / (halfX - c.zmpMargin));
        const az = clamp1((comZ - comH / g * (20 * -comZ - 6 * velZ)) / (halfZ - c.zmpMargin));

        const omega = Math.sqrt(g / comH);
        // prevA 必须与目标动作解耦（随机采样）：否则网络会学会"抄上一步
        // 动作"的捷径，闭环部署时自我放大直接摔倒。
        buildObs({
          comX, comZ, velX, velZ,
          capX: comX + velX / omega, capZ: comZ + velZ / omega,
          prevAX: rng() * 2 - 1, prevAZ: rng() * 2 - 1, halfX, halfZ,
        }, obs);
        const mu = this.agent.actor.forward(obs);
        this.agent.actor.backward([2 * (mu[0] - ax), 2 * (mu[1] - az)]);
      }
      this.agent.actor.adamStep(1e-3, 1 / batch);
    }
    // 起点已接近专家：探索噪声调小，避免 PPO 初期把好策略搅坏。
    this.agent.logStd.fill(-1.2);
  }

  /** 跑一个完整 PPO 迭代（采样 + 更新），返回统计。 */
  iterate() {
    const t0 = Date.now();
    const { numEnvs, horizon } = this.cfg;
    for (const buffer of this.buffers) buffer.reset();

    // ---- 采样 ----
    for (let t = 0; t < horizon; t++) {
      for (let e = 0; e < numEnvs; e++) {
        const env = this.envs[e];
        const obs = this.obsCache[e];
        const { action, logp, value } = this.agent.act(obs);
        const result = env.step(action);
        this.buffers[e].add(obs, action, logp, result.reward, value, result.done);
        this.epReturn[e] += result.reward;
        this.epLen[e] += 1;
        if (result.done) {
          this.recentReturns.push(this.epReturn[e]);
          this.recentLens.push(this.epLen[e]);
          if (this.recentReturns.length > 60) {
            this.recentReturns.shift();
            this.recentLens.shift();
          }
          this.epReturn[e] = 0;
          this.epLen[e] = 0;
          this.obsCache[e] = env.reset();
        } else {
          this.obsCache[e] = result.obs;
        }
      }
    }
    this.totalSteps += numEnvs * horizon;

    // ---- GAE ----
    for (let e = 0; e < numEnvs; e++) {
      const buffer = this.buffers[e];
      const lastDone = buffer.done[buffer.n - 1];
      const lastVal = lastDone ? 0 : this.agent.value(this.obsCache[e]);
      buffer.computeGAE(lastVal, this.agent.hp.gamma, this.agent.hp.lam);
    }

    // ---- PPO 更新（热启动后先做 critic 预热）----
    const freezeActor = this.cfg.pretrain && this.iter < this.cfg.criticWarmup;
    const losses = this.agent.update(this.buffers, { freezeActor });
    this.iter += 1;

    const avg = (arr) => arr.length
      ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const meanEpReturn = avg(this.recentReturns);

    // 统计窗口够满时刷新最优 checkpoint
    if (this.recentReturns.length >= 20 && meanEpReturn > this.best.return) {
      this.best = {
        return: meanEpReturn,
        weights: this.agent.save(),
        iter: this.iter,
      };
      this.badStreak = 0;
    }

    // 发散自动回滚（真实训练管线的 resume-from-checkpoint）：
    // 回报持续崩到最优 40% 以下 → 恢复最优权重并降学习率继续。
    let restored = false;
    if (this.best.weights && this.iter > this.cfg.criticWarmup + 5
        && meanEpReturn < this.best.return * 0.4) {
      this.badStreak += 1;
      if (this.badStreak >= 8) {
        this.agent.load(this.best.weights);
        this.agent.resetOptimizer();
        this.agent.hp.lr = Math.max(5e-5, this.agent.hp.lr * 0.7);
        this.badStreak = 0;
        restored = true;
      }
    } else {
      this.badStreak = 0;
    }

    return {
      iter: this.iter,
      totalSteps: this.totalSteps,
      meanEpReturn,
      meanEpLen: avg(this.recentLens),
      bestReturn: this.best.return,
      bestIter: this.best.iter,
      restored,
      ...losses,
      ms: Date.now() - t0,
    };
  }

  /** 部署/导出用的权重：优先历史最优 checkpoint。 */
  deployWeights() {
    return this.best.weights || this.agent.save();
  }
}
