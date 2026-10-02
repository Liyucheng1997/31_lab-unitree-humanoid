import test from 'node:test';
import assert from 'node:assert/strict';
import { superellipse, curve, loftMesh, solveCrank } from '../src/robot/model/loftCore.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('超椭圆截面点满足 |x/a|^n + |z/b|^n = 1', () => {
  for (const n of [2, 2.6, 4]) {
    for (let k = 0; k < 24; k++) {
      const th = (k / 24) * Math.PI * 2;
      const [x, z] = superellipse(0.05, 0.08, n, th);
      const v = Math.abs(x / 0.05) ** n + Math.abs(z / 0.08) ** n;
      assert.ok(near(v, 1, 1e-9), `n=${n} θ=${th.toFixed(2)} → ${v}`);
    }
  }
});

test('关键帧曲线过每个关键点且在区间外钳位', () => {
  const keys = [[0, 1], [0.3, 2], [0.7, 1.5], [1, 0.5]];
  const f = curve(keys);
  for (const [v, p] of keys) assert.ok(near(f(v), p, 1e-12));
  assert.equal(f(-1), 1);
  assert.equal(f(2), 0.5);
});

function checkMesh(m, label) {
  const { positions, normals, indices } = m;
  for (const v of positions) assert.ok(Number.isFinite(v), `${label}: 顶点含非有限值`);
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    assert.ok(Math.abs(l - 1) < 1e-4, `${label}: 第 ${i / 3} 个法线长度 ${l}`);
  }
  // 每个三角形的几何面法线与顶点法线同向（背面剔除与光照一致）
  let bad = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const P = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const [pa, pb, pc] = [P(a), P(b), P(c)];
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const w = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const f = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    if (Math.hypot(...f) < 1e-14) continue;     // 穹顶退化三角形
    const n = [0, 1, 2].map((k) => normals[a * 3 + k] + normals[b * 3 + k] + normals[c * 3 + k]);
    if (f[0] * n[0] + f[1] * n[1] + f[2] * n[2] < 0) bad++;
  }
  assert.equal(bad, 0, `${label}: ${bad} 个三角形朝向与法线相反`);
}

test('放样网格：整圈、穹顶封口、分体瓦片 + 壁厚均有效且朝向一致', () => {
  const tube = loftMesh({
    radial: 24, segments: 8,
    profile: (v) => ({ y: -v * 0.3, a: 0.05, b: 0.04, n: 2.6 }),
  });
  checkMesh(tube, '整圈');
  // 外法线朝外：截面最右点（θ=0）法线应指向 +X
  assert.ok(tube.normals[0] > 0.9);

  const dome = loftMesh({
    radial: 32, segments: 16,
    profile: (v) => ({ y: v * 0.2, a: 0.08 * Math.sqrt(1 - v * v), b: 0.09 * Math.sqrt(1 - v * v), n: 2.4 }),
  });
  checkMesh(dome, '穹顶');

  const panel = loftMesh({
    radial: 20, segments: 10, arc: [Math.PI / 2 - 1, Math.PI / 2 + 1], thickness: 0.004,
    profile: (v) => ({ y: -v * 0.2, a: 0.06, b: 0.07, z: 0.01, n: 2.8 }),
  });
  checkMesh(panel, '带壁厚瓦片');
  // 壁厚：外表面 + 内壁 + 4 条端面
  const cols = 21;
  const rows = 11;
  assert.equal(panel.positions.length / 3, 2 * cols * rows + 2 * (rows * 2) + 2 * (cols * 2));
});

test('曲柄-连杆闭环解：已知曲柄角正推足端，再反解能还原', () => {
  const M = [0.058, -0.112, -0.04];
  const r = 0.042;
  for (const theta of [-2.2, -1.9, -Math.PI / 2, -1.2, -0.9]) {
    const P = [M[0], M[1] + r * Math.cos(theta), M[2] + r * Math.sin(theta)];
    const A = [0.034, -0.38, -0.04 + 0.01 * Math.sin(theta)];
    const L = Math.hypot(P[0] - A[0], P[1] - A[1], P[2] - A[2]);
    const sol = solveCrank(M, A, r, L, theta + 0.05);
    assert.ok(sol.reachable);
    assert.ok(near(sol.theta, theta, 1e-9), `θ=${theta} 解得 ${sol.theta}`);
  }
  // 杆长远超行程 → 不可达
  assert.equal(solveCrank(M, [0.034, -0.38, -0.04], r, 0.5, -Math.PI / 2).reachable, false);
});
