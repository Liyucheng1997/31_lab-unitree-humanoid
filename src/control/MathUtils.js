// 数学工具：插值、平滑（类临界阻尼）、两骨解析 IK
// 约定：世界前进方向 = -Z（机器人面向 -Z）。正的关节 rotation.x 使肢体向 -Z（前方）摆动。

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const TAU = Math.PI * 2;

// 平滑步进：朝 target 逼近，tau 为时间常数（越小越快）。与帧率无关。
export function damp(current, target, tau, dt) {
  if (tau <= 1e-5) return target;
  return lerp(current, target, 1 - Math.exp(-dt / tau));
}

// 对一个 {x,y,z} 角度对象做分量平滑
export function dampEuler(cur, tgt, tau, dt) {
  cur.x = damp(cur.x, tgt.x, tau, dt);
  cur.y = damp(cur.y, tgt.y, tau, dt);
  cur.z = damp(cur.z, tgt.z, tau, dt);
}

// 平滑的 0→1 缓动
export const smoothstep = (t) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * 两骨解析 IK（矢状面，绕 X 轴）。
 * 给定脚相对髋枢轴的目标位置 (z, y)，求髋俯仰角 hip 与膝角 knee。
 *
 * 几何推导（forward = -Z, 向下 = -Y）：
 *   膝位置 = R(hip)·(0,-L1,0)
 *   脚位置 = 上 + R(hip+knee)·(0,-L2,0)
 *   => d² = L1² + L2² + 2·L1·L2·cos(knee)
 *   令 k1 = L1 + L2·cos(knee), k2 = L2·sin(knee)
 *   => hip = atan2(-z,-y) - atan2(k2,k1)
 *
 * @param {number} z      目标相对髋的 Z（前为负）
 * @param {number} y      目标相对髋的 Y（下为负）
 * @param {number} L1     大腿长
 * @param {number} L2     小腿长
 * @param {number} kneeSign 膝弯曲方向（+1 / -1）
 */
export function solveLegIK(z, y, L1, L2, kneeSign = 1) {
  const maxReach = (L1 + L2) * 0.999;
  let d = Math.hypot(z, y);
  d = clamp(d, Math.abs(L1 - L2) + 1e-4, maxReach);

  // 余弦定理求膝角
  let cosKnee = (d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2);
  cosKnee = clamp(cosKnee, -1, 1);
  const knee = kneeSign * Math.acos(cosKnee);

  const k1 = L1 + L2 * Math.cos(knee);
  const k2 = L2 * Math.sin(knee);
  const hip = Math.atan2(-z, -y) - Math.atan2(k2, k1);

  return { hip, knee };
}
