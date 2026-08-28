// 行为（Behavior）：每个行为在每帧产出一个"目标姿态"。
// MotionController 负责把目标姿态平滑地施加到关节上（类 PD 控制）。
//
// 行为的 update(ctx) 返回一个 pose 对象：
//   {
//     joints: { 关节名: {x,y,z} },   // 关节欧拉角目标（缺省按 rest 处理）
//     rootHeight: number,             // 根（pelvis）的绝对高度
//     forwardSpeed: number,           // 沿朝向的前进速度 m/s
//     rootRoll/rootPitch: number,     // 根的姿态微调
//     hands: { L, R },                // 手指卷曲 0=张开 1=握拳
//     emotion: string,                // 面部灯光表情（见 RobotBuilder EMOTIONS）
//     flash: boolean,                 // 本帧眼部闪光（发力瞬间）
//     autoLook: boolean,              // 允许头部自动注视镜头
//     pitchTau/heightTau: number,     // 覆盖根姿态平滑常数（空翻等快动作用）
//   }
//
// ctx = { t, dt, dim, params, move }  params 来自 HUD，move 来自键盘

import { DIM, FORWARD_Z, baseRootHeight } from '../robot/skeleton.js?v=20260828-rpo-v1';
import { solveLegIK, clamp, lerp, smoothstep, TAU } from './MathUtils.js?v=20260828-rpo-v1';
import { GRAVITY } from './BalanceController.js?v=20260828-rpo-v1';

export const KNEE_SIGN = FORWARD_Z; // 膝盖始终朝视觉正面弯曲

// 工具：让脚相对髋做 IK，写入 hip/knee/ankle 目标
function footIK(pose, side, footZ, footY, extraAnkle = 0, contact = true,
                lateral = 0, footYaw = 0) {
  // 先把横向目标投影到腿长平面，再分别求髋俯仰与髋外展。
  const projectedY = -Math.hypot(footY, lateral);
  const { hip, knee } = solveLegIK(footZ, projectedY, DIM.thigh, DIM.shin, KNEE_SIGN);
  const hipRoll = Math.atan2(lateral, -footY);
  pose.joints['hip' + side] = { x: hip, y: footYaw, z: hipRoll };
  pose.joints['knee' + side] = { x: knee, y: 0, z: 0 };
  // 踝部反向补偿，使脚掌大致平行地面
  pose.joints['ankle' + side] = {
    x: -(hip + knee) + extraAnkle, y: -footYaw, z: -hipRoll,
  };
  pose.feet[side] = {
    x: (side === 'L' ? 1 : -1) * DIM.hipWidth * 0.5 + lateral,
    z: footZ,
    contact,
  };
}

function emptyPose() {
  return {
    joints: {}, feet: {}, balanceTarget: null,
    rootHeight: baseRootHeight(), forwardSpeed: 0, rootRoll: 0, rootPitch: 0,
    hands: { L: 0.15, R: 0.15 },
    emotion: 'calm', flash: false, autoLook: false,
  };
}

// 正值表示符合人体结构的“向前屈肘”，转换为 Three.js 绕 X 轴的负角度。
const elbowFlex = (x, y = 0, z = 0) => ({ x: -x, y, z });

function windowPulse(u, start, end) {
  if (u <= start || u >= end) return 0;
  return Math.sin(Math.PI * (u - start) / (end - start));
}

// ============================================================
// IDLE：站立，呼吸起伏 + 轻微重心摆动 + 注视镜头
// ============================================================
export class IdleBehavior {
  constructor() { this.name = 'idle'; }
  update(ctx) {
    const p = emptyPose();
    p.autoLook = true;
    const breathe = Math.sin(ctx.t * 1.6) * 0.012;
    const sway = Math.sin(ctx.t * 0.8) * 0.03;
    p.rootHeight = baseRootHeight() + breathe;
    p.rootRoll = sway * 0.3;

    const footY = -(DIM.standHipHeight + breathe);
    footIK(p, 'L', 0, footY);
    footIK(p, 'R', 0, footY);

    // 手臂自然下垂 + 微摆；手指偶尔轻捻，像在待机自检。
    const a = Math.sin(ctx.t * 1.6) * 0.04;
    p.joints.shoulderL = { x: -0.08 + a, y: 0, z: 0.12 };
    p.joints.shoulderR = { x: -0.08 - a, y: 0, z: -0.12 };
    p.joints.elbowL = elbowFlex(0.22);
    p.joints.elbowR = elbowFlex(0.22);
    p.hands.L = p.hands.R = 0.18 + Math.max(0, Math.sin(ctx.t * 0.45)) * 0.14;
    p.joints.waist = { x: 0, y: sway * 0.4, z: 0 };
    p.joints.head = { x: 0, y: Math.sin(ctx.t * 0.5) * 0.12, z: 0 };
    return p;
  }
}

// ============================================================
// WALK：基于 IK 的步态发生器（核心）
//   - 占空比 duty：支撑相脚贴地向后，摆动相抬脚向前（摆线）
//   - 骨盆 2 倍频上下起伏 + 横向摆向支撑腿
//   - 手臂与腿反相摆动；支持倒退与转弯侧倾
// ============================================================
export class WalkBehavior {
  constructor() { this.name = 'walk'; this.phase = 0; }

