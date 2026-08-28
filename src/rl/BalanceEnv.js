// 平衡恢复训练环境（对齐 roboparty_train 中 Isaac Lab 任务的设计范式）：
//   - 物理：线性倒立摆（LIPM），与 BalanceController 同一套动力学——
//     训练环境与部署环境天然同构，这就是 roboto_origin 的 sim2sim 思路。
//   - 动作(2)：归一化 ZMP 指令 a∈[-1,1]²，映射到支撑域内（等价于踝力矩指令）。
//   - 观测(10)：重心位置/速度/捕获点 + 上一步动作 + 支撑域尺寸。
//   - 奖励：存活 + 回中 + 速度惩罚 + 动作/动作率惩罚（Isaac Lab 加权项风格）。
//   - 域随机化：重心高度、支撑域尺寸、观测噪声、动作延迟、随机推撞——
//     训练出的策略对模型误差鲁棒，才谈得上"落地"。

import { makeRng, gaussian } from './nn.js?v=20260828-rpo-v1';

export const ENV_CONFIG = {
  dt: 0.02,                 // 50 Hz 控制频率（Isaac Lab locomotion 同款）
  substeps: 4,              // 内部 5ms 积分
  gravity: 9.81,
  episodeLength: 500,       // 10 s
  // 观测归一化尺度
  posScale: 0.15, velScale: 0.6, capScale: 0.2,
  halfXBase: 0.13, halfZBase: 0.115, halfScale: 0.05,
  zmpMargin: 0.012,         // 与 BalanceController.edgeMargin 一致
  // 域随机化范围
  comHeightRange: [0.6, 0.95],
  halfXRange: [0.10, 0.16],
  halfZRange: [0.09, 0.14],
  pushIntervalRange: [1.0, 2.4],   // 秒
  pushVelRange: [0.08, 0.45],      // m/s 速度突变
  obsNoise: 0.004,
  actionDelaySteps: 1,      // 模拟通信/执行延迟
  // 奖励权重
  wAlive: 1.0, wPos: 6.0, wVel: 0.4, wAction: 0.05, wRate: 0.2,
  fallPenalty: 10,
  fallRatio: 1.35,          // 捕获点超出支撑域该倍数视为摔倒
};

export const OBS_DIM = 10;
export const ACT_DIM = 2;

/**
 * 构造观测向量。部署端（PolicyBalancer）复用同一函数，保证训练/部署一致。
 * @param {{comX,comZ,velX,velZ,capX,capZ,prevAX,prevAZ,halfX,halfZ}} s
 */
export function buildObs(s, out = new Float64Array(OBS_DIM)) {
  const c = ENV_CONFIG;
  out[0] = s.comX / c.posScale;
  out[1] = s.comZ / c.posScale;
  out[2] = s.velX / c.velScale;
  out[3] = s.velZ / c.velScale;
  out[4] = s.capX / c.capScale;
  out[5] = s.capZ / c.capScale;
  out[6] = s.prevAX;
  out[7] = s.prevAZ;
  out[8] = (s.halfX - c.halfXBase) / c.halfScale;
  out[9] = (s.halfZ - c.halfZBase) / c.halfScale;
  return out;
}

const sampleRange = (rng, [lo, hi]) => lo + rng() * (hi - lo);

export class BalanceEnv {
  constructor(seed = 1, config = {}) {
    this.c = { ...ENV_CONFIG, ...config };
    this.rng = makeRng(seed);
    this.obs = new Float64Array(OBS_DIM);
    this.reset();
  }

  reset() {
    const c = this.c;
    const rng = this.rng;
    // 域随机化：每回合一套"机器人参数"
    this.comHeight = sampleRange(rng, c.comHeightRange);
    this.halfX = sampleRange(rng, c.halfXRange);
    this.halfZ = sampleRange(rng, c.halfZRange);
    this.pushTimer = sampleRange(rng, c.pushIntervalRange);

    // 初始扰动状态
    this.comX = (rng() - 0.5) * 0.08;
    this.comZ = (rng() - 0.5) * 0.08;
    this.velX = (rng() - 0.5) * 0.3;
    this.velZ = (rng() - 0.5) * 0.3;
    this.prevA = [0, 0];
    this.delayQueue = [];
    for (let i = 0; i < c.actionDelaySteps; i++) this.delayQueue.push([0, 0]);
    this.steps = 0;
    return this.observe();
  }

  observe() {
    const c = this.c;
    const omega = Math.sqrt(c.gravity / this.comHeight);
    const noise = () => gaussian(this.rng) * c.obsNoise;
    return buildObs({
      comX: this.comX + noise(), comZ: this.comZ + noise(),
      velX: this.velX + noise() * 3, velZ: this.velZ + noise() * 3,
      capX: this.comX + this.velX / omega,
      capZ: this.comZ + this.velZ / omega,
      prevAX: this.prevA[0], prevAZ: this.prevA[1],
      halfX: this.halfX, halfZ: this.halfZ,
    }, this.obs);
  }

  /**
   * @param {number[]} action 归一化 ZMP 指令 [-1,1]²
   * @returns {{obs, reward, done}}
   */
  step(action) {
    const c = this.c;
    const ax = Math.max(-1, Math.min(1, action[0]));
    const az = Math.max(-1, Math.min(1, action[1]));

    // 动作延迟（模拟总线/驱动器链路）
    this.delayQueue.push([ax, az]);
    const [useAX, useAZ] = this.delayQueue.shift();

    const zmpX = useAX * (this.halfX - c.zmpMargin);
    const zmpZ = useAZ * (this.halfZ - c.zmpMargin);

    // LIPM 积分：acc = g/h · (com − zmp)
    const h = c.dt / c.substeps;
    const k = c.gravity / this.comHeight;
    for (let i = 0; i < c.substeps; i++) {
      this.velX += k * (this.comX - zmpX) * h;
      this.velZ += k * (this.comZ - zmpZ) * h;
      this.comX += this.velX * h;
      this.comZ += this.velZ * h;
    }

    // 随机推撞（训练鲁棒性核心）
    this.pushTimer -= c.dt;
    if (this.pushTimer <= 0) {
      this.pushTimer = sampleRange(this.rng, c.pushIntervalRange);
      const mag = sampleRange(this.rng, c.pushVelRange);
      const dir = this.rng() * Math.PI * 2;
      this.velX += Math.cos(dir) * mag;
      this.velZ += Math.sin(dir) * mag;
    }

    // 奖励（Isaac Lab 风格加权项）
    const posErr = this.comX * this.comX + this.comZ * this.comZ;
    const velErr = this.velX * this.velX + this.velZ * this.velZ;
    const rateX = ax - this.prevA[0];
    const rateZ = az - this.prevA[1];
    let reward = c.wAlive
      - c.wPos * posErr
      - c.wVel * velErr
      - c.wAction * (ax * ax + az * az)
      - c.wRate * (rateX * rateX + rateZ * rateZ);

    this.prevA = [ax, az];
    this.steps += 1;

    // 终止判定：捕获点飞出支撑域太远 = 无法用踝策略挽回，摔倒。
    const omega = Math.sqrt(c.gravity / this.comHeight);
    const capX = this.comX + this.velX / omega;
    const capZ = this.comZ + this.velZ / omega;
    const fell = Math.abs(capX) > this.halfX * c.fallRatio
      || Math.abs(capZ) > this.halfZ * c.fallRatio;
    if (fell) reward -= c.fallPenalty;
    const done = fell || this.steps >= c.episodeLength;

    return { obs: this.observe(), reward, done };
  }
}
