// 行为（Behavior）：每个行为在每帧产出一个"目标姿态"。
// MotionController 负责把目标姿态平滑地施加到关节上（类 PD 控制）。
//
// 行为的 update(ctx) 返回一个 pose 对象：
//   {
//     joints: { 关节名: {x,y,z} },   // 关节欧拉角目标（缺省按 rest 处理）
//     rootHeight: number,             // 根（pelvis）的绝对高度
//     forwardSpeed: number,           // 沿朝向的前进速度 m/s
//     rootRoll/rootPitch: number      // 根的姿态微调
//   }
//
// ctx = { t, dt, dim, params }  params 来自 HUD（speed/stride 等）

import { DIM, baseRootHeight } from '../robot/skeleton.js';
import { solveLegIK, clamp, lerp, smoothstep, TAU } from './MathUtils.js';

const KNEE_SIGN = -1; // 膝弯曲方向；若膝盖反向（像鸟腿）改为 +1

// 工具：让脚相对髋做 IK，写入 hip/knee/ankle 目标
function footIK(pose, side, footZ, footY, extraAnkle = 0) {
  const { hip, knee } = solveLegIK(footZ, footY, DIM.thigh, DIM.shin, KNEE_SIGN);
  pose.joints['hip' + side] = { x: hip, y: 0, z: 0 };
  pose.joints['knee' + side] = { x: knee, y: 0, z: 0 };
  // 踝部反向补偿，使脚掌大致平行地面
  pose.joints['ankle' + side] = { x: -(hip + knee) + extraAnkle, y: 0, z: 0 };
}

function emptyPose() {
  return { joints: {}, rootHeight: baseRootHeight(), forwardSpeed: 0, rootRoll: 0, rootPitch: 0 };
}

// ============================================================
// IDLE：站立，呼吸起伏 + 轻微重心摆动
// ============================================================
export class IdleBehavior {
  constructor() { this.name = 'idle'; }
  update(ctx) {
    const p = emptyPose();
    const breathe = Math.sin(ctx.t * 1.6) * 0.012;
    const sway = Math.sin(ctx.t * 0.8) * 0.03;
    p.rootHeight = baseRootHeight() + breathe;
    p.rootRoll = sway * 0.3;

    const footY = -(DIM.standHipHeight + breathe);
    footIK(p, 'L', 0, footY);
    footIK(p, 'R', 0, footY);

    // 手臂自然下垂 + 微摆
    const a = Math.sin(ctx.t * 1.6) * 0.04;
    p.joints.shoulderL = { x: 0.05 + a, y: 0, z: 0.12 };
    p.joints.shoulderR = { x: 0.05 - a, y: 0, z: -0.12 };
    p.joints.elbowL = { x: 0.18, y: 0, z: 0 };
    p.joints.elbowR = { x: 0.18, y: 0, z: 0 };
    p.joints.waist = { x: 0, y: sway * 0.4, z: 0 };
    p.joints.head = { x: 0, y: Math.sin(ctx.t * 0.5) * 0.12, z: 0 };
    return p;
  }
}

// ============================================================
// WALK：基于 IK 的步态发生器（核心）
//   - 占空比 duty：支撑相脚贴地向后，摆动相抬脚向前（摆线）
//   - 骨盆 2 倍频上下起伏 + 横向摆向支撑腿
//   - 手臂与腿反相摆动
// ============================================================
export class WalkBehavior {
  constructor() { this.name = 'walk'; this.phase = 0; }

