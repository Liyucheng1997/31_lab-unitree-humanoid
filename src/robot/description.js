// 机器人描述层（对齐 roboto_origin 的 rpo_description 模块）。
// 单一事实来源：每个"单轴关节"一条记录，命名与 Roboparty rpo.urdf 对齐，
// 带轴向、位置限位、执行器规格（力矩/速度）与伺服增益，供以下模块共用：
//   - Actuators.js  伺服仿真（roboparty_firmware 的角色）
//   - urdfExport.js 导出真实 URDF（可进 MuJoCo / Isaac Lab）
//   - rl/           强化学习训练与部署（roboparty_train 的角色）
//
// 几何约定沿用 skeleton.js：+Z 视觉正面，正 rotation.x 使下垂肢体向 -Z（身后）摆。
// rpo 原始限位是它自己的轴系，这里按同等活动度换算到我们的轴系，并为
// 现有编舞（功夫/八段锦/空翻）留出安全余量——位置限位随几何走，
// 力矩/速度限制才是"落地真实性"的核心，直接采用 rpo 的电机档位。

import { DIM } from './skeleton.js?v=20261002-eng-v1';

// ------------------------------------------------------------------
// 执行器档位库（借鉴 rpo 实机电机规格）
//   J120: 髋 / 膝 / 腰用高扭矩关节模组 —— rpo effort=120N·m, velocity=25rad/s
//   J27 : 踝 / 肩 / 肘用中扭矩模组   —— rpo effort=27N·m（速度上调至 12rad/s，
//         我们的臂显著更轻，8rad/s 是 rpo 整臂负载下的标定值）
//   J9  : 腕 / 头等末端小模组
// ------------------------------------------------------------------
export const MOTORS = {
  J120: { effort: 120, velocity: 25 },
  J27:  { effort: 27,  velocity: 12 },
  J9:   { effort: 9,   velocity: 10 },
};

// 伺服响应档位：omega 为期望闭环自然频率(rad/s)，zeta 为阻尼比。
// kp = I·omega²，kd = 2·zeta·I·omega（I 为该关节的反射惯量估计）。
const RESP = {
  leg:   { omega: 24, zeta: 0.95 },
  ankle: { omega: 30, zeta: 1.0 },
  arm:   { omega: 16, zeta: 0.9 },
  wrist: { omega: 20, zeta: 0.9 },
  torso: { omega: 14, zeta: 1.0 },
  head:  { omega: 14, zeta: 1.0 },
};

// link 质量预算（kg）：与 BalanceController.ROBOT_MASS=35 一致的分解
// （rpo 实机更小更轻，这里按同样的质量分布比例放大到我们的 1.5m 机型）。
export const LINK_MASS = {
  pelvis: 6.8, torso: 9.6, head: 1.4,
  thigh: 3.0, shin: 2.1, foot: 0.8,          // 每条腿 5.9
  upperArm: 1.3, foreArm: 0.9, hand: 0.5,    // 每条臂 2.7
};

export const TOTAL_MASS =
  LINK_MASS.pelvis + LINK_MASS.torso + LINK_MASS.head +
  2 * (LINK_MASS.thigh + LINK_MASS.shin + LINK_MASS.foot) +
  2 * (LINK_MASS.upperArm + LINK_MASS.foreArm + LINK_MASS.hand);

// ------------------------------------------------------------------
// 关节表。字段：
//   name  与 rpo.urdf 对齐的关节名（rpo:false 的为本机型扩展关节）
//   group / axis  映射到 RobotBuilder 关节 Group 的欧拉分量
//   lower/upper   位置限位（rad，我们的轴系）
//   motor         执行器档位
//   inertia       反射惯量估计（kg·m²），由 link 质量与杆长粗算
//   resp          伺服响应档位
// ------------------------------------------------------------------
function legJoints(side) {
  const s = side === 'L' ? 'left' : 'right';
  const g = side;
  const rollLim = side === 'L' ? [-0.4, 1.2] : [-1.2, 0.4]; // 外展方向更大
  return [
    { name: `${s}_thigh_pitch_joint`, rpo: true, group: `hip${g}`, axis: 'x',
      lower: -2.4, upper: 0.9, motor: 'J120', inertia: 0.8, resp: 'leg' },
    { name: `${s}_thigh_yaw_joint`, rpo: true, group: `hip${g}`, axis: 'y',
      lower: -1.1, upper: 1.1, motor: 'J120', inertia: 0.15, resp: 'leg' },
    { name: `${s}_thigh_roll_joint`, rpo: true, group: `hip${g}`, axis: 'z',
      lower: rollLim[0], upper: rollLim[1], motor: 'J120', inertia: 0.8, resp: 'leg' },
    { name: `${s}_knee_joint`, rpo: true, group: `knee${g}`, axis: 'x',
      lower: -0.25, upper: 2.6, motor: 'J120', inertia: 0.2, resp: 'leg' },
    { name: `${s}_ankle_pitch_joint`, rpo: true, group: `ankle${g}`, axis: 'x',
      lower: -1.1, upper: 0.9, motor: 'J27', inertia: 0.03, resp: 'ankle' },
    { name: `${s}_ankle_roll_joint`, rpo: true, group: `ankle${g}`, axis: 'z',
      lower: -0.6, upper: 0.6, motor: 'J27', inertia: 0.03, resp: 'ankle' },
  ];
}

