import * as THREE from 'three';
import { DIM, FORWARD_Z } from './skeleton.js?v=20260708-showtime-v3';

// 高级材质：陶瓷白装甲 / 阳极黑结构 / 拉丝金属 / 冰蓝状态灯
const MAT = {
  shell: new THREE.MeshPhysicalMaterial({
    // roughness/clearcoat 与 Bloom 阈值 3.2 配套调校：装甲高光峰值需低于阈值
    color: 0xf3f5f6, roughness: 0.33, metalness: 0.08,
    clearcoat: 0.45, clearcoatRoughness: 0.2,
  }),
  shellShade: new THREE.MeshPhysicalMaterial({
    color: 0xcfd4d7, roughness: 0.3, metalness: 0.12, clearcoat: 0.45,
  }),
  frame: new THREE.MeshStandardMaterial({
    color: 0x111419, roughness: 0.34, metalness: 0.76,
  }),
  rubber: new THREE.MeshStandardMaterial({
    color: 0x080a0d, roughness: 0.74, metalness: 0.05,
  }),
  metal: new THREE.MeshStandardMaterial({
    color: 0x4b525a, roughness: 0.26, metalness: 0.92,
  }),
  visor: new THREE.MeshPhysicalMaterial({
    color: 0x05070a, roughness: 0.08, metalness: 0.42,
    clearcoat: 1, clearcoatRoughness: 0.08,
  }),
  light: new THREE.MeshStandardMaterial({
    color: 0xbff7ff, emissive: 0x35d9ff, emissiveIntensity: 4.4,
    roughness: 0.16, metalness: 0.12,
  }),
  // 低亮度指示灯：可见发光但不参与 Bloom（阈值 3.2 以下）。
  lightSoft: new THREE.MeshStandardMaterial({
    color: 0xbff7ff, emissive: 0x35d9ff, emissiveIntensity: 1.8,
    roughness: 0.16, metalness: 0.12,
  }),
};

// 表情预设：不同行为切换不同的眼睛/嘴部灯光气质。
const EMOTIONS = {
  calm:  { color: 0x35d9ff, intensity: 4.5 },   // 待机：冰蓝
  focus: { color: 0x4f8dff, intensity: 5.0 },   // 行走：深蓝
  power: { color: 0xffa03b, intensity: 6.2 },   // 跑步/跳跃：琥珀
  fury:  { color: 0xff3b55, intensity: 7.0 },   // 功夫：赤红
  zen:   { color: 0x34d399, intensity: 3.6 },   // 八段锦：翠绿
  joy:   { color: 0xff4fd8, intensity: 5.6 },   // 跳舞：霓虹粉
};

function finish(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function add(parent, mesh, x = 0, y = 0, z = 0) {
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function box(w, h, d, mat = MAT.shell) {
  return finish(new THREE.Mesh(new THREE.BoxGeometry(w, h, d, 2, 2, 2), mat));
}

function sphere(x, y = x, z = x, mat = MAT.frame, segments = 24) {
  const mesh = finish(new THREE.Mesh(new THREE.SphereGeometry(1, segments, 16), mat));
  mesh.scale.set(x, y, z);
  return mesh;
}

function cylinder(rTop, rBottom, height, mat = MAT.frame, radial = 24) {
  return finish(new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBottom, height, radial, 1, false), mat));
}

function ring(major, tube, mat = MAT.metal) {
  const mesh = finish(new THREE.Mesh(new THREE.TorusGeometry(major, tube, 10, 32), mat));
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

// XY 平面的倒角梯形装甲，厚度沿 Z；用于胸甲、髋甲和四肢外壳。
function armorPlate(topW, bottomW, height, depth, mat = MAT.shell, bevel = 0.009) {
  const shape = new THREE.Shape();
  shape.moveTo(-bottomW / 2, -height / 2);
  shape.lineTo(bottomW / 2, -height / 2);
  shape.lineTo(topW / 2, height / 2);
  shape.lineTo(-topW / 2, height / 2);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelSegments: 2,
    bevelSize: bevel, bevelThickness: bevel, curveSegments: 4,
  });
  geo.translate(0, 0, -depth / 2);
  geo.computeVertexNormals();
  return finish(new THREE.Mesh(geo, mat));
}