  update(ctx) {
    const p = emptyPose();
    const sp = ctx.params.speed;        // 0.4..2.2
    const stride = ctx.params.stride;   // 步幅（单脚前后行程的一半 ~= S/2）
    const S = stride;                   // 半行程
    const cadence = 0.9 * sp;           // 步频（cycle/s）
    const duty = 0.62;                  // 支撑相占比
    const stepHeight = 0.07 + 0.05 * sp;

    this.phase = (this.phase + ctx.dt * cadence) % 1;

    const legPhase = (side) => (side === 'L' ? this.phase : (this.phase + 0.5) % 1);

    // 单腿：返回前向偏移 f（正=前）与抬高 lift
    const legTarget = (ph) => {
      let f, lift;
      if (ph < duty) {                       // 支撑相：贴地，从前到后
        const u = ph / duty;
        f = lerp(S, -S, u);
        lift = 0;
      } else {                               // 摆动相：抬脚回到前方
        const u = (ph - duty) / (1 - duty);
        f = lerp(-S, S, smoothstep(u));
        lift = Math.sin(Math.PI * u) * stepHeight;
      }
      return { f, lift };
    };

    // 骨盆竖直起伏（支撑中点最高）2x 频率，横向摆动 1x
    const bob = Math.cos(this.phase * 2 * TAU) * 0.012;
    const sway = Math.sin(this.phase * TAU) * 0.025;
    p.rootHeight = baseRootHeight() - 0.02 + bob;
    p.rootRoll = -sway * 0.5;
    p.rootPitch = 0.04; // 略前倾

    const baseY = -(DIM.standHipHeight - 0.01);
    for (const side of ['L', 'R']) {
      const { f, lift } = legTarget(legPhase(side));
      // forward = -Z，所以前向偏移 f 对应 localZ = -f
      footIK(p, side, -f, baseY + lift, lift * 0.6);
    }

    // 前进速度：一个周期身体前进约 2S（支撑相走完整个行程）
    p.forwardSpeed = 2 * S * cadence;

    // 手臂反相摆动（与同侧腿相反）
    const swingL = Math.sin(this.phase * TAU);
    const swingR = Math.sin((this.phase + 0.5) * TAU);
    p.joints.shoulderL = { x: -swingR * 0.5, y: 0, z: 0.1 };
    p.joints.shoulderR = { x: -swingL * 0.5, y: 0, z: -0.1 };
    p.joints.elbowL = { x: 0.5 + swingR * 0.15, y: 0, z: 0 };
    p.joints.elbowR = { x: 0.5 + swingL * 0.15, y: 0, z: 0 };

    // 躯干随步伐反向小幅扭转
    p.joints.waist = { x: 0.02, y: swingL * 0.06, z: sway * 0.3 };
    p.joints.head = { x: 0, y: 0, z: 0 };
    return p;
  }
}

// ============================================================
// WAVE：右臂举起挥手（叠加在站立上）
// ============================================================
export class WaveBehavior {
  constructor() { this.name = 'wave'; this.t = 0; }
  update(ctx) {
    const p = new IdleBehavior().update(ctx);
    const wave = Math.sin(ctx.t * 6) * 0.35;
    p.joints.shoulderR = { x: -2.4, y: 0, z: -0.5 };
    p.joints.elbowR = { x: 0.4 + wave, y: wave * 0.5, z: 0 };
    p.joints.head = { x: -0.1, y: -0.25, z: 0 }; // 看向举起的手
    p.joints.waist = { x: 0, y: -0.08, z: 0 };
    return p;
  }
}

// ============================================================
// DANCE：随节拍编排的舞蹈（多段循环动作）
// ============================================================
export class DanceBehavior {
  constructor() { this.name = 'dance'; }
  update(ctx) {
    const p = emptyPose();
    const bpm = 120;
    const beat = (ctx.t * bpm) / 60;     // 拍计数
    const bp = beat % 4;                   // 4 拍小节
    const w = TAU * (bpm / 60);            // 角频率

    // 屈膝 groove：随拍上下
    const squat = (Math.sin(w * ctx.t) * 0.5 + 0.5) * 0.10;
    p.rootHeight = baseRootHeight() - 0.04 - squat;
    const sway = Math.sin(w * ctx.t) * 0.06;
    p.rootRoll = sway;

    // 双脚分开、随重心左右
    const footY = -(DIM.standHipHeight - squat - 0.01);
    const shift = Math.sin(w * ctx.t) * 0.04;
    footIK(p, 'L', shift, footY + Math.max(0, Math.sin(w * ctx.t)) * 0.0);
    footIK(p, 'R', shift, footY);

    // 手臂动作：每小节切换造型
    const seg = Math.floor((beat / 4) % 4);
    const a = Math.sin(w * ctx.t);
    const b = Math.cos(w * ctx.t);
    if (seg === 0) {
      // 双手上举交替
      p.joints.shoulderL = { x: -2.2 + a * 0.6, y: 0, z: 0.3 };
      p.joints.shoulderR = { x: -2.2 - a * 0.6, y: 0, z: -0.3 };
      p.joints.elbowL = { x: 0.3, y: 0, z: 0 };
      p.joints.elbowR = { x: 0.3, y: 0, z: 0 };
    } else if (seg === 1) {
      // 抱胸 / 推手
      p.joints.shoulderL = { x: -1.3, y: 0.4 + a * 0.4, z: 0.4 };
      p.joints.shoulderR = { x: -1.3, y: -0.4 - a * 0.4, z: -0.4 };
      p.joints.elbowL = { x: 1.6, y: 0, z: 0 };
      p.joints.elbowR = { x: 1.6, y: 0, z: 0 };
    } else if (seg === 2) {
      // 风车臂
      p.joints.shoulderL = { x: -1.5 + a * 1.6, y: 0, z: 0.2 };
      p.joints.shoulderR = { x: -1.5 - a * 1.6, y: 0, z: -0.2 };
      p.joints.elbowL = { x: 0.4, y: 0, z: 0 };
      p.joints.elbowR = { x: 0.4, y: 0, z: 0 };
    } else {
      // 摆手 + 扭胯
      p.joints.shoulderL = { x: -0.6 + b * 0.5, y: 0, z: 0.8 };
      p.joints.shoulderR = { x: -0.6 - b * 0.5, y: 0, z: -0.8 };
      p.joints.elbowL = { x: 0.9, y: 0, z: 0 };
      p.joints.elbowR = { x: 0.9, y: 0, z: 0 };
    }

    p.joints.waist = { x: 0, y: sway * 1.2, z: -sway * 0.6 };
    p.joints.head = { x: 0.1 * b, y: sway, z: -sway };
    return p;
  }
}

