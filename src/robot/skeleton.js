// 机器人尺寸与骨骼参数（单位：米）。仿宇树 G1 比例，整体约 1.3m 高。
export const DIM = {
  // 腿
  thigh: 0.34,        // L1 大腿
  shin: 0.32,         // L2 小腿
  footLen: 0.18,
  footH: 0.05,
  hipWidth: 0.20,     // 两髋间距（左右各一半）
  standHipHeight: 0.58, // 站立时髋枢轴到脚的高度（< thigh+shin，膝微屈）

  // 躯干
  pelvisH: 0.14,
  pelvisW: 0.26,
  torsoH: 0.30,
  torsoW: 0.30,
  torsoD: 0.18,

  // 头
  neckH: 0.06,
  headH: 0.18,
  headW: 0.17,

  // 臂
  shoulderWidth: 0.21, // 肩枢轴相对中线的横向距离
  upperArm: 0.26,
  foreArm: 0.24,
};

// 计算地面以上的根（pelvis）默认高度
export const GROUND_Y = 0;
// 机器人视觉正面：面罩、胸甲、脚尖、膝盖和前进方向必须统一。
export const FORWARD_Z = 1;
export const baseRootHeight = () =>
  DIM.standHipHeight + DIM.pelvisH * 0.5 + DIM.footH * 0.5;