function bolt(parent, x, y, z, scale = 1) {
  const b = add(parent, cylinder(0.009 * scale, 0.009 * scale, 0.006, MAT.metal, 12), x, y, z);
  b.rotation.x = Math.PI / 2;
  return b;
}

// ------------------------------------------------------------------
// 面部灯光系统：发光眼睛 + 嘴部灯带。可切换表情、眨眼与闪光。
// ------------------------------------------------------------------
function buildFace(neck, headY) {
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x0a0f14, emissive: 0x35d9ff, emissiveIntensity: 4.5,
    roughness: 0.2, metalness: 0.1,
  });
  const mouthMat = eyeMat.clone();
  mouthMat.emissiveIntensity = 2.0;

  const eyes = [];
  for (const x of [-0.045, 0.045]) {
    const eye = add(neck, sphere(0.011, 0.014, 0.006, eyeMat, 16),
      x, headY + 0.004, 0.093 * FORWARD_Z);
    add(neck, ring(0.014, 0.003, MAT.metal), x, headY + 0.004, 0.086 * FORWARD_Z)
      .rotation.x = 0;
    eyes.push(eye);
  }
  const mouth = add(neck, box(0.052, 0.006, 0.008, mouthMat),
    0, headY - 0.062, 0.085 * FORWARD_Z);

  const face = {
    eyes, mouth, eyeMat, mouthMat,
    emotion: 'calm',
    _color: new THREE.Color(EMOTIONS.calm.color),
    _targetColor: new THREE.Color(EMOTIONS.calm.color),
    _intensity: EMOTIONS.calm.intensity,
    _targetIntensity: EMOTIONS.calm.intensity,
    _flash: 0,
    _blinkTimer: 2.5,
    _blinkPhase: 0,

    setEmotion(name) {
      const preset = EMOTIONS[name];
      if (!preset || this.emotion === name) return;
      this.emotion = name;
      this._targetColor.setHex(preset.color);
      this._targetIntensity = preset.intensity;
    },

    /** 短促闪光：动作发力瞬间调用。 */
    flash(strength = 2.2) { this._flash = Math.max(this._flash, strength); },

    update(dt) {
      const k = 1 - Math.exp(-dt / 0.25);
      this._color.lerp(this._targetColor, k);
      this._intensity += (this._targetIntensity - this._intensity) * k;
      this._flash = Math.max(0, this._flash - dt * 6);

      const glow = this._intensity * (1 + this._flash);
      this.eyeMat.emissive.copy(this._color);
      this.eyeMat.emissiveIntensity = glow;
      this.mouthMat.emissive.copy(this._color);
      this.mouthMat.emissiveIntensity = glow * 0.6;

      // 随机眨眼：眼睛竖向压扁再弹回，让机器人显得"活着"。
      if (this._blinkPhase > 0) {
        this._blinkPhase = Math.max(0, this._blinkPhase - dt / 0.13);
        const openness = 0.12 + 0.88 * Math.abs(1 - this._blinkPhase * 2);
        for (const eye of this.eyes) eye.scale.y = 0.014 * openness;
      } else {
        this._blinkTimer -= dt;
        if (this._blinkTimer <= 0) {
          this._blinkPhase = 1;
          this._blinkTimer = 2 + Math.random() * 3.5;
        }
      }
    },
  };
  return face;
}

function buildHead(neck, joints, rig) {
  joints.head = neck;
  add(neck, cylinder(0.041, 0.047, DIM.neckH, MAT.frame), 0, DIM.neckH * 0.15, 0);
  add(neck, ring(0.043, 0.008, MAT.metal), 0, DIM.neckH * 0.22, 0);

  const headY = DIM.neckH * 0.5 + DIM.headH * 0.5;
  add(neck, sphere(0.084, 0.103, 0.078, MAT.frame), 0, headY, -0.006);
  // 白色后脑和顶盖围住独立的黑色面罩。
  add(neck, sphere(0.087, 0.1, 0.057, MAT.shell), 0, headY + 0.006, -0.038);
  const visor = add(neck, sphere(0.069, 0.078, 0.025, MAT.visor), 0, headY - 0.002, 0.071 * FORWARD_Z);
  visor.rotation.x = -0.08;
  add(neck, armorPlate(0.11, 0.14, 0.028, 0.03, MAT.shellShade, 0.004),
    0, headY + 0.082, 0.012);

  rig.face = buildFace(neck, headY);

  // 侧部听觉传感器指示灯。
  for (const s of [-1, 1]) {
    add(neck, sphere(0.006, 0.016, 0.016, MAT.light, 12), s * 0.085, headY, -0.008);
  }
  add(neck, armorPlate(0.09, 0.065, 0.045, 0.04, MAT.frame, 0.004),
    0, headY - 0.087, 0.018);
}