  update(ctx) {
    const p = emptyPose();
    p.emotion = 'focus';
    const dir = ctx.move && ctx.move.fwd < 0 ? -1 : 1; // S 键倒退
    const sp = ctx.params.speed * (dir < 0 ? 0.7 : 1); // 倒退放慢
    const stride = ctx.params.stride;   // 步幅（单脚前后行程的一半 ~= S/2）
    const S = stride;                   // 半行程
    const cadence = 0.9 * sp;           // 步频（cycle/s）
    const duty = 0.90;                  // 支撑相占比；延长双支撑，为重心换脚留出时间
    const stepHeight = (0.07 + 0.05 * sp) * (dir < 0 ? 0.7 : 1);

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
    p.rootPitch = 0.04 * dir; // 前进略前倾，倒退略后仰

    const baseY = -(DIM.standHipHeight - 0.01);
    for (const side of ['L', 'R']) {
      const { f, lift } = legTarget(legPhase(side));
      // 足端前向偏移与机器人视觉正面保持一致
      const contact = legPhase(side) < duty;
      footIK(p, side, f * FORWARD_Z * dir, baseY + lift, lift * 0.6, contact);
    }

    // 转弯时身体向弯道内侧倾斜，像真人骑行式压弯。
    const turn = (ctx.params.turn || 0) + (ctx.move ? ctx.move.turn : 0);
    p.rootRoll = -sway * 0.5 + turn * 0.10 * dir;

    // Anticipatory COM target: shift toward the stance leg before single support.
    // The balance loop further clamps this target to the measured support polygon.
    p.balanceTarget = {
      // 在双支撑开始时即预载下一条支撑腿，而不是等抬脚后才纠偏。
      x: (this.phase < 0.5 ? 1 : -1) * DIM.hipWidth * 0.275,
      z: 0,
    };

    // 前进速度：一个周期身体前进约 2S（支撑相走完整个行程）
    p.forwardSpeed = 2 * S * cadence * dir;

    // 手臂反相摆动（与同侧腿相反）
    const swingL = Math.sin(this.phase * TAU);
    const swingR = Math.sin((this.phase + 0.5) * TAU);
    p.joints.shoulderL = { x: -swingR * 0.5, y: 0, z: 0.1 };
    p.joints.shoulderR = { x: -swingL * 0.5, y: 0, z: -0.1 };
    p.joints.elbowL = elbowFlex(0.5 + swingR * 0.15);
    p.joints.elbowR = elbowFlex(0.5 + swingL * 0.15);
    p.hands.L = p.hands.R = 0.3;

    // 躯干随步伐反向小幅扭转
    p.joints.waist = { x: 0.02, y: swingL * 0.06, z: sway * 0.3 };
    p.joints.head = { x: 0, y: turn * 0.35, z: 0 }; // 看向转弯方向
    return p;
  }
}

// ============================================================
// RUN：跑步步态——占空比 < 0.5 产生真实腾空相
//   骨盆起伏更大、躯干前倾、屈肘摆臂、松握拳
// ============================================================
export class RunBehavior {
  constructor() { this.name = 'run'; this.phase = 0; }

  update(ctx) {
    const p = emptyPose();
    p.emotion = 'power';
    const sp = ctx.params.speed;
    const S = ctx.params.stride * 1.35;    // 跑步步幅放大
    const cadence = 1.1 + 0.85 * sp;       // 步频明显高于走路
    const duty = 0.42;                     // < 0.5：两个支撑窗之间出现双脚离地
    const stepHeight = 0.12 + 0.05 * sp;

    this.phase = (this.phase + ctx.dt * cadence) % 1;
    const legPhase = (side) => (side === 'L' ? this.phase : (this.phase + 0.5) % 1);

    const legTarget = (ph) => {
      if (ph < duty) {
        const u = ph / duty;
        return { f: lerp(S, -S, u), lift: 0 };
      }
      const u = (ph - duty) / (1 - duty);
      return {
        f: lerp(-S, S, smoothstep(u)),
        lift: Math.sin(Math.PI * u) * stepHeight,
      };
    };

    // 腾空窗（两条腿都不接触）抬升重心，模拟弹道飞行段。
    const flight = (windowPulse(this.phase, duty, 0.5)
      + windowPulse(this.phase, duty + 0.5, 1.0)) * 0.045;
    const bob = Math.cos(this.phase * 2 * TAU) * 0.02;
    p.rootHeight = baseRootHeight() - 0.05 + bob + flight;
    p.rootPitch = 0.13;                    // 明显前倾

    const baseY = -(DIM.standHipHeight - 0.02);
    for (const side of ['L', 'R']) {
      const ph = legPhase(side);
      const { f, lift } = legTarget(ph);
      footIK(p, side, f * FORWARD_Z, baseY + lift, lift * 0.5, ph < duty);
    }

    const turn = (ctx.params.turn || 0) + (ctx.move ? ctx.move.turn : 0);
    const sway = Math.sin(this.phase * TAU) * 0.02;
    p.rootRoll = -sway * 0.5 + turn * 0.16;

    p.balanceTarget = {
      x: (this.phase < 0.5 ? 1 : -1) * DIM.hipWidth * 0.2,
      z: 0.02,
    };
    p.forwardSpeed = 2 * S * cadence;

    // 摆臂：屈肘 90°，前后大幅泵动，松握拳。
    const swingL = Math.sin(this.phase * TAU);
    const swingR = Math.sin((this.phase + 0.5) * TAU);
    p.joints.shoulderL = { x: -0.25 - swingR * 0.85, y: 0, z: 0.14 };
    p.joints.shoulderR = { x: -0.25 - swingL * 0.85, y: 0, z: -0.14 };
    p.joints.elbowL = elbowFlex(1.35);
    p.joints.elbowR = elbowFlex(1.35);
    p.hands.L = p.hands.R = 0.7;

    p.joints.waist = { x: 0.06, y: swingL * 0.1, z: sway * 0.3 };
    p.joints.head = { x: -0.08, y: turn * 0.3, z: 0 }; // 抬头看路
    return p;
  }
}

