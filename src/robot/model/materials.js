// 工程材质库：PBR 物理材质 + 程序化微观纹理（运行时生成，零贴图资源）。
//   shell     PA12 注塑外壳：哑光缎面白 + 细砂纹法线 + 薄清漆
//   graphite  深灰外壳件（腹甲、护膝）
//   frame     6061 阳极黑氧化结构件
//   alu       CNC 机加工铝：拉丝法线纹理（电机端盖、法兰）
//   gunmetal  喷砂枪灰铝（电机外壳）
//   carbon    碳纤维管（小腿主梁、前臂梁）
//   rubber    TPU 足底 / 指腹
//   cable     编织套管线束
//   accent    工程橙（航插、限位块、警示件）
//   visor     面罩：高反射烟色亚克力
//
// 注意：与 scene.js 的 Bloom 阈值（7，按亮度）配套——只有 LED 类材质的亮度超过阈值。
import * as THREE from 'three';

const HAS_DOM = typeof document !== 'undefined';

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// 简单可重复的伪随机数，保证每次生成的纹理一致。
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** 由灰度高度函数生成切线空间法线贴图（无缝平铺）。 */
function normalMapFromHeight(size, heightFn, strength = 2) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) h[y * size + x] = heightFn(x, y);
  }
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const H = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      img.data[o] = (-dx / l * 0.5 + 0.5) * 255;
      img.data[o + 1] = (dy / l * 0.5 + 0.5) * 255;
      img.data[o + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** 平铺值噪声（多倍频），用于注塑砂纹与喷砂表面。 */
function tiledNoise(size, cells, seed) {
  const r = rng(seed);
  const grid = Array.from({ length: cells * cells }, r);
  const g = (x, y) => grid[((y + cells) % cells) * cells + ((x + cells) % cells)];
  const smooth = (t) => t * t * (3 - 2 * t);
  return (px, py) => {
    const fx = (px / size) * cells;
    const fy = (py / size) * cells;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * tx;
    const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  };
}

function makeTextures() {
  if (!HAS_DOM) return {};
  const S = 256;
  const n1 = tiledNoise(S, 64, 11);
  const n2 = tiledNoise(S, 128, 23);
  const grain = normalMapFromHeight(S, (x, y) => n1(x, y) * 0.6 + n2(x, y) * 0.4, 1.1);
  grain.repeat.set(6, 6);

  const b1 = tiledNoise(S, 32, 7);
  const blast = normalMapFromHeight(S, (x, y) => b1(x, y) * 0.3 + n2(x, y) * 0.7, 0.8);
  blast.repeat.set(4, 4);

  // 拉丝：沿 U 方向的细长条纹（各向异性高光贴合车削件的周向）
  const rLine = rng(5);
  const lines = Array.from({ length: S }, () => rLine());
  const brushed = normalMapFromHeight(S, (x, y) => lines[y] * 0.8 + n2(x, y) * 0.05, 1.4);
  brushed.repeat.set(1, 3);

  // 碳纤维 2x2 斜纹：颜色贴图 + 法线
  const weave = (x, y) => {
    const cell = 16;
    const u = Math.floor(x / cell);
    const v = Math.floor(y / cell);
    const warp = ((u + v) % 4) < 2;
    const fx = (x % cell) / cell;
    const fy = (y % cell) / cell;
    const bump = warp ? Math.sin(fx * Math.PI) : Math.sin(fy * Math.PI);
    return { warp, bump };
  };
  const cc = canvas(S);
  const cctx = cc.getContext('2d');
  const cimg = cctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const { warp, bump } = weave(x, y);
      const base = warp ? 34 : 22;
      const v = base + bump * 22;
      const o = (y * S + x) * 4;
      cimg.data[o] = v; cimg.data[o + 1] = v + 2; cimg.data[o + 2] = v + 6; cimg.data[o + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0);
  const carbonMap = new THREE.CanvasTexture(cc);
  carbonMap.wrapS = carbonMap.wrapT = THREE.RepeatWrapping;
  carbonMap.colorSpace = THREE.SRGBColorSpace;
  carbonMap.repeat.set(3, 6);
  const carbonNormal = normalMapFromHeight(S, (x, y) => weave(x, y).bump, 1.6);
  carbonNormal.repeat.copy(carbonMap.repeat);

  // 编织套管：交叉螺旋纹
  const braid = normalMapFromHeight(S, (x, y) => {
    const a = Math.sin((x + y) * 0.39);
    const b = Math.sin((x - y) * 0.39);
    return Math.max(a, b) * 0.5;
  }, 2.5);
  braid.repeat.set(12, 1);

  // 足底防滑纹：交错人字纹
  const tread = normalMapFromHeight(S, (x, y) => {
    const v = ((y + Math.abs(((x % 32) - 16)) * 0.9) % 18) / 18;
    return v < 0.5 ? 0 : 1;
  }, 3);
  tread.repeat.set(2, 3);

  return { grain, blast, brushed, carbonMap, carbonNormal, braid, tread };
}

const TEX = makeTextures();

export const MAT = {
  shell: new THREE.MeshPhysicalMaterial({
    name: 'shell', color: 0xeceef0, roughness: 0.46, metalness: 0.0,
    clearcoat: 0.32, clearcoatRoughness: 0.32, sheen: 0.15, sheenRoughness: 0.6,
    normalMap: TEX.grain ?? null, normalScale: new THREE.Vector2(0.12, 0.12),
  }),
  graphite: new THREE.MeshPhysicalMaterial({
    name: 'graphite', color: 0x2b3036, roughness: 0.5, metalness: 0.15,
    clearcoat: 0.25, clearcoatRoughness: 0.4,
    normalMap: TEX.grain ?? null, normalScale: new THREE.Vector2(0.15, 0.15),
  }),
  frame: new THREE.MeshStandardMaterial({
    name: 'frame', color: 0x16191d, roughness: 0.42, metalness: 0.78,
    normalMap: TEX.blast ?? null, normalScale: new THREE.Vector2(0.25, 0.25),
  }),
  gunmetal: new THREE.MeshStandardMaterial({
    name: 'gunmetal', color: 0x5d636b, roughness: 0.44, metalness: 0.9,
    normalMap: TEX.blast ?? null, normalScale: new THREE.Vector2(0.3, 0.3),
  }),
  alu: new THREE.MeshPhysicalMaterial({
    name: 'alu', color: 0xc4c8cc, roughness: 0.3, metalness: 1.0,
    // 不用 anisotropy：小车削件（螺钉头、轴端）UV 退化时各向异性切线会产生 Inf 高光，
    // 经 Bloom 扩散成大片光斑。拉丝质感改由法线贴图表达。
    normalMap: TEX.brushed ?? null, normalScale: new THREE.Vector2(0.18, 0.18),
  }),
  carbon: new THREE.MeshPhysicalMaterial({
    name: 'carbon', color: 0xffffff, roughness: 0.32, metalness: 0.25,
    clearcoat: 0.9, clearcoatRoughness: 0.08,
    map: TEX.carbonMap ?? null, normalMap: TEX.carbonNormal ?? null,
    normalScale: new THREE.Vector2(0.35, 0.35),
  }),
  rubber: new THREE.MeshStandardMaterial({
    name: 'rubber', color: 0x0c0d0f, roughness: 0.86, metalness: 0.0,
  }),
  tread: new THREE.MeshStandardMaterial({
    name: 'tread', color: 0x101114, roughness: 0.9, metalness: 0.0,
    normalMap: TEX.tread ?? null, normalScale: new THREE.Vector2(0.9, 0.9),
  }),
  cable: new THREE.MeshStandardMaterial({
    name: 'cable', color: 0x1b1e22, roughness: 0.62, metalness: 0.1,
    normalMap: TEX.braid ?? null, normalScale: new THREE.Vector2(0.8, 0.8),
  }),
  accent: new THREE.MeshPhysicalMaterial({
    name: 'accent', color: 0xff6a1a, roughness: 0.42, metalness: 0.05,
    clearcoat: 0.4, clearcoatRoughness: 0.3,
  }),
  copper: new THREE.MeshStandardMaterial({
    name: 'copper', color: 0xc77b4a, roughness: 0.32, metalness: 1.0,
  }),
  pcb: new THREE.MeshStandardMaterial({
    name: 'pcb', color: 0x0d3a2a, roughness: 0.5, metalness: 0.2,
  }),
  visor: new THREE.MeshPhysicalMaterial({
    name: 'visor', color: 0x020305, roughness: 0.05, metalness: 0.35,
    clearcoat: 1, clearcoatRoughness: 0.03, reflectivity: 0.8,
  }),
  lens: new THREE.MeshPhysicalMaterial({
    name: 'lens', color: 0x05080d, roughness: 0.02, metalness: 0.6,
    clearcoat: 1, iridescence: 0.6, iridescenceIOR: 1.8,
  }),
  // 状态指示灯：低于 Bloom 阈值，可见但不泛光
  ledSoft: new THREE.MeshStandardMaterial({
    name: 'ledSoft', color: 0xbff7ff, emissive: 0x35d9ff, emissiveIntensity: 1.6,
    roughness: 0.2,
  }),
  // 强发光灯带：参与 Bloom
  led: new THREE.MeshStandardMaterial({
    name: 'led', color: 0xbff7ff, emissive: 0x35d9ff, emissiveIntensity: 20,
    roughness: 0.2,
  }),
};

// X 光模式：外壳换成菲涅尔全息材质——正对视线处几乎全透明，轮廓边缘泛青光，
// 内部执行器、结构件、电池与线束一览无余；亮度低于 Bloom 阈值，不会糊成光团。
export const XRAY_MAT = new THREE.ShaderMaterial({
  name: 'xray',
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    color: { value: new THREE.Color(0x5fd4ff) },
    power: { value: 2.6 },
    base: { value: 0.008 },
    edge: { value: 0.42 },
  },
  vertexShader: /* glsl */`
    varying vec3 vN;
    varying vec3 vV;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal);
      vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 color;
    uniform float power;
    uniform float base;
    uniform float edge;
    varying vec3 vN;
    varying vec3 vV;
    void main() {
      float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), power);
      gl_FragColor = vec4(color * (base + edge * f), 1.0);
    }`,
});

