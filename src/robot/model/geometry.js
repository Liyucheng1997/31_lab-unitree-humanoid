// three.js 几何工具：把 loftCore 的纯数学网格包成 BufferGeometry，
// 并提供车削件（法兰/电机壳）、带减重孔的机加工板、圆角块、线束管等工程零件形状。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { loftMesh, curve } from './loftCore.js?v=20261002-eng-v1';

export { curve };

/** 超椭圆放样 → BufferGeometry（见 loftCore.loftMesh 参数）。 */
export function loft(opts) {
  const m = loftMesh(opts);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  return g;
}

/**
 * 用关键帧描述一段沿 -Y 方向延伸的肢体外壳。
 * keys: [[v, a(半宽), b(半深), z(前后偏心), n(方度)], ...]，y = y0 - v·length
 */
export function limbShell({ length, y0 = 0, keys, arc, thickness = 0, radial = 44, segments = 28, x = 0 }) {
  const A = curve(keys.map((k) => [k[0], k[1]]));
  const B = curve(keys.map((k) => [k[0], k[2]]));
  const Z = curve(keys.map((k) => [k[0], k[3] ?? 0]));
  const Nn = curve(keys.map((k) => [k[0], k[4] ?? 2.6]));
  return loft({
    radial, segments, arc, thickness,
    profile: (v) => ({ y: y0 - v * length, a: A(v), b: B(v), x, z: Z(v), n: Nn(v) }),
  });
}

/**
 * 车削件：profile 为 [[r, y], ...]（自下而上），绕 Y 轴旋转。
 * 法兰、电机壳、轴承座、端盖都用它——带倒角的阶梯轮廓就是机加工件的灵魂。
 */
export function lathe(profile, segments = 40) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0), y));
  const g = new THREE.LatheGeometry(pts, segments);
  g.computeVertexNormals();
  return g;
}

/** 把 Y 轴向的几何转到指定轴向（'x' | 'y' | 'z'）。 */
export function alignAxis(geometry, axis) {
  if (axis === 'x') geometry.rotateZ(-Math.PI / 2);
  else if (axis === 'z') geometry.rotateX(Math.PI / 2);
  return geometry;
}

export function roundedBox(w, h, d, radius = 0.004, segs = 3) {
  const r = Math.min(radius, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  return new RoundedBoxGeometry(w, h, d, segs, Math.max(r, 1e-4));
}

export function cyl(rTop, rBottom, h, radial = 28, open = false) {
  return new THREE.CylinderGeometry(rTop, rBottom, h, radial, 1, open);
}

/** 圆角矩形轮廓（Shape），可作为外轮廓或孔。 */
export function roundedRectShape(w, h, r, cx = 0, cy = 0, hole = false) {
  const s = hole ? new THREE.Path() : new THREE.Shape();
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0);
  s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  s.lineTo(x0 + w, y0 + h - r);
  s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  s.lineTo(x0 + r, y0 + h);
  s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  return s;
}

/**
 * 机加工侧板：XY 平面的圆角梯形外轮廓，内含若干减重孔（圆角矩形 / 圆孔），厚度沿 Z。
 * holes: [{ w, h, r, x, y }] 或 [{ circle: radius, x, y }]
 */
export function plate({ topW, bottomW, height, depth, radius = 0.01, holes = [], bevel = 0.0015 }) {
  const s = new THREE.Shape();
  const hb = bottomW / 2;
  const ht = topW / 2;
  const hh = height / 2;
  const r = Math.min(radius, ht, hb, hh);
  // 圆角梯形：逐角用二次曲线倒圆
  const pts = [[-hb, -hh], [hb, -hh], [ht, hh], [-ht, hh]];
  const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const along = (a, b, d) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return lerp2(a, b, Math.min(0.5, d / L));
  };
  for (let i = 0; i < 4; i++) {
    const prev = pts[(i + 3) % 4];
    const cur = pts[i];
    const next = pts[(i + 1) % 4];
    const p0 = along(cur, prev, r);
    const p1 = along(cur, next, r);
    if (i === 0) s.moveTo(p0[0], p0[1]);
    else s.lineTo(p0[0], p0[1]);
    s.quadraticCurveTo(cur[0], cur[1], p1[0], p1[1]);
  }
  s.closePath();
  for (const h of holes) {
    if (h.circle) {
      const p = new THREE.Path();
      p.absarc(h.x, h.y, h.circle, 0, Math.PI * 2, true);
      s.holes.push(p);
    } else {
      s.holes.push(roundedRectShape(h.w, h.h, h.r ?? 0.006, h.x, h.y, true));
    }
  }
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(depth - bevel * 2, 1e-4), bevelEnabled: bevel > 0,
    bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 10,
  });
  g.translate(0, 0, -depth / 2 + bevel);
  g.clearGroups();
  return g;
}

/** 沿空间曲线的软管 / 线束。 */
export function tube(points, radius, tubular = 32, radial = 8) {
  const c = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(c, tubular, radius, radial, false);
}

/** 内六角圆柱头螺钉（沿 +Y 朝外）：头部 + 六角孔暗面。 */
export function capScrew(d = 0.005) {
  const head = cyl(d * 0.8, d * 0.85, d * 0.55, 14);
  head.translate(0, d * 0.275, 0);
  return head;
}
export function hexSocket(d = 0.005) {
  const hole = cyl(d * 0.38, d * 0.38, d * 0.12, 6);
  hole.translate(0, d * 0.56, 0);
  return hole;
}

/** 平面多齿散热鳍片阵列（XY 平面，鳍片沿 Z 拉伸）。 */
export function finArray(count, pitch, finW, finH, finD) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const g = new THREE.BoxGeometry(finW, finH, finD);
    g.translate((i - (count - 1) / 2) * pitch, 0, 0);
    parts.push(g);
  }
  return parts;
}