// ============================================================
// WAVE：右臂举起、手腕挥动（叠加在站立上）
// ============================================================
export class WaveBehavior {
  constructor() { this.name = 'wave'; this.t = 0; }
  update(ctx) {
    const p = new IdleBehavior().update(ctx);
    const wave = Math.sin(ctx.t * 6) * 0.5;
    p.joints.shoulderR = { x: -2.4, y: 0, z: -0.5 };
    p.joints.elbowR = elbowFlex(0.5);
    p.joints.wristR = { x: 0, y: 0, z: wave };  // 手腕左右摆，掌心朝外
    p.hands.R = 0.05;                            // 张开手掌
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
    p.emotion = 'joy';
    const bpm = 120;
    const beat = (ctx.t * bpm) / 60;     // 拍计数
    const w = TAU * (bpm / 60);            // 角频率

    // 屈膝 groove：随拍上下
    const squat = (Math.sin(w * ctx.t) * 0.5 + 0.5) * 0.10;
    p.rootHeight = baseRootHeight() - 0.04 - squat;
    const sway = Math.sin(w * ctx.t) * 0.06;
    p.rootRoll = sway;

    // 双脚分开、随重心左右
    const footY = -(DIM.standHipHeight - squat - 0.01);
    const shift = Math.sin(w * ctx.t) * 0.04;
    footIK(p, 'L', shift, footY);
    footIK(p, 'R', shift, footY);

    // 手臂动作：每小节切换造型
    const seg = Math.floor((beat / 4) % 4);
    const a = Math.sin(w * ctx.t);
    const b = Math.cos(w * ctx.t);
    if (seg === 0) {
      // 双手上举交替
      p.joints.shoulderL = { x: -2.2 + a * 0.6, y: 0, z: 0.3 };
      p.joints.shoulderR = { x: -2.2 - a * 0.6, y: 0, z: -0.3 };
      p.joints.elbowL = elbowFlex(0.3);
      p.joints.elbowR = elbowFlex(0.3);
      p.joints.wristL = { x: 0, y: 0, z: a * 0.6 };
      p.joints.wristR = { x: 0, y: 0, z: -a * 0.6 };
      p.hands.L = p.hands.R = 0.05;
    } else if (seg === 1) {
      // 抱胸 / 推手
      p.joints.shoulderL = { x: -1.3, y: 0.4 + a * 0.4, z: 0.4 };
      p.joints.shoulderR = { x: -1.3, y: -0.4 - a * 0.4, z: -0.4 };
      p.joints.elbowL = elbowFlex(1.6);
      p.joints.elbowR = elbowFlex(1.6);
      p.hands.L = p.hands.R = 0.4;
    } else if (seg === 2) {
      // 风车臂
      p.joints.shoulderL = { x: -1.5 + a * 1.6, y: 0, z: 0.2 };
      p.joints.shoulderR = { x: -1.5 - a * 1.6, y: 0, z: -0.2 };
      p.joints.elbowL = elbowFlex(0.4);
      p.joints.elbowR = elbowFlex(0.4);
      p.hands.L = p.hands.R = 0.1;
    } else {
      // 摆手 + 扭胯
      p.joints.shoulderL = { x: -0.6 + b * 0.5, y: 0, z: 0.8 };
      p.joints.shoulderR = { x: -0.6 - b * 0.5, y: 0, z: -0.8 };
      p.joints.elbowL = elbowFlex(0.9);
      p.joints.elbowR = elbowFlex(0.9);
      p.joints.wristL = { x: 0, y: 0, z: b * 0.7 };
      p.joints.wristR = { x: 0, y: 0, z: b * 0.7 };
      p.hands.L = p.hands.R = 0.05;
    }

    p.joints.waist = { x: 0, y: sway * 1.2, z: -sway * 0.6 };
    p.joints.head = { x: 0.1 * b, y: sway, z: -sway };
    return p;
  }
}

// ============================================================
// 八段锦：八式传统功法，每式 8 秒，完整一轮约 64 秒。
// ============================================================
export const BADUANJIN_FORMS = [
  '双手托天理三焦', '左右开弓似射雕', '调理脾胃须单举', '五劳七伤往后瞧',
  '摇头摆尾去心火', '两手攀足固肾腰', '攒拳怒目增气力', '背后七颠百病消',
];

const FORM_SECONDS = 8;

function baduanjinBase(squat = 0) {
  const p = emptyPose();
  p.emotion = 'zen';
  p.hands = { L: 0.1, R: 0.1 };
  p.rootHeight = baseRootHeight() - squat;
  const footY = -(DIM.standHipHeight - squat);
  footIK(p, 'L', 0, footY);
  footIK(p, 'R', 0, footY);
  p.joints.head = { x: 0, y: 0, z: 0 };
  p.joints.waist = { x: 0, y: 0, z: 0 };
  return p;
}

// 慢速换重心 → 单脚摆动 → 双脚落稳。每个 step segment 对应一次脚步。
function alternatingStep(u, count = 2) {
  const raw = Math.min(u * count, count - 1e-6);
  const index = Math.floor(raw);
  const phase = raw - index;
  const movingSide = index % 2 === 0 ? 'R' : 'L';
  const stanceSide = movingSide === 'L' ? 'R' : 'L';
  const swingU = clamp((phase - 0.28) / 0.38, 0, 1);
  const lift = phase > 0.28 && phase < 0.66 ? Math.sin(Math.PI * swingU) : 0;
  const preload = phase < 0.22
    ? smoothstep(phase / 0.22)
    : phase < 0.72 ? 1 : 1 - smoothstep((phase - 0.72) / 0.28);
  return {
    movingSide, stanceSide, lift,
    excursion: Math.sin(Math.PI * swingU),
    contact: lift < 0.025,
    preload,
  };
}