function buildTorso(root, waist, joints) {
  joints.waist = waist;

  // 腰部三层旋转机构。
  add(waist, cylinder(0.075, 0.075, 0.07, MAT.frame), 0, 0.045, 0);
  add(waist, ring(0.07, 0.013, MAT.metal), 0, 0.025, 0);
  add(waist, ring(0.065, 0.009, MAT.rubber), 0, 0.074, 0);
  for (const x of [-0.055, 0.055]) add(waist, cylinder(0.013, 0.013, 0.08, MAT.metal), x, 0.08, 0);

  // 内部脊柱和肋架。
  add(waist, armorPlate(0.18, 0.13, 0.25, 0.125, MAT.frame, 0.012), 0, 0.19, -0.01);
  add(waist, cylinder(0.027, 0.032, 0.25, MAT.metal), 0, 0.19, -0.045);

  // 参考图中的宽肩、收腰白色胸甲，前后壳体分离形成层次。
  const chestFront = add(waist,
    armorPlate(DIM.torsoW * 0.98, DIM.torsoW * 0.72, DIM.torsoH * 0.78, 0.055, MAT.shell, 0.014),
    0, DIM.torsoH * 0.57, 0.083 * FORWARD_Z);
  chestFront.rotation.x = -0.025;
  add(waist,
    armorPlate(DIM.torsoW * 0.92, DIM.torsoW * 0.68, DIM.torsoH * 0.7, 0.05, MAT.shellShade, 0.013),
    0, DIM.torsoH * 0.57, -0.077 * FORWARD_Z);

  // 背部散热脊线灯带：从背面看也有科技细节。
  for (const x of [-0.045, 0.045]) {
    add(waist, box(0.008, DIM.torsoH * 0.42, 0.006, MAT.light),
      x, DIM.torsoH * 0.58, -0.106 * FORWARD_Z);
  }

  // 胸甲中央脊线、品牌徽记和状态灯。
  add(waist, armorPlate(0.026, 0.016, 0.17, 0.013, MAT.shellShade, 0.002),
    0, DIM.torsoH * 0.61, 0.116 * FORWARD_Z);
  add(waist, sphere(0.018, 0.018, 0.007, MAT.frame, 20), 0, DIM.torsoH * 0.69, 0.128 * FORWARD_Z);
  add(waist, sphere(0.008, 0.008, 0.004, MAT.light, 14), 0, DIM.torsoH * 0.69, 0.136 * FORWARD_Z);
  for (const x of [-0.075, 0.075]) {
    add(waist, box(0.009, 0.052, 0.008, MAT.light), x, DIM.torsoH * 0.54, 0.122 * FORWARD_Z);
  }

  // 锁骨与肩胛机械梁。
  add(waist, cylinder(0.032, 0.032, DIM.shoulderWidth * 1.75, MAT.frame), 0, DIM.torsoH * 0.88, 0).rotation.z = Math.PI / 2;
  for (const s of [-1, 1]) {
    add(waist, sphere(0.075, 0.06, 0.066, MAT.frame), s * DIM.shoulderWidth * 0.86, DIM.torsoH * 0.88, 0);
    add(waist, sphere(0.071, 0.052, 0.052, MAT.shell), s * DIM.shoulderWidth * 0.92, DIM.torsoH * 0.9, -0.012);
  }

  // 骨盆核心与左右髋甲。
  add(root, armorPlate(0.23, 0.2, DIM.pelvisH * 0.78, 0.14, MAT.frame, 0.012), 0, 0.005, 0);
  add(root, ring(0.074, 0.012, MAT.metal), 0, DIM.pelvisH * 0.34, 0);
  for (const s of [-1, 1]) {
    const hipArmor = add(root, sphere(0.08, 0.09, 0.068, MAT.shell), s * 0.095, -0.015, 0.006);
    hipArmor.rotation.z = -s * 0.18;
    add(root, armorPlate(0.085, 0.065, 0.115, 0.035, MAT.shellShade, 0.007),
      s * 0.105, -0.018, 0.067 * FORWARD_Z).rotation.z = -s * 0.16;
    bolt(root, s * 0.102, 0.015, 0.092 * FORWARD_Z, 0.8);
  }
}

