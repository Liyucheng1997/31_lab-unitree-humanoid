import { clamp } from './MathUtils.js?v=20260708-showtime-v3';

// SI units. The controller uses a linear inverted-pendulum model (LIPM):
//   comAcceleration = gravity / comHeight * (com - zmp)
// The ZMP command is constrained to the current foot support polygon.
export const GRAVITY = 9.81;
export const ROBOT_MASS = 35;

const DEFAULTS = {
  gravity: GRAVITY,
  mass: ROBOT_MASS,
  comHeight: 0.78,
  footWidth: 0.105,
  footLength: 0.18,
  edgeMargin: 0.012,
  kp: 20,
  kd: 6,
};

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

const cross = (a, b, c) =>
  (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);

function convexHull(points) {
  if (points.length <= 2) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Build the convex support polygon from the feet currently touching ground. */
export function supportPolygon(feet, footWidth = DEFAULTS.footWidth,
                               footLength = DEFAULTS.footLength) {
  const contacts = Object.values(feet || {}).filter((foot) => foot?.contact !== false);
  if (contacts.length === 0) return null;

  const halfW = footWidth * 0.5;
  const halfL = footLength * 0.5;
  const corners = contacts.flatMap((foot) => {
    const x = finite(foot.x);
    const z = finite(foot.z);
    return [
      { x: x - halfW, z: z - halfL }, { x: x + halfW, z: z - halfL },
      { x: x + halfW, z: z + halfL }, { x: x - halfW, z: z + halfL },
    ];
  });
  const points = convexHull(corners);
  return {
    points,
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minZ: Math.min(...points.map((point) => point.z)),
    maxZ: Math.max(...points.map((point) => point.z)),
  };
}

export function pointMargin(point, bounds) {
  if (!bounds) return -Infinity;
  if (bounds.points?.length >= 3) {
    let margin = Infinity;
    for (let i = 0; i < bounds.points.length; i++) {
      const a = bounds.points[i];
      const b = bounds.points[(i + 1) % bounds.points.length];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      margin = Math.min(margin, cross(a, b, point) / length);
    }
    return margin;
  }
  return Math.min(
    point.x - bounds.minX, bounds.maxX - point.x,
    point.z - bounds.minZ, bounds.maxZ - point.z,
  );
}

// Project a requested point into a convex polygon inset by `margin`.
function constrainPoint(point, polygon, margin) {
  const constrained = { x: finite(point.x), z: finite(point.z) };
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < polygon.points.length; i++) {
      const a = polygon.points[i];
      const b = polygon.points[(i + 1) % polygon.points.length];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      const signedDistance = cross(a, b, constrained) / length;
      if (signedDistance < margin) {
        const correction = margin - signedDistance;
        constrained.x += (-dz / length) * correction;
        constrained.z += (dx / length) * correction;
      }
    }
  }
  return constrained;
}

/**
 * Gravity-aware balance loop for horizontal COM motion.
 * State and support coordinates are robot-local: +X left, +Z forward.
 */
export class BalanceController {
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    this.enabled = true;
    this.reset();
  }

  reset() {
    this.com = { x: 0, z: 0 };
    this.velocity = { x: 0, z: 0 };
    this.zmp = { x: 0, z: 0 };
    this.capturePoint = { x: 0, z: 0 };
    this.support = null;
    this.margin = 0;
    this.status = 'stable';
    this.controlEffort = 0;
  }

  /** Apply a horizontal impulse in N*s, as from an external push. */
  applyImpulse(xImpulse = 0, zImpulse = 0) {
    this.velocity.x += xImpulse / this.config.mass;
    this.velocity.z += zImpulse / this.config.mass;
  }

  step(pose, dt) {
    dt = clamp(finite(dt), 0, 0.05);
    this.support = supportPolygon(
      pose?.feet, this.config.footWidth, this.config.footLength);

    // No ground reaction force in flight: horizontal velocity is conserved.
    if (!this.support) {
      this.com.x += this.velocity.x * dt;
      this.com.z += this.velocity.z * dt;
      this.zmp = { x: NaN, z: NaN };
      this.capturePoint = { ...this.com };
      this.margin = -Infinity;
      this.status = 'airborne';
      this.controlEffort = 0;
      return this.output();
    }

    const c = this.config;
    const target = pose?.balanceTarget || {
      x: (this.support.minX + this.support.maxX) * 0.5,
      z: (this.support.minZ + this.support.maxZ) * 0.5,
    };
    const safeTarget = constrainPoint(target, this.support, c.edgeMargin);
    const targetX = safeTarget.x;
    const targetZ = safeTarget.z;

    // Integrate in small fixed-ish slices to avoid frame-rate-dependent instability.
    const slices = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / slices;
    let requestedX = this.com.x;
    let requestedZ = this.com.z;
    for (let i = 0; i < slices; i++) {
      const desiredAX = this.enabled
        ? c.kp * (targetX - this.com.x) - c.kd * this.velocity.x : 0;
      const desiredAZ = this.enabled
        ? c.kp * (targetZ - this.com.z) - c.kd * this.velocity.z : 0;

      // Invert LIPM dynamics to request a ZMP, then respect the real foot boundary.
      requestedX = this.com.x - c.comHeight / c.gravity * desiredAX;
      requestedZ = this.com.z - c.comHeight / c.gravity * desiredAZ;
      this.zmp = constrainPoint({ x: requestedX, z: requestedZ }, this.support, c.edgeMargin);

      const ax = c.gravity / c.comHeight * (this.com.x - this.zmp.x);
      const az = c.gravity / c.comHeight * (this.com.z - this.zmp.z);
      this.velocity.x += ax * h;
      this.velocity.z += az * h;
      this.com.x += this.velocity.x * h;
      this.com.z += this.velocity.z * h;
    }

    const naturalFrequency = Math.sqrt(c.gravity / c.comHeight);
    this.capturePoint.x = this.com.x + this.velocity.x / naturalFrequency;
    this.capturePoint.z = this.com.z + this.velocity.z / naturalFrequency;
    this.margin = pointMargin(this.capturePoint, this.support);
    this.status = this.margin >= c.edgeMargin ? 'stable'
      : this.margin >= 0 ? 'warning' : 'unstable';
    this.controlEffort = Math.hypot(requestedX - this.zmp.x, requestedZ - this.zmp.z);
    return this.output();
  }

  output() {
    const c = this.config;
    const hasZmp = Number.isFinite(this.zmp.x) && Number.isFinite(this.zmp.z);
    // These angles are applied to the visible ankle/hip chain as feedback action.
    const ankleRoll = hasZmp ? clamp((this.zmp.x - this.com.x) / c.comHeight, -0.18, 0.18) : 0;
    const anklePitch = hasZmp ? clamp((this.zmp.z - this.com.z) / c.comHeight, -0.18, 0.18) : 0;
    return {
      gravity: c.gravity,
      com: { ...this.com },
      velocity: { ...this.velocity },
      zmp: { ...this.zmp },
      capturePoint: { ...this.capturePoint },
      support: this.support ? { ...this.support } : null,
      margin: this.margin,
      status: this.status,
      controlEffort: this.controlEffort,
      bodyRoll: Math.atan2(this.com.x, c.comHeight),
      bodyPitch: Math.atan2(this.com.z, c.comHeight),
      ankleRoll,
      anklePitch,
    };
  }
}