// ============================================================
// JUMP：蹲伏 → 起跳 → 腾空(弹道) → 落地缓冲 → 恢复
//   一次性动作，结束后回到 idle
// ============================================================
export class JumpBehavior {
  constructor(onDone) {
    this.name = 'jump';
    this.t = 0;
    this.onDone = onDone;
    // 阶段时间
    this.crouch = 0.28;
    this.push = 0.12;
    this.air = 0.52;
    this.land = 0.22;
    this.total = this.crouch + this.push + this.air + this.land;
    this.launchV = 3.0;  // 起跳速度
  }
  update(ctx) {
    this.t += ctx.dt;
    const p = emptyPose();
    const base = baseRootHeight();
    let h = base, crouchAmt = 0;

    if (this.t < this.crouch) {
      const u = this.t / this.crouch;
      crouchAmt = smoothstep(u) * 0.16;
      h = base - crouchAmt;
    } else if (this.t < this.crouch + this.push) {
      const u = (this.t - this.crouch) / this.push;
      crouchAmt = (1 - smoothstep(u)) * 0.16;
      h = base - crouchAmt + smoothstep(u) * 0.04;
    } else if (this.t < this.crouch + this.push + this.air) {
      const ta = this.t - this.crouch - this.push;
      const g = 9.8;
      h = base + 0.04 + this.launchV * ta - 0.5 * g * ta * ta;
      crouchAmt = 0.02;
    } else if (this.t < this.total) {
      const u = (this.t - this.crouch - this.push - this.air) / this.land;
      crouchAmt = Math.sin(Math.PI * u) * 0.14;
      h = base - crouchAmt;
    } else {
      if (this.onDone) this.onDone();
      h = base;
    }

    h = Math.max(h, DIM.footH); // 不穿地
    p.rootHeight = h;

    // 腿：腾空时髋膝收起，地面时按高度做 IK
    const inAir = this.t >= this.crouch + this.push &&
                  this.t < this.crouch + this.push + this.air;
    if (inAir) {
      const tuck = 0.5;
      p.joints.hipL = { x: 0.5, y: 0, z: 0 };
      p.joints.hipR = { x: 0.5, y: 0, z: 0 };
      p.joints.kneeL = { x: KNEE_SIGN * 1.0, y: 0, z: 0 };
      p.joints.kneeR = { x: KNEE_SIGN * 1.0, y: 0, z: 0 };
      p.joints.ankleL = { x: 0.3, y: 0, z: 0 };
      p.joints.ankleR = { x: 0.3, y: 0, z: 0 };
    } else {
      const footY = -(base - crouchAmt - DIM.pelvisH * 0.5 - DIM.footH * 0.5);
      footIK(p, 'L', 0, footY);
      footIK(p, 'R', 0, footY);
    }

    // 手臂：蹲时后摆，跳时上甩
    const armUp = inAir ? -2.6 : -0.3 + crouchAmt * 4;
    p.joints.shoulderL = { x: armUp, y: 0, z: 0.15 };
    p.joints.shoulderR = { x: armUp, y: 0, z: -0.15 };
    p.joints.elbowL = { x: 0.3, y: 0, z: 0 };
    p.joints.elbowR = { x: 0.3, y: 0, z: 0 };
    p.joints.waist = { x: inAir ? -0.15 : crouchAmt * 1.5, y: 0, z: 0 };
    return p;
  }
}