function applyBaduanjinFootwork(index, u, p) {
  const squat = clamp(baseRootHeight() - p.rootHeight, -0.06, 0.18);
  let footY = -(DIM.standHipHeight - squat);
  const feet = {
    L: { z: 0, lift: 0, lateral: 0, yaw: 0, ankle: 0, contact: true },
    R: { z: 0, lift: 0, lateral: 0, yaw: 0, ankle: 0, contact: true },
  };
  let step = null;
  const open = Math.sin(Math.PI * u);

  if (index === 0) {
    // 起势开步与收步：左脚横向开合，手臂上托时同步提踵。
    feet.L.lateral = 0.065 * open;
    feet.L.lift = Math.max(windowPulse(u, 0.18, 0.36), windowPulse(u, 0.68, 0.86)) * 0.045;
    feet.L.contact = feet.L.lift < 0.002;
    const heel = Math.pow(Math.sin(Math.PI * u), 6);
    feet.L.ankle = feet.R.ankle = -heel * 0.12;
  } else if (index === 1) {
    // 开弓马步：宽站姿，左右交替踏实并把重心移向支撑腿。
    step = alternatingStep(u, 4);
    feet.L.lateral = 0.055 * open;
    feet.R.lateral = -0.055 * open;
    feet[step.movingSide].lift = step.lift * 0.032;
    feet[step.movingSide].z = step.excursion * 0.035 * FORWARD_Z;
    feet[step.movingSide].contact = step.contact;
  } else if (index === 2) {
    // 单举配侧点步：举左手时出左脚，举右手时出右脚。
    step = alternatingStep(u, 2);
    const sign = step.movingSide === 'L' ? 1 : -1;
    feet[step.movingSide].lateral = sign * step.excursion * 0.075;
    feet[step.movingSide].lift = step.lift * 0.05;
    feet[step.movingSide].contact = step.contact;
  } else if (index === 3) {
    // 往后瞧配虚步转脚，脚尖随头腰转向，随后回正。
    step = alternatingStep(u, 2);
    const sign = step.movingSide === 'L' ? 1 : -1;
    feet[step.movingSide].lift = step.lift * 0.025;
    feet[step.movingSide].yaw = sign * step.excursion * 0.34;
    feet[step.movingSide].z = -step.excursion * 0.035 * FORWARD_Z;
    feet[step.movingSide].contact = step.contact;
  } else if (index === 4) {
    // 摇头摆尾采用宽马步小垫步，配合腰胯画圆。
    step = alternatingStep(u, 4);
    feet.L.lateral = 0.06 * open;
    feet.R.lateral = -0.06 * open;
    feet[step.movingSide].lift = step.lift * 0.028;
    feet[step.movingSide].z = step.excursion * 0.045 * FORWARD_Z;
    feet[step.movingSide].contact = step.contact;
  } else if (index === 5) {
    // 攀足改为交替小弓步，前脚落稳后再俯身。
    step = alternatingStep(u, 2);
    feet[step.movingSide].lift = step.lift * 0.045;
    feet[step.movingSide].z = step.excursion * 0.11 * FORWARD_Z;
    feet[step.movingSide].contact = step.contact;
  } else if (index === 6) {
    // 攒拳配四次进退垫步，拳与同侧落脚同步。
    step = alternatingStep(u, 4);
    const sign = step.movingSide === 'L' ? 1 : -1;
    feet.L.lateral = 0.045 * open;
    feet.R.lateral = -0.045 * open;
    feet[step.movingSide].lift = step.lift * 0.035;
    feet[step.movingSide].z = step.excursion * 0.065 * FORWARD_Z;
    feet[step.movingSide].yaw = sign * step.excursion * 0.12;
    feet[step.movingSide].contact = step.contact;
  } else {
    // 七颠：脚尖保持接触，脚跟七次有节奏地抬落。
    const heel = Math.pow(Math.sin(u * Math.PI * 7), 2);
    feet.L.ankle = feet.R.ankle = -heel * 0.22;
    // 根节点上升来自踝关节提踵，不再用腿部伸长抵消踝角。
    footY = -DIM.standHipHeight;
  }

  for (const side of ['L', 'R']) {
    const foot = feet[side];
    footIK(p, side, foot.z, footY + foot.lift, foot.ankle,
      foot.contact, foot.lateral, foot.yaw);
  }

  const grounded = Object.entries(p.feet).filter(([, foot]) => foot.contact !== false);
  const center = grounded.reduce((sum, [, foot]) => ({
    x: sum.x + foot.x / grounded.length,
    z: sum.z + foot.z / grounded.length,
  }), { x: 0, z: 0 });
  if (step) {
    const stance = p.feet[step.stanceSide];
    p.balanceTarget = {
      x: lerp(center.x, stance.x, step.preload),
      z: lerp(center.z, stance.z, step.preload),
    };
  } else if (index === 0) {
    // 从本式开始即把重心缓慢预载到右腿，确保左脚开合前捕获点已进入支撑足。
    p.balanceTarget = { x: p.feet.R.x, z: p.feet.R.z };
  } else {
    p.balanceTarget = center;
  }
}

function mixPose(a, b, t) {
  const p = emptyPose();
  for (const key of ['rootHeight', 'forwardSpeed', 'rootRoll', 'rootPitch'])
    p[key] = lerp(a[key] || 0, b[key] || 0, t);
  const names = new Set([...Object.keys(a.joints), ...Object.keys(b.joints)]);
  for (const name of names) {
    const av = a.joints[name] || { x: 0, y: 0, z: 0 };
    const bv = b.joints[name] || { x: 0, y: 0, z: 0 };
    p.joints[name] = {
      x: lerp(av.x, bv.x, t), y: lerp(av.y, bv.y, t), z: lerp(av.z, bv.z, t),
    };
  }
  p.hands = {
    L: lerp(a.hands?.L ?? 0.15, b.hands?.L ?? 0.15, t),
    R: lerp(a.hands?.R ?? 0.15, b.hands?.R ?? 0.15, t),
  };
  p.emotion = t < 0.5 ? a.emotion : b.emotion;
  // 足底接触不能插值；过渡段沿用当前动作的接触几何。
  p.feet = Object.keys(a.feet).length ? { ...a.feet } : { ...b.feet };
  p.balanceTarget = a.balanceTarget || b.balanceTarget;
  return p;
}

