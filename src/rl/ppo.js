// PPO-Clip 实现（对齐 roboparty_train 使用的 rsl_rl：Actor-Critic + GAE）。
// 纯 JS、逐样本反传，规模足够本项目的平衡策略训练。
//
// 策略：对角高斯。actor 网络输出均值 μ，logStd 为独立可学参数。
// 环境自行把动作裁剪到 [-1,1]（logp 按未裁剪动作计算，标准做法）。

import { MLP, makeRng, gaussian } from './nn.js?v=20261002-eng-v1';

export const DEFAULT_HP = {
  gamma: 0.99,          // 折扣
  lam: 0.95,            // GAE λ
  clip: 0.2,            // PPO 裁剪半径
  lr: 3e-4,
  epochs: 4,
  minibatch: 512,
  entCoef: 0.01,
  vfCoef: 0.5,
  initLogStd: -0.5,
  minLogStd: -2.0,      // 熵下限：防止探索塌缩后被梯度噪声侵蚀
  // KL 早停（Spinning-Up / rsl_rl 的 desired-KL 思想）：
  // 每个 epoch 结束估计新旧策略 KL，超过 1.5×desiredKL 就停掉剩余 epoch，
  // 防止单次更新把策略推得太远导致后期崩塌。
  desiredKL: 0.02,
  hidden: [64, 64],
};

export class RolloutBuffer {
  constructor(capacity, obsDim, actDim) {
    this.capacity = capacity;
    this.obsDim = obsDim;
    this.actDim = actDim;
    this.obs = new Float64Array(capacity * obsDim);
    this.act = new Float64Array(capacity * actDim);
    this.logp = new Float64Array(capacity);
    this.rew = new Float64Array(capacity);
    this.val = new Float64Array(capacity);
    this.done = new Uint8Array(capacity);
    this.adv = new Float64Array(capacity);
    this.ret = new Float64Array(capacity);
    this.n = 0;
  }

  add(obs, act, logp, rew, val, done) {
    const i = this.n;
    this.obs.set(obs, i * this.obsDim);
    this.act.set(act, i * this.actDim);
    this.logp[i] = logp;
    this.rew[i] = rew;
    this.val[i] = val;
    this.done[i] = done ? 1 : 0;
    this.n += 1;
  }

  get full() { return this.n >= this.capacity; }

  /**
   * GAE 优势估计。要求按时间顺序、单环境连续写入
   * （多环境时用多个 buffer，最后合并训练，见 Trainer）。
   * @param {number} lastVal 轨迹末状态的 V(s)（done 则传 0）
   */
  computeGAE(lastVal, gamma, lam) {
    let advNext = 0;
    let vNext = lastVal;
    for (let i = this.n - 1; i >= 0; i--) {
      const notDone = this.done[i] ? 0 : 1;
      const delta = this.rew[i] + gamma * vNext * notDone - this.val[i];
      advNext = delta + gamma * lam * notDone * advNext;
      this.adv[i] = advNext;
      this.ret[i] = advNext + this.val[i];
      vNext = this.val[i];
    }
  }

  reset() { this.n = 0; }
}

export class PPOAgent {
  constructor(obsDim, actDim, hp = {}, seed = 7) {
    this.obsDim = obsDim;
    this.actDim = actDim;
    this.hp = { ...DEFAULT_HP, ...hp };
    this.actor = new MLP([obsDim, ...this.hp.hidden, actDim], seed);
    this.critic = new MLP([obsDim, ...this.hp.hidden, 1], seed + 1);
    this.logStd = new Float64Array(actDim).fill(this.hp.initLogStd);
    this.gLogStd = new Float64Array(actDim);
    this.mLogStd = new Float64Array(actDim);
    this.vLogStd = new Float64Array(actDim);
    this.logStdT = 0;
    this.rng = makeRng(seed * 977 + 13);
    this.updates = 0;
  }

