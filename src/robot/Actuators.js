// 执行器伺服层（对齐 roboto_origin 的 roboparty_firmware 模块）。
// 行为层只给"目标角"，真实的运动由每个关节的电机伺服产生：
//   τ = kp·(q* − q) − kd·q̇      （关节模组内的 PD 位置伺服）
//   τ ← clamp(τ, ±effort)        （电机力矩饱和 —— rpo 电机档位）
//   q̈ = τ / I                    （反射惯量近似的单关节动力学）
//   q̇ ← clamp(q̇ + q̈·h, ±velocity)（驱动器速度限幅）
//   q  ← clamp(q + q̇·h, [lower, upper])（机械硬限位，撞限位速度清零）
// 以 500Hz 固定步长积分（真实机器人固件的典型控制频率），与渲染帧率解耦。
//
// 未在关节表中的欧拉分量（如踝 yaw 的脚尖朝向补偿）退化为原来的指数平滑，
// 保持编舞兼容。

import { jointSpecs } from './description.js?v=20260828-rpo-v1';
import { clamp, damp } from '../control/MathUtils.js?v=20260828-rpo-v1';

const CONTROL_DT = 0.002;       // 500 Hz 伺服周期
const MAX_SUBSTEPS = 50;        // 单帧最多积分 0.1s，防止后台标签页回来时爆算

export class JointActuator {
  constructor(spec) {
    this.spec = spec;
    this.q = 0;
    this.dq = 0;
    this.target = 0;
    this.torque = 0;
    this.saturated = false;     // 本帧是否发生力矩/速度饱和
    this.atLimit = false;       // 本帧是否顶到机械限位
  }

  setTarget(qTarget) {
    // 超限的编舞目标直接钳到限位——和真实下位机一样在入口做安全裁剪。
    this.target = clamp(qTarget, this.spec.lower, this.spec.upper);
  }

  /** 单个 500Hz 伺服节拍。 */
  tick(h) {
    const s = this.spec;
    let torque = s.kp * (this.target - this.q) - s.kd * this.dq;
    const rawTorque = torque;
    torque = clamp(torque, -s.effort, s.effort);

    this.dq += (torque / s.inertia) * h;
    const rawDq = this.dq;
    this.dq = clamp(this.dq, -s.velocity, s.velocity);

    this.q += this.dq * h;
    if (this.q <= s.lower || this.q >= s.upper) {
      this.q = clamp(this.q, s.lower, s.upper);
      this.dq = 0;
      this.atLimit = true;
    }
    this.torque = torque;
    if (torque !== rawTorque || this.dq !== rawDq) this.saturated = true;
  }

  /** 直接同步状态（初始化 / 重置用），不经过动力学。 */
  hardSet(q) {
    this.q = clamp(q, this.spec.lower, this.spec.upper);
    this.dq = 0;
    this.target = this.q;
  }
}

export class ActuatorLayer {
  /**
   * @param {Object} joints RobotBuilder 返回的命名关节 Group 表
   */
  constructor(joints) {
    this.joints = joints;
    this.actuators = [];
    this.byName = new Map();
    // group -> { x: actuator|null, y, z }，未映射分量走平滑 fallback
    this.channels = new Map();

    for (const spec of jointSpecs()) {
      if (!joints[spec.group]) continue;   // 该机型没有这个 Group 就跳过
      const actuator = new JointActuator(spec);
      this.actuators.push(actuator);
      this.byName.set(spec.name, actuator);
      if (!this.channels.has(spec.group)) {
        this.channels.set(spec.group, { x: null, y: null, z: null });
      }
      this.channels.get(spec.group)[spec.axis] = actuator;
    }

    // fallback 分量的当前值缓存
    this.fallback = {};
    for (const name of Object.keys(joints)) {
      this.fallback[name] = { x: 0, y: 0, z: 0 };
    }
    this.accumulator = 0;
  }

  /** 把行为层的欧拉目标姿态写入各关节伺服目标。 */
  setTargets(targetsByGroup) {
    for (const [group, channel] of this.channels) {
      const tgt = targetsByGroup[group];
      if (!tgt) continue;
      if (channel.x) channel.x.setTarget(tgt.x || 0);
      if (channel.y) channel.y.setTarget(tgt.y || 0);
      if (channel.z) channel.z.setTarget(tgt.z || 0);
    }
  }

  /**
   * 推进伺服并把结果写回 Three.js 关节。
   * @param {number} dt 渲染帧时长
   * @param {Object} targetsByGroup 同 setTargets 的目标表（fallback 分量需要）
   * @param {(name:string)=>number} fallbackTau 未映射分量的平滑时间常数
   */
  step(dt, targetsByGroup, fallbackTau) {
    for (const actuator of this.actuators) {
      actuator.saturated = false;
      actuator.atLimit = false;
    }

    // 固定步长积分：渲染帧率无论多少，伺服都按 500Hz 推进。
    this.accumulator = Math.min(
      this.accumulator + dt, CONTROL_DT * MAX_SUBSTEPS);
    while (this.accumulator >= CONTROL_DT) {
      this.accumulator -= CONTROL_DT;
      for (const actuator of this.actuators) actuator.tick(CONTROL_DT);
    }

    // 写回：映射分量取伺服角，其余分量按旧逻辑平滑。
    for (const [name, joint] of Object.entries(this.joints)) {
      const channel = this.channels.get(name);
      const tgt = targetsByGroup[name] || { x: 0, y: 0, z: 0 };
      const cur = this.fallback[name];
      for (const axis of ['x', 'y', 'z']) {
        const actuator = channel?.[axis];
        if (actuator) {
          cur[axis] = actuator.q;
        } else {
          cur[axis] = damp(cur[axis], tgt[axis] || 0, fallbackTau(name), dt);
        }
      }
      joint.rotation.set(cur.x, cur.y, cur.z);
    }
  }

  /** 把伺服状态直接同步到给定姿态（行为切换大跳时可选用）。 */
  snapTo(targetsByGroup) {
    for (const [group, channel] of this.channels) {
      const tgt = targetsByGroup[group] || { x: 0, y: 0, z: 0 };
      for (const axis of ['x', 'y', 'z']) {
        channel[axis]?.hardSet(tgt[axis] || 0);
      }
    }
  }

  /** 遥测：HUD 关节监视用。 */
  telemetry() {
    return this.actuators.map((a) => ({
      name: a.spec.name,
      q: a.q, dq: a.dq, target: a.target, torque: a.torque,
      effort: a.spec.effort,
      saturated: a.saturated, atLimit: a.atLimit,
    }));
  }
}

export { CONTROL_DT };
