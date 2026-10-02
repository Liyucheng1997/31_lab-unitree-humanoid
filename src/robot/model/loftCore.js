// 放样（loft）几何内核 —— 纯数学，无 three 依赖，可在 Node 中单测。
//
// 沿一条参数 v∈[0,1] 扫掠一族超椭圆截面，生成光顺的工业外壳曲面：
//   |x/a|^n + |z/b|^n = 1      n=2 椭圆，n→4 圆角矩形（注塑件 / CNC 件的典型截面）
// 截面由 profile(v) 给出：{ y, a, b, x?, z?, n? }，可以逐段改变宽度、深度、偏心和方度。
//
// 支持：
//   - 角度区间 arc=[θ0, θ1]：只生成一块"瓦片"，用于前/后/侧分体外壳；
//   - thickness>0：生成内壁 + 四周端面，得到有真实壁厚的壳体，分模缝处能看到厚度；
//   - 截面半径收缩到 0 的退化环：自动用轴向法线，用于穹顶状封口。
// θ=0 指向 +X，θ=π/2 指向 +Z（机器人正面）。

const TAU = Math.PI * 2;

/** 超椭圆上角度 θ 处的点（相对截面中心）。 */
export function superellipse(a, b, n, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const e = 2 / n;
  return [
    a * Math.sign(c) * Math.pow(Math.abs(c), e),
    b * Math.sign(s) * Math.pow(Math.abs(s), e),
  ];
}

/**
 * 关键帧插值：keys = [[v, value], ...]（v 递增）。
 * 非均匀 Catmull-Rom（Hermite），曲线过每个关键点且一阶连续——外壳轮廓不会出现折痕。
 */
export function curve(keys) {
  const n = keys.length;
  const slope = keys.map((_, i) => {
    if (n < 2) return 0;
    const p = keys[Math.max(0, i - 1)];
    const q = keys[Math.min(n - 1, i + 1)];
    return (q[1] - p[1]) / Math.max(q[0] - p[0], 1e-9);
  });
  return (v) => {
    if (v <= keys[0][0]) return keys[0][1];
    if (v >= keys[n - 1][0]) return keys[n - 1][1];
    let i = 0;
    while (i < n - 2 && v > keys[i + 1][0]) i++;
    const [v0, p0] = keys[i];
    const [v1, p1] = keys[i + 1];
    const h = v1 - v0;
    const t = (v - v0) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * h * slope[i]
      + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * h * slope[i + 1];
  };
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

/** 网格缓冲构造器：所有三角形按期望法线自动定向，保证背面剔除正确。 */
class MeshBuffer {
  constructor() { this.p = []; this.n = []; this.uv = []; this.idx = []; }
  vertex(p, n, u, v) {
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    return this.p.length / 3 - 1;
  }
  pos(i) { return [this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]]; }
  nrm(i) { return [this.n[i * 3], this.n[i * 3 + 1], this.n[i * 3 + 2]]; }
  tri(a, b, c) {
    const pa = this.pos(a);
    const face = cross(sub(this.pos(b), pa), sub(this.pos(c), pa));
    const want = [0, 1, 2].map((k) => this.n[a * 3 + k] + this.n[b * 3 + k] + this.n[c * 3 + k]);
    if (dot(face, want) < 0) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
  }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(b, d, c); }
  result() {
    // 退化顶点（壁厚端面在穹顶处收缩为一点）兜底：零法线改为相邻三角形的面法线之和。
    const acc = new Float64Array(this.n.length);
    for (let t = 0; t < this.idx.length; t += 3) {
      const [a, b, c] = [this.idx[t], this.idx[t + 1], this.idx[t + 2]];
      const pa = this.pos(a);
      const f = cross(sub(this.pos(b), pa), sub(this.pos(c), pa));
      for (const v of [a, b, c]) for (let k = 0; k < 3; k++) acc[v * 3 + k] += f[k];
    }
    for (let v = 0; v < this.n.length / 3; v++) {
      const cur = this.nrm(v);
      if (Math.hypot(cur[0], cur[1], cur[2]) > 1e-6) continue;
      let f = norm([acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]]);
      if (f[0] === 0 && f[1] === 0 && f[2] === 0) f = [0, 1, 0];
      this.n[v * 3] = f[0]; this.n[v * 3 + 1] = f[1]; this.n[v * 3 + 2] = f[2];
    }
    return {
      positions: new Float32Array(this.p),
      normals: new Float32Array(this.n),
      uvs: new Float32Array(this.uv),
      indices: new Uint32Array(this.idx),
    };
  }
}

/**
 * 生成放样网格。
 * @param {Object} o
 * @param {(v:number)=>{y:number,a:number,b:number,x?:number,z?:number,n?:number}} o.profile
 * @param {number} [o.radial=40]   周向分段
 * @param {number} [o.segments=24] 轴向分段
 * @param {[number,number]} [o.arc] 角度区间，缺省为整圈
 * @param {number} [o.thickness=0] 壁厚（>0 生成内壁与端面）
 * @returns {{positions:Float32Array,normals:Float32Array,uvs:Float32Array,indices:Uint32Array}}
 */