// ------------------------------------------------------------------
// 五指机械手：手腕独立关节 + 双段可弯曲手指（可握拳）。
// ------------------------------------------------------------------
function buildHand(wrist, side) {
  const s = side === 'L' ? 1 : -1;

  add(wrist, ring(0.028, 0.007, MAT.metal), 0, 0.016, 0);
  add(wrist, sphere(0.036, 0.05, 0.027, MAT.shell), 0, -0.025, 0.004);
  add(wrist, armorPlate(0.046, 0.038, 0.062, 0.022, MAT.frame, 0.004),
    0, -0.025, 0.023 * FORWARD_Z);
  add(wrist, sphere(0.007, 0.007, 0.004, MAT.light, 10), 0, -0.02, 0.036 * FORWARD_Z);

  const fingers = [];
  for (let i = 0; i < 5; i++) {
    const fingerX = (i - 2) * 0.011;
    const fingerLen = i === 0 || i === 4 ? 0.041 : 0.052;
    const proximalLen = fingerLen * 0.55;
    const distalLen = fingerLen * 0.5;

    // 近节：从掌指关节出发
    const knuckle = new THREE.Group();
    knuckle.position.set(fingerX, -0.058, 0.005);
    knuckle.rotation.z = s * (i - 2) * 0.025;
    wrist.add(knuckle);
    add(knuckle, sphere(0.005, 0.005, 0.005, MAT.rubber, 10));
    add(knuckle, cylinder(0.0036, 0.0042, proximalLen, MAT.metal, 8),
      0, -proximalLen * 0.5, 0);

    // 远节：可再弯曲一段
    const mid = new THREE.Group();
    mid.position.set(0, -proximalLen, 0);
    knuckle.add(mid);
    add(mid, sphere(0.004, 0.004, 0.004, MAT.rubber, 8));
    add(mid, cylinder(0.003, 0.0036, distalLen, MAT.metal, 8),
      0, -distalLen * 0.5, 0);

    fingers.push({ knuckle, mid, thumb: i === 0 });
  }

  // curl: 0 = 张开，1 = 握拳。手指朝掌心(+Z 前方)卷曲。
  return {
    fingers,
    setCurl(t) {
      for (const finger of this.fingers) {
        const amount = finger.thumb ? t * 0.9 : t;
        finger.knuckle.rotation.x = amount * 1.25 * FORWARD_Z;
        finger.mid.rotation.x = amount * 1.35 * FORWARD_Z;
      }
    },
  };
}

