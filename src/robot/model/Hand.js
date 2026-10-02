// 灵巧手：铝合金掌骨架 + 白色手背壳 + 掌面 TPU 垫，四指三节 + 两节对掌拇指。
// 每个指节是独立刚体（Group），指腹带橡胶垫，关节处有销轴与限位块。
// setCurl(t)：0 张开 → 1 握拳，与旧接口一致（正 rotation.x 朝掌心 −Z 卷曲）。
import * as THREE from 'three';
import { MAT } from './materials.js?v=20261002-eng-v1';
import { roundedBox, cyl, limbShell } from './geometry.js?v=20261002-eng-v1';

// [x 位置(相对掌心中线，正 = 小指侧会按左右手镜像), 指节长度]
const FINGERS = [
  { x: -0.0225, len: [0.03, 0.021, 0.017], name: 'index' },
  { x: -0.0075, len: [0.032, 0.023, 0.018], name: 'middle' },
  { x: 0.0075, len: [0.03, 0.021, 0.017], name: 'ring' },
  { x: 0.0225, len: [0.025, 0.018, 0.015], name: 'little' },
];
const CURL = [1.15, 1.35, 0.95];

function phalanx(sink, body, len, w, k, isTip) {
  const r = w * 0.44;
  // 指节芯：深灰胶囊体（铝合金骨架 + 硬质涂层）
  const core = new THREE.CapsuleGeometry(r, Math.max(len - 2 * r, 0.001), 6, 14);
  core.scale(1, 1, 0.88);
  sink.add(body, core, MAT.graphite, { p: [0, -len * 0.5, 0] });
  // 掌侧指腹垫（TPU）
  sink.add(body, roundedBox(w * 0.74, len * (isTip ? 0.7 : 0.56), r * 0.7, 0.0022, 2), MAT.rubber,
    { p: [0, -len * (isTip ? 0.56 : 0.5), -r * 0.62] });
  // 关节销轴：铝合金端帽露出两侧
  const pin = cyl(r * 0.62, r * 0.62, w * 1.06, 14);
  pin.rotateZ(Math.PI / 2);
  sink.add(body, pin, MAT.alu, {});
  // 近节手背白色护板，指尖白色甲片
  if (k === 0) {
    sink.add(body, roundedBox(w * 0.9, len * 0.62, r * 0.5, 0.0025, 2), MAT.shell,
      { p: [0, -len * 0.52, r * 0.62] });
  }
  if (isTip) {
    sink.add(body, roundedBox(w * 0.78, len * 0.38, r * 0.42, 0.002, 2), MAT.shell,
      { p: [0, -len * 0.7, r * 0.6] });
  }
}

/**
 * @param {PartSink} sink
 * @param {THREE.Object3D} wrist  手腕刚体（原点 = 腕关节）
 * @param {'L'|'R'} side
 */
export function buildHand(sink, wrist, side) {
  const s = side === 'L' ? 1 : -1;
  const palmTop = -0.024;
  const palmLen = 0.07;
  const palmBottom = palmTop - palmLen;

  // 掌骨架 + 手背壳 + 掌面垫
  sink.add(wrist, roundedBox(0.064, palmLen, 0.018, 0.005, 3), MAT.frame,
    { p: [0, palmTop - palmLen / 2, -0.001] });
  const back = limbShell({
    length: palmLen + 0.004, y0: palmTop + 0.002, radial: 28, segments: 10,
    arc: [Math.PI / 2 - 1.35, Math.PI / 2 + 1.35], thickness: 0.003,
    keys: [[0, 0.03, 0.017, -0.004, 3.2], [0.5, 0.035, 0.019, -0.004, 3.6], [1, 0.035, 0.016, -0.004, 3.6]],
  });
  sink.add(wrist, back, MAT.shell, {});
  sink.add(wrist, roundedBox(0.058, palmLen * 0.82, 0.006, 0.0028, 2), MAT.rubber,
    { p: [0, palmTop - palmLen * 0.55, -0.0115] });
  // 手背状态灯 + 腕部连接法兰
  sink.add(wrist, roundedBox(0.016, 0.004, 0.003, 0.0012, 1), MAT.ledSoft,
    { p: [0, palmTop - 0.016, 0.0178] });
  sink.add(wrist, cyl(0.026, 0.028, 0.008, 28), MAT.alu, { p: [0, palmTop + 0.004, 0] });

  const fingers = [];
  for (const f of FINGERS) {
    const w = 0.0138;
    let parent = wrist;
    let y = palmBottom + 0.003;
    const segs = [];
    f.len.forEach((len, k) => {
      const g = new THREE.Group();
      g.name = `${side}-${f.name}-${k}`;
      g.position.set(k === 0 ? f.x * s : 0, k === 0 ? y : -f.len[k - 1], 0);
      if (k === 0) g.rotation.z = s * f.x * 0.9;   // 指尖略微散开
      parent.add(g);
      phalanx(sink, g, len, w * (1 - k * 0.06), k, k === 2);
      segs.push(g);
      parent = g;
    });
    fingers.push({ segs, thumb: false });
  }

  // 拇指：掌侧根部对掌，两节 + 掌骨
  const thumbBase = new THREE.Group();
  thumbBase.name = `${side}-thumb-base`;
  // 方向：向下、向掌心（−Z）、略向内；屈曲轴经 Ry 转过约 50°，弯曲时横跨掌面
  thumbBase.position.set(-s * 0.027, palmTop - 0.02, -0.011);
  thumbBase.rotation.set(0.35, -s * 0.9, -s * 0.4);
  wrist.add(thumbBase);
  sink.add(wrist, new THREE.SphereGeometry(0.009, 16, 12), MAT.frame,
    { p: [-s * 0.027, palmTop - 0.02, -0.011] });
  const thumbSegs = [];
  let parent = thumbBase;
  [0.028, 0.022, 0.018].forEach((len, k) => {
    const g = new THREE.Group();
    g.name = `${side}-thumb-${k}`;
    g.position.set(0, k === 0 ? 0 : -[0.028, 0.022][k - 1], 0);
    parent.add(g);
    phalanx(sink, g, len, 0.0152 * (1 - k * 0.05), k, k === 2);
    thumbSegs.push(g);
    parent = g;
  });
  fingers.push({ segs: thumbSegs, thumb: true });

  return {
    fingers,
    setCurl(t) {
      for (const finger of this.fingers) {
        finger.segs.forEach((g, k) => {
          const amount = finger.thumb ? t * [0.55, 0.7, 0.6][k] : t * CURL[k];
          g.rotation.x = amount;
        });
      }
    },
  };
}