export function loftMesh(o) {
  const radial = o.radial ?? 40;
  const segs = o.segments ?? 24;
  const arc = o.arc ?? [0, TAU];
  const closed = Math.abs(arc[1] - arc[0] - TAU) < 1e-6;
  const cols = radial + 1;
  const rows = segs + 1;

  // 1. 采样曲面点
  const P = [];
  const centers = [];
  for (let j = 0; j < rows; j++) {
    const s = o.profile(j / segs);
    const cx = s.x ?? 0;
    const cz = s.z ?? 0;
    centers.push([cx, s.y, cz]);
    for (let i = 0; i < cols; i++) {
      const th = arc[0] + (arc[1] - arc[0]) * (i / radial);
      const [x, z] = superellipse(Math.max(s.a, 0), Math.max(s.b, 0), s.n ?? 2, th);
      P.push([cx + x, s.y, cz + z]);
    }
  }
  const at = (i, j) => P[j * cols + i];

  // 2. 曲面切向（中心差分；整圈时周向回绕）与外法线
  const dTheta = (i, j) => {
    if (closed) {
      const ip = i === radial ? 1 : i + 1;
      const im = i === 0 ? radial - 1 : i - 1;
      return sub(at(ip, j), at(im, j));
    }
    return sub(at(Math.min(radial, i + 1), j), at(Math.max(0, i - 1), j));
  };
  const dV = (i, j) => sub(at(i, Math.min(segs, j + 1)), at(i, Math.max(0, j - 1)));

  // 全局朝向：用中部一个点的 (dθ × dv) 与径向比较，决定法线符号。
  const mi = Math.floor(radial / 2);
  const mj = Math.floor(segs / 2);
  const radialDir = sub(at(mi, mj), centers[mj]);
  const sign = dot(cross(dTheta(mi, mj), dV(mi, mj)), radialDir) >= 0 ? 1 : -1;

  const N = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let nrm = norm(cross(dTheta(i, j), dV(i, j)));
      if (nrm[0] === 0 && nrm[1] === 0 && nrm[2] === 0) {
        // 退化环（穹顶顶点）：法线沿轴向朝外。
        const other = centers[j === 0 ? 1 : segs - 1];
        nrm = norm(sub(centers[j], other));
      } else {
        nrm = nrm.map((c) => c * sign);
      }
      N.push(nrm);
    }
  }

  const mb = new MeshBuffer();
  const t = o.thickness ?? 0;

  // 3. 外表面
  const outer = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      outer.push(mb.vertex(at(i, j), N[j * cols + i], i / radial, j / segs));
    }
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < radial; i++) {
      mb.quad(outer[j * cols + i], outer[j * cols + i + 1],
        outer[(j + 1) * cols + i], outer[(j + 1) * cols + i + 1]);
    }
  }
  if (t <= 0) return mb.result();

  // 4. 内壁：沿外法线反向偏移壁厚
  const inner = [];
  const IP = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const p = at(i, j);
      const n = N[k];
      const q = [p[0] - n[0] * t, p[1] - n[1] * t, p[2] - n[2] * t];
      IP.push(q);
      inner.push(mb.vertex(q, [-n[0], -n[1], -n[2]], i / radial, j / segs));
    }
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < radial; i++) {
      mb.quad(inner[j * cols + i], inner[j * cols + i + 1],
        inner[(j + 1) * cols + i], inner[(j + 1) * cols + i + 1]);
    }
  }

  // 5. 端面（壁厚的可见边）：法线取该边界处向外的切向
  const rim = (ks, outward) => {
    const vo = [];
    const vi = [];
    ks.forEach((k, m) => {
      const n = outward(k);
      vo.push(mb.vertex(P[k], n, m / (ks.length - 1), 0));
      vi.push(mb.vertex(IP[k], n, m / (ks.length - 1), 1));
    });
    for (let m = 0; m < ks.length - 1; m++) mb.quad(vo[m], vo[m + 1], vi[m], vi[m + 1]);
  };
  if (!closed) {
    const colK = (i) => Array.from({ length: rows }, (_, j) => j * cols + i);
    rim(colK(0), (k) => norm(dTheta(0, Math.floor(k / cols)).map((c) => -c)));
    rim(colK(radial), (k) => norm(dTheta(radial, Math.floor(k / cols))));
  }
  const rowK = (j) => Array.from({ length: cols }, (_, i) => j * cols + i);
  const capDir = (j) => norm(sub(centers[j], centers[j === 0 ? 1 : segs - 1]));
  rim(rowK(0), () => capDir(0));
  rim(rowK(segs), () => capDir(segs));
  return mb.result();
}

/**
 * 曲柄-连杆闭环求解（踝关节并联驱动用）。
 * 曲柄绕 X 轴转动：P(θ) = M + r·(0, cosθ, sinθ)，求使 |P(θ) − A| = L 的 θ。
 *   (M−A)·(0,c,s)·r 展开得 Dy·cosθ + Dz·sinθ = K → θ = φ ± acos(K/R)
 * 取离上一帧 θ 最近的解，保证机构连续不翻转。
 * @returns {{theta:number, reachable:boolean}}
 */
export function solveCrank(M, A, r, L, prevTheta = 0) {
  const D = [M[0] - A[0], M[1] - A[1], M[2] - A[2]];
  const R = Math.hypot(D[1], D[2]);
  const K = (L * L - (D[0] * D[0] + D[1] * D[1] + D[2] * D[2]) - r * r) / (2 * r);
  const ratio = K / Math.max(R, 1e-12);
  const reachable = Math.abs(ratio) <= 1;
  const phi = Math.atan2(D[2], D[1]);
  const delta = Math.acos(Math.max(-1, Math.min(1, ratio)));
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const c1 = phi + delta;
  const c2 = phi - delta;
  const theta = Math.abs(wrap(c1 - prevTheta)) <= Math.abs(wrap(c2 - prevTheta)) ? c1 : c2;
  return { theta: prevTheta + wrap(theta - prevTheta), reachable };
}
