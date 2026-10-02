// 策略部署适配器（对齐 roboparty_deploy 的角色）：
// 把训练好的 PPO actor 挂到 BalanceController 的 zmpPolicy 钩子上，
// 用与训练环境完全一致的观测构造（buildObs）——即 sim2sim 部署。
// PD ↔ RL 可随时切换对比。

import { buildObs, ENV_CONFIG, OBS_DIM, ACT_DIM } from './BalanceEnv.js?v=20261002-eng-v1';
import { PPOAgent } from './ppo.js?v=20261002-eng-v1';

export class PolicyBalancer {
  constructor() {
    this.agent = null;
    this.prevA = [0, 0];
    this.obs = new Float64Array(OBS_DIM);
  }

  get ready() { return this.agent !== null; }

  /** 加载（或热更新）权重。data 为 PPOAgent.save() 的产物。 */
  loadWeights(data) {
    if (!this.agent) {
      this.agent = new PPOAgent(data.obsDim, data.actDim, { hidden: data.hidden });
    }
    this.agent.load(data);
  }

  /** 挂到 BalanceController；传 null 卸载（回到 PD）。 */
  attach(balanceController, enabled = true) {
    if (enabled && this.ready) {
      balanceController.zmpPolicy = (bc) => this.compute(bc);
    } else {
      balanceController.zmpPolicy = null;
      this.prevA = [0, 0];
    }
  }

  /**
   * 由 BalanceController 每步回调：状态 → 观测 → actor 均值动作 → ZMP 指令。
   * 输入输出都在机器人本地坐标系。
   */
  compute(bc) {
    const s = bc.support;
    const cx = (s.minX + s.maxX) * 0.5;
    const cz = (s.minZ + s.maxZ) * 0.5;
    const halfX = Math.max((s.maxX - s.minX) * 0.5, 0.02);
    const halfZ = Math.max((s.maxZ - s.minZ) * 0.5, 0.02);
    const omega = Math.sqrt(bc.config.gravity / bc.config.comHeight);

    buildObs({
      comX: bc.com.x - cx, comZ: bc.com.z - cz,
      velX: bc.velocity.x, velZ: bc.velocity.z,
      capX: bc.com.x - cx + bc.velocity.x / omega,
      capZ: bc.com.z - cz + bc.velocity.z / omega,
      prevAX: this.prevA[0], prevAZ: this.prevA[1],
      halfX, halfZ,
    }, this.obs);

    const { action } = this.agent.act(this.obs, true);  // 部署用确定性均值
    const ax = Math.max(-1, Math.min(1, action[0]));
    const az = Math.max(-1, Math.min(1, action[1]));
    this.prevA = [ax, az];
    const margin = ENV_CONFIG.zmpMargin;
    return {
      x: cx + ax * Math.max(halfX - margin, 0),
      z: cz + az * Math.max(halfZ - margin, 0),
    };
  }
}