function baduanjinForm(index, u) {
  const breath = Math.sin(u * Math.PI * 2);
  const open = Math.sin(u * Math.PI); // 起势 → 展开 → 收势
  let p = baduanjinBase();

  if (index === 0) { // 双手由腹前交叉上托
    p.joints.shoulderL = { x: -2.75 * open, y: 0, z: 0.16 + 0.18 * open };
    p.joints.shoulderR = { x: -2.75 * open, y: 0, z: -0.16 - 0.18 * open };
    p.joints.elbowL = elbowFlex(1.25 * (1 - open));
    p.joints.elbowR = elbowFlex(1.25 * (1 - open));
    p.joints.wristL = { x: 0, y: 0, z: -open * 0.5 };  // 掌心向上托举
    p.joints.wristR = { x: 0, y: 0, z: open * 0.5 };
    p.hands = { L: 0.02, R: 0.02 };
    p.joints.head.x = -0.16 * open;
  } else if (index === 1) { // 马步，左右轮换拉弓
    const side = Math.sin(u * Math.PI * 2);
    const squat = 0.1 * open;
    p = baduanjinBase(squat);
    p.joints.shoulderL = { x: -1.25, y: -0.65 * side, z: 0.65 + 0.35 * side };
    p.joints.shoulderR = { x: -1.25, y: -0.65 * side, z: -0.65 + 0.35 * side };
    p.joints.elbowL = elbowFlex(0.45 + 1.05 * Math.max(0, -side));
    p.joints.elbowR = elbowFlex(0.45 + 1.05 * Math.max(0, side));
    // 拉弦手握拳，推弓手立掌。
    p.hands.L = Math.max(0, -side);
    p.hands.R = Math.max(0, side);
    p.joints.waist.y = side * 0.24;
    p.joints.head.y = side * 0.3;
  } else if (index === 2) { // 一手上举，一手下按，半程换边
    const side = Math.sin(u * Math.PI * 2);
    const leftUp = (side + 1) * 0.5;
    p.joints.shoulderL = { x: lerp(0.15, -2.8, leftUp), y: 0, z: 0.2 };
    p.joints.shoulderR = { x: lerp(-2.8, 0.15, leftUp), y: 0, z: -0.2 };
    p.joints.elbowL = elbowFlex(lerp(0.25, 0.05, leftUp));
    p.joints.elbowR = elbowFlex(lerp(0.05, 0.25, leftUp));
    p.hands = { L: 0.02, R: 0.02 };
    p.rootRoll = -side * 0.035;
  } else if (index === 3) { // 手臂下垂，头缓慢左右后顾
    p.joints.shoulderL = { x: 0.08, y: 0, z: 0.18 };
    p.joints.shoulderR = { x: 0.08, y: 0, z: -0.18 };
    p.joints.elbowL = p.joints.elbowR = elbowFlex(0.12);
    p.joints.head.y = breath * 0.72;
    p.joints.waist.y = breath * 0.12;
  } else if (index === 4) { // 马步俯身，腰胯与头部画圆
    const squat = 0.13 * open;
    p = baduanjinBase(squat);
    p.rootRoll = breath * 0.1;
    p.rootPitch = 0.18 + open * 0.18;
    p.joints.waist = { x: 0.2, y: Math.cos(u * TAU) * 0.2, z: -breath * 0.16 };
    p.joints.head = { x: -0.12, y: -Math.cos(u * TAU) * 0.35, z: breath * 0.18 };
    p.joints.shoulderL = { x: 0.2, y: 0, z: 0.42 };
    p.joints.shoulderR = { x: 0.2, y: 0, z: -0.42 };
    p.joints.elbowL = p.joints.elbowR = elbowFlex(0.3);
  } else if (index === 5) { // 直膝前屈，双手向足部攀伸
    const fold = open;
    p.rootPitch = 0.42 * fold;
    p.joints.waist.x = 0.82 * fold;
    p.joints.head.x = -0.25 * fold;
    p.joints.shoulderL = { x: -0.55 + 1.3 * fold, y: 0, z: 0.12 };
    p.joints.shoulderR = { x: -0.55 + 1.3 * fold, y: 0, z: -0.12 };
    p.joints.elbowL = p.joints.elbowR = elbowFlex(0.1);
    p.hands = { L: 0.02, R: 0.02 };
  } else if (index === 6) { // 马步攒拳，左右交替冲拳
    const side = Math.sin(u * TAU);
    p = baduanjinBase(0.09 * open);
    p.joints.shoulderL = { x: -1.3 + side * 0.65, y: -0.3, z: 0.22 };
    p.joints.shoulderR = { x: -1.3 - side * 0.65, y: 0.3, z: -0.22 };
    p.joints.elbowL = elbowFlex(0.25 + Math.max(0, -side) * 1.35);
    p.joints.elbowR = elbowFlex(0.25 + Math.max(0, side) * 1.35);
    p.hands = { L: 1, R: 1 };  // 攒拳怒目：双手紧握
    p.joints.waist.y = side * 0.18;
    p.joints.head.y = side * 0.12;
  } else { // 脚跟随呼吸节拍七颠（以踝、根高度表达）
    const bounce = Math.pow(Math.sin(u * Math.PI * 7), 2);
    p.rootHeight += bounce * 0.055;
    p.joints.shoulderL = { x: -0.08, y: 0, z: 0.12 };
    p.joints.shoulderR = { x: -0.08, y: 0, z: -0.12 };
    p.joints.elbowL = p.joints.elbowR = elbowFlex(0.15);
  }
  applyBaduanjinFootwork(index, u, p);
  return p;
}