function buildArm(waist, side, joints, rig) {
  const s = side === 'L' ? 1 : -1;
  const shoulder = new THREE.Group();
  shoulder.name = `shoulder${side}`;
  shoulder.position.set(s * DIM.shoulderWidth, DIM.torsoH * 0.88, 0);
  waist.add(shoulder);
  joints[`shoulder${side}`] = shoulder;

  add(shoulder, sphere(0.061, 0.061, 0.061, MAT.rubber));
  const shoulderCap = add(shoulder, sphere(0.067, 0.052, 0.058, MAT.shell), s * 0.016, 0.008, -0.006);
  shoulderCap.rotation.z = -s * 0.12;
  add(shoulder, ring(0.048, 0.007, MAT.metal), 0, -0.005, 0).rotation.z = Math.PI / 2;

  // 内部上臂骨 + 前后装甲，中间留出黑色关节缝。
  add(shoulder, cylinder(0.033, 0.04, DIM.upperArm * 0.75, MAT.frame), 0, -DIM.upperArm * 0.5, 0);
  const upperArmor = add(shoulder,
    armorPlate(0.078, 0.064, DIM.upperArm * 0.62, 0.075, MAT.shell, 0.008),
    0, -DIM.upperArm * 0.46, 0.012 * FORWARD_Z);
  upperArmor.rotation.z = s * 0.035;
  add(shoulder, armorPlate(0.052, 0.044, DIM.upperArm * 0.38, 0.018, MAT.shellShade, 0.004),
    s * 0.044, -DIM.upperArm * 0.43, -0.006).rotation.y = -s * 0.55;

  const elbow = new THREE.Group();
  elbow.name = `elbow${side}`;
  elbow.position.set(0, -DIM.upperArm, 0);
  shoulder.add(elbow);
  joints[`elbow${side}`] = elbow;
  add(elbow, sphere(0.047, 0.047, 0.047, MAT.rubber));
  add(elbow, cylinder(0.038, 0.038, 0.075, MAT.metal), 0, 0, 0).rotation.z = Math.PI / 2;
  add(elbow, sphere(0.04, 0.04, 0.016, MAT.shell), s * 0.039, 0, 0);
  bolt(elbow, s * 0.052, 0, 0, 0.7).rotation.z = Math.PI / 2;

  add(elbow, cylinder(0.026, 0.035, DIM.foreArm * 0.72, MAT.frame), 0, -DIM.foreArm * 0.5, 0);
  const foreArmor = add(elbow,
    armorPlate(0.066, 0.049, DIM.foreArm * 0.65, 0.068, MAT.shell, 0.007),
    0, -DIM.foreArm * 0.47, 0.014 * FORWARD_Z);
  foreArmor.rotation.z = -s * 0.025;
  add(elbow, armorPlate(0.044, 0.036, DIM.foreArm * 0.42, 0.014, MAT.frame, 0.003),
    -s * 0.037, -DIM.foreArm * 0.48, 0.022 * FORWARD_Z).rotation.y = s * 0.45;

  // 手腕独立关节：挥手、抱拳、推掌都由它完成。
  const wrist = new THREE.Group();
  wrist.name = `wrist${side}`;
  wrist.position.set(0, -DIM.foreArm - 0.018, 0);
  elbow.add(wrist);
  joints[`wrist${side}`] = wrist;
  rig.hands[side] = buildHand(wrist, side);
}