/** 切换一组外壳网格的 X 光材质（原材质存于 userData.solid）。 */
export function setXRay(meshes, on) {
  for (const m of meshes) {
    if (on) {
      m.userData.solid ??= m.material;
      m.material = XRAY_MAT;
      m.castShadow = false;
    } else if (m.userData.solid) {
      m.material = m.userData.solid;
      m.castShadow = true;
    }
  }
}

/** 文字标签贴花（铭牌、警示标、关节编号），返回透明 CanvasTexture。 */
export function labelTexture(lines, { w = 256, h = 64, bg = null, fg = '#1d232a', font = 'bold 30px "Segoe UI", sans-serif', align = 'left', border = null } = {}) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  if (border) {
    ctx.strokeStyle = border; ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);
  }
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.textAlign = align;
  const list = Array.isArray(lines) ? lines : [lines];
  list.forEach((line, i) => {
    const f = typeof line === 'object' ? line : { text: line };
    ctx.font = f.font ?? font;
    const x = align === 'center' ? w / 2 : 10;
    ctx.fillText(f.text, x, (h / list.length) * (i + 0.5));
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 警示三角（挤压点 / 高温）贴花。 */
export function warningTexture() {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffb000';
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 9;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(64, 10); ctx.lineTo(120, 112); ctx.lineTo(8, 112); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#111';
  ctx.font = 'bold 66px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', 64, 78);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function decalMaterial(texture) {
  return new THREE.MeshStandardMaterial({
    map: texture, transparent: true, roughness: 0.5, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false,
  });
}