export class BaduanjinBehavior {
  constructor() { this.name = 'baduanjin'; this.elapsed = 0; }
  reset() { this.elapsed = 0; }
  get formIndex() { return Math.floor(this.elapsed / FORM_SECONDS) % BADUANJIN_FORMS.length; }
  get formName() { return BADUANJIN_FORMS[this.formIndex]; }
  get progress() { return (this.elapsed % FORM_SECONDS) / FORM_SECONDS; }
  update(ctx) {
    this.elapsed = (this.elapsed + ctx.dt) % (FORM_SECONDS * BADUANJIN_FORMS.length);
    const index = this.formIndex;
    const u = this.progress;
    const current = baduanjinForm(index, u);
    // 每式末 0.8 秒预混合下一式，避免姿态突变。
    if (u < 0.9) return current;
    const next = baduanjinForm((index + 1) % BADUANJIN_FORMS.length, 0);
    return mixPose(current, next, smoothstep((u - 0.9) / 0.1));
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
    p.emotion = 'power';
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
      p.flash = true;
    } else if (this.t < this.crouch + this.push + this.air) {
      const ta = this.t - this.crouch - this.push;
      h = base + 0.04 + this.launchV * ta - 0.5 * GRAVITY * ta * ta;
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
      p.joints.hipL = { x: -0.5 * FORWARD_Z, y: 0, z: 0 };
      p.joints.hipR = { x: -0.5 * FORWARD_Z, y: 0, z: 0 };
      p.joints.kneeL = { x: KNEE_SIGN * 1.0, y: 0, z: 0 };
      p.joints.kneeR = { x: KNEE_SIGN * 1.0, y: 0, z: 0 };
      p.joints.ankleL = { x: 0.3, y: 0, z: 0 };
      p.joints.ankleR = { x: 0.3, y: 0, z: 0 };
      p.feet.L = { x: DIM.hipWidth * 0.5, z: 0, contact: false };
      p.feet.R = { x: -DIM.hipWidth * 0.5, z: 0, contact: false };
    } else {
      const footY = -(base - crouchAmt - DIM.pelvisH * 0.5 - DIM.footH * 0.5);
      footIK(p, 'L', 0, footY);
      footIK(p, 'R', 0, footY);
    }

    // 手臂：蹲时后摆，跳时上甩
    const armUp = inAir ? -2.6 : -0.3 + crouchAmt * 4;
    p.joints.shoulderL = { x: armUp, y: 0, z: 0.15 };
    p.joints.shoulderR = { x: armUp, y: 0, z: -0.15 };
    p.joints.elbowL = elbowFlex(0.3);
    p.joints.elbowR = elbowFlex(0.3);
    p.hands.L = p.hands.R = 0.5;
    p.joints.waist = { x: inAir ? -0.15 : crouchAmt * 1.5, y: 0, z: 0 };
    return p;
  }
}

// ============================================================
// BACKFLIP：后空翻——蹲伏蓄力 → 爆发起跳 → 空中团身后旋 360°
//   → 展体落地缓冲 → 起身。宇树机器人的招牌动作。
// ============================================================
export class BackflipBehavior {
  constructor(onDone) {
    this.name = 'backflip';
    this.t = 0;
    this.onDone = onDone;
    this.crouch = 0.38;
    this.push = 0.12;
    this.air = 0.62;
    this.land = 0.28;
    this.recover = 0.34;
    this.total = this.crouch + this.push + this.air + this.land + this.recover;
    // 弹道：起跳速度使腾空时间正好等于 air
    this.launchV = GRAVITY * this.air / 2;
  }

  update(ctx) {
    this.t += ctx.dt;
    const p = emptyPose();
    p.emotion = 'power';
    p.pitchTau = 0.02;     // 空翻的姿态响应必须极快
    p.heightTau = 0.012;
    const base = baseRootHeight();
    const tAir0 = this.crouch + this.push;
    const tLand0 = tAir0 + this.air;
    const tRec0 = tLand0 + this.land;

    let h = base;
    let pitch = 0;
    let crouchAmt = 0;
    let inAir = false;

    if (this.t < this.crouch) {
      // 深蹲蓄力，手臂后摆
      const u = smoothstep(this.t / this.crouch);
      crouchAmt = u * 0.21;
      h = base - crouchAmt;
      p.joints.shoulderL = { x: 0.9 * u, y: 0, z: 0.2 };
      p.joints.shoulderR = { x: 0.9 * u, y: 0, z: -0.2 };
      p.joints.elbowL = p.joints.elbowR = elbowFlex(0.25);
      p.joints.waist = { x: 0.35 * u, y: 0, z: 0 };
    } else if (this.t < tAir0) {
      // 爆发蹬伸：手臂猛甩向上带动角动量
      const u = smoothstep((this.t - this.crouch) / this.push);
      crouchAmt = (1 - u) * 0.21;
      h = base - crouchAmt + u * 0.05;
      pitch = -0.35 * u;   // 起跳瞬间已开始后旋
      p.flash = true;
      p.joints.shoulderL = { x: lerp(0.9, -3.0, u), y: 0, z: 0.2 };
      p.joints.shoulderR = { x: lerp(0.9, -3.0, u), y: 0, z: -0.2 };
      p.joints.elbowL = p.joints.elbowR = elbowFlex(0.2);
      p.joints.waist = { x: lerp(0.35, -0.2, u), y: 0, z: 0 };
    } else if (this.t < tLand0) {
      // 腾空：弹道高度 + 团身后旋一整周
      inAir = true;
      const ta = this.t - tAir0;
      const u = ta / this.air;
      h = base + 0.05 + this.launchV * ta - 0.5 * GRAVITY * ta * ta;
      // 旋转节奏：起翻慢 → 团身加速 → 展体减速
      const spin = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
      pitch = -0.35 - (TAU - 0.35) * spin;
      // 团身程度：中段最紧
      const tuck = Math.sin(Math.PI * clamp((u - 0.08) / 0.84, 0, 1));
      p.joints.hipL = p.joints.hipR = { x: -2.0 * tuck * FORWARD_Z, y: 0, z: 0 };
      p.joints.kneeL = p.joints.kneeR = { x: KNEE_SIGN * 2.35 * tuck, y: 0, z: 0 };
      p.joints.ankleL = p.joints.ankleR = { x: 0.5 * tuck, y: 0, z: 0 };
      // 手臂抱膝
      p.joints.shoulderL = { x: lerp(-3.0, -1.1, tuck), y: 0, z: 0.18 };
      p.joints.shoulderR = { x: lerp(-3.0, -1.1, tuck), y: 0, z: -0.18 };
      p.joints.elbowL = p.joints.elbowR = elbowFlex(0.4 + 1.5 * tuck);
      p.hands.L = p.hands.R = 0.9;
      p.joints.waist = { x: -0.25 * tuck, y: 0, z: 0 };
      p.feet.L = { x: DIM.hipWidth * 0.5, z: 0, contact: false };
      p.feet.R = { x: -DIM.hipWidth * 0.5, z: 0, contact: false };
    } else if (this.t < tRec0) {
      // 落地：深蹲吸收冲击，手臂前伸稳定
      const u = (this.t - tLand0) / this.land;
      crouchAmt = Math.sin(Math.PI * clamp(u * 0.85, 0, 1)) * 0.19;
      h = base - crouchAmt;
      pitch = -TAU;        // 已完成整周（≡ 0°）
      p.joints.shoulderL = { x: -1.15, y: 0, z: 0.25 };
      p.joints.shoulderR = { x: -1.15, y: 0, z: -0.25 };
      p.joints.elbowL = p.joints.elbowR = elbowFlex(0.35);
      p.joints.waist = { x: 0.3 * (1 - u * 0.5), y: 0, z: 0 };
    } else if (this.t < this.total) {
      // 起身回正
      const u = smoothstep((this.t - tRec0) / this.recover);
      crouchAmt = (1 - u) * 0.1;
      h = base - crouchAmt;
      pitch = -TAU;
      p.joints.shoulderL = { x: -1.15 * (1 - u), y: 0, z: 0.15 };
      p.joints.shoulderR = { x: -1.15 * (1 - u), y: 0, z: -0.15 };
      p.joints.elbowL = p.joints.elbowR = elbowFlex(0.25);
      p.joints.waist = { x: 0.15 * (1 - u), y: 0, z: 0 };
    } else {
      if (this.onDone) this.onDone();
      pitch = -TAU;
    }

    if (!inAir) {
      const footY = -(base - crouchAmt - DIM.pelvisH * 0.5 - DIM.footH * 0.5);
      footIK(p, 'L', 0, footY);
      footIK(p, 'R', 0, footY);
    }

    p.rootHeight = Math.max(h, DIM.footH);
    p.rootPitch = pitch;
    return p;
  }
}

