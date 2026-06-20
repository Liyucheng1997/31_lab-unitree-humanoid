import * as THREE from 'three';
import { dampEuler, damp, clamp } from './MathUtils.js?v=20260620-baduanjin-steps-v2';
import { BalanceController } from './BalanceController.js?v=20260620-baduanjin-steps-v2';
import { DIM, FORWARD_Z, baseRootHeight } from '../robot/skeleton.js?v=20260620-baduanjin-steps-v2';
import {
  IdleBehavior, WalkBehavior, DanceBehavior, WaveBehavior, JumpBehavior, BaduanjinBehavior,
} from './behaviors.js?v=20260620-baduanjin-steps-v2';

// 关节的"静止"姿态（无目标时回归）
const REST = {
  shoulderL: { x: -0.08, y: 0, z: 0.12 }, shoulderR: { x: -0.08, y: 0, z: -0.12 },
  elbowL: { x: -0.22, y: 0, z: 0 }, elbowR: { x: -0.22, y: 0, z: 0 },
};

/**
 * 运动控制器：
 *  - 持有命名关节，保存每个关节的"当前角"，每帧朝目标角平滑（类 PD）。
 *  - 持有行为状态机，行为产出目标姿态。
 *  - 处理根节点运动：朝向(yaw)、前进位移、高度。
 */
export class MotionController {
  constructor(rig) {
    this.rig = rig;                 // { root, joints }
    this.joints = rig.joints;
    this.t = 0;

    // 每个关节的当前角缓存
    this.cur = {};
    for (const name of Object.keys(this.joints)) {
      this.cur[name] = { x: 0, y: 0, z: 0 };
    }

    // 根运动状态
    this.yaw = 0;
    this.rootY = baseRootHeight();
    this.rootPitch = 0;
    this.rootRoll = 0;
    this.balance = new BalanceController({
      footWidth: DIM.footWidth,
      footLength: DIM.footLen,
    });
    this.balanceState = this.balance.output();

    // 关节平滑时间常数（s）—越小响应越快。不同部位可不同。
    this.tau = {
      default: 0.08,
      leg: 0.05,     // 腿要快，跟上步态
      arm: 0.10,
    };

    // 行为
    this.behaviors = {
      idle: new IdleBehavior(),
      walk: new WalkBehavior(),
      dance: new DanceBehavior(),
      wave: new WaveBehavior(),
      baduanjin: new BaduanjinBehavior(),
    };
    this.current = this.behaviors.idle;

    // HUD 参数
    this.params = { speed: 1.0, stride: 0.26, turn: 0 };
    this.moveInput = { fwd: 0, turn: 0 }; // 键盘
  }

  setBehavior(name) {
    if (name === 'jump') {
      // 跳跃是一次性行为，完成后回到 idle
      this.current = new JumpBehavior(() => { this.current = this.behaviors.idle; });
      return;
    }
    if (this.behaviors[name]) {
      this.current = this.behaviors[name];
      if (typeof this.current.reset === 'function') this.current.reset();
    }
  }

  get behaviorName() { return this.current.name; }

  applyPush(xImpulse = 0, zImpulse = 0) {
    this.balance.applyImpulse(xImpulse, zImpulse);
  }

  tauFor(name) {
    if (name.startsWith('hip') || name.startsWith('knee') || name.startsWith('ankle'))
      return this.tau.leg;
    if (name.startsWith('shoulder') || name.startsWith('elbow'))
      return this.tau.arm;
    return this.tau.default;
  }

  update(dt) {
    dt = Math.min(dt, 0.05); // 防止卡顿后大跳
    this.t += dt;

    // 行为产出目标姿态
    const ctx = { t: this.t, dt, dim: DIM, params: this.params };
    const pose = this.current.update(ctx);
    this.balanceState = this.balance.step(pose, dt);

    // Closed-loop ankle strategy plus a smaller hip counter-action.
    const feedback = this.balanceState;
    for (const side of ['L', 'R']) {
      const ankle = pose.joints[`ankle${side}`];
      if (ankle) {
        ankle.x += feedback.anklePitch;
        ankle.z += feedback.ankleRoll;
      }
      const hip = pose.joints[`hip${side}`];
      if (hip) {
        hip.x -= feedback.anklePitch * 0.35;
        hip.z -= feedback.ankleRoll * 0.35;
      }
    }

    // ---- 关节平滑 ----
    for (const name of Object.keys(this.joints)) {
      const tgt = pose.joints[name] || REST[name] || { x: 0, y: 0, z: 0 };
      const tau = this.tauFor(name);
      dampEuler(this.cur[name], tgt, tau, dt);
      const j = this.joints[name];
      j.rotation.set(this.cur[name].x, this.cur[name].y, this.cur[name].z);
    }

    // ---- 根：朝向 ----
    // 转向：HUD 滑块 + 键盘，仅在能移动的行为里生效
    const canSteer = this.current.name === 'walk';
    const turnRate = (this.params.turn + this.moveInput.turn);
    if (canSteer) this.yaw += turnRate * 1.6 * dt;
    else this.yaw += this.moveInput.turn * 1.2 * dt;
    this.rig.root.rotation.y = this.yaw;

    // ---- 根：前进位移（沿机器人视觉正面 +Z 的本地方向）----
    const speed = pose.forwardSpeed || 0;
    if (speed !== 0) {
      const fx = Math.sin(this.yaw) * FORWARD_Z;
      const fz = Math.cos(this.yaw) * FORWARD_Z;
      this.rig.root.position.x += fx * speed * dt;
      this.rig.root.position.z += fz * speed * dt;
    }

    // ---- 根：高度 / 姿态 平滑 ----
    const hTau = this.current.name === 'jump' ? 0.012 : 0.06;
    this.rootY = damp(this.rootY, pose.rootHeight, hTau, dt);
    this.rig.root.position.y = this.rootY;
    const physicalPitch = clamp(feedback.bodyPitch, -0.32, 0.32);
    const physicalRoll = clamp(feedback.bodyRoll, -0.32, 0.32);
    this.rootPitch = damp(this.rootPitch, (pose.rootPitch || 0) + physicalPitch, 0.06, dt);
    this.rootRoll = damp(this.rootRoll, (pose.rootRoll || 0) + physicalRoll, 0.06, dt);
    // 把 pitch/roll 叠加到根（保留 yaw）
    this.rig.root.rotation.x = this.rootPitch;
    this.rig.root.rotation.z = this.rootRoll;
  }
}
