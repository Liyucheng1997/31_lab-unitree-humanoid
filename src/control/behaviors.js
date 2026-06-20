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

import { DIM, FORWARD_Z, baseRootHeight } from '../robot/skeleton.js?v=20260620-baduanjin-steps-v2';
import { solveLegIK, clamp, lerp, smoothstep, TAU } from './MathUtils.js?v=20260620-baduanjin-steps-v2';
import { GRAVITY } from './BalanceController.js?v=20260620-baduanjin-steps-v2';

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
  };
}

// 正值表示符合人体结构的“向前屈肘”，转换为 Three.js 绕 X 轴的负角度。
const elbowFlex = (x, y = 0, z = 0) => ({ x: -x, y, z });

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
    p.joints.shoulderL = { x: -0.08 + a, y: 0, z: 0.12 };
    p.joints.shoulderR = { x: -0.08 - a, y: 0, z: -0.12 };
    p.joints.elbowL = elbowFlex(0.22);
    p.joints.elbowR = elbowFlex(0.22);
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
    const duty = 0.90;                  // 支撑相占比；延长双支撑，为重心换脚留出时间
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
      // 足端前向偏移与机器人视觉正面保持一致
      const contact = legPhase(side) < duty;
      footIK(p, side, f * FORWARD_Z, baseY + lift, lift * 0.6, contact);
    }

    // Anticipatory COM target: shift toward the stance leg before single support.
    // The balance loop further clamps this target to the measured support polygon.
    p.balanceTarget = {
      // 在双支撑开始时即预载下一条支撑腿，而不是等抬脚后才纠偏。
      x: (this.phase < 0.5 ? 1 : -1) * DIM.hipWidth * 0.275,
      z: 0,
    };

    // 前进速度：一个周期身体前进约 2S（支撑相走完整个行程）
    p.forwardSpeed = 2 * S * cadence;

    // 手臂反相摆动（与同侧腿相反）
    const swingL = Math.sin(this.phase * TAU);
    const swingR = Math.sin((this.phase + 0.5) * TAU);
    p.joints.shoulderL = { x: -swingR * 0.5, y: 0, z: 0.1 };
    p.joints.shoulderR = { x: -swingL * 0.5, y: 0, z: -0.1 };
    p.joints.elbowL = elbowFlex(0.5 + swingR * 0.15);
    p.joints.elbowR = elbowFlex(0.5 + swingL * 0.15);

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
    p.joints.elbowR = elbowFlex(0.4 + wave, wave * 0.5);
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
      p.joints.elbowL = elbowFlex(0.3);
      p.joints.elbowR = elbowFlex(0.3);
    } else if (seg === 1) {
      // 抱胸 / 推手
      p.joints.shoulderL = { x: -1.3, y: 0.4 + a * 0.4, z: 0.4 };
      p.joints.shoulderR = { x: -1.3, y: -0.4 - a * 0.4, z: -0.4 };
      p.joints.elbowL = elbowFlex(1.6);
      p.joints.elbowR = elbowFlex(1.6);
    } else if (seg === 2) {
      // 风车臂
      p.joints.shoulderL = { x: -1.5 + a * 1.6, y: 0, z: 0.2 };
      p.joints.shoulderR = { x: -1.5 - a * 1.6, y: 0, z: -0.2 };
      p.joints.elbowL = elbowFlex(0.4);
      p.joints.elbowR = elbowFlex(0.4);
    } else {
      // 摆手 + 扭胯
      p.joints.shoulderL = { x: -0.6 + b * 0.5, y: 0, z: 0.8 };
      p.joints.shoulderR = { x: -0.6 - b * 0.5, y: 0, z: -0.8 };
      p.joints.elbowL = elbowFlex(0.9);
      p.joints.elbowR = elbowFlex(0.9);
    }

    p.joints.waist = { x: 0, y: sway * 1.2, z: -sway * 0.6 };
    p.joints.head = { x: 0.1 * b, y: sway, z: -sway };
    return p;
  }
}

// ============================================================
// 八段锦：八式传统功法，每式 8 秒，完整一轮约 64 秒。
// 机器人没有腕/掌关节，因此以肩、肘、腰、头和重心变化表达动作语义。
// ============================================================
export const BADUANJIN_FORMS = [
  '双手托天理三焦', '左右开弓似射雕', '调理脾胃须单举', '五劳七伤往后瞧',
  '摇头摆尾去心火', '两手攀足固肾腰', '攒拳怒目增气力', '背后七颠百病消',
];

const FORM_SECONDS = 8;

function baduanjinBase(squat = 0) {
  const p = emptyPose();
  p.rootHeight = baseRootHeight() - squat;
  const footY = -(DIM.standHipHeight - squat);
  footIK(p, 'L', 0, footY);
  footIK(p, 'R', 0, footY);
  p.joints.head = { x: 0, y: 0, z: 0 };
  p.joints.waist = { x: 0, y: 0, z: 0 };
  return p;
}

function windowPulse(u, start, end) {
  if (u <= start || u >= end) return 0;
  return Math.sin(Math.PI * (u - start) / (end - start));
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
    p.joints.head.x = -0.16 * open;
  } else if (index === 1) { // 马步，左右轮换拉弓
    const side = Math.sin(u * Math.PI * 2);
    const squat = 0.1 * open;
    p = baduanjinBase(squat);
    p.joints.shoulderL = { x: -1.25, y: -0.65 * side, z: 0.65 + 0.35 * side };
    p.joints.shoulderR = { x: -1.25, y: -0.65 * side, z: -0.65 + 0.35 * side };
    p.joints.elbowL = elbowFlex(0.45 + 1.05 * Math.max(0, -side));
    p.joints.elbowR = elbowFlex(0.45 + 1.05 * Math.max(0, side));
    p.joints.waist.y = side * 0.24;
    p.joints.head.y = side * 0.3;
  } else if (index === 2) { // 一手上举，一手下按，半程换边
    const side = Math.sin(u * Math.PI * 2);
    const leftUp = (side + 1) * 0.5;
    p.joints.shoulderL = { x: lerp(0.15, -2.8, leftUp), y: 0, z: 0.2 };
    p.joints.shoulderR = { x: lerp(-2.8, 0.15, leftUp), y: 0, z: -0.2 };
    p.joints.elbowL = elbowFlex(lerp(0.25, 0.05, leftUp));
    p.joints.elbowR = elbowFlex(lerp(0.05, 0.25, leftUp));
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
  } else if (index === 6) { // 马步攒拳，左右交替冲拳
    const side = Math.sin(u * TAU);
    p = baduanjinBase(0.09 * open);
    p.joints.shoulderL = { x: -1.3 + side * 0.65, y: -0.3, z: 0.22 };
    p.joints.shoulderR = { x: -1.3 - side * 0.65, y: 0.3, z: -0.22 };
    p.joints.elbowL = elbowFlex(0.25 + Math.max(0, -side) * 1.35);
    p.joints.elbowR = elbowFlex(0.25 + Math.max(0, side) * 1.35);
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
      const tuck = 0.5;
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
    p.joints.waist = { x: inAir ? -0.15 : crouchAmt * 1.5, y: 0, z: 0 };
    return p;
  }
}