// ============================================================
// 动作序列器：把一串带时长的关键姿态段拼成一次性表演。
// ============================================================
class SequenceBehavior {
  constructor(name, segments, onDone) {
    this.name = name;
    this.segments = segments;
    this.onDone = onDone;
    this.t = 0;
    this.total = segments.reduce((sum, seg) => sum + seg.dur, 0);
  }

  update(ctx) {
    this.t += ctx.dt;
    if (this.t >= this.total) {
      if (this.onDone) this.onDone();
      return this.segments.at(-1).build(ctx, 1);
    }
    let local = this.t;
    for (const seg of this.segments) {
      if (local < seg.dur) return seg.build(ctx, local / seg.dur);
      local -= seg.dur;
    }
    return this.segments.at(-1).build(ctx, 1);
  }
}

// ============================================================
// KUNGFU：抱拳礼 → 马步蓄势 → 左右冲拳 → 弓步双推掌
//   → 侧踢 → 收势。一次性连招，眼睛转为赤红。
// ============================================================

// 功夫基础站姿：给定下蹲深度与双脚布局。
function kungfuStance({ squat = 0, spread = 0, zL = 0, zR = 0, liftR = 0, latR = 0 } = {}) {
  const p = emptyPose();
  p.emotion = 'fury';
  p.hands = { L: 1, R: 1 };
  p.rootHeight = baseRootHeight() - squat;
  const footY = -(DIM.standHipHeight - squat);
  footIK(p, 'L', zL * FORWARD_Z, footY, 0, true, spread);
  footIK(p, 'R', zR * FORWARD_Z, footY + liftR, 0, liftR < 0.01, -spread + latR);
  p.joints.head = { x: 0, y: 0, z: 0 };
  p.joints.waist = { x: 0, y: 0, z: 0 };
  return p;
}

// 冲拳曲线：快出 → 顶峰停顿 → 收回。
function punchCurve(u) {
  if (u < 0.22) return 0;
  if (u < 0.42) return smoothstep((u - 0.22) / 0.2);   // 出拳（0.16s 内打满）
  if (u < 0.68) return 1;                                // 定格
  return 1 - smoothstep((u - 0.68) / 0.32);              // 收拳
}

function chamberArm(p, side) {
  // 拳收腰间的预备位。
  const s = side === 'L' ? 1 : -1;
  p.joints['shoulder' + side] = { x: 0.28, y: 0, z: s * 0.16 };
  p.joints['elbow' + side] = elbowFlex(1.35);
  p.joints['wrist' + side] = { x: 0, y: 0, z: 0 };
}