function buildLeg(root, side, joints) {
  const s = side === 'L' ? 1 : -1;
  const hip = new THREE.Group();
  hip.name = `hip${side}`;
  hip.position.set(s * DIM.hipWidth * 0.5, -DIM.pelvisH * 0.4, 0);
  root.add(hip);
  joints[`hip${side}`] = hip;

  add(hip, sphere(0.061, 0.061, 0.061, MAT.rubber));
  add(hip, ring(0.05, 0.009, MAT.metal), 0, 0, 0).rotation.z = Math.PI / 2;
  add(hip, sphere(0.023, 0.023, 0.016, MAT.lightSoft), -s * 0.052, 0, 0);

  // 大腿内骨与流线型前/外侧装甲。
  add(hip, cylinder(0.042, 0.05, DIM.thigh * 0.82, MAT.frame), 0, -DIM.thigh * 0.5, 0);
  const thighFront = add(hip,
    armorPlate(0.105, 0.075, DIM.thigh * 0.72, 0.095, MAT.shell, 0.011),
    0, -DIM.thigh * 0.47, 0.018 * FORWARD_Z);
  thighFront.rotation.z = -s * 0.025;
  const thighSide = add(hip,
    armorPlate(0.07, 0.05, DIM.thigh * 0.52, 0.025, MAT.shellShade, 0.006),
    s * 0.055, -DIM.thigh * 0.43, -0.005);
  thighSide.rotation.y = -s * Math.PI / 2;
  add(hip, armorPlate(0.052, 0.042, DIM.thigh * 0.35, 0.014, MAT.frame, 0.003),
    -s * 0.052, -DIM.thigh * 0.58, -0.005).rotation.y = s * Math.PI / 2;

  const knee = new THREE.Group();
  knee.name = `knee${side}`;
  knee.position.set(0, -DIM.thigh, 0);
  hip.add(knee);
  joints[`knee${side}`] = knee;
  add(knee, sphere(0.052, 0.052, 0.052, MAT.rubber));
  add(knee, cylinder(0.041, 0.041, 0.08, MAT.metal), 0, 0, 0).rotation.z = Math.PI / 2;
  add(knee, sphere(0.045, 0.042, 0.025, MAT.shell), 0, 0, 0.042 * FORWARD_Z);
  add(knee, sphere(0.012, 0.012, 0.007, MAT.light), 0, 0, 0.069 * FORWARD_Z);
  add(knee, sphere(0.043, 0.043, 0.016, MAT.shellShade), s * 0.043, 0, 0);
  bolt(knee, s * 0.057, 0, 0, 0.8).rotation.z = Math.PI / 2;

  // 小腿采用后置黑色连杆与前置白色胫骨甲。
  add(knee, cylinder(0.03, 0.039, DIM.shin * 0.84, MAT.frame), 0, -DIM.shin * 0.5, -0.025);
  const shinFront = add(knee,
    armorPlate(0.079, 0.058, DIM.shin * 0.7, 0.075, MAT.shell, 0.009),
    0, -DIM.shin * 0.48, 0.025 * FORWARD_Z);
  shinFront.rotation.z = s * 0.02;
  add(knee, armorPlate(0.028, 0.02, DIM.shin * 0.48, 0.012, MAT.frame, 0.003),
    -s * 0.047, -DIM.shin * 0.5, -0.015).rotation.y = s * 0.7;
  add(knee, box(0.01, DIM.shin * 0.34, 0.007, MAT.light),
    s * 0.035, -DIM.shin * 0.47, 0.068 * FORWARD_Z);

  const ankle = new THREE.Group();
  ankle.name = `ankle${side}`;
  ankle.position.set(0, -DIM.shin, 0);
  knee.add(ankle);
  joints[`ankle${side}`] = ankle;
  add(ankle, sphere(0.04, 0.04, 0.04, MAT.rubber));
  add(ankle, ring(0.033, 0.007, MAT.metal), 0, 0, 0).rotation.z = Math.PI / 2;

  // 两段式脚掌：黑色防滑底 + 白色楔形脚背 + 深色脚尖。
  const footZ = DIM.footLen * 0.16 * FORWARD_Z;
  add(ankle, box(DIM.footWidth, DIM.footH * 0.35, DIM.footLen * 1.08, MAT.rubber),
    0, -DIM.footH * 0.66, footZ);
  const footTop = add(ankle,
    armorPlate(0.087, 0.1, DIM.footLen * 0.7, 0.045, MAT.shell, 0.007),
    0, -DIM.footH * 0.36, footZ + 0.012 * FORWARD_Z);
  footTop.rotation.x = Math.PI / 2;
  add(ankle, box(DIM.footWidth * 0.98, 0.018, 0.045, MAT.frame),
    0, -DIM.footH * 0.52, DIM.footLen * 0.63 * FORWARD_Z);
}

/**
 * 构建高细节人形机器人。
 * 返回 { root, joints, face, hands }：
 *   joints 在原有基础上新增 wristL / wristR；
 *   face 提供 setEmotion / flash / update；
 *   hands.L/.R 提供 setCurl(0..1) 张手→握拳。
 */
export function buildRobot() {
  const joints = {};
  const rig = { root: null, joints, face: null, hands: {} };
  const root = new THREE.Group();
  root.name = 'root';
  rig.root = root;

  const waist = new THREE.Group();
  waist.name = 'waist';
  waist.position.set(0, DIM.pelvisH * 0.5, 0);
  root.add(waist);

  buildTorso(root, waist, joints);

  const neck = new THREE.Group();
  neck.name = 'head';
  neck.position.set(0, DIM.torsoH + DIM.neckH * 0.5, 0);
  waist.add(neck);
  buildHead(neck, joints, rig);

  buildArm(waist, 'L', joints, rig);
  buildArm(waist, 'R', joints, rig);
  buildLeg(root, 'L', joints);
  buildLeg(root, 'R', joints);

  root.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return rig;
}