function armJoints(side) {
  const s = side === 'L' ? 'left' : 'right';
  const g = side;
  const rollLim = side === 'L' ? [-0.5, 3.3] : [-3.3, 0.5]; // 抬臂外展方向更大
  return [
    { name: `${s}_arm_pitch_joint`, rpo: true, group: `shoulder${g}`, axis: 'x',
      lower: -3.3, upper: 3.3, motor: 'J27', inertia: 0.2, resp: 'arm' },
    { name: `${s}_arm_roll_joint`, rpo: true, group: `shoulder${g}`, axis: 'z',
      lower: rollLim[0], upper: rollLim[1], motor: 'J27', inertia: 0.2, resp: 'arm' },
    { name: `${s}_arm_yaw_joint`, rpo: true, group: `shoulder${g}`, axis: 'y',
      lower: -2.0, upper: 2.0, motor: 'J27', inertia: 0.04, resp: 'arm' },
    { name: `${s}_elbow_pitch_joint`, rpo: true, group: `elbow${g}`, axis: 'x',
      lower: -2.6, upper: 0.5, motor: 'J27', inertia: 0.05, resp: 'arm' },
    // rpo 的第 5 个臂关节（前臂旋转）对应我们腕 Group 的 yaw 分量。
    { name: `${s}_elbow_yaw_joint`, rpo: true, group: `wrist${g}`, axis: 'y',
      lower: -2.0, upper: 2.0, motor: 'J9', inertia: 0.012, resp: 'wrist' },
    { name: `${s}_wrist_pitch_joint`, rpo: false, group: `wrist${g}`, axis: 'x',
      lower: -1.6, upper: 1.6, motor: 'J9', inertia: 0.01, resp: 'wrist' },
    { name: `${s}_wrist_roll_joint`, rpo: false, group: `wrist${g}`, axis: 'z',
      lower: -1.6, upper: 1.6, motor: 'J9', inertia: 0.01, resp: 'wrist' },
  ];
}

export const JOINTS = [
  ...legJoints('L'), ...legJoints('R'),
  // rpo 的 torso_joint 是纯 yaw；pitch/roll 为本机型扩展（宇树 G1 同款三自由度腰）。
  { name: 'torso_joint', rpo: true, group: 'waist', axis: 'y',
    lower: -3.14, upper: 3.14, motor: 'J120', inertia: 0.27, resp: 'torso' },
  { name: 'torso_pitch_joint', rpo: false, group: 'waist', axis: 'x',
    lower: -1.35, upper: 1.35, motor: 'J120', inertia: 0.5, resp: 'torso' },
  { name: 'torso_roll_joint', rpo: false, group: 'waist', axis: 'z',
    lower: -0.8, upper: 0.8, motor: 'J120', inertia: 0.5, resp: 'torso' },
  ...armJoints('L'), ...armJoints('R'),
  { name: 'head_pitch_joint', rpo: false, group: 'head', axis: 'x',
    lower: -0.7, upper: 0.6, motor: 'J9', inertia: 0.03, resp: 'head' },
  { name: 'head_yaw_joint', rpo: false, group: 'head', axis: 'y',
    lower: -1.35, upper: 1.35, motor: 'J9', inertia: 0.03, resp: 'head' },
];

// 与 rpo.urdf 对齐的关节数（rpo 实机共 23 个 revolute 关节）。
export const RPO_JOINT_COUNT = JOINTS.filter((j) => j.rpo).length;

/** 展开成 Actuators 可直接使用的完整规格（含解析出的 kp/kd 与执行器参数）。 */
export function jointSpecs() {
  return JOINTS.map((j) => {
    const motor = MOTORS[j.motor];
    const resp = RESP[j.resp];
    return {
      ...j,
      effort: motor.effort,
      velocity: motor.velocity,
      kp: j.inertia * resp.omega * resp.omega,
      kd: 2 * resp.zeta * j.inertia * resp.omega,
    };
  });
}

// URDF 导出用的连杆几何（相对各关节系的尺寸盒），单位米。
export const URDF_GEOM = {
  hipOffset: { x: DIM.hipWidth * 0.5, y: -DIM.pelvisH * 0.4, z: 0 },
  thighLen: DIM.thigh,
  shinLen: DIM.shin,
  foot: { len: DIM.footLen, width: DIM.footWidth, height: DIM.footH },
  waistY: DIM.pelvisH * 0.5,
  shoulderOffset: { x: DIM.shoulderWidth, y: DIM.torsoH * 0.88, z: 0 },
  upperArmLen: DIM.upperArm,
  foreArmLen: DIM.foreArm,
  neckY: DIM.torsoH + DIM.neckH * 0.5,
  torso: { w: DIM.torsoW, h: DIM.torsoH, d: DIM.torsoD },
  pelvis: { w: DIM.pelvisW, h: DIM.pelvisH, d: 0.15 },
  head: { w: DIM.headW, h: DIM.headH },
};