function makeKungfuSegments() {
  return [
    // 1. 抱拳礼：右拳左掌相合于胸前，微微欠身。
    {
      dur: 1.7,
      build(ctx, u) {
        const p = kungfuStance();
        const rise = smoothstep(clamp(u / 0.4, 0, 1));
        const bow = windowPulse(u, 0.35, 0.9);
        p.joints.shoulderR = { x: -1.25 * rise, y: -0.45 * rise, z: -0.12 };
        p.joints.elbowR = elbowFlex(1.75 * rise);
        p.joints.shoulderL = { x: -1.2 * rise, y: 0.5 * rise, z: 0.12 };
        p.joints.elbowL = elbowFlex(1.65 * rise);
        p.joints.wristL = { x: 0, y: 0, z: -0.7 * rise };  // 掌心贴向拳面
        p.hands = { L: 0.05, R: 1 };
        p.joints.waist = { x: 0.14 * bow, y: 0, z: 0 };
        p.joints.head = { x: 0.18 * bow, y: 0, z: 0 };
        p.rootHeight = baseRootHeight() - 0.015 * bow;
        return p;
      },
    },
    // 2. 撤步沉马：下沉成马步，双拳收于腰间。
    {
      dur: 1.2,
      build(ctx, u) {
        const sink = smoothstep(u);
        const p = kungfuStance({ squat: 0.13 * sink, spread: 0.075 * sink });
        chamberArm(p, 'L');
        chamberArm(p, 'R');
        p.joints.head = { x: -0.05 * sink, y: 0, z: 0 };
        return p;
      },
    },
    // 3. 左冲拳（腰马合一，拧腰送肩）
    {
      dur: 0.9,
      build(ctx, u) {
        const punch = punchCurve(u);
        const p = kungfuStance({ squat: 0.13, spread: 0.075 });
        chamberArm(p, 'R');
        p.joints.shoulderL = { x: lerp(0.28, -1.5, punch), y: 0.15 * punch, z: 0.12 };
        p.joints.elbowL = elbowFlex(lerp(1.35, 0.08, punch));
        p.joints.wristL = { x: 0, y: 0, z: -punch * 0.4 };
        p.joints.waist = { x: 0.03, y: -0.34 * punch, z: 0 };
        p.joints.head = { x: 0, y: -0.1 * punch, z: 0 };
        p.rootPitch = 0.03 * punch;
        p.flash = punch > 0.96;
        return p;
      },
    },
    // 4. 右冲拳
    {
      dur: 0.9,
      build(ctx, u) {
        const punch = punchCurve(u);
        const p = kungfuStance({ squat: 0.13, spread: 0.075 });
        chamberArm(p, 'L');
        p.joints.shoulderR = { x: lerp(0.28, -1.5, punch), y: -0.15 * punch, z: -0.12 };
        p.joints.elbowR = elbowFlex(lerp(1.35, 0.08, punch));
        p.joints.wristR = { x: 0, y: 0, z: punch * 0.4 };
        p.joints.waist = { x: 0.03, y: 0.34 * punch, z: 0 };
        p.joints.head = { x: 0, y: 0.1 * punch, z: 0 };
        p.rootPitch = 0.03 * punch;
        p.flash = punch > 0.96;
        return p;
      },
    },
    // 5. 弓步双推掌：左脚踏前成弓步，双掌齐出。
    {
      dur: 1.5,
      build(ctx, u) {
        const step = smoothstep(clamp(u / 0.35, 0, 1));
        const push = punchCurve(clamp((u - 0.2) / 0.8, 0, 1));
        const p = kungfuStance({
          squat: 0.11, zL: 0.14 * step, zR: -0.1 * step,
        });
        for (const side of ['L', 'R']) {
          const s = side === 'L' ? 1 : -1;
          p.joints['shoulder' + side] = {
            x: lerp(0.28, -1.45, push), y: 0, z: s * 0.14,
          };
          p.joints['elbow' + side] = elbowFlex(lerp(1.35, 0.12, push));
          p.joints['wrist' + side] = { x: -0.9 * push, y: 0, z: 0 }; // 立掌
        }
        p.hands = { L: 0.03, R: 0.03 };
        p.joints.waist = { x: 0.08 * push, y: 0, z: 0 };
        p.rootPitch = 0.05 * push;
        p.balanceTarget = { x: 0, z: 0.05 * step };
        p.flash = push > 0.96;
        return p;
      },
    },
    // 6. 右侧踢：重心移至左腿，右腿提膝侧展踢出。
    {
      dur: 1.9,
      build(ctx, u) {
        // 分段：0-0.3 提膝蓄力，0.3-0.5 踢出，0.5-0.68 定格，0.68-1 收腿落地。
        const chamber = smoothstep(clamp(u / 0.3, 0, 1));
        const kick = u < 0.5 ? smoothstep(clamp((u - 0.3) / 0.2, 0, 1))
          : u < 0.68 ? 1 : 1 - smoothstep(clamp((u - 0.68) / 0.32, 0, 1));
        const settle = smoothstep(clamp((u - 0.82) / 0.18, 0, 1));
        const lift = Math.max(chamber * (1 - settle) * 0.3, kick * 0.42);
        const lat = -kick * 0.34;
        const p = kungfuStance({
          squat: 0.06, liftR: lift, latR: lat,
        });
        // 支撑侧身体反倾，保持重心在左脚上方。
        p.rootRoll = (chamber * (1 - settle)) * 0.14 + kick * 0.1;
        p.balanceTarget = { x: DIM.hipWidth * 0.5, z: 0 };
        // 双臂展开成戒备式
        const guard = chamber * (1 - settle);
        p.joints.shoulderL = { x: -0.5 * guard, y: 0, z: 0.85 * guard + 0.12 };
        p.joints.shoulderR = { x: -0.9 * guard, y: 0, z: -(0.5 + 0.5 * kick) * guard - 0.12 };
        p.joints.elbowL = elbowFlex(0.5);
        p.joints.elbowR = elbowFlex(0.4 * (1 - kick) + 0.15);
        p.joints.head = { y: -0.4 * kick, x: 0, z: 0 };
        p.joints.waist = { x: 0, y: -0.2 * kick, z: -0.1 * kick };
        p.flash = kick > 0.96 && u < 0.6;
        return p;
      },
    },
    // 7. 收势：并步直立，抱拳再垂手。
    {
      dur: 1.6,
      build(ctx, u) {
        const gather = smoothstep(clamp(u / 0.45, 0, 1));
        const release = smoothstep(clamp((u - 0.55) / 0.45, 0, 1));
        const hold = gather * (1 - release);
        const p = kungfuStance();
        p.joints.shoulderR = { x: -1.25 * hold - 0.08 * release, y: -0.45 * hold, z: -0.12 };
        p.joints.elbowR = elbowFlex(1.75 * hold + 0.22 * release);
        p.joints.shoulderL = { x: -1.2 * hold - 0.08 * release, y: 0.5 * hold, z: 0.12 };
        p.joints.elbowL = elbowFlex(1.65 * hold + 0.22 * release);
        p.joints.wristL = { x: 0, y: 0, z: -0.7 * hold };
        p.hands = { L: lerp(0.05, 0.15, release), R: lerp(1, 0.15, release) };
        p.joints.head = { x: 0.12 * hold, y: 0, z: 0 };
        p.emotion = release > 0.5 ? 'calm' : 'fury';
        return p;
      },
    },
  ];
}

export class KungfuBehavior extends SequenceBehavior {
  constructor(onDone) {
    super('kungfu', makeKungfuSegments(), onDone);
  }
}