  /** 采样动作。deterministic=true 时直接用均值（部署模式）。 */
  act(obs, deterministic = false) {
    const mean = this.actor.forward(obs);
    const action = new Float64Array(this.actDim);
    let logp = 0;
    for (let i = 0; i < this.actDim; i++) {
      const std = Math.exp(this.logStd[i]);
      const a = deterministic ? mean[i] : mean[i] + std * gaussian(this.rng);
      action[i] = a;
      const z = (a - mean[i]) / std;
      logp += -0.5 * z * z - this.logStd[i] - 0.5 * Math.log(2 * Math.PI);
    }
    return { action, logp, value: this.critic.forward(obs)[0] };
  }

  value(obs) { return this.critic.forward(obs)[0]; }

  /**
   * 用（已 computeGAE 的）rollout 数据做一次 PPO 更新。
   * @param {RolloutBuffer[]} buffers
   * @param {{freezeActor?:boolean}} options freezeActor=true 时只训练 critic
   *        （热启动后的价值网络预热，防止噪声优势毁掉示教策略）。
   * @returns {{policyLoss:number, valueLoss:number, entropy:number}}
   */
  update(buffers, options = {}) {
    const freezeActor = options.freezeActor === true;
    const hp = this.hp;
    // 汇总样本索引 [bufferIdx, step]
    const index = [];
    for (let b = 0; b < buffers.length; b++) {
      for (let i = 0; i < buffers[b].n; i++) index.push([b, i]);
    }
    const total = index.length;
    if (total === 0) return { policyLoss: 0, valueLoss: 0, entropy: 0 };

    // 优势归一化（全 batch）
    let mean = 0;
    for (const [b, i] of index) mean += buffers[b].adv[i];
    mean /= total;
    let variance = 0;
    for (const [b, i] of index) {
      const d = buffers[b].adv[i] - mean;
      variance += d * d;
    }
    const std = Math.sqrt(variance / total) + 1e-8;

    const obs = new Float64Array(this.obsDim);
    const stats = { policyLoss: 0, valueLoss: 0, entropy: 0, count: 0 };

    let earlyStopped = false;
    for (let epoch = 0; epoch < hp.epochs && !earlyStopped; epoch++) {
      let epochKl = 0;
      let epochKlN = 0;
      // Fisher-Yates 打乱
      for (let i = total - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        const tmp = index[i]; index[i] = index[j]; index[j] = tmp;
      }
      for (let start = 0; start < total; start += hp.minibatch) {
        const end = Math.min(start + hp.minibatch, total);
        const batchN = end - start;
        this.actor.zeroGrad();
        this.critic.zeroGrad();
        this.gLogStd.fill(0);

        for (let k = start; k < end; k++) {
          const [b, i] = index[k];
          const buffer = buffers[b];
          for (let d = 0; d < this.obsDim; d++) obs[d] = buffer.obs[i * this.obsDim + d];
          const adv = (buffer.adv[i] - mean) / std;

          // ---- actor ----
          const mu = this.actor.forward(obs);
          let logpNew = 0;
          const zArr = new Float64Array(this.actDim);
          for (let d = 0; d < this.actDim; d++) {
            const sd = Math.exp(this.logStd[d]);
            const z = (buffer.act[i * this.actDim + d] - mu[d]) / sd;
            zArr[d] = z;
            logpNew += -0.5 * z * z - this.logStd[d] - 0.5 * Math.log(2 * Math.PI);
          }
          const ratio = Math.exp(logpNew - buffer.logp[i]);
          epochKl += buffer.logp[i] - logpNew;   // KL(old‖new) 的采样估计
          epochKlN += 1;
          const clipped = ratio < 1 - hp.clip || ratio > 1 + hp.clip;
          const surrogate1 = ratio * adv;
          const surrogate2 = Math.max(Math.min(ratio, 1 + hp.clip), 1 - hp.clip) * adv;
          stats.policyLoss += -Math.min(surrogate1, surrogate2);

          // dL/dlogpNew：仅当未裁剪分支起作用时非零
          let dLdLogp = 0;
          if (!freezeActor && (surrogate1 <= surrogate2 || !clipped)) {
            dLdLogp = -ratio * adv;
          }
          if (dLdLogp !== 0) {
            const dMu = new Float64Array(this.actDim);
            for (let d = 0; d < this.actDim; d++) {
              const sd = Math.exp(this.logStd[d]);
              // dlogp/dμ = z/σ；dlogp/dlogσ = z²-1
              dMu[d] = dLdLogp * (zArr[d] / sd);
              this.gLogStd[d] += dLdLogp * (zArr[d] * zArr[d] - 1);
            }
            this.actor.backward(dMu);
          }
          // 熵正则：H = Σ(logσ)+const，dH/dlogσ=1 → 损失梯度 -entCoef
          for (let d = 0; d < this.actDim; d++) {
            this.gLogStd[d] += -hp.entCoef;
            stats.entropy += this.logStd[d] + 0.5 * Math.log(2 * Math.PI * Math.E);
          }

          // ---- critic ----
          const v = this.critic.forward(obs)[0];
          const vErr = v - buffer.ret[i];
          stats.valueLoss += vErr * vErr;
          this.critic.backward([hp.vfCoef * 2 * vErr]);
          stats.count += 1;
        }

        const scale = 1 / batchN;
        if (!freezeActor) this.actor.adamStep(hp.lr, scale);
        this.critic.adamStep(hp.lr, scale);
        if (freezeActor) continue;
        // logStd 的 Adam
        this.logStdT += 1;
        const c1 = 1 - Math.pow(0.9, this.logStdT);
        const c2 = 1 - Math.pow(0.999, this.logStdT);
        for (let d = 0; d < this.actDim; d++) {
          const g = this.gLogStd[d] * scale;
          this.mLogStd[d] = 0.9 * this.mLogStd[d] + 0.1 * g;
          this.vLogStd[d] = 0.999 * this.vLogStd[d] + 0.001 * g * g;
          this.logStd[d] -= hp.lr * (this.mLogStd[d] / c1)
            / (Math.sqrt(this.vLogStd[d] / c2) + 1e-8);
          // 防止 σ 塌缩或爆炸
          this.logStd[d] = Math.min(0.5, Math.max(hp.minLogStd, this.logStd[d]));
        }
      }
      // KL 早停：本 epoch 已把策略推离旧策略太远，剩余 epoch 不再更新。
      if (epochKlN > 0 && Math.abs(epochKl / epochKlN) > hp.desiredKL * 1.5) {
        earlyStopped = true;
      }
    }
    this.updates += 1;
    const n = Math.max(1, stats.count);
    return {
      policyLoss: stats.policyLoss / n,
      valueLoss: stats.valueLoss / n,
      entropy: stats.entropy / (n * this.actDim),
    };
  }

  /** 导出权重（JSON 可序列化，供部署/存档）。 */
  save() {
    return {
      format: 'rpo-web-ppo-v1',
      obsDim: this.obsDim,
      actDim: this.actDim,
      hidden: this.hp.hidden,
      actor: this.actor.getParams(),
      critic: this.critic.getParams(),
      logStd: Array.from(this.logStd),
      updates: this.updates,
    };
  }

  load(data) {
    if (data.obsDim !== this.obsDim || data.actDim !== this.actDim) {
      throw new Error(`权重维度不匹配: ${data.obsDim}x${data.actDim}`);
    }
    this.actor.setParams(data.actor);
    this.critic.setParams(data.critic);
    this.logStd.set(data.logStd);
    this.updates = data.updates || 0;
  }

  /** 清空优化器动量（checkpoint 回滚后调用）。 */
  resetOptimizer() {
    this.actor.resetAdam();
    this.critic.resetAdam();
    this.mLogStd.fill(0);
    this.vLogStd.fill(0);
    this.logStdT = 0;
  }
}
